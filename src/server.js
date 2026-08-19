/**
 * server.js — zero-dependency HTTP layer.
 *
 * Built on node:http deliberately: no Express, no middleware stack, no
 * supply chain. For three endpoints, the platform is enough.
 *
 *   POST /v1/route    body: {"tokens": <estimate>, "payload"?: <provider body>}
 *                     → routing decision; with a payload it forwards to
 *                     Anthropic and meters the usage actually consumed
 *   GET  /v1/status   fleet health, redacted keys, breaker states
 *   GET  /healthz     liveness for load balancers
 *
 * The browser dashboard talks ONLY to this server. Raw keys exist ONLY
 * in KeyStore's closure. That is the entire security model, and it fits
 * in one sentence — which is how you know it's a good one.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { KeyStore } from './key-store.js';
import { UsageTracker } from './usage-tracker.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { route, STRATEGIES } from './router.js';
import { validate, RouteRequest } from './schemas.js';
import { adapterFor } from './providers.js';

const MAX_BODY_BYTES = 64 * 1024; // reject absurd payloads early

/** Structured JSON logs: grep-able, ship-able to any log drain. */
function log(level, msg, extra = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + '\n',
  );
}

/**
 * Provider call. This is the ONLY place a raw secret is used, and it never
 * leaves this function — not into a log line, not into a response body.
 *
 * Two modes, chosen by whether the caller sent a `payload`:
 *   - no payload → reserve/meter only. Returns the routing decision and books
 *     the estimate. Useful when the caller makes its own provider call, and it
 *     keeps the network out of the test suite.
 *   - payload    → forward to the key's provider and meter what was ACTUALLY
 *     consumed. Which vendor that is comes from the key's own `provider`
 *     field, so one fleet can mix Anthropic and OpenAI keys.
 *     Billing off the real usage instead of the client's estimate is the whole
 *     reason to route through here; an estimate that drifts low would let a key
 *     sail past its quota unnoticed.
 */
async function callProvider({ secret, tokens, payload, provider, env = {}, signal }) {
  if (!payload) return { ok: true, tokensUsed: tokens };

  const adapter = adapterFor(provider, env);

  const res = await fetch(adapter.url, {
    method: 'POST',
    headers: adapter.headers(secret),
    body: JSON.stringify(payload),
    signal,
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(adapter.errorMessage(body) || `provider responded ${res.status}`);
    err.status = res.status;
    // Distinguish "this key is bad" from "this request was bad". A 401/403/429
    // or 5xx means the key can't serve traffic, so it should trip the breaker
    // and rotate. A 400 means the CALLER sent malformed input — quarantining a
    // perfectly good key for someone else's typo would be a self-inflicted
    // outage, so we surface it without penalising the key.
    err.clientError = res.status >= 400 && res.status < 500
      && ![401, 403, 429].includes(res.status);
    throw err;
  }

  const used = adapter.usage(body);
  return { ok: true, tokensUsed: used || tokens, response: body, model: body?.model };
}

/**
 * Timing-safe bearer-token check. A plain === comparison leaks length and
 * prefix information through response timing; crypto.timingSafeEqual on
 * fixed-length digests does not.
 */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createApp({
  env = process.env,
  now = Date.now,
  provider = callProvider,
} = {}) {
  const store = new KeyStore(env);
  const usage = new UsageTracker({
    windowMs: Number(env.KEYROUTER_WINDOW_MS) || 86_400_000,
    now,
  });
  const breakers = new Map(
    store.meta.map((m) => [m.id, new CircuitBreaker({ now })]),
  );

  // Resolve every key's provider up front. A typo'd provider name should kill
  // the boot with a readable message, not surface as a mystery 502 on the
  // first request that happens to route to that key.
  const providerOf = new Map(store.meta.map((m) => [m.id, m.provider]));
  for (const m of store.meta) adapterFor(m.provider, env);

  // ── Client authentication ─────────────────────────────────────────────
  // KEYROUTER_AUTH_TOKEN protects the proxy itself: without it, anyone who
  // can reach this port can spend your quota. Absence is allowed only for
  // local development, and we say so loudly at boot.
  const authToken = env.KEYROUTER_AUTH_TOKEN || null;
  if (!authToken) {
    log('warn', 'KEYROUTER_AUTH_TOKEN not set — proxy is UNAUTHENTICATED. Fine on localhost, never in production.');
  }

  // ── CORS ──────────────────────────────────────────────────────────────
  // Exact-match allow-list, comma-separated. No wildcard default: a proxy
  // that fronts paid API keys should never reflect arbitrary origins.
  const allowedOrigins = (env.KEYROUTER_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // ── State persistence ─────────────────────────────────────────────────
  // Usage metering survives restarts via a JSON snapshot. Without this, a
  // redeploy at 79% quota looks like a fresh fleet and the router happily
  // slams a nearly-exhausted key.
  const stateFile = env.KEYROUTER_STATE_FILE || null;
  if (stateFile && fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      usage.restore(saved.usage);
      log('info', 'restored usage state', { stateFile });
    } catch (err) {
      // Corrupt state must not brick the service; start fresh and say so.
      log('error', 'state file unreadable, starting fresh', { stateFile, error: err.message });
    }
  }
  function persist() {
    if (!stateFile) return;
    try {
      // Write-then-rename so a crash mid-write can't corrupt the snapshot.
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: now(), usage: usage.snapshot() }));
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      log('error', 'persist failed', { error: err.message });
    }
  }

  const config = {
    strategy: env.KEYROUTER_STRATEGY || STRATEGIES.LOWEST_USAGE,
    thresholdPct: Number(env.KEYROUTER_THRESHOLD) || 80,
  };

  let activeId = store.meta[0]?.id ?? null;

  /** Assemble the fleet view the pure router consumes. */
  function fleet() {
    return store.meta.map((m) => ({
      id: m.id,
      enabled: m.enabled,
      limit: m.limit,
      used: usage.used(m.id),
      circuitOpen: !breakers.get(m.id).allows(),
    }));
  }

  async function handleRoute(body, requestId) {
    const problems = validate(RouteRequest, body);
    if (problems.length > 0) {
      return [400, { error: 'invalid request body', details: problems }];
    }
    const { tokens, payload } = body;

    const decision = route(fleet(), { activeId, ...config });
    if (!decision.keyId) {
      log('error', 'fleet exhausted', { requestId });
      return [503, { error: 'no routable keys', reason: decision.reason }];
    }

    if (decision.rotated) {
      log('info', 'rotated key', {
        requestId, from: activeId, to: decision.keyId, reason: decision.reason,
      });
      activeId = decision.keyId;
    }

    const breaker = breakers.get(decision.keyId);
    try {
      const result = await provider({
        secret: store.secretFor(decision.keyId),
        tokens,
        payload,
        provider: providerOf.get(decision.keyId),
        env,
      });
      breaker.recordSuccess();
      usage.record(decision.keyId, result.tokensUsed ?? tokens);
      return [200, {
        keyId: decision.keyId,
        rotated: decision.rotated,
        reason: decision.reason,
        tokensUsed: result.tokensUsed ?? tokens,
        ...(result.model ? { model: result.model } : {}),
        ...(result.response ? { response: result.response } : {}),
      }];
    } catch (err) {
      if (err.clientError) {
        // Caller's payload was rejected by the provider. Not the key's fault,
        // so the breaker stays closed and this key keeps serving others.
        log('warn', 'provider rejected request', {
          requestId, keyId: decision.keyId, status: err.status,
        });
        return [400, { error: err.message, keyId: decision.keyId }];
      }
      breaker.recordFailure();
      log('error', 'provider call failed', {
        requestId, keyId: decision.keyId, error: err.message,
      });
      // Client can retry; the breaker will have quarantined the bad key.
      return [502, { error: 'provider call failed', keyId: decision.keyId }];
    }
  }

  function handleStatus() {
    const keys = store.publicView().map((m) => ({
      ...m,
      used: usage.used(m.id),
      resetsInMs: usage.resetsIn(m.id),
      breaker: breakers.get(m.id).toJSON(),
      active: m.id === activeId,
    }));
    return [200, { config, keys }];
  }

  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    const started = now();

    // CORS: reflect the origin only if it's on the allow-list.
    const origin = req.headers.origin;
    const corsHeaders = {};
    if (origin && allowedOrigins.includes(origin)) {
      corsHeaders['access-control-allow-origin'] = origin;
      corsHeaders['access-control-allow-headers'] = 'content-type, authorization';
      corsHeaders['access-control-allow-methods'] = 'GET, POST, OPTIONS';
      corsHeaders['vary'] = 'origin';
    }

    const respond = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-request-id': requestId,
        ...corsHeaders,
      });
      res.end(JSON.stringify(payload));
      log('info', 'request', {
        requestId, method: req.method, url: req.url, status, ms: now() - started,
      });
    };

    try {
      // Preflight never requires auth — browsers send it without headers.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
      }
      if (req.method === 'GET' && req.url === '/healthz') {
        return respond(store.meta.length ? 200 : 503, {
          ok: store.meta.length > 0,
          keys: store.meta.length,
        });
      }

      // Everything below is authenticated when a token is configured.
      // /healthz stays open: load balancers don't carry credentials.
      if (authToken) {
        const presented = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (!tokenMatches(presented, authToken)) {
          return respond(401, { error: 'missing or invalid bearer token' });
        }
      }

      if (req.method === 'GET' && req.url === '/v1/status') {
        return respond(...handleStatus());
      }
      if (req.method === 'POST' && req.url === '/v1/route') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) return respond(413, { error: 'body too large' });
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          return respond(400, { error: 'invalid JSON body' });
        }
        const result = await handleRoute(body, requestId);
        persist(); // metering survives a crash between requests
        return respond(...result);
      }
      respond(404, { error: 'not found' });
    } catch (err) {
      // Last-resort handler: never leak a stack trace to the client.
      log('error', 'unhandled', { requestId, error: err.message });
      respond(500, { error: 'internal error', requestId });
    }
  });

  /** Graceful shutdown: stop accepting, drain in-flight, save state. */
  function shutdown(signal) {
    log('info', 'shutting down', { signal });
    server.close(() => {
      persist();
      log('info', 'state saved, goodbye');
      process.exit(0);
    });
    // Hard deadline so a hung connection can't block the deploy forever.
    setTimeout(() => process.exit(1), 5000).unref();
  }

  return {
    server, fleet, shutdown, persist,
    get activeId() { return activeId; },
  };
}

// Only start listening when run directly (`node src/server.js`), so tests
// can import createApp without opening a port.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT) || 8787;
  const app = createApp();
  app.server.listen(port, () => log('info', 'listening', { port }));
  process.on('SIGTERM', () => app.shutdown('SIGTERM'));
  process.on('SIGINT', () => app.shutdown('SIGINT'));
}
