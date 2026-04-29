// §24.10 safety preflight — single entry point that runs every auto-send
// candidate through the four ship-blocking gates per PRD §6.1.13.
//
// The gates, in order:
//   1. The thread itself opted in (per-thread `autoSendEnabled`).
//   2. The provider opted in (`companionSettings.autoSendOptIn[provider]`).
//   3. Screen-share-safe mode is OFF (user is not currently sharing).
//   4. Token budget — the wrapped text fits the model's context window.
//
// Plus the injection-scrub from `injectionScrub.ts` runs unconditionally
// — its job is to *wrap*, not refuse, so it never blocks; it just
// modifies the outbound text and reports whether anything looked
// suspicious.
//
// This module is pure. The (future) content-script auto-send drain in
// `entrypoints/content.ts` will be the only caller.

import type { ProviderId } from '../companion/model';
import { scanForInjection } from './injectionScrub';

// Fast char/4 heuristic, matching what PacketComposer renders for live
// preview. Real cl100k counts come from the companion at dispatch time;
// we don't bundle the BPE table into the side-panel/content bundle to
// keep MV3 size in check.
export const estimateTokensFast = (text: string): number => Math.ceil(text.length / 4);

// 200K is the largest published context across the providers we drive
// (Claude 200K, GPT 4o 128K, Gemini 1M but practical chat ~200K).
// Per-provider tightening can land later.
const DEFAULT_TOKEN_LIMIT = 200_000;

export type PreflightBlockedReason =
  | 'thread-toggle-off'
  | 'provider-opt-out'
  | 'screen-share-safe'
  | 'token-budget'
  | 'unsupported-provider';

export interface AutoSendPreflightInput {
  readonly text: string;
  readonly provider: ProviderId;
  readonly threadAutoSendEnabled: boolean;
  readonly autoSendOptIn: {
    readonly chatgpt: boolean;
    readonly claude: boolean;
    readonly gemini: boolean;
  };
  readonly screenShareSafeMode: boolean;
  // Optional override — defaults to 200K tokens.
  readonly tokenLimit?: number;
}

export interface AutoSendPreflightVerdict {
  readonly ok: boolean;
  readonly blockedBy?: PreflightBlockedReason;
  // Possibly scrubbed/wrapped text. When ok=true the caller sends THIS
  // (not the original input). When ok=false this still reflects what
  // would have shipped, so the UI can show a preview of what's blocked.
  readonly text: string;
  readonly injectionDetected: boolean;
  readonly injectionPatternsMatched: readonly string[];
  readonly tokenEstimate: number;
}

const KNOWN_PROVIDERS = new Set<ProviderId>(['chatgpt', 'claude', 'gemini']);

export const evaluateAutoSendPreflight = (
  input: AutoSendPreflightInput,
): AutoSendPreflightVerdict => {
  // Run injection-scrub first — its output is what we'd send AND it
  // doesn't block, so we always have a final text to report.
  const scrub = scanForInjection(input.text);
  const tokenEstimate = estimateTokensFast(scrub.wrapped);
  const tokenLimit = input.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  const baseFields = {
    text: scrub.wrapped,
    injectionDetected: scrub.detected,
    injectionPatternsMatched: scrub.patternsMatched,
    tokenEstimate,
  } as const;

  if (!input.threadAutoSendEnabled) {
    return { ok: false, blockedBy: 'thread-toggle-off', ...baseFields };
  }
  if (!KNOWN_PROVIDERS.has(input.provider)) {
    return { ok: false, blockedBy: 'unsupported-provider', ...baseFields };
  }
  // KNOWN_PROVIDERS narrowed; `as` keeps autoSendOptIn lookup typed.
  const providerKey = input.provider as 'chatgpt' | 'claude' | 'gemini';
  if (!input.autoSendOptIn[providerKey]) {
    return { ok: false, blockedBy: 'provider-opt-out', ...baseFields };
  }
  if (input.screenShareSafeMode) {
    return { ok: false, blockedBy: 'screen-share-safe', ...baseFields };
  }
  if (tokenEstimate > tokenLimit) {
    return { ok: false, blockedBy: 'token-budget', ...baseFields };
  }
  return { ok: true, ...baseFields };
};
