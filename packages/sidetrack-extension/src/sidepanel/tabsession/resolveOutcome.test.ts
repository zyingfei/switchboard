import { describe, expect, it } from 'vitest';

import {
  MAX_POSSIBILITY_ROWS,
  PENDING_DEADLINE_MS,
  THREAD_SUGGESTION_RETRY_WINDOW_MS,
  pendingDeadlineExceeded,
  possibilitiesFrom,
  suggestionStateFrom,
  threadRetryDelayMs,
  threadRetryExhausted,
} from './resolveOutcome';
import type { TabSessionResolutionResult, TabSessionResolverCandidate } from './types';

const candidate = (
  over: Partial<TabSessionResolverCandidate> = {},
): TabSessionResolverCandidate => ({
  workstreamId: 'ws-1',
  rawFusionLogit: 1.2,
  dominantSource: 'ppr',
  reasons: [{ source: 'ppr', summary: 'graph 0.5', anchors: [] }],
  ...over,
});

const resolution = (
  decision: TabSessionResolutionResult['decision'],
  candidates: readonly TabSessionResolverCandidate[],
): TabSessionResolutionResult => ({
  tabSessionId: 'tses_1',
  dryRun: true,
  decision,
  fusedCandidates: candidates,
});

describe('suggestionStateFrom — sub-threshold candidates are NOT empty', () => {
  it('maps a resolution with candidates below the confidence bar (inbox) to populated, not empty', () => {
    // The user's ask: the resolver had ranked possibilities, so the card must
    // NOT read as "empty / no signal". A weak guess (action='inbox') still
    // carries fusedCandidates → populated.
    const state = suggestionStateFrom({
      suggestion: resolution({ action: 'inbox', margin: -0.4 }, [
        candidate(),
        candidate({ workstreamId: 'ws-2' }),
      ]),
    });
    expect(state).toBe('populated');
  });

  it('only a genuinely zero-candidate resolution is empty', () => {
    expect(
      suggestionStateFrom({ suggestion: resolution({ action: 'inbox', margin: 0 }, []) }),
    ).toBe('empty');
  });
});

describe('possibilitiesFrom — the full ranked list survives to the render layer', () => {
  it('returns a row per candidate, top-first, preserving order and workstream ids', () => {
    const result = possibilitiesFrom(
      resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
        candidate({ workstreamId: 'ws-1', rawFusionLogit: 2.5 }),
        candidate({ workstreamId: 'ws-2', rawFusionLogit: 1.0 }),
        candidate({ workstreamId: 'ws-3', rawFusionLogit: 0.2 }),
      ]),
    );
    expect(result.rows.map((r) => r.workstreamId)).toEqual(['ws-1', 'ws-2', 'ws-3']);
    expect(result.rows.map((r) => r.rank)).toEqual([0, 1, 2]);
  });

  it('N candidates survive — nothing is truncated to top-1 below the cap', () => {
    // Client parse never truncates (Array.isArray passthrough); this reads
    // back that the panel-facing helper sees all N up to the visible budget.
    const four = [1, 2, 3, 4].map((n) => candidate({ workstreamId: `ws-${String(n)}` }));
    const result = possibilitiesFrom(
      resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, four),
    );
    expect(result.rows).toHaveLength(4);
  });

  it('caps the list at MAX_POSSIBILITY_ROWS so a long tail stays scannable', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      candidate({ workstreamId: `ws-${String(i)}` }),
    );
    const result = possibilitiesFrom(
      resolution({ action: 'suggest', workstreamId: 'ws-0', margin: 0.9 }, many),
    );
    expect(result.rows).toHaveLength(MAX_POSSIBILITY_ROWS);
    expect(result.rows[0]?.workstreamId).toBe('ws-0');
  });

  it('an endorsed suggestion has a confident primary → the list is the tail after rank 0', () => {
    const result = possibilitiesFrom(
      resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
        candidate({ workstreamId: 'ws-1' }),
        candidate({ workstreamId: 'ws-2' }),
      ]),
    );
    expect(result.hasPrimary).toBe(true);
    expect(result.others.map((r) => r.workstreamId)).toEqual(['ws-2']);
  });

  it('a weak guess (inbox) has NO confident primary → every ranked row is a possibility (rank 0 included)', () => {
    const result = possibilitiesFrom(
      resolution({ action: 'inbox', margin: -0.4 }, [
        candidate({ workstreamId: 'ws-1' }),
        candidate({ workstreamId: 'ws-2' }),
      ]),
    );
    expect(result.hasPrimary).toBe(false);
    expect(result.others.map((r) => r.workstreamId)).toEqual(['ws-1', 'ws-2']);
  });

  it('applies the tie gate to the LEADER only, not to mid-list rows', () => {
    // margin below TIED_MARGIN_THRESHOLD → leader is "no clear pick"; the
    // runner-up is scored on its own logit (a strong 2.5 → highly-likely).
    const result = possibilitiesFrom(
      resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.01 }, [
        candidate({ workstreamId: 'ws-1', rawFusionLogit: 2.5 }),
        candidate({ workstreamId: 'ws-2', rawFusionLogit: 2.5 }),
      ]),
    );
    expect(result.rows[0]?.level).toBe('no-clear-pick');
    expect(result.rows[1]?.level).toBe('highly-likely');
  });

  it('is empty for a zero-candidate or undefined resolution', () => {
    expect(possibilitiesFrom(undefined).rows).toHaveLength(0);
    expect(possibilitiesFrom(resolution({ action: 'inbox', margin: 0 }, [])).rows).toHaveLength(0);
  });
});

describe('thread-suggestion self-heal cadence (All-Threads "Needs organize")', () => {
  it('threadRetryDelayMs ramps 1s → capped 5s, matching the URL surface', () => {
    // Early attempts probe at 1s.
    expect(threadRetryDelayMs(0)).toBe(1_000);
    expect(threadRetryDelayMs(7)).toBe(1_000);
    // From attempt 8 it ramps by 1s/attempt…
    expect(threadRetryDelayMs(8)).toBe(2_000);
    expect(threadRetryDelayMs(9)).toBe(3_000);
    // …and caps at 5s so a busy companion isn't hammered.
    expect(threadRetryDelayMs(11)).toBe(5_000);
    expect(threadRetryDelayMs(50)).toBe(5_000);
  });

  it('threadRetryExhausted flips exactly at the retry window', () => {
    const startedAtMs = 1_000;
    // Inside the window → keep retrying.
    expect(
      threadRetryExhausted({ startedAtMs, nowMs: startedAtMs + THREAD_SUGGESTION_RETRY_WINDOW_MS }),
    ).toBe(false);
    // One tick past the window → stop rescheduling (busy card stays honest).
    expect(
      threadRetryExhausted({
        startedAtMs,
        nowMs: startedAtMs + THREAD_SUGGESTION_RETRY_WINDOW_MS + 1,
      }),
    ).toBe(true);
  });

  it('a hanging thread fetch flips to busy at the shared pending deadline', () => {
    const pendingSinceMs = 5_000;
    // Just before the deadline the still-pending fetch stays pending (no flip).
    expect(
      pendingDeadlineExceeded({
        pendingSinceMs,
        hasResult: false,
        hasError: false,
        nowMs: pendingSinceMs + PENDING_DEADLINE_MS - 1,
      }),
    ).toBe(false);
    // At the deadline it flips — the row synthesizes the 'busy' state so the
    // retry loop owns recovery (same 20s deadline the URL surface uses).
    expect(
      pendingDeadlineExceeded({
        pendingSinceMs,
        hasResult: false,
        hasError: false,
        nowMs: pendingSinceMs + PENDING_DEADLINE_MS,
      }),
    ).toBe(true);
    // A late-arriving result (or a real error) is never overridden by the flip.
    expect(
      pendingDeadlineExceeded({
        pendingSinceMs,
        hasResult: true,
        hasError: false,
        nowMs: pendingSinceMs + PENDING_DEADLINE_MS + 5_000,
      }),
    ).toBe(false);
  });

  it('the retry window outlasts the pending deadline (loop still driving at the flip)', () => {
    // The busy flip fires at PENDING_DEADLINE_MS; the retry window must still be
    // open then so a probe actually re-fetches after the flip.
    expect(THREAD_SUGGESTION_RETRY_WINDOW_MS).toBeGreaterThan(PENDING_DEADLINE_MS);
  });
});
