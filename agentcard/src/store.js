/**
 * State for the AgentCard integration.
 *
 * Holds: the mapping from this app's user ids to AgentCard user ids, enrolment
 * sessions, purchases and their event log, and webhook de-duplication.
 *
 * It never holds card numbers, card data or tokens. AgentCard keeps the card,
 * encrypted on the user's device. Our records hold only display fields and ids.
 *
 * The store is in memory and calls `onChange` after every mutation. A durable
 * implementation (see file-store.js) writes each change to disk. A Redis
 * implementation (plan section 8) can use the same interface.
 */

const CLOCK = () => new Date().toISOString();

/**
 * @param {{ now?: () => string, seenLimit?: number, onChange?: () => void }} [options]
 */
export function createMemoryStore({ now = CLOCK, seenLimit = 10_000, onChange = () => {} } = {}) {
  /** @type {Map<string, string>} our user id -> AgentCard user id */
  const users = new Map();
  /** @type {Map<string, object>} vault session id -> enrolment record */
  const sessions = new Map();
  /** @type {Map<string, object>} checkout authorization id -> purchase */
  const purchases = new Map();
  /** @type {Map<string, Array<object>>} purchase id -> event log */
  const purchaseEvents = new Map();
  /** @type {Set<string>} processed webhook event ids, oldest first */
  const seenEvents = new Set();
  /** @type {Map<string, object>} card id -> display record, from webhooks */
  const cardEvents = new Map();

  const changed = () => onChange();

  const store = {
    // ---- user mapping ----
    getAgentCardUser(userId) {
      return users.get(userId) ?? null;
    },
    /** Returns our user id that owns an AgentCard user id, if any. */
    userForAgentCardUser(agentcardUserId) {
      for (const [userId, value] of users) if (value === agentcardUserId) return userId;
      return null;
    },
    setAgentCardUser(userId, agentcardUserId) {
      users.set(userId, agentcardUserId);
      changed();
    },
    /** Removes the AgentCard link and open sessions for a user. Purchase history is kept. */
    unlinkUser(userId) {
      const had = users.delete(userId);
      for (const [id, s] of sessions) if (s.userId === userId) sessions.delete(id);
      changed();
      return had;
    },
    listUsers() {
      return [...users.entries()].map(([userId, agentcardUserId]) => ({ userId, agentcardUserId }));
    },

    // ---- enrolment sessions ----
    putSession(sessionId, record) {
      sessions.set(sessionId, { ...record, sessionId, updatedAt: now() });
      changed();
      return { ...sessions.get(sessionId) };
    },
    getSession(sessionId) {
      const found = sessions.get(sessionId);
      return found ? { ...found } : null;
    },
    updateSession(sessionId, patch) {
      const current = sessions.get(sessionId);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: now() };
      sessions.set(sessionId, next);
      changed();
      return { ...next };
    },
    /** The newest session for a user that is still pending and unexpired, if any. */
    pendingSessionFor(userId, nowMs = Date.now()) {
      let best = null;
      for (const s of sessions.values()) {
        if (s.userId !== userId || s.status !== 'pending') continue;
        if (s.expiresAt && Date.parse(s.expiresAt) <= nowMs) continue;
        if (!best || s.createdAt > best.createdAt) best = s;
      }
      return best ? { ...best } : null;
    },

    // ---- purchases ----
    putPurchase(record) {
      purchases.set(record.id, { ...record });
      changed();
      return { ...record };
    },
    getPurchase(id) {
      const found = purchases.get(id);
      return found ? { ...found } : null;
    },
    updatePurchase(id, patch) {
      const current = purchases.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: now() };
      purchases.set(id, next);
      changed();
      return { ...next };
    },
    listPurchases(userId) {
      return [...purchases.values()].filter((p) => p.userId === userId).map((p) => ({ ...p }));
    },
    appendPurchaseEvent(purchaseId, event) {
      const list = purchaseEvents.get(purchaseId) ?? [];
      list.push({ ...event, at: now() });
      purchaseEvents.set(purchaseId, list);
      changed();
    },
    listPurchaseEvents(purchaseId) {
      return [...(purchaseEvents.get(purchaseId) ?? [])];
    },

    // ---- card events (display fields only) ----
    recordCardEvent(card) {
      cardEvents.set(card.cardId, { ...card, at: now() });
      changed();
    },
    listCardEvents() {
      return [...cardEvents.values()].map((c) => ({ ...c }));
    },

    // ---- webhook de-duplication ----
    /** True the first time an event id is seen. */
    markEventSeen(eventId) {
      if (seenEvents.has(eventId)) return false;
      seenEvents.add(eventId);
      if (seenEvents.size > seenLimit) seenEvents.delete(seenEvents.values().next().value);
      changed();
      return true;
    },
    unmarkEvent(eventId) {
      seenEvents.delete(eventId);
      changed();
    },

    // ---- deletion (matches DELETE /sessions/:userId) ----
    forgetUser(userId) {
      const agentcardUser = users.get(userId);
      users.delete(userId);
      for (const [id, s] of sessions) if (s.userId === userId) sessions.delete(id);
      for (const [id, p] of purchases) {
        if (p.userId === userId) {
          purchases.delete(id);
          purchaseEvents.delete(id);
        }
      }
      changed();
      return agentcardUser !== undefined;
    },

    // ---- persistence ----
    /** Plain-object snapshot, safe to JSON-serialise. */
    snapshot() {
      return {
        version: 1,
        users: [...users.entries()],
        sessions: [...sessions.entries()],
        purchases: [...purchases.entries()],
        purchaseEvents: [...purchaseEvents.entries()],
        seenEvents: [...seenEvents],
        cardEvents: [...cardEvents.entries()],
      };
    },
    /** Replace all state from a snapshot without triggering onChange. */
    restore(snapshot) {
      if (!snapshot || snapshot.version !== 1) throw new Error('Unsupported AgentCard state snapshot');
      users.clear(); sessions.clear(); purchases.clear(); purchaseEvents.clear(); seenEvents.clear(); cardEvents.clear();
      for (const [k, v] of snapshot.users) users.set(k, v);
      for (const [k, v] of snapshot.sessions) sessions.set(k, v);
      for (const [k, v] of snapshot.purchases) purchases.set(k, v);
      for (const [k, v] of snapshot.purchaseEvents) purchaseEvents.set(k, v);
      for (const id of snapshot.seenEvents) seenEvents.add(id);
      for (const [k, v] of snapshot.cardEvents ?? []) cardEvents.set(k, v);
    },
  };
  return store;
}
