// Real tokenizer using cl100k_base (GPT-4 / Claude approximation). The
// previous char/4 heuristic over-estimated for English, under-estimated
// for CJK + code. cl100k is good for budget-warning purposes; a Claude
// thread won't be off by more than ~10% from the model's actual count.
import { encode } from 'gpt-tokenizer';

// Per-provider context-window thresholds. These are the point at which
// the packet is large enough that it may not fit the destination
// model's context window — a warning, not a hard block. Values are
// deliberately conservative approximations of the *chat-surface*
// context window (not the max API window), because the consumer-facing
// chat UIs the extension drives cap well below the raw model limit:
//   - chatgpt: ~128K on GPT-4o-class models (approx).
//   - claude:  ~200K on the Claude chat surface (Sonnet/Opus API windows
//              reach 1M, but claude.ai truncates far below that; 200K is
//              the honest chat-safe floor).
//   - gemini:  ~1M on Gemini's long-context surface (approx).
//   - other:   200K conservative default for anything we don't recognise.
// Cite as approximations — refine when providers publish stable numbers.
export const providerTokenThresholds = {
  chatgpt: 128_000,
  claude: 200_000,
  gemini: 1_000_000,
  other: 200_000,
} as const;

export type TokenBudgetProvider = keyof typeof providerTokenThresholds;

// Back-compat default threshold. Retained so existing callers that
// don't yet pass a provider keep compiling; new call sites should use
// `tokenThresholdForProvider`. 'other' is the conservative floor.
export const tokenBudgetWarningThreshold = providerTokenThresholds.other;

export const tokenThresholdForProvider = (provider: string): number => {
  if (provider in providerTokenThresholds) {
    return providerTokenThresholds[provider as TokenBudgetProvider];
  }
  return providerTokenThresholds.other;
};

export const estimateTokens = (input: string): number => {
  if (input.length === 0) {
    return 0;
  }
  // gpt-tokenizer's encode() returns a number[] of token ids.
  return encode(input).length;
};
