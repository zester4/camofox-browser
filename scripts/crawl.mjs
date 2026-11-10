#!/usr/bin/env node
// Crawl a site and write it as LLM-ready markdown.
//
//   node scripts/crawl.mjs https://example.com
//   node scripts/crawl.mjs https://docs.example.com --max-pages 50 --max-depth 3
//   node scripts/crawl.mjs https://example.com --no-robots --out ./crawl-out
//
// Needs CHUSKY_BASE_URL and CHUSKY_ACCESS_KEY (from .env or the environment).
// Writes into --out (default ./crawl-results/<timestamp>/):
//   llm.md      every page in one markdown file, with a page map at the top
//   pages/      one markdown file per page
//   pages.json  url, title, depth and character count per page
//   summary.json  what was crawled, what was skipped, and why

import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from '../skills/chuskybrowser-setup/scripts/lib-env.mjs';
import { ChuskyClient } from '../skills/chuskybrowser-setup/scripts/chusky-client.mjs';
import { crawlSite, toLlmDocument, DEFAULTS } from '../lib/crawl.js';

const ENV = { ...loadDotEnv(), ...process.env };

function parseArgs(argv) {
  const opts = { url: null, maxPages: DEFAULTS.maxPages, maxDepth: DEFAULTS.maxDepth, respectRobots: true, sameHostOnly: true, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--max-pages': opts.maxPages = Number(next()); break;
      case '--max-depth': opts.maxDepth = Number(next()); break;
      case '--no-robots': opts.respectRobots = false; break;
      case '--any-host': opts.sameHostOnly = false; break;
      case '--out': opts.out = path.resolve(next()); break;
      case '-h':
      case '--help':
        console.log('Usage: node scripts/crawl.mjs <url> [--max-pages N] [--max-depth N] [--any-host] [--no-robots] [--out DIR]');
        process.exit(0);
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
        if (opts.url) throw new Error('Give one start URL');
        opts.url = arg;
    }
  }
  if (!opts.url) throw new Error('Give a start URL, e.g. node scripts/crawl.mjs https://example.com');
  return opts;
}

// Adapts the REST API to the shape lib/crawl.js expects.
function makeApi(client, baseUrl, accessKey, userId) {
  const headers = { Authorization: `Bearer ${accessKey}` };
  return {
    openTab: (args) => client.openTab(args),
    navigate: (tabId, args) => client.navigate(tabId, args),
    snapshot: (tabId) => client.snapshot(tabId),
    closeTab: (tabId) => client.closeTab(tabId),
    async links(tabId, { offset, limit }) {
      const url = new URL(`${baseUrl}/tabs/${encodeURIComponent(tabId)}/links`);
      url.searchParams.set('userId', userId);
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('limit', String(limit));
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`links failed (HTTP ${res.status})`);
      return res.json();
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl = (ENV.CHUSKY_BASE_URL || '').replace(/\/+$/, '');
  const accessKey = ENV.CHUSKY_ACCESS_KEY || '';
  if (!baseUrl || !accessKey) throw new Error('Set CHUSKY_BASE_URL and CHUSKY_ACCESS_KEY in .env first.');

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.out || path.resolve(process.cwd(), 'crawl-results', runId);
  fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });

  const userId = `crawl-${runId}`;
  const client = new ChuskyClient({ baseUrl, accessKey, userId });
  await client.health().catch((err) => { throw new Error(`Chusky server not reachable: ${err.message}`); });

  console.log(`Crawling ${opts.url} (max ${opts.maxPages} pages, depth ${opts.maxDepth}, robots ${opts.respectRobots ? 'on' : 'off'})`);
  const started = Date.now();
  const result = await crawlSite(makeApi(client, baseUrl, accessKey, userId), opts.url, {
    maxPages: opts.maxPages,
    maxDepth: opts.maxDepth,
    respectRobots: opts.respectRobots,
    sameHostOnly: opts.sameHostOnly,
    sessionKey: runId,
  });
  await client.endSession().catch(() => {});

  fs.writeFileSync(path.join(outDir, 'llm.md'), toLlmDocument(result));
  result.pages.forEach((p, i) => {
    const slug = (p.title || p.url).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
    fs.writeFileSync(path.join(outDir, 'pages', `${String(i + 1).padStart(3, '0')}-${slug}.md`), `Source: ${p.url}\n\n${p.markdown}`);
  });
  fs.writeFileSync(path.join(outDir, 'pages.json'), JSON.stringify(result.pages.map(({ markdown, ...rest }) => rest), null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    runId,
    startUrl: result.startUrl,
    seconds: Math.round((Date.now() - started) / 1000),
    pages: result.pages.length,
    stoppedBy: result.stoppedBy,
    options: result.options,
    skipped: result.skipped,
  }, null, 2) + '\n');

  for (const p of result.pages) console.log(`  ok  ${p.url}  (${p.chars} chars)`);
  for (const s of result.skipped) console.log(`  --  ${s.url}  ${s.reason}`);
  console.log(`\n${result.pages.length} page(s) written. Stopped: ${result.stoppedBy}. Output: ${outDir}`);
  console.log(`Feed agents: ${path.join(outDir, 'llm.md')}`);
}

main().catch((err) => {
  console.error(`crawl: ${err.message}`);
  process.exit(1);
});
