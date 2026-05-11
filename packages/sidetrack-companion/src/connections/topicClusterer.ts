import {
  DEFAULT_TOPIC_COSINE_THRESHOLD,
  DEFAULT_TOPIC_ENGAGEMENT_GATE_MS,
  TOPIC_ALGORITHM_VERSION,
  createTopicRevisionId,
  type TopicAlgorithmVersion,
  type TopicLineage,
  type TopicNodeMetadata,
  type TopicRevision,
  type TopicRevisionTopic,
} from '../producers/topic-revision.js';
import { topicId } from './topicId.js';
import { UnionFind } from './unionFind.js';

export interface TopicVisit {
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly focusedWindowMs: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly workstreamId?: string;
}

export interface VisitSimilarityEdge {
  readonly fromVisitKey: string;
  readonly toVisitKey: string;
  readonly cosine: number;
}

export interface VisitSimilarityRevisionInput {
  readonly revisionId: string;
  readonly edges: readonly VisitSimilarityEdge[];
}

export type UserAssertedVisitRelationKind = 'in_thread' | 'in_workstream';

export interface UserAssertedVisitRelation {
  readonly kind: UserAssertedVisitRelationKind;
  readonly fromVisitKey: string;
  readonly toVisitKey: string;
}

export interface BuildTopicRevisionOptions {
  readonly cosineThreshold?: number;
  readonly engagementGateMs?: number;
  readonly algorithmVersion?: TopicAlgorithmVersion;
  readonly producedAt?: number;
}

export interface BuildTopicRevisionInput {
  readonly visits: readonly TopicVisit[];
  readonly visitSimilarity: VisitSimilarityRevisionInput;
  readonly userAssertedRelations?: readonly UserAssertedVisitRelation[];
  readonly previousRevision?: TopicRevision;
  readonly options?: BuildTopicRevisionOptions;
}

interface CurrentComponent {
  readonly topicId: string;
  readonly memberCanonicalUrls: readonly string[];
}

const compareString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const roundMetric = (value: number): number => Number(value.toFixed(6));

const sortedVisitsByCanonical = (visits: readonly TopicVisit[]): readonly TopicVisit[] => {
  const byCanonical = new Map<string, TopicVisit>();
  for (const visit of [...visits].sort((a, b) => compareString(a.canonicalUrl, b.canonicalUrl))) {
    if (visit.canonicalUrl.length === 0) continue;
    const existing = byCanonical.get(visit.canonicalUrl);
    if (existing === undefined) {
      byCanonical.set(visit.canonicalUrl, visit);
      continue;
    }
    const title =
      (existing.title ?? '').length >= (visit.title ?? '').length ? existing.title : visit.title;
    byCanonical.set(visit.canonicalUrl, {
      canonicalUrl: visit.canonicalUrl,
      ...(title === undefined ? {} : { title }),
      focusedWindowMs: Math.max(existing.focusedWindowMs, visit.focusedWindowMs),
      firstObservedAt:
        existing.firstObservedAt < visit.firstObservedAt
          ? existing.firstObservedAt
          : visit.firstObservedAt,
      lastObservedAt:
        existing.lastObservedAt > visit.lastObservedAt
          ? existing.lastObservedAt
          : visit.lastObservedAt,
      ...(visit.workstreamId === undefined
        ? existing.workstreamId === undefined
          ? {}
          : { workstreamId: existing.workstreamId }
        : { workstreamId: visit.workstreamId }),
    });
  }
  return [...byCanonical.values()];
};

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

const buildMetadata = (
  members: readonly string[],
  visitsByCanonical: ReadonlyMap<string, TopicVisit>,
  similarityEdges: readonly VisitSimilarityEdge[],
  cosineThreshold: number,
): TopicNodeMetadata => {
  const visits = members
    .map((member) => visitsByCanonical.get(member))
    .filter((visit) => visit !== undefined);
  const memberSet = new Set(members);
  const workstreamCounts = new Map<string, number>();
  for (const visit of visits) {
    if (visit.workstreamId === undefined || visit.workstreamId.length === 0) continue;
    workstreamCounts.set(visit.workstreamId, (workstreamCounts.get(visit.workstreamId) ?? 0) + 1);
  }
  const dominant = [...workstreamCounts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return compareString(a[0], b[0]);
  })[0];

  const representativeTitles = [...visits]
    .sort((a, b) => {
      if (a.focusedWindowMs !== b.focusedWindowMs) {
        return b.focusedWindowMs - a.focusedWindowMs;
      }
      return compareString(a.canonicalUrl, b.canonicalUrl);
    })
    .slice(0, 5)
    .map((visit) => {
      const title = visit.title?.trim();
      return title === undefined || title.length === 0 ? visit.canonicalUrl : title;
    });

  const firstObservedAt = visits.map((visit) => visit.firstObservedAt).sort(compareString)[0] ?? '';
  const lastObservedAt =
    visits.map((visit) => visit.lastObservedAt).sort((a, b) => compareString(b, a))[0] ?? '';

  const cosinesByPair = new Map<string, number>();
  for (const edge of similarityEdges) {
    if (edge.cosine < cosineThreshold) continue;
    if (!memberSet.has(edge.fromVisitKey) || !memberSet.has(edge.toVisitKey)) continue;
    const key = pairKey(edge.fromVisitKey, edge.toVisitKey);
    const existing = cosinesByPair.get(key);
    if (existing === undefined || edge.cosine > existing) {
      cosinesByPair.set(key, edge.cosine);
    }
  }
  const cosines = [...cosinesByPair.values()];
  const cohesion =
    cosines.length === 0
      ? 0
      : roundMetric(cosines.reduce((sum, cosine) => sum + cosine, 0) / cosines.length);

  return {
    memberCount: members.length,
    ...(dominant === undefined ? {} : { dominantWorkstreamId: dominant[0] }),
    representativeTitles,
    firstObservedAt,
    lastObservedAt,
    cohesion,
  };
};

const computeLineage = async (
  previousRevision: TopicRevision | undefined,
  currentComponents: readonly CurrentComponent[],
  observedAt: string,
): Promise<readonly TopicLineage[]> => {
  if (previousRevision === undefined) return [];

  const currentTopicIdByMember = new Map<string, string>();
  for (const component of currentComponents) {
    for (const member of component.memberCanonicalUrls) {
      currentTopicIdByMember.set(member, component.topicId);
    }
  }

  const previousTopicIdsByMember = new Map<string, Set<string>>();
  for (const topic of previousRevision.topics) {
    for (const member of topic.memberCanonicalUrls) {
      const set = previousTopicIdsByMember.get(member) ?? new Set<string>();
      set.add(topic.topicId);
      previousTopicIdsByMember.set(member, set);
    }
  }

  const emitted = new Set<string>();
  const lineage: TopicLineage[] = [];
  const push = (edge: TopicLineage): void => {
    const key = `${edge.fromTopicId}\u0000${edge.toTopicId}\u0000${edge.kind}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    lineage.push(edge);
  };

  for (const previousTopic of [...previousRevision.topics].sort((a, b) =>
    compareString(a.topicId, b.topicId),
  )) {
    const currentIds = new Set<string>();
    for (const member of previousTopic.memberCanonicalUrls) {
      const currentTopicId = currentTopicIdByMember.get(member);
      if (currentTopicId !== undefined) currentIds.add(currentTopicId);
    }
    if (currentIds.size <= 1) continue;
    for (const currentTopicId of [...currentIds].sort(compareString)) {
      push({
        fromTopicId: previousTopic.topicId,
        toTopicId: currentTopicId,
        kind: 'split',
        observedAt,
      });
    }
  }

  for (const currentComponent of [...currentComponents].sort((a, b) =>
    compareString(a.topicId, b.topicId),
  )) {
    const previousIds = new Set<string>();
    for (const member of currentComponent.memberCanonicalUrls) {
      const containingPreviousTopics = previousTopicIdsByMember.get(member);
      if (containingPreviousTopics === undefined) continue;
      for (const previousTopicId of containingPreviousTopics) previousIds.add(previousTopicId);
    }
    if (previousIds.size <= 1) continue;
    for (const previousTopicId of [...previousIds].sort(compareString)) {
      push({
        fromTopicId: previousTopicId,
        toTopicId: currentComponent.topicId,
        kind: 'merge',
        observedAt,
      });
    }
  }

  return lineage.sort((a, b) => {
    const from = compareString(a.fromTopicId, b.fromTopicId);
    if (from !== 0) return from;
    const to = compareString(a.toTopicId, b.toTopicId);
    if (to !== 0) return to;
    return compareString(a.kind, b.kind);
  });
};

// Stage 5 follow-up — env-tunable topic engagement gate. Production
// default still DEFAULT_TOPIC_ENGAGEMENT_GATE_MS (5000ms); dogfood can
// dial it down for short browsing sessions.
export const TOPIC_ENGAGEMENT_GATE_MS_ENV = 'SIDETRACK_TOPIC_ENGAGEMENT_GATE_MS';

const resolveTopicEngagementGateMs = (override: number | undefined): number => {
  if (override !== undefined && Number.isFinite(override)) return Math.max(0, override);
  const raw = process.env[TOPIC_ENGAGEMENT_GATE_MS_ENV];
  if (raw !== undefined && raw.length > 0) {
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  return DEFAULT_TOPIC_ENGAGEMENT_GATE_MS;
};

export const buildTopicRevision = async (
  input: BuildTopicRevisionInput,
): Promise<TopicRevision> => {
  const cosineThreshold = input.options?.cosineThreshold ?? DEFAULT_TOPIC_COSINE_THRESHOLD;
  const engagementGateMs = resolveTopicEngagementGateMs(input.options?.engagementGateMs);
  const algorithmVersion = input.options?.algorithmVersion ?? TOPIC_ALGORITHM_VERSION;
  const producedAt = input.options?.producedAt ?? Date.now();
  const observedAt = new Date(producedAt).toISOString();

  const visits = sortedVisitsByCanonical(input.visits);
  const visitsByCanonical = new Map(visits.map((visit) => [visit.canonicalUrl, visit] as const));
  const touchedVisitKeys = new Set<string>();
  for (const edge of input.visitSimilarity.edges) {
    touchedVisitKeys.add(edge.fromVisitKey);
    touchedVisitKeys.add(edge.toVisitKey);
  }
  // Stage 5 follow-up — user-asserted relations' endpoints get a
  // bypass for the engagement gate. The user's intent (organized this
  // URL into a workstream) is a stronger signal than "did they linger
  // on the page for 5 s." Without this, T3 derives relations
  // correctly but they silently fail to form topics because most
  // dogfood visits are below the engagement gate.
  const userAssertedVisitKeys = new Set<string>();
  for (const relation of input.userAssertedRelations ?? []) {
    touchedVisitKeys.add(relation.fromVisitKey);
    touchedVisitKeys.add(relation.toVisitKey);
    userAssertedVisitKeys.add(relation.fromVisitKey);
    userAssertedVisitKeys.add(relation.toVisitKey);
  }
  for (const previousTopic of input.previousRevision?.topics ?? []) {
    for (const member of previousTopic.memberCanonicalUrls) touchedVisitKeys.add(member);
  }

  const eligibleVisitKeys = new Set<string>();
  for (const visit of visits) {
    if (!touchedVisitKeys.has(visit.canonicalUrl)) continue;
    // User-asserted endpoints bypass the engagement gate. Everyone
    // else still has to clear it.
    if (
      visit.focusedWindowMs <= engagementGateMs &&
      !userAssertedVisitKeys.has(visit.canonicalUrl)
    ) {
      continue;
    }
    eligibleVisitKeys.add(visit.canonicalUrl);
  }

  const uf = new UnionFind();
  for (const key of [...eligibleVisitKeys].sort(compareString)) uf.add(key);

  for (const relation of input.userAssertedRelations ?? []) {
    if (
      !eligibleVisitKeys.has(relation.fromVisitKey) ||
      !eligibleVisitKeys.has(relation.toVisitKey)
    ) {
      continue;
    }
    uf.union(relation.fromVisitKey, relation.toVisitKey);
  }

  for (const edge of input.visitSimilarity.edges) {
    if (edge.cosine < cosineThreshold) continue;
    if (!eligibleVisitKeys.has(edge.fromVisitKey) || !eligibleVisitKeys.has(edge.toVisitKey)) {
      continue;
    }
    uf.union(edge.fromVisitKey, edge.toVisitKey);
  }

  const currentComponents: CurrentComponent[] = [];
  for (const component of uf.components()) {
    const memberCanonicalUrls = [...component.members].sort(compareString);
    currentComponents.push({
      topicId: await topicId(memberCanonicalUrls),
      memberCanonicalUrls,
    });
  }
  currentComponents.sort((a, b) => compareString(a.topicId, b.topicId));

  const topics: TopicRevisionTopic[] = [];
  for (const component of currentComponents) {
    if (component.memberCanonicalUrls.length < 2) continue;
    topics.push({
      topicId: component.topicId,
      memberCanonicalUrls: component.memberCanonicalUrls,
      metadata: buildMetadata(
        component.memberCanonicalUrls,
        visitsByCanonical,
        input.visitSimilarity.edges,
        cosineThreshold,
      ),
    });
  }
  topics.sort((a, b) => compareString(a.topicId, b.topicId));

  const lineage = await computeLineage(input.previousRevision, currentComponents, observedAt);
  const revisionId = await createTopicRevisionId({
    visitSimilarityRevisionId: input.visitSimilarity.revisionId,
    cosineThreshold,
    algorithmVersion,
  });

  return {
    revisionId,
    visitSimilarityRevisionId: input.visitSimilarity.revisionId,
    cosineThreshold,
    algorithmVersion,
    topics,
    lineage,
    producedAt,
  };
};
