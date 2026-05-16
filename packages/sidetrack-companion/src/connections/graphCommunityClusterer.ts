import { UndirectedGraph } from 'graphology';

import type { VisitSimilarityEdge } from './topicClusterer.js';

// Deterministic graph community-detection clusterer (Louvain
// modularity over the visit-similarity graph). This is a *candidate*
// builder mirroring the partition shape consumed by
// `topicAlgorithmComparison.ts` (a `(nodeIds, edges) => string[][]`
// partition function, identical in contract to `leidenLikePartition`
// and `densityLeafPartition`). It never touches the active/served
// Union-Find path.
//
// graphology is already a companion dependency (see
// `tabsession/evidenceGraph.ts`); we build the weighted similarity
// graph with `UndirectedGraph` and run a from-scratch Louvain so the
// result stays pure-JS, dependency-light, and fully deterministic.
//
// Design — textbook agglomerative Louvain (level-0 local moving) that
// optimises the same whole-partition modularity the harness reasons
// about in `partitionObjective`:
//
//   * Every node starts in its own singleton community; local moving
//     greedily merges nodes into the adjacent community that maximises
//     whole-partition modularity. On the weighted similarity graph
//     this fuses a dense clique into one community (nearly every edge
//     becomes internal, so the modularity gain dominates the degree
//     penalty) yet refuses to merge two cliques joined by a single
//     weak bridge (carrying the lone bridge endpoint across lowers
//     global modularity).
//   * After each sweep, communities are refined into their connected
//     sub-components (mirroring `refineConnectedCommunities` inside
//     `leidenLikePartition`) so a community never spans an internal
//     gap.
//   * Every iteration order is sorted (`compareString`), every move
//     tie-break is deterministic (strictly greater modularity wins;
//     equal keeps the lexicographically smaller community), there is
//     no randomness, and communities are renamed to their smallest
//     member so topic ids are stable across runs and input orderings.

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// Strict positive epsilon: a candidate move is only accepted when it
// improves modularity by more than this. Keeps tie-breaks
// deterministic (no oscillation between equally-good communities).
const MODULARITY_EPSILON = 1e-9;

// Bound the local-moving sweeps. Louvain converges fast on the small,
// well-separated similarity graphs this harness measures; the cap is
// a safety net, not the expected exit (the no-move early-out is).
const MAX_LOCAL_MOVING_PASSES = 32;

const buildSimilarityGraph = (
  nodeIds: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): UndirectedGraph => {
  const graph = new UndirectedGraph({ allowSelfLoops: false, multi: false });
  const allowed = new Set<string>();
  for (const node of [...nodeIds].sort(compareString)) {
    if (graph.hasNode(node)) continue;
    graph.addNode(node);
    allowed.add(node);
  }
  // Sort edges so identical input always folds into the graph in the
  // same order; collapse parallel edges by keeping the strongest
  // cosine (mirrors how the other candidates dedupe pairs).
  const sortedEdges = [...edges]
    .filter(
      (edge) =>
        edge.fromVisitKey !== edge.toVisitKey &&
        allowed.has(edge.fromVisitKey) &&
        allowed.has(edge.toVisitKey) &&
        Number.isFinite(edge.cosine) &&
        edge.cosine > 0,
    )
    .sort((left, right) => {
      const from = compareString(left.fromVisitKey, right.fromVisitKey);
      if (from !== 0) return from;
      const to = compareString(left.toVisitKey, right.toVisitKey);
      if (to !== 0) return to;
      return right.cosine - left.cosine;
    });
  for (const edge of sortedEdges) {
    const [source, target] =
      edge.fromVisitKey < edge.toVisitKey
        ? [edge.fromVisitKey, edge.toVisitKey]
        : [edge.toVisitKey, edge.fromVisitKey];
    if (graph.hasEdge(source, target)) {
      const existing = graph.getEdgeAttribute(source, target, 'weight') as number;
      if (edge.cosine > existing) {
        graph.setEdgeAttribute(source, target, 'weight', edge.cosine);
      }
      continue;
    }
    graph.addEdge(source, target, { weight: edge.cosine });
  }
  return graph;
};

interface WeightedEdge {
  readonly source: string;
  readonly target: string;
  readonly weight: number;
}

// Materialise the graph into sorted node ids and sorted weighted
// edges. Everything downstream iterates these arrays so order — and
// therefore the result — is independent of graphology's internal
// iteration order and of the caller's input ordering.
const materialise = (
  graph: UndirectedGraph,
): { readonly nodes: readonly string[]; readonly edges: readonly WeightedEdge[] } => {
  const nodes = [...graph.nodes()].sort(compareString);
  const edges: WeightedEdge[] = [];
  graph.forEachEdge((_edge, attributes, source, target) => {
    const [a, b] = source < target ? [source, target] : [target, source];
    edges.push({ source: a, target: b, weight: attributes['weight'] as number });
  });
  edges.sort((left, right) => {
    const source = compareString(left.source, right.source);
    if (source !== 0) return source;
    return compareString(left.target, right.target);
  });
  return { nodes, edges };
};

// Connected components, each sorted, the list sorted by smallest
// member — the deterministic seed partition. A connected component is
// the coarsest grouping Louvain is allowed to produce here.
const connectedComponents = (
  nodes: readonly string[],
  edges: readonly WeightedEdge[],
): readonly (readonly string[])[] => {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (seen.has(node)) continue;
    const stack = [node];
    const members: string[] = [];
    seen.add(node);
    while (stack.length > 0) {
      const current = stack.pop()!;
      members.push(current);
      for (const neighbour of [...(adjacency.get(current) ?? [])].sort(compareString)) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    components.push(members.sort(compareString));
  }
  return components.sort((left, right) => compareString(left[0] ?? '', right[0] ?? ''));
};

// Standard weighted Newman modularity of a whole partition, scored
// exactly like `partitionObjective`'s modularity branch in
// `topicAlgorithmComparison.ts` so this candidate optimises the same
// quantity the harness reasons about.
const modularity = (
  communityByNode: ReadonlyMap<string, string>,
  edges: readonly WeightedEdge[],
): number => {
  const totalWeight = edges.reduce((sum, edge) => sum + edge.weight, 0);
  if (totalWeight === 0) return 0;
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + edge.weight);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + edge.weight);
  }
  const internalByCommunity = new Map<string, number>();
  const degreeSumByCommunity = new Map<string, number>();
  for (const [node, community] of communityByNode) {
    degreeSumByCommunity.set(
      community,
      (degreeSumByCommunity.get(community) ?? 0) + (degree.get(node) ?? 0),
    );
  }
  for (const edge of edges) {
    if (communityByNode.get(edge.source) !== communityByNode.get(edge.target)) continue;
    const community = communityByNode.get(edge.source)!;
    internalByCommunity.set(community, (internalByCommunity.get(community) ?? 0) + edge.weight);
  }
  let score = 0;
  for (const community of [...degreeSumByCommunity.keys()].sort(compareString)) {
    const internal = internalByCommunity.get(community) ?? 0;
    const degreeSum = degreeSumByCommunity.get(community) ?? 0;
    score += internal / totalWeight - (degreeSum / (2 * totalWeight)) ** 2;
  }
  return score;
};

const adjacencyOf = (
  nodes: readonly string[],
  edges: readonly WeightedEdge[],
): ReadonlyMap<string, readonly string[]> => {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  const sorted = new Map<string, readonly string[]>();
  for (const node of nodes) {
    sorted.set(node, [...(adjacency.get(node) ?? [])].sort(compareString));
  }
  return sorted;
};

// Split a disconnected community into its connected sub-components so
// a community never spans an internal gap (mirrors
// `refineConnectedCommunities`). Sub-community ids stay deterministic
// (smallest member), so re-running is idempotent.
const refineToConnected = (
  communityByNode: Map<string, string>,
  nodes: readonly string[],
  edges: readonly WeightedEdge[],
): void => {
  const membersByCommunity = new Map<string, string[]>();
  for (const node of nodes) {
    const community = communityByNode.get(node) ?? node;
    const members = membersByCommunity.get(community) ?? [];
    members.push(node);
    membersByCommunity.set(community, members);
  }
  for (const members of membersByCommunity.values()) {
    const memberSet = new Set(members);
    const internalEdges = edges.filter(
      (edge) => memberSet.has(edge.source) && memberSet.has(edge.target),
    );
    for (const component of connectedComponents([...members].sort(compareString), internalEdges)) {
      const communityId = component[0] ?? '';
      for (const member of component) communityByNode.set(member, communityId);
    }
  }
};

// One Louvain local-moving sweep. For every node (in sorted order) we
// try moving it into each adjacent community and keep the move that
// yields the highest *whole-partition* modularity, accepting only a
// strict improvement. Returns whether any node moved.
const runLocalMovingSweep = (
  communityByNode: Map<string, string>,
  nodes: readonly string[],
  edges: readonly WeightedEdge[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean => {
  let movedAny = false;
  for (const node of nodes) {
    const current = communityByNode.get(node);
    if (current === undefined) continue;
    const candidateCommunities = new Set<string>([current, node]);
    for (const neighbour of adjacency.get(node) ?? []) {
      const community = communityByNode.get(neighbour);
      if (community !== undefined) candidateCommunities.add(community);
    }
    let bestCommunity = current;
    let bestModularity = modularity(communityByNode, edges);
    for (const community of [...candidateCommunities].sort(compareString)) {
      if (community === current) continue;
      communityByNode.set(node, community);
      const score = modularity(communityByNode, edges);
      if (
        score > bestModularity + MODULARITY_EPSILON ||
        (Math.abs(score - bestModularity) <= MODULARITY_EPSILON &&
          compareString(community, bestCommunity) < 0)
      ) {
        bestModularity = score;
        bestCommunity = community;
      }
    }
    communityByNode.set(node, bestCommunity);
    if (bestCommunity !== current) movedAny = true;
  }
  return movedAny;
};

const groupsFrom = (
  communityByNode: ReadonlyMap<string, string>,
): readonly (readonly string[])[] => {
  const membersByCommunity = new Map<string, string[]>();
  for (const node of [...communityByNode.keys()].sort(compareString)) {
    const community = communityByNode.get(node);
    if (community === undefined) continue;
    const members = membersByCommunity.get(community) ?? [];
    members.push(node);
    membersByCommunity.set(community, members);
  }
  return [...membersByCommunity.values()]
    .map((members) => [...members].sort(compareString))
    .sort((left, right) => compareString(left[0] ?? '', right[0] ?? ''));
};

/**
 * Deterministic Louvain community detection over the visit-similarity
 * graph. Same contract as the other candidate partition functions in
 * `topicAlgorithmComparison.ts`: takes the eligible node ids and the
 * threshold-filtered similarity edges, returns disjoint communities
 * (each sorted; the list sorted by smallest member). Identical input
 * always yields identical output, independent of input ordering.
 */
export const louvainCommunityPartition = (
  nodeIds: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): readonly (readonly string[])[] => {
  const graph = buildSimilarityGraph(nodeIds, edges);
  if (graph.order === 0) return [];
  const { nodes, edges: weightedEdges } = materialise(graph);

  // Textbook Louvain level-0 seed: every node in its own singleton
  // community (id = the node). Local moving then *agglomerates*
  // greedily by whole-partition modularity. On the weighted
  // similarity graph this both fuses a dense clique into one
  // community (almost every edge becomes internal, so the modularity
  // gain dominates the degree penalty) and refuses to merge two
  // cliques joined by a single weak bridge (carrying the lone bridge
  // endpoint across lowers global modularity).
  const communityByNode = new Map<string, string>(nodes.map((node) => [node, node]));

  const adjacency = adjacencyOf(nodes, weightedEdges);
  for (let pass = 0; pass < MAX_LOCAL_MOVING_PASSES; pass += 1) {
    const moved = runLocalMovingSweep(communityByNode, nodes, weightedEdges, adjacency);
    refineToConnected(communityByNode, nodes, weightedEdges);
    if (!moved) break;
  }
  return groupsFrom(communityByNode);
};
