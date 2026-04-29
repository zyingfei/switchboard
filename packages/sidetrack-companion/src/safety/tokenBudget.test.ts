import { describe, expect, it } from 'vitest';

import { estimateTokens, tokenBudgetWarningThreshold } from './tokenBudget.js';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns the cl100k token count for ASCII text', () => {
    // "hello" is a single token under cl100k_base.
    expect(estimateTokens('hello')).toBe(1);
  });

  it('returns a positive count for CJK text', () => {
    // cl100k handles short CJK efficiently — a few common chars may
    // collapse into 1-2 tokens — but the count should be non-zero.
    expect(estimateTokens('你好世界')).toBeGreaterThan(0);
  });

  it('crosses the dispatch warning threshold for large inputs', () => {
    expect(estimateTokens('a '.repeat(tokenBudgetWarningThreshold + 100))).toBeGreaterThan(
      tokenBudgetWarningThreshold,
    );
  });
});
