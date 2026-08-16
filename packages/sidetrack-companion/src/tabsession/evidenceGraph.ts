import { MultiDirectedGraph } from 'graphology';

import type { ConnectionsSnapshot } from '../connections/types.js';
import { weightForEdgeKind } from './edgePriors.js';

export interface EvidenceGraph {
  readonly graph: MultiDirectedGraph;
  readonly revision: string;
  readonly adjacency: ReadonlyMap<
    string,
    readonly { readonly to: string; readonly weight: number }[]
  >;
}

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const edgeWeight = (base: number, confidence: string): number => {
  if (confidence === 'asserted') return base * 1.2;
  if (confidence === 'inferred') return base * 0.75;
  return base;
};

// PERF (2026-08-16) — memoize per snapshot OBJECT IDENTITY, not content. A
// batch-resolve request builds one shared subgraph snapshot for the whole
// `misses` loop (server.ts pins `missedSnapshot` once and reuses the same
// object reference for every URL — see readResolverSubgraphForUrls), and the
// reverse-shadow / content-lane joins reuse the SAME reference again. Without
// this, buildEvidenceGraph (a graphology build + full adjacency sort, ~140ms
// on a hub subgraph) reran once per miss URL even though every call in a
// batch was rebuilding the IDENTICAL graph. WeakMap is the correct structure
// for this: no manual invalidation, no TTL — the entry is only ever reachable
// while some caller still holds the snapshot object, and is collected the
// moment nothing does. Keying on content (e.g. snapshotRevision) would be
// WRONG here: subgraph reads (readResolverSubgraphForUrls et al.) don't
// carry a per-request-stable revision distinct from the full graph's, so two
// DIFFERENT subgraphs (different URL, different node/edge set) could share
// one — object identity is the only boundary that is actually correct.
const evidenceGraphCache = new WeakMap<ConnectionsSnapshot, EvidenceGraph>();

export const buildEvidenceGraph = (snapshot: ConnectionsSnapshot): EvidenceGraph => {
  const cached = evidenceGraphCache.get(snapshot);
  if (cached !== undefined) return cached;

  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  for (const node of [...snapshot.nodes].sort((left, right) => compareString(left.id, right.id))) {
    graph.mergeNode(node.id, { kind: node.kind, label: node.label });
  }

  const adjacency = new Map<string, { to: string; weight: number }[]>();
  let edgeSeq = 0;
  const addArc = (keyPrefix: string, from: string, to: string, weight: number): void => {
    if (from === to) return;
    if (!graph.hasNode(from)) graph.addNode(from);
    if (!graph.hasNode(to)) graph.addNode(to);
    graph.addDirectedEdgeWithKey(`${keyPrefix}:${String(edgeSeq)}`, from, to, { weight });
    edgeSeq += 1;
    const list = adjacency.get(from) ?? [];
    list.push({ to, weight });
    adjacency.set(from, list);
  };

  for (const edge of [...snapshot.edges].sort((left, right) => compareString(left.id, right.id))) {
    const weight = edgeWeight(weightForEdgeKind(edge.kind), edge.confidence);
    addArc(edge.id, edge.fromNodeId, edge.toNodeId, weight);
    addArc(`${edge.id}:reverse`, edge.toNodeId, edge.fromNodeId, weight * 0.85);
  }

  const result: EvidenceGraph = {
    graph,
    revision: `${snapshot.updatedAt}:${String(snapshot.nodeCount)}:${String(snapshot.edgeCount)}`,
    adjacency: new Map(
      [...adjacency.entries()].map(([nodeId, edges]) => [
        nodeId,
        [...edges].sort((left, right) => compareString(left.to, right.to)),
      ]),
    ),
  };
  evidenceGraphCache.set(snapshot, result);
  return result;
};
