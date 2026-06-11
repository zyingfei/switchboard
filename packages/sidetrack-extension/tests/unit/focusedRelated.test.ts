import { describe, expect, it } from 'vitest';

import { buildFocusedRelatedItems } from '../../src/sidepanel/focusedRelated';

// Pure-mapper contract for the Now-card Related strip. The hook around
// it is thin (debounce + cache + bridge message); the correctness
// surface is this mapping: self-suppression incl. slash-variant drift,
// dedupe, label fallback, cap, and garbage tolerance.

const SELF = 'https://example.com/page';

describe('buildFocusedRelatedItems', () => {
  it('maps canonicalUrl + title results to link items', () => {
    const items = buildFocusedRelatedItems(
      [
        { canonicalUrl: 'https://other.com/a', title: 'Other A' },
        { canonicalUrl: 'https://other.com/b', title: 'Other B' },
      ],
      SELF,
    );
    expect(items).toEqual([
      { url: 'https://other.com/a', label: 'Other A' },
      { url: 'https://other.com/b', label: 'Other B' },
    ]);
  });

  it('suppresses the focused url including trailing-slash variants', () => {
    const items = buildFocusedRelatedItems(
      [
        { canonicalUrl: SELF, title: 'Self exact' },
        { canonicalUrl: `${SELF}/`, title: 'Self slash variant' },
        { canonicalUrl: 'https://other.com/a', title: 'Keep me' },
      ],
      SELF,
    );
    expect(items).toEqual([{ url: 'https://other.com/a', label: 'Keep me' }]);
  });

  it('suppresses slash variants when the focused url has the slash', () => {
    const items = buildFocusedRelatedItems(
      [{ canonicalUrl: 'https://openfeature.dev', title: 'Self no slash' }],
      'https://openfeature.dev/',
    );
    expect(items).toEqual([]);
  });

  it('dedupes results that differ only by trailing slash', () => {
    const items = buildFocusedRelatedItems(
      [
        { canonicalUrl: 'https://other.com/a', title: 'First' },
        { canonicalUrl: 'https://other.com/a/', title: 'Duplicate' },
      ],
      SELF,
    );
    expect(items).toEqual([{ url: 'https://other.com/a', label: 'First' }]);
  });

  it('falls back to the url when title is missing or blank', () => {
    const items = buildFocusedRelatedItems(
      [
        { canonicalUrl: 'https://other.com/untitled' },
        { canonicalUrl: 'https://other.com/blank', title: '   ' },
      ],
      SELF,
    );
    expect(items).toEqual([
      { url: 'https://other.com/untitled', label: 'https://other.com/untitled' },
      { url: 'https://other.com/blank', label: 'https://other.com/blank' },
    ]);
  });

  it('caps at max items', () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      canonicalUrl: `https://other.com/${String(i)}`,
      title: `Item ${String(i)}`,
    }));
    expect(buildFocusedRelatedItems(results, SELF, 6)).toHaveLength(6);
    expect(buildFocusedRelatedItems(results, SELF, 3)).toHaveLength(3);
  });

  it('skips malformed rows and non-http urls', () => {
    const items = buildFocusedRelatedItems(
      [
        null,
        42,
        'string-row',
        {},
        { canonicalUrl: 17, title: 'numeric url' },
        { canonicalUrl: 'chrome-extension://abc/page.html', title: 'extension page' },
        { canonicalUrl: 'about:blank', title: 'about' },
        { canonicalUrl: 'https://other.com/ok', title: 'OK' },
      ],
      SELF,
    );
    expect(items).toEqual([{ url: 'https://other.com/ok', label: 'OK' }]);
  });
});
