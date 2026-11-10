// Crawl a site and return clean markdown for each page, ready for an LLM.
//
// The crawler is pure logic plus an `api` object with these methods:
//   openTab({ url, sessionKey }) -> { tabId }
//   navigate(tabId, { url, sessionKey })
//   snapshot(tabId) -> { url, snapshot }
//   links(tabId, { offset, limit }) -> { links: [{ url, text }], pagination: { hasMore } }
//   closeTab(tabId)
// The CLI (scripts/crawl.mjs) builds that object from the REST API. Tests pass a mock.

export const DEFAULTS = Object.freeze({
  maxPages: 20,
  maxDepth: 2,
  sameHostOnly: true,
  respectRobots: true,
  userAgentToken: 'chuskybrowser',
  linksPageSize: 200,
  pathPrefix: null, // null = the folder of the start URL, e.g. /3/ for https://docs.python.org/3/
});

const HARD_MAX_PAGES = 200;
const HARD_MAX_DEPTH = 5;

// ---------- robots.txt ----------

// Returns { allows(path) }. Follows the common rules: the group for our agent
// name wins over "*", the longest matching rule wins, and Allow beats Disallow
// on a tie. An empty or missing file allows everything.
export function parseRobots(text, userAgentToken = DEFAULTS.userAgentToken) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) { lastWasAgent = false; continue; }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }

  const token = userAgentToken.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = specific || wildcard;
  const rules = group ? group.rules : [];

  return {
    allows(path) {
      let best = null;
      for (const rule of rules) {
        if (rule.path === '') continue; // "Disallow:" with no value allows everything
        if (!pathMatches(rule.path, path)) continue;
        if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

function pathMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + body.split('*').map(escapeRe).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- links ----------

// Normalise a link found on a page. Returns an absolute http(s) URL without a
// fragment, or null for anything else (mailto:, javascript:, etc.).
export function normalizeLink(href, base) {
  let url;
  try { url = new URL(href, base); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href;
}

function hostKey(host) {
  return host.toLowerCase().replace(/^www\./, '');
}

export function isSameSite(url, startUrl) {
  try {
    return hostKey(new URL(url).hostname) === hostKey(new URL(startUrl).hostname);
  } catch { return false; }
}

// ---------- snapshot -> markdown ----------

// Turns the page's accessibility snapshot (lines such as `- heading "X"` and
// `  - link "text" [ref3]`) into plain markdown: headings, list items and
// paragraphs. Element refs are dropped and repeated lines are removed.
const CHROME_ROLE = /^\s*- (navigation|banner|contentinfo|complementary|search|menubar|toolbar|menu)\b/;

export function snapshotToMarkdown(snapshotText) {
  const out = [];
  const seen = new Set();
  let lastBlank = true;
  let skipBelow = null; // indent of a navigation/banner/footer/sidebar block we are inside
  const push = (line) => {
    if (!line) {
      if (!lastBlank) out.push('');
      lastBlank = true;
      return;
    }
    if (seen.has(line)) return;
    seen.add(line);
    out.push(line);
    lastBlank = false;
  };

  for (const raw of String(snapshotText || '').split(/\r?\n/)) {
    const indent = raw.length - raw.trimStart().length;
    const depth = Math.floor(indent / 2);
    const line = raw.trim();
    if (!line) { if (skipBelow === null) push(''); continue; }
    if (skipBelow !== null) {
      if (indent > skipBelow) continue;
      skipBelow = null;
    }
    if (CHROME_ROLE.test(raw)) { skipBelow = indent; continue; }

    const heading = line.match(/^- heading "(.*)"/);
    if (heading) { push(''); push(`## ${cleanText(heading[1])}`); push(''); continue; }

    const link = line.match(/^- link "(.*?)"/);
    if (link) {
      const text = cleanText(link[1]);
      if (text) push(`${'  '.repeat(Math.min(depth, 4))}- ${text}`);
      continue;
    }

    const other = line.match(/^- (\w+) "(.*)"/);
    if (other) {
      const text = cleanText(other[2]);
      if (!text) continue;
      if (/^(text|paragraph|StaticText)$/i.test(other[1])) push(text);
      else push(`${'  '.repeat(Math.min(depth, 4))}- ${text}`);
      continue;
    }

    // Lines without a quoted name, e.g. structural labels, are kept only when
    // they read as text.
    if (/^- /.test(line)) continue;
    push(cleanText(line.replace(/\s*\[ref[^\]]*\]\s*$/, '')));
  }

  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// Reverse of Windows-1252 for the bytes 0x80-0x9F, which latin1 decoding gets wrong.
const CP1252 = new Map(Object.entries({
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89,
  'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
}).map(([ch, b]) => [ch, b]));

export function fixMojibake(text) {
  const str = String(text);
  if (!/[ÃÂâÐÑ]/.test(str)) return str;
  const bytes = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 256) bytes.push(code);
    else if (CP1252.has(ch)) bytes.push(CP1252.get(ch));
    else return str;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return str;
  }
}

function cleanText(s) {
  return fixMojibake(s)
    .replace(/\\"/g, '"')
    .replace(/\s*\[ref[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- robots lookup ----------

async function loadRobots(api, origin, state) {
  if (state.robots.has(origin)) return state.robots.get(origin);
  let robots;
  try {
    await api.navigate(state.tabId, { url: origin + '/robots.txt', sessionKey: state.sessionKey });
    const snap = await api.snapshot(state.tabId);
    const text = snap?.snapshot || '';
    robots = parseRobots(text);
  } catch {
    // Could not read robots.txt. Stay on the start page rather than guess.
    robots = null;
  }
  state.robots.set(origin, robots);
  return robots;
}

// ---------- crawl ----------

export async function crawlSite(api, startUrl, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const maxPages = clamp(opts.maxPages, 1, HARD_MAX_PAGES);
  const maxDepth = clamp(opts.maxDepth, 0, HARD_MAX_DEPTH);
  const start = normalizeLink(startUrl, startUrl);
  if (!start) throw new Error(`Not an http(s) URL: ${startUrl}`);

  const prefix = opts.pathPrefix || folderOf(start);
  const sessionKey = opts.sessionKey || `crawl-${Date.now()}`;
  const state = { tabId: null, sessionKey, robots: new Map() };
  const pages = [];
  const skipped = [];
  const queued = new Set([start]);
  const queue = [{ url: start, depth: 0 }];

  const opened = await api.openTab({ url: start, sessionKey });
  state.tabId = opened.tabId;

  try {
    while (queue.length && pages.length < maxPages) {
      const { url, depth } = queue.shift();
      const origin = new URL(url).origin;

      if (opts.respectRobots) {
        const robots = await loadRobots(api, origin, state);
        const path = new URL(url).pathname + new URL(url).search;
        if (robots === null && url !== start) { skipped.push({ url, reason: 'robots.txt unreadable' }); continue; }
        if (robots && !robots.allows(path)) { skipped.push({ url, reason: 'disallowed by robots.txt' }); continue; }
      }

      try {
        await api.navigate(state.tabId, { url, sessionKey });
        const snap = await api.snapshot(state.tabId);
        const pageLinks = await allLinks(api, state.tabId, opts.linksPageSize);
        const title = snapshotTitle(snap?.snapshot);
        const markdown = snapshotToMarkdown(snap?.snapshot);
        pages.push({
          url: snap?.url || url,
          title,
          depth,
          markdown,
          chars: markdown.length,
        });

        if (depth < maxDepth) {
          for (const link of pageLinks) {
            const next = normalizeLink(link.url, url);
            if (!next || queued.has(next)) continue;
            if (opts.sameHostOnly && !isSameSite(next, start)) continue;
            if (!new URL(next).pathname.startsWith(prefix)) continue;
            queued.add(next);
            queue.push({ url: next, depth: depth + 1 });
          }
        }
      } catch (err) {
        skipped.push({ url, reason: `error: ${String(err.message || err).slice(0, 200)}` });
      }
    }
  } finally {
    try { await api.closeTab(state.tabId); } catch { /* best effort */ }
  }

  return {
    startUrl: start,
    pages: removeRepeatedLines(pages),
    skipped,
    stoppedBy: pages.length >= maxPages ? 'maxPages' : 'complete',
    options: { maxPages, maxDepth, sameHostOnly: !!opts.sameHostOnly, respectRobots: !!opts.respectRobots, pathPrefix: prefix },
  };
}

async function allLinks(api, tabId, pageSize) {
  const out = [];
  let offset = 0;
  for (let guard = 0; guard < 50; guard++) {
    const res = await api.links(tabId, { offset, limit: pageSize });
    const batch = res?.links || [];
    out.push(...batch);
    if (!res?.pagination?.hasMore || batch.length === 0) break;
    offset += batch.length;
  }
  return out;
}

function snapshotTitle(text) {
  const m = String(text || '').match(/^- heading "(.*?)"/m);
  return m ? cleanText(m[1]) : '';
}

// Removes lines that appear on most of the crawled pages. Site menus, sidebars
// and footers repeat on every page and are not part of any one page's content.
// Only applies when there are at least 3 pages, and only to short lines.
export function removeRepeatedLines(pages, { share = 0.5, minPages = 3, maxChars = 160 } = {}) {
  if (pages.length < minPages) return pages;
  const counts = new Map();
  for (const p of pages) {
    const unique = new Set(p.markdown.split('\n').map((l) => l.trim()).filter((l) => l && l.length <= maxChars && !l.startsWith('#')));
    for (const l of unique) counts.set(l, (counts.get(l) || 0) + 1);
  }
  const boilerplate = new Set([...counts].filter(([, n]) => n / pages.length >= share).map(([l]) => l));
  return pages.map((p) => {
    const kept = p.markdown.split('\n').filter((l) => !boilerplate.has(l.trim()));
    const markdown = kept.join('\n').replace(/\n{3,}/g, '\n\n');
    return { ...p, markdown, chars: markdown.length };
  });
}

export function folderOf(url) {
  const path = new URL(url).pathname;
  return path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1) || '/';
}

function clamp(n, lo, hi) {
  const v = Number.isFinite(Number(n)) ? Number(n) : lo;
  return Math.min(hi, Math.max(lo, v));
}

// ---------- output ----------

// One markdown document with a map of every page at the top, so an agent can
// load the whole crawl in one read.
export function toLlmDocument(result) {
  const lines = [`# Crawl of ${result.startUrl}`, '', `${result.pages.length} page(s). Stopped: ${result.stoppedBy}.`, '', '## Pages', ''];
  for (const p of result.pages) lines.push(`- [${p.title || p.url}](${p.url}) (depth ${p.depth})`);
  for (const p of result.pages) {
    lines.push('', '---', '', `# ${p.title || p.url}`, '', `Source: ${p.url}`, '', p.markdown.trimEnd());
  }
  return lines.join('\n') + '\n';
}
