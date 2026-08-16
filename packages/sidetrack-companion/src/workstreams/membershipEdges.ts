// visit_in_workstream edge production from membership rows —
// docs/plans/2026-08-16-category-flexibility-hyde.md §1, "Graph edges":
// "Mint one visit_in_workstream edge per membership row (not just the
// primary) ... asserted for user-filed, inferred for ai-suggested-accepted
// / prototype-matched. No new edge-kind machinery; this is precisely the
// Phase 2 the schema comment names" (connections/types.ts:119's
// `visit_in_workstream` — "retained for Phase 2 replacement").
//
// This module is the PURE, tested edge-production function only. Wiring it
// into the connections snapshot build (connections/snapshot.ts already
// emits a single-primary version of this edge — see its 2026-05 fix block
// around `effectiveVisitWorkstreamId`) requires threading membership-store
// reads through `sync/contract/connectionsMaterializer.ts`'s input
// assembly, which is explicitly out of scope for this PR (do-not-touch
// file; also the file a concurrently-developed sibling branch is more
// likely to touch). Kept here, ready to splice in, rather than left
// unbuilt.

import type { ConnectionEdge, ConnectionEdgeProducedBy } from '../connections/types.js';
import {
  activeMembershipRows,
  type MembershipSubjectKind,
  type WorkstreamMembershipRow,
} from './membershipEvents.js';

const nodeIdFor = (kind: 'timeline-visit' | 'thread' | 'tab-session' | 'workstream', key: string): string =>
  `${kind}:${key}`;

// Only 'canonical-url' subjects map to a `timeline-visit` node today (the
// connections graph's existing visit_in_workstream consumer,
// `connections/snapshot.ts`, keys visits by canonical URL). 'thread' and
// 'tab-session' subjects map to their own existing node kinds.
const fromNodeIdFor = (subjectKind: MembershipSubjectKind, subjectId: string): string => {
  if (subjectKind === 'canonical-url') return nodeIdFor('timeline-visit', subjectId);
  if (subjectKind === 'thread') return nodeIdFor('thread', subjectId);
  return nodeIdFor('tab-session', subjectId);
};

const producedByFor = (row: WorkstreamMembershipRow): ConnectionEdgeProducedBy => ({
  source: 'event-log',
  eventType: 'workstream.membership.set',
  dot: { replicaId: row.dot.replicaId, seq: row.dot.seq },
});

// asserted for user-filed (the user directly said so); inferred for
// anything the system proposed and the user (or a future auto-apply) only
// confirmed indirectly — ai-suggested-accepted / prototype-matched.
const confidenceFor = (row: WorkstreamMembershipRow): ConnectionEdge['confidence'] =>
  row.provenance === 'user-filed' ? 'asserted' : 'inferred';

/**
 * One `visit_in_workstream` edge per ACTIVE membership row (not just the
 * primary) — the design's Phase 2. Deleted rows produce no edge. Pure and
 * deterministic: same input rows -> same edge set, so callers can dedupe by
 * `id` (ConnectionEdge's own contract) freely.
 */
export const visitInWorkstreamEdgesFromMembership = (
  rows: readonly WorkstreamMembershipRow[],
): readonly ConnectionEdge[] =>
  activeMembershipRows(rows).map((row) => {
    const fromNodeId = fromNodeIdFor(row.subjectKind, row.subjectId);
    const toNodeId = nodeIdFor('workstream', row.workstreamId);
    return {
      id: `edge:visit_in_workstream:${fromNodeId}:${toNodeId}`,
      kind: 'visit_in_workstream',
      fromNodeId,
      toNodeId,
      observedAt: new Date(row.acceptedAtMs).toISOString(),
      producedBy: producedByFor(row),
      confidence: confidenceFor(row),
      metadata: {
        role: row.role ?? 'secondary',
        provenance: row.provenance ?? 'user-filed',
      },
    } satisfies ConnectionEdge;
  });
