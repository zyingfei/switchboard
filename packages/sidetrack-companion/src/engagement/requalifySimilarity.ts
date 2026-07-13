// One-shot similarity requalification planner.
//
// WHY: the engagement regression (session.aggregated stopped emitting
// ~2026-06-27, then a gap backfill re-derived the missing aggregates
// under the `edge_backfill` replica) left a HISTORICAL backlog: OLD
// visits whose late/backfilled engagement crosses the >=5000ms
// visit-similarity gate, but whose `visit_resembles_visit` edges never
// reformed. The scoped-delta materializer only revisits a visit whose
// URL is in the drain window (a fresh BROWSER_TIMELINE_OBSERVED) — a
// late engagement event puts the URL in neither the reconcile set nor
// the touched set (see connectionsMaterializer's requalification fix,
// which heals this GOING FORWARD). Already-drained backfill aggregates
// sit past the materializer frontier, so a restart alone won't re-drain
// them. This planner identifies that backlog and (on --apply) emits a
// minimal "requalify ping": a fresh ENGAGEMENT_SESSION_AGGREGATED event
// with ZERO dimensions under a distinct session id. Zero dimensions add
// nothing to the classifier's per-visit engagement SUM (so no
// double-count), but the event's `engagementVisit` invalidation forces
// the visit back into the next drain — where the materializer's
// requalify path re-embeds it and reforms its similarity edges.
//
// FREEZE-SAFE: appends events only; no serving-math change, no rewrite.
// Deterministic + idempotent: pings carry stable clientEventIds/dots, so
// re-running dedups rather than re-appending.

import {
  ENGAGEMENT_SESSION_AGGREGATED,
  isEngagementSessionAggregatedPayload,
  type EngagementDimensions,
  type EngagementSessionAggregatedPayload,
} from './events.js';
import type { AcceptedEvent } from '../sync/causal.js';

// Distinct from the browser UUID replicas and from the gap-backfill
// replica (`edge_backfill`). Path-safe (alnum + underscore).
export const REQUALIFY_REPLICA_ID = 'similarity_requalify';

const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

// Resolve an engagement visitId to the canonical URL the similarity gate
// keys on. Mirrors canonicalUrlForVisitId in the engagement classifier:
// `visit:<url>` strips to the URL; a bare URL/eventId strips the same
// way. (We cannot join through navigation here without the full
// classifier; the `visit:` form is what the gap backfill emits and is
// sufficient for the historical backlog.)
const canonicalUrlForEngagementVisitId = (visitId: string): string =>
  stripFragmentAndTrailingSlash(
    visitId.startsWith('visit:') ? visitId.slice('visit:'.length) : visitId,
  );

const zeroDimensions = (): EngagementDimensions => ({
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

const requalifyClientEventId = (visitId: string): string =>
  `requalify:engagement.session.aggregated:${visitId}`;

const requalifySessionId = (visitId: string): string => `requalify:${visitId}`;

// The aggregate id MUST match the real-event lane
// (`engagement.session.aggregated:<visitId>`) so the ping folds onto the
// same aggregate the classifier already sums.
const requalifyAggregateId = (visitId: string): string =>
  `${ENGAGEMENT_SESSION_AGGREGATED}:${visitId}`;

export interface RequalifyOptions {
  // Only requalify visits whose summed focusedWindowMs (over all
  // aggregates) is >= this gate. Defaults to the similarity gate.
  readonly engagementGateMs?: number;
  // Starting seq for the synthetic replica's dot; each emitted event gets
  // a monotonically increasing seq from here. Deterministic given a
  // stable visit ordering (sorted by canonical URL).
  readonly startSeq?: number;
  // Cap the number of pings emitted in one run (bounds the drain wave).
  // 0 / undefined => no cap.
  readonly maxPings?: number;
}

export interface RequalifyPlan {
  readonly events: readonly AcceptedEvent<EngagementSessionAggregatedPayload>[];
  readonly stats: {
    readonly aggregatesScanned: number;
    readonly distinctEligibleVisits: number;
    readonly visitsWithSimilarityEdge: number;
    readonly requalifyBacklog: number;
    readonly pingsPlanned: number;
    readonly cappedBy: number | null;
  };
  // The canonical URLs that need requalification (report surface).
  readonly backlogUrls: readonly string[];
}

/**
 * Pure derivation. Given the logged engagement aggregates and the set of
 * canonical URLs that ALREADY have at least one `visit_resembles_visit`
 * edge in the served snapshot, returns the requalify-ping events plus
 * stats. A visit is in the backlog when its summed focusedWindowMs
 * crosses the gate but it has NO similarity edge. Deterministic.
 */
export const planSimilarityRequalify = (input: {
  readonly aggregates: readonly AcceptedEvent[];
  // Canonical URLs (stripFragmentAndTrailingSlash form) that already have
  // >=1 visit_resembles_visit edge in the served snapshot.
  readonly urlsWithSimilarityEdge: ReadonlySet<string>;
  readonly options?: RequalifyOptions;
}): RequalifyPlan => {
  const engagementGateMs = input.options?.engagementGateMs ?? 5_000;
  const startSeq = input.options?.startSeq ?? 1;
  const maxPings = input.options?.maxPings ?? 0;

  // Sum focusedWindowMs per canonical URL across every aggregate (the
  // classifier sums all per-session aggregates per visit before the gate).
  const focusedMsByUrl = new Map<string, number>();
  let aggregatesScanned = 0;
  for (const event of input.aggregates) {
    if (event.type !== ENGAGEMENT_SESSION_AGGREGATED) continue;
    if (!isEngagementSessionAggregatedPayload(event.payload)) continue;
    aggregatesScanned += 1;
    const url = canonicalUrlForEngagementVisitId(event.payload.visitId);
    if (url.length === 0) continue;
    const focused = event.payload.dimensions.engagement.focusedWindowMs;
    focusedMsByUrl.set(url, (focusedMsByUrl.get(url) ?? 0) + (focused > 0 ? focused : 0));
  }

  const eligibleUrls: string[] = [];
  for (const [url, focusedMs] of focusedMsByUrl) {
    if (focusedMs >= engagementGateMs) eligibleUrls.push(url);
  }
  eligibleUrls.sort((a, b) => a.localeCompare(b));

  let visitsWithSimilarityEdge = 0;
  const backlogUrls: string[] = [];
  for (const url of eligibleUrls) {
    if (input.urlsWithSimilarityEdge.has(url)) {
      visitsWithSimilarityEdge += 1;
      continue;
    }
    backlogUrls.push(url);
  }

  const cappedBy = maxPings > 0 && backlogUrls.length > maxPings ? maxPings : null;
  const urlsToPing = cappedBy === null ? backlogUrls : backlogUrls.slice(0, maxPings);

  const events: AcceptedEvent<EngagementSessionAggregatedPayload>[] = [];
  let seq = startSeq;
  const maxAcceptedAtMs = input.aggregates.reduce(
    (max, event) => Math.max(max, event.acceptedAtMs),
    0,
  );
  for (const url of urlsToPing) {
    const visitId = `visit:${url}`;
    const payload: EngagementSessionAggregatedPayload = {
      payloadVersion: 1,
      visitId,
      sessionId: requalifySessionId(visitId),
      dimensions: { engagement: zeroDimensions() },
    };
    events.push({
      clientEventId: requalifyClientEventId(visitId),
      dot: { replicaId: REQUALIFY_REPLICA_ID, seq },
      deps: {},
      aggregateId: requalifyAggregateId(visitId),
      type: ENGAGEMENT_SESSION_AGGREGATED,
      payload,
      acceptedAtMs: maxAcceptedAtMs,
    });
    seq += 1;
  }

  return {
    events,
    stats: {
      aggregatesScanned,
      distinctEligibleVisits: eligibleUrls.length,
      visitsWithSimilarityEdge,
      requalifyBacklog: backlogUrls.length,
      pingsPlanned: events.length,
      cappedBy,
    },
    backlogUrls,
  };
};

/**
 * Extract the set of canonical URLs (strip-normalized) that already have
 * at least one `visit_resembles_visit` edge, from a served connections
 * snapshot's edges. Both endpoints are timeline-visit node ids.
 */
export const urlsWithSimilarityEdgeFromEdges = (
  edges: readonly { readonly kind: string; readonly fromNodeId: string; readonly toNodeId: string }[],
): ReadonlySet<string> => {
  const prefix = 'timeline-visit:';
  const urls = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== 'visit_resembles_visit') continue;
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      if (!nodeId.startsWith(prefix)) continue;
      urls.add(stripFragmentAndTrailingSlash(nodeId.slice(prefix.length)));
    }
  }
  return urls;
};
