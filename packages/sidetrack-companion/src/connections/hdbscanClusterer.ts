import {
  DEFAULT_TOPIC_COSINE_THRESHOLD,
  DEFAULT_TOPIC_ENGAGEMENT_GATE_MS,
  TOPIC_HDBSCAN_REVISION_KEY,
  type TopicRevision,
} from '../producers/topic-revision.js';
import {
  buildTopicRevision,
  type BuildTopicRevisionInput,
  type UserAssertedVisitRelation,
  type VisitSimilarityEdge,
} from './topicClusterer.js';
import { UnionFind } from './unionFind.js';

export const HDBSCAN_TOPIC_MIN_SAMPLES = 3;

interface DensityEdge {
  readonly fromVisitKey: string;
  readonly toVisitKey: string;
  readonly cosine: number;
  readonly distance: number;
}

interface MutualReachabilityEdge extends DensityEdge {
  readonly mutualReachabilityDistance: number;
}

const compareString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

const clampCosine = (cosine: number): number => Math.min(Math.max(cosine, 0), 1);

const eligibleVisitKeysFor = (input: BuildTopicRevisionInput): ReadonlySet<string> => {
  const engagementGateMs = input.options?.engagementGateMs ?? DEFAULT_TOPIC_ENGAGEMENT_GATE_MS;
  const touchedVisitKeys = new Set<string>();
  for (const edge of input.visitSimilarity.edges) {
    touchedVisitKeys.add(edge.fromVisitKey);
    touchedVisitKeys.add(edge.toVisitKey);
  }
  for (const relation of input.userAssertedRelations ?? []) {
    touchedVisitKeys.add(relation.fromVisitKey);
    touchedVisitKeys.add(relation.toVisitKey);
  }
  for (const previousTopic of input.previousRevision?.topics ?? []) {
    for (const member of previousTopic.memberCanonicalUrls) touchedVisitKeys.add(member);
  }

  const focusedWindowMsByCanonical = new Map<string, number>();
  for (const visit of input.visits) {
    if (visit.canonicalUrl.length === 0) continue;
    focusedWindowMsByCanonical.set(
      visit.canonicalUrl,
      Math.max(focusedWindowMsByCanonical.get(visit.canonicalUrl) ?? 0, visit.focusedWindowMs),
    );
  }

  const eligibleVisitKeys = new Set<string>();
  for (const [canonicalUrl, focusedWindowMs] of [...focusedWindowMsByCanonical.entries()].sort(
    (a, b) => compareString(a[0], b[0]),
  )) {
    if (!touchedVisitKeys.has(canonicalUrl)) continue;
    if (focusedWindowMs <= engagementGateMs) continue;
    eligibleVisitKeys.add(canonicalUrl);
  }
  return eligibleVisitKeys;
};

const normalizeDensityEdge = (
  edge: VisitSimilarityEdge,
  eligibleVisitKeys: ReadonlySet<string>,
  cosineThreshold: number,
): DensityEdge | null => {
  if (!Number.isFinite(edge.cosine) || edge.cosine < cosineThreshold) return null;
  if (!eligibleVisitKeys.has(edge.fromVisitKey) || !eligibleVisitKeys.has(edge.toVisitKey)) {
    return null;
  }
  if (edge.fromVisitKey === edge.toVisitKey) return null;
  const cosine = clampCosine(edge.cosine);
  const fromVisitKey = edge.fromVisitKey < edge.toVisitKey ? edge.fromVisitKey : edge.toVisitKey;
  const toVisitKey = edge.fromVisitKey < edge.toVisitKey ? edge.toVisitKey : edge.fromVisitKey;
  return {
    fromVisitKey,
    toVisitKey,
    cosine,
    distance: 1 - cosine,
  };
};

const densityEdgesFor = (
  edges: readonly VisitSimilarityEdge[],
  eligibleVisitKeys: ReadonlySet<string>,
  cosineThreshold: number,
): readonly DensityEdge[] => {
  const byPair = new Map<string, DensityEdge>();
  for (const edge of edges) {
    const normalized = normalizeDensityEdge(edge, eligibleVisitKeys, cosineThreshold);
    if (normalized === null) continue;
    const key = pairKey(normalized.fromVisitKey, normalized.toVisitKey);
    const existing = byPair.get(key);
    if (existing === undefined || normalized.cosine > existing.cosine) {
      byPair.set(key, normalized);
    }
  }
  return [...byPair.values()].sort((a, b) => {
    const from = compareString(a.fromVisitKey, b.fromVisitKey);
    if (from !== 0) return from;
    return compareString(a.toVisitKey, b.toVisitKey);
  });
};

const adjacencyFor = (
  eligibleVisitKeys: ReadonlySet<string>,
  densityEdges: readonly DensityEdge[],
): ReadonlyMap<string, readonly DensityEdge[]> => {
  const adjacency = new Map<string, DensityEdge[]>();
  for (const visitKey of [...eligibleVisitKeys].sort(compareString)) {
    adjacency.set(visitKey, []);
  }
  for (const edge of densityEdges) {
    adjacency.get(edge.fromVisitKey)?.push(edge);
    adjacency.get(edge.toVisitKey)?.push(edge);
  }
  return adjacency;
};

const coreDistancesFor = (
  eligibleVisitKeys: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, readonly DensityEdge[]>,
): ReadonlyMap<string, number> => {
  const requiredNeighborCount = HDBSCAN_TOPIC_MIN_SAMPLES - 1;
  const coreDistances = new Map<string, number>();
  for (const visitKey of [...eligibleVisitKeys].sort(compareString)) {
    const distances = [...(adjacency.get(visitKey) ?? [])]
      .map((edge) => edge.distance)
      .sort((a, b) => a - b);
    const coreDistance = distances[requiredNeighborCount - 1];
    coreDistances.set(
      visitKey,
      coreDistance === undefined ? Number.POSITIVE_INFINITY : coreDistance,
    );
  }
  return coreDistances;
};

const mutualReachabilityEdgesFor = (
  densityEdges: readonly DensityEdge[],
  coreDistances: ReadonlyMap<string, number>,
): readonly MutualReachabilityEdge[] => {
  const edges: MutualReachabilityEdge[] = [];
  for (const edge of densityEdges) {
    const fromCoreDistance = coreDistances.get(edge.fromVisitKey);
    const toCoreDistance = coreDistances.get(edge.toVisitKey);
    if (fromCoreDistance === undefined || toCoreDistance === undefined) continue;
    if (!Number.isFinite(fromCoreDistance) || !Number.isFinite(toCoreDistance)) continue;
    edges.push({
      ...edge,
      mutualReachabilityDistance: Math.max(edge.distance, fromCoreDistance, toCoreDistance),
    });
  }
  return edges.sort((a, b) => {
    if (a.mutualReachabilityDistance !== b.mutualReachabilityDistance) {
      return a.mutualReachabilityDistance - b.mutualReachabilityDistance;
    }
    const from = compareString(a.fromVisitKey, b.fromVisitKey);
    if (from !== 0) return from;
    return compareString(a.toVisitKey, b.toVisitKey);
  });
};

const minimumSpanningTreeFor = (
  eligibleVisitKeys: ReadonlySet<string>,
  coreDistances: ReadonlyMap<string, number>,
  mutualReachabilityEdges: readonly MutualReachabilityEdge[],
): readonly MutualReachabilityEdge[] => {
  const coreVisitKeys = [...eligibleVisitKeys]
    .filter((visitKey) => Number.isFinite(coreDistances.get(visitKey) ?? Number.POSITIVE_INFINITY))
    .sort(compareString);
  const uf = new UnionFind();
  for (const visitKey of coreVisitKeys) uf.add(visitKey);

  const selected: MutualReachabilityEdge[] = [];
  for (const edge of mutualReachabilityEdges) {
    if (uf.find(edge.fromVisitKey) === uf.find(edge.toVisitKey)) continue;
    uf.union(edge.fromVisitKey, edge.toVisitKey);
    selected.push(edge);
  }
  return selected;
};

const unionUserAssertedRelations = (
  uf: UnionFind,
  relations: readonly UserAssertedVisitRelation[],
  eligibleVisitKeys: ReadonlySet<string>,
): void => {
  for (const relation of relations) {
    if (
      !eligibleVisitKeys.has(relation.fromVisitKey) ||
      !eligibleVisitKeys.has(relation.toVisitKey)
    ) {
      continue;
    }
    uf.union(relation.fromVisitKey, relation.toVisitKey);
  }
};

const componentKeyByVisitKeyFor = (
  eligibleVisitKeys: ReadonlySet<string>,
  minimumSpanningTree: readonly MutualReachabilityEdge[],
  userAssertedRelations: readonly UserAssertedVisitRelation[],
  cosineThreshold: number,
): ReadonlyMap<string, string> => {
  const maxDensityDistance = 1 - cosineThreshold;
  const uf = new UnionFind();
  for (const visitKey of [...eligibleVisitKeys].sort(compareString)) uf.add(visitKey);

  unionUserAssertedRelations(uf, userAssertedRelations, eligibleVisitKeys);
  for (const edge of minimumSpanningTree) {
    if (edge.mutualReachabilityDistance > maxDensityDistance) continue;
    uf.union(edge.fromVisitKey, edge.toVisitKey);
  }

  const componentKeyByVisitKey = new Map<string, string>();
  for (const component of uf.components()) {
    if (component.members.length < 2) continue;
    const members = [...component.members].sort(compareString);
    const componentKey = members.join('\u0000');
    for (const member of members) componentKeyByVisitKey.set(member, componentKey);
  }
  return componentKeyByVisitKey;
};

const hdbscanComponentKeyByVisitKeyFor = (
  input: BuildTopicRevisionInput,
): ReadonlyMap<string, string> => {
  const cosineThreshold = input.options?.cosineThreshold ?? DEFAULT_TOPIC_COSINE_THRESHOLD;
  const eligibleVisitKeys = eligibleVisitKeysFor(input);
  const densityEdges = densityEdgesFor(
    input.visitSimilarity.edges,
    eligibleVisitKeys,
    cosineThreshold,
  );
  const adjacency = adjacencyFor(eligibleVisitKeys, densityEdges);
  const coreDistances = coreDistancesFor(eligibleVisitKeys, adjacency);
  const mutualReachabilityEdges = mutualReachabilityEdgesFor(densityEdges, coreDistances);
  const minimumSpanningTree = minimumSpanningTreeFor(
    eligibleVisitKeys,
    coreDistances,
    mutualReachabilityEdges,
  );
  return componentKeyByVisitKeyFor(
    eligibleVisitKeys,
    minimumSpanningTree,
    input.userAssertedRelations ?? [],
    cosineThreshold,
  );
};

const filterEdgesToHdbscanComponents = (
  edges: readonly VisitSimilarityEdge[],
  componentKeyByVisitKey: ReadonlyMap<string, string>,
): readonly VisitSimilarityEdge[] =>
  edges.filter((edge) => {
    const fromComponentKey = componentKeyByVisitKey.get(edge.fromVisitKey);
    return (
      fromComponentKey !== undefined &&
      fromComponentKey === componentKeyByVisitKey.get(edge.toVisitKey)
    );
  });

export const buildHdbscanTopicRevision = async (
  input: BuildTopicRevisionInput,
): Promise<TopicRevision> => {
  const componentKeyByVisitKey = hdbscanComponentKeyByVisitKeyFor(input);
  const edges = filterEdgesToHdbscanComponents(input.visitSimilarity.edges, componentKeyByVisitKey);
  return buildTopicRevision({
    visits: input.visits,
    visitSimilarity: {
      revisionId: input.visitSimilarity.revisionId,
      edges,
    },
    ...(input.userAssertedRelations === undefined
      ? {}
      : { userAssertedRelations: input.userAssertedRelations }),
    ...(input.previousRevision === undefined ? {} : { previousRevision: input.previousRevision }),
    options: {
      ...(input.options ?? {}),
      algorithmVersion: TOPIC_HDBSCAN_REVISION_KEY,
    },
  });
};
