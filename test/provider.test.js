/**
 * provider.test.js — the forwarding path.
 *
 * These exercise the REAL default provider (no injected fake), so the thing
 * under test is the actual Anthropic call: headers, usage metering, and how
 * failures are attributed. Only api.anthropic.com is stubbed; the harness's
 * own fetch to the local server still goes over real HTTP, matching the
 * integration style of the rest of the suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

function start(app) {
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const { port } = app.server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Intercept only Anthropic; everything else hits the network for real. */
function stubAnthropic(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const href = typeof url === 'string' ? url : url.url;
    if (href.startsWith('https://api.anthropic.com')) {
      calls.push({ href, opts });
      return handler(opts);
    }
    return real(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const jsonRes = (status, body) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

const ENV = {
  KEYROUTER_KEYS: JSON.stringify([
    { id: 'primary', provider: 'anthropic', limit: 100000 },
    { id: 'backup', provider: 'anthropic', limit: 100000 },
  ]),
  KEYROUTER_SECRET_primary: 'sk-ant-test-primary-0001',
  KEYROUTER_SECRET_backup: 'sk-ant-test-backup-0002',
};

const PAYLOAD = {
  model: 'claude-opus-5',
  max_tokens: 64,
  messages: [{ role: 'user', content: 'hi' }],
};

test('forwards the payload and meters REAL usage, not the estimate', async (t) => {
  const stub = stubAnthropic(() => jsonRes(200, {
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'hello' }],
    usage: { input_tokens: 1000, output_tokens: 234 },
  }));
  t.after(stub.restore);

  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  const r = await fetch(`${base}/v1/route`, {
    method: 'POST',
    body: JSON.stringify({ tokens: 10, payload: PAYLOAD }),
  }).then((x) => x.json());

  // Booked 1234 (what was actually consumed), not the 10 the caller guessed.
  assert.equal(r.tokensUsed, 1234);
  assert.equal(r.model, 'claude-opus-5');
  assert.equal(r.response.content[0].text, 'hello');

  const status = await fetch(`${base}/v1/status`).then((x) => x.json());
  const primary = status.keys.find((k) => k.id === 'primary');
  assert.equal(primary.used, 1234, 'quota must reflect real consumption');
});

test('sends the secret upstream as x-api-key and never returns it', async (t) => {
  const stub = stubAnthropic(() => jsonRes(200, {
    model: 'claude-opus-5', content: [], usage: { input_tokens: 1, output_tokens: 1 },
  }));
  t.after(stub.restore);

  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  const raw = await fetch(`${base}/v1/route`, {
    method: 'POST',
    body: JSON.stringify({ tokens: 5, payload: PAYLOAD }),
  }).then((x) => x.text());

  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].opts.headers['x-api-key'], 'sk-ant-test-primary-0001');
  assert.equal(stub.calls[0].opts.headers['anthropic-version'], '2023-06-01');
  assert.ok(!raw.includes('sk-ant-test-primary-0001'), 'secret leaked to client!');
});

test('no payload → meter-only, and no provider call is made', async (t) => {
  const stub = stubAnthropic(() => jsonRes(500, { error: { message: 'should not be called' } }));
  t.after(stub.restore);

  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  const r = await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: 42 }),
  }).then((x) => x.json());

  assert.equal(r.tokensUsed, 42);
  assert.equal(stub.calls.length, 0, 'meter-only must not hit the provider');
});

test('a 401 from the provider trips the breaker and rotates off the key', async (t) => {
  const stub = stubAnthropic(() => jsonRes(401, { error: { message: 'invalid x-api-key' } }));
  t.after(stub.restore);

  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  // Fail enough times to open the breaker on the active key.
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${base}/v1/route`, {
      method: 'POST', body: JSON.stringify({ tokens: 5, payload: PAYLOAD }),
    });
    assert.equal(res.status, 502);
  }

  const status = await fetch(`${base}/v1/status`).then((x) => x.json());
  const primary = status.keys.find((k) => k.id === 'primary');
  assert.notEqual(primary.breaker.state, 'closed', 'a dead key must be quarantined');
});

test('a 400 from the provider does NOT punish the key', async (t) => {
  const stub = stubAnthropic(() => jsonRes(400, { error: { message: 'max_tokens: must be >= 1' } }));
  t.after(stub.restore);

  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  const res = await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: 5, payload: PAYLOAD }),
  });
  const body = await res.json();

  assert.equal(res.status, 400, 'caller error should surface as 400, not 502');
  assert.match(body.error, /max_tokens/);

  const status = await fetch(`${base}/v1/status`).then((x) => x.json());
  const primary = status.keys.find((k) => k.id === 'primary');
  assert.equal(primary.breaker.state, 'closed', 'a good key must not be quarantined for a caller typo');
});
