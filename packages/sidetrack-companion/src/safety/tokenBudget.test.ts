import { describe, expect, it } from 'vitest';

import { estimateTokens, tokenBudgetWarningThreshold } from './tokenBudget.js';

describe('estimateTokens', () => {
  it('estimates short input by four characters per token', () => {
    expect(estimateTokens('hello')).toBe(2);
  });

  it('estimates long input by rounding up', () => {
    expect(estimateTokens('a'.repeat(32_001))).toBe(8_001);
  });

  it('supports the dispatch warning threshold', () => {
    expect(estimateTokens('a'.repeat(tokenBudgetWarningThreshold * 4 + 1))).toBeGreaterThan(
      tokenBudgetWarningThreshold,
    );
  });
});
