// W5 — shared Tier A (1-hop label propagation) / Tier B (HNSW vector
// fallback) candidate→existing-topic assignment logic.
//
// Extracted from incrementalTopicMembership.ts so incrementalTopicRevision.ts
// (W5 Phase A) can reuse the IDENTICAL placement heuristic instead of a
// second copy. The two callers differ only in what they DO with an
// assignment (assignIncrementalMembership always attaches as a SECONDARY
// affiliation; buildIncrementalTopicRevision additionally promotes to
// PRIMARY membership when the promotion rule is met, then structurally
// verifies via a bounded local leiden pass) — not in how a candidate's
// target topic/score/support are computed. Behaviour is byte-for-byte
// identical to the pre-extraction inline code (see
// incrementalTopicMembership.test.ts, unchanged by this refactor).

import type { VisitSimilarityEdge } from './topicClusterer.js';
import type { LoadedSimilarityHnswStore } from './visitSimilarityHnsw.js';

export const DEFAULT_ASSIGNMENT_TOP_K = 20;

export interface ClusterAgg {
  sum: number;
  max: number;
  count: number;
}

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// Argmax cluster by summed cosine (more supporting neighbours wins);
// deterministic lexicographic tie-break on topicId.
export const pickCluster = (
  byCluster: ReadonlyMap<string, ClusterAgg>,
): { topicId: string; agg: ClusterAgg } | null => {
  let best: { topicId: string; agg: ClusterAgg } | null = null;
  for (const [topicId, agg] of byCluster) {
    if (
      best === null ||
      agg.sum > best.agg.sum ||
      (agg.sum === best.agg.sum && compareString(topicId, best.topicId) < 0)
    ) {
      best = { topicId, agg };
    }
  }
  return best;
};

export const addInto = (byCluster: Map<string, ClusterAgg>, topicId: string, cosine: number): void => {
  const agg = byCluster.get(topicId) ?? { sum: 0, max: 0, count: 0 };
  agg.sum += cosine;
  agg.max = Math.max(agg.max, cosine);
  agg.count += 1;
  byCluster.set(topicId, agg);
};

export type CandidateAssignmentReason = 'edge_support' | 'member_similarity';

export interface CandidateAssignment {
  readonly canonicalUrl: string;
  readonly topicId: string;
  readonly score: number;
  readonly supportCount: number;
  readonly reason: CandidateAssignmentReason;
}

export interface ComputeCandidateAssignmentsParams {
  /** Candidates to place — already filtered to "not currently placed" by the caller. */
  readonly candidates: readonly string[];
  /** Primary-member → topicId index, e.g. buildClusterIndex(revision).memberToTopic. */
  readonly memberToTopic: ReadonlyMap<string, string>;
  /** Similarity edges to scan for Tier A (only edges touching a candidate matter). */
  readonly edges: readonly VisitSimilarityEdge[];
  /** Persisted vector store for the Tier B fallback (null ⇒ Tier A only). */
  readonly hnswStore: LoadedSimilarityHnswStore | null;
  /** Minimum cosine for an edge/neighbour to count. */
  readonly cosineThreshold: number;
  readonly topK?: number;
}

// Tier A (1-hop label propagation over similarity edges to a PRIMARY
// member) + Tier B (HNSW vector fallback for candidates with a
// persisted embedding but no >= threshold edge to a member). Never
// invents a topic: a candidate with neither an edge nor a vector match
// is simply absent from the result.
//
// Deterministic: candidates are processed in sorted order and every
// tie resolves lexicographically (pickCluster) — never Map/Set
// iteration order.
export const computeCandidateAssignments = async (
  params: ComputeCandidateAssignmentsParams,
): Promise<readonly CandidateAssignment[]> => {
  const { candidates, memberToTopic, edges, hnswStore, cosineThreshold } = params;
  const topK = params.topK ?? DEFAULT_ASSIGNMENT_TOP_K;
  if (candidates.length === 0) return [];
  const candidateSet = new Set(candidates);

  const tierA = new Map<string, Map<string, ClusterAgg>>();
  for (const edge of edges) {
    if (edge.cosine < cosineThreshold) continue;
    const fromCand = candidateSet.has(edge.fromVisitKey);
    const toCand = candidateSet.has(edge.toVisitKey);
    if (fromCand === toCand) continue; // need exactly one candidate endpoint
    const candidate = fromCand ? edge.fromVisitKey : edge.toVisitKey;
    const other = fromCand ? edge.toVisitKey : edge.fromVisitKey;
    const topicId = memberToTopic.get(other);
    if (topicId === undefined) continue; // other endpoint is not a primary member
    let byCluster = tierA.get(candidate);
    if (byCluster === undefined) {
      byCluster = new Map();
      tierA.set(candidate, byCluster);
    }
    addInto(byCluster, topicId, edge.cosine);
  }

  const knownLabels = hnswStore !== null ? await hnswStore.knownLabels() : null;

  const assignments: CandidateAssignment[] = [];
  for (const url of [...candidates].sort(compareString)) {
    let pick = pickCluster(tierA.get(url) ?? new Map());
    let reason: CandidateAssignmentReason = 'edge_support';
    // Tier B — vector fallback for candidates with no >= threshold edge to
    // a member in the (possibly capped) edge list but a persisted vector.
    if (pick === null && hnswStore !== null && knownLabels?.has(url) === true) {
      const byCluster = new Map<string, ClusterAgg>();
      for (const { neighborVisitId, distance } of await hnswStore.queryTopK(url, topK)) {
        const cosine = 1 - distance;
        if (cosine < cosineThreshold) continue;
        const topicId = memberToTopic.get(neighborVisitId);
        if (topicId === undefined) continue;
        addInto(byCluster, topicId, cosine);
      }
      pick = pickCluster(byCluster);
      reason = 'member_similarity';
    }
    if (pick === null) continue; // unplaceable — never invent a topic
    assignments.push({
      canonicalUrl: url,
      topicId: pick.topicId,
      score: pick.agg.max,
      supportCount: pick.agg.count,
      reason,
    });
  }
  return assignments;
};
