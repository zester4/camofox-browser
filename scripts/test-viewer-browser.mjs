#!/usr/bin/env node
/**
 * Browser test for the live viewer's own page (plugins/live-viewer/viewer.html), on Firefox (Camoufox).
 *
 *   node scripts/test-viewer-browser.mjs
 *
 * Needs the server running (npm start) with CHUSKY_ACCESS_KEY in .env, and the Camoufox binary
 * (npm run fetch-bin). The viewer is opened inside a host page, the way the app embeds it, and the
 * host applies the resize message the viewer sends. Checks:
 *   - the bar shows Done while the person holds the tab
 *   - a click on the picture and typing reach the page, and the picture refreshes
 *   - Minimize shrinks the host frame to the bar, Expand from the bar opens full size in one click,
 *     and Escape leaves full size
 *   - Done hands the tab back to the agent
 *
 * Exit code is 0 only when every check passed.
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { randomUUID } from 'node:crypto';
import { firefox } from 'playwright-core';
import { launchOptions } from 'camoufox-js';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const BASE = (process.env.CHUSKY_BASE_URL || 'http://localhost:9377').trim().replace(/\/+$/, '');
const ACCESS_KEY = (process.env.CHUSKY_ACCESS_KEY || process.env.CHUSKY_API_KEY || '').trim();
const userId = `viewer-ui-${randomUUID()}`;
const sessionKey = `viewer-ui-${randomUUID()}`;
const MINIMIZED_HEIGHT = 36;
const NORMAL_HEIGHT = 480;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until fn returns a truthy value, or gives up after timeoutMs. */
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

// The box page: reports its box position when it loads, and each text change it receives.
const TEST_PAGE = `<!doctype html><meta charset="utf-8"><title>Viewer test</title>
<body style="font:24px sans-serif;margin:40px">
<input id="box" style="font:24px sans-serif;width:70%;padding:8px" autocomplete="off">
<script>
  var box = document.getElementById('box');
  window.addEventListener('load', function () {
    var r = box.getBoundingClientRect();
    navigator.sendBeacon('/loaded?x=' + ((r.x + r.width / 2) / innerWidth) + '&y=' + ((r.y + r.height / 2) / innerHeight));
  });
  box.addEventListener('input', function () {
    navigator.sendBeacon('/typed?text=' + encodeURIComponent(box.value));
  });
</script></body>`;

// The host page: embeds the viewer and applies its resize message, as the app does.
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><title>Host</title>
<body style="margin:0;font:16px sans-serif">
<iframe id="viewer" style="display:block;width:960px;height:${NORMAL_HEIGHT}px;border:0"></iframe>
<script>
  document.getElementById('viewer').src = new URLSearchParams(location.search).get('src');
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'chusky-live-viewer' || d.type !== 'resize') return;
    navigator.sendBeacon('/resize?minimized=' + (d.minimized ? 1 : 0) + '&expanded=' + (d.expanded ? 1 : 0));
    document.getElementById('viewer').style.height =
      d.minimized ? '${MINIMIZED_HEIGHT}px' : d.expanded ? '100vh' : '${NORMAL_HEIGHT}px';
  });
</script></body>`;

async function launchFirefox() {
  const options = await launchOptions({ headless: true });
  options.handleSIGTERM = false;
  options.handleSIGINT = false;
  options.handleSIGHUP = false;
  return firefox.launch(options);
}

async function main() {
  check('server answers', (await call('/live-viewer/view', { key: '' })).status < 500);
  if (!ACCESS_KEY) {
    check('CHUSKY_ACCESS_KEY is set in .env', false, 'the viewer needs it to issue links');
    return;
  }

  const received = new Map(); // text -> time the test page received it
  const resizes = [];         // resize messages the host page received from the viewer, in order
  let loaded = null;          // the box's position, as fractions of the window
  const local = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/loaded') {
      loaded = { x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')) };
    } else if (url.pathname === '/typed') {
      received.set(url.searchParams.get('text'), Date.now());
    } else if (url.pathname === '/resize') {
      resizes.push({ minimized: url.searchParams.get('minimized') === '1', expanded: url.searchParams.get('expanded') === '1' });
    }
    const html = url.pathname === '/page' ? TEST_PAGE : url.pathname === '/host' ? HOST_PAGE : null;
    if (html) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(204).end();
    }
  });
  await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const port = local.address().port;

  let tabId = null;
  let browser = null;
  try {
    const opened = await call('/tabs', { method: 'POST', body: { userId, sessionKey, url: `http://127.0.0.1:${port}/page` } });
    tabId = (await json(opened))?.tabId ?? null;
    check('open the test page in a tab', opened.ok && Boolean(tabId), `HTTP ${opened.status}`);
    if (!tabId) return;
    check('the test page loads', Boolean(await waitFor(async () => loaded, 15_000)));
    if (!loaded) return;

    const started = await call(`/tabs/${encodeURIComponent(tabId)}/handoff`, {
      method: 'POST',
      body: { userId, reason: 'Viewer browser test', idleMs: 120_000 },
    });
    check('handoff starts', started.ok, `HTTP ${started.status}`);

    const link = await call('/live-viewer/links', { method: 'POST', body: { userId, tabId, ttlSeconds: 300, control: true } });
    const linkData = await json(link);
    check('control link issued', Boolean(linkData?.url), `HTTP ${link.status}`);
    if (!linkData?.url) return;

    browser = await launchFirefox();
    check('Firefox (Camoufox) launches', true, `version ${browser.version()}`);
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/host?src=${encodeURIComponent(linkData.url)}`, { waitUntil: 'domcontentloaded' });

    const viewer = page.frameLocator('#viewer');
    const picture = viewer.locator('#frame');
    const frameBox = () => page.locator('#viewer').boundingBox();
    const frameHeight = () => page.locator('#viewer').evaluate((el) => Math.round(el.getBoundingClientRect().height));
    const messageCount = async () => resizes.length;
    const messagesFrom = async (n) => resizes.slice(n);
    const waitForMessage = (from, test) => waitFor(async () => (await messagesFrom(from)).find(test), 3000, 50);

    // 1. The bar shows Done while the person holds the tab.
    const showsDone = await viewer.locator('#done').waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
    check('the bar shows Done while the person holds the tab', showsDone);

    // 2. A click on the picture lands on the box; typing reaches the page; the picture refreshes.
    const hasPicture = await waitFor(() => picture.evaluate((img) => img.naturalWidth > 0), 15_000);
    check('the picture loads', Boolean(hasPicture));
    const geometry = await picture.evaluate((img) => {
      const r = img.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, nw: img.naturalWidth, nh: img.naturalHeight };
    });
    const iframe = await frameBox();
    const scale = Math.min(geometry.width / geometry.nw, geometry.height / geometry.nh);
    const drawW = geometry.nw * scale;
    const drawH = geometry.nh * scale;
    const picLeft = iframe.x + geometry.left + (geometry.width - drawW) / 2;
    const picTop = iframe.y + geometry.top + (geometry.height - drawH) / 2;
    await page.mouse.click(picLeft + loaded.x * drawW, picTop + loaded.y * drawH);

    const beforeSrc = await picture.getAttribute('src');
    const text = `ui${randomUUID().slice(0, 6)}`;
    await page.keyboard.type(text);
    const reached = await waitFor(async () => [...received.keys()].some((v) => v.endsWith(text)), 5000, 50);
    check('a click on the picture and typing reach the page', Boolean(reached));
    const refreshed = await waitFor(async () => (await picture.getAttribute('src')) !== beforeSrc, 5000, 50);
    check('the picture refreshes after typing', Boolean(refreshed));

    // 3. Minimize shrinks the host frame to the bar; Expand from the bar opens full size; Escape leaves it.
    let mark = await messageCount();
    await viewer.locator('#min').click();
    const minimized = await waitForMessage(mark, (m) => m.minimized);
    check('Minimize tells the host to shrink the frame', Boolean(minimized));
    check('the frame is the bar height when minimized', (await frameHeight()) === MINIMIZED_HEIGHT, `${await frameHeight()} px`);
    check('Expand is still reachable while minimized', await viewer.locator('#expand').isVisible());

    mark = await messageCount();
    await viewer.locator('#expand').click();
    const expanded = await waitForMessage(mark, (m) => m.expanded && !m.minimized);
    check('Expand from the bar opens full size in one click', Boolean(expanded));
    check('the frame is taller than the normal height when expanded', (await frameHeight()) > NORMAL_HEIGHT, `${await frameHeight()} px`);

    mark = await messageCount();
    await page.keyboard.press('Escape');
    const exited = await waitForMessage(mark, (m) => !m.expanded && !m.minimized);
    check('Escape leaves full size', Boolean(exited));
    check('the frame returns to the normal height', (await frameHeight()) === NORMAL_HEIGHT, `${await frameHeight()} px`);

    mark = await messageCount();
    await viewer.locator('#min').click();
    await waitForMessage(mark, (m) => m.minimized);
    mark = await messageCount();
    await viewer.locator('#min').click();
    const restored = await waitForMessage(mark, (m) => !m.minimized);
    check('Minimize again restores the view', Boolean(restored));
    check('the frame returns to the normal height after restoring', (await frameHeight()) === NORMAL_HEIGHT, `${await frameHeight()} px`);

    // 4. Done hands the tab back: the agent can act on it again.
    await viewer.locator('#done').click();
    const handedBack = await waitFor(async () => {
      const r = await call(`/tabs/${encodeURIComponent(tabId)}/scroll`, { method: 'POST', body: { userId, direction: 'down', amount: 50 } });
      return r.status === 200 ? r : null;
    }, 8000, 300);
    check('Done hands the tab back to the agent', Boolean(handedBack));
  } catch (err) {
    check('viewer browser test', false, err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (tabId) await call(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' }).catch(() => {});
    local.close();
  }
}

main()
  .then(() => {
    console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('Test stopped:', err.message);
    process.exit(1);
  });
