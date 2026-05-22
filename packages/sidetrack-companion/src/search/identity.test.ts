import { describe, expect, it } from 'vitest';

import {
  isBase58Like,
  isHexDigest,
  isIsoDateLike,
  isMixedAlnumOpaque,
  isNumericTimestamp,
  isShortHexId,
  isSingleChar,
  isStructuralIdentifier,
  isUlid,
  isUuid,
  parseUrlIdentity,
  urlIdentitySimilarity,
} from './identity.js';

describe('identity classifiers', () => {
  describe('isUuid', () => {
    it('matches RFC 4122 UUID-shaped strings', () => {
      expect(isUuid('6a0ca209-f794-8329-8786-8d26494572e0')).toBe(true);
      expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
      expect(isUuid('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(true);
    });
    it('rejects non-UUID shapes', () => {
      expect(isUuid('6a0ca209f7948329')).toBe(false);
      expect(isUuid('linux-kernel-cve')).toBe(false);
      expect(isUuid('not-a-uuid')).toBe(false);
    });
  });

  describe('isUlid', () => {
    it('matches 26-char Crockford base32', () => {
      expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    });
    it('rejects natural words and other ids', () => {
      expect(isUlid('chatgpt')).toBe(false);
      expect(isUlid('6a0ca209-f794-8329-8786-8d26494572e0')).toBe(false);
    });
  });

  describe('isHexDigest', () => {
    it('matches SHA-1 (40), SHA-256 (64), MD5 (32) digests', () => {
      expect(isHexDigest('a'.repeat(40))).toBe(true);
      expect(isHexDigest('0123456789abcdef'.repeat(2))).toBe(true); // 32 chars
      expect(isHexDigest('0123456789abcdef'.repeat(4))).toBe(true); // 64 chars
    });
    it('rejects shorter strings', () => {
      expect(isHexDigest('a'.repeat(31))).toBe(false);
      expect(isHexDigest('linux')).toBe(false);
    });
  });

  describe('isShortHexId', () => {
    it('matches 16-31 char hex strings', () => {
      expect(isShortHexId('a'.repeat(16))).toBe(true);
      expect(isShortHexId('0123456789abcdef')).toBe(true);
      expect(isShortHexId('a'.repeat(24))).toBe(true);
    });
    it('rejects strings under 16 chars or with non-hex', () => {
      expect(isShortHexId('a'.repeat(15))).toBe(false);
      expect(isShortHexId('linuxkernel00000')).toBe(false); // has g+
      expect(isShortHexId('decade')).toBe(false);
    });
  });

  describe('isNumericTimestamp', () => {
    it('matches 10-digit (epoch seconds) and 13-digit (millis)', () => {
      expect(isNumericTimestamp('1779311908')).toBe(true);
      expect(isNumericTimestamp('1779311908950')).toBe(true);
    });
    it('rejects other digit counts', () => {
      expect(isNumericTimestamp('123')).toBe(false);
      expect(isNumericTimestamp('17793119089501')).toBe(false); // 14
    });
  });

  describe('isIsoDateLike', () => {
    it('matches calendar dates and datetime prefixes', () => {
      expect(isIsoDateLike('2026-05-20')).toBe(true);
      expect(isIsoDateLike('2026-05-20T10:00:00')).toBe(true);
    });
    it('rejects non-date strings', () => {
      expect(isIsoDateLike('2026-05-2A')).toBe(false);
      expect(isIsoDateLike('not-a-date')).toBe(false);
    });
  });

  describe('isBase58Like', () => {
    it('matches long base58 with at least one digit', () => {
      expect(isBase58Like('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    });
    it('rejects long pure-alpha (no digit)', () => {
      expect(isBase58Like('Justifications')).toBe(false);
    });
    it('rejects strings with disallowed base58 chars', () => {
      expect(isBase58Like('0123456789abcdefghijklmn')).toBe(false); // has 0
    });
  });

  describe('isSingleChar', () => {
    it('catches single-char path letters', () => {
      expect(isSingleChar('c')).toBe(true);
      expect(isSingleChar('a')).toBe(true);
    });
    it('does not catch longer tokens', () => {
      expect(isSingleChar('cc')).toBe(false);
    });
  });

  describe('isMixedAlnumOpaque', () => {
    it('catches scrambled alnum like cs_live_a1rV95tH1R8esch5Y suffix', () => {
      // The opaque part after `cs_live_` in
      // chatgpt.com/checkout/openai_llc/cs_live_a1rV95tH1R8esch5Y
      expect(isMixedAlnumOpaque('a1rV95tH1R8esch5Y')).toBe(true);
    });
    it('does not catch words even if long', () => {
      expect(isMixedAlnumOpaque('authentication')).toBe(false); // no digits
      expect(isMixedAlnumOpaque('cve')).toBe(false); // too short
    });
    it('does not catch tokens with natural vowel-bearing 4-char windows', () => {
      // "react18alpha2" has "react" → vowel-bearing window present
      expect(isMixedAlnumOpaque('react18alpha2')).toBe(false);
    });
  });

  describe('isStructuralIdentifier (combined)', () => {
    it('catches the canonical opaque tokens from the v2 pool failure', () => {
      // chatgpt.com/c/6a0ca209-f794-8329-8786-8d26494572e0
      expect(isStructuralIdentifier('c')).toBe(true);
      expect(isStructuralIdentifier('6a0ca209-f794-8329-8786-8d26494572e0')).toBe(true);
      // gemini.google.com/app/793023ce95e54c30
      expect(isStructuralIdentifier('app')).toBe(false); // natural word, slug-eligible
      expect(isStructuralIdentifier('793023ce95e54c30')).toBe(true); // 16-char hex
      // chatgpt.com/checkout/openai_llc/cs_live_a1rV95tH1R8esch5Y — the
      // checkout / openai_llc / cs_live are normal-ish words; the
      // suffix is opaque.
      expect(isStructuralIdentifier('checkout')).toBe(false);
      expect(isStructuralIdentifier('openai_llc')).toBe(false);
    });

    it('does not catch natural-language slugs', () => {
      expect(isStructuralIdentifier('security')).toBe(false);
      expect(isStructuralIdentifier('kernel')).toBe(false);
      expect(isStructuralIdentifier('cve')).toBe(false); // 3 chars but not single-char
      expect(isStructuralIdentifier('security-bulletins')).toBe(false);
      expect(isStructuralIdentifier('react-router-bug')).toBe(false);
    });
  });
});

describe('parseUrlIdentity', () => {
  it('extracts host, pathSegments, queryKeys', () => {
    const out = parseUrlIdentity('https://aws.amazon.com/security/bulletins/2026-029?lang=en&v=2');
    expect(out).not.toBeNull();
    expect(out?.host).toBe('aws.amazon.com');
    expect(out?.pathSegments).toEqual(['security', 'bulletins', '2026-029']);
    expect(out?.queryKeys).toEqual(['lang', 'v']);
  });

  it('strips www.', () => {
    expect(parseUrlIdentity('https://www.example.com/x')?.host).toBe('example.com');
  });

  it('returns null on malformed input', () => {
    expect(parseUrlIdentity('not a url')).toBeNull();
  });
});

describe('urlIdentitySimilarity', () => {
  it('returns 0 for cross-host URLs', () => {
    expect(
      urlIdentitySimilarity('https://chatgpt.com/c/abc', 'https://gemini.google.com/app/xyz'),
    ).toBe(0);
  });

  it('returns 1 for two identifier-shaped paths under the same host', () => {
    // Both /c/<hash>. Identifier shape is the same, query empty.
    const s = urlIdentitySimilarity(
      'https://chatgpt.com/c/6a0ca209-f794-8329-8786-8d26494572e0',
      'https://chatgpt.com/c/6a0def77-04a0-8325-bc6a-cb0fca771ed2',
    );
    expect(s).toBe(1);
  });

  it('returns 1 for same host + bare path (the bare-host neighbor case)', () => {
    expect(urlIdentitySimilarity('https://chatgpt.com', 'https://chatgpt.com/')).toBe(1);
  });

  it('returns less than 1 when path shapes differ on the same host', () => {
    const s = urlIdentitySimilarity(
      'https://aws.amazon.com/security/bulletins/2026-029',
      'https://aws.amazon.com/products/ec2',
    );
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});
