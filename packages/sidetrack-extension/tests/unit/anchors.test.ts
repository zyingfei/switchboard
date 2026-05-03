import { describe, expect, it } from 'vitest';

import { findAnchor, serializeAnchor } from '../../src/annotation/anchors';

const rangeForText = (doc: Document, text: string): Range => {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current !== null) {
    const index = current.textContent?.indexOf(text) ?? -1;
    if (index >= 0) {
      const range = doc.createRange();
      range.setStart(current, index);
      range.setEnd(current, index + text.length);
      return range;
    }
    current = walker.nextNode();
  }
  throw new Error(`Missing text: ${text}`);
};

describe('annotation anchors', () => {
  it('round-trips serialize and find on a synthetic DOM', () => {
    document.body.innerHTML = '<main><p>Alpha beta gamma delta</p></main>';
    const anchor = serializeAnchor(rangeForText(document, 'beta gamma'));
    const restored = findAnchor(document.documentElement, anchor);

    expect(restored?.toString()).toBe('beta gamma');
  });

  it('resolves via TextQuote after DOM structure changes', () => {
    document.body.innerHTML = '<main><p>Alpha beta gamma delta</p></main>';
    const anchor = serializeAnchor(rangeForText(document, 'beta gamma'));
    document.body.innerHTML = '<article><section>Alpha beta gamma delta</section></article>';

    expect(findAnchor(document.documentElement, anchor)?.toString()).toBe('beta gamma');
  });

  it('uses the leftmost exact match when prefix and suffix are ambiguous', () => {
    document.body.innerHTML = '<p>same target same target</p>';
    const anchor = {
      textQuote: { exact: 'target', prefix: 'same ', suffix: '' },
      textPosition: { start: 999, end: 1005 },
      cssSelector: 'p',
    };

    const restored = findAnchor(document.documentElement, anchor);

    expect(restored?.toString()).toBe('target');
    expect(restored?.startOffset).toBe(5);
  });

  it('returns null for malformed no-match anchors', () => {
    document.body.innerHTML = '<p>Nothing useful</p>';
    const anchor = {
      textQuote: { exact: 'absent', prefix: 'x', suffix: 'y' },
      textPosition: { start: 999, end: 1000 },
      cssSelector: '%%% bad selector',
    };

    expect(findAnchor(document.documentElement, anchor)).toBeNull();
  });
});
