import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import {
  validate, RouteResponse, StatusResponse, ErrorResponse, HealthResponse,
} from '../src/schemas.js';

function start(app) {
  return new Promise((resolve) => {
    app.server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${app.server.address().port}`);
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
};

/** Assert a payload matches its schema, printing every violation. */
const conforms = (schema, payload, label) => {
  const problems = validate(schema, payload);
  assert.deepEqual(problems, [], `${label} violates contract: ${problems.join('; ')}`);
};

test('contract: every endpoint response matches its declared schema', async (t) => {
  const app = createApp({ env: ENV });
  const base = await start(app);
  t.after(() => app.server.close());

  // GET /healthz
  conforms(HealthResponse,
    await fetch(`${base}/healthz`).then((r) => r.json()), 'GET /healthz');

  // POST /v1/route — success path
  conforms(RouteResponse,
    await fetch(`${base}/v1/route`, {
      method: 'POST', body: JSON.stringify({ tokens: 50 }),
    }).then((r) => r.json()), 'POST /v1/route 200');

  // GET /v1/status
  conforms(StatusResponse,
    await fetch(`${base}/v1/status`).then((r) => r.json()), 'GET /v1/status');

  // POST /v1/route — validation failure path
  const bad = await fetch(`${base}/v1/route`, {
    method: 'POST', body: JSON.stringify({ tokens: -1, junk: true }),
  });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  conforms(ErrorResponse, badBody, 'POST /v1/route 400');
  // Structured details: caller learns EVERY problem, not just the first.
  assert.ok(badBody.details.some((d) => d.includes('tokens')), 'reports bad tokens');
  assert.ok(badBody.details.some((d) => d.includes('junk')), 'reports unknown field');

  // 404 path
  conforms(ErrorResponse,
    await fetch(`${base}/nowhere`).then((r) => r.json()), 'GET 404');
});

test('contract: schema validator itself behaves', () => {
  // non-objects rejected
  assert.deepEqual(validate({ a: { type: 'string' } }, null), ['value must be an object']);
  assert.deepEqual(validate({ a: { type: 'string' } }, []), ['value must be an object']);

  // nested paths in error messages
  const errs = validate(StatusResponse, { config: { strategy: 'chaos', thresholdPct: 80 }, keys: [] });
  assert.ok(errs.some((e) => e.includes('config.strategy')));

  // unknown fields rejected at any depth
  const errs2 = validate({ a: { type: 'string', required: true } }, { a: 'x', b: 1 });
  assert.deepEqual(errs2, ['b is not a known field']);
});

test('contract: key store config errors are aggregated and structured', () => {
  assert.throws(
    () => createApp({
      env: {
        KEYROUTER_KEYS: '[{"id":"a","limit":-5,"bogus":1}]',
        KEYROUTER_SECRET_a: 'sk-x-0000000000',
      },
    }),
    /limit must be ≥ 1.*bogus is not a known field/s,
  );
  assert.throws(
    () => createApp({
      env: {
        KEYROUTER_KEYS: '[{"id":"a"},{"id":"a"}]',
        KEYROUTER_SECRET_a: 'sk-x-0000000000',
      },
    }),
    /duplicate key id/,
  );
});
