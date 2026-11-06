import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { loadConfig, requireCredentials, describeConfig, verifyWebhookSignature, createAgentCardApi, AgentCardError, createMemoryStore, toDisplayCard, EVENT_STATUS } from '../src/index.js';
import { createFakeAgentCard, FAKE_CLIENT } from './fake-agentcard.js';

// ---------- configuration ----------

describe('configuration', () => {
  test('reads only the values it is given, with the default base URL', () => {
    const config = loadConfig({ clientId: ' id_1 ', clientSecret: 'sec_1', webhookSecret: '' });
    assert.equal(config.clientId, 'id_1');
    assert.equal(config.webhookSecret, null);
    assert.equal(config.baseUrl, 'https://api.agentcard.sh');
  });

  test('accepts the environment variable names too (for scripts)', () => {
    const config = loadConfig({ AGENTCARD_CLIENT_ID: 'a', AGENTCARD_CLIENT_SECRET: 'b', AGENTCARD_WEBHOOK_SECRET: 'whsec_x' });
    assert.equal(config.clientSecret, 'b');
    assert.equal(config.webhookSecret, 'whsec_x');
  });

  test('names missing variables and never reveals values', () => {
    assert.throws(() => requireCredentials(loadConfig({})), (err) => {
      assert.equal(err.code, 'not_configured');
      assert.match(err.message, /AGENTCARD_CLIENT_ID, AGENTCARD_CLIENT_SECRET/);
      return true;
    });
    const summary = JSON.stringify(describeConfig(loadConfig({ clientId: 'id_abc', clientSecret: 'sec_xyz' })));
    assert.ok(!summary.includes('id_abc') && !summary.includes('sec_xyz'));
  });
});

// ---------- webhook signature ----------

describe('webhook signature', () => {
  const SECRET = 'whsec_unit';
  const NOW = 1757264400;
  const sign = (body, t = NOW, secret = SECRET) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

  test('accepts a correct signature and rejects tampering, wrong secret, replay, junk', () => {
    const body = '{"id":"evt_1"}';
    assert.equal(verifyWebhookSignature({ header: sign(body), rawBody: body, secret: SECRET, now: NOW }), true);
    assert.equal(verifyWebhookSignature({ header: sign(body), rawBody: '{"id":"x"}', secret: SECRET, now: NOW }), false);
    assert.equal(verifyWebhookSignature({ header: sign(body, NOW, 'other'), rawBody: body, secret: SECRET, now: NOW }), false);
    assert.equal(verifyWebhookSignature({ header: sign(body, NOW - 301), rawBody: body, secret: SECRET, now: NOW }), false);
    assert.equal(verifyWebhookSignature({ header: undefined, rawBody: body, secret: SECRET, now: NOW }), false);
    assert.equal(verifyWebhookSignature({ header: 'garbage', rawBody: body, secret: SECRET, now: NOW }), false);
  });
});

// ---------- API client ----------

describe('API client', () => {
  const creds = { clientId: FAKE_CLIENT.id, clientSecret: FAKE_CLIENT.secret };

  test('exchanges one token and reuses it until shortly before expiry', async () => {
    const fake = createFakeAgentCard({ tokenLifetimeSeconds: 3600 });
    let clock = 0;
    const api = createAgentCardApi({ ...creds, fetchImpl: fake.fetch, now: () => clock, sleep: async () => {} });
    await api.listVaultCards('usr_none').catch(() => {});
    await api.listVaultCards('usr_none').catch(() => {});
    assert.equal(fake.state.tokenRequests, 1);
    clock = 3600_000 - 30_000;
    await api.listVaultCards('usr_none').catch(() => {});
    assert.equal(fake.state.tokenRequests, 2);
  });

  test('concurrent first calls share one token exchange', async () => {
    const fake = createFakeAgentCard();
    const api = createAgentCardApi({ ...creds, fetchImpl: fake.fetch, sleep: async () => {} });
    await Promise.all(['a', 'b', 'c'].map((u) => api.listVaultCards(u).catch(() => {})));
    assert.equal(fake.state.tokenRequests, 1);
  });

  test('bad credentials raise an error that contains no secret', async () => {
    const fake = createFakeAgentCard();
    const api = createAgentCardApi({ clientId: FAKE_CLIENT.id, clientSecret: 'wrong_secret_value', fetchImpl: fake.fetch, sleep: async () => {} });
    await assert.rejects(api.listVaultCards('u'), (err) => {
      assert.ok(err instanceof AgentCardError);
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes('wrong_secret_value'));
      return true;
    });
  });

  test('retries 429 and succeeds', async () => {
    const fake = createFakeAgentCard();
    fake.queue((m, p) => m === 'GET' && p === '/api/v2/vault_cards', () => new Response('{}', { status: 429 }));
    const api = createAgentCardApi({ ...creds, fetchImpl: fake.fetch, sleep: async () => {} });
    const body = await api.listVaultCards('usr_none').catch((e) => e);
    assert.equal(body.status, 404); // the 429 was retried, then the real answer came back
  });

  test('a 400 slow_down on a read waits the server interval once', async () => {
    const fake = createFakeAgentCard();
    const waits = [];
    fake.queue((m, p) => m === 'GET' && p.startsWith('/api/v2/checkout/authorizations/'), () =>
      new Response('{"error":{"code":"slow_down"},"interval":2}', { status: 400, headers: { 'content-type': 'application/json' } }));
    const api = createAgentCardApi({ ...creds, fetchImpl: fake.fetch, sleep: async (ms) => waits.push(ms) });
    await assert.rejects(api.getAuthorization('cauth_missing'), (err) => err.status === 404);
    assert.deepEqual(waits, [2000]);
  });

  test('exhausted 5xx is reported as retryable', async () => {
    const fake = createFakeAgentCard();
    for (let i = 0; i < 5; i += 1) fake.queue((m, p) => m === 'GET' && p === '/api/v2/vault_cards', () => new Response('{}', { status: 503 }));
    const api = createAgentCardApi({ ...creds, fetchImpl: fake.fetch, sleep: async () => {}, maxRetries: 2 });
    await assert.rejects(api.listVaultCards('u'), (err) => err.status === 503 && err.retryable === true);
  });
});

// ---------- display mapping and vocabulary ----------

describe('display and vocabulary', () => {
  test('a card is reduced to display fields only', () => {
    const shaped = toDisplayCard({ id: 'vc_1', brand: 'visa', last4: '4242', expiry_month: 12, expiry_year: 2030, created_at: 'x', number: '4242424242424242', cvc: '123' });
    assert.deepEqual(Object.keys(shaped).sort(), ['brand', 'cardId', 'createdAt', 'expiryMonth', 'expiryYear', 'last4']);
    assert.ok(!JSON.stringify(shaped).includes('4242424242424242'));
  });

  test('every documented checkout status maps to our status', () => {
    assert.equal(EVENT_STATUS.submitted, 'submitted_on_device');
    assert.equal(EVENT_STATUS.amount_mismatch, 'declined');
    assert.equal(EVENT_STATUS.settlement_unconfirmed, 'not_settled');
  });

  test('the memory store keeps no references to what it was given', () => {
    const store = createMemoryStore();
    const rec = { id: 'x', status: 'a' };
    store.putPurchase(rec);
    rec.status = 'changed';
    assert.equal(store.getPurchase('x').status, 'a');
  });
});
