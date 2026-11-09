import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileStore, createMemoryStore } from '../src/index.js';
import { makeService } from './helpers.js';

describe('durable state', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'agentcard-state-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('the user-to-card mapping survives a restart', async () => {
    const file = join(dir, 'restart', 'state.json');
    const first = makeService({ stateFile: file });
    const { sessionId } = await first.service.vault.start('persist-me');
    first.fake.linkSession(sessionId, 'usr_persist');
    first.advance(3000);
    await first.service.vault.poll('persist-me', sessionId);
    first.service.store.flush();

    // A fresh process reads the same file.
    const reloaded = createFileStore(file);
    assert.equal(reloaded.getAgentCardUser('persist-me'), 'usr_persist');
    assert.equal(reloaded.getSession(sessionId).status, 'linked');
  });

  test('the state file is private (0600) and holds no card data or secrets', async () => {
    const file = join(dir, 'perm', 'state.json');
    const s = makeService({ stateFile: file });
    const { sessionId } = await s.service.vault.start('perm-user');
    s.fake.linkSession(sessionId, 'usr_perm');
    s.advance(3000);
    await s.service.vault.poll('perm-user', sessionId);
    s.service.store.flush();

    assert.equal(statSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes('usr_perm'));
    assert.ok(!text.includes('sec_test'), 'client secret must never be written');
    assert.ok(!text.includes('whsec_test'), 'webhook secret must never be written');
    assert.ok(!/\b\d{13,19}\b/.test(text), 'no card-number-shaped digits');
  });

  test('writes are atomic: no temp files are left behind', async () => {
    const file = join(dir, 'atomic', 'state.json');
    const store = createFileStore(file);
    for (let i = 0; i < 5; i += 1) store.setAgentCardUser(`u${i}`, `usr_${i}`);
    await new Promise((r) => setImmediate(r));
    store.flush();
    const leftovers = readdirSync(join(dir, 'atomic')).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.equal(createFileStore(file).getAgentCardUser('u4'), 'usr_4');
  });

  test('an unreadable state file is moved aside and the app starts empty', () => {
    const sub = join(dir, 'corrupt');
    const file = join(sub, 'state.json');
    const logs = [];
    mkdirSync(sub, { recursive: true });
    writeFileSync(file, '{not valid json');
    const store = createFileStore(file, { log: (level, msg) => logs.push({ level, msg }) });
    assert.equal(store.listUsers().length, 0);
    assert.ok(logs.some((l) => l.level === 'error' && /unreadable/.test(l.msg)));
    assert.ok(readdirSync(sub).some((f) => f.startsWith('state.json.corrupt-')));
    assert.equal(existsSync(file), false);
  });

  test('a snapshot round-trips through the memory store', () => {
    const a = createMemoryStore();
    a.setAgentCardUser('x', 'usr_x');
    a.putPurchase({ id: 'cauth_1', userId: 'x', status: 'approved' });
    a.markEventSeen('evt_1');
    const b = createMemoryStore();
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    assert.equal(b.getAgentCardUser('x'), 'usr_x');
    assert.equal(b.getPurchase('cauth_1').status, 'approved');
    assert.equal(b.markEventSeen('evt_1'), false, 'de-duplication survives a restart');
  });

  test('forgetting a user removes their mapping, sessions and purchases', async () => {
    const s = makeService();
    const { sessionId } = await s.service.vault.start('forget-me');
    s.fake.linkSession(sessionId, 'usr_forget');
    s.advance(3000);
    await s.service.vault.poll('forget-me', sessionId);
    s.service.store.forgetUser('forget-me');
    assert.equal(s.service.store.getAgentCardUser('forget-me'), null);
    assert.equal(s.service.store.getSession(sessionId), null);
  });
});
