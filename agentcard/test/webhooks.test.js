import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { makeService, WEBHOOK_SECRET } from './helpers.js';
import { signedDelivery } from './fake-agentcard.js';

describe('webhook receiver', () => {
  test('a bad signature is refused and changes nothing', async () => {
    const s = makeService();
    const { body } = signedDelivery({ id: 'evt_bad', type: 'vault.session_linked', data: {} }, 'wrong', s.nowSeconds());
    const res = await s.service.webhooks()({ headers: { 'agentcard-signature': `t=${s.nowSeconds()},v1=00` }, rawBody: body });
    assert.equal(res.status, 401);
    assert.equal(s.service.store.markEventSeen('evt_bad'), true, 'the event id was never recorded');
  });

  test('a stale signature (replay) is refused', async () => {
    const s = makeService();
    const { body, headers } = signedDelivery({ id: 'evt_old', type: 'vault.card_stored', data: {} }, WEBHOOK_SECRET, s.nowSeconds() - 3600);
    const res = await s.service.webhooks()({ headers, rawBody: body });
    assert.equal(res.status, 401);
  });

  test('duplicate deliveries are acknowledged and processed once', async () => {
    let seen = 0;
    const s = makeService();
    const handler = s.service.webhooks();
    const once = { id: 'evt_dup', type: 'vault.card_stored', data: { card_id: 'vc_1' } };
    const d1 = signedDelivery(once, WEBHOOK_SECRET, s.nowSeconds());
    assert.equal((await handler({ headers: d1.headers, rawBody: d1.body })).status, 200);
    const again = await handler({ headers: d1.headers, rawBody: d1.body });
    assert.equal(again.body.duplicate, true);
    seen = s.service.store.listCardEvents().length;
    assert.equal(seen, 1);
  });

  test('a failed handler returns 500 and the retry is processed', async () => {
    const s = makeService();
    const handler = s.service.webhooks();
    const original = s.service.checkout.applyWebhookEvent;
    let calls = 0;
    s.service.checkout.applyWebhookEvent = (event) => {
      calls += 1;
      if (calls === 1) throw new Error('database unavailable');
      return original(event);
    };
    const { purchaseId } = await seedPurchase(s);
    const event = { id: 'evt_retry', type: 'checkout_authorization.approved', created: s.nowSeconds(), data: { id: purchaseId } };
    const d = signedDelivery(event, WEBHOOK_SECRET, s.nowSeconds());
    assert.equal((await handler({ headers: d.headers, rawBody: d.body })).status, 500);
    assert.equal((await handler({ headers: d.headers, rawBody: d.body })).status, 200);
    assert.equal(s.service.checkout.detail('buyer', purchaseId).status, 'approved');
    assert.equal(calls, 2);
  });

  test('missing id or type, and invalid JSON, are rejected', async () => {
    const s = makeService();
    const handler = s.service.webhooks();
    const noId = signedDelivery({ type: 'vault.card_stored' }, WEBHOOK_SECRET, s.nowSeconds());
    assert.equal((await handler({ headers: noId.headers, rawBody: noId.body })).status, 400);
    const junk = '{not json';
    const t = s.nowSeconds();
    const sig = `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${junk}`).digest('hex')}`;
    assert.equal((await handler({ headers: { 'agentcard-signature': sig }, rawBody: junk })).status, 400);
  });

  test('event families this app does not use are accepted and ignored', async () => {
    const s = makeService();
    const r = await s.deliver({ id: 'evt_order', type: 'order.placed', data: {} });
    assert.equal(r.status, 200);
  });

  test('the webhook needs a configured secret', () => {
    const s = makeService({ configOverrides: { webhookSecret: '' } });
    assert.throws(() => s.service.webhooks(), (e) => e.code === 'not_configured');
  });

  test('over real HTTP with the raw body: a signed vault link completes enrolment', async () => {
    const s = makeService();
    const { sessionId } = await s.service.vault.start('http-user');
    s.fake.linkSession(sessionId, 'usr_http');
    const { createHttpHandlers } = await import('../src/http.js');
    const express = (await import('express')).default;
    const handlers = createHttpHandlers({ vault: s.service.vault, checkout: s.service.checkout, webhooks: () => s.service.webhooks() });
    const app = express();
    app.post('/', express.raw({ type: '*/*', limit: '256kb' }), handlers.webhook);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const event = { id: 'evt_http_link', type: 'vault.session_linked', created: s.nowSeconds(), data: { vault_session_id: sessionId, user_id: 'usr_http' } };
      const { body, headers } = signedDelivery(event, WEBHOOK_SECRET, s.nowSeconds());
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
      assert.equal(res.status, 200);
      assert.equal(s.service.store.getAgentCardUser('http-user'), 'usr_http');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

async function seedPurchase(s) {
  const { sessionId } = await s.service.vault.start('buyer');
  s.fake.linkSession(sessionId, 'usr_buyer');
  s.advance(3000);
  await s.service.vault.poll('buyer', sessionId);
  s.fake.addCard('usr_buyer', { last4: '4242' });
  const r = await s.service.checkout.request('buyer', {
    merchant: 'Shop', amount: 100, currency: 'usd', psp: 'stripe',
    request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' },
  });
  return { purchaseId: r.purchaseId };
}
