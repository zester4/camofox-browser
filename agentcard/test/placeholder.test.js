import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceholders } from '../src/placeholder.js';

const CONFIG = { clientId: 'id_test', clientSecret: 'secret_test', baseUrl: 'https://api.agentcard.test' };
const store = { getAgentCardUser: (userId) => ({ 'user-1': 'usr_abc', 'user-2': 'usr_def' })[userId] ?? null };

/** A stand-in for the SDK's VaultClient. Records what it was asked, and answers as the SDK would. */
function fakeVault(answer) {
  const calls = [];
  class VaultClient {
    constructor(options) { this.options = options; }
    async placeholderCard(input) {
      calls.push(input);
      if (answer instanceof Error) throw answer;
      return answer;
    }
  }
  return { VaultClient, calls };
}

const CARD = {
  cardId: 'vc_1',
  brand: 'visa',
  number: '4111111111111111',
  securityCode: '123',
  expiryMonth: '12',
  expiryYear: '2030',
};

function placeholdersWith(answer) {
  const fake = fakeVault(answer);
  const p = createPlaceholders({ config: CONFIG, store, ensureConfigured: () => {}, VaultClient: fake.VaultClient });
  return { p, calls: fake.calls, fake };
}

describe('placeholder for a stored card', () => {
  test('asks the SDK with AgentCard’s user id, not our external id', async () => {
    const { p, calls } = placeholdersWith(CARD);
    await p.get('user-1');
    assert.equal(calls[0].user, 'usr_abc');
    assert.equal(calls[0].cardId, undefined, 'no card id means the first card on file');
  });

  test('a card id is passed through, so the page and the approval use the same card', async () => {
    const { p, calls } = placeholdersWith(CARD);
    const out = await p.get('user-1', ' vc_1 ');
    assert.equal(calls[0].cardId, 'vc_1');
    assert.equal(out.cardId, 'vc_1');
  });

  test('returns exactly the fields the agent types, and nothing else', async () => {
    const { p } = placeholdersWith({ ...CARD, extra: 'nope' });
    const out = await p.get('user-1');
    assert.deepEqual(Object.keys(out).sort(), ['brand', 'cardId', 'expiryMonth', 'expiryYear', 'number', 'securityCode']);
  });

  test('a user with no card on file is refused before any call', async () => {
    const { p, calls } = placeholdersWith(CARD);
    await assert.rejects(p.get('user-nobody'), (e) => e.code === 'not_enrolled');
    assert.equal(calls.length, 0);
  });

  test('the SDK client is built once with the company credentials and base URL', async () => {
    const { p, fake } = placeholdersWith(CARD);
    await p.get('user-1');
    await p.get('user-2');
    assert.equal(fake.calls.length, 2);
  });

  test('an unknown card is a card_not_found error', async () => {
    const err = Object.assign(new Error('x'), { reason: 'card_not_found' });
    const { p } = placeholdersWith(err);
    await assert.rejects(p.get('user-1', 'vc_missing'), (e) => e.code === 'card_not_found');
  });

  test('a network with no placeholder, or an unknown expiry, is placeholder_unavailable', async () => {
    for (const reason of ['brand_unsupported', 'expiry_unknown']) {
      const { p } = placeholdersWith(Object.assign(new Error('x'), { reason }));
      await assert.rejects(p.get('user-1'), (e) => e.code === 'placeholder_unavailable', reason);
    }
  });

  test('other errors pass through unchanged', async () => {
    const { p } = placeholdersWith(new Error('network down'));
    await assert.rejects(p.get('user-1'), (e) => e.message === 'network down' && e.code === undefined);
  });

  test('bad input is refused before any call', async () => {
    const { p, calls } = placeholdersWith(CARD);
    await assert.rejects(p.get(''), (e) => e.code === 'invalid_request');
    await assert.rejects(p.get('user-1', 'x'.repeat(129)), (e) => e.code === 'invalid_request');
    await assert.rejects(p.get('user-1', '   '), (e) => e.code === 'invalid_request');
    assert.equal(calls.length, 0);
  });
});
