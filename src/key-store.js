/**
 * key-store.js — the ONLY module allowed to touch raw API keys.
 *
 * Security invariants, enforced in code rather than by convention:
 *   1. Keys load from environment variables — never from source, never
 *      from the client.
 *   2. Raw key material is held in a closure (#secrets), not on the
 *      object, so `JSON.stringify(store)` can never leak it.
 *   3. Everything that leaves this module is redacted.
 *
 * Configuration format (env):
 *   KEYROUTER_KEYS='[{"id":"primary","provider":"anthropic","limit":100000}]'
 *   KEYROUTER_SECRET_primary='sk-ant-...'
 *
 * Metadata is public-ish JSON; each secret rides in its own env var named
 * after the key id, which plays nicely with Netlify/Vercel/Fly dashboards.
 */

import { validate, KeyConfig } from './schemas.js';

const SECRET_PREFIX = 'KEYROUTER_SECRET_';

export function redact(secret) {
  if (typeof secret !== 'string' || secret.length < 10) return '••••••';
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

export class KeyStore {
  #secrets = new Map();

  /** @param {NodeJS.ProcessEnv} env */
  constructor(env = process.env) {
    /** @type {Array<{id:string, provider:string, limit:number, enabled:boolean}>} */
    this.meta = [];

    const raw = env.KEYROUTER_KEYS;
    if (!raw) return; // empty store is valid; server reports it via /healthz

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('KEYROUTER_KEYS is not valid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('KEYROUTER_KEYS must be a JSON array');
    }

    for (const item of parsed) {
      const problems = validate(KeyConfig, item);
      if (problems.length > 0) {
        throw new Error(`KEYROUTER_KEYS entry invalid: ${problems.join('; ')}`);
      }
      if (this.#secrets.has(item.id)) {
        throw new Error(`duplicate key id: ${item.id}`);
      }
      const secret = env[SECRET_PREFIX + item.id];
      if (!secret) {
        throw new Error(`missing env var ${SECRET_PREFIX}${item.id}`);
      }
      this.#secrets.set(item.id, secret);
      this.meta.push({
        id: item.id,
        provider: item.provider ?? 'anthropic',
        limit: Number(item.limit) > 0 ? Number(item.limit) : 100_000,
        enabled: item.enabled !== false,
      });
    }
  }

  /** Raw secret — call sites are grep-able, which is the point. */
  secretFor(id) {
    const s = this.#secrets.get(id);
    if (!s) throw new Error(`unknown key id: ${id}`);
    return s;
  }

  /** Safe-to-log view. Secrets are redacted at the source. */
  publicView() {
    return this.meta.map((m) => ({
      ...m,
      key: redact(this.#secrets.get(m.id)),
    }));
  }
}
