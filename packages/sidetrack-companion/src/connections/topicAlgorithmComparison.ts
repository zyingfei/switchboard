import { createHash } from 'node:crypto';

import {
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  type TopicNodeMetadata,
  type TopicRevision,
  type TopicRevisionStore,
  type TopicRevisionTopic,
} from '../producers/topic-revision.js';
import type { FocusEvalPack, FocusEvalPair } from './focusEvalPack.js';
import { louvainCommunityPartition } from './graphCommunityClusterer.js';
import {
  buildTopicRevision,
  type TopicVisit,
  type VisitSimilarityEdge,
  type VisitSimilarityRevisionInput,
} from './topicClusterer.js';
import { topicId } from './topicId.js';

export type TopicComparisonCandidate =
  | 'sparse-uf'
  | 'leiden-modularity'
  | 'leiden-cpm'
  | 'bertopic-shaped'
  | 'louvain-community';

export interface TopicAlgorithmComparisonMetrics {
  readonly pairwisePrecision: number;
  readonly bCubedPrecision: number;
  readonly bCubedRecall: number;
  readonly bCubedF1: number;
  readonly omegaIndex: number;
  readonly labeledPairAccuracy: number;
  readonly perVisitChurn: number;
  readonly topicCount: number;
  readonly maxTopicSize: number;
  readonly assignedVisitCount: number;
  readonly noiseCount: number;
}

export interface TopicAlgorithmComparisonResult {
  readonly candidate: TopicComparisonCandidate;
  readonly revision: TopicRevision;
  readonly metrics: TopicAlgorithmComparisonMetrics;
}

export interface RunTopicAlgorithmComparisonInput {
  readonly pack: FocusEvalPack;
  readonly candidates?: readonly TopicComparisonCandidate[];
  readonly previousRevision?: TopicRevision;
  readonly cosineThreshold?: number;
}

const DEFAULT_THRESHOLD = 0.85;
const CPM_GAMMA = 0.18;

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const roundMetric = (value: number): number => Number(value.toFixed(6));

const stableSuggestionIdFor = (medoidCanonicalUrl: string): string =>
  `suggestion:${createHash('sha256').update(medoidCanonicalUrl).digest('base64url').slice(0, 16)}`;

const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

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

const partitionObjective = (
  communities: ReadonlyMap<string, string>,
  nodes: readonly string[],
  edges: readonly VisitSimilarityEdge[],
  objective: 'modularity' | 'cpm',
): number => {
  const byCommunity = new Map<string, Set<string>>();
  for (const node of nodes) {
    const community = communities.get(node) ?? node;
    const members = byCommunity.get(community) ?? new Set<string>();
    members.add(node);
    byCommunity.set(community, members);
  }
  if (objective === 'cpm') {
    let score = 0;
    for (const members of byCommunity.values()) {
      let internal = 0;
      for (const edge of edges) {
        if (members.has(edge.fromVisitKey) && members.has(edge.toVisitKey)) internal += edge.cosine;
      }
      score += internal - (CPM_GAMMA * (members.size * (members.size - 1))) / 2;
    }
    return score;
  }

  const totalWeight = edges.reduce((sum, edge) => sum + edge.cosine, 0);
  if (totalWeight === 0) return 0;
  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node, 0);
  for (const edge of edges) {
    degree.set(edge.fromVisitKey, (degree.get(edge.fromVisitKey) ?? 0) + edge.cosine);
    degree.set(edge.toVisitKey, (degree.get(edge.toVisitKey) ?? 0) + edge.cosine);
  }
  let score = 0;
  for (const members of byCommunity.values()) {
    let internal = 0;
    let degreeSum = 0;
    for (const member of members) degreeSum += degree.get(member) ?? 0;
    for (const edge of edges) {
      if (members.has(edge.fromVisitKey) && members.has(edge.toVisitKey)) internal += edge.cosine;
    }
    score += internal / totalWeight - (degreeSum / (2 * totalWeight)) ** 2;
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

const leidenLikePartition = (
  nodes: readonly string[],
  edges: readonly VisitSimilarityEdge[],
  objective: 'modularity' | 'cpm',
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
      let bestScore = partitionObjective(communities, nodes, edges, objective);
      for (const candidate of [...candidateCommunities].sort(compareString)) {
        if (candidate === current) continue;
        const trial = new Map(communities);
        trial.set(node, candidate);
        const score = partitionObjective(trial, nodes, edges, objective);
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

const densityLeafPartition = (
  nodes: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): readonly (readonly string[])[] => {
  const scoresByNode = new Map<string, number[]>();
  for (const node of nodes) scoresByNode.set(node, []);
  for (const edge of edges) {
    scoresByNode.get(edge.fromVisitKey)?.push(edge.cosine);
    scoresByNode.get(edge.toVisitKey)?.push(edge.cosine);
  }
  const localThreshold = (node: string): number => {
    const scores = [...(scoresByNode.get(node) ?? [])].sort((left, right) => left - right);
    if (scores.length === 0) return 1;
    return scores[Math.floor((scores.length - 1) * 0.6)] ?? 1;
  };
  const kept = edges.filter(
    (edge) =>
      edge.cosine >= Math.max(localThreshold(edge.fromVisitKey), localThreshold(edge.toVisitKey)),
  );
  return connectedComponents(nodes, kept);
};

const metadataForMembers = (
  members: readonly string[],
  visitsByCanonical: ReadonlyMap<string, TopicVisit>,
  edges: readonly VisitSimilarityEdge[],
): TopicNodeMetadata => {
  const visits = members
    .map((member) => visitsByCanonical.get(member))
    .filter((visit): visit is TopicVisit => visit !== undefined);
  const representativeTitles = visits
    .sort(
      (left, right) =>
        right.focusedWindowMs - left.focusedWindowMs ||
        compareString(left.canonicalUrl, right.canonicalUrl),
    )
    .slice(0, 5)
    .map((visit) => visit.title ?? visit.canonicalUrl);
  const memberSet = new Set(members);
  const internal = edges.filter(
    (edge) => memberSet.has(edge.fromVisitKey) && memberSet.has(edge.toVisitKey),
  );
  const medoidCanonicalUrl = members[0];
  return {
    memberCount: members.length,
    ...(medoidCanonicalUrl === undefined
      ? {}
      : {
          medoidCanonicalUrl,
          stableSuggestionId: stableSuggestionIdFor(medoidCanonicalUrl),
        }),
    representativeTitles,
    firstObservedAt: visits.map((visit) => visit.firstObservedAt).sort(compareString)[0] ?? '',
    lastObservedAt:
      visits.map((visit) => visit.lastObservedAt).sort((a, b) => compareString(b, a))[0] ?? '',
    cohesion:
      internal.length === 0
        ? 0
        : roundMetric(internal.reduce((sum, edge) => sum + edge.cosine, 0) / internal.length),
  };
};

const revisionFromGroups = async (input: {
  readonly candidate: TopicComparisonCandidate;
  readonly groups: readonly (readonly string[])[];
  readonly visits: readonly TopicVisit[];
  readonly visitSimilarity: VisitSimilarityRevisionInput;
  readonly threshold: number;
}): Promise<TopicRevision> => {
  const visitsByCanonical = new Map(input.visits.map((visit) => [visit.canonicalUrl, visit]));
  const topics: TopicRevisionTopic[] = [];
  for (const group of input.groups) {
    const members = [...group].sort(compareString);
    if (members.length < 2) continue;
    topics.push({
      topicId: await topicId(members),
      memberCanonicalUrls: members,
      metadata: metadataForMembers(members, visitsByCanonical, input.visitSimilarity.edges),
    });
  }
  topics.sort((left, right) => compareString(left.topicId, right.topicId));
  return {
    revisionId: `topic-comparison:${input.candidate}:${createHash('sha256')
      .update(topics.map((topic) => topic.topicId).join('\n'))
      .digest('hex')
      .slice(0, 12)}`,
    visitSimilarityRevisionId: input.visitSimilarity.revisionId,
    cosineThreshold: input.threshold,
    algorithmVersion: TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
    topics,
    lineage: [],
    producedAt: Date.parse('2026-05-13T12:00:00.000Z'),
  };
};

const visitToTopicMap = (revision: TopicRevision): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const topic of revision.topics) {
    for (const member of topic.memberCanonicalUrls) out.set(member, topic.topicId);
  }
  return out;
};

const perVisitChurn = (previous: TopicRevision | undefined, current: TopicRevision): number => {
  if (previous === undefined) return 0;
  const before = visitToTopicMap(previous);
  const after = visitToTopicMap(current);
  if (before.size === 0) return 0;
  let changed = 0;
  for (const [visit, topic] of before.entries()) {
    if (after.get(visit) !== topic) changed += 1;
  }
  return changed / before.size;
};

const labeledPairPredictions = (
  labels: readonly FocusEvalPair[],
  predictedTopicByVisit: ReadonlyMap<string, string>,
): readonly { readonly label: FocusEvalPair['label']; readonly predictedSame: boolean }[] =>
  labels.map((label) => ({
    label: label.label,
    predictedSame:
      predictedTopicByVisit.has(label.a) &&
      predictedTopicByVisit.get(label.a) === predictedTopicByVisit.get(label.b),
  }));

const bCubed = (
  revision: TopicRevision,
  trueClusterByVisit: ReadonlyMap<string, string>,
): { readonly precision: number; readonly recall: number; readonly f1: number } => {
  const predictedByVisit = visitToTopicMap(revision);
  const visits = [...trueClusterByVisit.keys()].sort(compareString);
  const predictedMembers = new Map<string, Set<string>>();
  const trueMembers = new Map<string, Set<string>>();
  for (const visit of visits) {
    const predicted = predictedByVisit.get(visit) ?? `noise:${visit}`;
    const truth = trueClusterByVisit.get(visit) ?? `unknown:${visit}`;
    const p = predictedMembers.get(predicted) ?? new Set<string>();
    p.add(visit);
    predictedMembers.set(predicted, p);
    const t = trueMembers.get(truth) ?? new Set<string>();
    t.add(visit);
    trueMembers.set(truth, t);
  }
  let precision = 0;
  let recall = 0;
  for (const visit of visits) {
    const predicted =
      predictedMembers.get(predictedByVisit.get(visit) ?? `noise:${visit}`) ??
      new Set<string>([visit]);
    const truth =
      trueMembers.get(trueClusterByVisit.get(visit) ?? `unknown:${visit}`) ??
      new Set<string>([visit]);
    let intersection = 0;
    for (const member of predicted) {
      if (truth.has(member)) intersection += 1;
    }
    precision += intersection / predicted.size;
    recall += intersection / truth.size;
  }
  precision = visits.length === 0 ? 0 : precision / visits.length;
  recall = visits.length === 0 ? 0 : recall / visits.length;
  return {
    precision: roundMetric(precision),
    recall: roundMetric(recall),
    f1: precision + recall === 0 ? 0 : roundMetric((2 * precision * recall) / (precision + recall)),
  };
};

const metricsFor = (
  revision: TopicRevision,
  pack: FocusEvalPack,
  previousRevision: TopicRevision | undefined,
): TopicAlgorithmComparisonMetrics => {
  const predictedByVisit = visitToTopicMap(revision);
  const labeled = labeledPairPredictions(pack.labels, predictedByVisit).filter(
    (row) => row.label !== 'ambiguous',
  );
  const predictedSame = labeled.filter((row) => row.predictedSame);
  const truePositive = predictedSame.filter((row) => row.label === 'same-topic').length;
  const agreements = labeled.filter(
    (row) =>
      (row.label === 'same-topic' && row.predictedSame) ||
      (row.label === 'different-topic' && !row.predictedSame),
  ).length;
  const bcubed = bCubed(revision, pack.trueClusterByVisit);
  const assignedVisitCount = predictedByVisit.size;
  return {
    pairwisePrecision:
      predictedSame.length === 0 ? 0 : roundMetric(truePositive / predictedSame.length),
    bCubedPrecision: bcubed.precision,
    bCubedRecall: bcubed.recall,
    bCubedF1: bcubed.f1,
    omegaIndex: labeled.length === 0 ? 0 : roundMetric(agreements / labeled.length),
    labeledPairAccuracy: labeled.length === 0 ? 0 : roundMetric(agreements / labeled.length),
    perVisitChurn: roundMetric(perVisitChurn(previousRevision, revision)),
    topicCount: revision.topics.length,
    maxTopicSize: Math.max(0, ...revision.topics.map((topic) => topic.memberCanonicalUrls.length)),
    assignedVisitCount,
    noiseCount: Math.max(0, pack.visits.length - assignedVisitCount),
  };
};

const buildCandidateRevision = async (
  candidate: TopicComparisonCandidate,
  visits: readonly TopicVisit[],
  visitSimilarity: VisitSimilarityRevisionInput,
  threshold: number,
  previousRevision: TopicRevision | undefined,
): Promise<TopicRevision> => {
  if (candidate === 'sparse-uf') {
    return buildTopicRevision({
      visits,
      visitSimilarity,
      ...(previousRevision === undefined ? {} : { previousRevision }),
      options: { cosineThreshold: threshold, producedAt: Date.parse('2026-05-13T12:00:00.000Z') },
    });
  }
  const eligible = eligibleVisits(visits);
  const nodeIds = eligible.map((visit) => visit.canonicalUrl).sort(compareString);
  const edges = filteredEdges(visitSimilarity.edges, new Set(nodeIds), threshold);
  const groups =
    candidate === 'leiden-modularity'
      ? leidenLikePartition(nodeIds, edges, 'modularity')
      : candidate === 'leiden-cpm'
        ? leidenLikePartition(nodeIds, edges, 'cpm')
        : candidate === 'louvain-community'
          ? louvainCommunityPartition(nodeIds, edges)
          : densityLeafPartition(nodeIds, edges);
  return revisionFromGroups({ candidate, groups, visits, visitSimilarity, threshold });
};

export const runTopicAlgorithmComparison = async (
  input: RunTopicAlgorithmComparisonInput,
): Promise<readonly TopicAlgorithmComparisonResult[]> => {
  const candidates = input.candidates ?? [
    'sparse-uf',
    'leiden-modularity',
    'leiden-cpm',
    'bertopic-shaped',
    'louvain-community',
  ];
  const threshold = input.cosineThreshold ?? DEFAULT_THRESHOLD;
  const results: TopicAlgorithmComparisonResult[] = [];
  for (const candidate of candidates) {
    const revision = await buildCandidateRevision(
      candidate,
      input.pack.visits,
      input.pack.visitSimilarity,
      threshold,
      input.previousRevision,
    );
    results.push({
      candidate,
      revision,
      metrics: metricsFor(revision, input.pack, input.previousRevision),
    });
  }
  return results;
};

export const writeTopicAlgorithmComparisonShadows = async (
  store: TopicRevisionStore,
  results: readonly TopicAlgorithmComparisonResult[],
): Promise<void> => {
  for (const result of results) {
    await store.putCandidateShadowRevision(result.candidate, result.revision);
  }
};
