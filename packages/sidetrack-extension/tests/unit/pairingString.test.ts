import { describe, expect, it } from 'vitest';

import { looksLikePairingString, parsePairingString } from '../../src/companion/pairingString';

// A real base64url bridge key is 43 chars (randomBytes(32).base64url).
const KEY = 'Ag9X-yZ2bQ8pLm3No1RsT4uVwX6yZaBcDeFgHiJkLm';

describe('parsePairingString', () => {
  it('parses a well-formed token into port + key', () => {
    expect(parsePairingString(`st-pair://17374/${KEY}`)).toEqual({ port: 17_374, bridgeKey: KEY });
  });

  it('tolerates surrounding whitespace and a trailing newline (pasting the file line)', () => {
    expect(parsePairingString(`  st-pair://17373/${KEY}\n`)).toEqual({
      port: 17_373,
      bridgeKey: KEY,
    });
  });

  it('rejects a bare bridge key (no scheme)', () => {
    expect(parsePairingString(KEY)).toBeNull();
  });

  it('rejects an out-of-range port', () => {
    expect(parsePairingString(`st-pair://70000/${KEY}`)).toBeNull();
  });

  it('rejects a too-short / malformed key', () => {
    expect(parsePairingString('st-pair://17373/short')).toBeNull();
    expect(parsePairingString('st-pair://17373/has spaces and !! chars')).toBeNull();
  });

  it('detects the pairing-string shape regardless of case', () => {
    expect(looksLikePairingString(`ST-PAIR://17374/${KEY}`)).toBe(true);
    expect(looksLikePairingString(KEY)).toBe(false);
  });
});
