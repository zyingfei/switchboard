// Real tokenizer using cl100k_base (GPT-4 / Claude approximation). The
// previous char/4 heuristic over-estimated for English, under-estimated
// for CJK + code. cl100k is good for budget-warning purposes; a Claude
// thread won't be off by more than ~10% from the model's actual count.
import { encode } from 'gpt-tokenizer';

export const tokenBudgetWarningThreshold = 8000;

export const estimateTokens = (input: string): number => {
  if (input.length === 0) {
    return 0;
  }
  // gpt-tokenizer's encode() returns a number[] of token ids.
  return encode(input).length;
};
