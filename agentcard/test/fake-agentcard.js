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

const MERCHANTS = [
  { kind: 'direct', slug: 'doordash', name: 'DoorDash', domain: 'doordash.com', buys_through: 'doordash', supported: true, supported_reason: 'pay_proven', supported_detail: null, supported_read_at: '2026-11-01T00:00:00Z', countries: ['US'] },
  { kind: 'direct', slug: 'opentable', name: 'OpenTable', domain: 'opentable.com', buys_through: 'opentable', supported: null, supported_reason: 'unreached', supported_detail: null, supported_read_at: null, countries: ['US'] },
  { kind: 'catalog', slug: 'walmart', name: 'Walmart', domain: 'walmart.com', buys_through: 'agentcard', supported: false, supported_reason: 'gate_refused', supported_detail: 'refused at checkout', supported_read_at: '2026-11-01T00:00:00Z', countries: ['US'] },
];

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
    preparations: new Map(), // id -> record
    presets: new Map(), // name -> { name, rules, attachments: [] }
    outcomes: new Map(), // authorization id -> [reports]
    disconnected: new Set(),
    recognizers: [
      { psp: 'stripe', match: 'api\\.stripe\\.com/v1/tokens', hosts: ['^api\\.stripe\\.com$'], encoding: 'form', passthroughHeaders: [], request: { method: 'POST' } },
      { psp: 'aci', match: 'secure\\.aci\\.example/v1/checkouts/[^/]+', hosts: ['^secure\\.aci\\.example$'], encoding: 'json', passthroughHeaders: [], request: { method: 'POST' }, preparationRequired: true },
    ],
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

    if (method === 'GET' && path === '/api/v2/checkout/recognizers') {
      return json(200, state.recognizers);
    }

    if (method === 'POST' && path === '/api/v2/checkout/preparations') {
      for (const field of ['user', 'merchant', 'amount', 'currency', 'psp', 'merchant_origin', 'checkout_key']) {
        if (body?.[field] === undefined || body?.[field] === null || body?.[field] === '') {
          return json(400, { error: { code: 'invalid_request', message: `${field} is required` } });
        }
      }
      const existing = [...state.preparations.values()].find((x) => x.checkout_key === body.checkout_key);
      if (existing) return json(200, existing);
      const id = `cprep_${++idSeq}`;
      const record = {
        id, object: 'checkout_preparation', status: 'awaiting_approval', user: body.user,
        merchant: body.merchant, amount: body.amount, currency: body.currency, psp: body.psp,
        merchant_origin: body.merchant_origin, card_id: body.card_id ?? null, checkout_key: body.checkout_key,
        approvalUrl: `https://vault.agentcard.sh/authorize?id=${id}`, ready_expires_at: null, authorization_id: null,
        payment_status: 'not_started',
      };
      state.preparations.set(id, record);
      return json(201, record);
    }

    const prepMatch = path.match(/^\/api\/v2\/checkout\/preparations\/([^/]+)(\/cancel)?$/);
    if (prepMatch) {
      const rec = state.preparations.get(prepMatch[1]);
      if (!rec) return json(404, { error: { code: 'not_found', message: 'No such preparation' } });
      if (method === 'POST' && prepMatch[2]) {
        if (rec.status === 'awaiting_approval') rec.status = 'cancelled';
        return json(200, rec);
      }
      if (method === 'GET') return json(200, rec);
    }

    const outcomeMatch = path.match(/^\/api\/v2\/checkout\/authorizations\/([^/]+)\/outcome$/);
    if (method === 'POST' && outcomeMatch) {
      const rec = state.authorizations.get(outcomeMatch[1]);
      if (!rec) return json(404, { error: { code: 'not_found', message: 'No such authorization' } });
      const reports = state.outcomes.get(rec.id) ?? [];
      if (rec.charged_kind !== 'none' || rec.status !== 'approved') {
        return json(409, { error: { code: 'outcome_not_reportable', message: 'Not reportable' } });
      }
      reports.push(body);
      state.outcomes.set(rec.id, reports);
      return json(200, { object: 'checkout_outcome', id: rec.id, outcome: body.outcome, replayed: false });
    }

    if (method === 'POST' && path === '/api/v2/checkout/vault_link') {
      if (!state.users.has(body?.user)) return json(404, { error: { code: 'not_found', message: 'User not connected' } });
      return json(202, { object: 'vault_link', sent: true, user: body.user });
    }

    const disconnectMatch = path.match(/^\/api\/v2\/vault_users\/([^/]+)\/connection$/);
    if (method === 'DELETE' && disconnectMatch) {
      const userId = disconnectMatch[1];
      if (!state.users.has(userId)) return json(404, { error: { code: 'connection_not_found', message: 'No connection' } });
      state.users.delete(userId);
      state.disconnected.add(userId);
      return json(200, { object: 'vault_user_connection', user_id: userId, connected: false, revoked_tokens: 1, revoked_wallet_links: 0, revoked_sessions: 0, test_mode: true });
    }

    const presetMatch = path.match(/^\/api\/v2\/vault\/presets(?:\/([^/]+))?(\/attachments)?$/);
    if (presetMatch) {
      const name = presetMatch[1];
      if (method === 'GET' && !name) return json(200, { object: 'list', data: [...state.presets.values()].map(presetView) });
      if (method === 'PUT' && name && presetMatch[2]) {
        const preset = state.presets.get(name);
        if (!preset) return json(404, { error: { code: 'not_found', message: 'No such preset' } });
        const owner = [...state.users.values()].find((u) => u.cards.some((c) => c.id === body?.target_id));
        if (body?.kind !== 'card' || !owner) return json(404, { error: { code: 'card_not_found', message: 'Card not stored' } });
        const card = owner.cards.find((c) => c.id === body.target_id);
        if (!preset.attachments.some((a) => a.target_id === card.id)) preset.attachments.push({ kind: 'card', target_id: card.id, last4: card.last4 });
        return json(200, presetView(preset));
      }
      if (name && !presetMatch[2]) {
        if (method === 'PUT') {
          const existing = state.presets.get(name);
          const rules = body ?? {};
          if (rules.per_day !== undefined && (typeof rules.per_day !== 'number' || rules.per_day <= 0)) {
            return json(400, { error: { code: 'policy_invalid', message: 'per_day must be a positive number of dollars' } });
          }
          const preset = { name, rules, attachments: existing?.attachments ?? [] };
          state.presets.set(name, preset);
          return json(200, presetView(preset));
        }
        if (method === 'GET') {
          const preset = state.presets.get(name);
          return preset ? json(200, presetView(preset)) : json(404, { error: { code: 'not_found', message: 'No such preset' } });
        }
        if (method === 'DELETE') {
          return state.presets.delete(name) ? json(200, { object: 'vault_preset_deleted', name }) : json(404, { error: { code: 'not_found', message: 'No such preset' } });
        }
      }
    }

    if (method === 'POST' && path === '/api/v2/webhook_endpoints') {
      const endpoint = { id: `we_${++idSeq}`, object: 'webhook_endpoint', url: body.url, enabled_events: body.enabled_events, status: 'active', secret: webhookSecret };
      state.endpoints.push(endpoint);
      return json(201, endpoint);
    }
    const secretMatch = path.match(/^\/api\/v2\/webhook_endpoints\/([^/]+)\/secret$/);
    if (method === 'GET' && secretMatch) return json(200, { id: secretMatch[1], secret: webhookSecret });

    if (method === 'GET' && path === '/buy/merchants') {
      // Documented shape: merchants[], next_cursor, counts. `link_status` appears only
      // for direct merchants when external_user_id is passed.
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const kind = url.searchParams.get('kind');
      const externalUserId = url.searchParams.get('external_user_id');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
      let rows = MERCHANTS.filter((m) => (!q || m.name.toLowerCase().includes(q) || m.domain?.includes(q))
        && (!kind || m.kind === kind));
      rows = rows.slice(0, limit).map((m) => {
        const out = { ...m };
        if (externalUserId && m.kind === 'direct') {
          out.link_status = externalUserId === 'user-linked' ? 'linked' : 'not_linked';
        }
        return out;
      });
      return json(200, { merchants: rows, next_cursor: null, counts: { direct: rows.filter((m) => m.kind === 'direct').length, catalog: rows.filter((m) => m.kind === 'catalog').length } });
    }

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
    /** The outcome reports AgentCard has recorded for an authorization. */
    outcomesFor(id) {
      return state.outcomes.get(id) ?? [];
    },
    /** Set a preparation's status, as the user's approval does on AgentCard's side. */
    setPreparation(id, patch) {
      const rec = state.preparations.get(id);
      if (rec) Object.assign(rec, patch);
      return rec;
    },
    setAuthorization(id, patch) {
      const rec = state.authorizations.get(id);
      if (rec) Object.assign(rec, patch);
      return rec;
    },
  };
}

function presetView(p) {
  return {
    object: 'vault_preset',
    name: p.name,
    id: `pol_${p.name.slice(0, 12)}`,
    version: 1,
    summary: 'test rules',
    attachments: p.attachments,
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
