import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as realSdk from '@agent-cards/commerce-sdk';
import { makeService } from './helpers.js';
import { createCommerce, buyInputFrom } from '../src/commerce.js';

const CONFIG = { clientId: 'id_test', clientSecret: 'secret_test', baseUrl: 'https://api.agentcard.test' };

/**
 * A stand-in for the SDK's buy tool, so the tests see exactly which externalUserId and
 * threadId our code passes, and what it does with the result. The real SDK's answer()
 * calls AgentCard's /buy endpoints, which are verified only against sandbox.
 */
function fakeSdk({ answer } = {}) {
  const built = [];
  const sdk = {
    ...realSdk,
    AgentcardClient: class {
      constructor(options) { this.options = options; }
    },
    buyTool(options) {
      built.push(options);
      return {
        answer: answer ?? (async (input) => ({
          status: 'needs_card',
          reply: 'Add your card to place the order.',
          messages: ['Add your card to place the order.'],
          cart: null,
          carts: [],
          products: [],
          links: [{ kind: 'vault', url: 'https://vault.example/abc' }],
          link_sent: false,
          approval_expires_at: null,
          shopper_need_not_reply: false,
          input,
        })),
      };
    },
    forModel: (result) => ({ status: result.status, reply: result.reply }),
  };
  return { sdk, built };
}

function commerceWith(sdk, api = {}) {
  return createCommerce({ sdk, ensureConfigured: () => {}, config: CONFIG, api });
}

describe('buy: our backend binds the user, never the model', () => {
  test('externalUserId is our userId, and the company client gets the credentials', async () => {
    const { sdk, built } = fakeSdk();
    const c = commerceWith(sdk);
    await c.buy('user-42', { ask: 'two packs of AA batteries from Amazon' });
    assert.equal(built.length, 1);
    assert.equal(built[0].externalUserId, 'user-42');
    assert.equal(built[0].agentcard.options.clientId, 'id_test');
    assert.equal(built[0].agentcard.options.baseUrl, 'https://api.agentcard.test');
    assert.equal(built[0].sendLink, undefined, 'links come back in the result, not through a callback');
  });

  test('a userId in the body does not change who the call is for', async () => {
    const { sdk, built } = fakeSdk();
    const c = commerceWith(sdk);
    await c.buy('user-42', { ask: 'hi', userId: 'someone-else' });
    assert.equal(built[0].externalUserId, 'user-42');
  });

  test('AgentCard identifiers and other user keys are refused, so the model cannot name a user', () => {
    for (const key of ['external_user_id', 'externalUserId', 'user_id', 'userId_agentcard', 'agentcard_user_id', 'card_id']) {
      assert.throws(() => buyInputFrom({ ask: 'x', [key]: 'usr_other' }, realSdk), (e) => e.code === 'invalid_request' && e.message.includes(key), key);
    }
  });

  test('one buy tool per user and chat: reused within a chat, separate across chats', async () => {
    const { sdk, built } = fakeSdk();
    const c = commerceWith(sdk);
    await c.buy('user-1', { ask: 'a', threadId: 'chat-1' });
    await c.buy('user-1', { ask: 'b', threadId: 'chat-1' });
    await c.buy('user-1', { ask: 'c', threadId: 'chat-2' });
    await c.buy('user-2', { ask: 'd', threadId: 'chat-1' });
    assert.equal(built.length, 3);
    assert.deepEqual(built.map((b) => [b.externalUserId, b.threadId]), [
      ['user-1', 'chat-1'],
      ['user-1', 'chat-2'],
      ['user-2', 'chat-1'],
    ]);
    assert.equal(c._toolCount(), 3);
  });
});

describe('buy: input is checked against the SDK schema', () => {
  test('ask is required and bounded', async () => {
    const c = commerceWith(fakeSdk().sdk);
    await assert.rejects(c.buy('u', {}), (e) => e.code === 'invalid_request' && /ask is required/.test(e.message));
    await assert.rejects(c.buy('u', { ask: '   ' }), (e) => e.code === 'invalid_request');
    await assert.rejects(c.buy('u', { ask: 'x'.repeat(2001) }), (e) => e.code === 'invalid_request');
  });

  test('a product and a store cannot both be picked', async () => {
    const c = commerceWith(fakeSdk().sdk);
    await assert.rejects(c.buy('u', { ask: 'x', product_id: 'p1', store_id: 's1' }), (e) => e.code === 'invalid_request');
  });

  test('confirm must be a boolean, as the SDK schema says', async () => {
    const c = commerceWith(fakeSdk().sdk);
    await assert.rejects(c.buy('u', { ask: 'yes', confirm: 'yes' }), (e) => e.code === 'invalid_request');
  });

  test('the five model fields pass through to the SDK', async () => {
    const { sdk } = fakeSdk();
    const c = commerceWith(sdk);
    const out = await c.buy('u', { ask: 'yes', confirm: true, new_order: false, product_id: 'prod_1', store_id: null });
    assert.equal(out.model.status, 'needs_card');
  });

  test('the tool definition the model sees has exactly the five fields', () => {
    const c = commerceWith(realSdk);
    const def = c.definition();
    assert.deepEqual(Object.keys(def.input_schema.properties).sort(), ['ask', 'confirm', 'new_order', 'product_id', 'store_id']);
  });
});

describe('buy: links and products reach the backend, not the model', () => {
  test('links are returned for delivery and are absent from what the model reads', async () => {
    const c = commerceWith(fakeSdk().sdk);
    const out = await c.buy('u', { ask: 'x' });
    assert.equal(out.links.length, 1);
    assert.equal(out.links[0].url, 'https://vault.example/abc');
    assert.ok(!JSON.stringify(out.model).includes('vault.example'), 'model view must hold no link');
  });

  test('a flight is a book product and a table is a reserve product, passed through unchanged', async () => {
    const { sdk } = fakeSdk({
      answer: async () => ({
        status: 'needs_input', reply: 'pick one', messages: ['pick one'], cart: null, carts: [],
        products: [
          { id: 'f1', ref: 'pf1', name: 'LHR to JFK 09:10', action: 'book', priceCents: 42000, currency: 'usd' },
          { id: 't1', ref: 'pt1', name: 'Table for 2, 19:30', action: 'reserve', priceCents: 0, currency: 'usd' },
        ],
        links: [], link_sent: true, approval_expires_at: null, shopper_need_not_reply: false,
      }),
    });
    const out = await commerceWith(sdk).buy('u', { ask: 'a flight and a table', product_id: null, store_id: null });
    assert.deepEqual(out.products.map((p) => p.action), ['book', 'reserve']);
  });

  test('a store-login link reaches the backend with its store named', async () => {
    const { sdk } = fakeSdk({
      answer: async () => ({
        status: 'needs_input', reply: 'sign in', messages: [], cart: null, carts: [], products: [],
        links: [{ kind: 'store_login', store: 'DoorDash', url: 'https://login.example/dd' }],
        link_sent: false, approval_expires_at: null, shopper_need_not_reply: false,
      }),
    });
    const out = await commerceWith(sdk).buy('u', { ask: 'order tacos' });
    assert.equal(out.links[0].kind, 'store_login');
    assert.equal(out.links[0].store, 'DoorDash');
  });
});

describe('merchant check (GET /buy/merchants, through the documented-shape fake)', () => {
  test('returns each merchant with its supported value as AgentCard reports it', async () => {
    const s = makeService();
    const out = await s.service.commerce.merchants({});
    const bySlug = Object.fromEntries(out.merchants.map((m) => [m.slug, m]));
    assert.equal(bySlug.doordash.supported, true);
    assert.equal(bySlug.walmart.supported, false);
    assert.equal(bySlug.opentable.supported, null);
    assert.equal(bySlug.walmart.supported_reason, 'gate_refused');
  });

  test('the request goes to the root /buy/merchants path, not under /api/v2', async () => {
    const s = makeService();
    await s.service.commerce.merchants({});
    const last = s.fake.state.requests.at(-1);
    assert.equal(last.path, '/buy/merchants');
    assert.equal(last.method, 'GET');
  });

  test('with a userId, direct merchants carry that user’s link_status; without one, none', async () => {
    const s = makeService();
    const linked = await s.service.commerce.merchants({ userId: 'user-linked' });
    const dd = linked.merchants.find((m) => m.slug === 'doordash');
    assert.equal(dd.link_status, 'linked');
    assert.equal(s.fake.state.requests.at(-1).query.external_user_id, 'user-linked');

    const anon = await s.service.commerce.merchants({});
    assert.ok(anon.merchants.every((m) => !('link_status' in m)));
  });

  test('kind and q filter the list; limit and cursor are passed on', async () => {
    const s = makeService();
    const catalog = await s.service.commerce.merchants({ kind: 'catalog' });
    assert.deepEqual(catalog.merchants.map((m) => m.slug), ['walmart']);
    const byName = await s.service.commerce.merchants({ q: 'open' });
    assert.deepEqual(byName.merchants.map((m) => m.slug), ['opentable']);
    await s.service.commerce.merchants({ limit: '5', cursor: 'c_1' });
    const q = s.fake.state.requests.at(-1).query;
    assert.equal(q.limit, '5');
    assert.equal(q.cursor, 'c_1');
  });

  test('bad query values are refused before any call', async () => {
    const s = makeService();
    const before = s.fake.state.requests.length;
    await assert.rejects(s.service.commerce.merchants({ kind: 'Catalog!' }), (e) => e.code === 'invalid_request');
    await assert.rejects(s.service.commerce.merchants({ limit: 0 }), (e) => e.code === 'invalid_request');
    await assert.rejects(s.service.commerce.merchants({ limit: 101 }), (e) => e.code === 'invalid_request');
    await assert.rejects(s.service.commerce.merchants({ q: 'x'.repeat(101) }), (e) => e.code === 'invalid_request');
    assert.equal(s.fake.state.requests.length, before, 'nothing is sent for an invalid query');
  });
});

describe('HTTP handlers for commerce', () => {
  function res() {
    const out = { status: 200, body: undefined };
    return {
      out,
      status(code) { out.status = code; return this; },
      json(body) { out.body = body; return this; },
    };
  }

  test('buy returns 400 for a missing ask, and 400 for an AgentCard-style key', async () => {
    const s = makeService();
    const a = res();
    await s.service.handlers.buy({ body: { userId: 'u', ask: '' } }, a);
    assert.equal(a.out.status, 400);
    const b = res();
    await s.service.handlers.buy({ body: { userId: 'u', ask: 'x', external_user_id: 'other' } }, b);
    assert.equal(b.out.status, 400);
    assert.equal(b.out.body.error, 'invalid_request');
  });

  test('buy without a userId is 400', async () => {
    const s = makeService();
    const a = res();
    await s.service.handlers.buy({ body: { ask: 'x' } }, a);
    assert.equal(a.out.status, 400);
  });

  test('merchants returns the list through the handler', async () => {
    const s = makeService();
    const a = res();
    await s.service.handlers.merchants({ query: { kind: 'catalog', userId: 'user-linked' } }, a);
    assert.equal(a.out.status, 200);
    assert.deepEqual(a.out.body.merchants.map((m) => m.slug), ['walmart']);
  });

  test('the definition handler serves the SDK tool definition', () => {
    const s = makeService();
    const a = res();
    s.service.handlers.buyDefinition({}, a);
    assert.equal(a.out.status, 200);
    assert.ok(a.out.body.input_schema);
  });
});
