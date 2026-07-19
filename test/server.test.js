import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

/** Real HTTP over a real (ephemeral) port — integration, not mocks. */
function start(app) {
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      const { port } = app.server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const ENV = {
  KEYROUTER_KEYS: JSON.stringify([
    { id: 'primary', provider: 'anthropic', limit: 1000 },
    { id: 'backup', provider: 'anthropic', limit: 1000 },
  ]),
  KEYROUTER_SECRET_primary: 'sk-ant-test-primary-0001',
  KEYROUTER_SECRET_backup: 'sk-ant-test-backup-0002',
  KEYROUTER_THRESHOLD: '80',
};

test('E2E: routes, then rotates before the primary key is exhausted', async (t) => {
  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  // Ride the primary key up to (but under) the 80% threshold.
  for (let i = 0; i < 7; i += 1) {
    const r = await fetch(`${base}/v1/route`, {
      method: 'POST', body: JSON.stringify({ tokens: 100 }),
    }).then((x) => x.json());
    assert.equal(r.keyId, 'primary');
    assert.equal(r.rotated, false);
  }

  // 8th request puts primary at 700/1000 → next crosses 80% → rotate.
  const r8 = await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: 100 }),
  }).then((x) => x.json());
  assert.equal(r8.keyId, 'primary'); // 800 used AFTER this call

  const r9 = await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: 100 }),
  }).then((x) => x.json());
  assert.equal(r9.keyId, 'backup');
  assert.equal(r9.rotated, true);
  assert.match(r9.reason, /threshold/);
});

test('E2E: /v1/status never leaks raw secrets', async (t) => {
  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  const text = await fetch(`${base}/v1/status`).then((x) => x.text());
  assert.ok(!text.includes('sk-ant-test-primary-0001'), 'raw secret leaked!');
  assert.ok(!text.includes('sk-ant-test-backup-0002'), 'raw secret leaked!');
  const body = JSON.parse(text);
  assert.equal(body.keys.length, 2);
  assert.match(body.keys[0].key, /…/); // redacted form present
});

test('E2E: provider failures trip the breaker and fail over', async (t) => {
  let calls = 0;
  const flakyProvider = async ({ secret, tokens }) => {
    calls += 1;
    if (secret.includes('primary')) throw new Error('simulated 401');
    return { ok: true, tokensUsed: tokens };
  };
  const app = createApp({ env: ENV, provider: flakyProvider });
  const base = await start(app);
  t.after(() => app.server.close());

  // Primary fails 3× (502s), breaker opens, traffic lands on backup.
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(`${base}/v1/route`, {
      method: 'POST', body: JSON.stringify({ tokens: 10 }),
    });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [502, 502, 502, 200]);

  const status = await fetch(`${base}/v1/status`).then((x) => x.json());
  const primary = status.keys.find((k) => k.id === 'primary');
  assert.equal(primary.breaker.state, 'open');
  assert.ok(calls >= 4);
});

test('E2E: input validation — bad JSON, bad tokens, oversized body', async (t) => {
  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  const bad = await fetch(`${base}/v1/route`, { method: 'POST', body: '{oops' });
  assert.equal(bad.status, 400);

  const neg = await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: -50 }),
  });
  assert.equal(neg.status, 400);

  const huge = await fetch(`${base}/v1/route`, {
    method: 'POST', body: '"' + 'x'.repeat(70 * 1024) + '"',
  });
  assert.equal(huge.status, 413);
});

test('E2E: misconfigured store fails fast with a clear message', () => {
  assert.throws(
    () => createApp({ env: { KEYROUTER_KEYS: '[{"id":"a"}]' } }),
    /missing env var KEYROUTER_SECRET_a/,
  );
  assert.throws(
    () => createApp({ env: { KEYROUTER_KEYS: 'not json' } }),
    /not valid JSON/,
  );
});
