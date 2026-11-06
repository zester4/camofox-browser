import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeService, WEBHOOK_SECRET } from './helpers.js';
import { createAgentCardService } from '../src/index.js';
import { createHttpHandlers } from '../src/http.js';
import { FAKE_CLIENT, signedDelivery } from './fake-agentcard.js';

/** Mount the handlers the way server.js does, on a real port. */
async function startApp(service) {
  const h = service.handlers;
  const app = express();
  // Order matters: the webhook route must come before the JSON parser, so that
  // the signature is checked against the exact bytes AgentCard sent.
  app.post('/agentcard/webhooks', express.raw({ type: '*/*', limit: '256kb' }), h.webhook);
  app.use(express.json({ limit: '100kb' }));
  app.post('/agentcard/vault/enrol', h.enrol);
  app.get('/agentcard/vault/sessions/:sessionId', h.pollSession);
  app.get('/agentcard/vault/cards', h.listCards);
  app.post('/agentcard/purchases', h.createPurchase);
  app.get('/agentcard/purchases', h.listPurchases);
  app.get('/agentcard/purchases/:purchaseId', h.getPurchase);
  app.post('/agentcard/purchases/:purchaseId/cancel', h.cancelPurchase);
  app.post('/agentcard/purchases/:purchaseId/refresh', h.refreshPurchase);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/agentcard`;
  return {
    base,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
    call: async (method, path, { body, userId } = {}) => {
      const url = `${base}${path}${userId ? `${path.includes('?') ? '&' : '?'}userId=${encodeURIComponent(userId)}` : ''}`;
      const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, text };
    },
  };
}

describe('AgentCard HTTP routes', () => {
  let s;
  let app;

  before(async () => {
    s = makeService();
    app = await startApp(s.service);
  });
  after(async () => { await app.close(); });

  test('every user route requires a userId', async () => {
    assert.equal((await app.call('POST', '/vault/enrol', { body: {} })).status, 400);
    assert.equal((await app.call('GET', '/vault/cards')).status, 400);
    assert.equal((await app.call('GET', '/purchases')).status, 400);
  });

  test('enrol returns the link for the backend to deliver, and the same link when repeated', async () => {
    const first = await app.call('POST', '/vault/enrol', { body: { userId: 'http-a' } });
    assert.equal(first.status, 201);
    assert.equal(first.json.status, 'link');
    assert.match(first.json.url, /^https:\/\/vault\.agentcard\.sh\//);
    const again = await app.call('POST', '/vault/enrol', { body: { userId: 'http-a' } });
    assert.equal(again.status, 200);
    assert.equal(again.json.url, first.json.url);
  });

  test('poll is owner-only and reports pending', async () => {
    const r = await app.call('POST', '/vault/enrol', { body: { userId: 'http-b' } });
    const mine = await app.call('GET', `/vault/sessions/${r.json.sessionId}`, { userId: 'http-b' });
    assert.equal(mine.status, 200);
    assert.equal(mine.json.status, 'pending');
    const theirs = await app.call('GET', `/vault/sessions/${r.json.sessionId}`, { userId: 'http-x' });
    assert.equal(theirs.status, 404);
  });

  test('a stored card is listed as display fields only', async () => {
    const r = await app.call('POST', '/vault/enrol', { body: { userId: 'http-c' } });
    s.fake.linkSession(r.json.sessionId, 'usr_http_c');
    s.advance(3000);
    await app.call('GET', `/vault/sessions/${r.json.sessionId}`, { userId: 'http-c' });
    s.fake.addCard('usr_http_c', { brand: 'visa', last4: '4242' });
    const cards = await app.call('GET', '/vault/cards', { userId: 'http-c' });
    assert.equal(cards.status, 200);
    assert.equal(cards.json.enrolled, true);
    assert.equal(cards.json.cards[0].last4, '4242');
    assert.ok(!cards.text.includes('card_number'));
  });

  test('an enrolled user with a card gets has_card from enrol, with no link', async () => {
    const r = await app.call('POST', '/vault/enrol', { body: { userId: 'http-c' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'has_card');
    assert.equal(r.json.url, undefined);
  });

  test('a purchase before any card gives 409 not_enrolled', async () => {
    const r = await app.call('POST', '/purchases', { body: { userId: 'http-nocard', merchant: 'M', amount: 100, currency: 'usd', psp: 'stripe', request: { url: 'https://a.example/x', method: 'POST' } } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'not_enrolled');
  });

  test('a purchase returns the approval link to the backend, and invalid input gives 400', async () => {
    const ok = await app.call('POST', '/purchases', { body: { userId: 'http-c', merchant: 'Shop', amount: 2306, currency: 'usd', psp: 'stripe', checkoutOrigin: 'https://shop.example.com', request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' } } });
    assert.equal(ok.status, 201);
    assert.match(ok.json.approvalUrl, /authorize\?id=cauth_/);
    const bad = await app.call('POST', '/purchases', { body: { userId: 'http-c', merchant: 'Shop', amount: -1, currency: 'usd', psp: 'stripe', request: { url: 'https://a.example/x', method: 'POST' } } });
    assert.equal(bad.status, 400);
  });

  test('purchase list, detail, cancel and refresh are owner-only', async () => {
    const made = await app.call('POST', '/purchases', { body: { userId: 'http-c', merchant: 'Shop2', amount: 500, currency: 'usd', psp: 'stripe', request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' } } });
    const id = made.json.purchaseId;
    const list = await app.call('GET', '/purchases', { userId: 'http-c' });
    assert.ok(list.json.purchases.some((p) => p.purchaseId === id));
    assert.equal((await app.call('GET', `/purchases/${id}`, { userId: 'http-c' })).status, 200);
    assert.equal((await app.call('GET', `/purchases/${id}`, { userId: 'http-x' })).status, 404);
    assert.equal((await app.call('POST', `/purchases/${id}/cancel`, { body: { userId: 'http-x' } })).status, 404);
    const cancelled = await app.call('POST', `/purchases/${id}/cancel`, { body: { userId: 'http-c' } });
    assert.equal(cancelled.json.status, 'declined');
    const refreshed = await app.call('POST', `/purchases/${id}/refresh`, { body: { userId: 'http-c' } });
    assert.equal(refreshed.json.status, 'declined');
  });

  test('no response carries a secret or a card number', async () => {
    const all = await app.call('GET', '/purchases', { userId: 'http-c' });
    const enrol = await app.call('POST', '/vault/enrol', { body: { userId: 'http-c' } });
    for (const text of [all.text, enrol.text]) {
      assert.ok(!text.includes(FAKE_CLIENT.secret));
      assert.ok(!text.includes(WEBHOOK_SECRET));
      assert.ok(!text.includes('card[number]'));
    }
  });

  test('a signed webhook over HTTP is accepted, and an unsigned one is refused', async () => {
    const t = s.nowSeconds();
    const ev = { id: 'evt_http_unsigned_check', type: 'vault.card_stored', created: t, data: { card_id: 'vc_http' } };
    const good = signedDelivery(ev, WEBHOOK_SECRET, t);
    const res = await fetch(`${app.base}/webhooks`, { method: 'POST', headers: { ...good.headers, 'content-type': 'application/json' }, body: good.body });
    assert.equal(res.status, 200);
    const bad = await fetch(`${app.base}/webhooks`, { method: 'POST', headers: { 'content-type': 'application/json', 'agentcard-signature': `t=${t},v1=00` }, body: good.body });
    assert.equal(bad.status, 401);
  });
});

describe('when AgentCard is not configured', () => {
  test('the app still boots, and the routes answer 503 with the missing names', async () => {
    const service = createAgentCardService({ config: {}, stateFile: null });
    assert.equal(service.configured, false);
    const app = await startApp(service);
    try {
      const r = await app.call('POST', '/vault/enrol', { body: { userId: 'anyone' } });
      assert.equal(r.status, 503);
      assert.equal(r.json.error, 'not_configured');
      assert.match(r.json.message, /AGENTCARD_CLIENT_ID/);
      const hook = await app.call('POST', '/webhooks', { body: {} });
      assert.equal(hook.status, 503);
    } finally {
      await app.close();
    }
  });
});

describe('handler wiring', () => {
  test('the webhook refuses to verify when the raw body is missing', async () => {
    const s2 = makeService();
    const h2 = createHttpHandlers({ vault: s2.service.vault, checkout: s2.service.checkout, webhooks: () => s2.service.webhooks() });
    let sent;
    const res = { status(code) { sent = { code }; return this; }, json(body) { sent.body = body; return this; } };
    await h2.webhook({ headers: {}, body: { already: 'parsed' } }, res);
    assert.equal(sent.code, 500);
    assert.equal(sent.body.error, 'raw_body_required');
  });

  test('createHttpHandlers exposes every route the server mounts', () => {
    const s = makeService();
    const h = createHttpHandlers({ vault: s.service.vault, checkout: s.service.checkout, webhooks: () => s.service.webhooks() });
    for (const name of ['enrol', 'pollSession', 'listCards', 'createPurchase', 'listPurchases', 'getPurchase', 'cancelPurchase', 'refreshPurchase', 'webhook']) {
      assert.equal(typeof h[name], 'function', name);
    }
  });
});
