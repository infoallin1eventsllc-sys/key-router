import test from 'node:test';
import assert from 'node:assert/strict';
import {
  usagePct, isRoutable, shouldRotate, selectKey, route, STRATEGIES,
} from '../src/router.js';

const key = (over = {}) => ({
  id: 'a', enabled: true, used: 0, limit: 100, circuitOpen: false, ...over,
});

test('usagePct: clamps and guards zero-limit', () => {
  assert.equal(usagePct(key({ used: 50 })), 50);
  assert.equal(usagePct(key({ used: 250 })), 100);
  assert.equal(usagePct(key({ limit: 0 })), 100); // zero-limit key is unusable
  assert.equal(usagePct(null), 100);
});

test('isRoutable: rejects disabled, tripped, and exhausted keys', () => {
  assert.equal(isRoutable(key()), true);
  assert.equal(isRoutable(key({ enabled: false })), false);
  assert.equal(isRoutable(key({ circuitOpen: true })), false);
  assert.equal(isRoutable(key({ used: 100 })), false);
  assert.equal(isRoutable(undefined), false);
});

test('shouldRotate: fires exactly at the threshold boundary', () => {
  assert.equal(shouldRotate(key({ used: 79 }), 80), false);
  assert.equal(shouldRotate(key({ used: 80 }), 80), true); // >= not >
  assert.equal(shouldRotate(null, 80), true);
});

test('selectKey: empty and all-down fleets return null', () => {
  assert.equal(selectKey([], { strategy: STRATEGIES.LOWEST_USAGE }), null);
  const down = [key({ enabled: false }), key({ id: 'b', circuitOpen: true })];
  assert.equal(selectKey(down, { strategy: STRATEGIES.LOWEST_USAGE }), null);
});

test('selectKey lowest-usage: picks most headroom, stable tie-break', () => {
  const fleet = [
    key({ id: 'a', used: 60 }),
    key({ id: 'b', used: 10 }),
    key({ id: 'c', used: 10 }),
  ];
  assert.equal(selectKey(fleet, { strategy: STRATEGIES.LOWEST_USAGE }).id, 'b');
});

test('selectKey round-robin: skips unroutable keys and wraps', () => {
  const fleet = [
    key({ id: 'a', used: 95 }),          // routable but high
    key({ id: 'b', circuitOpen: true }), // skipped
    key({ id: 'c' }),
  ];
  const picked = selectKey(fleet, {
    strategy: STRATEGIES.ROUND_ROBIN, activeId: 'a',
  });
  assert.equal(picked.id, 'c');
  // wraps past the end back to 'a'
  const wrapped = selectKey(fleet, {
    strategy: STRATEGIES.ROUND_ROBIN, activeId: 'c',
  });
  assert.equal(wrapped.id, 'a');
});

test('route: holds a healthy active key (no churn)', () => {
  const fleet = [key({ id: 'a', used: 20 }), key({ id: 'b' })];
  const d = route(fleet, {
    activeId: 'a', strategy: STRATEGIES.LOWEST_USAGE, thresholdPct: 80,
  });
  assert.deepEqual(
    { keyId: d.keyId, rotated: d.rotated },
    { keyId: 'a', rotated: false },
  );
});

test('route: rotates ahead of exhaustion with a human-readable reason', () => {
  const fleet = [key({ id: 'a', used: 85 }), key({ id: 'b', used: 5 })];
  const d = route(fleet, {
    activeId: 'a', strategy: STRATEGIES.LOWEST_USAGE, thresholdPct: 80,
  });
  assert.equal(d.keyId, 'b');
  assert.equal(d.rotated, true);
  assert.match(d.reason, /80% threshold/);
});

test('route: reports fleet outage instead of throwing', () => {
  const fleet = [key({ id: 'a', used: 100 })];
  const d = route(fleet, {
    activeId: 'a', strategy: STRATEGIES.LOWEST_USAGE, thresholdPct: 80,
  });
  assert.equal(d.keyId, null);
  assert.equal(d.reason, 'no routable keys');
});
