import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';

const REQ = { url: 'https://api.stripe.com/v1/tokens', method: 'post', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'card[number]=placeholder' };
const BASE = { merchant: 'Example Shop', amount: 2306, currency: 'usd', psp: 'stripe', request: REQ, checkoutOrigin: 'https://shop.example.com' };

/** A user with a linked vault and one stored card. Returns the card id. */
async function userWithCard(s, userId = 'buyer', acId = `usr_${userId}`) {
  if (!s.service.store.getAgentCardUser(userId)) {
    const { sessionId } = await s.service.vault.start(userId);
    s.fake.linkSession(sessionId, acId);
    s.advance(3000);
    await s.service.vault.poll(userId, sessionId);
  }
  return s.fake.addCard(acId, { brand: 'visa', last4: '4242' }).id;
}

const authOf = (s, id) => s.fake.state.authorizations.get(id);

describe('before a purchase', () => {
  test('refuses a user who has never stored a card', async () => {
    const s = makeService();
    await assert.rejects(s.service.checkout.request('nobody', BASE), (e) => e.code === 'not_enrolled');
    assert.equal(s.fake.state.authorizations.size, 0);
  });

  test('refuses a user whose vault is empty', async () => {
    const s = makeService();
    const { sessionId } = await s.service.vault.start('empty');
    s.fake.linkSession(sessionId, 'usr_empty');
    s.advance(3000);
    await s.service.vault.poll('empty', sessionId);
    await assert.rejects(s.service.checkout.request('empty', BASE), (e) => e.code === 'no_card');
  });

  test('refuses an invalid request before calling AgentCard', async () => {
    const s = makeService();
    await userWithCard(s);
    const bad = [
      { amount: 0 }, { amount: 12.5 }, { amount: '23.06' },
      { currency: 'USD' }, { currency: 'dollars' },
      { psp: '' }, { psp: 'Stripe!' },
      { merchant: '' }, { merchant: 'x'.repeat(121) },
      { request: { url: 'http://insecure.example', method: 'POST' } },
      { request: { method: 'POST' } },
      { checkoutOrigin: 'https://shop.example.com/cart' },
      { checkoutOrigin: 'http://shop.example.com' },
    ];
    for (const override of bad) {
      await assert.rejects(s.service.checkout.request('buyer', { ...BASE, ...override }), (e) => e.code === 'invalid_request', JSON.stringify(override));
    }
    assert.equal(s.fake.state.authorizations.size, 0);
  });

  test('refuses a card that is not on this user’s vault', async () => {
    const s = makeService();
    await userWithCard(s);
    await assert.rejects(s.service.checkout.request('buyer', { ...BASE, cardId: 'vc_not_mine' }), (e) => e.code === 'card_not_found');
  });

  test('enforces a configured amount limit', async () => {
    const s = makeService({ maxAmountCents: 5000 });
    await userWithCard(s);
    await assert.rejects(s.service.checkout.request('buyer', { ...BASE, amount: 5001 }), (e) => e.code === 'over_limit');
    assert.equal(s.fake.state.authorizations.size, 0);
  });
});

describe('making a purchase', () => {
  test('pays with the default (first) card, and sends the documented fields', async () => {
    const s = makeService();
    const cardId = await userWithCard(s);
    const r = await s.service.checkout.request('buyer', BASE);
    const sent = s.fake.state.requests.find((q) => q.path === '/api/v2/checkout/authorizations').body;
    assert.equal(sent.user, 'usr_buyer');
    assert.equal(sent.card_id, cardId);
    assert.equal(sent.checkout_origin, 'https://shop.example.com');
    assert.equal(sent.request.method, 'POST');
    assert.equal(r.status, 'awaiting_approval');
    assert.equal(r.cardId, cardId);
  });

  test('uses the card the user chose', async () => {
    const s = makeService();
    await userWithCard(s);
    const second = s.fake.addCard('usr_buyer', { brand: 'mastercard', last4: '5555' }).id;
    s.service.store.setAgentCardUser('buyer', 'usr_buyer');
    const r = await s.service.checkout.request('buyer', { ...BASE, cardId: second });
    assert.equal(r.cardId, second);
  });

  test('returns the approval link to the caller, and the user never sees it from us unprompted', async () => {
    const s = makeService();
    await userWithCard(s);
    const r = await s.service.checkout.request('buyer', BASE);
    assert.match(r.approvalUrl, /^https:\/\/vault\.agentcard\.sh\/authorize\?id=cauth_/);
    assert.equal(s.service.store.getPurchase(r.purchaseId).userId, 'buyer');
  });

  test('a purchase is recorded with its event log', async () => {
    const s = makeService();
    await userWithCard(s);
    const r = await s.service.checkout.request('buyer', BASE);
    const detail = s.service.checkout.detail('buyer', r.purchaseId);
    assert.deepEqual(detail.events.map((e) => e.type), ['requested']);
    assert.equal(detail.canRetry, false);
  });
});

describe('outcomes from webhooks', () => {
  async function purchase(s) {
    await userWithCard(s);
    return (await s.service.checkout.request('buyer', BASE)).purchaseId;
  }

  test('approved: final success, never retried', async () => {
    const s = makeService();
    const id = await purchase(s);
    await s.deliver({ id: 'evt_a', type: 'checkout_authorization.approved', created: s.nowSeconds(), data: { id, charged_amount: 2306, charged_kind: 'captured' } });
    const d = s.service.checkout.detail('buyer', id);
    assert.equal(d.status, 'approved');
    assert.equal(d.chargedAmount, 2306);
    assert.equal(d.canRetry, false);
  });

  test('submitted on device: maps to submitted_on_device and is not retried', async () => {
    const s = makeService();
    const id = await purchase(s);
    await s.deliver({ id: 'evt_s', type: 'checkout_authorization.submitted', created: s.nowSeconds(), data: { id } });
    assert.equal(s.service.checkout.detail('buyer', id).status, 'submitted_on_device');
    assert.equal(s.service.checkout.canRetry('buyer', id), false);
  });

  test('declined and expired may be retried', async () => {
    const s = makeService();
    const a = await purchase(s);
    await s.deliver({ id: 'evt_d', type: 'checkout_authorization.declined', created: s.nowSeconds(), data: { id: a, reason: 'user_declined' } });
    assert.equal(s.service.checkout.canRetry('buyer', a), true);
    const b = await purchase(s);
    await s.deliver({ id: 'evt_e', type: 'checkout_authorization.expired', created: s.nowSeconds(), data: { id: b } });
    assert.equal(s.service.checkout.canRetry('buyer', b), true);
  });

  test('an amount mismatch counts as declined', async () => {
    const s = makeService();
    const id = await purchase(s);
    await s.deliver({ id: 'evt_m', type: 'checkout_authorization.amount_mismatch', created: s.nowSeconds(), data: { id } });
    assert.equal(s.service.checkout.detail('buyer', id).status, 'declined');
  });

  test('settlement unconfirmed allows a retry only once AgentCard marks it final', async () => {
    const s = makeService();
    const id = await purchase(s);
    await s.deliver({ id: 'evt_a2', type: 'checkout_authorization.approved', created: s.nowSeconds(), data: { id } });
    await s.deliver({ id: 'evt_u1', type: 'checkout_authorization.settlement_unconfirmed', created: s.nowSeconds(), data: { id, settlement: { status: 'not_settled', reason: 'not_confirmed', final: false } } });
    assert.equal(s.service.checkout.canRetry('buyer', id), false);
    await s.deliver({ id: 'evt_u2', type: 'checkout_authorization.settlement_unconfirmed', created: s.nowSeconds(), data: { id, settlement: { status: 'not_settled', reason: 'not_confirmed', final: true } } });
    assert.equal(s.service.checkout.canRetry('buyer', id), true);
  });

  test('settled records the settlement; watched is logged but changes nothing', async () => {
    const s = makeService();
    const id = await purchase(s);
    await s.deliver({ id: 'evt_w', type: 'checkout_authorization.watched', created: s.nowSeconds(), data: { id } });
    assert.equal(s.service.checkout.detail('buyer', id).status, 'awaiting_approval');
    await s.deliver({ id: 'evt_st', type: 'checkout_authorization.settled', created: s.nowSeconds(), data: { id, settlement: { status: 'settled', reason: 'processor_succeeded', final: true } } });
    const d = s.service.checkout.detail('buyer', id);
    assert.equal(d.status, 'settled');
    assert.equal(d.settlement.status, 'settled');
  });
});

describe('cancel and refresh', () => {
  test('cancel stops a purchase that is waiting for approval', async () => {
    const s = makeService();
    await userWithCard(s);
    const { purchaseId } = await s.service.checkout.request('buyer', BASE);
    const r = await s.service.checkout.cancel('buyer', purchaseId);
    assert.equal(r.status, 'declined');
    assert.equal(s.service.checkout.canRetry('buyer', purchaseId), true);
  });

  test('cancel does nothing once the purchase has moved on', async () => {
    const s = makeService();
    await userWithCard(s);
    const { purchaseId } = await s.service.checkout.request('buyer', BASE);
    await s.deliver({ id: 'evt_x', type: 'checkout_authorization.approved', created: s.nowSeconds(), data: { id: purchaseId } });
    const r = await s.service.checkout.cancel('buyer', purchaseId);
    assert.equal(r.status, 'approved');
    assert.equal(s.fake.state.requests.filter((q) => q.path.endsWith('/cancel')).length, 0);
  });

  test('refresh reads the authoritative status when a webhook is late', async () => {
    const s = makeService();
    await userWithCard(s);
    const { purchaseId } = await s.service.checkout.request('buyer', BASE);
    s.fake.setAuthorization(purchaseId, { status: 'approved', charged_amount: 2306, charged_kind: 'captured' });
    const r = await s.service.checkout.refresh('buyer', purchaseId);
    assert.equal(r.status, 'approved');
    assert.equal(r.chargedAmount, 2306);
  });
});

describe('ownership', () => {
  test('one user cannot read, cancel or refresh another user’s purchase', async () => {
    const s = makeService();
    await userWithCard(s, 'buyer');
    await userWithCard(s, 'thief', 'usr_thief');
    const { purchaseId } = await s.service.checkout.request('buyer', BASE);
    assert.throws(() => s.service.checkout.detail('thief', purchaseId), (e) => e.code === 'not_found');
    await assert.rejects(s.service.checkout.cancel('thief', purchaseId), (e) => e.code === 'not_found');
    await assert.rejects(s.service.checkout.refresh('thief', purchaseId), (e) => e.code === 'not_found');
    assert.equal(s.service.checkout.list('thief').length, 0);
    assert.equal(s.service.checkout.list('buyer').length, 1);
  });

  test('card ids and secrets are not part of the purchase summary', async () => {
    const s = makeService();
    await userWithCard(s);
    const r = await s.service.checkout.request('buyer', BASE);
    const text = JSON.stringify(s.service.checkout.list('buyer'));
    assert.ok(!text.includes('placeholder'));
    assert.ok(!text.includes('card[number]'));
    assert.ok(r.approvalUrl);
  });
});
