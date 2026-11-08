/**
 * Express handlers for the AgentCard routes. server.js mounts them and holds
 * the OpenAPI documentation for each route.
 *
 * Authentication: the user routes sit behind the app's access-key middleware,
 * like every other Chusky route, so only the app's backend can call them. The
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
  placeholder_unavailable: 422,
  over_limit: 422,
  outcome_not_reportable: 409,
  not_configured: 503,
};

function userIdFrom(req) {
  const fromBody = req.body && typeof req.body === 'object' ? req.body.userId : undefined;
  const fromQuery = req.query ? req.query.userId : undefined;
  const value = fromBody ?? fromQuery;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sendError(res, err, log) {
  if (err instanceof AgentCardError && err.code === 'policy_invalid') {
    return res.status(400).json({ error: 'policy_invalid', message: err.message });
  }
  if (err instanceof AgentCardError) {
    log('error', 'agentcard: upstream error', { status: err.status, code: err.code });
    return res.status(502).json({ error: 'agentcard_unavailable', upstreamStatus: err.status, retryable: err.retryable });
  }
  const status = STATUS_BY_CODE[err?.code];
  if (status) return res.status(status).json({ error: err.code, message: err.message });
  log('error', 'agentcard: unexpected error', { reason: err?.message });
  return res.status(500).json({ error: 'internal_error' });
}

/** Maps an error to the HTTP response this module uses everywhere. Exported for the routes server.js adds. */
export function sendAgentCardError(res, err, log = () => {}) {
  return sendError(res, err, log);
}

/**
 * @param {{
 *   vault: ReturnType<import('./vault.js').createVault>,
 *   checkout: ReturnType<import('./checkout.js').createCheckout>,
 *   webhooks: () => (args: object) => Promise<{ status: number, body: object }>,
 *   log?: (level: string, msg: string, fields?: object) => void,
 * }} deps
 */
export function createHttpHandlers({ vault, checkout, account, webhooks, log = () => {}, commerce = null, placeholders = null }) {
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

    /** GET /agentcard/payments/processors  (no user: the processor list for this company) */
    processors: async (req, res) => {
      try {
        const capabilities = typeof req.query?.capabilities === 'string' && req.query.capabilities.trim()
          ? req.query.capabilities.trim()
          : undefined;
        res.json(await account.processors({ capabilities }));
      } catch (err) {
        sendError(res, err, log);
      }
    },

    /** POST /agentcard/purchases/prepare: the user approves merchant and amount before Pay */
    preparePurchase: userRoute(async (req, res, userId) => {
      res.status(201).json(await checkout.prepare(userId, req.body ?? {}));
    }),

    /** POST /agentcard/purchases/:purchaseId/outcome: report a charge we did not see (auto-approved only) */
    reportOutcome: userRoute(async (req, res, userId) => {
      res.json(await checkout.reportOutcome(userId, req.params.purchaseId, req.body ?? {}));
    }),

    /** POST /agentcard/vault/send-link: AgentCard texts or emails the user their vault link */
    sendVaultLink: userRoute(async (req, res, userId) => {
      res.json(await account.sendVaultLink(userId));
    }),

    /** DELETE /agentcard/vault/connection: disconnect (cards stay in the user's vault) */
    disconnect: userRoute(async (req, res, userId) => {
      const result = await account.disconnect(userId);
      res.status(result.pending ? 202 : 200).json(result);
    }),

    /** DELETE /agentcard/users: disconnect and remove everything we hold for the user */
    eraseUser: userRoute(async (req, res, userId) => {
      const result = await account.erase(userId);
      res.status(result.erased ? 200 : 202).json(result);
    }),

    /** PUT /agentcard/presets/:label */
    setPreset: userRoute(async (req, res, userId) => {
      res.json(await account.setPreset(userId, req.params.label, req.body?.rules ?? req.body ?? {}));
    }),

    /** POST /agentcard/commerce/buy: one buy call for the user. The backend supplies userId, never the model. */
    buy: userRoute(async (req, res, userId) => {
      const { userId: _ignored, ...body } = req.body ?? {};
      const result = await commerce.buy(userId, { ...body, threadId: req.body?.threadId });
      res.json(result);
    }),

    /** GET /agentcard/commerce/tool: the buy tool's definition, for the backend's model. */
    buyDefinition: (req, res) => {
      res.json(commerce.definition());
    },

    /** GET /agentcard/cards/placeholder?userId=&cardId=  the test card the agent types for a stored card */
    placeholder: userRoute(async (req, res, userId) => {
      const cardId = typeof req.query?.cardId === 'string' ? req.query.cardId : undefined;
      res.json(await placeholders.get(userId, cardId));
    }),

    /** GET /agentcard/merchants: can AgentCard pay at a store. userId is optional (adds link_status). */
    merchants: async (req, res) => {
      try {
        const q = req.query ?? {};
        const result = await commerce.merchants({
          userId: typeof q.userId === 'string' && q.userId.trim() ? q.userId.trim() : undefined,
          kind: q.kind,
          q: q.q,
          limit: q.limit,
          cursor: q.cursor,
        });
        res.json(result);
      } catch (err) {
        sendError(res, err, log);
      }
    },

    /** GET /agentcard/presets */
    listPresets: userRoute(async (req, res, userId) => {
      res.json({ presets: await account.listPresets(userId) });
    }),

    /** GET /agentcard/presets/:label */
    getPreset: userRoute(async (req, res, userId) => {
      res.json(await account.getPreset(userId, req.params.label));
    }),

    /** DELETE /agentcard/presets/:label */
    deletePreset: userRoute(async (req, res, userId) => {
      res.json(await account.deletePreset(userId, req.params.label));
    }),

    /** POST /agentcard/presets/:label/attach  body: { userId, cardId? } */
    attachPreset: userRoute(async (req, res, userId) => {
      res.json(await account.attachPreset(userId, req.params.label, req.body?.cardId));
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
