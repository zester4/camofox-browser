import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { attachBrowserCheckout } from '../src/index.js';
import { makeService } from './helpers.js';

describe('browser checkout (SDK attachment)', () => {
  test('refuses without the required purchase fields', async () => {
    const client = { vault: {}, sdk: { attachToPlaywright: async () => 'attached' } };
    const ok = { agentcardUserId: 'usr_1', merchant: 'shop.example.com', amountCents: 2306, onApprovalUrl: () => {} };
    assert.equal(await attachBrowserCheckout(client, {}, ok), 'attached');
    await assert.rejects(attachBrowserCheckout(client, {}, { ...ok, agentcardUserId: '' }), /agentcardUserId/);
    await assert.rejects(attachBrowserCheckout(client, {}, { ...ok, merchant: '' }), /merchant/);
    await assert.rejects(attachBrowserCheckout(client, {}, { ...ok, amountCents: 0 }), /amountCents/);
    await assert.rejects(attachBrowserCheckout(client, {}, { ...ok, amountCents: 12.5 }), /amountCents/);
    await assert.rejects(attachBrowserCheckout(client, {}, { ...ok, onApprovalUrl: undefined }), /onApprovalUrl/);
  });

  test('the service refuses to attach for a user with no card', async () => {
    const s = makeService({ configOverrides: {} });
    await assert.rejects(
      s.service.attachBrowserCheckout({}, { userId: 'nobody', merchant: 'm', amountCents: 100, onApprovalUrl: () => {} }),
      (e) => e.code === 'not_enrolled',
    );
  });
});
