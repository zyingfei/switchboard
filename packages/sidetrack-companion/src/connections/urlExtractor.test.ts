import { describe, expect, it } from 'vitest';

import { extractUrlsFromText } from './urlExtractor.js';

describe('connections — urlExtractor', () => {
  it('extracts a bare https URL', () => {
    expect(extractUrlsFromText('see https://example.com/page for details')).toEqual([
      'https://example.com/page',
    ]);
  });

  it('strips fragments and auth-token query params', () => {
    const out = extractUrlsFromText(
      'try https://example.com/page?token=abc&keep=1#section-2 here',
    );
    expect(out).toEqual(['https://example.com/page?keep=1']);
  });

  it('extracts URL from markdown-link form `[label](url)`', () => {
    const out = extractUrlsFromText('see [the docs](https://example.com/docs) for more');
    expect(out).toEqual(['https://example.com/docs']);
  });

  it('dedupes by canonical form', () => {
    const out = extractUrlsFromText(
      'first https://example.com/p#a then https://example.com/p#b again https://example.com/p/',
    );
    expect(out).toEqual(['https://example.com/p']);
  });

  it('caps at 32 URLs per call', () => {
    const urls: string[] = [];
    for (let i = 0; i < 50; i += 1) urls.push(`https://e${String(i)}.com`);
    const out = extractUrlsFromText(urls.join(' '));
    expect(out.length).toBe(32);
    // First 32 are kept, in input order.
    expect(out[0]).toBe('https://e0.com');
    expect(out[31]).toBe('https://e31.com');
  });

  it('drops malformed inputs ("not a url", bare scheme)', () => {
    expect(extractUrlsFromText('not a url here')).toEqual([]);
    expect(extractUrlsFromText('http:// is broken')).toEqual([]);
  });

  it('trims trailing punctuation', () => {
    const out = extractUrlsFromText('check https://example.com/path. and https://x.com/y!');
    expect(out).toEqual(['https://example.com/path', 'https://x.com/y']);
  });

  it('returns empty for empty / non-string input', () => {
    expect(extractUrlsFromText('')).toEqual([]);
    // @ts-expect-error - exercising defensive guard
    expect(extractUrlsFromText(undefined)).toEqual([]);
  });
});
