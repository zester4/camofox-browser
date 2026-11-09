#!/usr/bin/env node
/**
 * Measures how quickly a person's typing shows up in the live viewer, against a running server.
 *
 *   node scripts/test-viewer-latency.mjs
 *
 * Needs the server running (npm start) with CHUSKY_ACCESS_KEY set in .env. Starts a local page with
 * one text box, hands the tab to the person, types short strings through the viewer's input route,
 * and measures three times for each string:
 *   ack      the viewer's input request returns
 *   page     the page itself receives the text (the page reports it back, so the server's page
 *            evaluation is not needed; it is blocked while a handoff is active)
 *   picture  the picture the person sees changes (the frame bytes change)
 *
 * Thresholds (ms, p95) can be changed with VIEWER_ACK_P95_MS, VIEWER_PAGE_P95_MS, VIEWER_PICTURE_P95_MS.
 * Note: the picture check counts any change in the frame, including the text caret blinking, so it can
 * only be earlier than the true text appearance, never later.
 *
 * Exit code is 0 only when every check passed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const BASE = (process.env.CHUSKY_BASE_URL || 'http://localhost:9377').trim().replace(/\/+$/, '');
const ACCESS_KEY = (process.env.CHUSKY_ACCESS_KEY || process.env.CHUSKY_API_KEY || '').trim();
const ROUNDS = Number(process.env.VIEWER_ROUNDS || 12);
const LIMITS = {
  ack: Number(process.env.VIEWER_ACK_P95_MS || 1000),
  page: Number(process.env.VIEWER_PAGE_P95_MS || 600),
  picture: Number(process.env.VIEWER_PICTURE_P95_MS || 800),
};

const userId = `latency-${randomUUID()}`;
const sessionKey = `latency-${randomUUID()}`;
let tabId = null;
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

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summary(name, values, limit) {
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  const ok = values.length > 0 && p95 <= limit;
  check(`${name} within ${limit} ms at p95`, ok, `median ${Math.round(p50)} ms, p95 ${Math.round(p95)} ms, n=${values.length}`);
}

/**
 * A local page with one text box. It reports to this process when it loads (with the box's position
 * as a fraction of the window) and each time its text changes (with the text and the time received).
 */
function startPage() {
  const received = new Map();   // text -> time the page reported it
  let loadedBox = null;
  const html = `<!doctype html><meta charset="utf-8"><title>Latency</title>
<body style="font:24px sans-serif;margin:40px">
<input id="box" style="font:24px sans-serif;width:70%;padding:8px" autocomplete="off">
<pre id="out" style="font:24px monospace;margin-top:24px"></pre>
<script>
  var box = document.getElementById('box');
  window.addEventListener('load', function () {
    var r = box.getBoundingClientRect();
    navigator.sendBeacon('/loaded?x=' + ((r.x + r.width / 2) / innerWidth) + '&y=' + ((r.y + r.height / 2) / innerHeight));
  });
  box.addEventListener('input', function () {
    document.getElementById('out').textContent = box.value;
    navigator.sendBeacon('/typed?text=' + encodeURIComponent(box.value));
  });
</script></body>`;
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/loaded') {
        loadedBox = { x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')) };
      } else if (url.pathname === '/typed') {
        received.set(url.searchParams.get('text'), Date.now());
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else {
        res.writeHead(204).end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolveServer({ server, received, box: () => loadedBox }));
  });
}

async function viewerFrame(token) {
  const res = await call(`/live-viewer/frame?t=${encodeURIComponent(token)}`, { key: '' });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

const hash = (buffer) => (buffer ? createHash('sha1').update(buffer).digest('hex') : null);

async function main() {
  check('server answers', (await call('/live-viewer/view', { key: '' })).status < 500);
  if (!ACCESS_KEY) {
    check('CHUSKY_ACCESS_KEY is set in .env', false, 'the viewer needs it to issue links');
    return;
  }

  const page = await startPage();
  const { port } = page.server.address();
  const pageUrl = `http://127.0.0.1:${port}/`;
  try {
    const opened = await call('/tabs', { method: 'POST', body: { userId, sessionKey, url: pageUrl } });
    tabId = (await json(opened))?.tabId ?? null;
    check('open the test page in a tab', opened.ok && typeof tabId === 'string', `HTTP ${opened.status}`);
    if (!tabId) return;

    // Wait for the page to report its box position.
    const loadDeadline = Date.now() + 15_000;
    while (!page.box() && Date.now() < loadDeadline) await new Promise((r) => setTimeout(r, 100));
    check('the test page loads', Boolean(page.box()));
    if (!page.box()) return;

    const started = await call(`/tabs/${encodeURIComponent(tabId)}/handoff`, {
      method: 'POST',
      body: { userId, reason: 'Latency test', idleMs: 120_000 },
    });
    check('handoff starts', started.ok, `HTTP ${started.status}`);

    const link = await call('/live-viewer/links', { method: 'POST', body: { userId, tabId, ttlSeconds: 300, control: true } });
    const linkData = await json(link);
    const token = linkData?.url ? new URL(linkData.url).searchParams.get('t') : null;
    check('control link issued', Boolean(token), `HTTP ${link.status}`);
    if (!token) return;
    console.log(`      watch and type here while the test runs (open in your browser):\n      ${linkData.url}`);

    // Click the box through the viewer, as the person would.
    const box = page.box();
    const clicked = await call(`/live-viewer/input?t=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: { action: 'click', x: box.x, y: box.y },
      key: '',
    });
    check('the person can click the box', clicked.ok, `HTTP ${clicked.status}`);
    await new Promise((r) => setTimeout(r, 300));

    // Frame cadence: how often a picture is available to the viewer.
    const gaps = [];
    let last = Date.now();
    const pictures = new Set();
    for (let i = 0; i < 20; i += 1) {
      const frame = await viewerFrame(token);
      if (frame) pictures.add(hash(frame));
      gaps.push(Date.now() - last);
      last = Date.now();
    }
    const frameMs = gaps.slice(1);
    console.log(`      frame requests: median ${Math.round(percentile(frameMs, 50))} ms, p95 ${Math.round(percentile(frameMs, 95))} ms, distinct pictures ${pictures.size}`);

    const ack = [];
    const pageTimes = [];
    const pictureTimes = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      const text = `t${i}${randomUUID().slice(0, 4)}`;
      const beforeHash = hash(await viewerFrame(token));

      const t0 = Date.now();
      const typed = await call(`/live-viewer/input?t=${encodeURIComponent(token)}`, { method: 'POST', body: { action: 'type', text }, key: '' });
      const ackMs = Date.now() - t0;
      if (!typed.ok) {
        check(`typing round ${i + 1} accepted`, false, `HTTP ${typed.status}`);
        break;
      }
      ack.push(ackMs);

      let pageMs = null;
      let pictureMs = null;
      while (Date.now() - t0 < 6000 && (pageMs === null || pictureMs === null)) {
        // The box keeps earlier rounds' text, so this round's text is the end of what the page received.
        if (pageMs === null) {
          const match = [...page.received].find(([value]) => value.endsWith(text));
          if (match) pageMs = match[1] - t0;
        }
        if (pictureMs === null && hash(await viewerFrame(token)) !== beforeHash) pictureMs = Date.now() - t0;
        await new Promise((r) => setTimeout(r, 15));
      }
      if (pageMs !== null) pageTimes.push(pageMs);
      if (pictureMs !== null) pictureTimes.push(pictureMs);
    }

    check('every typed string reached the page', pageTimes.length === ROUNDS, `${pageTimes.length}/${ROUNDS}`);
    summary('input acknowledged', ack, LIMITS.ack);
    summary('text on the page', pageTimes, LIMITS.page);
    summary('picture shows the change', pictureTimes, LIMITS.picture);

    // Keep the tab open so the viewer link printed above can be watched (and typed into) before cleanup.
    const hold = Number(process.env.VIEWER_HOLD_MS ?? 60_000);
    if (hold > 0) {
      console.log(`      holding the tab open for ${Math.round(hold / 1000)} s, so you can watch it in the viewer link`);
      await new Promise((r) => setTimeout(r, hold));
    }

    await call(`/tabs/${encodeURIComponent(tabId)}/handoff/release`, { method: 'POST', body: { userId } });
  } finally {
    if (tabId) await call(`/tabs/${encodeURIComponent(tabId)}?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' }).catch(() => {});
    page.server.close();
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
