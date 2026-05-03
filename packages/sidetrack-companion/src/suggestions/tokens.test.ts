import { describe, expect, it } from 'vitest';

import { jaccard, normalizeTokens } from './tokens.js';

describe('suggestion tokens', () => {
  it('normalizes punctuation and stopwords', () => {
    expect([...normalizeTokens('The Vector-recall plan, and the UI!')]).toEqual([
      'vector',
      'recall',
      'plan',
    ]);
  });

  it('computes jaccard similarity', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBe(1 / 3);
  });
});
