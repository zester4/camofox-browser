import { parseRobots, normalizeLink, isSameSite, snapshotToMarkdown, crawlSite, toLlmDocument } from '../../lib/crawl.js';

describe('robots.txt', () => {
  test('a missing or empty file allows everything', () => {
    expect(parseRobots('').allows('/anything')).toBe(true);
  });

  test('disallow blocks matching paths, allow wins on the longer match', () => {
    const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/public\n');
    expect(r.allows('/private/secret')).toBe(false);
    expect(r.allows('/private/public/page')).toBe(true);
    expect(r.allows('/about')).toBe(true);
  });

  test('our agent name uses its own group over *', () => {
    const text = 'User-agent: *\nDisallow: /\n\nUser-agent: chuskybrowser\nDisallow: /shop\n';
    const r = parseRobots(text, 'chuskybrowser');
    expect(r.allows('/blog')).toBe(true);
    expect(r.allows('/shop/item')).toBe(false);
  });

  test('* wildcards and $ anchors work', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\n');
    expect(r.allows('/files/report.pdf')).toBe(false);
    expect(r.allows('/files/report.pdf.html')).toBe(true);
  });

  test('comments are ignored', () => {
    expect(parseRobots('User-agent: * # all\nDisallow: /x # no\n').allows('/x')).toBe(false);
  });
});

describe('links', () => {
  test('resolves relative links and drops fragments and non-http schemes', () => {
    expect(normalizeLink('/a#top', 'https://site.com/home')).toBe('https://site.com/a');
    expect(normalizeLink('mailto:x@y.com', 'https://site.com/')).toBeNull();
    expect(normalizeLink('javascript:void(0)', 'https://site.com/')).toBeNull();
  });

  test('same site ignores www and differs by host otherwise', () => {
    expect(isSameSite('https://www.site.com/x', 'https://site.com/')).toBe(true);
    expect(isSameSite('https://other.com/x', 'https://site.com/')).toBe(false);
  });
});

describe('snapshotToMarkdown', () => {
  test('turns headings, links and text into clean markdown without refs', () => {
    const snap = [
      '- heading "Widget Guide" [ref1]',
      '- text "Widgets are small parts."',
      '  - link "Installing" [ref2]',
      '  - link "Installing" [ref3]',
      '- button "Buy now" [ref4]',
      '- heading "Specs"',
    ].join('\n');
    const md = snapshotToMarkdown(snap);
    expect(md).toContain('## Widget Guide');
    expect(md).toContain('Widgets are small parts.');
    expect(md).toContain('- Installing');
    expect(md.match(/Installing/g).length).toBe(1);
    expect(md).toContain('- Buy now');
    expect(md).toContain('## Specs');
    expect(md).not.toMatch(/ref\d/);
    expect(md).not.toMatch(/\n{3,}/);
  });
});

// A fake site: a home page linking to two pages, one of them disallowed.
function mockApi(site, robotsText) {
  const tabs = new Map();
  let n = 0;
  const closed = [];
  return {
    closed,
    async openTab({ url }) { const id = 't' + ++n; tabs.set(id, url); return { tabId: id }; },
    async navigate(tabId, { url }) { tabs.set(tabId, url); },
    async snapshot(tabId) {
      const url = tabs.get(tabId);
      if (url.endsWith('/robots.txt')) return { url, snapshot: robotsText };
      const page = site[url];
      if (!page) throw new Error('404');
      return { url, snapshot: page.snapshot };
    },
    async links(tabId) {
      const url = tabs.get(tabId);
      const page = site[url];
      const links = (page?.links || []).map((h) => ({ url: new URL(h, url).href, text: h }));
      return { links, pagination: { total: links.length, offset: 0, limit: 200, hasMore: false } };
    },
    async closeTab(tabId) { closed.push(tabId); tabs.delete(tabId); },
  };
}

const longText = 'Useful content about the topic on this page. '.repeat(3);
const site = {
  'https://site.com/': { snapshot: `- heading "Home"\n- text "${longText}"`, links: ['/a', '/shop/item', 'https://other.com/x', '/a#again'] },
  'https://site.com/a': { snapshot: `- heading "Page A"\n- text "${longText}"`, links: ['/b', '/'] },
  'https://site.com/b': { snapshot: `- heading "Page B"\n- text "${longText}"`, links: [] },
  'https://site.com/shop/item': { snapshot: `- heading "Shop"`, links: [] },
};
const robots = 'User-agent: *\nDisallow: /shop\n';

describe('crawlSite', () => {
  test('follows same-site links, respects robots, and returns markdown per page', async () => {
    const api = mockApi(site, robots);
    const r = await crawlSite(api, 'https://site.com/', { maxPages: 10, maxDepth: 2 });
    expect(r.pages.map((p) => p.url)).toEqual(['https://site.com/', 'https://site.com/a', 'https://site.com/b']);
    expect(r.pages[1].title).toBe('Page A');
    expect(r.pages[1].depth).toBe(1);
    expect(r.pages[2].depth).toBe(2);
    expect(r.skipped).toEqual([{ url: 'https://site.com/shop/item', reason: 'disallowed by robots.txt' }]);
    expect(api.closed.length).toBe(1);
    expect(r.stoppedBy).toBe('complete');
  });

  test('maxPages caps the crawl and says so', async () => {
    const r = await crawlSite(mockApi(site, robots), 'https://site.com/', { maxPages: 2, maxDepth: 5 });
    expect(r.pages.length).toBe(2);
    expect(r.stoppedBy).toBe('maxPages');
  });

  test('maxDepth stops following links', async () => {
    const r = await crawlSite(mockApi(site, robots), 'https://site.com/', { maxPages: 10, maxDepth: 1 });
    expect(r.pages.map((p) => p.url)).toEqual(['https://site.com/', 'https://site.com/a']);
  });

  test('when robots.txt cannot be read, only the start page is crawled', async () => {
    const api = mockApi(site, '');
    api.navigate = async (tabId, { url }) => {
      if (url.endsWith('/robots.txt')) throw new Error('blocked');
      api.__tab = url;
      return undefined;
    };
    const r = await crawlSite({ ...api, snapshot: async (tabId) => ({ url: 'x', snapshot: site[api.__tab]?.snapshot || '' }), links: async () => ({ links: [{ url: 'https://site.com/a', text: 'a' }], pagination: { hasMore: false } }) }, 'https://site.com/', { maxPages: 10, maxDepth: 2 });
    expect(r.pages.length).toBe(1);
    expect(r.skipped[0].reason).toBe('robots.txt unreadable');
  });

  test('a page that errors is skipped, not fatal', async () => {
    const api = mockApi({ 'https://site.com/': { snapshot: `- text "${longText}"`, links: ['/missing'] } }, '');
    const r = await crawlSite(api, 'https://site.com/', { maxPages: 10, maxDepth: 2, respectRobots: false });
    expect(r.pages.length).toBe(1);
    expect(r.skipped[0].reason).toMatch(/^error: 404/);
  });

  test('llm document has a page map and each page in order', async () => {
    const r = await crawlSite(mockApi(site, robots), 'https://site.com/', { maxPages: 10, maxDepth: 1 });
    const doc = toLlmDocument(r);
    expect(doc).toContain('# Crawl of https://site.com/');
    expect(doc).toContain('- [Page A](https://site.com/a) (depth 1)');
    expect(doc.indexOf('# Page A')).toBeGreaterThan(doc.indexOf('## Pages'));
  });
});

import { folderOf, fixMojibake } from '../../lib/crawl.js';

describe('staying in the start folder', () => {
  test('folderOf gives the start URL folder', () => {
    expect(folderOf('https://docs.python.org/3/')).toBe('/3/');
    expect(folderOf('https://docs.python.org/3/download.html')).toBe('/3/');
    expect(folderOf('https://example.com')).toBe('/');
  });

  test('a crawl from /3/ does not follow links into other versions', async () => {
    const site3 = {
      'https://site.com/3/': { snapshot: `- text "${longText}"`, links: ['/3/a', '/2.7/', '/'] },
      'https://site.com/3/a': { snapshot: `- text "${longText}"`, links: ['/3/'] },
    };
    const r = await crawlSite(mockApi(site3, ''), 'https://site.com/3/', { maxPages: 10, maxDepth: 3, respectRobots: false });
    expect(r.pages.map((p) => p.url)).toEqual(['https://site.com/3/', 'https://site.com/3/a']);
    expect(r.options.pathPrefix).toBe('/3/');
  });
});

describe('navigation is left out of the markdown', () => {
  test('navigation, banner and footer blocks are dropped, content kept', () => {
    const snap = [
      '- banner "Site"',
      '  - link "Logo" [e1]',
      '- navigation "Main"',
      '  - link "Home" [e2]',
      '  - link "Versions" [e3]',
      '- heading "Tutorial"',
      '- text "Actual content."',
      '- contentinfo "Footer"',
      '  - link "Copyright" [e4]',
    ].join('\n');
    const md = snapshotToMarkdown(snap);
    expect(md).toContain('## Tutorial');
    expect(md).toContain('Actual content.');
    expect(md).not.toMatch(/Home|Versions|Logo|Copyright/);
  });
});

describe('garbled characters', () => {
  test('UTF-8 read as Windows-1252 is repaired', () => {
    expect(fixMojibake('Python Developerâ€™s Guide')).toBe('Python Developer’s Guide');
    expect(fixMojibake('cafÃ©')).toBe('café');
  });

  test('normal text is left alone', () => {
    expect(fixMojibake('Plain text with ünïcode already fine')).toBe('Plain text with ünïcode already fine');
  });
});

import { removeRepeatedLines } from '../../lib/crawl.js';

describe('repeated menus and footers', () => {
  test('lines that appear on most pages are removed; page content stays', () => {
    const page = (n) => ({ url: `https://s.com/${n}`, title: `P${n}`, depth: 1, chars: 0, markdown: `## Page ${n}\n\n- Home\n- Downloads\n- Copyright\n\nThe body of page ${n}.\n` });
    const out = removeRepeatedLines([page(1), page(2), page(3), page(4)]);
    for (const p of out) {
      expect(p.markdown).not.toMatch(/- Home|- Copyright/);
      expect(p.markdown).toMatch(/The body of page/);
      expect(p.markdown).toMatch(/## Page/);
    }
  });

  test('two pages are too few to decide what is boilerplate', () => {
    const pages = [{ markdown: '- Home\nA', chars: 0 }, { markdown: '- Home\nB', chars: 0 }];
    expect(removeRepeatedLines(pages)[0].markdown).toContain('- Home');
  });
});
