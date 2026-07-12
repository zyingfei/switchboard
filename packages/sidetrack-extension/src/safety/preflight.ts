// §24.10 safety preflight — single entry point that runs every auto-send
// candidate through the four ship-blocking gates per PRD §6.1.13.
//
// The gates, in order:
//   1. The thread itself opted in (per-thread `autoSendEnabled`).
//   2. The provider opted in (`companionSettings.autoSendOptIn[provider]`).
//   3. Screen-share-safe mode is OFF (user is not currently sharing).
//   4. Token budget — the wrapped text fits the model's context window.
//
// Plus TWO unconditional text transforms run before the gates so that
// whatever ships is safe (the F01 inversion — the auto-send drain must
// not leak secrets any more than the clipboard/dispatch paths do):
//   - secret redaction (`applyLocalRedaction`, shared with the dispatch
//     paths) masks API keys / tokens / cards / SSNs / emails, and
//   - injection-scrub (`injectionScrub.ts`) *wraps* untrusted content;
//     it never refuses, it just reports whether anything looked suspicious.
//
// This module is pure. The content-script auto-send drain is the caller.

import { applyLocalRedaction } from '../dispatch/outboundPreflight';
import type { ProviderId } from '../companion/model';
import { scanForInjection } from './injectionScrub';
import { estimateTokensFast } from './tokenEstimate';

// Re-exported for existing callers that import it from here.
export { estimateTokensFast };

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
  // Redact secrets FIRST (shared rules with the dispatch paths), then
  // injection-scrub the redacted text — its output is what we'd send AND
  // neither transform blocks, so we always have a final safe text to
  // report. Without the redaction step the drain shipped raw secrets
  // (the F01 gap: this path never went through outboundPreflight).
  const redacted = applyLocalRedaction(input.text);
  const scrub = scanForInjection(redacted.output);
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
