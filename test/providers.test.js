/**
 * providers.test.js — one fleet, several vendors.
 *
 * The point of these is that routing/metering/breakers stay vendor-agnostic:
 * a key's own `provider` decides where its traffic goes, so a fleet can mix
 * Anthropic and OpenAI keys — including keys owned by different people.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { adapterFor, knownProviders } from '../src/providers.js';

function start(app) {
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${app.server.address().port}`));
  });
}

/** Intercept vendor calls; let the harness's own localhost fetch through. */
function stubUpstream(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const href = typeof url === 'string' ? url : url.url;
    if (/^https:\/\/(api\.anthropic\.com|api\.openai\.com|gateway\.example\.com)/.test(href)) {
      calls.push({ href, opts });
      return handler(href, opts);
    }
    return real(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const jsonRes = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const MIXED_ENV = {
  KEYROUTER_KEYS: JSON.stringify([
    { id: 'claude', provider: 'anthropic', limit: 100000 },
    { id: 'gpt', provider: 'openai', limit: 100000 },
  ]),
  KEYROUTER_SECRET_claude: 'sk-ant-client-alpha-0001',
  KEYROUTER_SECRET_gpt: 'sk-openai-client-beta-0002',
};

const PAYLOAD = { model: 'x', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };

test('an OpenAI key goes to OpenAI, with bearer auth and total_tokens metering', async (t) => {
  const stub = stubUpstream(() => jsonRes(200, {
    model: 'gpt-test', choices: [], usage: { total_tokens: 777 },
  }));
  t.after(stub.restore);

  // Single-key fleet so routing is unambiguous.
  const app = createApp({
    env: {
      KEYROUTER_KEYS: JSON.stringify([{ id: 'gpt', provider: 'openai', limit: 100000 }]),
      KEYROUTER_SECRET_gpt: 'sk-openai-client-beta-0002',
    },
  });
  const base = await start(app);
  t.after(() => app.server.close());

  const r = await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: 5, payload: PAYLOAD }),
  }).then((x) => x.json());

  assert.equal(stub.calls[0].href, 'https://api.openai.com/v1/chat/completions');
  assert.equal(stub.calls[0].opts.headers.authorization, 'Bearer sk-openai-client-beta-0002');
  assert.equal(stub.calls[0].opts.headers['x-api-key'], undefined, 'must not send Anthropic auth');
  assert.equal(r.tokensUsed, 777, 'OpenAI reports one total, not input+output');
});

test('a mixed fleet sends each key to its own vendor', async (t) => {
  const stub = stubUpstream((href) => (
    href.includes('anthropic')
      ? jsonRes(200, { model: 'claude', content: [], usage: { input_tokens: 10, output_tokens: 5 } })
      : jsonRes(200, { model: 'gpt', choices: [], usage: { total_tokens: 99 } })
  ));
  t.after(stub.restore);

  const app = createApp({ env: MIXED_ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  // First key in the fleet is active; drive it until it rotates to the other.
  await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: 5, payload: PAYLOAD }),
  }).then((x) => x.json());

  const hosts = stub.calls.map((c) => new URL(c.href).host);
  assert.ok(hosts.includes('api.anthropic.com'), 'the anthropic key must hit anthropic');

  const status = await fetch(`${base}/v1/status`).then((x) => x.json());
  assert.deepEqual(
    status.keys.map((k) => k.provider).sort(),
    ['anthropic', 'openai'],
    'both vendors visible in one fleet',
  );
});

test('an unknown provider fails at boot with a readable message', () => {
  assert.throws(
    () => createApp({
      env: {
        KEYROUTER_KEYS: JSON.stringify([{ id: 'oops', provider: 'gemmini', limit: 10 }]),
        KEYROUTER_SECRET_oops: 'sk-whatever-0001',
      },
    }),
    /unknown provider "gemmini".*anthropic/s,
    'a typo must not become a silent misroute',
  );
});

test('KEYROUTER_URL_<PROVIDER> redirects a vendor to a custom endpoint', async (t) => {
  const stub = stubUpstream(() => jsonRes(200, { model: 'gpt', usage: { total_tokens: 12 } }));
  t.after(stub.restore);

  const app = createApp({
    env: {
      KEYROUTER_KEYS: JSON.stringify([{ id: 'gpt', provider: 'openai', limit: 1000 }]),
      KEYROUTER_SECRET_gpt: 'sk-openai-client-beta-0002',
      KEYROUTER_URL_OPENAI: 'https://gateway.example.com/v1/chat/completions',
    },
  });
  const base = await start(app);
  t.after(() => app.server.close());

  await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: 5, payload: PAYLOAD }),
  }).then((x) => x.json());

  assert.equal(stub.calls[0].href, 'https://gateway.example.com/v1/chat/completions');
});

test('adapterFor defaults to anthropic and lists what it knows', () => {
  assert.equal(adapterFor(undefined).url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(knownProviders().sort(), ['anthropic', 'openai']);
});
