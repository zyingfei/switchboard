import { CompanionRequestError } from '../../companion/client';
import type { ResolveOutcomeError, TabSessionResolutionResult } from './types';

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
