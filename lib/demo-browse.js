// Helpers for the browsing demo: pick the links on a page that are worth
// clicking, and skip the site's own menus.

const MENU_WORDS = /^(new|past|comments?|ask|show|jobs|submit|login|logout|more|hide|flag|reply|next|prev|previous|home|about|faq|guidelines|lists|api|security|legal|apply to yc|contact|search)$/i;

// Returns [{ ref, text }] for links whose text looks like content (long enough,
// not a menu word, not a comment count).
export function pickContentLinks(snapshotText, { minChars = 20 } = {}) {
  const out = [];
  const seen = new Set();
  for (const line of String(snapshotText || '').split(/\r?\n/)) {
    const m = line.match(/- link "(.*?)" \[([^\]]+)\]/);
    if (!m) continue;
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (text.length < minChars) continue;
    if (MENU_WORDS.test(text) || /\d+\s+comments?$/i.test(text)) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ ref: m[2], text });
  }
  return out;
}
