import { describe, expect, it } from 'vitest';

import { CompanionRequestError } from '../../../src/companion/client';
import {
  PENDING_DEADLINE_MS,
  classifyResolveFailure,
  nextPendingSince,
  pendingDeadlineExceeded,
  resolveErrorForStatus,
  suggestionStateFrom,
} from '../../../src/sidepanel/tabsession/resolveOutcome';
import type { TabSessionResolutionResult } from '../../../src/sidepanel/tabsession/types';

const candidate = () => ({
  workstreamId: 'ws_a',
  rawFusionLogit: 1.0,
  dominantSource: 'ppr' as const,
  reasons: [],
});

const populated = (): Pick<TabSessionResolutionResult, 'fusedCandidates'> => ({
  fusedCandidates: [candidate()],
});
const empty = (): Pick<TabSessionResolutionResult, 'fusedCandidates'> => ({
  fusedCandidates: [],
});

describe('suggestionStateFrom — error !== empty !== pending !== populated', () => {
  it('nothing yet = pending', () => {
    expect(suggestionStateFrom({})).toBe('pending');
  });

  it('a fetched result with no candidates = empty', () => {
    expect(suggestionStateFrom({ suggestion: empty() })).toBe('empty');
  });

  it('a fetched result with candidates = populated', () => {
    expect(suggestionStateFrom({ suggestion: populated() })).toBe('populated');
  });

  it('an error with no result = error (NOT pending, NOT empty)', () => {
    expect(suggestionStateFrom({ error: { kind: 'busy' } })).toBe('error');
  });

  it('error outranks a stale empty result (the core falsehood we fix)', () => {
    // A page we failed to resolve must never read as "no signal".
    expect(suggestionStateFrom({ suggestion: empty(), error: { kind: 'busy' } })).toBe('error');
  });

  it('a populated result outranks an error (keep the last good answer)', () => {
    expect(suggestionStateFrom({ suggestion: populated(), error: { kind: 'error' } })).toBe(
      'populated',
    );
  });
});

describe('resolveErrorForStatus — HTTP status to busy/error', () => {
  it('classifies 5xx as busy (companion up but contended)', () => {
    expect(resolveErrorForStatus(500)).toEqual({ kind: 'busy' });
    expect(resolveErrorForStatus(503)).toEqual({ kind: 'busy' });
  });

  it('classifies 408/429 (timeout/overload) as busy', () => {
    expect(resolveErrorForStatus(408)).toEqual({ kind: 'busy' });
    expect(resolveErrorForStatus(429)).toEqual({ kind: 'busy' });
  });

  it('classifies other 4xx as error', () => {
    expect(resolveErrorForStatus(400)).toEqual({ kind: 'error' });
    expect(resolveErrorForStatus(404)).toEqual({ kind: 'error' });
  });
});

describe('classifyResolveFailure — caught error to busy/error', () => {
  it('CompanionRequestError timeout = busy; network = error', () => {
    expect(classifyResolveFailure(new CompanionRequestError('slow', 'timeout'))).toEqual({
      kind: 'busy',
    });
    expect(classifyResolveFailure(new CompanionRequestError('down', 'network'))).toEqual({
      kind: 'error',
    });
  });

  it('extracts a 5xx status from the raw-fetch error message = busy', () => {
    // The batch/fan-out loaders throw plain Errors like `... failed (503).`
    expect(classifyResolveFailure(new Error('Companion resolve failed (503).'))).toEqual({
      kind: 'busy',
    });
  });

  it('an error carrying a numeric status property is honoured', () => {
    const err = Object.assign(new Error('boom'), { status: 500 });
    expect(classifyResolveFailure(err)).toEqual({ kind: 'busy' });
  });

  it('an unclassifiable failure defaults to error', () => {
    expect(classifyResolveFailure(new Error('something odd'))).toEqual({ kind: 'error' });
    expect(classifyResolveFailure('not an error')).toEqual({ kind: 'error' });
  });
});

describe('pendingDeadlineExceeded — a hung-forever pending flips to busy', () => {
  const base = { hasResult: false, hasError: false } as const;

  it('nothing pending (undefined pendingSince) never flips', () => {
    expect(
      pendingDeadlineExceeded({ ...base, pendingSinceMs: undefined, nowMs: 999_999 }),
    ).toBe(false);
  });

  it('pending but still within the deadline does NOT flip', () => {
    const startedAt = 1_000;
    expect(
      pendingDeadlineExceeded({
        ...base,
        pendingSinceMs: startedAt,
        nowMs: startedAt + PENDING_DEADLINE_MS - 1,
      }),
    ).toBe(false);
  });

  it('pending past the deadline flips (the 304-after-200s hang)', () => {
    const startedAt = 1_000;
    expect(
      pendingDeadlineExceeded({
        ...base,
        pendingSinceMs: startedAt,
        nowMs: startedAt + PENDING_DEADLINE_MS,
      }),
    ).toBe(true);
  });

  it('a settled result suppresses the flip even past the deadline (late data wins)', () => {
    const startedAt = 1_000;
    expect(
      pendingDeadlineExceeded({
        pendingSinceMs: startedAt,
        hasResult: true,
        hasError: false,
        nowMs: startedAt + PENDING_DEADLINE_MS * 10,
      }),
    ).toBe(false);
  });

  it('an already-recorded error is not re-flipped by the deadline', () => {
    const startedAt = 1_000;
    expect(
      pendingDeadlineExceeded({
        pendingSinceMs: startedAt,
        hasResult: false,
        hasError: true,
        nowMs: startedAt + PENDING_DEADLINE_MS * 10,
      }),
    ).toBe(false);
  });

  it('honours a caller-supplied deadline override', () => {
    const startedAt = 1_000;
    expect(
      pendingDeadlineExceeded({ ...base, pendingSinceMs: startedAt, nowMs: startedAt + 5, deadlineMs: 10 }),
    ).toBe(false);
    expect(
      pendingDeadlineExceeded({ ...base, pendingSinceMs: startedAt, nowMs: startedAt + 10, deadlineMs: 10 }),
    ).toBe(true);
  });
});

describe('nextPendingSince — the deadline resets on a new navigation', () => {
  it('starts a fresh clock when nothing was pending', () => {
    expect(nextPendingSince({ previous: null, key: 'https://a.test/', nowMs: 5_000 })).toBe(5_000);
  });

  it('keeps the existing clock while still on the same URL (deadline keeps counting)', () => {
    expect(
      nextPendingSince({
        previous: { key: 'https://a.test/', pendingSinceMs: 1_000 },
        key: 'https://a.test/',
        nowMs: 9_000,
      }),
    ).toBe(1_000);
  });

  it('RESETS to now when the URL changes (a new navigation cannot inherit a stale deadline)', () => {
    // URL A had been pending since t=1000; navigating to B at t=18000 must not
    // immediately be "18s pending" — it restarts at t=18000.
    expect(
      nextPendingSince({
        previous: { key: 'https://a.test/', pendingSinceMs: 1_000 },
        key: 'https://b.test/',
        nowMs: 18_000,
      }),
    ).toBe(18_000);
  });
});
