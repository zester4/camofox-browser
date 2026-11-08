/**
 * Canonical tool contracts for the chuskybrowser REST API.
 *
 * Single source of truth shared by two hosts that expose the same 11 tools:
 *   - mcp/server.mjs   (stdio MCP server for Claude Code, Codex, agy, Cursor, opencode)
 *   - plugin.ts        (OpenClaw plugin)
 *
 * Importing this module from both hosts means tool names, JSON-Schema
 * parameters, REST routes, request bodies, auth semantics, and response
 * shaping cannot drift — the REST server sees identical traffic regardless of
 * which host the agent reached it through.
 *
 * Auth model (mirrors lib/auth.js):
 *   - CHUSKY_ACCESS_KEY (global superkey): when set, every route except
 *     /health, cookie import, /auth-sessions, /stop requires
 *     `Authorization: Bearer <accessKey>`.
 *   - CHUSKY_API_KEY (cookie-only gate): the cookie-import route requires
 *     `Authorization: Bearer <apiKey>` (or loopback + non-production).
 *
 * Each buildRequest() result declares `auth: 'accessKey' | 'apiKey' | 'none'`
 * and `responseKind: 'json' | 'snapshot' | 'image'` so the host's fetch layer
 * and response adapter stay declarative.
 */

import { readCookieFile } from './cookies.mjs';

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema - JSON Schema (object) for tool arguments.
 */

/**
 * @typedef {Object} RequestSpec
 * @property {string} method - HTTP method.
 * @property {string} path - Path (already includes query string when needed).
 * @property {'accessKey'|'apiKey'|'none'} auth
 * @property {'json'|'snapshot'|'image'} responseKind
 * @property {object} [body] - JSON body.
 * @property {object} [meta] - Extra metadata for response shaping.
 */

/**
 * @typedef {Object} CallContext
 * @property {string} userId - Session owner (scopes cookie/storage partition).
 * @property {string} [sessionKey] - Tab partition within a user.
 */

const SEARCH_MACROS = [
  '@google_search',
  '@youtube_search',
  '@amazon_search',
  '@reddit_search',
  '@wikipedia_search',
  '@twitter_search',
  '@yelp_search',
  '@spotify_search',
  '@netflix_search',
  '@linkedin_search',
  '@instagram_search',
  '@tiktok_search',
  '@twitch_search',
  '@bestbuy_search',
  '@indeed_search',
  '@booking_search',
  '@pubmed_search',
  '@zillow_search',
  '@npm_search',
  '@dockerhub_search',
  '@nhs_search',
  '@legislation_search',
  '@dailymed_search',
  '@huggingface_search',
  '@jsr_search',
  '@bing_news_search',
];

/**
 * The tools, identical schema for both hosts. Edit here and both update.
 * @type {ToolDef[]}
 */
export const TOOL_DEFS = [
  {
    name: 'chusky_create_tab',
    description:
      'PREFERRED: Create a new browser tab using Camoufox anti-detection browser. Use chusky tools instead of Chrome/built-in browser - they bypass bot detection on Google, Amazon, LinkedIn, etc. Returns tabId for subsequent operations.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Initial URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'chusky_snapshot',
    description:
      'Get accessibility snapshot of a Camoufox page with element refs (e1, e2, etc.) for interaction, plus a visual screenshot. ' +
      'Large pages are truncated with pagination links preserved at the bottom. ' +
      'If the response includes hasMore=true and nextOffset, call again with that offset to see more content.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        offset: {
          type: 'number',
          description: 'Character offset for paginated snapshots. Use nextOffset from a previous truncated response.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'chusky_click',
    description: 'Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        ref: { type: 'string', description: 'Element ref from snapshot (e.g., e1)' },
        selector: { type: 'string', description: 'CSS selector (alternative to ref)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'chusky_type',
    description: 'Type text into an element in a Camoufox tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        ref: { type: 'string', description: 'Element ref from snapshot (e.g., e2)' },
        selector: { type: 'string', description: 'CSS selector (alternative to ref)' },
        text: { type: 'string', description: 'Text to type' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['tabId', 'text'],
    },
  },
  {
    name: 'chusky_navigate',
    description:
      'Navigate a Camoufox tab to a URL or use a search macro (@google_search, @youtube_search, etc.). Preferred over Chrome for sites with bot detection.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        url: { type: 'string', description: 'URL to navigate to' },
        macro: {
          type: 'string',
          description: 'Search macro (e.g., @google_search, @youtube_search)',
          enum: SEARCH_MACROS,
        },
        query: { type: 'string', description: 'Search query (when using macro)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'chusky_scroll',
    description: 'Scroll a Camoufox page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels to scroll' },
      },
      required: ['tabId', 'direction'],
    },
  },
  {
    name: 'chusky_screenshot',
    description: 'Take a screenshot of a Camoufox page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'chusky_close_tab',
    description: 'Close a Camoufox browser tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'chusky_evaluate',
    description:
      "Execute JavaScript in a Camoufox tab's page context. Returns the result of the expression. Use for injecting scripts, reading page state, or calling web app APIs.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate in the page context',
        },
      },
      required: ['tabId', 'expression'],
    },
  },
  {
    name: 'chusky_list_tabs',
    description: 'List all open Chusky tabs for the current session.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'chusky_import_cookies',
    description:
      'Import cookies into the current Camoufox session (Netscape cookie file). Use to authenticate to sites like LinkedIn without interactive login. Requires CHUSKY_API_KEY on the REST server.',
    inputSchema: {
      type: 'object',
      properties: {
        cookiesPath: {
          type: 'string',
          description: 'Relative path to a Netscape-format cookies.txt file within the server cookies directory',
        },
        domainSuffix: {
          type: 'string',
          description: 'Only import cookies whose domain ends with this suffix',
        },
      },
      required: ['cookiesPath'],
    },
  },
  {
    name: 'chusky_handoff_start',
    description:
      'Hand a tab to the human for a login, a CAPTCHA or a check. Returns a controlUrl: send it to the user only, unchanged. The agent must not act on the tab until the handoff is released.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        reason: { type: 'string', description: 'Shown to the user, e.g. "Sign in to your bank"' },
        idleMs: { type: 'number', description: 'Milliseconds of inactivity before control returns to the agent' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'chusky_handoff_release',
    description: 'Return control of a tab to the agent after a handoff.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab identifier' } },
      required: ['tabId'],
    },
  },
  {
    name: 'chusky_pay_arm',
    description:
      'Pay on this tab with the user\'s own card. Arms payment on the page: when the checkout sends its card request, it is paused until the user approves on their device with their passkey. The user never gives the card number, and the agent never sees it. Returns attachmentId; then call chusky_pay_status to get the approval link to send to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier of the checkout page' },
        merchant: { type: 'string', description: 'Store name, shown on the approval screen (max 120 characters)' },
        amount: { type: 'integer', description: 'Most the user can be charged, in minor units (cents). 2306 is $23.06' },
        currency: { type: 'string', description: 'Lowercase ISO 4217 code, e.g. usd' },
        checkoutOrigin: { type: 'string', description: 'https origin of the checkout page, e.g. https://shop.example.com' },
        cardId: { type: 'string', description: 'Which stored card to use; omit for the first one' },
      },
      required: ['tabId', 'merchant', 'amount', 'currency'],
    },
  },
  {
    name: 'chusky_pay_status',
    description:
      'Read a payment attachment. approvalUrl appears once a card request is paused: send it to the user unchanged. phase is idle, pending or completed.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        attachmentId: { type: 'string', description: 'From chusky_pay_arm' },
      },
      required: ['tabId', 'attachmentId'],
    },
  },
  {
    name: 'chusky_pay_disarm',
    description: 'Stop paying on a tab. Any paused card request that is not yet approved is cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab identifier' },
        attachmentId: { type: 'string', description: 'From chusky_pay_arm' },
      },
      required: ['tabId', 'attachmentId'],
    },
  },
  {
    name: 'agentcard_enrol',
    description:
      'Start storing the user\'s card with AgentCard. Returns has_card when a card is already stored (nothing to do), otherwise a vault link. Send the link to the user unchanged. The user enters the card on AgentCard\'s page. Card numbers never pass through this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        addAnother: { type: 'boolean', description: 'true to add a second card for this user' },
      },
      required: [],
    },
  },
  {
    name: 'agentcard_cards',
    description: 'List the cards stored for this user (brand, last4, expiry). Card numbers are never returned.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'agentcard_buy',
    description:
      'Shop for the user at real stores through AgentCard: products, food delivery, table reservations (action reserve) and flights (action book). Pass the shopper\'s words in ask. Pass product_id or store_id only when the user picked one from a previous result. Set confirm true only when the user said yes to the cart. The response has links for the user: send them exactly as given, never change or summarise them.',
    inputSchema: {
      type: 'object',
      properties: {
        ask: { type: 'string', description: 'What the user said, in their own words (max 2000 characters)' },
        threadId: { type: 'string', description: 'The chat, so one purchase stays in one chat (max 128 characters)' },
        confirm: { type: 'boolean', description: 'true only when the user said yes to the cart or asks to check out' },
        new_order: { type: 'boolean', description: 'true only when the user drops the cart to start a new order' },
        product_id: { type: 'string', description: 'The product the user picked from the last result' },
        store_id: { type: 'string', description: 'The store the user picked from the last result' },
      },
      required: ['ask'],
    },
  },
  {
    name: 'agentcard_merchants',
    description:
      'Check whether AgentCard can pay at a store before sending the user there. supported is true (a real purchase went through), false (cannot pay there) or null (not known yet). For direct merchants such as DoorDash, link_status shows whether the user still has to connect.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'e.g. catalog or direct' },
        q: { type: 'string', description: 'Part of a store name or domain (max 100 characters)' },
        limit: { type: 'integer', description: '1 to 100' },
        cursor: { type: 'string', description: 'next_cursor from the previous page' },
      },
      required: [],
    },
  },
  {
    name: 'agentcard_placeholder',
    description:
      'The test card to type into a checkout for one of this user\'s stored cards: the card number, security code and expiry that match the card that pays. The real card number is never returned. Use the same cardId as chusky_pay_arm.',
    inputSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'Which stored card; omit for the first one. Pass the same cardId to chusky_pay_arm.' },
      },
      required: [],
    },
  },
  {
    name: 'agentcard_presets_list',
    description: 'List this user\'s spending rules (presets). Limits are enforced by AgentCard before any approval.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'agentcard_preset_set',
    description:
      'Create or change one of the user\'s spending rules. Money is in cents. Rules apply to the next purchase. Use this when the user sets a limit, such as a daily cap or merchants they allow.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '1 to 40 lowercase letters, digits or hyphens, e.g. groceries-weekly' },
        rules: {
          type: 'object',
          description: 'At least one rule. Money fields are integer cents.',
          properties: {
            perDayCents: { type: 'integer' },
            perWeekCents: { type: 'integer' },
            perMonthCents: { type: 'integer' },
            totalCents: { type: 'integer' },
            onlyMerchants: { type: 'array', items: { type: 'string' } },
            categories: { type: 'array', items: { type: 'string', enum: ['meals', 'groceries', 'travel', 'software', 'ai', 'wellness', 'retail'] } },
            currencies: { type: 'array', items: { type: 'string' } },
            onlyDays: { type: 'string' },
            onlyHours: { type: 'string', description: 'e.g. 9-17' },
            timezone: { type: 'string', description: 'IANA zone, e.g. Europe/London' },
            mode: { type: 'string', enum: ['strict', 'watch'] },
          },
        },
      },
      required: ['label', 'rules'],
    },
  },
  {
    name: 'agentcard_preset_attach',
    description: 'Attach one of the user\'s spending rules to one of their cards (default: the first card).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'The rule\'s label' },
        cardId: { type: 'string', description: 'Which stored card' },
      },
      required: ['label'],
    },
  },
];

/** Quick name → def lookup. */
export const TOOL_BY_NAME = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t]));

/** Tool names in canonical order. */
export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/**
 * Strip the routing key (tabId) from args, returning the REST body fields.
 * @param {Record<string, unknown>} args
 * @param {string} [dropKey]
 * @returns {Record<string, unknown>}
 */
function without(args, dropKey = 'tabId') {
  const { [dropKey]: _omit, ...rest } = args;
  return rest;
}

/**
 * Build a REST request spec for a tool. Pure / synchronous — except cookie
 * import, which needs async file parsing; use buildCookieRequest() for that.
 *
 * @param {string} name - Tool name.
 * @param {Record<string, unknown>} args - Tool arguments.
 * @param {CallContext} ctx - { userId, sessionKey }.
 * @returns {RequestSpec}
 * @throws {Error} if the tool is unknown.
 */
export function buildRequest(name, args, ctx) {
  const userId = ctx.userId;
  const sessionKey = ctx.sessionKey;
  switch (name) {
    case 'chusky_create_tab':
      return {
        method: 'POST',
        path: '/tabs',
        auth: 'accessKey',
        responseKind: 'json',
        body: { url: args.url, userId, sessionKey },
      };
    case 'chusky_snapshot': {
      const params = new URLSearchParams({ userId, includeScreenshot: 'true' });
      if (args.offset != null && args.offset !== '') params.set('offset', String(args.offset));
      return {
        method: 'GET',
        path: `/tabs/${args.tabId}/snapshot?${params}`,
        auth: 'accessKey',
        responseKind: 'snapshot',
      };
    }
    case 'chusky_click':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/click`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'chusky_type':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/type`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'chusky_navigate':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/navigate`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'chusky_scroll':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/scroll`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { ...without(args), userId },
      };
    case 'chusky_screenshot':
      return {
        method: 'GET',
        path: `/tabs/${args.tabId}/screenshot?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'image',
      };
    case 'chusky_close_tab':
      return {
        method: 'DELETE',
        path: `/tabs/${args.tabId}?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'chusky_evaluate':
      return {
        method: 'POST',
        path: `/tabs/${args.tabId}/evaluate`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId, expression: args.expression },
      };
    case 'chusky_list_tabs':
      return {
        method: 'GET',
        path: `/tabs?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'chusky_import_cookies':
      // Async (Netscape parse + path check) — caller must use buildCookieRequest().
      throw new Error('chusky_import_cookies requires buildCookieRequest() (async cookie parsing)');
    case 'chusky_handoff_start':
      return {
        method: 'POST',
        path: `/tabs/${encodeURIComponent(args.tabId)}/handoff`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId, reason: args.reason, idleMs: args.idleMs },
      };
    case 'chusky_handoff_release':
      return {
        method: 'POST',
        path: `/tabs/${encodeURIComponent(args.tabId)}/handoff/release`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId },
      };
    case 'chusky_pay_arm':
      return {
        method: 'POST',
        path: `/agentcard/tabs/${encodeURIComponent(args.tabId)}/payment`,
        auth: 'accessKey',
        responseKind: 'json',
        body: {
          userId,
          merchant: args.merchant,
          amount: args.amount,
          currency: args.currency,
          checkoutOrigin: args.checkoutOrigin,
          cardId: args.cardId,
        },
      };
    case 'chusky_pay_status':
      return {
        method: 'GET',
        path: `/agentcard/tabs/${encodeURIComponent(args.tabId)}/payment/${encodeURIComponent(args.attachmentId)}?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'chusky_pay_disarm':
      return {
        method: 'DELETE',
        path: `/agentcard/tabs/${encodeURIComponent(args.tabId)}/payment/${encodeURIComponent(args.attachmentId)}?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'agentcard_enrol':
      return {
        method: 'POST',
        path: '/agentcard/vault/enrol',
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId, addAnother: args.addAnother === true },
      };
    case 'agentcard_placeholder':
      return {
        method: 'GET',
        path: `/agentcard/cards/placeholder?${new URLSearchParams({ userId, ...(args.cardId ? { cardId: args.cardId } : {}) })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'agentcard_cards':
      return {
        method: 'GET',
        path: `/agentcard/vault/cards?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'agentcard_buy': {
      const body = { userId };
      for (const key of ['ask', 'threadId', 'confirm', 'new_order', 'product_id', 'store_id']) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      return { method: 'POST', path: '/agentcard/commerce/buy', auth: 'accessKey', responseKind: 'json', body };
    }
    case 'agentcard_merchants': {
      const params = new URLSearchParams({ userId });
      for (const key of ['kind', 'q', 'limit', 'cursor']) {
        if (args[key] !== undefined && args[key] !== '') params.set(key, String(args[key]));
      }
      return { method: 'GET', path: `/agentcard/merchants?${params}`, auth: 'accessKey', responseKind: 'json' };
    }
    case 'agentcard_presets_list':
      return {
        method: 'GET',
        path: `/agentcard/presets?${new URLSearchParams({ userId })}`,
        auth: 'accessKey',
        responseKind: 'json',
      };
    case 'agentcard_preset_set':
      return {
        method: 'PUT',
        path: `/agentcard/presets/${encodeURIComponent(args.label)}`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId, rules: args.rules },
      };
    case 'agentcard_preset_attach':
      return {
        method: 'POST',
        path: `/agentcard/presets/${encodeURIComponent(args.label)}/attach`,
        auth: 'accessKey',
        responseKind: 'json',
        body: { userId, cardId: args.cardId },
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Cookie import is special: the Netscape file must be parsed locally (matching
 * the OpenClaw plugin) and the REST route accepts a parsed `{ cookies: [...] }`
 * body, never a path. This function does the parse and returns a request spec
 * that the host fetch layer can dispatch like any other tool.
 *
 * @param {{cookiesPath: string, domainSuffix?: string}} args
 * @param {CallContext} ctx
 * @param {{apiKey: string, cookiesDir: string}} config - server config (apiKey + cookiesDir).
 * @returns {Promise<RequestSpec & {meta: {imported: number, userId: string}}>}
 * @throws {Error} if CHUSKY_API_KEY is unset.
 */
export async function buildCookieRequest(args, ctx, config) {
  if (!config.apiKey) {
    throw new Error(
      'CHUSKY_API_KEY is not set. Cookie import is disabled unless both the server and the host (MCP/OpenClaw) have CHUSKY_API_KEY.'
    );
  }
  const cookies = await readCookieFile({
    cookiesDir: config.cookiesDir,
    cookiesPath: args.cookiesPath,
    domainSuffix: args.domainSuffix,
  });
  return {
    method: 'POST',
    path: `/sessions/${encodeURIComponent(ctx.userId)}/cookies`,
    auth: 'apiKey',
    responseKind: 'json',
    body: { cookies },
    meta: { imported: cookies.length, userId: ctx.userId },
  };
}

/**
 * Resolve which bearer token a request needs, given server config.
 * @param {RequestSpec} spec
 * @param {{accessKey?: string, apiKey?: string}} config
 * @returns {{header?: {Authorization: string}, missing?: string}}
 */
export function authHeaders(spec, config) {
  if (spec.auth === 'accessKey') {
    if (!config.accessKey) return {}; // server not gated — no header needed
    return { Authorization: `Bearer ${config.accessKey}` };
  }
  if (spec.auth === 'apiKey') {
    // apiKey presence is enforced by buildCookieRequest(); here we only attach it.
    return { Authorization: `Bearer ${config.apiKey}` };
  }
  return {};
}

/**
 * Execute a request spec against a REST base URL. Shared by the MCP server and
 * the OpenClaw plugin so the wire-level behavior (auth headers, image decoding,
 * error formatting) is identical across hosts.
 *
 * @param {string} baseUrl - REST server origin (e.g. http://localhost:9377).
 * @param {RequestSpec} spec
 * @param {{accessKey?: string, apiKey?: string}} config
 * @returns {Promise<unknown>} JSON value, or an image content block for image specs.
 * @throws {Error} on non-2xx, or when an image route returns non-image bytes.
 */
export async function fetchSpec(baseUrl, spec, config) {
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders(spec, config),
  };
  const res = await fetch(`${baseUrl}${spec.path}`, {
    method: spec.method,
    headers,
    body: spec.body ? JSON.stringify(spec.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  if (spec.responseKind === 'image') {
    const contentType = res.headers.get('content-type') || '';
    // Guard: server may return JSON/text (e.g. error with 200) — don't base64 it.
    if (!contentType.startsWith('image/')) {
      const text = await res.text();
      throw new Error(`Screenshot failed: ${text}`);
    }
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { type: 'image', data, mimeType: contentType };
  }
  return res.json();
}

/**
 * Build + dispatch a tool call end-to-end. The single entry point both hosts
 * call, so a tool's full behavior (request shape + auth + transport + response
 * shaping) lives in exactly one place. Hosts only differ in how they source
 * `ctx` (userId/sessionKey) and `config`.
 *
 * @param {string} name - Tool name.
 * @param {Record<string, unknown>} args - Tool arguments.
 * @param {CallContext} ctx - { userId, sessionKey }.
 * @param {string} baseUrl - REST server origin.
 * @param {{apiKey?: string, accessKey?: string, cookiesDir: string}} config - server config.
 * @returns {Promise<{spec: RequestSpec, payload: unknown}>}
 */
export async function runTool(name, args, ctx, baseUrl, config) {
  const spec =
    name === 'chusky_import_cookies'
      ? await buildCookieRequest(args, ctx, config)
      : buildRequest(name, args, ctx);
  const payload = await fetchSpec(baseUrl, spec, config);
  return { spec, payload };
}

/**
 * Shape a REST JSON payload into MCP/OpenClaw content blocks.
 *
 * - snapshot: splits the embedded screenshot out as an image block
 * - image: already an image block produced by the fetch layer
 * - json (default): pretty-printed JSON text block
 *
 * @param {RequestSpec} spec
 * @param {unknown} payload - JSON value ('json'/'snapshot') or an image block ('image').
 * @returns {Array<{type: string, text?: string, data?: string, mimeType?: string}>}
 */
export function adaptResponse(spec, payload) {
  if (spec.responseKind === 'image') {
    return [payload];
  }
  if (spec.responseKind === 'snapshot') {
    const { screenshot, ...rest } = /** @type {any} */ (payload) || {};
    const content = [{ type: 'text', text: JSON.stringify(rest, null, 2) }];
    if (screenshot?.data) {
      content.push({
        type: 'image',
        data: screenshot.data,
        mimeType: screenshot.mimeType || 'image/png',
      });
    }
    return content;
  }
  // Cookie import: surface the parsed count alongside the server reply.
  if (spec.meta && spec.meta.imported != null) {
    return [
      {
        type: 'text',
        text: JSON.stringify({ imported: spec.meta.imported, userId: spec.meta.userId, result: payload }, null, 2),
      },
    ];
  }
  return [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
}
