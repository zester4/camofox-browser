/**
 * Webhook receiver for AgentCard events.
 *
 * AgentCard webhook rules (docs: Webhooks):
 *  - Each delivery carries `AgentCard-Signature: t=<unix>,v1=<hex>`, an
 *    HMAC-SHA256 over `${t}.${rawBody}` keyed with the endpoint secret.
 *    Check it on the raw bytes, and reject timestamps older than a few minutes.
 *  - Delivery is at least once. De-duplicate on the event `id`.
 *  - Answer 2xx quickly. A failed delivery is retried up to 5 times, so a
 *    failed handler returns 500 and releases the event id for the retry.
 *
 * Events handled:
 *  - vault.session_linked   -> the session's user_id is stored against our user
 *  - vault.card_stored      -> recorded for the audit trail
 *  - checkout_authorization.* -> purchase status and settlement
 * Other families are accepted and ignored.
 */
import { verifyWebhookSignature } from './webhook.js';

export const SIGNATURE_HEADER = 'agentcard-signature';

/**
 * @param {{
 *   secret: string,
 *   store: ReturnType<import('./store.js').createMemoryStore>,
 *   vault: ReturnType<import('./vault.js').createVault>,
 *   checkout: ReturnType<import('./checkout.js').createCheckout>,
 *   log?: (level: string, msg: string, fields?: object) => void,
 *   onEvent?: (event: object) => void,
 *   now?: () => number,
 * }} deps
 */
export function createWebhookHandler({ secret, store, vault, checkout, log = () => {}, onEvent, now }) {
  if (!secret) throw new Error('webhook secret is required');

  async function dispatch(event) {
    const data = event.data ?? {};
    if (event.type === 'vault.session_linked') {
      vault.onSessionLinked(data);
    } else if (event.type === 'vault.card_stored') {
      vault.onCardStored(data);
    } else if (event.type.startsWith('checkout_authorization.')) {
      checkout.applyWebhookEvent(event);
    }
    if (onEvent) onEvent(event);
  }

  /**
   * @param {{ headers: Record<string, string | string[] | undefined>, rawBody: string | Buffer }} request
   * @returns {Promise<{ status: number, body: object }>}
   */
  return async function handle({ headers, rawBody }) {
    const header = headers?.[SIGNATURE_HEADER];
    const ok = verifyWebhookSignature({
      header: Array.isArray(header) ? header[0] : header,
      rawBody,
      secret,
      now: now ? Math.floor(now() / 1000) : undefined,
    });
    if (!ok) {
      log('warn', 'agentcard: webhook signature rejected');
      return { status: 401, body: { error: 'invalid_signature' } };
    }

    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    } catch {
      return { status: 400, body: { error: 'invalid_json' } };
    }
    if (!event?.id || typeof event.type !== 'string') {
      return { status: 400, body: { error: 'missing_id_or_type' } };
    }

    if (!store.markEventSeen(event.id)) {
      return { status: 200, body: { received: true, duplicate: true } };
    }

    try {
      await dispatch(event);
      log('info', 'agentcard: webhook handled', { type: event.type, id: event.id });
      return { status: 200, body: { received: true } };
    } catch (err) {
      store.unmarkEvent(event.id);
      log('error', 'agentcard: webhook handler failed', { type: event.type, id: event.id, reason: err.message });
      return { status: 500, body: { error: 'handler_failed' } };
    }
  };
}
