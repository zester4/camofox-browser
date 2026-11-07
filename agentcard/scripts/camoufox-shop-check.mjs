#!/usr/bin/env node
/**
 * Live check against the demo store (https://shop.agentcard.sh), on a Firefox engine (Camoufox).
 * Test mode on Stripe. Per the integration doc: buy an item, the agent submits a placeholder card,
 * the user approves on their device, the processor's answer replays into the page.
 *
 *   node agentcard/scripts/camoufox-shop-check.mjs --user camo-check
 *
 * Needs the Camoufox binary (`npm run fetch-bin`) and sandbox credentials in .env. No Stripe account.
 * Steps print what they find on the page. If a step cannot find its element, the page's buttons and
 * fields are printed, so the selectors here can be corrected from real output.
 *
 * Exit code is 0 only when every check that ran passed. Card numbers and tokens are never printed.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { firefox } from 'playwright-core';
import { Camoufox, launchOptions } from 'camoufox-js';
import { createAgentCardService } from '../src/index.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) loadEnvFile(ENV_PATH);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? true : null;
};
const userId = flag('--user') && flag('--user') !== true ? flag('--user') : 'camo-check';
const STORE = 'https://shop.agentcard.sh/';
const MERCHANT = 'shop.agentcard.sh';
const ITEM_PRICE_CENTS = 583; // Enamel Camp Mug, $5.83. Must match the store's price.

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** Prints the page's buttons, fields and frames, so a missing selector can be fixed from real output. */
async function dumpPage(page, label) {
  const frames = page.frames().map((f) => f.url().slice(0, 100));
  const info = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('button, a, [role=button]')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 25),
    fields: [...document.querySelectorAll('input, select, textarea')].map((i) => `${i.tagName} name=${i.name} id=${i.id} autocomplete=${i.autocomplete}`).slice(0, 25),
  })).catch(() => ({}));
  console.log(`      [${label}] ${JSON.stringify({ ...info, frames })}`);
}

async function launchFirefox() {
  const options = await launchOptions({ headless: true });
  options.handleSIGTERM = false;
  options.handleSIGINT = false;
  options.handleSIGHUP = false;
  return firefox.launch(options);
}

/** Finds the first field matching any selector, in the page or any of its frames (Stripe Elements uses frames). */
async function fillFirst(page, selectors, value) {
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      if (await loc.count().catch(() => 0)) {
        await loc.fill(value);
        return true;
      }
    }
  }
  return false;
}

async function main() {
  const clientId = process.env.AGENTCARD_CLIENT_ID?.trim();
  const clientSecret = process.env.AGENTCARD_CLIENT_SECRET?.trim();
  check('sandbox credentials present', Boolean(clientId && clientSecret));
  if (!clientId || !clientSecret) return;

  const service = createAgentCardService({
    config: { clientId, clientSecret, baseUrl: process.env.AGENTCARD_BASE_URL },
    stateFile: null,
    log: (level, msg) => { if (level !== 'debug') console.log(`      log ${level}: ${msg}`); },
  });

  // Card on file: enrol if needed.
  const started = await service.vault.start(userId);
  if (started.status === 'link') {
    console.log(`      open this link, connect code 111111, store the test card with your passkey:\n      ${started.url}`);
    const deadline = Date.now() + 10 * 60_000;
    let linked = false;
    while (Date.now() < deadline) {
      const status = await service.vault.poll(userId, started.sessionId);
      if (status.status === 'linked') { linked = true; break; }
      await new Promise((r) => setTimeout(r, 3000));
    }
    check('user links a sandbox card', linked);
    if (!linked) return;
  }
  const cards = await service.vault.listCards(userId);
  check('card on file for the user', cards.enrolled && cards.cards.length > 0, `${cards.cards.length} card(s)`);
  if (!cards.enrolled || cards.cards.length === 0) return;

  // The placeholder for the card that pays: the test number, CVC and real expiry the page types.
  const cardId = cards.cards[0].cardId;
  let card;
  try {
    card = await service.placeholders.get(userId, cardId);
  } catch (err) {
    check('placeholder for the stored card', false, err.code ?? err.message);
    return;
  }
  check('placeholder for the stored card', Boolean(card?.number && card?.securityCode));

  let browser;
  try {
    browser = await launchFirefox();
    check('Firefox (Camoufox) launches', true, `version ${browser.version()}`);
    const page = await browser.newPage();
    // Field NAMES of the processor requests the store's own page sends (never the values), so the
    // fixture page can send the same fields.
    page.on('request', (r) => {
      if (!/api\.stripe\.com/.test(r.url())) return;
      const keys = [...new URLSearchParams(r.postData() ?? '').keys()];
      console.log(`      store sends ${r.method()} ${new URL(r.url()).pathname} with fields: ${keys.join(', ') || '(none)'}`);
      // The publishable key is public (every visitor's browser has it). Printed so the fixture can send it.
      const pk = new URLSearchParams(r.postData() ?? '').get('key');
      if (pk && /^pk_(test|live)_/.test(pk)) console.log(`      store publishable key (public, not a secret): ${pk}\n      add it to .env as STRIPE_PUBLISHABLE_KEY=${pk}`);
    });
    await page.goto(STORE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    check('demo store loads', (await page.locator('body').count()) > 0);

    // Arm the payment before the card is typed, as the doc orders it.
    const handle = await service.attachPayment(page, {
      userId,
      cardId,
      merchant: MERCHANT,
      amount: ITEM_PRICE_CENTS,
      currency: 'usd',
      checkoutOrigin: 'https://shop.agentcard.sh',
      timeoutMs: 10 * 60_000,
      onApprovalUrl: (u) => console.log(`      approve this on your device (passkey): ${u}`),
    });
    check('payment armed on the store page', Boolean(handle));

    // 1. Buy the mug.
    const buy = page.getByRole('button', { name: /buy now/i }).first();
    const bought = await buy.click({ timeout: 15_000 }).then(() => true).catch(() => false);
    check('clicked "Buy now" on the mug', bought);
    if (!bought) await dumpPage(page, 'store');

    // 2. Type the placeholder card into the page's card fields (in the page or its frames).
    await page.waitForTimeout(3000);
    const numberOk = await fillFirst(page, ['input[autocomplete="cc-number"]', 'input[name="cardnumber"]', 'input[name="card-number"]', 'input[name="number"]'], String(card.number));
    check('typed the placeholder card number', numberOk);
    if (!numberOk) await dumpPage(page, 'card form');
    const expiryOk = await fillFirst(page, ['input[autocomplete="cc-exp"]', 'input[name="exp-date"]', 'input[name="expiry"]'], `${card.expiryMonth}/${String(card.expiryYear).slice(-2)}`);
    check('typed the expiry', expiryOk);
    const cvcOk = await fillFirst(page, ['input[autocomplete="cc-csc"]', 'input[name="cvc"]', 'input[name="cvv"]'], String(card.securityCode));
    check('typed the security code', cvcOk);

    // 3. Submit. The card request pauses here, and the approval link is issued.
    const pay = page.getByRole('button', { name: /pay|place order|submit|buy/i }).last();
    const paid = await pay.click({ timeout: 15_000 }).then(() => true).catch(() => false);
    check('clicked the pay button', paid);
    if (!paid) await dumpPage(page, 'pay');

    // 4. Wait for the user's approval and the processor's answer, then read the purchase outcome.
    const deadline = Date.now() + 10 * 60_000;
    let outcome = null;
    while (Date.now() < deadline) {
      const results = handle.results?.() ?? [];
      outcome = results.find((r) => r.status && r.status !== 'pending') ?? null;
      if (outcome) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const redact = (k, v) => (typeof v === 'string' && (v.length > 80 || /tok_|\d{12,}/.test(v)) ? '[redacted]' : v);
    console.log(`      purchase outcome: ${JSON.stringify(outcome, redact)}`);
    check('processor approved the purchase', outcome?.status === 'approved' || outcome?.status === 'settled' || outcome?.status === 'charged', outcome?.status ?? 'no outcome');

    // 5. The merchant's own confirmation: what the page shows after the payment.
    await page.waitForTimeout(2000);
    const text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).replace(/\d{6,}/g, '#').replace(/tok_\w+/g, 'tok_[redacted]');
    check('store shows an order confirmation', /order|thank|confirm|received/i.test(text), text.replace(/\s+/g, ' ').slice(0, 160));

    await handle.detach();
  } catch (err) {
    check('store payment check', false, err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    service.flush();
  }
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('Check stopped:', err.message);
    process.exit(1);
  });
