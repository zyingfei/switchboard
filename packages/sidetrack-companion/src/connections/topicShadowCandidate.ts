import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { evidenceTokensForRecord } from '../page-evidence/extract.js';
import type { PageEvidenceRecord } from '../page-evidence/types.js';
import {
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  createTopicRevisionId,
  type TopicSecondaryAffiliation,
  type TopicNodeMetadata,
  type TopicRevision,
  type TopicRevisionTopic,
} from '../producers/topic-revision.js';
import type { VisitSimilarityRevision } from './types.js';
import {
  buildTopicRevision,
  type TopicVisit,
  type UserAssertedVisitRelation,
  type VisitSimilarityEdge,
} from './topicClusterer.js';
import { topicId } from './topicId.js';

export const TOPIC_SHADOW_CANDIDATE_ENV = 'SIDETRACK_TOPIC_SHADOW_CANDIDATE';
export const TOPIC_SHADOW_IDF_RKN_SPLIT_CANDIDATE = 'idf-rkn-split' as const;

const RECIPROCAL_K = 10;
const MIN_LEXICAL_SCORE = 0.05;
const HIGH_DF_RATIO = 0.2;
const SPLIT_SIZE_TRIGGER = 35;
const SPLIT_SECONDARY_SIZE_TRIGGER = 20;
const SPLIT_COHESION_TRIGGER = 0.78;
const SPLIT_MAX_CHILD_RATIO = 0.85;
const SECONDARY_AFFILIATION_LIMIT_PER_VISIT = 2;
const SECONDARY_AFFILIATION_MIN_SCORE = 0.58;
const SECONDARY_AFFILIATION_MIN_COSINE = 0.85;

interface WeightedEdge extends VisitSimilarityEdge {
  readonly lexicalScore: number;
  readonly confidence: number;
  readonly qualityPairWeight: number;
  readonly weight: number;
}

interface TermFrequency {
  readonly term: string;
  readonly df: number;
  readonly idf: number;
}

export interface TopicShadowDiagnostics {
  readonly enabled: boolean;
  readonly candidate: typeof TOPIC_SHADOW_IDF_RKN_SPLIT_CANDIDATE;
  readonly baselineAlgorithmVersion: string;
  readonly shadowAlgorithmVersion: typeof TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY;
  readonly baselineRevisionId: string;
  readonly shadowRevisionId: string;
  readonly edgeCountBeforePruning: number;
  readonly edgeCountAfterPruning: number;
  readonly reciprocalK: number;
  readonly minLexicalScore: number;
  readonly workstreamHardUnionEdgesRemoved: number;
  readonly inThreadRelationsRetained: number;
  readonly highDfTermsSuppressed: number;
  readonly highDfTerms: readonly TermFrequency[];
  readonly baselineTopicCount: number;
  readonly shadowTopicCount: number;
  readonly topicCountDelta: number;
  readonly baselineMaxTopicSize: number;
  readonly shadowMaxTopicSize: number;
  readonly maxTopicSizeDelta: number;
  readonly baselineMaxTopicShare: number;
  readonly shadowMaxTopicShare: number;
  readonly maxShareDelta: number;
  readonly eligibleVisitCount: number;
  readonly shadowAssignedVisitCount: number;
  readonly noiseShare: number;
  readonly splitParentCount: number;
  readonly splitAcceptedCount: number;
  readonly secondaryAffiliationCount: number;
  readonly contentEnrichedEdges?: number;
  readonly metadataOnlyEdges?: number;
  readonly mixedTierEdges?: number;
  readonly contentDrivenTopicCount?: number;
  readonly metadataOnlyTopicCount?: number;
  readonly perVisitChurn: number;
  readonly runtimeMs: number;
}

export interface TopicShadowCandidateResult {
  readonly revision: TopicRevision;
  readonly diagnostics: TopicShadowDiagnostics;
}

export interface BuildTopicShadowCandidateInput {
  readonly visits: readonly TopicVisit[];
  readonly visitSimilarity: VisitSimilarityRevision;
  readonly userAssertedRelations: readonly UserAssertedVisitRelation[];
  readonly baselineRevision: TopicRevision;
  readonly previousRevision?: TopicRevision;
  readonly cosineThreshold: number;
  readonly evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>;
}

const compareString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const roundMetric = (value: number): number => Number(value.toFixed(6));

const stableSuggestionIdFor = (medoidCanonicalUrl: string): string =>
  `suggestion:${createHash('sha256').update(medoidCanonicalUrl).digest('base64url').slice(0, 16)}`;

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const hostForUrl = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

const hostTokensForUrl = (url: string): readonly string[] =>
  hostForUrl(url)
    .split(/[^a-z0-9]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);

const pathTokensForUrl = (url: string): readonly string[] => {
  try {
    return new URL(url).pathname
      .split('/')
      .map(safeDecode)
      .flatMap((part) => part.split(/[^A-Za-z0-9]+/u))
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 1);
  } catch {
    return [];
  }
};

const titleTokens = (title: string | undefined): readonly string[] =>
  (title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);

const visitTokens = (
  visit: TopicVisit,
  evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>,
): readonly string[] => {
  const evidence = evidenceByCanonicalUrl?.get(visit.canonicalUrl);
  if (evidence !== undefined) {
    return [
      ...new Set([
        ...evidenceTokensForRecord(evidence).map((term) => term.normalized),
        ...evidence.metadata.titleTokens,
        ...evidence.metadata.pathTokens,
      ]),
    ].sort(compareString);
  }
  return [
    ...new Set([
      ...titleTokens(visit.title),
      ...hostTokensForUrl(visit.canonicalUrl),
      ...pathTokensForUrl(visit.canonicalUrl),
    ]),
  ].sort(compareString);
};

const buildTokenStats = (
  visits: readonly TopicVisit[],
  evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>,
): {
  readonly tokensByVisit: ReadonlyMap<string, readonly string[]>;
  readonly terms: readonly TermFrequency[];
  readonly idfFor: (term: string) => number;
} => {
  const tokensByVisit = new Map<string, readonly string[]>();
  const df = new Map<string, number>();
  for (const visit of visits) {
    if (visit.canonicalUrl.length === 0) continue;
    const tokens = visitTokens(visit, evidenceByCanonicalUrl);
    tokensByVisit.set(visit.canonicalUrl, tokens);
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const documentCount = Math.max(1, tokensByVisit.size);
  const idfFor = (term: string): number =>
    Math.log((documentCount + 1) / ((df.get(term) ?? 0) + 1)) + 1;
  const terms = [...df.entries()]
    .map(([term, count]) => ({ term, df: count, idf: roundMetric(idfFor(term)) }))
    .sort((left, right) => right.df - left.df || compareString(left.term, right.term));
  return { tokensByVisit, terms, idfFor };
};

const idfCosine = (
  leftTokens: readonly string[],
  rightTokens: readonly string[],
  idfFor: (term: string) => number,
): number => {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const token of left) {
    const weight = idfFor(token);
    leftNorm += weight * weight;
    if (right.has(token)) dot += weight * weight;
  }
  for (const token of right) {
    const weight = idfFor(token);
    rightNorm += weight * weight;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
};

const qualityWeightFor = (quality: string | undefined): number => {
  if (quality === 'high') return 1;
  if (quality === 'medium') return 0.75;
  if (quality === 'low') return 0.25;
  return 1;
};

const qualityPairWeightFor = (
  edge: VisitSimilarityEdge,
  evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>,
): number => {
  const left = evidenceByCanonicalUrl?.get(edge.fromVisitKey);
  const right = evidenceByCanonicalUrl?.get(edge.toVisitKey);
  return Math.min(
    qualityWeightFor(left?.content?.quality),
    qualityWeightFor(right?.content?.quality),
  );
};

const rankLookupFor = (edges: readonly VisitSimilarityEdge[]): ReadonlyMap<string, number> => {
  const adjacency = new Map<string, { readonly other: string; readonly score: number }[]>();
  for (const edge of edges) {
    const left = adjacency.get(edge.fromVisitKey) ?? [];
    left.push({ other: edge.toVisitKey, score: edge.cosine });
    adjacency.set(edge.fromVisitKey, left);
    const right = adjacency.get(edge.toVisitKey) ?? [];
    right.push({ other: edge.fromVisitKey, score: edge.cosine });
    adjacency.set(edge.toVisitKey, right);
  }

  const out = new Map<string, number>();
  for (const [visitKey, neighbors] of adjacency.entries()) {
    neighbors
      .sort((left, right) => right.score - left.score || compareString(left.other, right.other))
      .forEach((neighbor, index) => {
        out.set(`${visitKey}\u0000${neighbor.other}`, index + 1);
      });
  }
  return out;
};

const prunedSimilarityFor = (
  visits: readonly TopicVisit[],
  visitSimilarity: VisitSimilarityRevision,
  evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>,
): {
  readonly revisionId: string;
  readonly edges: readonly WeightedEdge[];
  readonly highDfTerms: readonly TermFrequency[];
} => {
  const visitByCanonical = new Map(visits.map((visit) => [visit.canonicalUrl, visit] as const));
  const { tokensByVisit, terms, idfFor } = buildTokenStats(visits, evidenceByCanonicalUrl);
  const ranks = rankLookupFor(visitSimilarity.edges);
  const edges: WeightedEdge[] = [];
  for (const edge of visitSimilarity.edges) {
    if (!visitByCanonical.has(edge.fromVisitKey) || !visitByCanonical.has(edge.toVisitKey)) {
      continue;
    }
    const sourceRank = ranks.get(`${edge.fromVisitKey}\u0000${edge.toVisitKey}`);
    const targetRank = ranks.get(`${edge.toVisitKey}\u0000${edge.fromVisitKey}`);
    if (
      sourceRank === undefined ||
      targetRank === undefined ||
      sourceRank > RECIPROCAL_K ||
      targetRank > RECIPROCAL_K
    ) {
      continue;
    }
    const lexicalScore = idfCosine(
      tokensByVisit.get(edge.fromVisitKey) ?? [],
      tokensByVisit.get(edge.toVisitKey) ?? [],
      idfFor,
    );
    if (lexicalScore < MIN_LEXICAL_SCORE) continue;
    const confidence =
      typeof edge.metadata?.confidence === 'number' && Number.isFinite(edge.metadata.confidence)
        ? Math.max(0, Math.min(1, edge.metadata.confidence))
        : 1;
    const qualityPairWeight = qualityPairWeightFor(edge, evidenceByCanonicalUrl);
    edges.push({
      fromVisitKey: edge.fromVisitKey,
      toVisitKey: edge.toVisitKey,
      cosine: edge.cosine,
      ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
      lexicalScore: roundMetric(lexicalScore),
      confidence: roundMetric(confidence),
      qualityPairWeight: roundMetric(qualityPairWeight),
      weight: roundMetric(edge.cosine * lexicalScore * confidence),
    });
  }
  edges.sort((left, right) => {
    const from = compareString(left.fromVisitKey, right.fromVisitKey);
    if (from !== 0) return from;
    return compareString(left.toVisitKey, right.toVisitKey);
  });
  const documentCount = Math.max(1, tokensByVisit.size);
  const highDfTerms = terms.filter((term) => term.df / documentCount >= HIGH_DF_RATIO).slice(0, 25);
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      sourceRevisionId: visitSimilarity.revisionId,
      candidate: TOPIC_SHADOW_IDF_RKN_SPLIT_CANDIDATE,
      reciprocalK: RECIPROCAL_K,
      minLexicalScore: MIN_LEXICAL_SCORE,
      edges,
    }),
  );
  return {
    revisionId: `${visitSimilarity.revisionId}:idf-rkn-split:${hash.digest('hex').slice(0, 8)}`,
    edges,
    highDfTerms,
  };
};

const componentize = (
  members: readonly string[],
  edges: readonly Pick<VisitSimilarityEdge, 'fromVisitKey' | 'toVisitKey'>[],
): readonly (readonly string[])[] => {
  const parent = new Map<string, string>();
  const add = (value: string): void => {
    if (!parent.has(value)) parent.set(value, value);
  };
  const find = (value: string): string => {
    add(value);
    const current = parent.get(value);
    if (current === undefined || current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const member of members) add(member);
  for (const edge of edges) union(edge.fromVisitKey, edge.toVisitKey);
  const groups = new Map<string, string[]>();
  for (const member of parent.keys()) {
    const root = find(member);
    const list = groups.get(root) ?? [];
    list.push(member);
    groups.set(root, list);
  }
  return [...groups.values()].map((group) => group.sort(compareString));
};

const averageCosine = (
  members: readonly string[],
  edges: readonly VisitSimilarityEdge[],
): number => {
  const memberSet = new Set(members);
  const scores = edges
    .filter((edge) => memberSet.has(edge.fromVisitKey) && memberSet.has(edge.toVisitKey))
    .map((edge) => edge.cosine);
  if (scores.length === 0) return 0;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
};

const medoidForMembers = (
  members: readonly string[],
  visitsByCanonical: ReadonlyMap<string, TopicVisit>,
  edges: readonly VisitSimilarityEdge[],
): string | undefined => {
  if (members.length === 0) return undefined;
  const memberSet = new Set(members);
  const scores = new Map<string, number>();
  for (const member of members) scores.set(member, 0);
  for (const edge of edges) {
    if (!memberSet.has(edge.fromVisitKey) || !memberSet.has(edge.toVisitKey)) continue;
    scores.set(edge.fromVisitKey, (scores.get(edge.fromVisitKey) ?? 0) + edge.cosine);
    scores.set(edge.toVisitKey, (scores.get(edge.toVisitKey) ?? 0) + edge.cosine);
  }
  return [...members].sort((left, right) => {
    const score = (scores.get(right) ?? 0) - (scores.get(left) ?? 0);
    if (score !== 0) return score;
    const focus =
      (visitsByCanonical.get(right)?.focusedWindowMs ?? 0) -
      (visitsByCanonical.get(left)?.focusedWindowMs ?? 0);
    if (focus !== 0) return focus;
    return compareString(left, right);
  })[0];
};

const weightedChildCohesion = (
  groups: readonly (readonly string[])[],
  edges: readonly VisitSimilarityEdge[],
): number => {
  let weighted = 0;
  let total = 0;
  for (const group of groups) {
    if (group.length < 2) continue;
    weighted += averageCosine(group, edges) * group.length;
    total += group.length;
  }
  return total === 0 ? 0 : weighted / total;
};

const percentile = (values: readonly number[], quantile: number): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile)),
  );
  return sorted[index];
};

const shouldSplit = (members: readonly string[], cohesion: number): boolean =>
  members.length > SPLIT_SIZE_TRIGGER ||
  (members.length > SPLIT_SECONDARY_SIZE_TRIGGER && cohesion < SPLIT_COHESION_TRIGGER);

const splitMembers = (
  members: readonly string[],
  edges: readonly WeightedEdge[],
): {
  readonly groups: readonly (readonly string[])[];
  readonly parentConsidered: number;
  readonly splitAccepted: number;
} => {
  const memberSet = new Set(members);
  const internal = edges.filter(
    (edge) => memberSet.has(edge.fromVisitKey) && memberSet.has(edge.toVisitKey),
  );
  const parentCohesion = averageCosine(members, internal);
  if (!shouldSplit(members, parentCohesion) || internal.length === 0) {
    return { groups: [members], parentConsidered: 0, splitAccepted: 0 };
  }

  for (const quantile of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    const threshold = percentile(
      internal.map((edge) => edge.weight),
      quantile,
    );
    if (threshold === undefined) continue;
    const kept = internal.filter((edge) => edge.weight >= threshold);
    const groups = componentize(members, kept);
    const nonSingletons = groups.filter((group) => group.length >= 2);
    if (nonSingletons.length < 2) continue;
    const largest = Math.max(...groups.map((group) => group.length));
    if (largest > Math.floor(members.length * SPLIT_MAX_CHILD_RATIO)) continue;
    const childCohesion = weightedChildCohesion(nonSingletons, internal);
    if (childCohesion + 0.005 < parentCohesion) continue;
    const nested = groups.flatMap((group) => splitMembers(group, edges).groups);
    return { groups: nested, parentConsidered: 1, splitAccepted: 1 };
  }
  return { groups: [members], parentConsidered: 1, splitAccepted: 0 };
};

const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const edgeLookupFor = (
  edges: readonly VisitSimilarityEdge[],
): ReadonlyMap<string, VisitSimilarityEdge> => {
  const out = new Map<string, VisitSimilarityEdge>();
  for (const edge of edges) out.set(pairKey(edge.fromVisitKey, edge.toVisitKey), edge);
  return out;
};

const uniqueVisitsByCanonical = (visits: readonly TopicVisit[]): readonly TopicVisit[] => [
  ...visits
    .reduce((byCanonical, visit) => {
      const existing = byCanonical.get(visit.canonicalUrl);
      if (
        existing === undefined ||
        visit.focusedWindowMs > existing.focusedWindowMs ||
        (visit.focusedWindowMs === existing.focusedWindowMs &&
          visit.lastObservedAt > existing.lastObservedAt)
      ) {
        byCanonical.set(visit.canonicalUrl, visit);
      }
      return byCanonical;
    }, new Map<string, TopicVisit>())
    .values(),
];

interface SecondaryTopicCandidate {
  readonly topicId: string;
  readonly canonicalUrl: string;
  readonly score: number;
  readonly reasons: TopicSecondaryAffiliation['reasons'];
  readonly supportCount: number;
  readonly maxCosine: number;
  readonly lexicalScore: number;
  readonly reciprocalSupport: number;
}

const secondaryAffiliationsFor = (
  topics: readonly TopicRevisionTopic[],
  visits: readonly TopicVisit[],
  visitSimilarity: VisitSimilarityRevision,
  evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>,
): readonly TopicRevisionTopic[] => {
  if (topics.length === 0) return topics;
  const uniqueVisits = uniqueVisitsByCanonical(visits);
  const visitByCanonical = new Map(
    uniqueVisits.map((visit) => [visit.canonicalUrl, visit] as const),
  );
  const primaryTopicByVisit = new Map<string, string>();
  for (const topic of topics) {
    for (const member of topic.memberCanonicalUrls) primaryTopicByVisit.set(member, topic.topicId);
  }
  const edgeByPair = edgeLookupFor(visitSimilarity.edges);
  const ranks = rankLookupFor(visitSimilarity.edges);
  const { tokensByVisit, idfFor } = buildTokenStats(uniqueVisits, evidenceByCanonicalUrl);
  const secondaryByTopic = new Map<string, TopicSecondaryAffiliation[]>();

  for (const visit of uniqueVisits) {
    const visitTokensForScore = tokensByVisit.get(visit.canonicalUrl) ?? [];
    const candidates: SecondaryTopicCandidate[] = [];
    for (const topic of topics) {
      if (primaryTopicByVisit.get(visit.canonicalUrl) === topic.topicId) continue;
      let supportCount = 0;
      let maxCosine = 0;
      let lexicalScore = 0;
      let reciprocalSupport = 0;
      for (const member of topic.memberCanonicalUrls) {
        if (member === visit.canonicalUrl) continue;
        const edge = edgeByPair.get(pairKey(visit.canonicalUrl, member));
        if (edge !== undefined) {
          supportCount += 1;
          maxCosine = Math.max(maxCosine, edge.cosine);
          const sourceRank = ranks.get(`${visit.canonicalUrl}\u0000${member}`);
          const targetRank = ranks.get(`${member}\u0000${visit.canonicalUrl}`);
          if (
            sourceRank !== undefined &&
            targetRank !== undefined &&
            sourceRank <= RECIPROCAL_K &&
            targetRank <= RECIPROCAL_K
          ) {
            reciprocalSupport += 1;
          }
        }
        lexicalScore = Math.max(
          lexicalScore,
          idfCosine(visitTokensForScore, tokensByVisit.get(member) ?? [], idfFor),
        );
      }
      const workstreamSignal =
        visit.workstreamId !== undefined &&
        topic.metadata.dominantWorkstreamId !== undefined &&
        visit.workstreamId === topic.metadata.dominantWorkstreamId;
      if (supportCount === 0 && !workstreamSignal) continue;
      const supportScore = Math.min(1, supportCount / 3);
      const reciprocalScore = supportCount === 0 ? 0 : reciprocalSupport / supportCount;
      const score = roundMetric(
        maxCosine * 0.65 +
          lexicalScore * 0.1 +
          supportScore * 0.15 +
          reciprocalScore * 0.1 +
          (workstreamSignal ? 0.08 : 0),
      );
      if (score < SECONDARY_AFFILIATION_MIN_SCORE) continue;
      const reasons: TopicSecondaryAffiliation['reasons'] = [
        ...(supportCount > 0 ? (['edge_support'] as const) : []),
        ...(maxCosine >= SECONDARY_AFFILIATION_MIN_COSINE ? (['member_similarity'] as const) : []),
        ...(reciprocalSupport > 0 ? (['reciprocal_support'] as const) : []),
        ...(lexicalScore >= MIN_LEXICAL_SCORE ? (['term_overlap'] as const) : []),
        ...(workstreamSignal ? (['workstream_signal'] as const) : []),
      ];
      candidates.push({
        topicId: topic.topicId,
        canonicalUrl: visit.canonicalUrl,
        score,
        reasons,
        supportCount,
        maxCosine: roundMetric(maxCosine),
        lexicalScore: roundMetric(lexicalScore),
        reciprocalSupport,
      });
    }
    candidates
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.maxCosine - left.maxCosine ||
          compareString(left.topicId, right.topicId),
      )
      .slice(0, SECONDARY_AFFILIATION_LIMIT_PER_VISIT)
      .forEach((candidate) => {
        if (!visitByCanonical.has(candidate.canonicalUrl)) return;
        const list = secondaryByTopic.get(candidate.topicId) ?? [];
        secondaryByTopic.set(candidate.topicId, [
          ...list,
          {
            canonicalUrl: candidate.canonicalUrl,
            score: candidate.score,
            reasons: candidate.reasons,
            supportCount: candidate.supportCount,
            maxCosine: candidate.maxCosine,
            lexicalScore: candidate.lexicalScore,
            reciprocalSupport: candidate.reciprocalSupport,
          },
        ]);
      });
  }

  return topics.map((topic) => {
    const secondaryAffiliations = (secondaryByTopic.get(topic.topicId) ?? []).sort((left, right) =>
      left.canonicalUrl === right.canonicalUrl
        ? right.score - left.score
        : compareString(left.canonicalUrl, right.canonicalUrl),
    );
    return secondaryAffiliations.length === 0 ? topic : { ...topic, secondaryAffiliations };
  });
};

const metadataForMembers = (
  members: readonly string[],
  visitsByCanonical: ReadonlyMap<string, TopicVisit>,
  edges: readonly VisitSimilarityEdge[],
): TopicNodeMetadata => {
  const visits = members
    .map((member) => visitsByCanonical.get(member))
    .filter((visit): visit is TopicVisit => visit !== undefined);
  const workstreamCounts = new Map<string, number>();
  for (const visit of visits) {
    if (visit.workstreamId === undefined || visit.workstreamId.length === 0) continue;
    workstreamCounts.set(visit.workstreamId, (workstreamCounts.get(visit.workstreamId) ?? 0) + 1);
  }
  const dominant = [...workstreamCounts.entries()].sort((left, right) => {
    if (left[1] !== right[1]) return right[1] - left[1];
    return compareString(left[0], right[0]);
  })[0];
  const representativeTitles = [...visits]
    .sort((left, right) => {
      if (left.focusedWindowMs !== right.focusedWindowMs) {
        return right.focusedWindowMs - left.focusedWindowMs;
      }
      return compareString(left.canonicalUrl, right.canonicalUrl);
    })
    .slice(0, 5)
    .map((visit) => {
      const title = visit.title?.trim();
      return title === undefined || title.length === 0 ? visit.canonicalUrl : title;
    });
  const medoidCanonicalUrl = medoidForMembers(members, visitsByCanonical, edges);
  return {
    memberCount: members.length,
    ...(dominant === undefined ? {} : { dominantWorkstreamId: dominant[0] }),
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
    cohesion: roundMetric(averageCosine(members, edges)),
  };
};

const topicCountFor = (revision: TopicRevision): number => revision.topics.length;

const memberCountFor = (revision: TopicRevision): number =>
  revision.topics.reduce((sum, topic) => sum + topic.memberCanonicalUrls.length, 0);

const maxTopicSizeFor = (revision: TopicRevision): number =>
  Math.max(0, ...revision.topics.map((topic) => topic.memberCanonicalUrls.length));

const visitToTopicMap = (revision: TopicRevision): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const topic of revision.topics) {
    for (const member of topic.memberCanonicalUrls) out.set(member, topic.topicId);
  }
  return out;
};

const perVisitChurn = (baseline: TopicRevision, shadow: TopicRevision): number => {
  const baselineTopicByVisit = visitToTopicMap(baseline);
  const shadowTopicByVisit = visitToTopicMap(shadow);
  if (baselineTopicByVisit.size === 0) return 0;
  let changed = 0;
  for (const [visitKey, baselineTopicId] of baselineTopicByVisit.entries()) {
    if (shadowTopicByVisit.get(visitKey) !== baselineTopicId) changed += 1;
  }
  return changed / baselineTopicByVisit.size;
};

// Default ON: idf-rkn-split is the production topic clustering (the
// legacy union-find baseline starves on raw e5 cosine -> ~0 topics).
// Set SIDETRACK_TOPIC_SHADOW_CANDIDATE=off (or false/0/none) to fall
// back to the baseline. `idf-rkn-split` and unset both mean on.
const TOPIC_SHADOW_DISABLED_VALUES = new Set(['off', 'false', '0', 'none']);
export const shouldBuildTopicShadowCandidate = (): boolean => {
  const raw = process.env[TOPIC_SHADOW_CANDIDATE_ENV];
  if (raw === undefined) return true;
  return !TOPIC_SHADOW_DISABLED_VALUES.has(raw.trim().toLowerCase());
};

// Stage 5.2 W4 (shadow) — the shadow revision id is a deterministic
// function of its inputs (the pruned-similarity revision id + cosine
// threshold + algorithm), exactly like the baseline topic-revision
// skip-gate in connectionsMaterializer. `prunedSimilarityFor` is the
// cheap part (token/df + reciprocal-rank pruning + a content hash);
// the expensive part is the union-find + recursive split clustering
// below. Computing just the expected id lets the materializer reuse a
// persisted, unchanged shadow instead of recomputing the full
// idf-rkn-split clustering on every drain (the dominant per-drain CPU
// cost — the runaway). Must stay byte-consistent with the id
// `buildTopicShadowCandidate` ultimately produces (asserted by test).
export const expectedShadowRevisionId = async (input: {
  readonly visits: readonly TopicVisit[];
  readonly visitSimilarity: VisitSimilarityRevision;
  readonly evidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>;
  readonly cosineThreshold: number;
}): Promise<string> => {
  const pruned = prunedSimilarityFor(
    input.visits,
    input.visitSimilarity,
    input.evidenceByCanonicalUrl,
  );
  return createTopicRevisionId({
    visitSimilarityRevisionId: pruned.revisionId,
    cosineThreshold: input.cosineThreshold,
    algorithmVersion: TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  });
};

export const buildTopicShadowCandidate = async (
  input: BuildTopicShadowCandidateInput,
): Promise<TopicShadowCandidateResult> => {
  const startedAt = performance.now();
  const pruned = prunedSimilarityFor(
    input.visits,
    input.visitSimilarity,
    input.evidenceByCanonicalUrl,
  );
  const retainedRelations = input.userAssertedRelations.filter(
    (relation) => relation.kind !== 'in_workstream',
  );
  const removedWorkstreamRelations = input.userAssertedRelations.length - retainedRelations.length;
  const base = await buildTopicRevision({
    visits: input.visits,
    visitSimilarity: { revisionId: pruned.revisionId, edges: pruned.edges },
    ...(retainedRelations.length === 0 ? {} : { userAssertedRelations: retainedRelations }),
    ...(input.previousRevision === undefined ? {} : { previousRevision: input.previousRevision }),
    options: {
      cosineThreshold: input.cosineThreshold,
      algorithmVersion: TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
    },
  });

  const visitsByCanonical = new Map(input.visits.map((visit) => [visit.canonicalUrl, visit]));
  const topics: TopicRevisionTopic[] = [];
  let splitParentCount = 0;
  let splitAcceptedCount = 0;
  for (const baseTopic of base.topics) {
    const split = splitMembers(baseTopic.memberCanonicalUrls, pruned.edges);
    splitParentCount += split.parentConsidered;
    splitAcceptedCount += split.splitAccepted;
    for (const members of split.groups) {
      if (members.length < 2) continue;
      const sortedMembers = [...members].sort(compareString);
      topics.push({
        topicId: await topicId(sortedMembers),
        memberCanonicalUrls: sortedMembers,
        metadata: metadataForMembers(sortedMembers, visitsByCanonical, pruned.edges),
      });
    }
  }
  topics.sort((left, right) => compareString(left.topicId, right.topicId));
  const topicsWithSecondary = secondaryAffiliationsFor(
    topics,
    input.visits,
    input.visitSimilarity,
    input.evidenceByCanonicalUrl,
  );
  const secondaryAffiliationCount = topicsWithSecondary.reduce(
    (sum, topic) => sum + (topic.secondaryAffiliations?.length ?? 0),
    0,
  );
  const contentEnrichedEdges = input.visitSimilarity.edges.filter(
    (edge) => edge.metadata?.producer === 'content-enriched',
  ).length;
  const metadataOnlyEdges = input.visitSimilarity.edges.filter(
    (edge) => edge.metadata?.producer === 'metadata-only',
  ).length;
  const mixedTierEdges = input.visitSimilarity.edges.filter((edge) => {
    const from = edge.metadata?.evidenceTierFrom;
    const to = edge.metadata?.evidenceTierTo;
    return typeof from === 'string' && typeof to === 'string' && from !== to;
  }).length;
  const contentDrivenTopicCount = topicsWithSecondary.filter((topic) =>
    topic.memberCanonicalUrls.some(
      (canonicalUrl) => input.evidenceByCanonicalUrl?.get(canonicalUrl)?.content !== undefined,
    ),
  ).length;
  const revision: TopicRevision = {
    ...base,
    topics: topicsWithSecondary,
  };

  const baselineMembers = Math.max(1, memberCountFor(input.baselineRevision));
  const shadowMembers = memberCountFor(revision);
  const baselineMax = maxTopicSizeFor(input.baselineRevision);
  const shadowMax = maxTopicSizeFor(revision);
  const baselineShare = baselineMax / baselineMembers;
  const shadowShare = shadowMax / baselineMembers;
  const diagnostics: TopicShadowDiagnostics = {
    enabled: true,
    candidate: TOPIC_SHADOW_IDF_RKN_SPLIT_CANDIDATE,
    baselineAlgorithmVersion: input.baselineRevision.algorithmVersion,
    shadowAlgorithmVersion: TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
    baselineRevisionId: input.baselineRevision.revisionId,
    shadowRevisionId: revision.revisionId,
    edgeCountBeforePruning: input.visitSimilarity.edges.length,
    edgeCountAfterPruning: pruned.edges.length,
    reciprocalK: RECIPROCAL_K,
    minLexicalScore: MIN_LEXICAL_SCORE,
    workstreamHardUnionEdgesRemoved: removedWorkstreamRelations,
    inThreadRelationsRetained: retainedRelations.length,
    highDfTermsSuppressed: pruned.highDfTerms.length,
    highDfTerms: pruned.highDfTerms,
    baselineTopicCount: topicCountFor(input.baselineRevision),
    shadowTopicCount: topicCountFor(revision),
    topicCountDelta: topicCountFor(revision) - topicCountFor(input.baselineRevision),
    baselineMaxTopicSize: baselineMax,
    shadowMaxTopicSize: shadowMax,
    maxTopicSizeDelta: shadowMax - baselineMax,
    baselineMaxTopicShare: roundMetric(baselineShare),
    shadowMaxTopicShare: roundMetric(shadowShare),
    maxShareDelta: roundMetric(shadowShare - baselineShare),
    eligibleVisitCount: baselineMembers,
    shadowAssignedVisitCount: shadowMembers,
    noiseShare: roundMetric((baselineMembers - shadowMembers) / baselineMembers),
    splitParentCount,
    splitAcceptedCount,
    secondaryAffiliationCount,
    contentEnrichedEdges,
    metadataOnlyEdges,
    mixedTierEdges,
    contentDrivenTopicCount,
    metadataOnlyTopicCount: Math.max(0, topicsWithSecondary.length - contentDrivenTopicCount),
    perVisitChurn: roundMetric(perVisitChurn(input.baselineRevision, revision)),
    runtimeMs: roundMetric(performance.now() - startedAt),
  };
  return { revision, diagnostics };
};
