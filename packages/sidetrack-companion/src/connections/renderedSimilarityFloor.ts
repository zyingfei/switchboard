// Rendered-edge floor guard — the TERMINAL invariant for the visit-
// similarity signal, evaluated against the SERVED ARTIFACT.
//
// Rounds 1-2 (see similarityFloorGuard.ts / similarityFloorState.ts)
// guarded the REVISION's edge count: round 1 protected publish-of-revision,
// round 2 protected build/adopt of the revision. Both live one abstraction
// ABOVE what resolvers actually read. Round 3 proved the gap: a drain
// adopted a non-empty visitSimilarity revision (51,156 edges) yet the
// published snapshot rendered ZERO `visit_resembles_visit` rows, because
// buildConnectionsSnapshot's Pass 7 emits a similarity edge only when BOTH
// endpoint timeline-visit nodes exist in the snapshot (snapshot.ts Pass 7:
// `visitObservedAtByKey.get(...)` returns undefined for an out-of-window
// endpoint → the edge is silently dropped). A window-poor node set (3,089
// timeline-visit nodes vs the ~9k-visit corpus) therefore stripped every
// similarity edge while the revision-level guard read 51,156 and passed.
//
// This module measures the RENDERED similarity-family rows in the candidate
// snapshot vs the previously SERVED snapshot's rendered rows, and — when the
// rendered rows collapse >90% with no recorded reset reason — REPAIRS the
// candidate before it is written: it carries forward the previous snapshot's
// similarity-family edges AND any missing endpoint timeline-visit nodes they
// need (an endpoint-completion carry-forward). A snapshot must never lose
// similarity solely because its node set was window-poor. If there is no
// previous snapshot to repair from (fresh vault), it publishes honestly.
//
// The two similarity-family edge kinds are timeline-visit↔timeline-visit
// links whose endpoints can be dropped by a window-poor render:
//   - visit_resembles_visit (the flapping signal this whole effort protects)
//   - closest_visit         (the learned ranker's neighbour edges, same
//                            endpoint-survival dependence)
//
// This file is pure (no I/O, no clock, no env): the caller feeds it the
// just-rendered candidate snapshot + the previously served snapshot + whether
// a legitimate reset fired, and it returns the decision plus (when repairing)
// a repaired snapshot. The snapshot recompute (nodeCount/edgeCount/
// snapshotRevision) is injected so this module stays free of the snapshot
// hashing internals.

import type { ConnectionEdge, ConnectionNode, ConnectionsSnapshot } from './types.js';
import { SIMILARITY_FLOOR_MIN_RETAINED_FRACTION } from './similarityFloorGuard.js';

// The similarity-family edge kinds whose endpoints a window-poor render can
// strip. Both are timeline-visit↔timeline-visit and both survive a full
// build only when BOTH endpoint nodes exist.
export const SIMILARITY_FAMILY_RENDER_EDGE_KINDS: ReadonlySet<ConnectionEdge['kind']> = new Set([
  'visit_resembles_visit',
  'closest_visit',
]);

// Cheap linear count of the similarity-family rows in a snapshot. O(edges),
// zero allocation — the runtime-agility bar (T5): the common no-collapse
// drain pays only this, never the Map-building repair path.
export const countRenderedSimilarityFamilyEdges = (
  snapshot: Pick<ConnectionsSnapshot, 'edges'>,
): number => {
  let count = 0;
  for (const edge of snapshot.edges) {
    if (SIMILARITY_FAMILY_RENDER_EDGE_KINDS.has(edge.kind)) count += 1;
  }
  return count;
};

// A rendered collapse: the candidate dropped below 10% of the previously
// served rendered rows (a >90% collapse), mirroring the revision-level floor
// guard's threshold so the two layers agree on what "collapse" means.
export const isRenderedSimilarityCollapse = (
  candidateCount: number,
  previousServedCount: number,
): boolean =>
  previousServedCount > 0 &&
  candidateCount < previousServedCount * SIMILARITY_FLOOR_MIN_RETAINED_FRACTION;

export interface RenderedSimilarityFloorInput {
  readonly candidate: ConnectionsSnapshot;
  // The previously SERVED snapshot (from store.readCurrent()). null on a
  // fresh vault / first publish — nothing to repair from.
  readonly previous: ConnectionsSnapshot | null;
  // True when a legitimate reset reason fired this drain (model change,
  // materializer version bump, store-corruption recovery, privacy purge,
  // operator rebuild, sustained-collapse acceptance). A rendered collapse
  // under one of these is legitimate and MUST be published, not repaired.
  readonly resetAllowed: boolean;
  // Injected recompute: given the repaired node/edge arrays, return the
  // canonical snapshot metadata (nodeCount/edgeCount/snapshotRevision).
  // Injected so this pure module never imports the snapshot hashing.
  readonly recompute: (
    nodes: readonly ConnectionNode[],
    edges: readonly ConnectionEdge[],
    updatedAt: string,
  ) => Pick<ConnectionsSnapshot, 'nodeCount' | 'edgeCount' | 'snapshotRevision' | 'updatedAt'>;
}

export type RenderedSimilarityFloorOutcome =
  | {
      // No collapse, a legitimate reset, or no previous snapshot to repair
      // from — publish the candidate as-is.
      readonly action: 'publish';
      readonly candidateCount: number;
      readonly previousServedCount: number;
      // When a rendered collapse WAS observed but publishing anyway because a
      // reset fired (else false). Recorded for the diagnostic.
      readonly collapseAllowedByReset: boolean;
    }
  | {
      // A >90% rendered collapse with no reset and a previous snapshot to
      // repair from — the returned snapshot has the previous similarity-
      // family rows + their missing endpoint timeline-visit nodes carried
      // forward.
      readonly action: 'repair';
      readonly snapshot: ConnectionsSnapshot;
      readonly candidateCount: number;
      readonly previousServedCount: number;
      // Rendered similarity-family row count AFTER the repair.
      readonly repairedCount: number;
    };

// Carry forward the previous snapshot's similarity-family edges into the
// candidate, completing any endpoint timeline-visit nodes the candidate's
// window-poor node set is missing. Endpoint-completion is the whole point:
// Pass 7 dropped these edges precisely because their endpoint nodes were
// absent, so re-adding the edges alone would leave them referencing missing
// nodes — we must also re-add the endpoint nodes from the previous snapshot.
//
// Only edges whose id is NOT already in the candidate are carried (the
// candidate's freshly rendered edges win on collision), so a partial render
// is completed rather than overwritten. O(previous similarity rows + their
// endpoint nodes) — bounded by the similarity signal, never a full graph
// rescan (the candidate/previous node maps are built once, keyed reads after).
const carryForwardRenderedSimilarityFamilyRows = (
  candidate: ConnectionsSnapshot,
  previous: ConnectionsSnapshot,
  recompute: RenderedSimilarityFloorInput['recompute'],
): { readonly snapshot: ConnectionsSnapshot; readonly repairedCount: number } => {
  const edgesById = new Map<string, ConnectionEdge>(candidate.edges.map((edge) => [edge.id, edge]));
  const nodesById = new Map<string, ConnectionNode>(candidate.nodes.map((node) => [node.id, node]));
  const previousNodesById = new Map<string, ConnectionNode>(
    previous.nodes.map((node) => [node.id, node]),
  );
  let maxObservedAt = candidate.updatedAt;
  for (const edge of previous.edges) {
    if (!SIMILARITY_FAMILY_RENDER_EDGE_KINDS.has(edge.kind)) continue;
    if (edgesById.has(edge.id)) continue; // candidate re-rendered it — keep the fresh one.
    // Endpoint-completion: re-add the endpoint timeline-visit nodes the
    // window-poor render dropped, sourced from the previous snapshot. If an
    // endpoint node is genuinely gone (not even in the previous snapshot), the
    // edge cannot be honestly carried — skip it (carry-forward is completion,
    // not resurrection of a truly-deleted visit).
    const fromNode = nodesById.get(edge.fromNodeId) ?? previousNodesById.get(edge.fromNodeId);
    const toNode = nodesById.get(edge.toNodeId) ?? previousNodesById.get(edge.toNodeId);
    if (fromNode === undefined || toNode === undefined) continue;
    if (!nodesById.has(edge.fromNodeId)) nodesById.set(edge.fromNodeId, fromNode);
    if (!nodesById.has(edge.toNodeId)) nodesById.set(edge.toNodeId, toNode);
    edgesById.set(edge.id, edge);
    if (edge.observedAt > maxObservedAt) maxObservedAt = edge.observedAt;
  }
  const nodes = [...nodesById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = [...edgesById.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const meta = recompute(nodes, edges, maxObservedAt);
  return {
    snapshot: { ...candidate, nodes, edges, ...meta },
    repairedCount: countRenderedSimilarityFamilyEdges({ edges }),
  };
};

// The terminal rendered-edge floor decision. Cheap count first (T5): return
// `publish` without touching the repair path unless the rendered rows
// actually collapsed >90% with no reset and there is a previous snapshot to
// repair from.
export const applyRenderedSimilarityFloor = (
  input: RenderedSimilarityFloorInput,
): RenderedSimilarityFloorOutcome => {
  const candidateCount = countRenderedSimilarityFamilyEdges(input.candidate);
  const previousServedCount =
    input.previous === null ? 0 : countRenderedSimilarityFamilyEdges(input.previous);
  if (!isRenderedSimilarityCollapse(candidateCount, previousServedCount)) {
    return { action: 'publish', candidateCount, previousServedCount, collapseAllowedByReset: false };
  }
  // A rendered collapse WAS observed. A legitimate reset publishes it as-is.
  if (input.resetAllowed) {
    return { action: 'publish', candidateCount, previousServedCount, collapseAllowedByReset: true };
  }
  // No previous snapshot to repair from — cannot honestly carry rows forward;
  // publish honestly (this also covers the fresh-vault / cold-boot case,
  // where previousServedCount is 0 and isRenderedSimilarityCollapse is false).
  if (input.previous === null) {
    return { action: 'publish', candidateCount, previousServedCount, collapseAllowedByReset: false };
  }
  const { snapshot, repairedCount } = carryForwardRenderedSimilarityFamilyRows(
    input.candidate,
    input.previous,
    input.recompute,
  );
  return { action: 'repair', snapshot, candidateCount, previousServedCount, repairedCount };
};
