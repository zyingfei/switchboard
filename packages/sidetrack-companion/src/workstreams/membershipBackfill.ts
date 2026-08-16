// One-time backfill: derive `workstream.membership.set{role:'primary'}`
// events from the three existing single-membership sources, per
// docs/plans/2026-08-16-category-flexibility-hyde.md §1 "Migration".
//
// Repo convention (no `migrations/` directory anywhere in the tree) is
// rebuild-from-canonical-log, not a schema migration script. This module is
// the PURE planning half of that: given the merged log, it derives exactly
// the membership rows the existing scalar-field readers (`urls/
// projection.ts`'s `currentAttribution`, `tabsession/projection.ts`'s
// `currentAttribution`, `threads/projection.ts`'s
// `record.value.primaryWorkstreamId`) ALREADY resolve — by calling those
// same projectors rather than re-deriving their tie-break logic, so the
// backfilled membership store is compatibility-correct by construction, not
// by parallel re-implementation. The consent-gated CLI half
// (`sidetrack-companion membership-backfill`, cli.ts) is the only place
// that actually appends — this module never writes.
//
// SOURCES (deliberately exactly these three, matching the design doc):
//   - `urls.attribution.inferred` / `user.organized.item{itemKind:
//     'canonical-url'}` — via `projectUrls`.
//   - `tabsession.attribution.inferred` / `user.organized.item{itemKind:
//     'tab-session'}` — via `projectTabSessions`.
//   - `thread.upserted.primaryWorkstreamId` — via `projectThread`, one call
//     per bac_id observed in the log. Not literally one of the three named
//     event TYPES in the design's migration paragraph (thread primary
//     attribution is a register field on `thread.upserted`, not a move
//     event), but `Thread.primaryWorkstreamId` is explicitly named as one
//     of the three scalar fields that become derived, so it is backfilled
//     from its own real source of truth rather than left uncovered.
//
// A `source: 'thread'` URL attribution (urls/projection.ts's derived
// "thread attribution propagates to the matching canonical URL" bridge) is
// SKIPPED — it is a projection artifact, not a persisted fact, and the
// thread's own primary membership row (backfilled separately, above)
// already covers the real fact it derives from.

import {
  membershipAggregateId,
  WORKSTREAM_MEMBERSHIP_SET,
  type MembershipProvenance,
  type WorkstreamMembershipSetPayload,
} from './membershipEvents.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { isThreadUpsertedPayload, THREAD_UPSERTED } from '../threads/events.js';
import { projectThread } from '../threads/projection.js';
import { projectTabSessions } from '../tabsession/projection.js';
import { projectUrls } from '../urls/projection.js';

/** Distinct from the companion's own UUID replicaId (importPeerEvent
 * rejects self-replica writes) and from `engagement/
 * backfillSessionAggregates.ts`'s `edge_backfill` — a distinct synthetic
 * replica per backfill family keeps each one's dots trivially
 * attributable in `sidetrack-companion status`/log inspection. */
export const MEMBERSHIP_BACKFILL_REPLICA_ID = 'workstream_membership_backfill';

export interface MembershipBackfillOptions {
  /** Starting seq for the synthetic replica's dot; deterministic given a
   * stable subject ordering (this module always sorts), so re-running
   * regenerates identical dots and `importPeerEvent` dedups rather than
   * duplicating rows. */
  readonly startSeq?: number;
}

export interface MembershipBackfillPlan {
  readonly events: readonly AcceptedEvent<WorkstreamMembershipSetPayload>[];
  readonly stats: {
    readonly urlsConsidered: number;
    readonly urlsBackfilled: number;
    readonly tabSessionsConsidered: number;
    readonly tabSessionsBackfilled: number;
    readonly threadsConsidered: number;
    readonly threadsBackfilled: number;
  };
}

const clientEventId = (
  subjectKind: 'canonical-url' | 'thread' | 'tab-session',
  subjectId: string,
  workstreamId: string,
): string => `backfill:workstream.membership.set:${subjectKind}:${subjectId}:${workstreamId}`;

const provenanceFor = (source: string): MembershipProvenance =>
  source === 'inferred' ? 'ai-suggested-accepted' : 'user-filed';

/**
 * Pure derivation over the full merged log. Deterministic: subjects are
 * sorted before dot assignment, so re-running produces byte-identical
 * events and `importPeerEvent` treats a re-run as a no-op (same
 * clientEventId dedup engagement's backfill relies on).
 */
export const planMembershipBackfill = (
  events: readonly AcceptedEvent[],
  options: MembershipBackfillOptions = {},
): MembershipBackfillPlan => {
  let seq = options.startSeq ?? 1;
  const emitted: AcceptedEvent<WorkstreamMembershipSetPayload>[] = [];

  const nextEvent = (
    subjectKind: 'canonical-url' | 'thread' | 'tab-session',
    subjectId: string,
    workstreamId: string,
    provenance: MembershipProvenance,
    atMs: number,
  ): void => {
    const payload: WorkstreamMembershipSetPayload = {
      payloadVersion: 1,
      subjectKind,
      subjectId,
      workstreamId,
      role: 'primary',
      provenance,
    };
    emitted.push({
      clientEventId: clientEventId(subjectKind, subjectId, workstreamId),
      dot: { replicaId: MEMBERSHIP_BACKFILL_REPLICA_ID, seq },
      deps: {},
      aggregateId: membershipAggregateId(subjectKind, subjectId, workstreamId),
      type: WORKSTREAM_MEMBERSHIP_SET,
      payload,
      acceptedAtMs: atMs,
    });
    seq += 1;
  };

  // ---- canonical-url ------------------------------------------------
  const urlProjection = projectUrls(events);
  const urlEntries = [...urlProjection.byCanonicalUrl.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  let urlsBackfilled = 0;
  for (const [canonicalUrl, record] of urlEntries) {
    const attribution = record.currentAttribution;
    if (attribution === undefined) continue;
    if (attribution.workstreamId === null) continue;
    // Derived bridge, not a persisted fact — see module header.
    if (attribution.source === 'thread') continue;
    nextEvent(
      'canonical-url',
      canonicalUrl,
      attribution.workstreamId,
      provenanceFor(attribution.source),
      Date.parse(attribution.observedAt) || 0,
    );
    urlsBackfilled += 1;
  }

  // ---- tab-session ----------------------------------------------------
  const tabProjection = projectTabSessions(events);
  const tabEntries = [...tabProjection.bySessionId.entries()].sort(([a], [b]) => a.localeCompare(b));
  let tabSessionsBackfilled = 0;
  for (const [tabSessionId, record] of tabEntries) {
    const attribution = record.currentAttribution;
    if (attribution === undefined) continue;
    if (attribution.workstreamId === null) continue;
    nextEvent(
      'tab-session',
      tabSessionId,
      attribution.workstreamId,
      provenanceFor(attribution.source),
      Date.parse(attribution.observedAt) || 0,
    );
    tabSessionsBackfilled += 1;
  }

  // ---- thread -----------------------------------------------------------
  const threadBacIds = new Set<string>();
  for (const event of events) {
    if (event.type === THREAD_UPSERTED && isThreadUpsertedPayload(event.payload)) {
      threadBacIds.add(event.payload.bac_id);
    }
  }
  const sortedBacIds = [...threadBacIds].sort((a, b) => a.localeCompare(b));
  let threadsBackfilled = 0;
  for (const bacId of sortedBacIds) {
    const projection = projectThread(bacId, events);
    if (projection.deleted) continue;
    // A conflict (concurrent, un-reconciled replicas) has no single
    // resolved answer to backfill — skip rather than guess; the user's
    // own reconciliation later produces a real membership.set event.
    if (projection.record.status !== 'resolved') continue;
    const workstreamId = projection.record.value?.primaryWorkstreamId;
    if (workstreamId === undefined) continue;
    nextEvent('thread', bacId, workstreamId, 'user-filed', projection.updatedAtMs);
    threadsBackfilled += 1;
  }

  return {
    events: emitted,
    stats: {
      urlsConsidered: urlEntries.length,
      urlsBackfilled,
      tabSessionsConsidered: tabEntries.length,
      tabSessionsBackfilled,
      threadsConsidered: sortedBacIds.length,
      threadsBackfilled,
    },
  };
};
