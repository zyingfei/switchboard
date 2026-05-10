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

export const buildEvidenceGraph = (snapshot: ConnectionsSnapshot): EvidenceGraph => {
  const graph = new MultiDirectedGraph({ allowSelfLoops: false });
  for (const node of [...snapshot.nodes].sort((left, right) => compareString(left.id, right.id))) {
    graph.mergeNode(node.id, { kind: node.kind, label: node.label });
  }

  const adjacency = new Map<string, { to: string; weight: number }[]>();
  const addArc = (from: string, to: string, weight: number): void => {
    if (from === to) return;
    if (!graph.hasNode(from)) graph.addNode(from);
    if (!graph.hasNode(to)) graph.addNode(to);
    graph.addDirectedEdgeWithKey(`${from}->${to}:${String(graph.size)}`, from, to, { weight });
    const list = adjacency.get(from) ?? [];
    list.push({ to, weight });
    adjacency.set(from, list);
  };

  for (const edge of [...snapshot.edges].sort((left, right) => compareString(left.id, right.id))) {
    const weight = edgeWeight(weightForEdgeKind(edge.kind), edge.confidence);
    addArc(edge.fromNodeId, edge.toNodeId, weight);
    addArc(edge.toNodeId, edge.fromNodeId, weight * 0.85);
  }

  return {
    graph,
    revision: `${snapshot.updatedAt}:${String(snapshot.nodeCount)}:${String(snapshot.edgeCount)}`,
    adjacency: new Map(
      [...adjacency.entries()].map(([nodeId, edges]) => [
        nodeId,
        [...edges].sort((left, right) => compareString(left.to, right.to)),
      ]),
    ),
  };
};
