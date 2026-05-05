// Heuristic matcher for "this freshly-captured thread received that
// recent dispatch." Pure — no chrome.* / no storage. The capture
// handlers in entrypoints/background.ts call this after upserting a
// thread; the result feeds a small storage map (dispatchId → threadId)
// that the side panel reads to render Recent Dispatches as "Linked"
// vs. "Pending."
//
// Match rule (intentionally simple, not fuzzy ML):
//   1. Dispatch ≤ 30 minutes old.
//   2. Dispatch's target.provider equals the captured thread's provider.
//   3. Dispatch is not already linked to a different thread.
//   4. The first MATCH_PREFIX_LEN normalised characters of the dispatch
//      body appear as a substring inside ANY of the captured user-turn
//      texts (also normalised).
// On multiple matches, take the MOST RECENT dispatch — assumes the
// user is acting on the freshest one.

import type { DispatchEventRecord } from '../dispatch/types';
import type { ProviderId } from './model';

// Was 100 — pulled in to 60 because the user usually pastes a
// research-packet body whose first ~80 chars are a generic header
// ("# Research request: <title>\n\n## Source\n…"). Matching the
// first 60 normalised chars cuts in earlier and is more robust to
// stray Gemini whitespace transforms while still being long enough
// to discriminate.
const MATCH_PREFIX_LEN = 60;
const MATCH_WINDOW_MS = 30 * 60 * 1000;
// Was 16 — bumped to 24 to keep the false-positive floor tight now
// that we match a shorter prefix. Generic words like "research"
// would otherwise hit too many tracked threads.
const MATCH_MIN_NEEDLE = 24;

export const normaliseForMatch = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    // Re-collapse — stripping punctuation can leave double spaces.
    .replace(/\s+/g, ' ')
    .trim();

const sameProvider = (
  capturedProvider: ProviderId,
  dispatchProvider: DispatchEventRecord['target']['provider'],
): boolean => {
  if (capturedProvider === 'unknown') {
    return false;
  }
  // ChatGPT dispatch covers all gpt_* tier variants on capture side.
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
  readonly threadProvider: ProviderId;
  readonly userTurnTexts: readonly string[];
  readonly capturedAtMs: number;
  readonly recentDispatches: readonly DispatchEventRecord[];
  // Existing dispatchId → threadId map. We skip dispatches that
  // already have a link to a *live* thread; orphaned links (the
  // linked thread was wiped from local storage or got a new bac_id)
  // are NOT a reason to skip — they should be re-linked to the
  // current thread when the prefix matches. The `liveThreadIds`
  // set lets the matcher tell which links are still valid.
  readonly existingLinks: Readonly<Partial<Record<string, string>>>;
  // bac_ids of every thread currently in chrome.storage. A linked
  // dispatch whose threadId is NOT in this set is treated as
  // unlinked — its old destination thread is gone (storage wipe,
  // companion bac_id reissue) and the matcher is free to relink.
  readonly liveThreadIds?: ReadonlySet<string>;
  // Optional override map: dispatchId → unredacted body. When
  // provided, the matcher uses this body for prefix matching
  // instead of the stored (redacted) DispatchEventRecord.body.
  // Critical for matching real captures because the user pastes
  // the unredacted form into the chat — the redacted prefix
  // ("Email: [email]") wouldn't substring-match the captured turn
  // ("Email: user@example.com").
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
    const age = input.capturedAtMs - Date.parse(dispatch.createdAt);
    if (!Number.isFinite(age) || age < 0 || age > MATCH_WINDOW_MS) {
      reason = reason === 'no-prefix-match' ? 'window-expired' : reason;
      continue;
    }
    const linkedTo = input.existingLinks[dispatch.bac_id];
    if (linkedTo !== undefined && linkedTo !== input.threadId) {
      // Treat the existing link as stale (and skippable as a "real"
      // link) only when the linked thread still exists. If
      // liveThreadIds was supplied and it doesn't include linkedTo,
      // the link is orphaned — let the matcher relink to the
      // current capture if the prefix matches.
      const linkIsLive =
        input.liveThreadIds === undefined || input.liveThreadIds.has(linkedTo);
      if (linkIsLive) {
        reason = reason === 'no-prefix-match' ? 'already-linked' : reason;
        continue;
      }
    }
    candidatesConsidered += 1;
    // Prefer the unredacted body — that's what the user pasted.
    // Fall back to the stored (redacted) body when no original is
    // cached (older dispatches predating PR1.1).
    const sourceBody = input.originalBodiesById?.[dispatch.bac_id] ?? dispatch.body;
    const needle = normaliseForMatch(sourceBody).slice(0, MATCH_PREFIX_LEN);
    bestPrefixMatchLen = Math.max(bestPrefixMatchLen, needle.length);
    if (needle.length < MATCH_MIN_NEEDLE) {
      // Too short to match safely — skip rather than risk a false
      // positive on a one-word packet.
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
