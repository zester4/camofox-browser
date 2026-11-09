/**
 * The Vault: storing the user's own card once, then reusing it.
 *
 * Follows the AgentCard docs (Adding a card; Checking for stored cards):
 *
 *  - Before sending a link, read the user's cards. A card on file means the
 *    user is already enrolled, so no link is sent. A 404 (`connection_not_found`)
 *    or an empty list means the user needs a link.
 *  - A vault session always carries our own stable id as `external_user_id`.
 *    The user_id is left out, so the session is open. A user who already has a
 *    vault unlocks it with a passkey and lands on the same account.
 *  - "Add another card" mints a session with the same external_user_id and
 *    `steps: ["card"]`. The new card lands under the same AgentCard user_id.
 *  - The link is returned to the caller unchanged. Our code never rewrites it.
 *  - Each person has at most one pending link at a time, so repeated requests
 *    do not produce more links.
 *  - Card state comes from `vault.session_linked` (recommended) and from polling
 *    the session at its poll_interval. Polling stays within the documented
 *    budget of 40 reads per minute per session.
 *  - Card numbers never reach this app. The Vault page takes the card and
 *    encrypts it on the user's device.
 */
import { AgentCardError } from './api.js';

/** The docs allow 40 reads per minute per session, so reads are at least 1.5 s apart. */
export const MIN_POLL_INTERVAL_MS = 1500;

/** Display fields only. Nothing else from a card record is kept. */
export function toDisplayCard(card) {
  return {
    cardId: card.id,
    brand: card.brand ?? null,
    last4: card.last4 ?? null,
    expiryMonth: card.expiry_month ?? null,
    expiryYear: card.expiry_year ?? null,
    createdAt: card.created_at ?? null,
  };
}

/**
 * @param {{
 *   api: ReturnType<import('./api.js').createAgentCardApi>,
 *   store: ReturnType<import('./store.js').createMemoryStore>,
 *   now?: () => number,
 *   log?: (level: string, msg: string, fields?: object) => void,
 * }} deps
 */
export function createVault({ api, store, now = () => Date.now(), log = () => {} }) {
  /** Read the cards on file for one of our users. Never throws for "not enrolled". */
  async function cardsFor(userId) {
    const agentcardUserId = store.getAgentCardUser(userId);
    if (!agentcardUserId) return { known: false, cards: [] };
    try {
      const body = await api.listVaultCards(agentcardUserId);
      const data = Array.isArray(body?.data) ? body.data : [];
      return { known: true, cards: data.map(toDisplayCard) };
    } catch (err) {
      if (err instanceof AgentCardError && err.status === 404) {
        // connection_not_found: this user is not enrolled under this company's mode.
        log('warn', 'agentcard: user not found for vault read', { userId });
        return { known: false, cards: [] };
      }
      throw err;
    }
  }

  function linkFrom(session) {
    return {
      sessionId: session.sessionId,
      url: session.url,
      expiresAt: session.expiresAt ?? null,
      purpose: session.purpose,
    };
  }

  /** Records the AgentCard user id against our user, and closes the session. */
  function complete(sessionId, agentcardUserId) {
    const session = store.getSession(sessionId);
    if (!session) return null;
    const owner = store.userForAgentCardUser(agentcardUserId);
    if (owner && owner !== session.userId) {
      // Two of our users must never share one vault. Refuse and record it.
      log('error', 'agentcard: vault already linked to another user', { sessionId });
      store.updateSession(sessionId, { status: 'conflict' });
      return { conflict: true };
    }
    store.setAgentCardUser(session.userId, agentcardUserId);
    return store.updateSession(sessionId, { status: 'linked', agentcardUserId, linkedAt: new Date(now()).toISOString() });
  }

  return {
    /**
     * Cards on file for a user (display fields only).
     * @returns {Promise<{ enrolled: boolean, cards: object[] }>}
     */
    async listCards(userId) {
      requireUser(userId);
      const { known, cards } = await cardsFor(userId);
      return { enrolled: known && cards.length > 0, cards };
    },

    /**
     * Start enrolment, or add another card.
     *
     * Returns `has_card` with the cards on file when no link is needed. Otherwise
     * returns `link` (or the still-pending link for this user).
     *
     * @param {string} userId
     * @param {{ addAnother?: boolean }} [opts]
     */
    async start(userId, { addAnother = false } = {}) {
      requireUser(userId);
      if (!addAnother) {
        const { cards } = await cardsFor(userId);
        if (cards.length > 0) return { status: 'has_card', cards };
      }

      const pending = store.pendingSessionFor(userId, now());
      if (pending && pending.purpose === (addAnother ? 'add_card' : 'enrol')) {
        return { status: 'link', ...linkFrom(pending), reused: true };
      }

      const session = await api.createVaultSession({
        externalUserId: userId,
        steps: addAnother ? ['card'] : undefined,
      });

      const record = store.putSession(session.id, {
        userId,
        status: 'pending',
        purpose: addAnother ? 'add_card' : 'enrol',
        url: session.url,
        expiresAt: session.expires_at ?? null,
        pollIntervalSeconds: Number(session.poll_interval) || 3,
        createdAt: new Date(now()).toISOString(),
        lastPolledAt: null,
        testMode: session.test_mode === true,
      });
      log('info', 'agentcard: vault link created', { userId, purpose: record.purpose, testMode: record.testMode });
      return { status: 'link', ...linkFrom(record), reused: false };
    },

    /**
     * Poll one session. Only the owner can read it. Honours the read budget.
     * @returns {Promise<{ status: 'pending'|'linked'|'expired'|'conflict', retryAfterMs?: number, agentcardUserLinked?: boolean }>}
     */
    async poll(userId, sessionId) {
      requireUser(userId);
      const session = store.getSession(sessionId);
      if (!session || session.userId !== userId) throw notFound();
      if (session.status === 'linked') return { status: 'linked' };
      if (session.status === 'conflict') return { status: 'conflict' };
      if (session.status === 'expired') return { status: 'expired' };

      const nowMs = now();
      const wait = (session.pollIntervalSeconds ?? 3) * 1000;
      const last = session.lastPolledAt ? Date.parse(session.lastPolledAt) : 0;
      const earliest = last + Math.max(wait, MIN_POLL_INTERVAL_MS);
      if (nowMs < earliest) return { status: 'pending', retryAfterMs: earliest - nowMs };

      store.updateSession(sessionId, { lastPolledAt: new Date(nowMs).toISOString() });
      const remote = await api.getVaultSession(sessionId);
      if (remote.status === 'linked' && remote.user_id) {
        const done = complete(sessionId, remote.user_id);
        if (done?.conflict) return { status: 'conflict' };
        return { status: 'linked' };
      }
      if (remote.status === 'expired') {
        store.updateSession(sessionId, { status: 'expired' });
        return { status: 'expired' };
      }
      return { status: 'pending', retryAfterMs: wait };
    },

    /**
     * Handle vault.session_linked. Connected sessions do not send it, so only
     * open sessions reach this path. Falls back to external_user_id if this
     * instance has lost the session record (for example after a restart).
     */
    onSessionLinked(data) {
      const sessionId = data?.vault_session_id;
      const agentcardUserId = data?.user_id;
      if (!sessionId || !agentcardUserId) return { handled: false, reason: 'missing_fields' };
      if (!store.getSession(sessionId) && data.external_user_id) {
        store.putSession(sessionId, {
          userId: data.external_user_id,
          status: 'pending',
          purpose: 'enrol',
          url: null,
          expiresAt: null,
          createdAt: new Date(now()).toISOString(),
          recovered: true,
        });
      }
      const done = complete(sessionId, agentcardUserId);
      return { handled: Boolean(done), conflict: Boolean(done?.conflict) };
    },

    /** Handle vault.card_stored. Recorded for the audit trail; reads use the vault. */
    onCardStored(data) {
      if (!data?.card_id) return { handled: false };
      const owner = data.user_id ? store.userForAgentCardUser(data.user_id) : null;
      store.recordCardEvent({
        cardId: data.card_id,
        brand: data.brand ?? null,
        last4: data.last4 ?? null,
        userId: owner,
      });
      return { handled: true, attributed: Boolean(owner) };
    },
  };
}

function requireUser(userId) {
  if (typeof userId !== 'string' || !userId.trim()) {
    const err = new Error('userId is required');
    err.code = 'invalid_request';
    throw err;
  }
}

function notFound() {
  const err = new Error('Not found');
  err.code = 'not_found';
  return err;
}
