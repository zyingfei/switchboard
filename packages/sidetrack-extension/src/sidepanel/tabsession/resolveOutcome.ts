import { CompanionRequestError } from '../../companion/client';
import type { ResolveOutcomeError, TabSessionResolutionResult } from './types';

// The four distinguishable outcomes of a resolve consumption. Error is a
// FIRST-CLASS state, separate from empty and pending — that separation is
// the whole fix: a failed batch-resolve (500 "database is locked" during a
// drain) must never render as the confident "First time seeing this URL"
// empty card.
export type SuggestionState = 'pending' | 'error' | 'empty' | 'populated';

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
