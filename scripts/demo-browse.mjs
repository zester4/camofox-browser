#!/usr/bin/env node
// Let the agent browse a free site while you watch it live.
//
//   node scripts/demo-browse.mjs                       # Hacker News, 3 stories
//   node scripts/demo-browse.mjs --url https://en.wikipedia.org/wiki/Main_Page --steps 4 --pause 5000
//
// Prints a live view link first. Open it in your own browser and watch the
// agent click, read and go back. Needs CHUSKY_BASE_URL and CHUSKY_ACCESS_KEY.

import { loadDotEnv } from '../skills/chuskybrowser-setup/scripts/lib-env.mjs';
import { ChuskyClient } from '../skills/chuskybrowser-setup/scripts/chusky-client.mjs';
import { pickContentLinks } from '../lib/demo-browse.js';

const ENV = { ...loadDotEnv(), ...process.env };

function parseArgs(argv) {
  const opts = { url: 'https://news.ycombinator.com/', steps: 3, pause: 4000, ttl: 3600 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--url': opts.url = next(); break;
      case '--steps': opts.steps = Number(next()); break;
      case '--pause': opts.pause = Number(next()); break;
      case '--ttl': opts.ttl = Number(next()); break;
      case '-h':
      case '--help':
        console.log('Usage: node scripts/demo-browse.mjs [--url URL] [--steps N] [--pause MS] [--ttl SECONDS]');
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  if (!(opts.steps >= 1 && opts.steps <= 20)) throw new Error('--steps must be 1 to 20');
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function viewerLink(baseUrl, accessKey, userId, tabId, ttlSeconds) {
  const res = await fetch(`${baseUrl}/live-viewer/links`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, tabId, control: false, ttlSeconds }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`viewer link failed (HTTP ${res.status}): ${data.error || 'no detail'}`);
  return data.url;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = (ENV.CHUSKY_BASE_URL || '').replace(/\/+$/, '');
  const accessKey = ENV.CHUSKY_ACCESS_KEY || '';
  if (!baseUrl || !accessKey) throw new Error('Set CHUSKY_BASE_URL and CHUSKY_ACCESS_KEY in .env first.');

  const userId = `demo-${Date.now()}`;
  const sessionKey = 'demo-browse';
  const client = new ChuskyClient({ baseUrl, accessKey, userId });
  await client.health().catch((err) => { throw new Error(`Chusky server not reachable: ${err.message}`); });

  const { tabId } = await client.openTab({ url: opts.url, sessionKey });
  const link = await viewerLink(baseUrl, accessKey, userId, tabId, opts.ttl);
  console.log('\nWatch the agent live (open this in your browser):');
  console.log(link + '\n');
  await sleep(opts.pause);

  const first = await client.snapshot(tabId);
  const candidates = pickContentLinks(first.snapshot);
  if (candidates.length === 0) throw new Error('No content links found on the start page.');
  console.log(`Found ${candidates.length} links to choose from. Visiting ${Math.min(opts.steps, candidates.length)}.\n`);

  for (let step = 0; step < Math.min(opts.steps, candidates.length); step++) {
    const pick = candidates[step];
    console.log(`Step ${step + 1}: clicking "${pick.text}"`);
    await client.click(tabId, { ref: pick.ref });
    await sleep(opts.pause);

    const page = await client.snapshot(tabId);
    const words = (page.snapshot || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 40).join(' ');
    console.log(`  now on ${page.url}`);
    console.log(`  reading: ${words}\n`);
    await sleep(opts.pause);

    if (step < Math.min(opts.steps, candidates.length) - 1) {
      console.log('  going back to the start page');
      await client.navigate(tabId, { url: opts.url, sessionKey });
      await sleep(opts.pause);
    }
  }

  await client.closeTab(tabId).catch(() => {});
  await client.endSession().catch(() => {});
  console.log('Done.');
}

main().catch((err) => {
  console.error(`demo-browse: ${err.message}`);
  process.exit(1);
});
