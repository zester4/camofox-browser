/**
 * Commerce: the buy tool from @agent-cards/commerce-sdk, run on our backend, and
 * the merchant check.
 *
 * Who the shopper is: our backend passes its own user id. We hand it to the SDK as
 * `externalUserId`, so AgentCard resolves the user. The model never supplies a user
 * id, an AgentCard id or an externalUserId. The input schema has five fields, and
 * anything else is refused, so the model cannot name another user.
 *
 * Links: the SDK returns the Vault, approval and store-login links in the result,
 * and product and store links as well. Our backend delivers them to the user
 * untouched. The model gets `forModel()`, which has no links in it.
 *
 * What the docs do not cover: there are no flight-traveler or flight-cancel tools in
 * the current Commerce SDK or REST docs. Flights are bought through the same buy
 * tool, as products with action `book`, and tables as action `reserve`.
 */
import * as defaultSdk from '@agent-cards/commerce-sdk';
import { AgentCardError } from './api.js';

const MAX_TOOLS = 5000;
const MERCHANT_KIND = /^[a-z_]{1,32}$/;

function codeError(message, code = 'invalid_request') {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Keys the buy tool's schema allows, plus our own routing fields. Anything else is refused. */
const MODEL_FIELDS = ['ask', 'confirm', 'new_order', 'product_id', 'store_id'];
const ROUTING_FIELDS = ['userId', 'threadId'];

/**
 * Checks the body of a buy request. The five model fields are checked by the SDK's own
 * parser, so they match the schema the model sees.
 * Exported for tests.
 */
export function buyInputFrom(body, sdk) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw codeError('body must be an object');
  for (const key of Object.keys(body)) {
    if (!MODEL_FIELDS.includes(key) && !ROUTING_FIELDS.includes(key)) {
      throw codeError(`unknown field "${key}"`);
    }
  }
  const input = {};
  // The SDK's schema marks all five as required, so absent fields take their neutral value.
  const defaults = { ask: undefined, confirm: false, new_order: false, product_id: null, store_id: null };
  for (const key of MODEL_FIELDS) input[key] = body[key] !== undefined ? body[key] : defaults[key];
  if (typeof input.ask !== 'string' || !input.ask.trim()) throw codeError('ask is required');
  if (input.ask.length > 2000) throw codeError('ask must be 2000 characters or fewer');
  if (input.product_id && input.store_id) throw codeError('pick a product or a store, not both');
  try {
    return sdk.parseBuyToolInput(input);
  } catch (err) {
    throw codeError(err?.message || 'input does not match the buy tool schema');
  }
}

/**
 * @param {{
 *   sdk?: object,                        // @agent-cards/commerce-sdk (injected in tests)
 *   ensureConfigured: () => void,        // throws when credentials are missing
 *   config: { clientId: string, clientSecret: string, baseUrl: string },
 *   fetchImpl?: typeof fetch,
 *   api: object,                         // the REST client (for the merchant check)
 *   log?: (level: string, msg: string, fields?: object) => void,
 * }} deps
 */
export function createCommerce({ sdk: injected, ensureConfigured, config, fetchImpl, api, log = () => {} }) {
  const sdk = injected ?? defaultSdk;
  let client = null;
  const tools = new Map(); // key: userId + threadId, one buy tool per shopper and chat

  function companyClient() {
    ensureConfigured();
    if (!client) {
      client = new sdk.AgentcardClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        baseUrl: config.baseUrl,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    }
    return client;
  }

  function toolFor(userId, threadId) {
    const key = `${userId}\u0000${threadId ?? ''}`;
    if (tools.has(key)) return tools.get(key);
    const tool = sdk.buyTool({
      agentcard: companyClient(),
      externalUserId: userId,
      ...(threadId ? { threadId } : {}),
    });
    if (tools.size >= MAX_TOOLS) tools.delete(tools.keys().next().value);
    tools.set(key, tool);
    return tool;
  }

  return {
    /** The tool's JSON definition (name, description, input schema) for the backend's model. */
    definition() {
      return sdk.buyToolDefinition();
    },

    /**
     * Run one buy call for one of our users. Returns what the model may read (`model`)
     * and what the backend delivers to the user (links, products, reply).
     */
    async buy(userId, body) {
      const input = buyInputFrom(body, sdk);
      const threadId = typeof body.threadId === 'string' && body.threadId.trim() ? body.threadId.trim() : undefined;
      if (threadId && threadId.length > 128) throw codeError('threadId must be 128 characters or fewer');
      let result;
      try {
        result = await toolFor(userId, threadId).answer(input);
      } catch (err) {
        if (err instanceof AgentCardError) throw err;
        if (err?.name === 'AgentcardApiError' || err?.status) {
          const wrapped = new AgentCardError(err.message, { status: err.status ?? 0, code: err.code ?? null });
          throw wrapped;
        }
        throw err;
      }
      log('info', 'agentcard: buy call', { userId, status: result.status, links: result.links?.length ?? 0 });
      return {
        status: result.status,
        reply: result.reply,
        messages: result.messages,
        cart: result.cart,
        carts: result.carts,
        products: result.products,
        links: result.links,
        link_sent: result.link_sent,
        approval_expires_at: result.approval_expires_at,
        shopper_need_not_reply: result.shopper_need_not_reply,
        model: sdk.forModel(result),
      };
    },

    /**
     * GET /buy/merchants. Whether AgentCard can pay at a store. With a userId, direct
     * merchants also carry `link_status` for that user (connections such as DoorDash).
     */
    async merchants({ userId, kind, q, limit, cursor } = {}) {
      if (kind !== undefined && (typeof kind !== 'string' || !MERCHANT_KIND.test(kind))) {
        throw codeError('kind must be lowercase letters or underscores');
      }
      if (q !== undefined && (typeof q !== 'string' || q.length > 100)) throw codeError('q must be 100 characters or fewer');
      let lim;
      if (limit !== undefined) {
        lim = Number(limit);
        if (!Number.isInteger(lim) || lim < 1 || lim > 100) throw codeError('limit must be a whole number from 1 to 100');
      }
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 500)) throw codeError('cursor is invalid');
      const raw = await api.listMerchants({ kind, q, limit: lim, cursor, externalUserId: userId });
      return {
        merchants: Array.isArray(raw?.merchants) ? raw.merchants : [],
        next_cursor: raw?.next_cursor ?? null,
        counts: raw?.counts ?? null,
      };
    },

    /** Test-only view of how many buy tools are held. */
    _toolCount: () => tools.size,
  };
}
