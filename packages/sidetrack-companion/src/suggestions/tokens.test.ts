import { describe, expect, it } from 'vitest';

import { jaccard, normalizeTokens } from './tokens.js';

describe('suggestion tokens', () => {
  it('normalizes punctuation and stopwords (word tokens only, short words skip trigrams)', () => {
    // 'vector' is 6 chars → emits trigrams. 'recall' is 6 chars
    // → emits trigrams. 'plan' is 4 chars → word only, no
    // trigrams. We assert the word tokens are present without
    // depending on internal trigram order.
    const tokens = normalizeTokens('The Vector-recall plan, and the UI!');
    expect(tokens.has('vector')).toBe(true);
    expect(tokens.has('recall')).toBe(true);
    expect(tokens.has('plan')).toBe(true);
    expect(tokens.has('the')).toBe(false); // stopword
    expect(tokens.has('ui')).toBe(false); // <3 chars
    // Trigrams are tagged with `#` so they don't collide with
    // real words; presence of any signals the trigram path fired.
    const trigramCount = [...tokens].filter((t) => t.startsWith('#')).length;
    expect(trigramCount).toBeGreaterThan(0);
  });

  it('computes jaccard similarity', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBe(1 / 3);
  });

  it('matches glued-together words against split-word counterparts via trigrams', () => {
    // The original motivating bug: thread "Hacker News Summary"
    // never matched workstream "hackernews" because exact-token
    // jaccard saw zero overlap. Trigrams bridge that.
    const wsTokens = normalizeTokens('hackernews');
    const threadTokens = normalizeTokens('Hacker News Summary May');
    expect(jaccard(wsTokens, threadTokens)).toBeGreaterThan(0);
  });
});
