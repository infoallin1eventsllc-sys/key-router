import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, STATE } from '../src/circuit-breaker.js';
import { UsageTracker } from '../src/usage-tracker.js';

/** Fake clock — tests never sleep. */
const clock = (start = 0) => {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
};

test('breaker: opens after N consecutive failures, success resets', () => {
  const cb = new CircuitBreaker({ failureThreshold: 3, now: clock() });
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state, STATE.CLOSED);
  cb.recordSuccess(); // streak broken
  cb.recordFailure();
  cb.recordFailure();
  cb.recordFailure();
  assert.equal(cb.state, STATE.OPEN);
  assert.equal(cb.allows(), false);
});

test('breaker: half-opens after cooldown, failed probe re-opens', () => {
  const now = clock();
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now });
  cb.recordFailure();
  assert.equal(cb.state, STATE.OPEN);

  now.advance(1000);
  assert.equal(cb.state, STATE.HALF_OPEN);
  assert.equal(cb.allows(), true); // one probe allowed

  cb.recordFailure(); // probe failed → fresh cooldown
  assert.equal(cb.state, STATE.OPEN);
  now.advance(999);
  assert.equal(cb.state, STATE.OPEN); // full cooldown, not remainder
  now.advance(1);
  assert.equal(cb.state, STATE.HALF_OPEN);

  cb.recordSuccess(); // probe succeeded → healthy again
  assert.equal(cb.state, STATE.CLOSED);
});

test('tracker: accumulates within a window, resets after it', () => {
  const now = clock();
  const u = new UsageTracker({ windowMs: 60_000, now });
  u.record('k1', 400);
  u.record('k1', 100);
  assert.equal(u.used('k1'), 500);
  assert.equal(u.resetsIn('k1'), 60_000);

  now.advance(59_999);
  assert.equal(u.used('k1'), 500); // still inside window
  now.advance(1);
  assert.equal(u.used('k1'), 0);   // window rolled
});

test('tracker: rejects corrupt meter data loudly', () => {
  const u = new UsageTracker({ now: clock() });
  assert.throws(() => u.record('k1', -5), RangeError);
  assert.throws(() => u.record('k1', NaN), RangeError);
  assert.equal(u.used('k1'), 0); // books untouched
});

test('tracker: snapshot/restore round-trips (persistence seam)', () => {
  const now = clock();
  const a = new UsageTracker({ windowMs: 60_000, now });
  a.record('k1', 777);
  const b = new UsageTracker({ windowMs: 60_000, now });
  b.restore(a.snapshot());
  assert.equal(b.used('k1'), 777);
});
