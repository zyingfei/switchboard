// W2 (G) — production topic producer: leiden-CPM @ cosine 0.90.
//
// Pipeline is the W0b/W0c-validated "G" recipe (the exact node/edge
// selection buildCandidateRevision used in the spikes, so the
// stability/quality results transfer): eligible visits
// (focusedWindowMs > 0) → edges ≥ threshold → leidenCpmPartition →
// assembleTopicRevisionFromGroups (THE canonical metadata + lineage +
// stable-topicId + revisionId path shared with buildTopicRevision, so
// topic-identity continuity across drains is guaranteed, not bespoke).

import {
  TOPIC_LEIDEN_CPM_REVISION_KEY,
  type TopicRevision,
} from '../producers/topic-revision.js';
import { leidenCpmPartition } from './leidenCpm.js';
import {
  assembleTopicRevisionFromGroups,
  type BuildTopicRevisionInput,
  type TopicVisit,
  type VisitSimilarityEdge,
} from './topicClusterer.js';

// The validated sweet spot (W0b): 0.85 collapses into grab-bags,
// ≥0.92 over-sparsifies; 0.90 is the judge-preferred / W0c-stable band.
export const LEIDEN_CPM_COSINE_THRESHOLD = 0.9;

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const eligibleVisits = (visits: readonly TopicVisit[]): readonly TopicVisit[] =>
  visits.filter((visit) => visit.focusedWindowMs > 0 && visit.canonicalUrl.length > 0);

const filteredEdges = (
  edges: readonly VisitSimilarityEdge[],
  allowed: ReadonlySet<string>,
  threshold: number,
): readonly VisitSimilarityEdge[] =>
  edges.filter(
    (edge) =>
      edge.cosine >= threshold && allowed.has(edge.fromVisitKey) && allowed.has(edge.toVisitKey),
  );

export const buildLeidenCpmTopicRevision = async (
  input: BuildTopicRevisionInput,
): Promise<TopicRevision> => {
  const cosineThreshold = input.options?.cosineThreshold ?? LEIDEN_CPM_COSINE_THRESHOLD;
  const producedAt = input.options?.producedAt ?? Date.now();

  const nodeIds = eligibleVisits(input.visits)
    .map((visit) => visit.canonicalUrl)
    .sort(compareString);
  const edges = filteredEdges(input.visitSimilarity.edges, new Set(nodeIds), cosineThreshold);
  const groups = leidenCpmPartition(nodeIds, edges);

  return assembleTopicRevisionFromGroups({
    groups,
    visitsByCanonical: new Map(input.visits.map((visit) => [visit.canonicalUrl, visit] as const)),
    visitSimilarity: input.visitSimilarity,
    ...(input.previousRevision === undefined
      ? {}
      : { previousRevision: input.previousRevision }),
    cosineThreshold,
    algorithmVersion: TOPIC_LEIDEN_CPM_REVISION_KEY,
    producedAt,
  });
};
