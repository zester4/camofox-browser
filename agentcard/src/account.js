/**
 * Account operations around the vault: which processors we can pay on, sending a
 * vault link through AgentCard, disconnecting or erasing a user, and per-user spend
 * presets (the user's own limits, enforced by AgentCard before any approval).
 *
 * Presets are company-wide in AgentCard, so each user's preset name is namespaced
 * with a hash of our user id. A user can only list, change or attach their own.
 */
import { createHash } from 'node:crypto';
import { AgentCardError } from './api.js';

const LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CATEGORIES = ['meals', 'groceries', 'travel', 'software', 'ai', 'wellness', 'retail'];
const MODES = ['strict', 'watch'];
const TIME_WINDOW = /^\d{1,2}-\d{1,2}$/;
const MAX_CENTS = 100_000_000; // 1,000,000 USD, a sanity bound on what a rule can say
const DISCONNECT_PENDING = 'partner_disconnect_pending';

function codeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** The AgentCard preset name for one of our users and a label they chose. */
export function presetNameFor(userId, label) {
  const hash = createHash('sha256').update(String(userId)).digest('hex').slice(0, 16);
  return `u${hash}-${label}`;
}

function presetPrefix(userId) {
  return presetNameFor(userId, '');
}

function validLabel(label) {
  if (typeof label !== 'string' || !LABEL.test(label)) {
    throw codeError('label must be 1 to 40 lowercase letters, digits or hyphens', 'invalid_request');
  }
  return label;
}

function cents(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_CENTS) {
    throw codeError(`${field} must be a positive integer number of cents`, 'invalid_request');
  }
  return value / 100;
}

function list(value, field, pattern) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw codeError(`${field} must be a non-empty array of up to 20 items`, 'invalid_request');
  }
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 80 || (pattern && !pattern.test(item))) {
      throw codeError(`${field} contains an invalid item`, 'invalid_request');
    }
  }
  return value;
}

/**
 * Translate the rules a user or app sends into AgentCard's preset body.
 * Money fields are in cents here and in USD (dollars) at AgentCard, as the docs require.
 * Exported for tests.
 */
export function presetBodyFrom(input) {
  if (!input || typeof input !== 'object') throw codeError('rules are required', 'invalid_request');
  const body = {};
  const money = { perDayCents: 'per_day', perWeekCents: 'per_week', perMonthCents: 'per_month', totalCents: 'total' };
  for (const [key, target] of Object.entries(money)) {
    const value = cents(input[key], key);
    if (value !== undefined) body[target] = value;
  }
  const merchants = list(input.onlyMerchants, 'onlyMerchants');
  if (merchants) body.only_merchants = merchants.join(',');
  const categories = list(input.categories, 'categories', /^[a-z]+$/);
  if (categories) {
    const bad = categories.find((c) => !CATEGORIES.includes(c));
    if (bad) throw codeError(`categories must be among: ${CATEGORIES.join(', ')}`, 'invalid_request');
    body.categories = categories.join(',');
  }
  const currencies = list(input.currencies, 'currencies', /^[a-z]{3}$/);
  if (currencies) body.currencies = currencies.join(',');
  if (input.onlyDays !== undefined) {
    if (typeof input.onlyDays !== 'string' || input.onlyDays.length > 64) throw codeError('onlyDays is invalid', 'invalid_request');
    body.only_days = input.onlyDays;
  }
  if (input.onlyHours !== undefined) {
    if (typeof input.onlyHours !== 'string' || !TIME_WINDOW.test(input.onlyHours)) throw codeError('onlyHours must look like "9-17"', 'invalid_request');
    body.only_hours = input.onlyHours;
  }
  if (input.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: input.timezone });
    } catch {
      throw codeError('timezone must be an IANA zone, e.g. "Europe/London"', 'invalid_request');
    }
    body.timezone = input.timezone;
  }
  if (input.mode !== undefined) {
    if (!MODES.includes(input.mode)) throw codeError('mode must be "strict" or "watch"', 'invalid_request');
    body.mode = input.mode;
  }
  if (Object.keys(body).length === 0) throw codeError('at least one rule is required', 'invalid_request');
  return body;
}

/** Map AgentCard's preset to what our API returns: no internal names beyond the label. */
function presetView(label, p) {
  return {
    label,
    summary: p?.summary ?? null,
    version: p?.version ?? null,
    attachments: (p?.attachments ?? []).map((a) => ({ kind: a.kind, cardId: a.target_id, last4: a.last4 ?? null })),
  };
}

function asList(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

/**
 * @param {{
 *   api: object,
 *   store: object,
 *   vault: object,
 *   log?: (level: string, msg: string, fields?: object) => void,
 * }} deps
 */
export function createAccount({ api, store, vault, log = () => {} }) {
  function connectedUser(userId) {
    const id = store.getAgentCardUser(userId);
    if (!id) throw codeError('This user has no card on file. Store a card first.', 'not_enrolled');
    return id;
  }

  async function ownedCard(userId, cardId) {
    const { enrolled, cards } = await vault.listCards(userId);
    if (!enrolled) throw codeError('This user has no card on file. Store a card first.', 'no_card');
    const chosen = cardId ?? cards[0].cardId;
    if (!cards.some((c) => c.cardId === chosen)) throw codeError('That card is not on this user’s vault', 'card_not_found');
    return chosen;
  }

  return {
    /** Processors AgentCard can pause and complete for this company, for token checkout. */
    async processors({ capabilities } = {}) {
      const raw = await api.listRecognizers({ modes: 'token', ...(capabilities ? { capabilities } : {}) });
      const served = asList(raw);
      return {
        processors: [...new Set(served.filter((e) => e?.psp && e.preparationRequired !== true).map((e) => e.psp))].sort(),
        needsPreparation: [...new Set(served.filter((e) => e?.psp && e.preparationRequired === true).map((e) => e.psp))].sort(),
      };
    },

    /** AgentCard sends the user their vault link by text or email. Use when we do not run our own channel. */
    async sendVaultLink(userId) {
      const agentcardUserId = connectedUser(userId);
      const result = await api.sendVaultLink(agentcardUserId);
      log('info', 'agentcard: vault link requested', { userId, sent: result?.sent === true });
      return { sent: result?.sent === true, url: result?.sent === true ? null : (result?.url ?? null) };
    },

    /**
     * Ends our connection to the user. Their cards stay in their vault and their
     * purchase history stays here. Returns pending: true when AgentCard asks us to retry.
     */
    async disconnect(userId) {
      const agentcardUserId = store.getAgentCardUser(userId);
      if (!agentcardUserId) return { connected: false, pending: false };
      try {
        await api.disconnectUser(agentcardUserId);
      } catch (err) {
        if (err instanceof AgentCardError && err.status === 404) {
          // Already disconnected on AgentCard's side; finish the local part.
        } else if (err instanceof AgentCardError && err.code === DISCONNECT_PENDING) {
          return { connected: true, pending: true };
        } else {
          throw err;
        }
      }
      store.unlinkUser(userId);
      log('info', 'agentcard: user disconnected', { userId });
      return { connected: false, pending: false };
    },

    /** Disconnect, then remove everything we hold for the user (mapping, sessions and purchase history). */
    async erase(userId) {
      const result = await this.disconnect(userId);
      if (result.pending) return { erased: false, ...result };
      store.forgetUser(userId);
      log('info', 'agentcard: user data erased', { userId });
      return { erased: true, connected: false, pending: false };
    },

    /** Create or replace one of the user's presets. Rules take effect on the next purchase. */
    async setPreset(userId, label, input) {
      validLabel(label);
      const body = presetBodyFrom(input);
      const res = await api.putPreset(presetNameFor(userId, label), body);
      return presetView(label, res);
    },

    async getPreset(userId, label) {
      validLabel(label);
      return presetView(label, await api.getPreset(presetNameFor(userId, label)));
    },

    /** The user's presets only: AgentCard lists every company's, so we filter by our prefix. */
    async listPresets(userId) {
      const prefix = presetPrefix(userId);
      const all = asList(await api.listPresets());
      return all
        .filter((p) => typeof p?.name === 'string' && p.name.startsWith(prefix))
        .map((p) => presetView(p.name.slice(prefix.length), p));
    },

    async deletePreset(userId, label) {
      validLabel(label);
      await api.deletePreset(presetNameFor(userId, label));
      return { label, deleted: true };
    },

    /** Attach one of the user's presets to one of their cards (default: the first card). */
    async attachPreset(userId, label, cardId) {
      validLabel(label);
      const chosen = await ownedCard(userId, cardId);
      const res = await api.attachPreset(presetNameFor(userId, label), chosen);
      return presetView(label, res);
    },
  };
}
