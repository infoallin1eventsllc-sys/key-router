/**
 * schemas.js — the data contract for the entire system, in one file.
 *
 * Every payload that crosses a boundary (HTTP in, HTTP out, env config)
 * has a declared shape here, and the boundaries enforce it. No shape
 * exists only as an implicit convention in someone's head.
 *
 * The validator is deliberately tiny (~40 lines): declarative field rules,
 * exhaustive error reporting (all problems at once, not just the first),
 * and unknown-field rejection so payloads can't silently grow junk.
 */

/** @typedef {{ type: string, required?: boolean, min?: number, max?: number,
 *              enum?: any[], items?: Schema, shape?: Record<string, Rule>,
 *              passthrough?: boolean }} Rule */
/** @typedef {Record<string, Rule>} Schema */

/**
 * Validate a value against a schema.
 * @returns {string[]} list of human-readable problems; empty means valid.
 */
export function validate(schema, value, path = '') {
  const errors = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path || 'value'} must be an object`];
  }

  for (const [field, rule] of Object.entries(schema)) {
    const p = path ? `${path}.${field}` : field;
    const v = value[field];

    if (v === undefined || v === null) {
      if (rule.required) errors.push(`${p} is required`);
      continue;
    }
    if (rule.type === 'array') {
      if (!Array.isArray(v)) { errors.push(`${p} must be an array`); continue; }
      if (rule.items?.shape) {
        v.forEach((item, i) => errors.push(...validate(rule.items.shape, item, `${p}[${i}]`)));
      }
      continue;
    }
    if (rule.type === 'object') {
      // A `passthrough` field is an opaque payload we forward verbatim to a
      // provider. We assert that it IS an object and stop there: the provider
      // owns that contract, not us, so validating its interior would only
      // couple us to someone else's schema and break when they extend it.
      if (rule.passthrough) {
        if (Array.isArray(v)) errors.push(`${p} must be an object`);
        continue;
      }
      errors.push(...validate(rule.shape ?? {}, v, p));
      continue;
    }
    if (typeof v !== rule.type) {
      errors.push(`${p} must be a ${rule.type}, got ${typeof v}`);
      continue;
    }
    if (rule.type === 'number' && !Number.isFinite(v)) errors.push(`${p} must be finite`);
    if (rule.min !== undefined && v < rule.min) errors.push(`${p} must be ≥ ${rule.min}`);
    if (rule.max !== undefined && v > rule.max) errors.push(`${p} must be ≤ ${rule.max}`);
    if (rule.enum && !rule.enum.includes(v)) errors.push(`${p} must be one of: ${rule.enum.join(', ')}`);
  }

  // Reject unknown fields: contracts are closed, not open-ended.
  for (const field of Object.keys(value)) {
    if (!(field in schema)) errors.push(`${path ? path + '.' : ''}${field} is not a known field`);
  }
  return errors;
}

/* ── Inbound ───────────────────────────────────────────────────────────── */

/** POST /v1/route request body */
export const RouteRequest = {
  tokens: { type: 'number', required: true, min: 1, max: 10_000_000 },
  // Optional provider request body (e.g. an Anthropic Messages payload).
  // Present  → Key Router forwards the call and meters REAL usage.
  // Absent   → reserve/meter only: you get a routing decision and accounting
  //            without a provider call, which is all some callers want.
  payload: { type: 'object', passthrough: true },
};

/** One entry of the KEYROUTER_KEYS env array */
export const KeyConfig = {
  id: { type: 'string', required: true },
  provider: { type: 'string' },
  limit: { type: 'number', min: 1 },
  enabled: { type: 'boolean' },
};

/* ── Outbound ──────────────────────────────────────────────────────────── */

/** 200 body from POST /v1/route */
export const RouteResponse = {
  keyId: { type: 'string', required: true },
  rotated: { type: 'boolean', required: true },
  reason: { type: 'string', required: true },
  tokensUsed: { type: 'number', required: true, min: 0 },
  // Only present when a `payload` was forwarded: the provider's own reply,
  // passed through untouched, plus the model that actually served it.
  model: { type: 'string' },
  response: { type: 'object', passthrough: true },
};

/** One key entry inside StatusResponse */
export const KeyStatus = {
  id: { type: 'string', required: true },
  provider: { type: 'string', required: true },
  limit: { type: 'number', required: true, min: 1 },
  enabled: { type: 'boolean', required: true },
  key: { type: 'string', required: true },        // ALWAYS redacted
  used: { type: 'number', required: true, min: 0 },
  resetsInMs: { type: 'number', required: true, min: 0 },
  active: { type: 'boolean', required: true },
  breaker: {
    type: 'object', required: true,
    shape: {
      state: { type: 'string', required: true, enum: ['closed', 'open', 'half-open'] },
      failures: { type: 'number', required: true, min: 0 },
    },
  },
};

/** GET /v1/status body */
export const StatusResponse = {
  config: {
    type: 'object', required: true,
    shape: {
      strategy: { type: 'string', required: true, enum: ['lowest-usage', 'round-robin'] },
      thresholdPct: { type: 'number', required: true, min: 1, max: 99 },
    },
  },
  keys: { type: 'array', required: true, items: { shape: KeyStatus } },
};

/** Any non-2xx body */
export const ErrorResponse = {
  error: { type: 'string', required: true },
  reason: { type: 'string' },
  keyId: { type: 'string' },
  requestId: { type: 'string' },
  details: { type: 'array' },
};

/** GET /healthz body */
export const HealthResponse = {
  ok: { type: 'boolean', required: true },
  keys: { type: 'number', required: true, min: 0 },
};
