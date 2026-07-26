import {
  type ConfidenceLevel,
  confidenceLevelFromProbability,
  probabilityFromLogit,
} from '../suggestion/confidence';
import { CompanionRequestError } from '../../companion/client';
import { endorsementFor } from './suggestionEndorsement';
import type {
  ResolveOutcomeError,
  TabSessionResolutionResult,
  TabSessionResolverCandidate,
} from './types';

// The four distinguishable outcomes of a resolve consumption. Error is a
// FIRST-CLASS state, separate from empty and pending — that separation is
// the whole fix: a failed batch-resolve (500 "database is locked" during a
// drain) must never render as the confident "First time seeing this URL"
// empty card.
export type SuggestionState = 'pending' | 'error' | 'empty' | 'populated';

// A pending resolve/index that neither fails fast nor settles must not hang
// the card FOREVER. Live-verified (CDP, 2026-07-26): during a long companion
// drain a resolve can be served after 200s+ as a 304, so the transport-error
// mapping (which only fires on HTTP error / network failure) never trips and
// the card stays "Checking connections…"/"Indexing…" indefinitely. After this
// deadline a still-pending request is treated as the EXISTING amber 'busy'
// state ("Companion is busy — retrying"); the existing poll/retry path then
// owns recovery, and a late-arriving success still supersedes the busy card
// (populated/settled > busy, per suggestionStateFrom). Chosen at 20s: past
// the ~5s..15s a healthy resolve takes under moderate load, well inside the
// FOCUSED_RESOLVE_RETRY_WINDOW (30s) so the retry loop is still driving
// refetches when the flip fires.
export const PENDING_DEADLINE_MS = 20_000;

// Pure state-machine step for the pending-deadline flip, shared by the panel
// and its tests. Given when a request went pending (`pendingSinceMs`, or
// undefined if nothing is in flight for this key), whether a result/error has
// already landed, and the current clock, decide whether to synthesize the
// 'busy' error so the existing self-heal path (urlSuggestionErrors + retry
// loop) owns recovery.
//   - Only pending (no result, no error) requests are eligible — a settled
//     result or an already-recorded error is never overridden here.
//   - The flip fires exactly when the request has been pending for at least
//     `deadlineMs`. Callers debounce it against the current error map so a
//     late success (which clears the entry) wins over a re-flip.
export const pendingDeadlineExceeded = (input: {
  readonly pendingSinceMs: number | undefined;
  readonly hasResult: boolean;
  readonly hasError: boolean;
  readonly nowMs: number;
  readonly deadlineMs?: number;
}): boolean => {
  if (input.pendingSinceMs === undefined) return false;
  if (input.hasResult || input.hasError) return false;
  return input.nowMs - input.pendingSinceMs >= (input.deadlineMs ?? PENDING_DEADLINE_MS);
};

// Decide the pending-since timestamp for a key given the previously-recorded
// pending clock. Keeps the deadline clock keyed to the CURRENT key so a new
// navigation restarts the deadline instead of inheriting the stale one — the
// reset-on-navigation invariant. Returns the existing timestamp when still on
// the same key, otherwise `nowMs` (a fresh start).
export const nextPendingSince = (input: {
  readonly previous: { readonly key: string; readonly pendingSinceMs: number } | null;
  readonly key: string;
  readonly nowMs: number;
}): number =>
  input.previous !== null && input.previous.key === input.key
    ? input.previous.pendingSinceMs
    : input.nowMs;

// ---- Thread-suggestion retry cadence (All-Threads "Needs organize" card) --
//
// The thread card (NeedsOrganizeSuggestionRow) fetches GET
// /v1/suggestions/thread/{id} once on mount and re-fetches only on real input
// changes (threadId / workstream mutation / index-rebuild settle / manual ↻).
// It had NO retry loop and NO error state: a hung or failed fetch cleared the
// in-flight flag and rendered "Pick a workstream…" as if the resolver had
// abstained, with nothing ever re-asking — a thread card stayed stuck for 10+
// minutes while the endpoint answered 200 in ~2.4s. These helpers give it the
// URL surface's self-heal contract (a bounded retry window + the shared
// pending-deadline busy flip) so ONE self-heal path owns recovery for both.
//
// Window kept identical to the URL surface's FOCUSED_RESOLVE_RETRY_WINDOW_MS so
// the retry loop is still driving refetches well past the 20s pending-deadline
// flip — a late success supersedes the busy card.
export const THREAD_SUGGESTION_RETRY_WINDOW_MS = 30_000;

// Backoff for the visible thread card's retry loop, mirroring the URL surface's
// escalation: a gentle ramp capped at 5s so a busy companion isn't hammered.
// `attempts` is the number of retries already issued for the CURRENT thread
// (0 = the first retry after the initial fetch).
//   - attempts <8  → 1s
//   - attempts ≥8  → 2s + (attempts-8)*1s, capped at 5s
export const threadRetryDelayMs = (attempts: number): number =>
  attempts < 8 ? 1_000 : Math.min(2_000 + (attempts - 8) * 1_000, 5_000);

// True once the visible thread card's retry loop has been running for longer
// than the window — the loop stops rescheduling (the busy card stays, and any
// real input change or manual ↻ restarts a fresh window). Mirrors the URL
// surface's `nowMs - startedAt > FOCUSED_RESOLVE_RETRY_WINDOW_MS` guard.
export const threadRetryExhausted = (input: {
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly windowMs?: number;
}): boolean =>
  input.nowMs - input.startedAtMs > (input.windowMs ?? THREAD_SUGGESTION_RETRY_WINDOW_MS);

// Pure state mapping shared by SuggestionStats and its tests. Precedence is
// deliberate:
//   1. A populated result always wins — if the resolver DID return
//      candidates, show them even if a later refresh errored.
//   2. An error outranks empty/pending — a page we failed to resolve is
//      NOT "no signal"; it's "we couldn't check". Surfacing the honest busy
//      state (and retrying) beats a confident falsehood.
//   3. A fetched-but-empty result is "empty".
//   4. Nothing yet (no result, no error) is "pending" (still checking).
export const suggestionStateFrom = (input: {
  readonly suggestion?: Pick<TabSessionResolutionResult, 'fusedCandidates'>;
  readonly error?: ResolveOutcomeError;
}): SuggestionState => {
  if (input.suggestion !== undefined && input.suggestion.fusedCandidates.length > 0) {
    return 'populated';
  }
  if (input.error !== undefined) return 'error';
  if (input.suggestion !== undefined) return 'empty';
  return 'pending';
};

// Classify a caught resolve failure into the honest UI error state.
//   - An HTTP status (from the batch-resolve fetch, which reads
//     `response.status` directly) of 5xx / 408 / 429 = the companion is up
//     but contended or overloaded ("busy — retrying").
//   - A CompanionRequestError timeout = up-but-slow = busy; a network kind =
//     unreachable = error.
//   - Anything else = 'error'.
// Both kinds render the same soft busy-retry card; the discriminant is kept
// for future tooltip/telemetry use and to keep error !== empty explicit.
export const classifyResolveFailure = (error: unknown): ResolveOutcomeError => {
  if (error instanceof CompanionRequestError) {
    return { kind: error.kind === 'timeout' ? 'busy' : 'error' };
  }
  const status = httpStatusFromError(error);
  if (status !== undefined && (status >= 500 || status === 408 || status === 429)) {
    return { kind: 'busy' };
  }
  return { kind: 'error' };
};

// Map a batch-resolve HTTP status directly (the batch path throws a plain
// Error, so it passes the status in explicitly instead of via the message).
export const resolveErrorForStatus = (status: number): ResolveOutcomeError =>
  status >= 500 || status === 408 || status === 429 ? { kind: 'busy' } : { kind: 'error' };

// Best-effort status extraction from the raw-fetch error messages the
// resolve loaders throw, e.g. `Companion ... failed (503).`. Kept lenient:
// a miss just falls through to 'error'.
const httpStatusFromError = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  const message = error instanceof Error ? error.message : '';
  const match = /\((\d{3})\)/u.exec(message);
  if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  return undefined;
};

// ---- Ranked "Possibilities" (the user's ask: SEE all the resolver's
// ranked candidates, not just the single top pick) --------------------------
//
// The resolver hands a FULL ranked `fusedCandidates[]` — it survives the
// client parse verbatim (isTabSessionResolutionResult / the URL-batch guard
// pass the whole array through). Only the RENDER truncated it: the card
// showed top-1 and hid the rest behind the manual "Pick another…" browse.
// This helper turns the ranked list into the rows the card renders, and — the
// key honesty case — tells the card whether a PRIMARY suggestion is already
// shown prominently above (endorsed suggest/auto-apply, or a top weak-guess
// lean), so the list can decide collapsed-under-a-disclosure vs expanded.
//
// The genuinely-empty resolve (fusedCandidates.length === 0) is NOT a
// possibilities case — it stays the existing "No signal yet" card. The case
// the user means by "shows nothing" is: candidates DO exist but sit below the
// policy's confidence bar (action='inbox'), so the top reads as a weak guess
// and the rest were invisible. Those get surfaced as
// "Below confidence bar — possibilities:".

export interface PossibilityRow {
  readonly workstreamId: string;
  readonly dominantSource: TabSessionResolverCandidate['dominantSource'];
  readonly level: ConfidenceLevel;
  // The candidate's position in the resolver's ranked list (0 = top). Kept
  // so the row can carry a stable key and the caller can tell the primary
  // (rank 0) from the rest.
  readonly rank: number;
}

export interface Possibilities {
  // Every ranked candidate as a row, top-first. Empty when the resolver
  // returned zero candidates.
  readonly rows: readonly PossibilityRow[];
  // True when a CONFIDENT primary suggestion is shown prominently above the
  // list — an endorsed pick (policy suggest/auto-apply). When true the list is
  // the "Other possibilities (N)" tail (rows after the primary) and collapses
  // under a disclosure. When false (weak guess or nothing endorsed), NO
  // confident primary is shown and the rows ARE the whole story — surface them
  // expanded ("Below confidence bar — possibilities:").
  readonly hasPrimary: boolean;
  // The rows to list UNDER the primary. When hasPrimary, this drops rank 0
  // (already shown as the headline); otherwise it is every row.
  readonly others: readonly PossibilityRow[];
}

// Cap so the list stays scannable on the compact Now card. The resolver can
// hand a long tail; 4 rows is the visible budget (the rest remain reachable
// via "Pick another…").
export const MAX_POSSIBILITY_ROWS = 4;

// Build the possibility rows from a resolution. Non-top candidates are scored
// individually from their own logit WITHOUT the decision.margin tie gate —
// that gate is a property of the top-1/top-2 separation, not of a mid-list
// row (mirrors SuggestionStats' existing `alternatives` handling). The top
// row keeps the margin gate so a near-tie reads honestly as "no clear pick".
export const possibilitiesFrom = (
  suggestion: TabSessionResolutionResult | undefined,
  options?: { readonly limit?: number },
): Possibilities => {
  const empty: Possibilities = { rows: [], hasPrimary: false, others: [] };
  if (suggestion === undefined || suggestion.fusedCandidates.length === 0) return empty;
  const limit = options?.limit ?? MAX_POSSIBILITY_ROWS;
  const margin = suggestion.decision.margin;
  const rows: PossibilityRow[] = suggestion.fusedCandidates
    .slice(0, limit)
    .map((candidate, index) => ({
      workstreamId: candidate.workstreamId,
      dominantSource: candidate.dominantSource,
      // Only the leader carries the tie gate (margin to the runner-up).
      level: confidenceLevelFromProbability(probabilityFromLogit(candidate.rawFusionLogit), {
        ...(index === 0 ? { margin } : {}),
      }),
      rank: index,
    }));
  // "Primary" means a CONFIDENT pick the card shows prominently — an endorsed
  // (policy suggest/auto-apply) suggestion. A weak guess (action='inbox') is
  // NOT a confident primary: the whole top of the list is below the policy's
  // bar, so the ranked possibilities ARE the answer and should surface
  // EXPANDED (rank 0 included) rather than collapse behind a disclosure —
  // that is exactly the case the user means by "shows nothing when there were
  // ranked possibilities". endorsementFor() is the single source of truth.
  const endorsement = endorsementFor(suggestion);
  const hasPrimary = endorsement.level === 'endorsed';
  // With a confident primary, the list is the tail after the headline (drop
  // rank 0). Without one, every ranked row is a possibility to show.
  const others = hasPrimary ? rows.slice(1) : rows;
  return { rows, hasPrimary, others };
};
