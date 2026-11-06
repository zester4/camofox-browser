/**
 * AgentCard configuration.
 *
 * This module does not read process.env. The app reads its environment in
 * lib/config.js (the repo's rule) and passes the AgentCard block here. Scripts
 * that run outside the server read the environment themselves and pass it in.
 *
 * Environment variables hold only secrets and service URLs:
 *   AGENTCARD_CLIENT_ID, AGENTCARD_CLIENT_SECRET, AGENTCARD_WEBHOOK_SECRET,
 *   AGENTCARD_BASE_URL (optional).
 * Product behaviour is set in code, not by environment variables.
 *
 * Secret values are never returned by describeConfig().
 */

export const DEFAULT_BASE_URL = 'https://api.agentcard.sh';

/**
 * @param {Record<string, string | undefined>} source  e.g. process.env, or the AgentCard block of lib/config.js
 * @returns {{ clientId: string, clientSecret: string, webhookSecret: string | null, baseUrl: string }}
 */
export function loadConfig(source) {
  const clientId = (source.clientId ?? source.AGENTCARD_CLIENT_ID ?? '').trim();
  const clientSecret = (source.clientSecret ?? source.AGENTCARD_CLIENT_SECRET ?? '').trim();
  const webhookSecret = (source.webhookSecret ?? source.AGENTCARD_WEBHOOK_SECRET ?? '').trim();
  const baseUrl = (source.baseUrl ?? source.AGENTCARD_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  return {
    clientId,
    clientSecret,
    webhookSecret: webhookSecret || null,
    baseUrl,
  };
}

/**
 * Throws a clear error when the credentials are missing. Names the variables,
 * never their values.
 * @param {ReturnType<typeof loadConfig>} config
 */
export function requireCredentials(config) {
  const missing = [];
  if (!config.clientId) missing.push('AGENTCARD_CLIENT_ID');
  if (!config.clientSecret) missing.push('AGENTCARD_CLIENT_SECRET');
  if (missing.length) {
    const err = new Error(`AgentCard is not configured. Missing: ${missing.join(', ')}`);
    err.code = 'not_configured';
    throw err;
  }
  return config;
}

/** Safe-to-log summary: whether each value is set, never the value. */
export function describeConfig(config) {
  return {
    clientId: config.clientId ? 'set' : 'missing',
    clientSecret: config.clientSecret ? 'set' : 'missing',
    webhookSecret: config.webhookSecret ? 'set' : 'missing',
    baseUrl: config.baseUrl,
  };
}
