import { describe, expect, it } from 'vitest';

import {
  ENGAGEMENT_AGGREGATE_STALL_MS,
  ENGAGEMENT_INTERVAL_FRESH_MS,
  computeEngagementLaneHealth,
  emptyEngagementLaneHealth,
} from './engagementLaneHealth.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe('computeEngagementLaneHealth', () => {
  it('is not stalled when both lanes are fresh and roughly in step', () => {
    const now = 100 * DAY;
    const health = computeEngagementLaneHealth({
      intervalObservedLastSeenMs: now - 30_000,
      sessionAggregateLastSeenMs: now - 5 * 60_000,
      nowMs: now,
    });
    expect(health.aggregateStalled).toBe(false);
    expect(health.aggregateLagMs).toBe(5 * 60_000 - 30_000);
  });

  it('flags a stall when intervals flow but aggregates are >24h behind (the 06-27 regression fingerprint)', () => {
    const now = 100 * DAY;
    const health = computeEngagementLaneHealth({
      intervalObservedLastSeenMs: now - 60_000, // interval a minute ago
      sessionAggregateLastSeenMs: now - 3 * DAY, // aggregate 3 days stale
      nowMs: now,
    });
    expect(health.aggregateStalled).toBe(true);
    expect(health.aggregateLagMs).toBe(3 * DAY - 60_000);
    expect(health.intervalObservedLastSeenMs).toBe(now - 60_000);
    expect(health.sessionAggregateLastSeenMs).toBe(now - 3 * DAY);
  });

  it('flags a stall when intervals flow but an aggregate was NEVER seen', () => {
    const now = 100 * DAY;
    const health = computeEngagementLaneHealth({
      intervalObservedLastSeenMs: now - 60_000,
      sessionAggregateLastSeenMs: 0, // never
      nowMs: now,
    });
    expect(health.aggregateStalled).toBe(true);
    expect(health.aggregateLagMs).toBe(now - 60_000);
  });

  it('does NOT flag when the browser is quiescent (no fresh intervals either)', () => {
    const now = 100 * DAY;
    // Both lanes are old (user hasn't browsed in a week) — not a
    // divergence, just idleness. Silence here is expected, not alarming.
    const health = computeEngagementLaneHealth({
      intervalObservedLastSeenMs: now - 7 * DAY,
      sessionAggregateLastSeenMs: now - 7 * DAY - HOUR,
      nowMs: now,
    });
    expect(health.aggregateStalled).toBe(false);
  });

  it('does NOT flag when there is no engagement data at all', () => {
    const now = 100 * DAY;
    const health = computeEngagementLaneHealth({
      intervalObservedLastSeenMs: 0,
      sessionAggregateLastSeenMs: 0,
      nowMs: now,
    });
    expect(health.aggregateStalled).toBe(false);
    expect(health.aggregateLagMs).toBe(0);
  });

  it('floors the lag at 0 when the aggregate is fresher than the interval', () => {
    const now = 100 * DAY;
    const health = computeEngagementLaneHealth({
      intervalObservedLastSeenMs: now - 5 * 60_000,
      sessionAggregateLastSeenMs: now - 60_000, // aggregate is newer
      nowMs: now,
    });
    expect(health.aggregateLagMs).toBe(0);
    expect(health.aggregateStalled).toBe(false);
  });

  it('respects the exact stall / freshness thresholds at the boundary', () => {
    const now = 100 * DAY;
    // Interval is exactly at the freshness edge; aggregate exactly at the
    // stall edge relative to it → stalled (>= is inclusive).
    const boundary = computeEngagementLaneHealth({
      intervalObservedLastSeenMs: now - ENGAGEMENT_INTERVAL_FRESH_MS,
      sessionAggregateLastSeenMs:
        now - ENGAGEMENT_INTERVAL_FRESH_MS - ENGAGEMENT_AGGREGATE_STALL_MS,
      nowMs: now,
    });
    expect(boundary.aggregateStalled).toBe(true);
    // One ms past the interval-freshness window → intervals no longer
    // considered flowing → not a divergence.
    const stale = computeEngagementLaneHealth({
      intervalObservedLastSeenMs: now - ENGAGEMENT_INTERVAL_FRESH_MS - 1,
      sessionAggregateLastSeenMs:
        now - ENGAGEMENT_INTERVAL_FRESH_MS - 1 - ENGAGEMENT_AGGREGATE_STALL_MS,
      nowMs: now,
    });
    expect(stale.aggregateStalled).toBe(false);
  });

  it('emptyEngagementLaneHealth is an all-zero, not-stalled sentinel', () => {
    expect(emptyEngagementLaneHealth()).toEqual({
      intervalObservedLastSeenMs: 0,
      sessionAggregateLastSeenMs: 0,
      aggregateLagMs: 0,
      aggregateStalled: false,
    });
  });
});
