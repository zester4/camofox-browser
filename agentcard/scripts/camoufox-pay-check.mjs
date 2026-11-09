#!/usr/bin/env node
/**
 * Live check of payment on a Firefox engine (Camoufox), with no Chromium.
 *
 *   node agentcard/scripts/camoufox-pay-check.mjs --engine-only
 *   node agentcard/scripts/camoufox-pay-check.mjs --user camo-check     # full payment, sandbox
 *   node agentcard/scripts/camoufox-pay-check.mjs --user camo-check --add-card   # add a card on this device
 *
 * Needs the Camoufox binary: run `npm run fetch-bin` once (it downloads from GitHub).
 * --engine-only needs no AgentCard account. It checks that Firefox launches and that
 * a page's card request can be paused and answered, using a local form.
 *
 * Full mode (sandbox credentials in .env, values never printed):
 *   1. opens an enrolment link for the user (connect code 111111, test card 4242, passkey)
 *   2. waits until the card is stored
 *   3. serves a checkout form that posts to Stripe's token endpoint
 *   4. pauses that request and prints the approval link. Approve it on your device.
 *   5. checks the page receives AgentCard's answer, with a token and no card number
 *
 * Exit code is 0 only when every check that ran passed. Nothing sensitive is printed.
 */
import { createServer } from 'node:http';
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
const engineOnly = args.includes('--engine-only');
const userId = flag('--user') && flag('--user') !== true ? flag('--user') : 'camo-check';

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** Engine check only: a local form, never sent to a processor. */
const ENGINE_FORM = `<!doctype html><meta charset="utf-8"><title>Checkout check</title>
<form method="POST" action="https://api.stripe.com/v1/tokens">
  <input type="hidden" name="card[number]" value="4242424242424242">
  <input type="hidden" name="card[exp_month]" value="12">
  <input type="hidden" name="card[exp_year]" value="2030">
  <input type="hidden" name="card[cvc]" value="123">
  <button id="pay" type="submit">Pay</button>
</form>`;

/**
 * The checkout page for the full check. The agent types the processor's placeholder for the
 * stored card (vault.placeholderCard): its number, security code and the card's real expiry.
 * The page's card facts must match the card that pays, or the processor refuses the request.
 */
function checkoutHtml(card, publishableKey) {
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  // The store's own page sends the publishable key with its token request; this page sends it when set.
  const keyField = /^pk_(test|live)_[A-Za-z0-9]+$/.test(publishableKey ?? '') ? `<input type="hidden" name="key" value="${publishableKey}">` : '';
  return `<!doctype html><meta charset="utf-8"><title>Checkout check</title>
<form method="POST" action="https://api.stripe.com/v1/tokens">
  ${keyField}
  <input type="hidden" name="card[number]" value="${digits(card.number)}">
  <input type="hidden" name="card[exp_month]" value="${digits(card.expiryMonth)}">
  <input type="hidden" name="card[exp_year]" value="${digits(card.expiryYear)}">
  <input type="hidden" name="card[cvc]" value="${digits(card.securityCode)}">
  <button id="pay" type="submit">Pay</button>
</form>`;
}

function serveFixture(html = ENGINE_FORM) {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

async function launchFirefox() {
  // Same path the server uses: camoufox-js builds the options, playwright-core's firefox launches them.
  const options = await launchOptions({ headless: true });
  options.handleSIGTERM = false;
  options.handleSIGINT = false;
  options.handleSIGHUP = false;
  return firefox.launch(options);
}

async function engineCheck() {
  const fixture = await serveFixture();
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  let browser;
  try {
    browser = await launchFirefox();
    check('Firefox (Camoufox) launches', true, `version ${browser.version()}`);
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    check('checkout page loads in Firefox', (await page.title()) === 'Checkout check');

    // Pause a request to a fake processor, answer it ourselves, and check the page sees the answer.
    let paused = 0;
    await page.route('https://api.stripe.com/**', async (route) => {
      paused += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"tok_engine_check"}' });
    });
    await page.evaluate(() => {
      document.querySelector('form').action = 'https://api.stripe.com/v1/tokens';
      document.querySelector('form').submit();
    });
    await page.waitForURL('https://api.stripe.com/**', { timeout: 15000 }).catch(() => {});
    const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    check('a page request to the processor is paused and answered', paused === 1 && body.includes('tok_engine_check'), `paused ${paused}`);
    await browser.close();
  } catch (err) {
    check('Firefox engine check', false, err.message);
  } finally {
    fixture.close();
    if (browser) await browser.close().catch(() => {});
  }
}

async function fullCheck() {
  const clientId = process.env.AGENTCARD_CLIENT_ID?.trim();
  const clientSecret = process.env.AGENTCARD_CLIENT_SECRET?.trim();
  check('sandbox credentials present', Boolean(clientId && clientSecret));
  if (!clientId || !clientSecret) return;

  const service = createAgentCardService({
    config: { clientId, clientSecret, baseUrl: process.env.AGENTCARD_BASE_URL },
    stateFile: null,
    log: (level, msg, fields) => { if (level !== 'debug') console.log(`      log ${level}: ${msg}`); },
  });

  // --add-card: store another card on THIS device. Approval needs the card on the device that approves.
  if (args.includes('--add-card')) {
    const added = await service.vault.start(userId, { addAnother: true });
    if (added.status !== 'link') {
      check('add a card link', false, `status ${added.status}`);
      return;
    }
    console.log(`      open this link ON THIS DEVICE, connect code 111111, add the test card with your passkey:\n      ${added.url}`);
    const before = (await service.vault.listCards(userId)).cards.length;
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const status = await service.vault.poll(userId, added.sessionId);
      if (status.status === 'linked') break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const after = (await service.vault.listCards(userId)).cards.length;
    check('card added to the vault', after > before, `${after} card(s)`);
    return;
  }

  // 1-2. Enrol the user and wait for the card. The connect code is 111111 in sandbox.
  const started = await service.vault.start(userId);
  if (started.status === 'link') {
    const { sessionId, url } = started;
    console.log(`      open this link, connect code 111111, store the test card with your passkey:\n      ${url}`);
    const deadline = Date.now() + 10 * 60_000;
    let linked = false;
    while (Date.now() < deadline) {
      const status = await service.vault.poll(userId, sessionId);
      if (status.status === 'linked') { linked = true; break; }
      await new Promise((r) => setTimeout(r, 3000));
    }
    check('user links a sandbox card', linked);
    if (!linked) return;
  }
  const cards = await service.vault.listCards(userId);
  check('card on file for the user', cards.enrolled && cards.cards.length > 0, `${cards.cards.length} card(s)`);
  if (!cards.enrolled || cards.cards.length === 0) return;

  // 3. The processor's placeholder for the stored card that pays. The page must show these facts.
  const cardId = cards.cards[0].cardId;
  let placeholder;
  try {
    placeholder = await service.placeholders.get(userId, cardId);
  } catch (err) {
    check('placeholder for the stored card', false, err.code ?? err.message);
    return;
  }
  check('placeholder for the stored card', Boolean(placeholder?.number && placeholder?.securityCode));

  // 4-5. Pay on the Firefox page with the placeholder card, as the integration doc describes.
  const fixture = await serveFixture(checkoutHtml(placeholder, process.env.STRIPE_PUBLISHABLE_KEY?.trim()));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  let browser;
  try {
    browser = await launchFirefox();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    let approvalUrl = null;
    const handle = await service.attachPayment(page, {
      userId,
      cardId,
      merchant: 'Chusky payment check',
      amount: 100,
      currency: 'usd',
      checkoutOrigin: 'https://shop.example.com',
      timeoutMs: 10 * 60_000,
      onApprovalUrl: (u) => {
        approvalUrl = u;
        console.log(`      approve this on your device (passkey): ${u}`);
      },
    });
    check('payment armed on the Firefox page', Boolean(handle));

    await page.evaluate(() => document.querySelector('form').submit());
    const waitUntil = Date.now() + 10 * 60_000;
    while (!approvalUrl && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 500));
    check('card request paused and approval link issued', Boolean(approvalUrl));

    await page.waitForURL('https://api.stripe.com/**', { timeout: 10 * 60_000 }).catch(() => {});
    const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const got = body.includes('"id"') && /tok_/.test(body);
    check('page receives AgentCard\'s answer after approval', got, got ? 'token returned' : 'no token seen');
    check('no full card number appears on the page', !/\b\d{13,19}\b/.test(body));
    if (!got) {
      // Show the processor's answer with digits and tokens masked, so the reason is visible without secrets.
      const shown = body.replace(/\d{6,}/g, '#').replace(/tok_\w+/g, 'tok_[redacted]').slice(0, 300);
      console.log(`      page says: ${shown.replace(/\s+/g, ' ').trim() || '(empty)'}`);
      const outcome = typeof handle.results === 'function' ? handle.results() : [];
      const redact = (k, v) => (typeof v === 'string' && (v.length > 80 || /tok_|\d{12,}/.test(v)) ? '[redacted]' : v);
      console.log(`      purchase outcome: ${JSON.stringify(outcome, redact)}`);
    }
    await handle.detach();
  } catch (err) {
    check('full payment check', false, err.message);
  } finally {
    fixture.close();
    if (browser) await browser.close().catch(() => {});
    service.flush();
  }
}

if (engineOnly) await engineCheck();
else await fullCheck();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed${failures ? `, ${failures} failed` : ''}`);
process.exit(failures ? 1 : 0);
