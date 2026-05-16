import type { ConnectionsSnapshot } from '../connections/types.js';
import type { ClosestVisitRanker } from '../connections/snapshot.js';
import { generateCandidates } from '../ranker/candidates.js';
import { extractFeatures } from '../ranker/features.js';
import type { Candidate } from '../ranker/types.js';
import type { AcceptedEvent } from '../sync/causal.js';

export interface SimilarityEvidence {
  readonly workstreamId: string;
  readonly simTopScore: number;
  readonly simMeanScore: number;
  readonly simAgreement: number;
  readonly simMargin: number;
}

export interface BuildSimilarityEvidenceInput {
  readonly snapshot: ConnectionsSnapshot;
  readonly targetVisitNodeIds: ReadonlySet<string>;
  readonly events: readonly AcceptedEvent[];
  readonly closestVisitRanker?: ClosestVisitRanker;
  readonly k?: number;
}

const VISIT_PREFIX = 'timeline-visit:';
const VISIT_INSTANCE_PREFIX = 'visit-instance:';
const WORKSTREAM_PREFIX = 'workstream:';

const scoreForEdge = (kind: string): number => {
  if (kind === 'closest_visit') return 1;
  if (kind === 'visit_continues_visit') return 0.85;
  if (kind === 'visit_resembles_visit') return 0.7;
  return 0;
};

const scoreForCandidateSources = (candidate: Candidate): number => {
  if (candidate.sources.includes('same_workstream')) return 0.95;
  if (candidate.sources.includes('same_canonical_url')) return 0.9;
  if (candidate.sources.includes('opener_chain')) return 0.85;
  if (candidate.sources.includes('navigation_chain')) return 0.8;
  if (candidate.sources.includes('same_repo_or_domain')) return 0.65;
  if (candidate.sources.includes('same_search_query')) return 0.6;
  if (candidate.sources.includes('same_copied_snippet')) return 0.55;
  if (candidate.sources.includes('same_title_path_tokens')) return 0.45;
  if (candidate.sources.includes('embedding_neighborhood')) return 0.4;
  if (candidate.sources.includes('cross_replica_continuation')) return 0.35;
  return 0.1;
};

const visitKeyFromNodeOrRaw = (visitId: string): string =>
  visitId.startsWith(VISIT_PREFIX) ? visitId.slice(VISIT_PREFIX.length) : visitId;

const visitNodeId = (visitKey: string): string => `${VISIT_PREFIX}${visitKey}`;

const canonicalVisitForNode = (snapshot: ConnectionsSnapshot, nodeId: string): string => {
  if (nodeId.startsWith(VISIT_PREFIX)) return nodeId;
  const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
  const timelineVisitId = node?.metadata?.timelineVisitId;
  if (typeof timelineVisitId === 'string' && timelineVisitId.startsWith(VISIT_PREFIX)) {
    return timelineVisitId;
  }
  const canonicalUrl = node?.metadata?.canonicalUrl;
  if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) return visitNodeId(canonicalUrl);
  return nodeId;
};

export const buildSimilarityEvidence = ({
  snapshot,
  targetVisitNodeIds,
  events,
  closestVisitRanker,
  k = 10,
}: BuildSimilarityEvidenceInput): readonly SimilarityEvidence[] => {
  const canonicalTargetVisitNodeIds = new Set(
    [...targetVisitNodeIds].map((targetVisitNodeId) =>
      canonicalVisitForNode(snapshot, targetVisitNodeId),
    ),
  );
  const visitWorkstream = new Map<string, string>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'visit_in_workstream' && edge.kind !== 'visit_instance_in_workstream') {
      continue;
    }
    if (
      !(
        edge.fromNodeId.startsWith(VISIT_PREFIX) ||
        edge.fromNodeId.startsWith(VISIT_INSTANCE_PREFIX)
      ) ||
      !edge.toNodeId.startsWith(WORKSTREAM_PREFIX)
    ) {
      continue;
    }
    const workstreamId = edge.toNodeId.slice(WORKSTREAM_PREFIX.length);
    visitWorkstream.set(edge.fromNodeId, workstreamId);
    const canonicalVisitNodeId = canonicalVisitForNode(snapshot, edge.fromNodeId);
    visitWorkstream.set(canonicalVisitNodeId, workstreamId);
    visitWorkstream.set(visitKeyFromNodeOrRaw(canonicalVisitNodeId), workstreamId);
  }

  const byWorkstream = new Map<string, number[]>();
  const addScore = (workstreamId: string | undefined, score: number): void => {
    if (workstreamId === undefined || !Number.isFinite(score) || score <= 0) return;
    const list = byWorkstream.get(workstreamId) ?? [];
    list.push(Math.max(0, Math.min(1, score)));
    byWorkstream.set(workstreamId, list);
  };

  const context = { merged: [...events], existingEdges: [...snapshot.edges] };
  for (const targetVisitNodeId of [...canonicalTargetVisitNodeIds].sort()) {
    const targetVisitKey = visitKeyFromNodeOrRaw(targetVisitNodeId);
    const scored = generateCandidates(targetVisitKey, context)
      .map((candidate) => {
        const score =
          closestVisitRanker === undefined
            ? scoreForCandidateSources(candidate)
            : closestVisitRanker.predict(
                extractFeatures(candidate, { merged: [...events], snapshot }),
                candidate,
              ).score;
        return Number.isFinite(score) && score > 0 ? { candidate, score } : null;
      })
      .filter(
        (
          item,
        ): item is {
          readonly candidate: Candidate;
          readonly score: number;
        } => item !== null,
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.toVisitId.localeCompare(right.candidate.toVisitId) ||
          left.candidate.generatedAt - right.candidate.generatedAt,
      )
      .slice(0, Math.max(0, Math.floor(k)));
    for (const item of scored) {
      const candidateVisitKey = visitKeyFromNodeOrRaw(item.candidate.toVisitId);
      addScore(
        visitWorkstream.get(candidateVisitKey) ??
          visitWorkstream.get(visitNodeId(candidateVisitKey)),
        item.score,
      );
    }
  }

  for (const edge of snapshot.edges) {
    const score = scoreForEdge(edge.kind);
    if (score === 0) continue;
    const other =
      canonicalTargetVisitNodeIds.has(edge.fromNodeId) && edge.toNodeId.startsWith(VISIT_PREFIX)
        ? edge.toNodeId
        : canonicalTargetVisitNodeIds.has(edge.toNodeId) && edge.fromNodeId.startsWith(VISIT_PREFIX)
          ? edge.fromNodeId
          : canonicalTargetVisitNodeIds.has(edge.fromNodeId) &&
              edge.toNodeId.startsWith(VISIT_INSTANCE_PREFIX)
            ? canonicalVisitForNode(snapshot, edge.toNodeId)
            : canonicalTargetVisitNodeIds.has(edge.toNodeId) &&
                edge.fromNodeId.startsWith(VISIT_INSTANCE_PREFIX)
              ? canonicalVisitForNode(snapshot, edge.fromNodeId)
              : null;
    if (other === null) continue;
    addScore(visitWorkstream.get(other), score);
  }

  const topScores = [...byWorkstream.values()]
    .map((scores) => Math.max(...scores))
    .sort((left, right) => right - left);
  return [...byWorkstream.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([workstreamId, scores]) => {
      const top = Math.max(...scores);
      const second = topScores.find((score) => score < top) ?? 0;
      return {
        workstreamId,
        simTopScore: top,
        simMeanScore: scores.reduce((sum, value) => sum + value, 0) / scores.length,
        simAgreement: Math.min(1, scores.length / 10),
        simMargin: Math.max(0, top - second),
      };
    });
};
