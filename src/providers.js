/**
 * providers.js — one adapter per upstream vendor.
 *
 * Providers differ in exactly three ways that matter to us: where to POST,
 * how to present the secret, and where the usage numbers live in the reply.
 * Everything above this file — routing, metering, circuit breakers, the
 * dashboard — is provider-agnostic, which is what lets a single fleet mix
 * keys from different vendors and different owners (yours, or a client's).
 *
 * Adding a vendor is adding an entry here. Nothing else changes.
 */

/** @typedef {{ url: string, headers: (secret: string) => Record<string,string>,
 *              usage: (body: any) => number, errorMessage: (body: any) => string|undefined }} Adapter */

export const PROVIDERS = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    headers: (secret) => ({
      'x-api-key': secret,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    // Anthropic reports input and output separately; quota cares about the sum.
    usage: (body) => (body?.usage?.input_tokens ?? 0) + (body?.usage?.output_tokens ?? 0),
    errorMessage: (body) => body?.error?.message,
  },

  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: (secret) => ({
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    }),
    usage: (body) => body?.usage?.total_tokens ?? 0,
    errorMessage: (body) => body?.error?.message,
  },
};

export const DEFAULT_PROVIDER = 'anthropic';

/**
 * Resolve a key's provider to its adapter.
 *
 * `KEYROUTER_URL_<PROVIDER>` overrides the endpoint, so the same adapter can
 * point at Azure OpenAI, a self-hosted gateway, or a compatible proxy without
 * a code change — useful when a client's key only works through their own
 * endpoint.
 *
 * Unknown names throw rather than silently defaulting: a typo'd provider
 * should fail at boot with a readable message, not quietly send a client's
 * traffic to the wrong vendor.
 */
export function adapterFor(name, env = {}) {
  const key = String(name || DEFAULT_PROVIDER).toLowerCase();
  const adapter = PROVIDERS[key];
  if (!adapter) {
    throw new Error(
      `unknown provider "${name}" — known providers: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  const override = env[`KEYROUTER_URL_${key.toUpperCase()}`];
  return override ? { ...adapter, url: override } : adapter;
}

/** Names accepted in KEYROUTER_KEYS entries. */
export function knownProviders() {
  return Object.keys(PROVIDERS);
}
