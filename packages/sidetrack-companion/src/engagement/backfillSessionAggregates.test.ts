import { describe, expect, it } from 'vitest';

import {
  BACKFILL_REPLICA_ID,
  planEngagementBackfill,
} from './backfillSessionAggregates.js';
import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
  type EngagementDimensions,
} from './events.js';
import type { AcceptedEvent } from '../sync/causal.js';

const dims = (over: Partial<EngagementDimensions> = {}): EngagementDimensions => ({
  activeMs: 0,
  visibleMs: 0,
  focusedWindowMs: 0,
  idleMs: 0,
  foregroundBursts: 0,
  returnCount: 0,
  scrollEvents: 0,
  maxScrollRatio: 0,
  copyCount: 0,
  pasteCount: 0,
  ...over,
});

let seq = 0;
const interval = (input: {
  readonly visitId: string;
  readonly acceptedAtMs: number;
  readonly engagement?: Partial<EngagementDimensions>;
}): AcceptedEvent => ({
  clientEventId: `int-${String((seq += 1))}`,
  dot: { replicaId: 'edge_x', seq },
  deps: {},
  aggregateId: `${ENGAGEMENT_INTERVAL_OBSERVED}:${input.visitId}`,
  type: ENGAGEMENT_INTERVAL_OBSERVED,
  payload: {
    payloadVersion: 1,
    visitId: input.visitId,
    intervalStart: input.acceptedAtMs - 30_000,
    intervalEnd: input.acceptedAtMs,
    dimensions: { engagement: dims(input.engagement) },
  },
  acceptedAtMs: input.acceptedAtMs,
});

const aggregate = (visitId: string): AcceptedEvent => ({
  clientEventId: `agg-${visitId}`,
  dot: { replicaId: 'edge_x', seq: (seq += 1) },
  deps: {},
  aggregateId: `${ENGAGEMENT_SESSION_AGGREGATED}:${visitId}`,
  type: ENGAGEMENT_SESSION_AGGREGATED,
  payload: {
    payloadVersion: 1,
    visitId,
    sessionId: `session:real:${visitId}`,
    dimensions: { engagement: dims({ focusedWindowMs: 9_000 }) },
  },
  acceptedAtMs: 1_000,
});

describe('planEngagementBackfill', () => {
  it('sums per-visit intervals into one synthetic aggregate with the right shape', () => {
    const plan = planEngagementBackfill({
      intervals: [
        interval({ visitId: 'visit:a', acceptedAtMs: 5_000, engagement: { focusedWindowMs: 4_000, maxScrollRatio: 0.3 } }),
        interval({ visitId: 'visit:a', acceptedAtMs: 6_000, engagement: { focusedWindowMs: 2_000, maxScrollRatio: 0.7 } }),
      ],
      existingAggregates: [],
      options: { fromMs: 0, toMs: 10_000 },
    });
    expect(plan.events).toHaveLength(1);
    const ev = plan.events[0];
    expect(ev?.type).toBe(ENGAGEMENT_SESSION_AGGREGATED);
    expect(ev?.dot.replicaId).toBe(BACKFILL_REPLICA_ID);
    // aggregateId must match the extension's stamping so it folds onto the
    // same lane as real aggregates.
    expect(ev?.aggregateId).toBe('engagement.session.aggregated:visit:a');
    expect(ev?.payload.visitId).toBe('visit:a');
    expect(ev?.payload.sessionId).toBe('backfill:visit:a');
    // Field-wise SUM; maxScrollRatio is a MAX.
    expect(ev?.payload.dimensions.engagement.focusedWindowMs).toBe(6_000);
    expect(ev?.payload.dimensions.engagement.maxScrollRatio).toBe(0.7);
    expect(plan.stats.synthesizedVisits).toBe(1);
    expect(plan.stats.intervalsInWindow).toBe(2);
  });

  it('EXCLUDES visits that already have a real aggregate (no double-count)', () => {
    const plan = planEngagementBackfill({
      intervals: [
        interval({ visitId: 'visit:has-agg', acceptedAtMs: 5_000, engagement: { focusedWindowMs: 4_000 } }),
        interval({ visitId: 'visit:missing', acceptedAtMs: 5_000, engagement: { focusedWindowMs: 8_000 } }),
      ],
      existingAggregates: [aggregate('visit:has-agg')],
      options: { fromMs: 0, toMs: 10_000 },
    });
    expect(plan.events.map((e) => e.payload.visitId)).toEqual(['visit:missing']);
    expect(plan.stats.visitsWithExistingAggregate).toBe(1);
    expect(plan.stats.synthesizedVisits).toBe(1);
  });

  it('only sums intervals inside the [fromMs, toMs] window', () => {
    const plan = planEngagementBackfill({
      intervals: [
        interval({ visitId: 'visit:a', acceptedAtMs: 1_000, engagement: { focusedWindowMs: 100 } }), // before
        interval({ visitId: 'visit:a', acceptedAtMs: 5_000, engagement: { focusedWindowMs: 200 } }), // in
        interval({ visitId: 'visit:a', acceptedAtMs: 99_000, engagement: { focusedWindowMs: 400 } }), // after
      ],
      existingAggregates: [],
      options: { fromMs: 2_000, toMs: 10_000 },
    });
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]?.payload.dimensions.engagement.focusedWindowMs).toBe(200);
    expect(plan.stats.intervalsScanned).toBe(3);
    expect(plan.stats.intervalsInWindow).toBe(1);
  });

  it('is deterministic: identical inputs produce identical dots + clientEventIds (idempotent re-run)', () => {
    const build = () =>
      planEngagementBackfill({
        intervals: [
          interval({ visitId: 'visit:b', acceptedAtMs: 5_000, engagement: { focusedWindowMs: 1 } }),
          interval({ visitId: 'visit:a', acceptedAtMs: 5_000, engagement: { focusedWindowMs: 1 } }),
        ],
        existingAggregates: [],
        options: { fromMs: 0, toMs: 10_000, startSeq: 1 },
      });
    const a = build();
    const b = build();
    // Sorted by visitId → stable ordering → stable seq assignment.
    expect(a.events.map((e) => [e.dot.seq, e.clientEventId, e.payload.visitId])).toEqual([
      [1, 'backfill:engagement.session.aggregated:visit:a', 'visit:a'],
      [2, 'backfill:engagement.session.aggregated:visit:b', 'visit:b'],
    ]);
    expect(a.events).toEqual(b.events);
  });

  it('emits nothing when there are no in-window intervals', () => {
    const plan = planEngagementBackfill({
      intervals: [interval({ visitId: 'visit:a', acceptedAtMs: 500, engagement: { focusedWindowMs: 1 } })],
      existingAggregates: [],
      options: { fromMs: 1_000, toMs: 2_000 },
    });
    expect(plan.events).toHaveLength(0);
    expect(plan.stats.synthesizedVisits).toBe(0);
  });

  it('carries deps={} and no hlc so the synthetic events never falsely dominate', () => {
    const plan = planEngagementBackfill({
      intervals: [interval({ visitId: 'visit:a', acceptedAtMs: 5_000, engagement: { focusedWindowMs: 1 } })],
      existingAggregates: [],
      options: { fromMs: 0, toMs: 10_000 },
    });
    expect(plan.events[0]?.deps).toEqual({});
    expect(plan.events[0]?.hlc).toBeUndefined();
  });
});
