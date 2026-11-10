#!/usr/bin/env node
// Re-check only the sites that did not load in an earlier run.
//
//   node scripts/site-retest.mjs                       # latest run, thin + template + timeout + error
//   node scripts/site-retest.mjs --from path/to/results.json
//   node scripts/site-retest.mjs --statuses timeout,error
//   node scripts/site-retest.mjs --only etsy.com,zara.com
//   node scripts/site-retest.mjs --settle 6000 --retry 12000 --concurrency 1
//
// Needs CHUSKY_BASE_URL and CHUSKY_ACCESS_KEY (from .env or the environment).
// Writes into --out (default ./site-retest-results/<timestamp>/):
//   results.json, results.csv   the new checks
//   changes.csv                 each site: old status -> new status
//   summary.json                counts before and after

import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from '../skills/chuskybrowser-setup/scripts/lib-env.mjs';
import { ChuskyClient } from '../skills/chuskybrowser-setup/scripts/chusky-client.mjs';
import { runCoverage, summarize, toCsv, STATUSES } from '../lib/site-coverage.js';

const ENV = { ...loadDotEnv(), ...process.env };
const RESULTS_ROOT = path.resolve(process.cwd(), 'site-coverage-results');
const RETRY_DEFAULT = ['thin', 'template', 'timeout', 'error'];

function parseArgs(argv) {
  const opts = { from: null, statuses: RETRY_DEFAULT, only: null, concurrency: 1, delay: 0, timeout: 60000, settle: 3000, retry: 8000, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--from': opts.from = path.resolve(next()); break;
      case '--statuses': opts.statuses = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--only': opts.only = next().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); break;
      case '--concurrency': opts.concurrency = Number(next()); break;
      case '--delay': opts.delay = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--settle': opts.settle = Number(next()); break;
      case '--retry': opts.retry = Number(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '-h':
      case '--help':
        console.log('Usage: node scripts/site-retest.mjs [--from results.json] [--statuses thin,timeout] [--only a.com,b.com] [--settle MS] [--retry MS] [--concurrency N] [--out DIR]');
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option ${arg}`);
    }
  }
  for (const s of opts.statuses) {
    if (!STATUSES.includes(s)) throw new Error(`Unknown status "${s}". Use one of: ${STATUSES.join(', ')}`);
  }
  return opts;
}

// Latest run folder that has a results.json.
function latestResults() {
  if (!fs.existsSync(RESULTS_ROOT)) throw new Error('No site-coverage-results folder here. Pass --from.');
  const runs = fs.readdirSync(RESULTS_ROOT)
    .filter((d) => fs.existsSync(path.join(RESULTS_ROOT, d, 'results.json')))
    .sort();
  if (runs.length === 0) throw new Error('No earlier run found. Pass --from.');
  return path.join(RESULTS_ROOT, runs[runs.length - 1], 'results.json');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fromFile = opts.from || latestResults();
  const previous = JSON.parse(fs.readFileSync(fromFile, 'utf8'));

  let targets = previous.filter((r) => opts.statuses.includes(r.status));
  if (opts.only) {
    const wanted = new Set(opts.only);
    targets = targets.filter((r) => wanted.has(r.site));
  }
  if (targets.length === 0) {
    console.log('Nothing to retest with those statuses.');
    return;
  }

  const baseUrl = (ENV.CHUSKY_BASE_URL || '').replace(/\/+$/, '');
  const accessKey = ENV.CHUSKY_ACCESS_KEY || '';
  if (!baseUrl || !accessKey) throw new Error('Set CHUSKY_BASE_URL and CHUSKY_ACCESS_KEY in .env first.');

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.out || path.resolve(process.cwd(), 'site-retest-results', runId);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new ChuskyClient({ baseUrl, accessKey, userId: `retest-${runId}` });
  await client.health().catch((err) => { throw new Error(`Chusky server not reachable: ${err.message}`); });

  console.log(`Retesting ${targets.length} site(s) from ${fromFile} (settle ${opts.settle}ms, retry ${opts.retry}ms).`);
  let done = 0;
  const started = Date.now();
  const results = await runCoverage(client, targets.map((r) => r.site), {
    concurrency: opts.concurrency,
    delayMs: opts.delay,
    timeoutMs: opts.timeout,
    settleMs: opts.settle,
    retryMs: opts.retry,
    onResult: (r) => {
      done++;
      const before = targets.find((t) => t.site === r.site)?.status || '?';
      console.log(`[${done}/${targets.length}] ${r.site.padEnd(28)} ${before} -> ${r.status}${r.reason ? '  ' + r.reason : ''}`);
    },
  });
  await client.endSession().catch(() => {});

  const before = new Map(previous.map((r) => [r.site, r.status]));
  const changes = results.map((r) => ({ site: r.site, before: before.get(r.site) || '', after: r.status, reason: r.reason }));
  const changeCsv = ['site,before,after,reason', ...changes.map((c) => [c.site, c.before, c.after, c.reason].map(csv).join(','))].join('\n') + '\n';

  const summary = {
    runId,
    source: fromFile,
    seconds: Math.round((Date.now() - started) / 1000),
    retested: results.length,
    after: summarize(results).counts,
    improved: changes.filter((c) => c.after === 'loaded').length,
    statusesRetested: opts.statuses,
  };

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'results.csv'), toCsv(results));
  fs.writeFileSync(path.join(outDir, 'changes.csv'), changeCsv);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log(`\nLoaded on retest: ${summary.improved} of ${results.length}`);
  console.log(`Results: ${outDir}`);
}

function csv(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

main().catch((err) => {
  console.error(`site-retest: ${err.message}`);
  process.exit(1);
});
