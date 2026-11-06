import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeService } from './helpers.js';

const POLL_OK = 3000; // the fake's poll_interval

async function enrol(s, userId) {
  const r = await s.service.vault.start(userId);
  return r;
}

describe('card check before any link', () => {
  test('a user with no vault (unknown to AgentCard) gets a link', async () => {
    const s = makeService();
    s.service.store.setAgentCardUser('ghost', 'usr_unknown_to_ac');
    const r = await enrol(s, 'ghost');
    assert.equal(r.status, 'link');
    assert.equal(r.purpose, 'enrol');
  });

  test('a user whose vault has no cards gets a link', async () => {
    const s = makeService();
    await linkedSession(s, 'empty-vault', 'usr_empty'); // vault exists, no cards
    const r = await enrol(s, 'empty-vault');
    assert.equal(r.status, 'link');
    assert.equal(r.purpose, 'enrol');
  });

  test('a user with a card on file is not sent a second link', async () => {
    const s = makeService();
    await linkedSession(s, 'carol', 'usr_carol');
    s.fake.addCard('usr_carol', { brand: 'visa', last4: '4242' });
    const r = await enrol(s, 'carol');
    assert.equal(r.status, 'has_card');
    assert.equal(r.cards.length, 1);
    assert.equal(r.cards[0].last4, '4242');
    assert.equal(s.fake.state.sessions.size, 1, 'only the first link was ever created');
  });
});

describe('minting a link', () => {
  test('the session carries our stable id as external_user_id, and no user_id', async () => {
    const s = makeService();
    const r = await enrol(s, 'dana');
    const created = s.fake.state.requests.find((q) => q.method === 'POST' && q.path === '/api/v2/vault_sessions');
    assert.equal(created.body.external_user_id, 'dana');
    assert.equal(created.body.user_id, undefined);
    assert.equal(created.body.steps, undefined);
    assert.match(r.url, /^https:\/\/vault\.agentcard\.sh\//);
  });

  test('the link is returned exactly as AgentCard gave it (not rewritten)', async () => {
    const s = makeService();
    const r = await enrol(s, 'erin');
    const remote = s.fake.state.sessions.get(r.sessionId);
    assert.ok(r.url.endsWith(`vs=${r.sessionId}.signature-${r.sessionId}`));
    assert.equal(remote.external_user_id, 'erin');
  });

  test('one pending link per person: a repeat request returns the same link', async () => {
    const s = makeService();
    const first = await enrol(s, 'frank');
    const second = await enrol(s, 'frank');
    assert.equal(second.reused, true);
    assert.equal(second.url, first.url);
    assert.equal(s.fake.state.sessions.size, 1);
  });

  test('an expired pending link is replaced by a new one', async () => {
    const s = makeService();
    const first = await enrol(s, 'gina');
    s.service.store.updateSession(first.sessionId, { expiresAt: '2020-01-01T00:00:00.000Z' });
    const second = await enrol(s, 'gina');
    assert.notEqual(second.sessionId, first.sessionId);
  });

  test('a user id is required', async () => {
    const s = makeService();
    await assert.rejects(s.service.vault.start(''), (e) => e.code === 'invalid_request');
  });
});

describe('adding another card', () => {
  test('mints with the same external_user_id and steps ["card"], and lands under the same user', async () => {
    const s = makeService();
    await linkedSession(s, 'hana', 'usr_hana');
    s.fake.addCard('usr_hana', { brand: 'visa', last4: '4242' });

    const another = await s.service.vault.start('hana', { addAnother: true });
    assert.equal(another.status, 'link');
    assert.equal(another.purpose, 'add_card');
    const minted = s.fake.state.requests.filter((q) => q.method === 'POST' && q.path === '/api/v2/vault_sessions').at(-1);
    assert.equal(minted.body.external_user_id, 'hana');
    assert.deepEqual(minted.body.steps, ['card']);

    // The user stores the second card. It lands under the same AgentCard user.
    s.fake.linkSession(another.sessionId, 'usr_hana');
    s.fake.addCard('usr_hana', { brand: 'mastercard', last4: '5555' });
    s.advance(POLL_OK);
    assert.equal((await s.service.vault.poll('hana', another.sessionId)).status, 'linked');
    assert.equal(s.service.store.getAgentCardUser('hana'), 'usr_hana');
    const { cards } = await s.service.vault.listCards('hana');
    assert.deepEqual(cards.map((c) => c.last4), ['5555', '4242']);
  });
});

describe('learning the user id', () => {
  test('polling records the AgentCard user id once the user links', async () => {
    const s = makeService();
    const { sessionId } = await enrol(s, 'ivan');
    assert.equal((await s.service.vault.poll('ivan', sessionId)).status, 'pending');
    s.fake.linkSession(sessionId, 'usr_ivan');
    s.advance(POLL_OK);
    assert.equal((await s.service.vault.poll('ivan', sessionId)).status, 'linked');
    assert.equal(s.service.store.getAgentCardUser('ivan'), 'usr_ivan');
  });

  test('vault.session_linked completes enrolment without polling', async () => {
    const s = makeService();
    const { sessionId } = await enrol(s, 'judy');
    s.fake.linkSession(sessionId, 'usr_judy');
    const res = await s.deliver({ id: 'evt_link_1', type: 'vault.session_linked', created: s.nowSeconds(), data: { vault_session_id: sessionId, user_id: 'usr_judy' } });
    assert.equal(res.status, 200);
    assert.equal(s.service.store.getAgentCardUser('judy'), 'usr_judy');
    assert.equal(s.service.store.getSession(sessionId).status, 'linked');
  });

  test('a restart that lost the session still links through external_user_id on the webhook', async () => {
    const s = makeService();
    const res = await s.deliver({
      id: 'evt_recover', type: 'vault.session_linked', created: s.nowSeconds(),
      data: { vault_session_id: 'vs_lost', user_id: 'usr_kim', external_user_id: 'kim' },
    });
    assert.equal(res.status, 200);
    assert.equal(s.service.store.getAgentCardUser('kim'), 'usr_kim');
  });

  test('an expired session is reported and never linked', async () => {
    const s = makeService();
    const { sessionId } = await enrol(s, 'leo');
    s.fake.expireSession(sessionId);
    s.advance(POLL_OK);
    assert.equal((await s.service.vault.poll('leo', sessionId)).status, 'expired');
    assert.equal(s.service.store.getAgentCardUser('leo'), null);
  });
});

describe('polling rules', () => {
  test('reads are spaced at least 1.5 seconds apart (the 40-per-minute budget)', async () => {
    const s = makeService();
    const { sessionId } = await enrol(s, 'mo');
    await s.service.vault.poll('mo', sessionId);
    const again = await s.service.vault.poll('mo', sessionId);
    assert.equal(again.status, 'pending');
    assert.ok(again.retryAfterMs > 0);
    const reads = () => s.fake.state.requests.filter((q) => q.path === `/api/v2/vault_sessions/${sessionId}`).length;
    assert.equal(reads(), 1);
    s.advance(POLL_OK);
    await s.service.vault.poll('mo', sessionId);
    assert.equal(reads(), 2);
  });

  test('only the owner can read a session', async () => {
    const s = makeService();
    const { sessionId } = await enrol(s, 'nina');
    await assert.rejects(s.service.vault.poll('someone-else', sessionId), (e) => e.code === 'not_found');
  });
});

describe('ownership safety', () => {
  test('two of our users cannot share one vault', async () => {
    const s = makeService();
    const a = await enrol(s, 'owen');
    s.fake.linkSession(a.sessionId, 'usr_shared');
    s.advance(POLL_OK);
    await s.service.vault.poll('owen', a.sessionId);

    const b = await enrol(s, 'paul');
    s.fake.linkSession(b.sessionId, 'usr_shared');
    s.advance(POLL_OK);
    const r = await s.service.vault.poll('paul', b.sessionId);
    assert.equal(r.status, 'conflict');
    assert.equal(s.service.store.getAgentCardUser('paul'), null);
    assert.equal(s.service.store.getAgentCardUser('owen'), 'usr_shared');
  });

  test('vault.card_stored is recorded as display fields and attributed when the user is known', async () => {
    const s = makeService();
    await linkedSession(s, 'quin', 'usr_quin');
    const res = await s.deliver({ id: 'evt_card_1', type: 'vault.card_stored', created: s.nowSeconds(), data: { card_id: 'vc_123', brand: 'visa', last4: '4242', user_id: 'usr_quin' } });
    assert.equal(res.status, 200);
    const [event] = s.service.store.listCardEvents();
    assert.equal(event.cardId, 'vc_123');
    assert.equal(event.userId, 'quin');
    assert.equal(event.last4, '4242');
    assert.ok(!JSON.stringify(event).includes('number'));
  });
});

/**
 * Helper: enrol a user and link the session in the fake, so the user has a vault
 * and our store knows the mapping. Returns the session id.
 */
async function linkedSession(s, userId, agentcardUserId = `usr_${userId}`) {
  const { sessionId } = await s.service.vault.start(userId);
  s.fake.linkSession(sessionId, agentcardUserId);
  s.advance(POLL_OK);
  await s.service.vault.poll(userId, sessionId);
  return sessionId;
}
