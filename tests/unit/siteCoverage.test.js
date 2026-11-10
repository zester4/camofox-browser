import fs from 'node:fs';
import { loadSites, classify, checkSite, runCoverage, summarize, toCsv, siteUrl } from '../../lib/site-coverage.js';

const LONG = 'Product details and pricing for the item you searched for. '.repeat(12);

function mockClient(pages = {}) {
  const closed = [];
  const opened = [];
  return {
    closed,
    opened,
    async openTab({ url, sessionKey }) {
      const host = new URL(url).hostname;
      opened.push({ url, sessionKey });
      const page = pages[host];
      if (page instanceof Error) throw page;
      if (page === 'hang') return new Promise(() => {});
      return { tabId: `tab-${host}` };
    },
    async snapshot(tabId) {
      const host = tabId.replace('tab-', '');
      const page = pages[host];
      return { url: `https://${host}/`, snapshot: typeof page === 'string' && page !== 'hang' ? page : LONG };
    },
    async closeTab(tabId) { closed.push(tabId); },
  };
}

describe('loadSites', () => {
  test('trims, lowercases, drops blanks and comments, and de-duplicates', () => {
    const text = '\nNike.com\n# comment\nwalmart.com\r\nnike.com\n\n  target.com  \n';
    expect(loadSites(text)).toEqual(['nike.com', 'walmart.com', 'target.com']);
  });

  test('the bundled 500-site list loads with no duplicates', () => {
    const sites = loadSites(fs.readFileSync(process.cwd() + '/scripts/data/coverage-sites.txt', 'utf8'));
    expect(sites.length).toBe(500);
    expect(new Set(sites).size).toBe(500);
    expect(sites[0]).toBe('nike.com');
  });
});

describe('siteUrl', () => {
  test('adds https unless a scheme is given', () => {
    expect(siteUrl('nike.com')).toBe('https://nike.com');
    expect(siteUrl('http://example.com')).toBe('http://example.com');
  });
});

describe('classify', () => {
  test('long readable text is loaded', () => {
    expect(classify({ snapshot: LONG }).status).toBe('loaded');
  });

  test('short block page text is blocked, and says why', () => {
    const r = classify({ snapshot: 'Access Denied. You don\'t have permission to access this page.' });
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/access denied/i);
  });

  test('a long article that mentions a captcha is still loaded', () => {
    const article = LONG.repeat(3) + ' Some sites use a captcha to stop bots. ' + LONG.repeat(2);
    expect(classify({ snapshot: article }).status).toBe('loaded');
  });

  test('short text without a block pattern is thin', () => {
    const r = classify({ snapshot: 'Welcome' });
    expect(r.status).toBe('thin');
    expect(r.chars).toBe(7);
  });

  test('empty page is thin, not loaded', () => {
    expect(classify({ snapshot: '' }).status).toBe('thin');
  });

  test('timeouts and other errors are separated', () => {
    const t = Object.assign(new Error('timed out after 60000ms'), { code: 'timeout' });
    expect(classify({ error: t }).status).toBe('timeout');
    expect(classify({ error: new Error('Chusky POST /tabs failed (HTTP 500)') }).status).toBe('error');
  });
});

describe('checkSite', () => {
  test('opens, reads, closes the tab, and reports a loaded site', async () => {
    const client = mockClient({ 'nike.com': LONG });
    const r = await checkSite(client, 'nike.com', { settleMs: 0, retryMs: 0 });
    expect(r.status).toBe('loaded');
    expect(r.url).toBe('https://nike.com');
    expect(client.opened[0].sessionKey).toBe('coverage-nike.com');
    expect(client.closed).toEqual(['tab-nike.com']);
  });

  test('a site that errors on open is recorded as error and still does not throw', async () => {
    const client = mockClient({ 'bad.com': new Error('Chusky POST /tabs failed (HTTP 500)') });
    const r = await checkSite(client, 'bad.com', { settleMs: 0, retryMs: 0 });
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/HTTP 500/);
    expect(client.closed).toEqual([]);
  });

  test('a page that never answers is recorded as timeout', async () => {
    const client = mockClient({ 'slow.com': 'hang' });
    const r = await checkSite(client, 'slow.com', { timeoutMs: 20, settleMs: 0, retryMs: 0 });
    expect(r.status).toBe('timeout');
  });
});

describe('runCoverage', () => {
  test('keeps input order, respects concurrency, and reports each result', async () => {
    const pages = { 'a.com': LONG, 'b.com': 'Access Denied', 'c.com': 'hi', 'd.com': LONG };
    const client = mockClient(pages);
    const seen = [];
    const results = await runCoverage(client, ['a.com', 'b.com', 'c.com', 'd.com'], {
      concurrency: 3,
      onResult: (r) => seen.push(r.site),
    });
    expect(results.map((r) => r.site)).toEqual(['a.com', 'b.com', 'c.com', 'd.com']);
    expect(results.map((r) => r.status)).toEqual(['loaded', 'blocked', 'thin', 'loaded']);
    expect(seen.sort()).toEqual(['a.com', 'b.com', 'c.com', 'd.com']);
    expect(client.closed.length).toBe(4);
  });
});

describe('summarize and toCsv', () => {
  const results = [
    { site: 'a.com', status: 'loaded', reason: '', chars: 900, ms: 10, finalUrl: 'https://a.com/', checkedAt: 'x' },
    { site: 'b.com', status: 'blocked', reason: 'block page text matched /access denied/i', chars: 40, ms: 12, finalUrl: 'https://b.com/', checkedAt: 'x' },
    { site: 'c.com', status: 'timeout', reason: 'timed out, slow', chars: 0, ms: 60000, finalUrl: 'https://c.com', checkedAt: 'x' },
    { site: 'd.com', status: 'loaded', reason: '', chars: 800, ms: 11, finalUrl: 'https://d.com/', checkedAt: 'x' },
  ];

  test('counts statuses and lists everything that did not load', () => {
    const s = summarize(results);
    expect(s.total).toBe(4);
    expect(s.counts.loaded).toBe(2);
    expect(s.percent.loaded).toBe(50);
    expect(s.notLoaded.map((x) => x.site)).toEqual(['b.com', 'c.com']);
  });

  test('CSV quotes cells with commas and quotes', () => {
    const csv = toCsv(results);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('site,status,chars,attempts,ms,finalUrl,reason,checkedAt');
    expect(lines[3]).toContain('"timed out, slow"');
    expect(lines[2]).toContain('block page text matched /access denied/i,x');
  });
});

describe('checkSite retry and labels', () => {
  function scripted(snapshots) {
    const calls = { snapshot: 0, closed: 0 };
    return {
      calls,
      async openTab() { return { tabId: 'T' }; },
      async snapshot() { const v = snapshots[Math.min(calls.snapshot, snapshots.length - 1)]; calls.snapshot++; return { url: 'https://x.com/', snapshot: v }; },
      async closeTab() { calls.closed++; },
    };
  }

  test('a placeholder first read is retried, and the longer read wins', async () => {
    const client = scripted(['Loading', LONG]);
    const r = await checkSite(client, 'x.com', { settleMs: 0, retryMs: 0 });
    expect(client.calls.snapshot).toBe(2);
    expect(r.attempts).toBe(2);
    expect(r.status).toBe('loaded');
  });

  test('a page that is loaded on the first read is not retried', async () => {
    const client = scripted([LONG]);
    const r = await checkSite(client, 'x.com', { settleMs: 0, retryMs: 0 });
    expect(client.calls.snapshot).toBe(1);
    expect(r.attempts).toBe(1);
  });

  test('a thin page with the eBay template length is labelled template', async () => {
    const text = 'x'.repeat(262);
    const client = scripted([text]);
    const r = await checkSite(client, 'ebay.com', { settleMs: 0, retryMs: 0 });
    expect(r.status).toBe('template');
    expect(r.reason).toMatch(/eBay/);
  });

  test('a thin page with no known length stays thin', async () => {
    const client = scripted(['Hello']);
    const r = await checkSite(client, 'x.com', { settleMs: 0, retryMs: 0 });
    expect(r.status).toBe('thin');
  });
});
