/**
 * Login handoff, end to end, against a running Chusky server.
 *
 * The agent reaches a login page and hands the tab to the person. The person signs in through the
 * live viewer (clicks and typing only). They press Done. The agent then continues in the same tab,
 * still signed in, and can act again.
 *
 * Usage (reads CHUSKY_BASE_URL and CHUSKY_ACCESS_KEY from the environment or .env):
 *   node scripts/test-handoff-login.mjs
 *
 * The test starts its own login site on 127.0.0.1, so the server must be able to reach localhost.
 * If the server runs on another machine, set LOGIN_SITE_HOST to an address that machine can reach.
 *
 * Checks:
 *   - the agent is blocked while the person holds the tab (409)
 *   - the person's clicks and typing reach the login page
 *   - the person's sign-in is accepted by the site and sets a session cookie
 *   - after Done, the agent sees the signed-in page in the same tab
 *   - a fresh navigation in the same tab is still signed in (the session was kept)
 *   - the agent can act again after Done
 *
 * The password is typed but never printed.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const BASE = (process.env.CHUSKY_BASE_URL || '').trim().replace(/\/+$/, '');
const ACCESS_KEY = (process.env.CHUSKY_ACCESS_KEY || process.env.CHUSKY_API_KEY || '').trim();
const LOGIN_HOST = (process.env.LOGIN_SITE_HOST || '127.0.0.1').trim();
if (!BASE) throw new Error('Missing CHUSKY_BASE_URL (set it in .env or the environment).');
if (!ACCESS_KEY) throw new Error('Missing CHUSKY_ACCESS_KEY (set it in .env or the environment).');

const userId = `login-test-${randomUUID()}`;
const sessionKey = `login-${randomUUID()}`;
const USERNAME = 'tester@example.com';
const PASSWORD = `pw-${randomUUID()}`; // typed by the person, never printed
const SESSION_VALUE = randomUUID();

let tabId = null;
let failures = 0;
let loginSite = null;
let siteUrl = '';
const siteState = { loginAccepted: 0, lastCookieOk: false, attempts: [], events: [] };

function check(name, ok, detail = '') {
  if (ok) console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` (${detail})` : ''}`);
  }
}

// A small login site: /login shows a form, /account shows the signed-in page when the session cookie is set.
function startLoginSite() {
  return new Promise((resolveSite, rejectSite) => {
    const server = createServer(async (req, res) => {
      const cookie = req.headers.cookie || '';
      const signedIn = cookie.includes(`session=${SESSION_VALUE}`);
      if (req.method === 'POST' && req.url === '/login') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        // What the site received, without the password itself: whether each field arrived and how long it was.
        siteState.attempts.push({
          userMatches: form.get('user') === USERNAME,
          userLength: (form.get('user') || '').length,
          passMatches: form.get('pass') === PASSWORD,
          passLength: (form.get('pass') || '').length,
        });
        if (form.get('user') === USERNAME && form.get('pass') === PASSWORD) {
          siteState.loginAccepted += 1;
          res.writeHead(303, { location: '/account', 'set-cookie': `session=${SESSION_VALUE}; Path=/; HttpOnly` });
          return res.end();
        }
        res.writeHead(401, { 'content-type': 'text/html' });
        return res.end('<h1>Sign-in failed</h1>');
      }
      if (req.url.startsWith('/beacon')) {
        // The page reports focus, typing lengths and Enter presses. Field names and lengths only, never the text.
        const q = new URL(req.url, 'http://x').searchParams;
        siteState.events.push({ event: q.get('event'), id: q.get('id'), len: q.get('len'), key: q.get('key') });
        res.writeHead(204);
        return res.end();
      }
      if (req.url === '/account') {
        siteState.lastCookieOk = signedIn;
        if (!signedIn) {
          res.writeHead(303, { location: '/login' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<!doctype html><title>Account</title><h1>Welcome back, tester</h1><p>Your account page.</p>');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Sign in</title>
<script>
  document.addEventListener('focusin', (e) => navigator.sendBeacon('/beacon?event=focus&id=' + e.target.id));
  document.addEventListener('input', (e) => navigator.sendBeacon('/beacon?event=input&id=' + e.target.id + '&len=' + e.target.value.length));
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigator.sendBeacon('/beacon?event=key&key=Enter&id=' + (e.target.id || e.target.tagName)); });
</script>
<main style="font:16px system-ui;padding:40px">
  <h1>Sign in</h1>
  <form method="POST" action="/login">
    <p><label>Email <input id="user" name="user" style="font-size:18px;padding:8px;width:280px"></label></p>
    <p><label>Password <input id="pass" name="pass" type="password" style="font-size:18px;padding:8px;width:280px"></label></p>
    <p><button id="signin" type="submit" style="font-size:18px;padding:8px 20px">Sign in</button></p>
  </form>
</main>`);
    });
    server.on('error', rejectSite);
    server.listen(0, LOGIN_HOST, () => resolveSite({ server, port: server.address().port }));
  });
}

async function call(path, { method = 'GET', body, key = ACCESS_KEY } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers.Authorization = `Bearer ${key}`;
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function evaluate(expression) {
  const res = await call(`/tabs/${encodeURIComponent(tabId)}/evaluate`, { method: 'POST', body: { userId, expression } });
  const data = await json(res);
  return { status: res.status, value: data?.result ?? data?.value ?? null };
}

async function issueControlLink() {
  const res = await call('/live-viewer/links', { method: 'POST', body: { userId, tabId, ttlSeconds: 300, control: true } });
  const data = await json(res);
  const token = data?.url ? new URL(data.url).searchParams.get('t') : null;
  return { status: res.status, token };
}

async function viewerPost(path, token, body) {
  const res = await call(`${path}?t=${encodeURIComponent(token)}`, { method: 'POST', body: body ?? {}, key: '' });
  return { status: res.status, data: await json(res) };
}

async function startHandoff() {
  const res = await call(`/tabs/${encodeURIComponent(tabId)}/handoff`, {
    method: 'POST',
    body: { userId, reason: 'Sign in to your account', idleMs: 120_000 },
  });
  return { status: res.status };
}

async function agentScroll() {
  const res = await call(`/tabs/${encodeURIComponent(tabId)}/scroll`, { method: 'POST', body: { userId, direction: 'down', amount: 100 } });
  return { status: res.status };
}

/** Centre of an element as a fraction of the viewport, which is how the viewer's clicks are sent. */
async function fractionOf(selector) {
  const { value } = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight };
  })()`);
  return value;
}

async function run() {
  const opened = await call('/tabs', { method: 'POST', body: { userId, sessionKey, url: `${siteUrl}/login` } });
  tabId = (await json(opened))?.tabId ?? null;
  check('open the login page in a tab', opened.ok && typeof tabId === 'string', `HTTP ${opened.status}`);
  if (!tabId) return;

  const user = await fractionOf('#user');
  const pass = await fractionOf('#pass');
  const button = await fractionOf('#signin');
  check('agent finds the sign-in fields', Boolean(user && pass && button));
  if (!user || !pass || !button) return;

  const started = await startHandoff();
  check('handoff starts for the person', started.status === 200 || started.status === 201, `HTTP ${started.status}`);

  const blocked = await agentScroll();
  check('agent is blocked while the person holds the tab', blocked.status === 409, `HTTP ${blocked.status}`);

  const link = await issueControlLink();
  check('control link issued for the person', link.status === 200 || link.status === 201, `HTTP ${link.status}`);
  if (!link.token) return;

  // The person: click the email field, type, click the password field, type, click Sign in.
  const steps = [
    ['click', { action: 'click', ...user }],
    ['type email', { action: 'type', text: USERNAME }],
    ['click password', { action: 'click', ...pass }],
    ['type password', { action: 'type', text: PASSWORD }],
    // Enter in the password field submits the form, so the test doesn't depend on where the button is.
    ['press Enter', { action: 'key', key: 'Enter' }],
  ];
  let inputsOk = true;
  for (const [name, body] of steps) {
    const res = await viewerPost('/live-viewer/input', link.token, body);
    if (res.status !== 200) {
      inputsOk = false;
      console.log(`      step "${name}" returned HTTP ${res.status}`);
      break;
    }
  }
  check('the person’s clicks and typing reach the page', inputsOk);

  // Give the site a moment to answer the sign-in.
  await new Promise((r) => setTimeout(r, 2500));
  const last = siteState.attempts.at(-1);
  const detail = last
    ? `accepted ${siteState.loginAccepted}; last form: email ${last.userMatches ? 'matched' : `did not match (length ${last.userLength})`}, password ${last.passMatches ? 'matched' : `did not match (length ${last.passLength})`}`
    : 'the sign-in form was never submitted';
  check('the site accepted the sign-in', siteState.loginAccepted === 1, detail);
  if (siteState.loginAccepted !== 1) {
    const trail = siteState.events.slice(-12).map((e) => [e.event, e.id, e.len ? `len ${e.len}` : '', e.key ?? ''].filter(Boolean).join(' ')).join(' | ');
    console.log(`      page reports: ${trail || 'nothing (the page sent no events)'}`);
  }

  const done = await viewerPost('/live-viewer/done', link.token);
  check('the person presses Done', done.status === 200, `HTTP ${done.status}`);

  // The agent continues in the same tab.
  const after = await evaluate('document.body.innerText');
  const text = String(after.value ?? '');
  check('after Done the agent sees the signed-in page in the same tab', /Welcome back/.test(text), text.replace(/\s+/g, ' ').slice(0, 80));

  const acts = await agentScroll();
  check('the agent can act again after Done', acts.status === 200, `HTTP ${acts.status}`);

  // A fresh navigation in the same tab proves the session was kept, not just the page on screen.
  const nav = await call(`/tabs/${encodeURIComponent(tabId)}/navigate`, { method: 'POST', body: { userId, url: `${siteUrl}/account` } });
  check('navigate to the account page after Done', nav.status === 200, `HTTP ${nav.status}`);
  const again = await evaluate('document.body.innerText');
  check('still signed in after a fresh navigation', /Welcome back/.test(String(again.value ?? '')));
}

async function main() {
  const site = await startLoginSite();
  loginSite = site.server;
  siteUrl = `http://${LOGIN_HOST}:${site.port}`;
  try {
    await run();
  } catch (err) {
    failures += 1;
    console.log(`FAIL  unexpected error (${err.name}): ${err.message}`);
  } finally {
    if (tabId) {
      await call(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' }).catch(() => {});
    }
    await new Promise((r) => loginSite.close(r));
  }
}

main().then(() => {
  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
});
