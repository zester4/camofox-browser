/**
 * Pay on any site through a Playwright-style page, including Chusky.
 *
 * Why this exists: the AgentCard SDK's browser path (attachToPlaywright) is
 * documented for Chromium. It drives Chromium over CDP, and on Firefox it refuses
 * a classic-mode payment step. Chusky is Firefox-based, so we do the documented
 * "your own interception" path instead: pause the processor's card request with
 * the page's own request routing, ask AgentCard for an authorization, give the
 * approval link to the user untouched, and replay AgentCard's processor response
 * into the paused request once the user has approved on their own device.
 *
 * Matching uses the SDK's own findRecognizer, so the rules for which request is
 * a card request are the SDK's, not ours.
 *
 * Safety rules enforced here:
 * - One payment per attachment. After a request is approved or submitted, every
 *   further matching request is aborted, so a page retry cannot charge twice.
 *   A declined, expired or refused attempt may be tried again (the docs' retry rule).
 * - A recognizer that needs a prepared checkout (preparationRequired) is refused
 *   on this path, because AgentCard answers preparation_required to an ordinary
 *   authorization for it. Nothing is sent for it.
 * - GET and other recognizers the SDK never pauses are left alone.
 * - A paused request that cannot be completed is aborted. It is never sent on.
 * - The approval URL is passed to onApprovalUrl untouched and is never logged.
 */
import { findRecognizer } from '@agent-cards/sdk';

const FINAL_FAILURE = new Set(['declined', 'expired', 'refused']);
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // authorizations expire after 15 minutes
const MIN_POLL_MS = 1000;

/**
 * Turn the recognizer list served by AgentCard into the shape the SDK's
 * findRecognizer reads (RegExp fields), as the SDK's own sync does.
 * Entries without hosts[] are refused by the server's allowlist, so they are dropped.
 * @param {object[]} served
 */
export function toRegistry(served) {
  if (!Array.isArray(served)) return [];
  return served
    .filter((e) => e && typeof e === 'object' && !('merchant_profile' in e) && Array.isArray(e.hosts) && typeof e.match === 'string')
    .map((e) => ({
      ...e,
      match: new RegExp(e.match, 'i'),
      passthroughHeaders: (e.passthroughHeaders ?? []).map((h) => new RegExp(h, 'i')),
    }));
}

/** The method a recognizer's card request uses, as the SDK reads it. */
export function recognizerMethod(rec) {
  const method = rec?.request?.method;
  return method === 'GET' || method === 'PUT' ? method : 'POST';
}

/** CORS headers for a fulfilled response, so the page's script can read it. */
export function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
  };
}

/**
 * Attach a payment interception to a page.
 *
 * @param {object} page Playwright-style page (page.route, route.request(), route.fulfill, route.abort, route.continue, page.unroute)
 * @param {{
 *   checkout: object,              // createCheckout(...) from checkout.js
 *   api: object,                   // the AgentCard API client (getAuthorization, cancelAuthorization)
 *   registry: object[],            // toRegistry(served recognizers)
 *   userId: string,                // our user id; the card on file pays
 *   merchant: string,              // shown on the approval screen
 *   amount: number,                // minor units
 *   currency: string,              // ISO 4217, lowercase
 *   checkoutOrigin?: string,       // https origin of the merchant checkout page
 *   cardId?: string,               // which stored card; default the first on file
 *   onApprovalUrl: (url: string, purchaseId: string) => void,
 *   log?: (level: string, msg: string, fields?: object) => void,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ state: () => object, results: () => object[], detach: () => Promise<void> }>}
 */
export async function attachInterception(page, options) {
  const {
    checkout, api, registry, userId, merchant, amount, currency,
    checkoutOrigin, cardId, onApprovalUrl,
    log = () => {}, now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  if (typeof onApprovalUrl !== 'function') throw new Error('onApprovalUrl is required: it delivers the approval link to the user');
  if (!Array.isArray(registry) || registry.length === 0) {
    const err = new Error('AgentCard served no recognizers for token checkout; nothing can be paused on this account');
    err.code = 'no_recognizers';
    throw err;
  }

  const results = [];
  let phase = 'idle'; // idle | pending | completed

  async function complete(route, req, rec) {
    phase = 'pending';
    const origin = req.headers().origin;
    const purchase = await checkout.request(userId, {
      merchant,
      amount,
      currency,
      psp: rec.psp,
      cardId,
      checkoutOrigin,
      request: { url: req.url(), method: req.method(), headers: req.headers(), body: req.postData() ?? '' },
    });
    if (!purchase.approvalUrl) throw Object.assign(new Error('AgentCard returned no approval link'), { code: 'no_approval_link' });
    onApprovalUrl(purchase.approvalUrl, purchase.purchaseId);
    log('info', 'agentcard: paused card request, awaiting approval', { purchaseId: purchase.purchaseId, psp: rec.psp });

    const deadline = now() + timeoutMs;
    for (;;) {
      const auth = await api.getAuthorization(purchase.purchaseId);
      const updated = checkout.applyAuthorization(userId, purchase.purchaseId, auth);

      if ((auth.status === 'approved' || auth.status === 'submitted_on_device') && auth.response) {
        const resp = auth.response;
        const body = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body ?? '');
        await route.fulfill({
          status: resp.status,
          headers: { ...(resp.headers ?? {}), ...corsHeaders(origin) },
          body,
        });
        phase = 'completed';
        results.push({ purchaseId: purchase.purchaseId, status: updated.status, psp: rec.psp, at: new Date(now()).toISOString() });
        return;
      }

      if (FINAL_FAILURE.has(auth.status)) {
        await route.abort('failed');
        phase = 'idle'; // a declined attempt may be retried, as the docs allow
        results.push({ purchaseId: purchase.purchaseId, status: auth.status, reason: auth.reason ?? null, psp: rec.psp, at: new Date(now()).toISOString() });
        return;
      }

      if (now() >= deadline) {
        await api.cancelAuthorization(purchase.purchaseId).catch(() => {});
        await route.abort('timedout');
        phase = 'idle';
        results.push({ purchaseId: purchase.purchaseId, status: 'expired', reason: 'approval_timeout', psp: rec.psp, at: new Date(now()).toISOString() });
        return;
      }

      const wait = Math.max(MIN_POLL_MS, Number(auth.poll_interval_ms ?? 2000));
      await sleep(wait);
    }
  }

  async function handle(route) {
    const req = route.request();
    const rec = findRecognizer(req.url(), registry);
    if (!rec || recognizerMethod(rec) !== req.method().toUpperCase() || recognizerMethod(rec) === 'GET') {
      return route.continue();
    }
    if (rec.preparationRequired === true) {
      results.push({ status: 'refused', reason: 'preparation_required', psp: rec.psp, at: new Date(now()).toISOString() });
      log('warn', 'agentcard: processor needs a prepared checkout; not paused on this path', { psp: rec.psp });
      return route.abort('failed');
    }
    if (phase !== 'idle') {
      results.push({ status: 'refused', reason: 'duplicate_blocked', psp: rec.psp, at: new Date(now()).toISOString() });
      return route.abort('failed');
    }
    try {
      await complete(route, req, rec);
    } catch (err) {
      // Never forward a paused request we could not complete. Log the code, not the payload.
      log('error', 'agentcard: payment interception failed', { code: err?.code ?? null, psp: rec.psp });
      results.push({ status: 'failed', reason: err?.code ?? 'interception_failed', psp: rec.psp, at: new Date(now()).toISOString() });
      phase = 'idle';
      await route.abort('failed').catch(() => {});
    }
  }

  const handler = (route) => handle(route);
  await page.route('**/*', handler);

  return {
    state: () => ({ phase }),
    results: () => results.slice(),
    async detach() {
      await page.unroute('**/*', handler);
    },
  };
}
