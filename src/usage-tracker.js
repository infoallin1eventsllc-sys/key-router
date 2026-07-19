/**
 * usage-tracker.js — per-key token accounting over a rolling window.
 *
 * Providers meter usage per minute/day; this tracker mirrors that with a
 * fixed window that resets automatically. Time is injected so tests are
 * deterministic. State is process-local by design: for a single-instance
 * deployment (the common case for a small business) this is correct and
 * free. The `snapshot()`/`restore()` pair is the seam for adding Redis or
 * a database later without touching callers.
 */

export class UsageTracker {
  /**
   * @param {object} opts
   * @param {number} opts.windowMs  metering window length (default 24 h)
   * @param {() => number} [opts.now]
   */
  constructor({ windowMs = 86_400_000, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    /** @type {Map<string, {used: number, windowStart: number}>} */
    this.buckets = new Map();
  }

  #bucket(keyId) {
    const t = this.now();
    let b = this.buckets.get(keyId);
    if (!b || t - b.windowStart >= this.windowMs) {
      b = { used: 0, windowStart: t };
      this.buckets.set(keyId, b);
    }
    return b;
  }

  /** Record consumption. Rejects negative/NaN input loudly — bad meter
   *  data should crash a request, never corrupt the books. */
  record(keyId, tokens) {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new RangeError(`invalid token count: ${tokens}`);
    }
    this.#bucket(keyId).used += tokens;
  }

  used(keyId) {
    return this.#bucket(keyId).used;
  }

  /** Milliseconds until this key's window resets. */
  resetsIn(keyId) {
    const b = this.#bucket(keyId);
    return Math.max(0, b.windowStart + this.windowMs - this.now());
  }

  snapshot() {
    return Object.fromEntries(this.buckets);
  }

  restore(data) {
    this.buckets = new Map(Object.entries(data ?? {}));
  }
}
