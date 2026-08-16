import { afterEach, describe, expect, it } from 'bun:test';

import {
  DECLINE_MEMORY_ENV,
  EMPTY_DECLINE_LOOKUP,
  foldDeclineMemory,
  isUrlDeclined,
  isWorkstreamDeclined,
} from './declineMemory.js';
import { applyLaneFallbackGuess, type ResultWithFusion } from './laneFallback.js';
import type { GuessLaneResult } from './guessLanes.js';
import { USER_FLOW_REJECTED, USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { SUGGESTION_ACCEPTED, SUGGESTION_DECLINED } from '../workstreams/suggestionEvents.js';

// DECLINE MEMORY — "Not in any stream" is an answer, and it must stick.
//
// The live bug these tests pin: resolveUrlAttribution settles a declined URL
// with gate `no-candidates` / detail `user declined — not in any stream` and an
// EMPTY fusedCandidates array — the exact shape applyLaneFallbackGuess fires
// on. So the fallback re-suggested a workstream on a page the user had just
// refused one for.

let seq = 0;

const organized = (
  itemId: string,
  toContainer: string | null,
  atMs: number,
  over: { readonly action?: string; readonly itemKind?: string; readonly seq?: number } = {},
): AcceptedEvent => {
  seq += 1;
  return {
    type: USER_ORGANIZED_ITEM,
    acceptedAtMs: atMs,
    dot: { replicaId: 'r1', seq: over.seq ?? seq },
    payload: {
      payloadVersion: 1,
      itemKind: over.itemKind ?? 'canonical-url',
      itemId,
      action: over.action ?? 'move',
      ...(toContainer === null ? { toContainer: null } : { toContainer }),
    },
  } as unknown as AcceptedEvent;
};

const suggestion = (
  type: typeof SUGGESTION_ACCEPTED | typeof SUGGESTION_DECLINED,
  subjectId: string,
  workstreamId: string,
  atMs: number,
): AcceptedEvent => {
  seq += 1;
  return {
    type,
    acceptedAtMs: atMs,
    dot: { replicaId: 'r1', seq },
    payload: {
      payloadVersion: 1,
      suggestionSource: 'workstream-split',
      subjectKind: 'canonical-url',
      subjectId,
      workstreamId,
    },
  } as unknown as AcceptedEvent;
};

afterEach(() => {
  delete process.env[DECLINE_MEMORY_ENV];
});

describe('decline memory — (a) the fold reads the REAL decline shape', () => {
  it('records a canonical-url move whose toContainer is null', () => {
    const lookup = foldDeclineMemory([organized('https://a.test/x', null, 1_000)]);
    expect(lookup.declinedUrls.has('https://a.test/x')).toBe(true);
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(true);
  });

  it('does NOT record a filing (toContainer set)', () => {
    const lookup = foldDeclineMemory([organized('https://a.test/x', 'ws-1', 1_000)]);
    expect(lookup.declinedUrls.size).toBe(0);
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(false);
  });

  it('ignores USER_FLOW_REJECTED — that is a visit↔visit relation, not a filing decision', () => {
    // The brief that commissioned this module said declines append
    // USER_FLOW_REJECTED. They do not: that event rejects a RELATION between
    // two visits (relationKind/fromId/toId) and is already consumed as a
    // negative PPR seed. Reading it as "don't file this page" would suppress
    // suggestions on every page the user ever un-linked from another.
    const flowRejected = {
      type: USER_FLOW_REJECTED,
      acceptedAtMs: 1_000,
      dot: { replicaId: 'r1', seq: 99 },
      payload: {
        payloadVersion: 1,
        relationKind: 'visit_resembles_visit',
        fromId: 'https://a.test/x',
        toId: 'https://a.test/y',
        reason: 'not-related',
      },
    } as unknown as AcceptedEvent;
    expect(foldDeclineMemory([flowRejected]).declinedUrls.size).toBe(0);
  });

  it('ignores non-move actions and non-canonical-url item kinds', () => {
    const lookup = foldDeclineMemory([
      organized('https://a.test/ignored', null, 1_000, { action: 'ignore' }),
      organized('visit-42', null, 1_000, { itemKind: 'visit' }),
      organized('thread-7', null, 1_000, { itemKind: 'thread' }),
    ]);
    expect(lookup.declinedUrls.size).toBe(0);
  });
});

describe('decline memory — (b) latest-wins, exactly as the resolver decides it', () => {
  it('a later filing UN-declines a URL', () => {
    const lookup = foldDeclineMemory([
      organized('https://a.test/x', null, 1_000),
      organized('https://a.test/x', 'ws-1', 2_000),
    ]);
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(false);
  });

  it('a later decline re-declines a previously filed URL', () => {
    const lookup = foldDeclineMemory([
      organized('https://a.test/x', 'ws-1', 1_000),
      organized('https://a.test/x', null, 2_000),
    ]);
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(true);
  });

  it('breaks a same-millisecond tie on dot.seq — the resolver tie-break', () => {
    const lookup = foldDeclineMemory([
      organized('https://a.test/x', null, 5_000, { seq: 9 }),
      organized('https://a.test/x', 'ws-1', 5_000, { seq: 4 }),
    ]);
    // seq 9 (the decline) is the later event despite arriving first in the array.
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(true);
  });

  it('is order-insensitive in the input array (folds by timestamp, not position)', () => {
    const forward = foldDeclineMemory([
      organized('https://a.test/x', null, 1_000),
      organized('https://a.test/x', 'ws-1', 2_000),
    ]);
    const reversed = foldDeclineMemory([
      organized('https://a.test/x', 'ws-1', 2_000),
      organized('https://a.test/x', null, 1_000),
    ]);
    expect(isUrlDeclined(forward, 'https://a.test/x')).toBe(
      isUrlDeclined(reversed, 'https://a.test/x'),
    );
    expect(isUrlDeclined(reversed, 'https://a.test/x')).toBe(false);
  });
});

describe('decline memory — (c) lookup edge cases', () => {
  it('matches across trailing-slash spellings in both directions', () => {
    const withSlash = foldDeclineMemory([organized('https://a.test/x/', null, 1_000)]);
    expect(isUrlDeclined(withSlash, 'https://a.test/x')).toBe(true);
    const withoutSlash = foldDeclineMemory([organized('https://a.test/x', null, 1_000)]);
    expect(isUrlDeclined(withoutSlash, 'https://a.test/x/')).toBe(true);
  });

  it('reads an absent lookup as "no known decline" — it can never invent a suppression', () => {
    expect(isUrlDeclined(null, 'https://a.test/x')).toBe(false);
    expect(isUrlDeclined(undefined, 'https://a.test/x')).toBe(false);
    expect(isUrlDeclined(EMPTY_DECLINE_LOOKUP, 'https://a.test/x')).toBe(false);
  });

  it('is disabled by SIDETRACK_DECLINE_MEMORY=0 / false (default ON)', () => {
    const lookup = foldDeclineMemory([organized('https://a.test/x', null, 1_000)]);
    process.env[DECLINE_MEMORY_ENV] = '0';
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(false);
    process.env[DECLINE_MEMORY_ENV] = 'false';
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(false);
    process.env[DECLINE_MEMORY_ENV] = '1';
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(true);
    delete process.env[DECLINE_MEMORY_ENV];
    expect(isUrlDeclined(lookup, 'https://a.test/x')).toBe(true);
  });
});

describe('decline memory — (d) the lane-fallback veto (the live bug)', () => {
  const LANES: readonly GuessLaneResult[] = [
    { lane: 'graph', candidates: [], emptyReason: 'no graph path' },
    { lane: 'similarity', candidates: [], emptyReason: 'no similar pages' },
    { lane: 'topic', candidates: [], emptyReason: 'no topic membership' },
    { lane: 'title', candidates: [], emptyReason: 'no v1 state loaded' },
    { lane: 'domain', candidates: [], emptyReason: 'domain unseen' },
    { lane: 'recency', candidates: [], emptyReason: 'no recent filing' },
    { lane: 'content', candidates: [{ workstreamId: 'ws-ai', score: 0.62, why: '8 matches' }] },
    { lane: 'ai', candidates: [{ workstreamId: 'ws-ai', score: 0.71, why: '6 matches' }] },
  ];

  // The EXACT decision resolver.ts builds for a declined URL: an inbox settle,
  // 'no-candidates', and the detail that names the settle.
  const declinedResolution: ResultWithFusion = {
    decision: {
      action: 'inbox',
      margin: 0,
      gate: { reason: 'no-candidates', detail: 'user declined — not in any stream' },
    },
    fusedCandidates: [],
    lanes: LANES,
  };

  it('does not synthesize a pick for a URL the user declined', () => {
    const declines = foldDeclineMemory([organized('https://a.test/declined', null, 1_000)]);
    const out = applyLaneFallbackGuess(declinedResolution, {
      canonicalUrl: 'https://a.test/declined',
      declines,
    });
    // Identity: nothing was rewritten at all.
    expect(out).toBe(declinedResolution);
    expect(out.fusedCandidates).toHaveLength(0);
    expect(out.decision.gate?.detail).toBe('user declined — not in any stream');
  });

  it('REGRESSION: without the decline memory it fires — this is the shipped bug', () => {
    // Pinned deliberately. The veto is opt-in per call site, so this asserts
    // what "forgot to pass it" costs, and fails loudly if the default flips.
    const out = applyLaneFallbackGuess(declinedResolution);
    expect(out).not.toBe(declinedResolution);
    expect(out.fusedCandidates[0]?.workstreamId).toBe('ws-ai');
  });

  it('still fires for a NON-declined URL with the memory supplied', () => {
    const declines = foldDeclineMemory([organized('https://a.test/other', null, 1_000)]);
    const out = applyLaneFallbackGuess(declinedResolution, {
      canonicalUrl: 'https://a.test/fresh',
      declines,
    });
    expect(out.fusedCandidates[0]?.workstreamId).toBe('ws-ai');
  });

  it('fires again once the user files the previously-declined URL', () => {
    const declines = foldDeclineMemory([
      organized('https://a.test/declined', null, 1_000),
      organized('https://a.test/declined', 'ws-ai', 2_000),
    ]);
    const out = applyLaneFallbackGuess(declinedResolution, {
      canonicalUrl: 'https://a.test/declined',
      declines,
    });
    expect(out.fusedCandidates[0]?.workstreamId).toBe('ws-ai');
  });

  it('the kill switch restores the pre-feature behavior', () => {
    process.env[DECLINE_MEMORY_ENV] = '0';
    const declines = foldDeclineMemory([organized('https://a.test/declined', null, 1_000)]);
    const out = applyLaneFallbackGuess(declinedResolution, {
      canonicalUrl: 'https://a.test/declined',
      declines,
    });
    expect(out.fusedCandidates[0]?.workstreamId).toBe('ws-ai');
  });
});

// Phase 1 multi-membership (docs/plans/2026-08-16-category-flexibility-hyde.md
// §5) — generalized, per-workstream decline memory. E6: "declined workstream
// A, still open to B" is a different assertion than the global "not in any
// stream" bit above, and must be consulted separately.
describe('decline memory — generalized per-workstream (§5)', () => {
  it('declining workstream C for a URL does not suppress A or B', () => {
    const lookup = foldDeclineMemory([suggestion(SUGGESTION_DECLINED, 'https://a.test/x', 'ws-c', 1_000)]);
    expect(isWorkstreamDeclined(lookup, 'https://a.test/x', 'ws-c')).toBe(true);
    expect(isWorkstreamDeclined(lookup, 'https://a.test/x', 'ws-a')).toBe(false);
    expect(isWorkstreamDeclined(lookup, 'https://a.test/x', 'ws-b')).toBe(false);
  });

  it('a decline on one URL never leaks to a different URL ("declined here != declined there")', () => {
    const lookup = foldDeclineMemory([suggestion(SUGGESTION_DECLINED, 'https://a.test/x', 'ws-c', 1_000)]);
    expect(isWorkstreamDeclined(lookup, 'https://a.test/y', 'ws-c')).toBe(false);
  });

  it('never resurfaces after decline: repeated folds of the same event stay declined', () => {
    const events = [suggestion(SUGGESTION_DECLINED, 'https://a.test/x', 'ws-c', 1_000)];
    expect(isWorkstreamDeclined(foldDeclineMemory(events), 'https://a.test/x', 'ws-c')).toBe(true);
    expect(isWorkstreamDeclined(foldDeclineMemory(events), 'https://a.test/x', 'ws-c')).toBe(true);
  });

  it('a later accept of the exact same pair clears the decline (latest-wins, not append-only)', () => {
    const lookup = foldDeclineMemory([
      suggestion(SUGGESTION_DECLINED, 'https://a.test/x', 'ws-c', 1_000),
      suggestion(SUGGESTION_ACCEPTED, 'https://a.test/x', 'ws-c', 2_000),
    ]);
    expect(isWorkstreamDeclined(lookup, 'https://a.test/x', 'ws-c')).toBe(false);
  });

  it('an earlier accept does not override a LATER decline (order matters, not just presence)', () => {
    const lookup = foldDeclineMemory([
      suggestion(SUGGESTION_ACCEPTED, 'https://a.test/x', 'ws-c', 1_000),
      suggestion(SUGGESTION_DECLINED, 'https://a.test/x', 'ws-c', 2_000),
    ]);
    expect(isWorkstreamDeclined(lookup, 'https://a.test/x', 'ws-c')).toBe(true);
  });

  it('a global "not in any stream" decline subsumes every per-workstream check', () => {
    const lookup = foldDeclineMemory([organized('https://a.test/x', null, 1_000)]);
    expect(isWorkstreamDeclined(lookup, 'https://a.test/x', 'ws-anything')).toBe(true);
  });

  it('the kill switch also disables the per-workstream check', () => {
    process.env[DECLINE_MEMORY_ENV] = '0';
    const lookup = foldDeclineMemory([suggestion(SUGGESTION_DECLINED, 'https://a.test/x', 'ws-c', 1_000)]);
    expect(isWorkstreamDeclined(lookup, 'https://a.test/x', 'ws-c')).toBe(false);
  });

  it('a null/undefined lookup reads as "no known decline"', () => {
    expect(isWorkstreamDeclined(null, 'https://a.test/x', 'ws-c')).toBe(false);
    expect(isWorkstreamDeclined(undefined, 'https://a.test/x', 'ws-c')).toBe(false);
    expect(isWorkstreamDeclined(EMPTY_DECLINE_LOOKUP, 'https://a.test/x', 'ws-c')).toBe(false);
  });
});
