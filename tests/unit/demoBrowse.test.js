import { pickContentLinks } from '../../lib/demo-browse.js';

describe('pickContentLinks', () => {
  test('keeps story titles and skips site menus and comment counts', () => {
    const snap = [
      '- link "new" [e1]',
      '- link "comments" [e2]',
      '- link "Show HN: A small tool for reading papers" [e3]',
      '- link "Why the Rust compiler got faster this year" [e4]',
      '- link "142 comments" [e5]',
      '- link "Show HN: A small tool for reading papers" [e6]',
      '- link "login" [e7]',
    ].join('\n');
    expect(pickContentLinks(snap)).toEqual([
      { ref: 'e3', text: 'Show HN: A small tool for reading papers' },
      { ref: 'e4', text: 'Why the Rust compiler got faster this year' },
    ]);
  });

  test('empty input gives no links', () => {
    expect(pickContentLinks('')).toEqual([]);
  });
});
