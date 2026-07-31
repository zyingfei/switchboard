// Engagement-lane freshness probe — aggregate-vs-interval divergence.
//
// The two-week silence that starved visit-similarity vault-wide
// (engagement.session.aggregated stopped ~2026-06-27 while
// engagement.interval.observed kept flowing) was invisible because no
// health surface tracked the two lanes separately. This probe makes the
// divergence observable: it reports the last-seen wall-clock of each lane
// and raises a flag when intervals have flowed recently but no aggregate
// has been seen for longer than a threshold — the exact fingerprint of the
// regression.
//
// FREEZE-SAFE (ADR-0011): observability only. No serving-math consumer
// reads any of this — it never gates similarity, attribution, or ranking.
//
// Cost: three indexed MAX(accepted_at_ms) queries (retained interval,
// compacted interval receipt, aggregate). Cheap enough for the request-time
// health path; also materialized at drain via the health report.

import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
} from '../engagement/events.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';

// Intervals flow ~every 30s from any active tab. If we've seen an interval
// within the last day but no aggregate for longer than this, the aggregate
// lane has stalled (a session should finalize — and emit an aggregate —
// within minutes of a tab going idle/closing).
export const ENGAGEMENT_AGGREGATE_STALL_MS = 24 * 60 * 60_000;
// Only flag when intervals are actively flowing; a quiescent browser (no
// intervals either) is not a divergence, just idleness.
export const ENGAGEMENT_INTERVAL_FRESH_MS = 24 * 60 * 60_000;

export interface EngagementLaneHealth {
  // Wall-clock ms of the most recent event on each lane; 0 = never seen.
  readonly intervalObservedLastSeenMs: number;
  readonly sessionAggregateLastSeenMs: number;
  // Gap between the two lanes (interval - aggregate), ms; 0 when aggregate
  // is at least as fresh as interval.
  readonly aggregateLagMs: number;
  /** Retained raw evidence can prove flowing/idle; compacted/absent is unknown. */
  readonly intervalFlowState: 'flowing' | 'idle' | 'unknown';
  // TRUE when intervals are flowing (fresh within
  // ENGAGEMENT_INTERVAL_FRESH_MS) but the aggregate lane has stalled
  // (aggregateLagMs >= ENGAGEMENT_AGGREGATE_STALL_MS, OR aggregate never
  // seen while intervals exist). This is the divergence alarm.
  readonly aggregateStalled: boolean | null;
}

export const emptyEngagementLaneHealth = (): EngagementLaneHealth => ({
  intervalObservedLastSeenMs: 0,
  sessionAggregateLastSeenMs: 0,
  aggregateLagMs: 0,
  intervalFlowState: 'unknown',
  aggregateStalled: null,
});

export interface ComputeEngagementLaneHealthInputs {
  readonly intervalObservedLastSeenMs: number;
  readonly sessionAggregateLastSeenMs: number;
  readonly nowMs: number;
  readonly aggregateStallMs?: number;
  readonly intervalFreshMs?: number;
  readonly intervalEvidence?: 'retained' | 'compacted-only' | 'absent';
}

// Pure — decoupled from the store so it's exhaustively testable.
export const computeEngagementLaneHealth = (
  inputs: ComputeEngagementLaneHealthInputs,
): EngagementLaneHealth => {
  const stallMs = inputs.aggregateStallMs ?? ENGAGEMENT_AGGREGATE_STALL_MS;
  const freshMs = inputs.intervalFreshMs ?? ENGAGEMENT_INTERVAL_FRESH_MS;
  const intervalLast = inputs.intervalObservedLastSeenMs;
  const aggregateLast = inputs.sessionAggregateLastSeenMs;
  // Reference the interval clock, not `nowMs`, for the lag: the two lanes
  // are relative to each other. When aggregate is fresher than interval
  // (possible right after a final), the lag floors at 0.
  const aggregateLagMs = intervalLast > aggregateLast ? intervalLast - aggregateLast : 0;
  const evidence = inputs.intervalEvidence ?? (intervalLast > 0 ? 'retained' : 'absent');
  const intervalFlowState =
    evidence !== 'retained'
      ? 'unknown'
      : inputs.nowMs - intervalLast <= freshMs
        ? 'flowing'
        : 'idle';
  const aggregateStalled =
    intervalFlowState === 'unknown'
      ? null
      : intervalFlowState === 'flowing' && aggregateLagMs >= stallMs;
  return {
    intervalObservedLastSeenMs: intervalLast,
    sessionAggregateLastSeenMs: aggregateLast,
    aggregateLagMs,
    intervalFlowState,
    aggregateStalled,
  };
};

// Read the two lane last-seen timestamps from the shared event store and
// compute the health. Returns the empty (all-zero, unknown) health when
// the store is unavailable — never throws, never blocks a drain.
export const collectEngagementLaneHealth = async (input: {
  readonly vaultRoot: string;
  readonly nowMs?: number;
}): Promise<EngagementLaneHealth> => {
  try {
    const store = await getCaughtUpSharedEventStore(input.vaultRoot);
    if (store === null) return emptyEngagementLaneHealth();
    const retainedIntervalLastSeenMs = store.maxAcceptedAtMsForType(ENGAGEMENT_INTERVAL_OBSERVED);
    const compactedIntervalLastSeenMs = store.maxCompactedAcceptedAtMsForType(
      ENGAGEMENT_INTERVAL_OBSERVED,
    );
    const intervalObservedLastSeenMs = Math.max(
      retainedIntervalLastSeenMs,
      compactedIntervalLastSeenMs,
    );
    const sessionAggregateLastSeenMs = store.maxAcceptedAtMsForType(ENGAGEMENT_SESSION_AGGREGATED);
    return computeEngagementLaneHealth({
      intervalObservedLastSeenMs,
      sessionAggregateLastSeenMs,
      nowMs: input.nowMs ?? Date.now(),
      intervalEvidence:
        retainedIntervalLastSeenMs > 0
          ? 'retained'
          : compactedIntervalLastSeenMs > 0
            ? 'compacted-only'
            : 'absent',
    });
  } catch {
    return emptyEngagementLaneHealth();
  }
};
