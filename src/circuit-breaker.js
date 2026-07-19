/**
 * circuit-breaker.js — per-key failure isolation.
 *
 * Classic three-state breaker:
 *
 *   CLOSED ──(failures ≥ threshold)──▶ OPEN ──(cooldown elapses)──▶ HALF_OPEN
 *      ▲                                                              │
 *      └────────────(probe succeeds)◀───────────┐    (probe fails)───┘
 *                                                └──────▶ back to OPEN
 *
 * Why a breaker instead of just counting errors: a key returning 401s will
 * fail *every* request. Without a breaker the router would keep burning
 * latency on a dead key; with one, the key is quarantined instantly and
 * re-probed on a schedule. Time is injected (`now`) so tests never sleep.
 */

export const STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
});

export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {number} opts.failureThreshold consecutive failures before opening
   * @param {number} opts.cooldownMs       how long to stay open before probing
   * @param {() => number} [opts.now]      clock, injectable for tests
   */
  constructor({ failureThreshold = 3, cooldownMs = 30_000, now = Date.now } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.openedAt = null;
  }

  get state() {
    if (this.openedAt === null) return STATE.CLOSED;
    return this.now() - this.openedAt >= this.cooldownMs
      ? STATE.HALF_OPEN
      : STATE.OPEN;
  }

  /** May a request pass through? Half-open admits ONE probe request. */
  allows() {
    return this.state !== STATE.OPEN;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure() {
    // A half-open probe that fails re-opens immediately with a fresh cooldown.
    if (this.state === STATE.HALF_OPEN) {
      this.openedAt = this.now();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
    }
  }

  toJSON() {
    return { state: this.state, failures: this.failures };
  }
}
