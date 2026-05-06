// Heuristic dispatch↔thread matcher. Server-side port of the
// extension's `tryLinkCapturedThread` (see
// packages/sidetrack-extension/src/companion/dispatchLinking.ts).
// Pure — no fs / network. The companion's capture handler calls
// this after writing a freshly-captured thread, then persists the
// match via `linkDispatchToThread`.
//
// Match rule (intentionally simple, not fuzzy ML):
//   1. Dispatch ≤ 30 minutes old.
//   2. Dispatch's target.provider equals the captured thread's provider.
//   3. Dispatch is not already linked to a different live thread.
//   4. The first MATCH_PREFIX_LEN normalised characters of the dispatch
//      body appear as a substring inside ANY of the captured user-turn
//      texts (also normalised).
// On multiple matches, take the MOST RECENT dispatch — assumes the
// user is acting on the freshest one.

import type { DispatchEventRecord } from '../http/schemas.js';

// Captured-side provider universe is narrower than the dispatch-target
// enum (which includes coding agents like codex / claude_code / cursor
// that aren't browser-captured). Keeping this local lets the matcher
// stay decoupled from the larger schemas.
export type CapturedProviderId = 'chatgpt' | 'claude' | 'gemini' | 'codex' | 'unknown';

const MATCH_PREFIX_LEN = 60;
const MATCH_WINDOW_MS = 30 * 60 * 1000;
const MATCH_MIN_NEEDLE = 24;

export const normaliseForMatch = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const sameProvider = (
  capturedProvider: CapturedProviderId,
  dispatchProvider: DispatchEventRecord['target']['provider'],
): boolean => {
  if (capturedProvider === 'unknown') {
    return false;
  }
  if (dispatchProvider === 'chatgpt' && capturedProvider === 'chatgpt') {
    return true;
  }
  if (dispatchProvider === 'claude' && capturedProvider === 'claude') {
    return true;
  }
  if (dispatchProvider === 'gemini' && capturedProvider === 'gemini') {
    return true;
  }
  return false;
};

export interface DispatchLinkInput {
  readonly threadId: string;
  readonly threadProvider: CapturedProviderId;
  readonly userTurnTexts: readonly string[];
  readonly capturedAtMs: number;
  readonly recentDispatches: readonly DispatchEventRecord[];
  readonly existingLinks: Readonly<Partial<Record<string, string>>>;
  readonly liveThreadIds?: ReadonlySet<string>;
  readonly originalBodiesById?: Readonly<Partial<Record<string, string>>>;
}

export interface DispatchLinkResult {
  readonly matched: true;
  readonly dispatchId: string;
  readonly matchedTurnIndex: number;
  readonly candidatesConsidered: number;
  readonly bestPrefixMatchLen: number;
}

export type DispatchLinkMissReason =
  | 'window-expired'
  | 'provider-mismatch'
  | 'no-prefix-match'
  | 'tiny-prefix'
  | 'already-linked';

export interface DispatchLinkMiss {
  readonly matched: false;
  readonly reason: DispatchLinkMissReason;
  readonly candidatesConsidered: number;
  readonly bestPrefixMatchLen: number;
}

export type DispatchLinkDiagnosticResult = DispatchLinkResult | DispatchLinkMiss;

export const tryLinkCapturedThread = (input: DispatchLinkInput): DispatchLinkDiagnosticResult => {
  const normalisedTurns = input.userTurnTexts.map(normaliseForMatch);
  let candidatesConsidered = 0;
  let bestPrefixMatchLen = 0;
  let reason: DispatchLinkMissReason = 'no-prefix-match';

  const dispatches = input.recentDispatches
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const dispatch of dispatches) {
    if (dispatch.body.length === 0) {
      continue;
    }
    if (!sameProvider(input.threadProvider, dispatch.target.provider)) {
      reason = reason === 'no-prefix-match' ? 'provider-mismatch' : reason;
      continue;
    }
    const linkedTo = input.existingLinks[dispatch.bac_id];
    const isOrphanRelink =
      linkedTo !== undefined &&
      linkedTo !== input.threadId &&
      input.liveThreadIds !== undefined &&
      !input.liveThreadIds.has(linkedTo);
    if (!isOrphanRelink) {
      const age = input.capturedAtMs - Date.parse(dispatch.createdAt);
      if (!Number.isFinite(age) || age < 0 || age > MATCH_WINDOW_MS) {
        reason = reason === 'no-prefix-match' ? 'window-expired' : reason;
        continue;
      }
    }
    if (linkedTo !== undefined && linkedTo !== input.threadId && !isOrphanRelink) {
      reason = reason === 'no-prefix-match' ? 'already-linked' : reason;
      continue;
    }
    candidatesConsidered += 1;
    const sourceBody = input.originalBodiesById?.[dispatch.bac_id] ?? dispatch.body;
    const needle = normaliseForMatch(sourceBody).slice(0, MATCH_PREFIX_LEN);
    bestPrefixMatchLen = Math.max(bestPrefixMatchLen, needle.length);
    if (needle.length < MATCH_MIN_NEEDLE) {
      reason = 'tiny-prefix';
      continue;
    }
    for (let i = 0; i < normalisedTurns.length; i += 1) {
      if (normalisedTurns[i]?.includes(needle) ?? false) {
        return {
          matched: true,
          dispatchId: dispatch.bac_id,
          matchedTurnIndex: i,
          candidatesConsidered,
          bestPrefixMatchLen,
        };
      }
    }
  }
  return { matched: false, reason, candidatesConsidered, bestPrefixMatchLen };
};
