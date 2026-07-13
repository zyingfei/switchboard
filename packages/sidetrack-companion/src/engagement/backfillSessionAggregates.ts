// One-shot gap backfill: derive `engagement.session.aggregated` events from
// logged `engagement.interval.observed` events.
//
// WHY: `session.aggregated` — the only event the engagement classifier
// folds into a visit's `focusedWindowMs` (the >=5000ms visit-similarity
// gate) — stopped being emitted ~2026-06-27 while intervals kept flowing.
// The intervals ARE in the log with real focusedWindowMs, so the missing
// aggregates can be reconstructed by event-sourced append (kosher: no
// rewriting, deterministic + idempotent).
//
// DERIVATION (deliberately conservative — MUST NOT double-count):
//   - The logged interval payload carries NO tabId/sessionId, so the
//     per-tab session boundaries the live path used are UNRECOVERABLE. We
//     therefore collapse ALL intervals for a visitId into ONE synthetic
//     aggregate. This is byte-consistent with how the classifier consumes
//     aggregates: `engagementClassifierInputsFromAccumulator` sums every
//     per-session aggregate for a visitId into one per-visit total anyway,
//     so the per-session granularity is discarded before classification.
//   - EXCLUDE any visitId that ALREADY has a real `session.aggregated`
//     event. Since the classifier SUMS all aggregates per visitId, adding
//     a per-visit sum on top of an existing aggregate would double-count.
//     Excluding the whole visit is safe (never over-counts); it only
//     under-backfills revisits that already partly attributed — and those
//     already cross the >=5s gate, so attribution loses nothing that
//     matters.
//   - Field-wise SUM for every counter; `maxScrollRatio` is a MAX (each
//     interval already carries a per-interval max). This matches the
//     extension aggregator's mergeEngagementTotals exactly.
//
// FREEZE-SAFE: appends events only; no serving-math change, no rewrite.

import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
  isEngagementIntervalObservedPayload,
  isEngagementSessionAggregatedPayload,
  type EngagementDimensions,
  type EngagementSessionAggregatedPayload,
} from './events.js';
import type { AcceptedEvent } from '../sync/causal.js';

// The replicaId the synthetic events are appended under. Distinct from the
// companion's own UUID replicaId (importPeerEvent rejects self-replica
// writes) and from any edge replica; path-safe (alnum + underscore).
export const BACKFILL_REPLICA_ID = 'edge_backfill';

const emptyDimensions = (): EngagementDimensions => ({
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
});

const sumDimensions = (
  left: EngagementDimensions,
  right: EngagementDimensions,
): EngagementDimensions => ({
  activeMs: left.activeMs + right.activeMs,
  visibleMs: left.visibleMs + right.visibleMs,
  focusedWindowMs: left.focusedWindowMs + right.focusedWindowMs,
  idleMs: left.idleMs + right.idleMs,
  foregroundBursts: left.foregroundBursts + right.foregroundBursts,
  returnCount: left.returnCount + right.returnCount,
  scrollEvents: left.scrollEvents + right.scrollEvents,
  maxScrollRatio: Math.max(left.maxScrollRatio, right.maxScrollRatio),
  copyCount: left.copyCount + right.copyCount,
  pasteCount: left.pasteCount + right.pasteCount,
});

export interface BackfillOptions {
  // Only backfill intervals whose acceptedAtMs falls in [fromMs, toMs].
  // Bounds the blast radius to the known gap window.
  readonly fromMs: number;
  readonly toMs: number;
  // Starting seq for the synthetic replica's dot; each emitted event gets a
  // monotonically increasing seq from here. Deterministic given a stable
  // visit ordering (we sort by visitId) so re-runs regenerate identical
  // dots and dedup rather than throwing ClientEventIdReuseError.
  readonly startSeq?: number;
}

export interface BackfillPlan {
  readonly events: readonly AcceptedEvent<EngagementSessionAggregatedPayload>[];
  readonly stats: {
    readonly intervalsScanned: number;
    readonly intervalsInWindow: number;
    readonly distinctVisitsInWindow: number;
    readonly visitsWithExistingAggregate: number;
    readonly synthesizedVisits: number;
  };
}

const backfillClientEventId = (visitId: string): string =>
  `backfill:engagement.session.aggregated:${visitId}`;

const backfillSessionId = (visitId: string): string => `backfill:${visitId}`;

// Aggregate id MUST match what the extension stamps on real events
// (`engagement.session.aggregated:<visitId>`) so downstream projections
// fold the backfilled event onto the same aggregate lane.
const backfillAggregateId = (visitId: string): string =>
  `${ENGAGEMENT_SESSION_AGGREGATED}:${visitId}`;

/**
 * Pure derivation. Given the logged interval + aggregate events, returns
 * the synthetic `session.aggregated` events to append (one per eligible
 * visit) plus stats. Deterministic: events are ordered by visitId and
 * carry deterministic dots/clientEventIds, so re-running is a no-op.
 */
export const planEngagementBackfill = (input: {
  readonly intervals: readonly AcceptedEvent[];
  readonly existingAggregates: readonly AcceptedEvent[];
  readonly options: BackfillOptions;
}): BackfillPlan => {
  const { fromMs, toMs } = input.options;
  const startSeq = input.options.startSeq ?? 1;

  // Visits that already have a real aggregate — excluded to avoid the
  // classifier double-counting.
  const excluded = new Set<string>();
  for (const event of input.existingAggregates) {
    if (event.type !== ENGAGEMENT_SESSION_AGGREGATED) continue;
    if (!isEngagementSessionAggregatedPayload(event.payload)) continue;
    excluded.add(event.payload.visitId);
  }

  // Sum in-window intervals per visitId.
  const totalsByVisit = new Map<string, EngagementDimensions>();
  let intervalsScanned = 0;
  let intervalsInWindow = 0;
  for (const event of input.intervals) {
    if (event.type !== ENGAGEMENT_INTERVAL_OBSERVED) continue;
    intervalsScanned += 1;
    if (event.acceptedAtMs < fromMs || event.acceptedAtMs > toMs) continue;
    if (!isEngagementIntervalObservedPayload(event.payload)) continue;
    intervalsInWindow += 1;
    const visitId = event.payload.visitId;
    const existing = totalsByVisit.get(visitId) ?? emptyDimensions();
    totalsByVisit.set(visitId, sumDimensions(existing, event.payload.dimensions.engagement));
  }

  const distinctVisitsInWindow = totalsByVisit.size;
  let visitsWithExistingAggregate = 0;
  const eligibleVisits: string[] = [];
  for (const visitId of totalsByVisit.keys()) {
    if (excluded.has(visitId)) {
      visitsWithExistingAggregate += 1;
      continue;
    }
    eligibleVisits.push(visitId);
  }
  eligibleVisits.sort((a, b) => a.localeCompare(b));

  const events: AcceptedEvent<EngagementSessionAggregatedPayload>[] = [];
  let seq = startSeq;
  for (const visitId of eligibleVisits) {
    const engagement = totalsByVisit.get(visitId) ?? emptyDimensions();
    const payload: EngagementSessionAggregatedPayload = {
      payloadVersion: 1,
      visitId,
      sessionId: backfillSessionId(visitId),
      dimensions: { engagement },
    };
    events.push({
      clientEventId: backfillClientEventId(visitId),
      dot: { replicaId: BACKFILL_REPLICA_ID, seq },
      deps: {},
      aggregateId: backfillAggregateId(visitId),
      type: ENGAGEMENT_SESSION_AGGREGATED,
      payload,
      // Stamp at the window's end so the synthetic event sorts after the
      // intervals it summarizes and reflects when the backfill covers.
      acceptedAtMs: toMs,
    });
    seq += 1;
  }

  return {
    events,
    stats: {
      intervalsScanned,
      intervalsInWindow,
      distinctVisitsInWindow,
      visitsWithExistingAggregate,
      synthesizedVisits: events.length,
    },
  };
};
