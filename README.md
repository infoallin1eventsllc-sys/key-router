# Key Router

A zero-dependency Node.js failover proxy for API keys you own. It meters usage per key, rotates traffic to the healthiest key **before** the active one hits its quota, quarantines failing keys with circuit breakers, and never lets a raw secret reach a client or a log line.

```
Browser dashboard ──▶ Key Router (this repo) ──▶ Provider API
     no secrets         holds the secrets          real calls
```

## Why zero dependencies

`npm audit` on this project has nothing to audit. The HTTP layer is `node:http`, tests run on `node:test`, IDs come from `node:crypto`. For a service whose entire job is guarding secrets, every dependency you don't install is attack surface you don't carry. Requires Node ≥ 20.

## Run it

```bash
export KEYROUTER_KEYS='[{"id":"primary","provider":"anthropic","limit":100000},
                        {"id":"backup","provider":"openai","limit":100000}]'
export KEYROUTER_SECRET_primary='sk-ant-...'
export KEYROUTER_SECRET_backup='sk-...'
npm start          # listens on $PORT, default 8787
npm test           # 36 tests: unit, integration, contract, provider
```

Optional config:

| Env var | Purpose | Default |
|---|---|---|
| `KEYROUTER_AUTH_TOKEN` | Bearer token clients must present. **Set this in production** — without it the proxy is open and boot logs warn loudly. | unset (dev only) |
| `KEYROUTER_ALLOWED_ORIGINS` | Comma-separated CORS allow-list for the browser dashboard. Exact match, no wildcards. | none |
| `KEYROUTER_STATE_FILE` | Path for the usage snapshot so metering survives restarts (atomic write-then-rename; corrupt files start fresh, never crash). | unset (in-memory) |
| `KEYROUTER_THRESHOLD` | Rotate at this % of quota | `80` |
| `KEYROUTER_STRATEGY` | `lowest-usage` \| `round-robin` | `lowest-usage` |
| `KEYROUTER_URL_<PROVIDER>` | Override a vendor's endpoint, e.g. `KEYROUTER_URL_OPENAI` | vendor default |
| `KEYROUTER_WINDOW_MS` | Metering window | 24 h |

The server handles `SIGTERM`/`SIGINT` gracefully: stops accepting, drains in-flight requests, saves state, with a 5 s hard deadline so a hung connection can't block a deploy.

## API

| Method | Path         | Purpose                                        |
|--------|--------------|------------------------------------------------|
| POST   | `/v1/route`  | Route one request; body `{"tokens": <estimate>, "payload"?: {...}}` |
| GET    | `/v1/status` | Fleet health: usage, breakers, redacted keys   |
| GET    | `/healthz`   | Liveness probe for load balancers              |

### Two ways to call `/v1/route`

**Meter only** — you want the routing decision and usage accounting, but you'll make the provider call yourself:

```jsonc
{ "tokens": 1200 }                    // → { keyId, rotated, reason, tokensUsed }
```

**Full proxy** — send the provider body as `payload` and Key Router forwards it, so the secret never leaves the server:

```jsonc
{
  "tokens": 1200,                     // pre-flight estimate, used to pick a key
  "payload": {                        // a normal Anthropic Messages request
    "model": "claude-opus-5",
    "max_tokens": 1024,
    "messages": [{ "role": "user", "content": "Draft a launch post." }]
  }
}
// → { keyId, rotated, reason, tokensUsed, model, response }
```

`tokensUsed` is billed from the provider's real `usage`, not your estimate — an
estimate that drifts low would let a key sail past its quota unnoticed.

Failures are attributed, not lumped together: `401/403/429/5xx` means the key
can't serve traffic, so the breaker opens and traffic rotates away from it. A
`400` means *your* payload was malformed, and is returned as a `400` without
punishing a perfectly good key.

Every request gets an `x-request-id` header that also appears in the structured JSON logs, so any response can be traced to its log lines.

## Providers — one fleet, several vendors

Each key declares its own `provider`, and that decides where its traffic goes.
Routing, metering and circuit breakers never learn which vendor served a
request, so a single fleet can mix vendors — and owners:

```jsonc
[
  { "id": "acme-claude", "provider": "anthropic", "limit": 500000 },
  { "id": "acme-gpt",    "provider": "openai",    "limit": 500000 },
  { "id": "mine-claude", "provider": "anthropic", "limit": 100000 }
]
```

| Provider | Endpoint | Auth | Usage metered from |
|---|---|---|---|
| `anthropic` (default) | `/v1/messages` | `x-api-key` | `input_tokens + output_tokens` |
| `openai` | `/v1/chat/completions` | `Authorization: Bearer` | `total_tokens` |

`provider` is optional and defaults to `anthropic`, so existing configs keep
working. An unrecognised name throws **at boot** with the list of known
providers — a typo should stop a deploy, not quietly send a client's traffic to
the wrong vendor.

Set `KEYROUTER_URL_ANTHROPIC` / `KEYROUTER_URL_OPENAI` to point an adapter at a
different endpoint (Azure OpenAI, a corporate gateway, a compatible proxy)
without touching code.

**Adding a vendor** is one entry in `src/providers.js` — endpoint, headers,
where usage lives. Nothing above that layer changes.

### Whose keys?

Key Router manages keys; it does not supply them. Every call bills whoever owns
the key it routed to. That is the feature: give each client their own key entry
with their own `limit`, and their marketing runs on their budget, metered
separately, never on yours.

## Data contracts (`src/schemas.js`)

Every payload that crosses a boundary — HTTP request, HTTP response, env config — has a declared schema in one file, and the boundaries enforce it:

- **Inbound**: `RouteRequest`, `KeyConfig`. Invalid input is rejected with a `400` listing *every* problem (`details: [...]`), and unknown fields are refused so payloads can't silently accumulate junk.
- **Outbound**: `RouteResponse`, `StatusResponse`, `ErrorResponse`, `HealthResponse`. Contract tests (`test/contracts.test.js`) hit the live server and validate real responses against these schemas, so shapes cannot drift without a test failing.
- **Config**: `KEYROUTER_KEYS` entries are schema-validated at boot; a misconfigured deploy fails fast with an aggregated error message instead of limping into production.

## Architecture

```
src/
  schemas.js          data contracts + validator (pure)
  router.js           key selection & rotation decisions (pure)
  circuit-breaker.js  closed → open → half-open failure isolation (pure)
  usage-tracker.js    windowed token metering (pure, injectable clock)
  providers.js        one adapter per vendor: endpoint, auth, usage mapping
  key-store.js        the ONLY module that touches raw secrets
  server.js           node:http wiring; executes decisions, owns no logic
```

Decisions and I/O are separated on purpose. `router.js` takes fleet state in and returns a decision out — no clocks, no sockets — which is why it runs identically in the browser demo, this server, or a serverless function. Time is injected everywhere (`now`), so the test suite covers cooldowns and window resets without a single `sleep`.

### Rotation

`shouldRotate` fires at the configured threshold (default 80%), not at 100%, so traffic moves to a fresh key while the active one still has headroom. Strategies: `lowest-usage` (most headroom wins, stable tie-break) or `round-robin` (next routable key, wrapping).

### Failure isolation

Each key gets a circuit breaker: 3 consecutive provider failures open it; after a cooldown it half-opens and admits one probe; the probe's outcome closes it or re-opens it with a fresh cooldown. A key throwing 401s is quarantined after 3 requests instead of eating latency forever.

### Security model

Three layers, each with a test proving it:

1. **Secrets**: raw keys exist only inside `KeyStore`'s private closure, loaded from env vars; a test asserts `/v1/status` output never contains a raw secret.
2. **Access**: `/v1/*` endpoints require a bearer token (timing-safe comparison via SHA-256 + `crypto.timingSafeEqual`, so response timing leaks nothing about the token). `/healthz` stays open for load balancers.
3. **Browser boundary**: CORS reflects only exact-match allow-listed origins — a proxy fronting paid keys never wildcards.

## Extension seams

- `callProvider()` in `server.js` — implemented for Anthropic Messages; swap the URL/headers for another provider and nothing else changes.
- `UsageTracker.snapshot()/restore()` — persistence hook for Redis/DB when you scale past one instance.

## A note on scope

Rotating across keys **you own** (failover, load-balancing) is standard resilience engineering. Using rotation to evade a provider's per-account limits violates most providers' terms — this project is built, documented, and tested for the former.
