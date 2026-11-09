import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';
import { presetBodyFrom, presetNameFor, toRegistry, corsHeaders } from '../src/index.js';

/** Store a card for one of our users, as the vault flow does. */
async function enrol(s, userId, agentcardUserId = `usr_${userId}`) {
  const { sessionId } = await s.service.vault.start(userId);
  s.fake.linkSession(sessionId, agentcardUserId);
  s.advance(3000);
  await s.service.vault.poll(userId, sessionId);
  s.fake.addCard(agentcardUserId, { last4: '4242' });
  return agentcardUserId;
}

const SHOP = 'https://shop.example.com';

describe('approve before pay (preparations)', () => {
  test('prepare returns the approval link and a next step, and records a preparation', async () => {
    const s = makeService();
    await enrol(s, 'prep-a');
    const r = await s.service.checkout.prepare('prep-a', { merchant: 'Shop', amount: 2306, currency: 'usd', psp: 'stripe', merchantOrigin: SHOP });
    assert.match(r.purchaseId, /^cprep_/);
    assert.equal(r.status, 'awaiting_approval');
    assert.match(r.approvalUrl, /authorize\?id=cprep_/);
    assert.match(r.nextStep, /ready/);
    assert.equal(s.service.store.getPurchase(r.purchaseId).kind, 'preparation');
  });

  test('merchantOrigin is required and must be an https origin with no path', async () => {
    const s = makeService();
    await enrol(s, 'prep-b');
    const base = { merchant: 'Shop', amount: 100, currency: 'usd', psp: 'stripe' };
    await assert.rejects(s.service.checkout.prepare('prep-b', base), (e) => e.code === 'invalid_request');
    await assert.rejects(s.service.checkout.prepare('prep-b', { ...base, merchantOrigin: 'https://shop.example.com/cart' }), (e) => e.code === 'invalid_request');
    await assert.rejects(s.service.checkout.prepare('prep-b', { ...base, merchantOrigin: 'http://shop.example.com' }), (e) => e.code === 'invalid_request');
  });

  test('a repeated checkoutKey returns the same preparation, not a second approval', async () => {
    const s = makeService();
    await enrol(s, 'prep-c');
    const input = { merchant: 'Shop', amount: 500, currency: 'usd', psp: 'stripe', merchantOrigin: SHOP, checkoutKey: 'checkout-key-0001' };
    const a = await s.service.checkout.prepare('prep-c', input);
    const b = await s.service.checkout.prepare('prep-c', input);
    assert.equal(a.purchaseId, b.purchaseId);
  });

  test('refresh moves a preparation to ready, which is the signal to pay', async () => {
    const s = makeService();
    await enrol(s, 'prep-d');
    const r = await s.service.checkout.prepare('prep-d', { merchant: 'Shop', amount: 500, currency: 'usd', psp: 'stripe', merchantOrigin: SHOP });
    s.fake.setPreparation(r.purchaseId, { status: 'ready', ready_expires_at: '2030-01-01T00:00:30Z' });
    const ready = await s.service.checkout.refresh('prep-d', r.purchaseId);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.readyExpiresAt, '2030-01-01T00:00:30Z');
  });

  test('cancel stops an unapproved preparation; another user cannot touch it', async () => {
    const s = makeService();
    await enrol(s, 'prep-e');
    await enrol(s, 'prep-f');
    const r = await s.service.checkout.prepare('prep-e', { merchant: 'Shop', amount: 500, currency: 'usd', psp: 'stripe', merchantOrigin: SHOP });
    await assert.rejects(s.service.checkout.cancel('prep-f', r.purchaseId), (e) => e.code === 'not_found');
    const cancelled = await s.service.checkout.cancel('prep-e', r.purchaseId);
    assert.equal(cancelled.status, 'cancelled');
  });
});

describe('outcome reporting', () => {
  test('refused for an ordinary purchase; accepted only for an approved, uncharged-by-us purchase', async () => {
    const s = makeService();
    await enrol(s, 'out-a');
    const p = await s.service.checkout.request('out-a', { merchant: 'Shop', amount: 2306, currency: 'usd', psp: 'stripe', request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' } });
    s.fake.setAuthorization(p.purchaseId, { status: 'approved', charged_kind: 'captured' });
    await s.service.checkout.refresh('out-a', p.purchaseId);
    await assert.rejects(s.service.checkout.reportOutcome('out-a', p.purchaseId, { outcome: 'charged', amount: 2306, currency: 'usd' }), (e) => e.code === 'outcome_not_reportable');
  });

  test('a charge AgentCard did not see is reported and recorded', async () => {
    const s = makeService();
    await enrol(s, 'out-b');
    const p = await s.service.checkout.request('out-b', { merchant: 'Shop', amount: 2306, currency: 'usd', psp: 'stripe', request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' } });
    s.fake.setAuthorization(p.purchaseId, { status: 'approved', charged_kind: 'none' });
    await s.service.checkout.refresh('out-b', p.purchaseId);
    const r = await s.service.checkout.reportOutcome('out-b', p.purchaseId, { outcome: 'charged', amount: 2306, currency: 'usd', processorReference: 'ch_1' });
    assert.equal(r.outcome, 'charged');
    assert.equal(s.fake.outcomesFor(p.purchaseId).length, 1);
    assert.equal(s.fake.outcomesFor(p.purchaseId)[0].processor_reference, 'ch_1');
  });

  test('validates the outcome and its amounts before calling AgentCard', async () => {
    const s = makeService();
    await enrol(s, 'out-c');
    const p = await s.service.checkout.request('out-c', { merchant: 'Shop', amount: 100, currency: 'usd', psp: 'stripe', request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' } });
    s.fake.setAuthorization(p.purchaseId, { status: 'approved', charged_kind: 'none' });
    await s.service.checkout.refresh('out-c', p.purchaseId);
    await assert.rejects(s.service.checkout.reportOutcome('out-c', p.purchaseId, { outcome: 'paid' }), (e) => e.code === 'invalid_request');
    await assert.rejects(s.service.checkout.reportOutcome('out-c', p.purchaseId, { outcome: 'charged', amount: 100 }), (e) => e.code === 'invalid_request');
  });
});

describe('processors and vault link', () => {
  test('lists token processors, and separately those that need a prepared checkout', async () => {
    const s = makeService();
    const r = await s.service.account.processors();
    assert.deepEqual(r.processors, ['stripe']);
    assert.deepEqual(r.needsPreparation, ['aci']);
  });

  test('AgentCard sends the link for a connected user; an unknown user gets not_enrolled', async () => {
    const s = makeService();
    await assert.rejects(s.service.account.sendVaultLink('nobody'), (e) => e.code === 'not_enrolled');
    await enrol(s, 'link-a');
    assert.deepEqual(await s.service.account.sendVaultLink('link-a'), { sent: true, url: null });
  });
});

describe('disconnect and erase', () => {
  test('disconnect unlinks the user and keeps purchase history; a repeat is a no-op', async () => {
    const s = makeService();
    await enrol(s, 'dc-a');
    const p = await s.service.checkout.request('dc-a', { merchant: 'Shop', amount: 100, currency: 'usd', psp: 'stripe', request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' } });
    const r = await s.service.account.disconnect('dc-a');
    assert.deepEqual(r, { connected: false, pending: false });
    assert.equal(s.service.store.getAgentCardUser('dc-a'), null);
    assert.ok(s.service.store.getPurchase(p.purchaseId), 'purchase history is kept');
    assert.deepEqual(await s.service.account.disconnect('dc-a'), { connected: false, pending: false });
  });

  test('erase removes purchase history too', async () => {
    const s = makeService();
    await enrol(s, 'dc-b');
    const p = await s.service.checkout.request('dc-b', { merchant: 'Shop', amount: 100, currency: 'usd', psp: 'stripe', request: { url: 'https://api.stripe.com/v1/tokens', method: 'POST' } });
    const r = await s.service.account.erase('dc-b');
    assert.equal(r.erased, true);
    assert.equal(s.service.store.getPurchase(p.purchaseId), null);
  });
});

describe('spend presets', () => {
  test('cents become dollars and every rule is checked before it is sent', () => {
    assert.deepEqual(presetBodyFrom({ perDayCents: 5000, onlyMerchants: ['SHOP', 'ACME'], categories: ['travel'], timezone: 'Europe/London', onlyHours: '9-17', mode: 'strict' }), {
      per_day: 50, only_merchants: 'SHOP,ACME', categories: 'travel', timezone: 'Europe/London', only_hours: '9-17', mode: 'strict',
    });
    assert.throws(() => presetBodyFrom({}), (e) => e.code === 'invalid_request');
    assert.throws(() => presetBodyFrom({ perDayCents: 1.5 }), (e) => e.code === 'invalid_request');
    assert.throws(() => presetBodyFrom({ categories: ['casino'] }), (e) => e.code === 'invalid_request');
    assert.throws(() => presetBodyFrom({ timezone: 'Mars/Olympus' }), (e) => e.code === 'invalid_request');
    assert.throws(() => presetBodyFrom({ onlyHours: '25:00' }), (e) => e.code === 'invalid_request');
  });

  test('a user sets, lists, attaches and deletes their own presets; another user sees none of them', async () => {
    const s = makeService();
    await enrol(s, 'pre-a');
    await enrol(s, 'pre-b');
    const set = await s.service.account.setPreset('pre-a', 'daily', { perDayCents: 5000 });
    assert.equal(set.label, 'daily');
    assert.deepEqual((await s.service.account.listPresets('pre-a')).map((p) => p.label), ['daily']);
    assert.deepEqual(await s.service.account.listPresets('pre-b'), []);

    const cardId = s.service.store.getAgentCardUser('pre-a') && (await s.service.vault.listCards('pre-a')).cards[0].cardId;
    const attached = await s.service.account.attachPreset('pre-a', 'daily', cardId);
    assert.equal(attached.attachments.length, 1);

    await assert.rejects(s.service.account.attachPreset('pre-b', 'daily', cardId), (e) => e.code === 'card_not_found');
    assert.deepEqual(await s.service.account.deletePreset('pre-a', 'daily'), { label: 'daily', deleted: true });
  });

  test('preset names are namespaced by user, so two users never share a name', () => {
    assert.notEqual(presetNameFor('u1', 'daily'), presetNameFor('u2', 'daily'));
    assert.match(presetNameFor('u1', 'daily'), /^u[0-9a-f]{16}-daily$/);
  });
});

describe('paying on any site (interception)', () => {
  /** A Playwright-style page recording what the interception does to each request. */
  function fakePage() {
    const handlers = [];
    return {
      async route(pattern, handler) { handlers.push({ pattern, handler }); },
      async unroute(pattern, handler) { const i = handlers.findIndex((h) => h.handler === handler); if (i >= 0) handlers.splice(i, 1); },
      /** Send one request through the page's routes, as the browser would. Resolves when the route is settled. */
      async send({ url, method = 'POST', headers = { origin: SHOP }, body = '' }) {
        const outcome = { continued: false, fulfilled: null, aborted: null };
        const route = {
          request: () => ({ url: () => url, method: () => method, headers: () => headers, postData: () => body }),
          continue: async () => { outcome.continued = true; },
          fulfill: async (o) => { outcome.fulfilled = o; },
          abort: async (reason) => { outcome.aborted = reason ?? 'failed'; },
        };
        for (const h of handlers.slice()) await h.handler(route);
        return outcome;
      },
    };
  }

  const lastAuth = (s) => [...s.fake.state.authorizations.values()].pop();

  test('a request that is not a card request is left alone', async () => {
    const s = makeService();
    await enrol(s, 'pay-a');
    const page = fakePage();
    await s.service.attachPayment(page, { userId: 'pay-a', merchant: 'Shop', amount: 2306, currency: 'usd', checkoutOrigin: SHOP, onApprovalUrl: () => {} });
    const out = await page.send({ url: 'https://shop.example.com/cart', method: 'GET' });
    assert.equal(out.continued, true);
    assert.equal(s.fake.state.requests.filter((r) => r.path === '/api/v2/checkout/authorizations').length, 0);
  });

  test('a card request is paused; the approval link goes to the user; approval replays AgentCard’s response with CORS', async () => {
    let s;
    // Approval lands on the user’s device during the first wait between polls.
    s = makeService({
      sleep: async () => {
        const a = lastAuth(s);
        if (a && a.status === 'awaiting_approval') {
          s.fake.setAuthorization(a.id, { status: 'approved', charged_kind: 'captured', response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":"tok_1"}' } });
        }
      },
    });
    await enrol(s, 'pay-b');
    const page = fakePage();
    const links = [];
    await s.service.attachPayment(page, {
      userId: 'pay-b', merchant: 'Shop', amount: 2306, currency: 'usd', checkoutOrigin: SHOP,
      onApprovalUrl: (url) => links.push(url),
    });
    const out = await page.send({ url: 'https://api.stripe.com/v1/tokens', method: 'POST', body: 'card[number]=placeholder' });
    assert.match(links[0], /authorize\?id=cauth_/);
    assert.equal(out.continued, false);
    assert.equal(out.fulfilled.status, 200);
    assert.equal(out.fulfilled.body, '{"id":"tok_1"}');
    assert.equal(out.fulfilled.headers['content-type'], 'application/json');
    assert.equal(out.fulfilled.headers['access-control-allow-origin'], SHOP);
    assert.equal(out.fulfilled.headers['access-control-allow-credentials'], 'true');
    assert.equal(s.service.store.getPurchase(lastAuth(s).id).status, 'approved');
  });

  test('a declined authorization aborts the paused request, and nothing is sent on', async () => {
    let s;
    s = makeService({
      sleep: async () => {
        const a = lastAuth(s);
        if (a && a.status === 'awaiting_approval') s.fake.setAuthorization(a.id, { status: 'declined', reason: 'user_declined' });
      },
    });
    await enrol(s, 'pay-c');
    const page = fakePage();
    await s.service.attachPayment(page, { userId: 'pay-c', merchant: 'Shop', amount: 100, currency: 'usd', checkoutOrigin: SHOP, onApprovalUrl: () => {} });
    const out = await page.send({ url: 'https://api.stripe.com/v1/tokens', method: 'POST', body: 'card[number]=placeholder' });
    assert.equal(out.aborted, 'failed');
    assert.equal(out.fulfilled, null);
    assert.equal(out.continued, false);
  });

  test('a recognizer that needs a prepared checkout is refused, and nothing is sent to AgentCard', async () => {
    const s = makeService();
    await enrol(s, 'pay-d');
    const page = fakePage();
    await s.service.attachPayment(page, { userId: 'pay-d', merchant: 'Shop', amount: 100, currency: 'usd', checkoutOrigin: SHOP, onApprovalUrl: () => {} });
    const out = await page.send({ url: 'https://secure.aci.example/v1/checkouts/abc123', method: 'POST', body: '{}' });
    assert.equal(out.aborted, 'failed');
    assert.equal(s.fake.state.requests.filter((r) => r.path === '/api/v2/checkout/authorizations').length, 0);
  });

  test('a second card request while one is pending is blocked, so a page retry cannot charge twice', async () => {
    let s;
    // The first request waits; each wait is a real short pause so the second request can arrive mid-wait.
    s = makeService({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    await enrol(s, 'pay-e');
    const page = fakePage();
    const links = [];
    await s.service.attachPayment(page, { userId: 'pay-e', merchant: 'Shop', amount: 100, currency: 'usd', checkoutOrigin: SHOP, onApprovalUrl: (u) => links.push(u) });
    const first = page.send({ url: 'https://api.stripe.com/v1/tokens', method: 'POST', body: 'a=1' });
    await new Promise((r) => setTimeout(r, 30));
    const second = await page.send({ url: 'https://api.stripe.com/v1/tokens', method: 'POST', body: 'a=2' });
    assert.equal(second.aborted, 'failed');
    assert.equal(links.length, 1, 'only one approval link was issued');
    assert.equal(s.fake.state.requests.filter((r) => r.path === '/api/v2/checkout/authorizations').length, 1);
    // Close the first attempt so the test ends: the user declines.
    s.fake.setAuthorization(lastAuth(s).id, { status: 'declined', reason: 'user_declined' });
    await first;
  });

  test('an approval that never comes times out: the authorization is cancelled and the request aborted', async () => {
    let s;
    s = makeService({ sleep: async () => { s.advance(60_000); } });
    await enrol(s, 'pay-f');
    const page = fakePage();
    await s.service.attachPayment(page, { userId: 'pay-f', merchant: 'Shop', amount: 100, currency: 'usd', checkoutOrigin: SHOP, onApprovalUrl: () => {}, timeoutMs: 120_000 });
    const out = await page.send({ url: 'https://api.stripe.com/v1/tokens', method: 'POST', body: 'card[number]=placeholder' });
    assert.equal(out.aborted, 'timedout');
    assert.equal(lastAuth(s).status, 'declined', 'cancelled on AgentCard');
  });

  test('CORS headers echo the page origin only when there is one', () => {
    assert.deepEqual(corsHeaders(SHOP), { 'access-control-allow-origin': SHOP, 'access-control-allow-credentials': 'true' });
    assert.deepEqual(corsHeaders(undefined), {});
  });

  test('the registry keeps only entries with hosts and a match, as the SDK does', () => {
    const reg = toRegistry([
      { psp: 'stripe', match: 'api\\.stripe\\.com/v1/tokens', hosts: ['^api\\.stripe\\.com$'], passthroughHeaders: [] },
      { psp: 'x', match: 'a' },
      { merchant_profile: 'y', psp: 'z', match: 'b', hosts: [] },
    ]);
    assert.equal(reg.length, 1);
    assert.ok(reg[0].match instanceof RegExp);
  });
});
