/**
 * Express handlers for the AgentCard routes. server.js mounts them and holds
 * the OpenAPI documentation for each route.
 *
 * Authentication: the user routes sit behind the app's access-key middleware,
 * like every other Camofox route, so only the app's backend can call them. The
 * backend names the user (`userId`). The webhook route is different: AgentCard
 * calls it, and the HMAC signature is its only authentication.
 *
 * What goes back to the backend: links (vault and approval) and card display
 * fields. Those links are for the backend to deliver to the user untouched.
 * Never returned: card numbers, tokens, client secrets, webhook secrets.
 */
import { AgentCardError } from './api.js';

const STATUS_BY_CODE = {
  invalid_request: 400,
  not_found: 404,
  not_enrolled: 409,
  no_card: 409,
  card_not_found: 404,
  over_limit: 422,
  not_configured: 503,
};

function userIdFrom(req) {
  const fromBody = req.body && typeof req.body === 'object' ? req.body.userId : undefined;
  const fromQuery = req.query ? req.query.userId : undefined;
  const value = fromBody ?? fromQuery;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sendError(res, err, log) {
  if (err instanceof AgentCardError) {
    log('error', 'agentcard: upstream error', { status: err.status, code: err.code });
    return res.status(502).json({ error: 'agentcard_unavailable', upstreamStatus: err.status, retryable: err.retryable });
  }
  const status = STATUS_BY_CODE[err?.code];
  if (status) return res.status(status).json({ error: err.code, message: err.message });
  log('error', 'agentcard: unexpected error', { reason: err?.message });
  return res.status(500).json({ error: 'internal_error' });
}

/**
 * @param {{
 *   vault: ReturnType<import('./vault.js').createVault>,
 *   checkout: ReturnType<import('./checkout.js').createCheckout>,
 *   webhooks: () => (args: object) => Promise<{ status: number, body: object }>,
 *   log?: (level: string, msg: string, fields?: object) => void,
 * }} deps
 */
export function createHttpHandlers({ vault, checkout, webhooks, log = () => {} }) {
  /** Wrap a handler so that user checks and errors are handled in one place. */
  function userRoute(fn) {
    return async (req, res) => {
      const userId = userIdFrom(req);
      if (!userId) return res.status(400).json({ error: 'invalid_request', message: 'userId is required' });
      try {
        await fn(req, res, userId);
      } catch (err) {
        sendError(res, err, log);
      }
    };
  }

  return {
    /** POST /agentcard/vault/enrol */
    enrol: userRoute(async (req, res, userId) => {
      const addAnother = req.body?.addAnother === true;
      const result = await vault.start(userId, { addAnother });
      if (result.status === 'has_card') return res.json(result);
      return res.status(result.reused ? 200 : 201).json(result);
    }),

    /** GET /agentcard/vault/sessions/:sessionId */
    pollSession: userRoute(async (req, res, userId) => {
      res.json(await vault.poll(userId, req.params.sessionId));
    }),

    /** GET /agentcard/vault/cards */
    listCards: userRoute(async (req, res, userId) => {
      res.json(await vault.listCards(userId));
    }),

    /** POST /agentcard/purchases */
    createPurchase: userRoute(async (req, res, userId) => {
      res.status(201).json(await checkout.request(userId, req.body ?? {}));
    }),

    /** GET /agentcard/purchases */
    listPurchases: userRoute(async (req, res, userId) => {
      res.json({ purchases: checkout.list(userId) });
    }),

    /** GET /agentcard/purchases/:purchaseId */
    getPurchase: userRoute(async (req, res, userId) => {
      res.json(checkout.detail(userId, req.params.purchaseId));
    }),

    /** POST /agentcard/purchases/:purchaseId/cancel */
    cancelPurchase: userRoute(async (req, res, userId) => {
      res.json(await checkout.cancel(userId, req.params.purchaseId));
    }),

    /** POST /agentcard/purchases/:purchaseId/refresh */
    refreshPurchase: userRoute(async (req, res, userId) => {
      res.json(await checkout.refresh(userId, req.params.purchaseId));
    }),

    /** POST /agentcard/webhooks  (raw body; signature checked by the handler) */
    webhook: async (req, res) => {
      let handle;
      try {
        handle = webhooks();
      } catch (err) {
        return sendError(res, err, log);
      }
      // The signature covers the exact bytes. If a JSON parser ran first, the raw
      // body is gone, so refuse rather than verify an empty body.
      if (!Buffer.isBuffer(req.body)) {
        log('error', 'agentcard: webhook raw body missing; mount the route before the JSON parser');
        return res.status(500).json({ error: 'raw_body_required' });
      }
      const result = await handle({ headers: req.headers, rawBody: req.body });
      res.status(result.status).json(result.body);
    },
  };
}
