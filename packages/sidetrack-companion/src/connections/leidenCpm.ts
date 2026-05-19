// W2 (G) — the production leiden-CPM partitioner.
//
// This is the PRODUCT extraction of the leiden-cpm clustering that won
// the W0b/W0c evaluation (5-blind-round runner-up, but W0c-stable at
// ~0.026 churn — beats the retired idf-rkn-split). It is a deliberate
// independent copy of the pure partitioner primitives that also live
// in topicAlgorithmComparison.ts: that file is FROZEN as a test-only
// regression oracle (W1), so a shared core would couple a frozen
// oracle to evolving product code. Different lifecycles ⇒ independent
// implementations, by design. The two are pinned equivalent by
// leidenCpm.test.ts.
//
// Pure graph code (no I/O); the revision assembly + lineage continuity
// is done by assembleTopicRevisionFromGroups (topicClusterer.ts), so
// every producer shares ONE identity/lineage implementation.

import type { VisitSimilarityEdge } from './topicClusterer.js';

// CPM resolution. Matches the oracle's value; the W0b/W0c "G" winner
// used this γ at cosineThreshold 0.90.
const CPM_GAMMA = 0.18;

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const adjacencyFor = (
  nodes: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): ReadonlyMap<string, ReadonlyMap<string, number>> => {
  const out = new Map<string, Map<string, number>>();
  for (const node of nodes) out.set(node, new Map<string, number>());
  for (const edge of edges) {
    out.get(edge.fromVisitKey)?.set(edge.toVisitKey, edge.cosine);
    out.get(edge.toVisitKey)?.set(edge.fromVisitKey, edge.cosine);
  }
  return out;
};

const connectedComponents = (
  nodes: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): readonly (readonly string[])[] => {
  const adjacency = adjacencyFor(nodes, edges);
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const node of [...nodes].sort(compareString)) {
    if (seen.has(node)) continue;
    const stack = [node];
    const group: string[] = [];
    seen.add(node);
    while (stack.length > 0) {
      const current = stack.pop()!;
      group.push(current);
      for (const next of adjacency.get(current)?.keys() ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    groups.push(group.sort(compareString));
  }
  return groups.sort((left, right) => compareString(left[0] ?? '', right[0] ?? ''));
};

const partitionObjectiveCpm = (
  communities: ReadonlyMap<string, string>,
  nodes: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): number => {
  const byCommunity = new Map<string, Set<string>>();
  for (const node of nodes) {
    const community = communities.get(node) ?? node;
    const members = byCommunity.get(community) ?? new Set<string>();
    members.add(node);
    byCommunity.set(community, members);
  }
  let score = 0;
  for (const members of byCommunity.values()) {
    let internal = 0;
    for (const edge of edges) {
      if (members.has(edge.fromVisitKey) && members.has(edge.toVisitKey)) internal += edge.cosine;
    }
    score += internal - (CPM_GAMMA * (members.size * (members.size - 1))) / 2;
  }
  return score;
};

const refineConnectedCommunities = (
  communities: ReadonlyMap<string, string>,
  nodes: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): ReadonlyMap<string, string> => {
  const byCommunity = new Map<string, string[]>();
  for (const node of nodes) {
    const community = communities.get(node) ?? node;
    const list = byCommunity.get(community) ?? [];
    list.push(node);
    byCommunity.set(community, list);
  }
  const refined = new Map<string, string>();
  for (const members of byCommunity.values()) {
    const memberSet = new Set(members);
    const internalEdges = edges.filter(
      (edge) => memberSet.has(edge.fromVisitKey) && memberSet.has(edge.toVisitKey),
    );
    for (const component of connectedComponents(members, internalEdges)) {
      const communityId = component[0] ?? '';
      for (const member of component) refined.set(member, communityId);
    }
  }
  return refined;
};

// Leiden-like local-move optimisation of the CPM objective, with a
// connected-community refinement each pass (the Leiden guarantee).
// Deterministic: nodes processed in sorted order, fixed 8 passes.
export const leidenCpmPartition = (
  nodes: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): readonly (readonly string[])[] => {
  let communities = new Map(nodes.map((node) => [node, node] as const));
  const adjacency = adjacencyFor(nodes, edges);
  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;
    for (const node of [...nodes].sort(compareString)) {
      const current = communities.get(node) ?? node;
      const candidateCommunities = new Set<string>([current]);
      for (const neighbor of adjacency.get(node)?.keys() ?? []) {
        candidateCommunities.add(communities.get(neighbor) ?? neighbor);
      }
      let bestCommunity = current;
      let bestScore = partitionObjectiveCpm(communities, nodes, edges);
      for (const candidate of [...candidateCommunities].sort(compareString)) {
        if (candidate === current) continue;
        const trial = new Map(communities);
        trial.set(node, candidate);
        const score = partitionObjectiveCpm(trial, nodes, edges);
        if (score > bestScore + 1e-9) {
          bestScore = score;
          bestCommunity = candidate;
        }
      }
      if (bestCommunity !== current) {
        communities.set(node, bestCommunity);
        moved = true;
      }
    }
    communities = new Map(refineConnectedCommunities(communities, nodes, edges));
    if (!moved) break;
  }
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const community = communities.get(node) ?? node;
    const list = groups.get(community) ?? [];
    list.push(node);
    groups.set(community, list);
  }
  return [...groups.values()].map((group) => group.sort(compareString));
};
