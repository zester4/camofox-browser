#!/usr/bin/env node
// Check which sites a running Chusky server can read.
//
//   node scripts/site-coverage.mjs                    # all sites in scripts/data/coverage-sites.txt
//   node scripts/site-coverage.mjs --limit 20         # first 20 only
//   node scripts/site-coverage.mjs --only nike.com,walmart.com
//   node scripts/site-coverage.mjs --concurrency 2 --delay 1000 --timeout 60000
//   node scripts/site-coverage.mjs --sites my-list.txt --out ./results
//
// Needs CHUSKY_BASE_URL and CHUSKY_ACCESS_KEY (from .env or the environment).
// Writes results.json, results.csv and summary.json into the --out folder.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forUser } from '../skills/chuskybrowser-setup/scripts/chusky-client.mjs';
import { loadSites, runCoverage, summarize, toCsv, STATUSES } from '../lib/site-coverage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SITES = path.join(here, 'data', 'coverage-sites.txt');

function parseArgs(argv) {
  const opts = { sites: DEFAULT_SITES, limit: 0, only: null, concurrency: 1, delay: 0, timeout: 60000, out: null, keepSession: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--sites': opts.sites = path.resolve(next()); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--only': opts.only = next().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--delay': opts.delay = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '-h':
      case '--help':
        console.log('Usage: node scripts/site-coverage.mjs [--sites FILE] [--limit N] [--only a.com,b.com] [--concurrency N] [--delay MS] [--timeout MS] [--out DIR]');
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  for (const key of ['limit', 'concurrency', 'delay', 'timeout']) {
    if (!Number.isFinite(opts[key]) || opts[key] < 0) throw new Error(`--${key} must be a number >= 0`);
  }
  if (opts.concurrency < 1) throw new Error('--concurrency must be at least 1');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let sites = loadSites(fs.readFileSync(opts.sites, 'utf8'));
  if (opts.only) {
    const wanted = new Set(opts.only);
    sites = sites.filter((s) => wanted.has(s));
  }
  if (opts.limit > 0) sites = sites.slice(0, opts.limit);
  if (sites.length === 0) throw new Error('No sites to check.');

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.out || path.resolve(process.cwd(), 'site-coverage-results', runId);
  fs.mkdirSync(outDir, { recursive: true });

  // One test user per run, so these tabs never mix with real users' sessions.
  const client = forUser(`coverage-${runId}`);
  const health = await client.health().catch((err) => {
    throw new Error(`Chusky server not reachable: ${err.message}`);
  });
  console.log(`Server: ${health.status || 'reachable'}. Checking ${sites.length} site(s), concurrency ${opts.concurrency}.`);

  let done = 0;
  const started = Date.now();
  const results = await runCoverage(client, sites, {
    concurrency: opts.concurrency,
    delayMs: opts.delay,
    timeoutMs: opts.timeout,
    onResult: (r) => {
      done++;
      const mark = r.status === 'loaded' ? 'ok ' : '-- ';
      console.log(`[${done}/${sites.length}] ${mark}${r.site.padEnd(32)} ${r.status.padEnd(8)} ${r.ms}ms${r.reason ? '  ' + r.reason : ''}`);
    },
  });

  if (!opts.keepSession) await client.endSession().catch(() => {});

  const summary = { runId, startedAt: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000), ...summarize(results) };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'results.csv'), toCsv(results));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log('');
  console.log(`Loaded ${summary.counts.loaded}/${summary.total} (${summary.percent.loaded}%)`);
  for (const s of STATUSES.slice(1)) console.log(`  ${s.padEnd(8)} ${summary.counts[s]}`);
  console.log(`Results: ${outDir}`);
}

main().catch((err) => {
  console.error(`site-coverage: ${err.message}`);
  process.exit(1);
});
