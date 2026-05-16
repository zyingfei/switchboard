import { describe, expect, it } from 'vitest';

import { fnv1a32Hex, hammingDistanceHex32, saltedFnv1a32Hex } from './fnv1a';

describe('fnv1a32Hex', () => {
  it('matches standard 32-bit FNV-1a known vectors', () => {
    expect(fnv1a32Hex('')).toBe('811c9dc5');
    expect(fnv1a32Hex('a')).toBe('e40c292c');
    expect(fnv1a32Hex('b')).toBe('e70c2de5');
    expect(fnv1a32Hex('foo')).toBe('a9f37ed7');
    expect(fnv1a32Hex('foobar')).toBe('bf9cf968');
  });

  it('salts hashes at the call site', () => {
    expect(saltedFnv1a32Hex('edge_a', 'tab|1|100')).toBe(fnv1a32Hex('edge_a|tab|1|100'));
    expect(saltedFnv1a32Hex('edge_a', 'tab|1|100')).not.toBe(
      saltedFnv1a32Hex('edge_b', 'tab|1|100'),
    );
  });

  it('has no collisions across 10k synthetic session keys', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(fnv1a32Hex(`edge_test|tab|${String(i)}|1778260000000`));
    }
    expect(seen.size).toBe(10_000);
  });

  it('computes 32-bit hamming distance', () => {
    expect(hammingDistanceHex32('00000000', 'ffffffff')).toBe(32);
    expect(hammingDistanceHex32('00000000', '0000000f')).toBe(4);
    expect(hammingDistanceHex32('12345678', '12345678')).toBe(0);
  });
});
