/**
 * The placeholder card the agent types into a checkout, for one of the user's stored cards.
 *
 * The page's card facts must match the card that pays: a documented test number of the same
 * network, a placeholder security code, and the stored card's real expiry. The SDK builds these
 * (vault.placeholderCard). Our backend asks for them, so the agent never needs the SDK, and the
 * user's own card number never leaves the vault.
 *
 * The SDK takes AgentCard's user id (usr_...), not our external id. The store maps one to the other.
 */
import * as defaultSdk from '@agent-cards/sdk';

function codeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const REASONS = {
  card_not_found: 'That card is not stored for this user.',
  brand_unsupported: 'AgentCard has no placeholder number for this card’s network.',
  expiry_unknown: 'That card has no usable expiry date.',
};

/**
 * @param {{
 *   config: { clientId: string, clientSecret: string, baseUrl?: string },
 *   store: { getAgentCardUser: (userId: string) => string | null | undefined },
 *   ensureConfigured: () => void,
 *   VaultClient?: new (options: object) => { placeholderCard: (input: object) => Promise<object> },
 * }} deps
 */
export function createPlaceholders({ config, store, ensureConfigured, VaultClient = defaultSdk.VaultClient }) {
  let vault = null;

  function vaultClient() {
    ensureConfigured();
    if (!vault) {
      vault = new VaultClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
    }
    return vault;
  }

  return {
    /**
     * @param {string} userId our user id
     * @param {string} [cardId] a stored card's id; omit for the first card on file
     * @returns {Promise<{ cardId: string, brand: string, number: string, securityCode: string, expiryMonth: string, expiryYear: string }>}
     */
    async get(userId, cardId) {
      if (typeof userId !== 'string' || !userId.trim()) throw codeError('userId is required', 'invalid_request');
      if (cardId !== undefined && (typeof cardId !== 'string' || !cardId.trim() || cardId.length > 128)) {
        throw codeError('cardId is invalid', 'invalid_request');
      }
      const agentcardUserId = store.getAgentCardUser(userId.trim());
      if (!agentcardUserId) throw codeError('This user has no card on file. Store a card first.', 'not_enrolled');
      try {
        const card = await vaultClient().placeholderCard({
          user: agentcardUserId,
          ...(cardId ? { cardId: cardId.trim() } : {}),
        });
        return {
          cardId: card.cardId,
          brand: card.brand,
          number: card.number,
          securityCode: card.securityCode,
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear,
        };
      } catch (err) {
        const reason = err?.reason;
        if (reason && REASONS[reason]) {
          const code = reason === 'card_not_found' ? 'card_not_found' : 'placeholder_unavailable';
          throw codeError(REASONS[reason], code);
        }
        throw err;
      }
    },
  };
}
