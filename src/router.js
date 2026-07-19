/**
 * router.js — pure key-selection logic.
 *
 * Zero I/O, zero side effects. Every function takes state in and returns a
 * decision out, which is what makes this module 100% unit-testable and lets
 * the exact same logic run in a browser demo, an Express app, or a
 * serverless function.
 */

/** @typedef {Object} KeyHealth
 *  @property {string}  id
 *  @property {boolean} enabled
 *  @property {number}  used        tokens consumed in current window
 *  @property {number}  limit       tokens allowed per window
 *  @property {boolean} circuitOpen breaker tripped (key failing)
 */

export const STRATEGIES = Object.freeze({
  LOWEST_USAGE: 'lowest-usage',
  ROUND_ROBIN: 'round-robin',
});

/** Percentage of quota consumed, clamped to [0, 100]. */
export function usagePct(key) {
  if (!key || key.limit <= 0) return 100; // a zero-limit key is unusable
  return Math.min(100, (key.used / key.limit) * 100);
}

/** A key may serve traffic iff it is enabled, its breaker is closed,
 *  and it has quota headroom. */
export function isRoutable(key) {
  return Boolean(key) && key.enabled && !key.circuitOpen && usagePct(key) < 100;
}

/**
 * Should the router proactively rotate away from the active key?
 * True when the key is missing, unroutable, or has crossed the
 * switch-ahead threshold (rotate BEFORE quota runs out).
 */
export function shouldRotate(activeKey, thresholdPct) {
  if (!isRoutable(activeKey)) return true;
  return usagePct(activeKey) >= thresholdPct;
}

/**
 * Select the next key to route to.
 *
 * @param {KeyHealth[]} keys
 * @param {object} opts
 * @param {string}  opts.strategy   one of STRATEGIES
 * @param {string=} opts.activeId   currently active key id (round-robin anchor)
 * @returns {KeyHealth|null} the chosen key, or null if the fleet is down
 */
export function selectKey(keys, { strategy, activeId } = {}) {
  const candidates = keys.filter(isRoutable);
  if (candidates.length === 0) return null;

  if (strategy === STRATEGIES.ROUND_ROBIN) {
    const start = keys.findIndex((k) => k.id === activeId);
    for (let i = 1; i <= keys.length; i += 1) {
      const key = keys[(start + i) % keys.length];
      if (isRoutable(key)) return key;
    }
    return candidates[0]; // unreachable, defensive
  }

  // LOWEST_USAGE (default): most headroom first; stable tie-break by id
  return candidates
    .slice()
    .sort((a, b) => usagePct(a) - usagePct(b) || a.id.localeCompare(b.id))[0];
}

/**
 * One routing decision: given fleet state + config, return what to do.
 * The server layer executes the decision; this function only decides.
 *
 * @returns {{ keyId: string|null, rotated: boolean, reason: string }}
 */
export function route(keys, { activeId, strategy, thresholdPct }) {
  const active = keys.find((k) => k.id === activeId) ?? null;

  if (!shouldRotate(active, thresholdPct)) {
    return { keyId: active.id, rotated: false, reason: 'active key healthy' };
  }

  const next = selectKey(keys, { strategy, activeId });
  if (!next) {
    return { keyId: null, rotated: false, reason: 'no routable keys' };
  }

  const reason = !active
    ? 'no active key'
    : active.circuitOpen
      ? 'circuit open on active key'
      : !active.enabled
        ? 'active key disabled'
        : usagePct(active) >= 100
          ? 'active key exhausted'
          : `active key crossed ${thresholdPct}% threshold`;

  return { keyId: next.id, rotated: next.id !== activeId, reason };
}
