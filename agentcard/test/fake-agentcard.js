/**
 * In-process fake of the AgentCard API, for tests only.
 *
 * It follows the documented contract: client-credentials tokens, sessions with
 * external_user_id and steps, vault_cards returning {object:"list", data:[…]}
 * with a 404 connection_not_found for unknown users, checkout authorizations
 * with card_id and checkout_origin, and webhook endpoints that return a secret.
 * Shapes the docs leave unverified are marked in the modules, and are
 * confirmed by the sandbox check.
 */
import { createHmac } from 'node:crypto';

export const FAKE_CLIENT = { id: 'cli_test', secret: 'sec_test' };

export function createFakeAgentCard({ webhookSecret = 'whsec_test', tokenLifetimeSeconds = 3600, mode = 'sandbox' } = {}) {
  let tokenSeq = 0;
  let idSeq = 0;
  const state = {
    tokens: new Set(),
    tokenRequests: 0,
    sessions: new Map(), // id -> { status, user_id, external_user_id, steps, expires_at }
    users: new Map(), // user_id -> { cards: [] }   (a vault exists once a session links)
    authorizations: new Map(), // id -> record
    endpoints: [],
    requests: [], // { method, path, body }
    queued: [], // one-shot overrides
  };

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const inFifteen = () => new Date(Date.now() + 15 * 60_000).toISOString();
  const inADay = () => new Date(Date.now() + 24 * 3600_000).toISOString();

  async function handler(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const body = typeof init.body === 'string' ? safeJson(init.body) : init.body;
    state.requests.push({ method, path, body, query: Object.fromEntries(url.searchParams) });

    const idx = state.queued.findIndex((q) => q.match(method, path));
    if (idx >= 0) return state.queued.splice(idx, 1)[0].respond();

    if (method === 'POST' && path === '/api/v2/oauth/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('client_id') !== FAKE_CLIENT.id || form.get('client_secret') !== FAKE_CLIENT.secret) {
        return json(401, { error: { code: 'invalid_client', message: 'Bad credentials' } });
      }
      state.tokenRequests += 1;
      const value = `tok_${++tokenSeq}`;
      state.tokens.add(value);
      return json(200, { access_token: value, token_type: 'Bearer', expires_in: tokenLifetimeSeconds, scope: 'api' });
    }

    const headers = init.headers ?? {};
    const bearer = (headers.authorization ?? headers.Authorization ?? '').replace(/^Bearer /, '');
    if (!state.tokens.has(bearer)) {
      return json(401, { error: { code: 'unauthorized', message: 'Missing or invalid token' } });
    }

    if (method === 'POST' && path === '/api/v2/vault_sessions') {
      if (body?.user_id && !state.users.has(body.user_id)) {
        return json(404, { error: { code: 'connection_not_found', message: 'No connection for that user' } });
      }
      const id = `vs_${++idSeq}`;
      state.sessions.set(id, {
        status: 'pending',
        user_id: null,
        external_user_id: body?.external_user_id ?? null,
        steps: body?.steps ?? null,
        expires_at: inADay(),
      });
      return json(201, {
        object: 'vault_session',
        id,
        user_id: null,
        url: `https://vault.agentcard.sh/v?vs=${id}.signature-${id}`,
        poll_interval: 3,
        expires_at: state.sessions.get(id).expires_at,
        test_mode: mode === 'sandbox',
      });
    }

    const sessionMatch = path.match(/^\/api\/v2\/vault_sessions\/([^/]+)$/);
    if (method === 'GET' && sessionMatch) {
      const s = state.sessions.get(sessionMatch[1]);
      if (!s) return json(404, { error: { code: 'not_found', message: 'No such session' } });
      return json(200, { id: sessionMatch[1], object: 'vault_session', status: s.status, user_id: s.user_id, external_user_id: s.external_user_id, expires_at: s.expires_at });
    }

    if (method === 'GET' && path === '/api/v2/vault_cards') {
      const userId = url.searchParams.get('user_id');
      const user = state.users.get(userId);
      if (!user) return json(404, { error: { code: 'connection_not_found', message: 'No sandbox connection exists for that user.' } });
      return json(200, { object: 'list', data: [...user.cards].reverse() });
    }

    if (method === 'POST' && path === '/api/v2/checkout/authorizations') {
      for (const field of ['user', 'merchant', 'psp', 'request']) {
        if (body?.[field] === undefined || body?.[field] === null || body?.[field] === '') {
          return json(400, { error: { code: 'invalid_request', message: `${field} is required` } });
        }
      }
      if (body.card_id) {
        const owner = state.users.get(body.user);
        if (!owner || !owner.cards.some((c) => c.id === body.card_id)) {
          return json(400, { error: { code: 'invalid_request', message: 'card_id is not on this user’s vault' } });
        }
      }
      if (body.checkout_origin && !/^https:\/\/[^/]+$/.test(body.checkout_origin)) {
        return json(400, { error: { code: 'invalid_request', message: 'checkout_origin must be an https origin' } });
      }
      const id = `cauth_${++idSeq}`;
      const record = {
        id,
        object: 'checkout_authorization',
        user: body.user,
        merchant: body.merchant,
        amount: body.amount ?? null,
        currency: body.currency ?? null,
        card_id: body.card_id ?? null,
        status: 'awaiting_approval',
        settlement: null,
        approvalUrl: `https://vault.agentcard.sh/authorize?id=${id}`,
        expires_at: inFifteen(),
        poll_interval_ms: 2000,
      };
      state.authorizations.set(id, record);
      return json(201, record);
    }

    const authMatch = path.match(/^\/api\/v2\/checkout\/authorizations\/([^/]+)(\/cancel)?$/);
    if (authMatch) {
      const rec = state.authorizations.get(authMatch[1]);
      if (!rec) return json(404, { error: { code: 'not_found', message: 'No such authorization' } });
      if (method === 'POST' && authMatch[2]) {
        if (rec.status === 'awaiting_approval') rec.status = 'declined';
        return json(200, { id: rec.id, status: rec.status, reason: 'merchant_request_aborted', cancelled: true });
      }
      if (method === 'GET') return json(200, rec);
    }

    if (method === 'POST' && path === '/api/v2/webhook_endpoints') {
      const endpoint = { id: `we_${++idSeq}`, object: 'webhook_endpoint', url: body.url, enabled_events: body.enabled_events, status: 'active', secret: webhookSecret };
      state.endpoints.push(endpoint);
      return json(201, endpoint);
    }
    const secretMatch = path.match(/^\/api\/v2\/webhook_endpoints\/([^/]+)\/secret$/);
    if (method === 'GET' && secretMatch) return json(200, { id: secretMatch[1], secret: webhookSecret });

    return json(404, { error: { code: 'not_found', message: `No route for ${method} ${path}` } });
  }

  return {
    fetch: handler,
    state,
    queue(match, respond) {
      state.queued.push({ match, respond });
    },
    /** Simulate the user finishing the vault page with their passkey. */
    linkSession(sessionId, agentcardUserId) {
      const s = state.sessions.get(sessionId);
      if (!s) return;
      s.status = 'linked';
      s.user_id = agentcardUserId;
      if (!state.users.has(agentcardUserId)) state.users.set(agentcardUserId, { cards: [] });
    },
    expireSession(sessionId) {
      const s = state.sessions.get(sessionId);
      if (s) s.status = 'expired';
    },
    /** Store a card on a user's vault. Returns the card as the API lists it. */
    addCard(agentcardUserId, { brand = 'visa', last4 = '4242', id } = {}) {
      if (!state.users.has(agentcardUserId)) state.users.set(agentcardUserId, { cards: [] });
      const card = {
        object: 'vault_card',
        id: id ?? `vc_${Math.random().toString(16).slice(2, 14)}`,
        brand,
        last4,
        expiry_month: 12,
        expiry_year: 2030,
        created_at: new Date().toISOString(),
      };
      state.users.get(agentcardUserId).cards.push(card);
      return card;
    },
    setAuthorization(id, patch) {
      const rec = state.authorizations.get(id);
      if (rec) Object.assign(rec, patch);
      return rec;
    },
  };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Build a signed webhook delivery exactly as AgentCard sends it. */
export function signedDelivery(event, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return { body, headers: { 'agentcard-signature': `t=${t},v1=${v1}` } };
}
