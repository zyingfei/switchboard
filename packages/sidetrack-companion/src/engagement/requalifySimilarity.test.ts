import { describe, expect, it } from 'vitest';

import {
  REQUALIFY_REPLICA_ID,
  planSimilarityRequalify,
  urlsWithSimilarityEdgeFromEdges,
} from './requalifySimilarity.js';
import {
  ENGAGEMENT_SESSION_AGGREGATED,
  type EngagementDimensions,
} from './events.js';
import type { AcceptedEvent } from '../sync/causal.js';

const dims = (focusedWindowMs: number): EngagementDimensions => ({
  activeMs: focusedWindowMs,
  visibleMs: focusedWindowMs,
  focusedWindowMs,
  idleMs: 0,
  foregroundBursts: 1,
  returnCount: 0,
  scrollEvents: 0,
  maxScrollRatio: 0,
  copyCount: 0,
  pasteCount: 0,
});

let seq = 0;
const aggregate = (input: {
  readonly visitId: string;
  readonly focusedWindowMs: number;
  readonly sessionSuffix?: string;
}): AcceptedEvent => {
  const sessionId = `s${input.sessionSuffix ?? ''}:${input.visitId}`;
  return {
    clientEventId: `agg-${String((seq += 1))}`,
    dot: { replicaId: 'edge_backfill', seq },
    deps: {},
    aggregateId: `${ENGAGEMENT_SESSION_AGGREGATED}:${input.visitId}`,
    type: ENGAGEMENT_SESSION_AGGREGATED,
    payload: {
      payloadVersion: 1,
      visitId: input.visitId,
      sessionId,
      dimensions: { engagement: dims(input.focusedWindowMs) },
    },
    acceptedAtMs: 1_780_000_000_000 + seq * 1000,
  };
};

const simEdge = (a: string, b: string) => ({
  kind: 'visit_resembles_visit',
  fromNodeId: `timeline-visit:${a}`,
  toNodeId: `timeline-visit:${b}`,
});

describe('planSimilarityRequalify', () => {
  it('flags gate-eligible visits that have no similarity edge as the backlog', () => {
    const aggregates = [
      // Eligible + already has a sim edge → NOT backlog.
      aggregate({ visitId: 'visit:https://a.test/x', focusedWindowMs: 60_000 }),
      // Eligible + NO sim edge → backlog.
      aggregate({ visitId: 'visit:https://b.test/y', focusedWindowMs: 40_000 }),
      // Below gate → excluded entirely.
      aggregate({ visitId: 'visit:https://c.test/z', focusedWindowMs: 100 }),
    ];
    const urlsWithEdge = urlsWithSimilarityEdgeFromEdges([
      simEdge('https://a.test/x', 'https://d.test/w'),
    ]);
    const plan = planSimilarityRequalify({ aggregates, urlsWithSimilarityEdge: urlsWithEdge });

    expect(plan.stats.distinctEligibleVisits).toBe(2);
    expect(plan.stats.visitsWithSimilarityEdge).toBe(1);
    expect(plan.stats.requalifyBacklog).toBe(1);
    expect(plan.stats.pingsPlanned).toBe(1);
    expect(plan.backlogUrls).toEqual(['https://b.test/y']);
  });

  it('sums focusedWindowMs across sessions before applying the gate', () => {
    // Two 3s sessions for the same visit → 6s total crosses the 5s gate.
    const aggregates = [
      aggregate({ visitId: 'visit:https://sum.test/p', focusedWindowMs: 3_000, sessionSuffix: 'A' }),
      aggregate({ visitId: 'visit:https://sum.test/p', focusedWindowMs: 3_000, sessionSuffix: 'B' }),
    ];
    const plan = planSimilarityRequalify({
      aggregates,
      urlsWithSimilarityEdge: new Set<string>(),
    });
    expect(plan.stats.distinctEligibleVisits).toBe(1);
    expect(plan.stats.requalifyBacklog).toBe(1);
    expect(plan.backlogUrls).toEqual(['https://sum.test/p']);
  });

  it('emits zero-dimension pings under the requalify replica with deterministic ids', () => {
    const aggregates = [
      aggregate({ visitId: 'visit:https://b.test/y', focusedWindowMs: 40_000 }),
    ];
    const plan = planSimilarityRequalify({
      aggregates,
      urlsWithSimilarityEdge: new Set<string>(),
    });
    expect(plan.events).toHaveLength(1);
    const event = plan.events[0]!;
    expect(event.type).toBe(ENGAGEMENT_SESSION_AGGREGATED);
    expect(event.dot.replicaId).toBe(REQUALIFY_REPLICA_ID);
    // Zero dimensions: adds nothing to the classifier's per-visit sum.
    expect(event.payload.dimensions.engagement.focusedWindowMs).toBe(0);
    expect(event.payload.dimensions.engagement.activeMs).toBe(0);
    // Aggregate id folds onto the real aggregate lane.
    expect(event.aggregateId).toBe(
      `${ENGAGEMENT_SESSION_AGGREGATED}:visit:https://b.test/y`,
    );

    // Determinism: re-planning regenerates identical dots + clientEventIds.
    const replan = planSimilarityRequalify({
      aggregates,
      urlsWithSimilarityEdge: new Set<string>(),
    });
    expect(replan.events[0]!.clientEventId).toBe(event.clientEventId);
    expect(replan.events[0]!.dot).toEqual(event.dot);
  });

  it('caps the number of pings emitted', () => {
    const aggregates = [
      aggregate({ visitId: 'visit:https://one.test', focusedWindowMs: 40_000 }),
      aggregate({ visitId: 'visit:https://two.test', focusedWindowMs: 40_000 }),
      aggregate({ visitId: 'visit:https://three.test', focusedWindowMs: 40_000 }),
    ];
    const plan = planSimilarityRequalify({
      aggregates,
      urlsWithSimilarityEdge: new Set<string>(),
      options: { maxPings: 2 },
    });
    expect(plan.stats.requalifyBacklog).toBe(3);
    expect(plan.stats.pingsPlanned).toBe(2);
    expect(plan.stats.cappedBy).toBe(2);
    // Report still surfaces the full backlog even when pings are capped.
    expect(plan.backlogUrls).toHaveLength(3);
  });

  it('produces an empty plan when every eligible visit already resembles', () => {
    const aggregates = [
      aggregate({ visitId: 'visit:https://done.test/q', focusedWindowMs: 60_000 }),
    ];
    const plan = planSimilarityRequalify({
      aggregates,
      urlsWithSimilarityEdge: urlsWithSimilarityEdgeFromEdges([
        simEdge('https://done.test/q', 'https://other.test/r'),
      ]),
    });
    expect(plan.stats.requalifyBacklog).toBe(0);
    expect(plan.events).toHaveLength(0);
  });
});
