// Site coverage: open a list of sites in Chusky, read each page, and sort the
// result into loaded / blocked / thin / timeout / error.
//
// The classifier and runner are pure JavaScript and take a client object with
// the same methods as ChuskyClient (openTab, snapshot, closeTab), so they can be
// tested without a browser.

export const STATUSES = ['loaded', 'blocked', 'thin', 'template', 'timeout', 'error'];

// A page with at least this much readable text is treated as loaded, unless it
// is short and matches a block pattern.
export const MIN_LOADED_CHARS = 400;

// Block pages are short. Anything longer than this is treated as real content
// even if a pattern matches, so articles that mention "captcha" are not
// counted as blocked.
export const BLOCK_MAX_CHARS = 1500;

export const BLOCK_PATTERNS = [
  /access denied/i,
  /unusual traffic/i,
  /verify you are human/i,
  /are you a human/i,
  /captcha/i,
  /press (?:&|and) hold/i,
  /pardon our interruption/i,
  /request (?:has been )?blocked/i,
  /\b403 forbidden\b/i,
  /attention required/i,
  /just a moment\.{0,3}/i,
  /enable javascript and cookies/i,
];

// Turns a text file (one domain per line) into a clean, de-duplicated list.
// Blank lines and lines starting with # are ignored.
export function loadSites(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export function siteUrl(site) {
  return /^https?:\/\//i.test(site) ? site : `https://${site}`;
}

function isTimeoutError(error) {
  if (!error) return false;
  if (error.code === 'timeout' || error.name === 'TimeoutError') return true;
  return /timed? ?out|aborted due to timeout/i.test(String(error.message || ''));
}

// Decide what a page looked like. `snapshot` is the readable text of the page,
// `error` is whatever was thrown while opening or reading it.
export function classify({ snapshot = '', error = null } = {}) {
  if (error) {
    const kind = isTimeoutError(error) ? 'timeout' : 'error';
    return { status: kind, reason: String(error.message || error).slice(0, 300), chars: 0 };
  }
  const text = String(snapshot || '').replace(/\s+/g, ' ').trim();
  const chars = text.length;
  const hit = BLOCK_PATTERNS.find((re) => re.test(text));
  if (hit && chars < BLOCK_MAX_CHARS) {
    return { status: 'blocked', reason: `block page text matched ${hit}`, chars };
  }
  if (chars >= MIN_LOADED_CHARS) {
    return { status: 'loaded', reason: '', chars };
  }
  return { status: 'thin', reason: `only ${chars} readable characters`, chars };
}

// Text lengths of pages that several sites share, e.g. one cookie or challenge
// screen used on every regional store. Matched by length only, so the label is
// a hint for a person to check, not proof.
export const SHARED_TEMPLATE_LENGTHS = Object.freeze({
  202: 'shared template (202 chars, seen on elgiganten and elkjop sites)',
  262: 'shared template (262-263 chars, seen on eBay sites)',
  263: 'shared template (262-263 chars, seen on eBay sites)',
});

// Open one site in its own tab, read it, close the tab, and classify the result.
// Waits `settleMs` after opening so client-rendered pages can finish. If the
// first read is only a placeholder (thin), waits `retryMs` and reads once more,
// keeping whichever read has more text.
export async function checkSite(client, site, { timeoutMs = 60000, sessionKey, settleMs = 3000, retryMs = 8000 } = {}) {
  const url = siteUrl(site);
  const started = Date.now();
  let tabId = null;
  let best = { snapshot: '', url };
  let error = null;
  let attempts = 0;
  try {
    await withTimeout((async () => {
      const tab = await client.openTab({ url, sessionKey: sessionKey || `coverage-${site}` });
      tabId = tab.tabId;
      await sleep(settleMs);
      const first = await client.snapshot(tabId);
      attempts = 1;
      best = pickLonger(best, first, url);
      if (classify({ snapshot: best.snapshot }).status === 'thin') {
        await sleep(retryMs);
        const second = await client.snapshot(tabId);
        attempts = 2;
        best = pickLonger(best, second, url);
      }
    })(), timeoutMs, site);
  } catch (err) {
    error = err;
  } finally {
    if (tabId) {
      try { await client.closeTab(tabId); } catch { /* best effort */ }
    }
  }
  const verdict = classify({ snapshot: best.snapshot, error });
  let status = verdict.status;
  let reason = verdict.reason;
  if (status === 'thin' && SHARED_TEMPLATE_LENGTHS[verdict.chars]) {
    status = 'template';
    reason = SHARED_TEMPLATE_LENGTHS[verdict.chars];
  }
  return {
    site,
    url,
    finalUrl: best.url || url,
    status,
    reason,
    chars: verdict.chars,
    attempts,
    ms: Date.now() - started,
    checkedAt: new Date(started).toISOString(),
  };
}

function pickLonger(current, next, fallbackUrl) {
  const nextText = String(next?.snapshot || '');
  return nextText.length > String(current.snapshot || '').length
    ? { snapshot: nextText, url: next?.url || fallbackUrl }
    : current;
}

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function withTimeout(promise, ms, site) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms}ms opening ${site}`);
      err.code = 'timeout';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Run checks for every site with a fixed concurrency. Results come back in the
// same order as `sites`. `onResult` is called as each site finishes.
export async function runCoverage(client, sites, {
  concurrency = 1,
  delayMs = 0,
  timeoutMs = 60000,
  settleMs = 3000,
  retryMs = 8000,
  onResult = () => {},
} = {}) {
  const results = new Array(sites.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < sites.length) {
      const index = next++;
      const result = await checkSite(client, sites[index], { timeoutMs, settleMs, retryMs });
      results[index] = result;
      onResult(result, index);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  });
  await Promise.all(workers);
  return results;
}

export function summarize(results) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const total = results.length;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total,
    counts,
    percent: Object.fromEntries(STATUSES.map((s) => [s, pct(counts[s])])),
    notLoaded: results.filter((r) => r.status !== 'loaded').map((r) => ({ site: r.site, status: r.status, reason: r.reason })),
  };
}

function csvCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(results) {
  const cols = ['site', 'status', 'chars', 'attempts', 'ms', 'finalUrl', 'reason', 'checkedAt'];
  const lines = [cols.join(',')];
  for (const r of results) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return lines.join('\n') + '\n';
}
