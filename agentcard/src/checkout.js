/**
 * Purchases paid with the user's own card, approved by the user each time.
 *
 * Flow (AgentCard docs: Completing a purchase; checkout authorizations):
 *  1. The app asks for a purchase: merchant, amount, currency, the processor
 *     request the browser captured, and optionally a `cardId` from the vault.
 *  2. AgentCard creates an authorization and returns an approvalUrl. The app
 *     gives that link to the user, untouched. Nothing is charged yet.
 *  3. The user approves on their own device with their passkey. AgentCard
 *     pays with the real card and replays the response into the paused request.
 *  4. We learn the outcome from checkout_authorization.* webhooks, and from a
 *     status read (refresh) when a webhook is late. An agent's report never
 *     counts as the outcome.
 *
 * Retry rule: a purchase is retried only when it failed and nothing was
 * charged (declined, expired, refused, or settlement final and not settled).
 * An approved or submitted purchase is never retried, because that could charge
 * the user twice.
 */
import { randomUUID } from 'node:crypto';

/** Preparation status (GET checkout/preparations/:id) -> our purchase status. */
export const PREPARATION_STATUS = {
  awaiting_approval: 'awaiting_approval',
  ready: 'ready',
  bound: 'bound',
  cancelled: 'cancelled',
  expired: 'expired',
};

/** Outcomes an app may report for an auto-approved purchase AgentCard did not charge. */
export const OUTCOMES = ['charged', 'declined', 'refunded'];

/** Webhook kind -> our purchase status. */
export const EVENT_STATUS = {
  approved: 'approved',
  submitted: 'submitted_on_device',
  declined: 'declined',
  amount_mismatch: 'declined',
  expired: 'expired',
  refused: 'refused',
  settled: 'settled',
  settlement_unconfirmed: 'not_settled',
};

const RETRYABLE = new Set(['declined', 'expired', 'refused']);
const CURRENCY = /^[a-z]{3}$/;
const PSP = /^[a-z][a-z_]{1,31}$/;
const MERCHANT_MAX = 120;

/** Product rule, set in code. Null means no cap. Decide before going live. */
export const DEFAULT_MAX_AMOUNT_CENTS = null;

function httpsOrigin(value) {
  if (value === undefined || value === null || value === '') return undefined;
  let u;
  try { u = new URL(value); } catch { throw invalid('checkoutOrigin must be a URL'); }
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash) {
    throw invalid('checkoutOrigin must be an https origin with no path');
  }
  return u.origin;
}

function invalid(message) {
  const err = new Error(message);
  err.code = 'invalid_request';
  return err;
}

function codeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The settlement block AgentCard sends, copied as-is except for known fields. */
function settlementFrom(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    status: value.status ?? null,
    reason: value.reason ?? null,
    final: value.final === true,
    processorReference: value.processor_reference ?? null,
    settledAmount: value.settled_amount ?? null,
    settledCurrency: value.settled_currency ?? null,
    message: value.message ?? null,
  };
}

/**
 * @param {{
 *   api: ReturnType<import('./api.js').createAgentCardApi>,
 *   store: ReturnType<import('./store.js').createMemoryStore>,
 *   vault: ReturnType<import('./vault.js').createVault>,
 *   maxAmountCents?: number | null,
 *   now?: () => string,
 *   log?: (level: string, msg: string, fields?: object) => void,
 * }} deps
 */
export function createCheckout({ api, store, vault, maxAmountCents = DEFAULT_MAX_AMOUNT_CENTS, now = () => new Date().toISOString(), log = () => {} }) {
  function owned(userId, id) {
    const p = store.getPurchase(id);
    if (!p || p.userId !== userId) throw codeError('Purchase not found', 'not_found');
    return p;
  }

  function summary(p) {
    return {
      purchaseId: p.id,
      merchant: p.merchant,
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      cardId: p.cardId ?? null,
      settlement: p.settlement ?? null,
      chargedAmount: p.chargedAmount ?? null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  function record(p, type, extra = {}) {
    store.appendPurchaseEvent(p.id, { type, status: p.status, ...extra });
  }

  /** True only when a retry is safe: the purchase failed and nothing was charged. */
  function canRetry(userId, id) {
    const p = owned(userId, id);
    if (RETRYABLE.has(p.status)) return true;
    return p.settlement?.status === 'not_settled' && p.settlement?.final === true;
  }

  return {
    /**
     * Start a purchase. Returns the approval link for the caller to deliver.
     * @returns {Promise<object>}
     */
    async request(userId, input) {
      if (typeof userId !== 'string' || !userId.trim()) throw invalid('userId is required');
      const agentcardUserId = store.getAgentCardUser(userId);
      if (!agentcardUserId) throw codeError('This user has no card on file. Store a card first.', 'not_enrolled');

      const merchant = typeof input.merchant === 'string' ? input.merchant.trim() : '';
      if (!merchant || merchant.length > MERCHANT_MAX) throw invalid(`merchant is required (max ${MERCHANT_MAX} characters)`);
      if (!Number.isInteger(input.amount) || input.amount <= 0) throw invalid('amount must be a positive integer in the smallest currency unit');
      if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) throw invalid('currency must be a lowercase 3-letter ISO code, e.g. "usd"');
      if (typeof input.psp !== 'string' || !PSP.test(input.psp)) throw invalid('psp must be a lowercase processor name, e.g. "stripe"');
      const req = input.request;
      if (!req || typeof req.url !== 'string' || !/^https:\/\//.test(req.url) || typeof req.method !== 'string') {
        throw invalid('request.url (https) and request.method are required');
      }
      if (maxAmountCents !== null && input.amount > maxAmountCents) {
        throw codeError('Purchase is above the configured limit', 'over_limit');
      }

      const origin = httpsOrigin(input.checkoutOrigin);

      // Pay with the requested card, or with the default card on file.
      const { enrolled, cards } = await vault.listCards(userId);
      if (!enrolled) throw codeError('This user has no card on file. Store a card first.', 'no_card');
      const cardId = input.cardId ?? cards[0].cardId;
      if (input.cardId && !cards.some((c) => c.cardId === input.cardId)) {
        throw codeError('That card is not on this user’s vault', 'card_not_found');
      }

      const auth = await api.createAuthorization({
        user: agentcardUserId,
        merchant,
        amount: input.amount,
        currency: input.currency,
        psp: input.psp,
        checkout_origin: origin,
        card_id: cardId,
        request: {
          url: req.url,
          method: req.method.toUpperCase(),
          headers: req.headers ?? {},
          body: req.body,
        },
      });

      const at = now();
      const p = store.putPurchase({
        id: auth.id,
        userId,
        merchant,
        amount: input.amount,
        currency: input.currency,
        psp: input.psp,
        cardId,
        status: auth.status ?? 'awaiting_approval',
        settlement: null,
        chargedAmount: null,
        createdAt: at,
        updatedAt: at,
      });
      record(p, 'requested');
      log('info', 'agentcard: purchase awaiting approval', { userId, purchaseId: p.id, amount: p.amount, currency: p.currency });

      return {
        ...summary(p),
        expiresAt: auth.expires_at ?? auth.expiresAt ?? null,
        // The approval link goes to the caller, which must send it untouched to the user.
        approvalUrl: auth.approvalUrl ?? null,
      };
    },

    /** Cancel a purchase that is still awaiting approval. */
    async cancel(userId, id) {
      const p = owned(userId, id);
      if (p.kind === 'preparation') return this.cancelPreparation(userId, id);
      if (p.status !== 'awaiting_approval') return summary(p);
      const result = await api.cancelAuthorization(id);
      const updated = store.updatePurchase(id, { status: result.status ?? 'declined' });
      record(updated, 'cancelled');
      return summary(updated);
    },

    /** Read the authoritative status from AgentCard. Use when a webhook is late. */
    async refresh(userId, id) {
      const p = owned(userId, id);
      if (p.kind === 'preparation') return this.refreshPreparation(userId, id);
      const auth = await api.getAuthorization(id);
      return this.applyAuthorization(userId, id, auth);
    },

    /**
     * Apply an authorization as AgentCard returned it. Used by refresh and by the
     * payment interception, which already holds the authorization it polled.
     */
    applyAuthorization(userId, id, auth) {
      owned(userId, id);
      const updated = store.updatePurchase(id, {
        status: auth.status,
        settlement: settlementFrom(auth.settlement),
        chargedAmount: auth.charged_amount ?? null,
        chargedKind: auth.charged_kind ?? null,
        reason: auth.reason ?? null,
      });
      record(updated, 'refreshed');
      return summary(updated);
    },

    /**
     * Apply one verified checkout_authorization.* webhook event.
     * @param {{ id: string, type: string, data?: object }} event
     */
    applyWebhookEvent(event) {
      const id = event.data?.id;
      if (!id) return null;
      const p = store.getPurchase(id);
      if (!p) return null; // not a purchase this app created

      const kind = event.type.replace(/^checkout_authorization\./, '');
      if (kind === 'watched') {
        record(p, event.type);
        return summary(p);
      }
      const status = EVENT_STATUS[kind];
      if (!status) return summary(p);

      const patch = { status };
      if (event.data?.settlement !== undefined) patch.settlement = settlementFrom(event.data.settlement);
      else if (status === 'settled' || status === 'not_settled') {
        patch.settlement = { status: status === 'settled' ? 'settled' : 'not_settled', final: status === 'not_settled' ? false : true, reason: null };
      }
      if (event.data?.charged_amount !== undefined) patch.chargedAmount = event.data.charged_amount;
      if (event.data?.charged_kind !== undefined) patch.chargedKind = event.data.charged_kind;
      const updated = store.updatePurchase(id, patch);
      record(updated, event.type);
      return summary(updated);
    },

    /**
     * Approve first, then pay. The user approves the merchant and amount on their
     * device before the browser clicks Pay. Once status is `ready`, the browser
     * must start its one card request before `readyExpiresAt` (about 30 seconds).
     * Preferred over a captured request: nothing is asked of the browser until the
     * user has said yes.
     */
    async prepare(userId, input) {
      if (typeof userId !== 'string' || !userId.trim()) throw invalid('userId is required');
      const agentcardUserId = store.getAgentCardUser(userId);
      if (!agentcardUserId) throw codeError('This user has no card on file. Store a card first.', 'not_enrolled');

      const merchant = typeof input.merchant === 'string' ? input.merchant.trim() : '';
      if (!merchant || merchant.length > MERCHANT_MAX) throw invalid(`merchant is required (max ${MERCHANT_MAX} characters)`);
      if (!Number.isInteger(input.amount) || input.amount <= 0) throw invalid('amount must be a positive integer in the smallest currency unit');
      if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) throw invalid('currency must be a lowercase 3-letter ISO code, e.g. "usd"');
      if (typeof input.psp !== 'string' || !PSP.test(input.psp)) throw invalid('psp must be a lowercase processor name, e.g. "stripe"');
      const merchantOrigin = httpsOrigin(input.merchantOrigin);
      if (!merchantOrigin) throw invalid('merchantOrigin is required: the https origin of the merchant checkout, e.g. "https://shop.example.com"');
      if (input.checkoutKey !== undefined && (typeof input.checkoutKey !== 'string' || input.checkoutKey.length < 16 || input.checkoutKey.length > 128)) {
        throw invalid('checkoutKey must be a string of 16 to 128 characters');
      }
      if (maxAmountCents !== null && input.amount > maxAmountCents) {
        throw codeError('Purchase is above the configured limit', 'over_limit');
      }

      const { enrolled, cards } = await vault.listCards(userId);
      if (!enrolled) throw codeError('This user has no card on file. Store a card first.', 'no_card');
      const cardId = input.cardId ?? cards[0].cardId;
      if (input.cardId && !cards.some((c) => c.cardId === input.cardId)) {
        throw codeError('That card is not on this user’s vault', 'card_not_found');
      }

      const prep = await api.createPreparation({
        user: agentcardUserId,
        card_id: cardId,
        merchant,
        amount: input.amount,
        currency: input.currency,
        psp: input.psp,
        mode: 'token',
        merchant_origin: merchantOrigin,
        checkout_key: input.checkoutKey ?? randomUUID(),
      });

      const at = now();
      const p = store.putPurchase({
        id: prep.id,
        kind: 'preparation',
        userId,
        merchant,
        amount: input.amount,
        currency: input.currency,
        psp: input.psp,
        cardId,
        status: PREPARATION_STATUS[prep.status] ?? 'awaiting_approval',
        approvalUrl: prep.approvalUrl ?? null,
        readyExpiresAt: prep.ready_expires_at ?? null,
        authorizationId: null,
        settlement: null,
        chargedAmount: null,
        createdAt: at,
        updatedAt: at,
      });
      record(p, 'prepared');
      log('info', 'agentcard: purchase prepared for approval', { userId, purchaseId: p.id, amount: p.amount, currency: p.currency });

      return {
        ...summary(p),
        approvalUrl: p.approvalUrl,
        readyExpiresAt: p.readyExpiresAt,
        nextStep: 'Deliver approvalUrl to the user untouched. Poll GET for status "ready", then start Pay at once.',
      };
    },

    /** Read a preparation's status. When `ready`, the browser may pay until readyExpiresAt. */
    async refreshPreparation(userId, id) {
      const p = owned(userId, id);
      if (p.kind !== 'preparation') throw codeError('Not a preparation. Use refresh for authorizations.', 'invalid_request');
      const prep = await api.getPreparation(id);
      const updated = store.updatePurchase(id, {
        status: PREPARATION_STATUS[prep.status] ?? p.status,
        readyExpiresAt: prep.ready_expires_at ?? p.readyExpiresAt ?? null,
        authorizationId: prep.authorization_id ?? p.authorizationId ?? null,
      });
      record(updated, 'refreshed');
      return {
        ...summary(updated),
        approvalUrl: updated.approvalUrl ?? null,
        readyExpiresAt: updated.readyExpiresAt ?? null,
        authorizationId: updated.authorizationId ?? null,
      };
    },

    /** Cancel a preparation the user has not approved. */
    async cancelPreparation(userId, id) {
      const p = owned(userId, id);
      if (p.kind !== 'preparation') throw codeError('Not a preparation.', 'invalid_request');
      if (p.status !== 'awaiting_approval') return summary(p);
      await api.cancelPreparation(id);
      const updated = store.updatePurchase(id, { status: 'cancelled' });
      record(updated, 'cancelled');
      return summary(updated);
    },

    /**
     * Report what the merchant did with an auto-approved purchase that AgentCard did
     * not charge (charged_kind "none"). AgentCard keeps every report; it does not verify them.
     */
    async reportOutcome(userId, id, input) {
      const p = owned(userId, id);
      if (p.kind === 'preparation') throw codeError('Outcomes are reported for auto-approved purchases, not preparations.', 'invalid_request');
      if (!OUTCOMES.includes(input.outcome)) throw invalid(`outcome must be one of: ${OUTCOMES.join(', ')}`);
      if (p.status !== 'approved' || p.chargedKind !== 'none') {
        throw codeError('Outcomes are reported only for auto-approved purchases that AgentCard did not charge', 'outcome_not_reportable');
      }
      const body = { outcome: input.outcome };
      if (input.outcome === 'charged' || input.outcome === 'refunded') {
        if (!Number.isInteger(input.amount) || input.amount <= 0) throw invalid('amount must be a positive integer in the smallest currency unit');
        body.amount = input.amount;
      }
      if (input.outcome === 'charged') {
        if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) throw invalid('currency must be a lowercase 3-letter ISO code');
        body.currency = input.currency;
      }
      if (input.processorReference !== undefined) body.processor_reference = String(input.processorReference).slice(0, 255);
      if (input.outcome === 'refunded' && input.partnerReference !== undefined) body.partner_reference = String(input.partnerReference).slice(0, 255);
      if (input.outcome === 'declined' && input.reason !== undefined) body.reason = String(input.reason).slice(0, 255);

      const result = await api.reportOutcome(id, body);
      record(p, 'outcome_reported', { outcome: input.outcome });
      return { ...summary(p), outcome: input.outcome, replayed: result?.replayed === true };
    },

    canRetry,

    /** Purchase detail with its event log. */
    detail(userId, id) {
      const p = owned(userId, id);
      return {
        ...summary(p),
        canRetry: canRetry(userId, id),
        events: store.listPurchaseEvents(id).map((e) => ({ type: e.type, status: e.status ?? null, at: e.at })),
      };
    },

    list(userId) {
      return store.listPurchases(userId).map(summary);
    },
  };
}
