import { describe, expect, it } from 'vitest';

import { canonicalizeUrl } from './canonical-url';

describe('canonicalizeUrl', () => {
  it('normalizes stable URL identity and strips known tracking parameters', () => {
    const cases: readonly [string, string][] = [
      ['HTTP://Example.COM/a', 'http://example.com/a'],
      ['https://EXAMPLE.com/a', 'https://example.com/a'],
      ['http://example.com:80/a', 'http://example.com/a'],
      ['https://example.com:443/a', 'https://example.com/a'],
      ['https://example.com:8443/a', 'https://example.com:8443/a'],
      ['https://example.com/a#section', 'https://example.com/a'],
      ['https://example.com/a?utm_source=x', 'https://example.com/a'],
      ['https://example.com/a?utm_medium=x', 'https://example.com/a'],
      ['https://example.com/a?utm_campaign=x', 'https://example.com/a'],
      ['https://example.com/a?utm_term=x', 'https://example.com/a'],
      ['https://example.com/a?utm_content=x', 'https://example.com/a'],
      ['https://example.com/a?UTM_SOURCE=x', 'https://example.com/a'],
      ['https://example.com/a?fbclid=x', 'https://example.com/a'],
      ['https://example.com/a?gclid=x', 'https://example.com/a'],
      ['https://example.com/a?srsltid=x', 'https://example.com/a'],
      ['https://example.com/a?mc_cid=x', 'https://example.com/a'],
      ['https://example.com/a?mc_eid=x', 'https://example.com/a'],
      ['https://example.com/a?_ga=x', 'https://example.com/a'],
      ['https://example.com/a?_gid=x', 'https://example.com/a'],
      ['https://example.com/a?q=keep&utm_source=x', 'https://example.com/a?q=keep'],
      ['https://example.com/a?utm_source=x&q=keep', 'https://example.com/a?q=keep'],
      ['https://example.com/a?q=keep&fbclid=x', 'https://example.com/a?q=keep'],
      ['https://example.com/a?fbclid=x&q=keep', 'https://example.com/a?q=keep'],
      ['https://example.com/a?q=keep&gclid=x&r=2', 'https://example.com/a?q=keep&r=2'],
      ['https://example.com/a?mc_cid=x&mc_eid=y&q=keep', 'https://example.com/a?q=keep'],
      ['https://example.com/a?keep=utm_source', 'https://example.com/a?keep=utm_source'],
      ['https://example.com/a?utm_source=x#frag', 'https://example.com/a'],
      [' https://EXAMPLE.com:443/a?Q=1&utm_id=x#frag ', 'https://example.com/a?Q=1'],
      ['https://example.com/', 'https://example.com/'],
      ['not a url#fragment', 'not a url'],
      ['', ''],
    ];

    for (const [input, expected] of cases) {
      expect(canonicalizeUrl(input)).toBe(expected);
    }
  });
});
