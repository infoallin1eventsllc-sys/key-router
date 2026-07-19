import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

function start(app) {
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${app.server.address().port}`);
    });
  });
}

const BASE_ENV = {
  KEYROUTER_KEYS: JSON.stringify([{ id: 'primary', limit: 1000 }]),
  KEYROUTER_SECRET_primary: 'sk-ant-test-primary-0001',
};

test('auth: protected endpoints reject missing/wrong tokens, accept the right one', async (t) => {
  const app = createApp({ env: { ...BASE_ENV, KEYROUTER_AUTH_TOKEN: 'shhh-topsecret' } });
  const base = await start(app);
  t.after(() => app.server.close());

  // No token → 401
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);

  // Wrong token → 401
  const wrong = await fetch(`${base}/v1/route`, {
    method: 'POST',
    headers: { authorization: 'Bearer nope' },
    body: JSON.stringify({ tokens: 10 }),
  });
  assert.equal(wrong.status, 401);

  // Right token → 200
  const ok = await fetch(`${base}/v1/status`, {
    headers: { authorization: 'Bearer shhh-topsecret' },
  });
  assert.equal(ok.status, 200);

  // /healthz stays open — load balancers don't carry credentials
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('cors: allow-listed origin is reflected, others get nothing', async (t) => {
  const app = createApp({
    env: { ...BASE_ENV, KEYROUTER_ALLOWED_ORIGINS: 'https://app.example.com' },
  });
  const base = await start(app);
  t.after(() => app.server.close());

  // Preflight from an allowed origin
  const pre = await fetch(`${base}/v1/route`, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example.com' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://app.example.com');

  // Unknown origin: no CORS headers reflected (browser will block it)
  const evil = await fetch(`${base}/healthz`, {
    headers: { origin: 'https://evil.example.net' },
  });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('persistence: usage survives a full restart via the state file', async (t) => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kr-')), 'state.json');
  const env = { ...BASE_ENV, KEYROUTER_STATE_FILE: stateFile };

  // First life: spend 400 tokens, then "crash" (close without ceremony).
  const first = createApp({ env });
  const base1 = await start(first);
  await fetch(`${base1}/v1/route`, { method: 'POST', body: JSON.stringify({ tokens: 400 }) });
  first.server.close();

  assert.ok(fs.existsSync(stateFile), 'state file written after request');

  // Second life: metering picks up where it left off.
  const second = createApp({ env });
  const base2 = await start(second);
  t.after(() => second.server.close());

  const status = await fetch(`${base2}/v1/status`).then((r) => r.json());
  assert.equal(status.keys[0].used, 400, 'usage restored across restart');
});

test('persistence: corrupt state file starts fresh instead of crashing', async (t) => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kr-')), 'state.json');
  fs.writeFileSync(stateFile, '{not json at all');

  const app = createApp({ env: { ...BASE_ENV, KEYROUTER_STATE_FILE: stateFile } });
  const base = await start(app);
  t.after(() => app.server.close());

  const status = await fetch(`${base}/v1/status`).then((r) => r.json());
  assert.equal(status.keys[0].used, 0, 'fresh books, no crash');
});
