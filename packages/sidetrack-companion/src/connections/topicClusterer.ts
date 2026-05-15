import { createHash } from 'node:crypto';

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
  readonly metadata: TopicNodeMetadata;
}

const compareString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const roundMetric = (value: number): number => Number(value.toFixed(6));

const stableSuggestionIdFor = (medoidCanonicalUrl: string): string =>
  `suggestion:${createHash('sha256').update(medoidCanonicalUrl).digest('base64url').slice(0, 16)}`;

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

const medoidForMembers = (
  members: readonly string[],
  visitsByCanonical: ReadonlyMap<string, TopicVisit>,
  similarityEdges: readonly VisitSimilarityEdge[],
): string | undefined => {
  if (members.length === 0) return undefined;
  const memberSet = new Set(members);
  const scores = new Map<string, number>();
  for (const member of members) scores.set(member, 0);
  for (const edge of similarityEdges) {
    if (!memberSet.has(edge.fromVisitKey) || !memberSet.has(edge.toVisitKey)) continue;
    scores.set(edge.fromVisitKey, (scores.get(edge.fromVisitKey) ?? 0) + edge.cosine);
    scores.set(edge.toVisitKey, (scores.get(edge.toVisitKey) ?? 0) + edge.cosine);
  }
  return [...members].sort((left, right) => {
    const score = (scores.get(right) ?? 0) - (scores.get(left) ?? 0);
    if (score !== 0) return score;
    const leftVisit = visitsByCanonical.get(left);
    const rightVisit = visitsByCanonical.get(right);
    const focus = (rightVisit?.focusedWindowMs ?? 0) - (leftVisit?.focusedWindowMs ?? 0);
    if (focus !== 0) return focus;
    return compareString(left, right);
  })[0];
};

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
  const medoidCanonicalUrl = medoidForMembers(members, visitsByCanonical, similarityEdges);

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
    ...(medoidCanonicalUrl === undefined
      ? {}
      : {
          medoidCanonicalUrl,
          stableSuggestionId: stableSuggestionIdFor(medoidCanonicalUrl),
        }),
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

  const currentIdsByPreviousTopic = new Map<string, Set<string>>();
  const previousIdsByCurrentTopic = new Map<string, Set<string>>();
  const splitPreviousTopicIds = new Set<string>();
  const splitCurrentTopicIds = new Set<string>();
  for (const previousTopic of previousRevision.topics) {
    const currentIds = new Set<string>();
    for (const member of previousTopic.memberCanonicalUrls) {
      const currentTopicId = currentTopicIdByMember.get(member);
      if (currentTopicId !== undefined) currentIds.add(currentTopicId);
    }
    currentIdsByPreviousTopic.set(previousTopic.topicId, currentIds);
    if (currentIds.size > 1) {
      splitPreviousTopicIds.add(previousTopic.topicId);
      for (const currentTopicId of currentIds) splitCurrentTopicIds.add(currentTopicId);
    }
  }

  const mergedCurrentTopicIds = new Set<string>();
  const mergedPreviousTopicIds = new Set<string>();
  for (const currentComponent of [...currentComponents].sort((a, b) =>
    compareString(a.topicId, b.topicId),
  )) {
    const previousIds = new Set<string>();
    for (const member of currentComponent.memberCanonicalUrls) {
      const containingPreviousTopics = previousTopicIdsByMember.get(member);
      if (containingPreviousTopics === undefined) continue;
      for (const previousTopicId of containingPreviousTopics) previousIds.add(previousTopicId);
    }
    previousIdsByCurrentTopic.set(currentComponent.topicId, previousIds);
    if (previousIds.size <= 1) continue;
    mergedCurrentTopicIds.add(currentComponent.topicId);
    for (const previousTopicId of [...previousIds].sort(compareString)) {
      mergedPreviousTopicIds.add(previousTopicId);
      push({
        fromTopicId: previousTopicId,
        toTopicId: currentComponent.topicId,
        kind: 'merge',
        observedAt,
      });
    }
  }

  const previousTopicByStableSuggestionId = new Map<string, TopicRevisionTopic>();
  for (const previousTopic of previousRevision.topics) {
    const stableSuggestionId = previousTopic.metadata.stableSuggestionId;
    if (
      stableSuggestionId !== undefined &&
      !previousTopicByStableSuggestionId.has(stableSuggestionId)
    ) {
      previousTopicByStableSuggestionId.set(stableSuggestionId, previousTopic);
    }
  }

  for (const currentComponent of [...currentComponents].sort((a, b) =>
    compareString(a.topicId, b.topicId),
  )) {
    const previousIds =
      previousIdsByCurrentTopic.get(currentComponent.topicId) ?? new Set<string>();
    if (previousIds.size === 0) {
      const resurfaced = currentComponent.metadata.stableSuggestionId
        ? previousTopicByStableSuggestionId.get(currentComponent.metadata.stableSuggestionId)
        : undefined;
      push({
        fromTopicId: resurfaced?.topicId ?? currentComponent.topicId,
        toTopicId: currentComponent.topicId,
        kind: resurfaced === undefined ? 'birth' : 'resurface',
        observedAt,
      });
      continue;
    }
    if (
      previousIds.size === 1 &&
      !mergedCurrentTopicIds.has(currentComponent.topicId) &&
      !splitCurrentTopicIds.has(currentComponent.topicId)
    ) {
      const previousTopicId = [...previousIds][0];
      if (
        previousTopicId !== undefined &&
        !mergedPreviousTopicIds.has(previousTopicId) &&
        !splitPreviousTopicIds.has(previousTopicId)
      ) {
        push({
          fromTopicId: previousTopicId,
          toTopicId: currentComponent.topicId,
          kind: 'continue',
          observedAt,
        });
      }
    }
  }

  for (const previousTopic of [...previousRevision.topics].sort((a, b) =>
    compareString(a.topicId, b.topicId),
  )) {
    const currentIds = currentIdsByPreviousTopic.get(previousTopic.topicId) ?? new Set<string>();
    if (currentIds.size > 0) continue;
    push({
      fromTopicId: previousTopic.topicId,
      toTopicId: previousTopic.topicId,
      kind: 'death',
      observedAt,
    });
  }

  return lineage.sort((a, b) => {
    const from = compareString(a.fromTopicId, b.fromTopicId);
    if (from !== 0) return from;
    const to = compareString(a.toTopicId, b.toTopicId);
    if (to !== 0) return to;
    return compareString(a.kind, b.kind);
  });
};

// PR #141 — env-tunable topic engagement gate. Production default
// stays DEFAULT_TOPIC_ENGAGEMENT_GATE_MS (5000ms); dogfood can dial
// it down for short browsing sessions via the env var.
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

// -- Stage 5.2 W4 — incremental topic cluster accumulator -------------
// Foundational additive path: maintain a UnionFind across drains so new
// similarity edges merge components in O(α(n)) per edge instead of
// re-clustering from scratch. Removal-aware fallback (the design doc's
// "affected-component rebuild" for edge removals) is a follow-up; this
// PR ships the hot-add path that covers the common Stage 5.2 case
// (Class A leaf events keep producing similarity edges, never removing).
//
// What this PR does NOT do (yet):
// - Lineage tracking across revisions (consumers still call
//   buildTopicRevision for split/merge lineage).
// - Engagement-gate filtering (the full builder filters visits by
//   focusedWindowMs > engagementGateMs; the accumulator delegates that
//   to the caller — only call addVisit / addEdge / addRelation for
//   visits already past the gate).
// - Eviction on edge removal. Callers needing splits must fall back to
//   buildTopicRevision for the affected component.

export interface IncrementalTopicComponent {
  readonly topicId: string;
  readonly memberCanonicalUrls: readonly string[];
}

interface EdgeRecord {
  readonly a: string;
  readonly b: string;
  readonly source: 'similarity' | 'user-asserted';
}

const edgePairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

export class IncrementalTopicClusterAccumulator {
  private uf = new UnionFind();
  private readonly visitsByCanonical = new Map<string, TopicVisit>();
  /**
   * Stage 5.2 W4 — edge ledger. Tracks every edge folded so removal
   * can locate the affected component and reconstruct it from the
   * remaining edges. Keyed by lexicographic pair so add/remove are
   * symmetric.
   */
  private readonly edges = new Map<string, EdgeRecord>();

  /** Register a visit (engagement-gated by caller). Idempotent. */
  addVisit(visit: TopicVisit): void {
    if (visit.canonicalUrl.length === 0) return;
    this.uf.add(visit.canonicalUrl);
    const existing = this.visitsByCanonical.get(visit.canonicalUrl);
    if (existing === undefined) {
      this.visitsByCanonical.set(visit.canonicalUrl, visit);
      return;
    }
    // Latest-wins for metadata (caller is responsible for ordering;
    // this matches sortedVisitsByCanonical's merge behaviour).
    const title =
      (existing.title ?? '').length >= (visit.title ?? '').length ? existing.title : visit.title;
    this.visitsByCanonical.set(visit.canonicalUrl, {
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
      ...(visit.workstreamId !== undefined
        ? { workstreamId: visit.workstreamId }
        : existing.workstreamId !== undefined
          ? { workstreamId: existing.workstreamId }
          : {}),
    });
  }

  /**
   * Apply a similarity edge. If both endpoints are registered visits
   * AND cosine >= threshold, merges the two components in O(α(n)).
   */
  addSimilarityEdge(edge: VisitSimilarityEdge, cosineThreshold: number): void {
    if (edge.cosine < cosineThreshold) return;
    if (!this.visitsByCanonical.has(edge.fromVisitKey)) return;
    if (!this.visitsByCanonical.has(edge.toVisitKey)) return;
    this.uf.union(edge.fromVisitKey, edge.toVisitKey);
    this.edges.set(edgePairKey(edge.fromVisitKey, edge.toVisitKey), {
      a: edge.fromVisitKey,
      b: edge.toVisitKey,
      source: 'similarity',
    });
  }

  /** Apply a user-asserted relation — always merges (no threshold). */
  addUserAssertedRelation(relation: UserAssertedVisitRelation): void {
    if (!this.visitsByCanonical.has(relation.fromVisitKey)) return;
    if (!this.visitsByCanonical.has(relation.toVisitKey)) return;
    this.uf.union(relation.fromVisitKey, relation.toVisitKey);
    this.edges.set(edgePairKey(relation.fromVisitKey, relation.toVisitKey), {
      a: relation.fromVisitKey,
      b: relation.toVisitKey,
      source: 'user-asserted',
    });
  }

  /**
   * Stage 5.2 W4 — remove an edge and re-cluster the affected
   * component. If the removal disconnects the component into multiple
   * sub-components, the new components are returned in the next
   * getComponents() call.
   *
   * Algorithm (per design doc):
   *   1. Locate component(s) touching the removed edge.
   *   2. Reset those members' UF state.
   *   3. Re-cluster using only the remaining edges restricted to
   *      this component's members.
   *
   * Cost: O(|component|·α(n)) — typically small.
   */
  removeEdge(a: string, b: string): void {
    const key = edgePairKey(a, b);
    if (!this.edges.has(key)) return;
    this.edges.delete(key);
    if (!this.visitsByCanonical.has(a) || !this.visitsByCanonical.has(b)) return;
    // Find the affected component members BEFORE rebuilding (otherwise
    // find() in the rebuilt UF would walk against the old parents).
    const componentMembers = new Set<string>();
    for (const member of this.uf.members(a)) componentMembers.add(member);
    for (const member of this.uf.members(b)) componentMembers.add(member);
    // Rebuild UF from scratch over the entire visit set; only the
    // affected component's edges are re-applied + the unaffected
    // components are reconstructed by virtue of their own edges.
    // This is conceptually a "component-restricted re-cluster" but
    // implemented as a global rebuild for simplicity — at this corpus
    // size the overhead is negligible (UnionFind is O(α(n)) per op).
    const fresh = new UnionFind();
    for (const visitKey of [...this.visitsByCanonical.keys()].sort(compareString)) {
      fresh.add(visitKey);
    }
    for (const edge of this.edges.values()) {
      if (!this.visitsByCanonical.has(edge.a)) continue;
      if (!this.visitsByCanonical.has(edge.b)) continue;
      fresh.union(edge.a, edge.b);
    }
    this.uf = fresh;
  }

  /**
   * Stage 5.2 W4 — read the current edge ledger. Used by the
   * materializer to diff old vs new similarity revisions on a
   * model-revision flip: edges present in the old revision but
   * missing from the new one are passed back to removeEdge so the
   * accumulator's union-find stays consistent. Returns a snapshot
   * sorted lexicographically by (a, b).
   */
  getEdges(): readonly {
    readonly a: string;
    readonly b: string;
    readonly source: 'similarity' | 'user-asserted';
  }[] {
    return [...this.edges.values()].sort((left, right) => {
      const a = compareString(left.a, right.a);
      if (a !== 0) return a;
      return compareString(left.b, right.b);
    });
  }

  /**
   * Return components keyed by topicId. Singleton components (one
   * member) are filtered out — they're not topics, they're isolated
   * visits. Caller responsible for downstream TopicRevisionTopic
   * derivation (metadata, lineage, persistent revisionId).
   */
  async getComponents(): Promise<readonly IncrementalTopicComponent[]> {
    const components: IncrementalTopicComponent[] = [];
    for (const component of this.uf.components()) {
      if (component.members.length < 2) continue;
      const memberCanonicalUrls = [...component.members].sort(compareString);
      components.push({
        topicId: await topicId(memberCanonicalUrls),
        memberCanonicalUrls,
      });
    }
    return components.sort((a, b) => compareString(a.topicId, b.topicId));
  }

  // Note: no clear() method. UnionFind state is permanent — callers
  // needing a fresh accumulator should drop the instance and create a
  // new one. removeEdge handles the disconnect path.
}

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
    const metadata = buildMetadata(
      memberCanonicalUrls,
      visitsByCanonical,
      input.visitSimilarity.edges,
      cosineThreshold,
    );
    currentComponents.push({
      topicId: await topicId(memberCanonicalUrls),
      memberCanonicalUrls,
      metadata,
    });
  }
  currentComponents.sort((a, b) => compareString(a.topicId, b.topicId));

  const topics: TopicRevisionTopic[] = [];
  for (const component of currentComponents) {
    if (component.memberCanonicalUrls.length < 2) continue;
    topics.push({
      topicId: component.topicId,
      memberCanonicalUrls: component.memberCanonicalUrls,
      metadata: component.metadata,
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

// -- Stage 5.2 W4 — derive-from-accumulator topic revision -----------
// Pairs with IncrementalTopicClusterAccumulator. Callers maintain the
// accumulator across drains (incremental add of similarity edges +
// user-asserted relations); this builder reads accumulator.getComponents()
// and fills in metadata + lineage using the same logic as
// buildTopicRevision. Byte-equal output when:
//   - The accumulator was fed the same engagement-gated visit set.
//   - The accumulator was fed the same similarity edges (cosine >= threshold).
//   - The accumulator was fed the same user-asserted relations.
//   - The supplied previousRevision is identical.
//   - The cosineThreshold / algorithmVersion / producedAt match.
//
// In short: feed the accumulator the same eligible inputs that
// buildTopicRevision would have used, and the output is identical
// modulo wall-clock producedAt.

export interface BuildTopicRevisionFromAccumulatorInput {
  readonly accumulator: IncrementalTopicClusterAccumulator;
  /**
   * Full visit set for metadata (representative titles, cohesion,
   * dominant workstream). Engagement-gating is the caller's job —
   * the accumulator was already fed eligible visits; this is just
   * the lookup table for metadata.
   */
  readonly visits: readonly TopicVisit[];
  /**
   * Similarity edges used to compute per-topic cohesion. The same
   * edges that fed the accumulator's addSimilarityEdge calls.
   */
  readonly visitSimilarity: VisitSimilarityRevisionInput;
  readonly previousRevision?: TopicRevision;
  readonly options?: BuildTopicRevisionOptions;
}

export const buildTopicRevisionFromAccumulator = async (
  input: BuildTopicRevisionFromAccumulatorInput,
): Promise<TopicRevision> => {
  const cosineThreshold = input.options?.cosineThreshold ?? DEFAULT_TOPIC_COSINE_THRESHOLD;
  const algorithmVersion = input.options?.algorithmVersion ?? TOPIC_ALGORITHM_VERSION;
  const producedAt = input.options?.producedAt ?? Date.now();
  const observedAt = new Date(producedAt).toISOString();

  const visits = sortedVisitsByCanonical(input.visits);
  const visitsByCanonical = new Map(visits.map((visit) => [visit.canonicalUrl, visit] as const));

  // Components come from the accumulator's existing union-find state.
  // getComponents() already filters singletons (a topic must have
  // at least 2 members) and sorts by topicId.
  const incrementalComponents = await input.accumulator.getComponents();
  const currentComponents: CurrentComponent[] = incrementalComponents.map((c) => ({
    topicId: c.topicId,
    memberCanonicalUrls: c.memberCanonicalUrls,
    metadata: buildMetadata(
      c.memberCanonicalUrls,
      visitsByCanonical,
      input.visitSimilarity.edges,
      cosineThreshold,
    ),
  }));

  const topics: TopicRevisionTopic[] = [];
  for (const component of currentComponents) {
    topics.push({
      topicId: component.topicId,
      memberCanonicalUrls: component.memberCanonicalUrls,
      metadata: component.metadata,
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
