import { describe, expect, it } from 'vitest';

import {
  base64ToUint64,
  hammingDistance64,
  hashToken64,
  simhash64Base64,
  tokenizeForSimhash,
  uint64ToBase64,
} from '../../../src/graph/simhash64';

describe('simhash64', () => {
  it('has stable known vectors and base64 roundtrips', () => {
    expect(simhash64Base64('')).toBe('AAAAAAAAAAA=');
    const alpha = uint64ToBase64(hashToken64('alpha'));
    expect(simhash64Base64('alpha')).toBe(alpha);
    expect(base64ToUint64(alpha)).toBe(hashToken64('alpha'));
  });

  it('computes hamming distance', () => {
    expect(hammingDistance64('AAAAAAAAAAA=', '//////////8=')).toBe(64);
    expect(hammingDistance64('AAAAAAAAAAA=', 'AAAAAAAAAAE=')).toBe(1);
    expect(hammingDistance64(simhash64Base64('same'), simhash64Base64('same'))).toBe(0);
  });

  it('uses at most 128 normalized tokens', () => {
    const text = Array.from({ length: 200 }, (_, index) => `Token${String(index)}`).join(' ');
    expect(tokenizeForSimhash(text)).toHaveLength(128);
    expect(tokenizeForSimhash('Hello, HELLO!')).toEqual(['hello', 'hello']);
  });

  it('keeps near-paraphrase pairs mostly within a small hamming band', () => {
    let near = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const base =
        'sidetrack browser companion tracks deterministic local work graph signals with privacy first hashing repeated stable shared context carries most semantic weight local first browser work graph privacy hashing deterministic signals repeated context stable shared';
      const left = `${base} shared context packet ${String(i % 7)}`;
      const right = `${base} shared context note ${String(i % 7)}`;
      if (hammingDistance64(simhash64Base64(left), simhash64Base64(right)) < 5) near += 1;
    }
    expect(near).toBeGreaterThan(900);
  });
});
