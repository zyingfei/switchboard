// W5 Phase A — the incremental topic-revision builder.
//
// PHASE-B WIRING (to be done by the wave that lands after W1; do NOT
// add these edits in Phase A — connectionsMaterializer.ts is owned by
// another agent while Phase A is in flight):
//
//   1. Import in connectionsMaterializer.ts:
//        import {
//          buildIncrementalTopicRevision,
//        } from '../../connections/incrementalTopicRevision.js';
//        import { TOPIC_INCREMENTAL_REVISION_KEY } from '../../producers/topic-revision.js';
//
//   2. `topicRevisionBuilderFor` (line ~957) is keyed by TopicAlgorithmVersion
//      and has the uniform signature `(BuildTopicRevisionInput) =>
//      Promise<TopicRevision>`. buildIncrementalTopicRevision does NOT fit
//      that signature — it needs dirty-set/edge-diff/HNSW/lookup
//      dependencies a full-rebuild call site doesn't have. Adding
//      TOPIC_INCREMENTAL_REVISION_KEY to TOPIC_REVISION_KEYS (done in this
//      Phase A change, see producers/topic-revision.ts) makes that switch
//      NON-EXHAUSTIVE under noImplicitReturns — Phase B MUST add a case,
//      e.g.:
//        case TOPIC_INCREMENTAL_REVISION_KEY:
//          // Never reached via the uniform path — buildIncrementalTopicRevision
//          // is called directly from the drain (see point 3), the same way
//          // assignIncrementalMembership is today (not through this switch).
//          throw new Error('TOPIC_INCREMENTAL_REVISION_KEY is not built via topicRevisionBuilderFor');
//      before `bun run typecheck` is green again. (`bun test` is unaffected —
//      it does not run tsc — so this is a typecheck-only gap between Phase A
//      landing and Phase B wiring it up.)
//
//   3. Actual call site: replace (or flag-gate) the `useIncremental` branch
//      around line 5497-5561 (the `assignIncrementalMembership` overlay) with
//      a call to buildIncrementalTopicRevision, supplying:
//        - previousRevision: previousTopicRevision (must be
//          TOPIC_LEIDEN_CPM_REVISION_KEY or TOPIC_INCREMENTAL_REVISION_KEY —
//          i.e. built by leiden or by a prior incremental pass; the
//          content-hash id scheme make both bases valid).
//        - visitSimilarityRevisionId: visitSimilarity.revisionId.
//        - dirtyVisitKeys: collectTouchedVisits(dirtyScopes, pendingEventsForDrain)
//          (already computed for this drain, line ~6888).
//        - addedEdges/removedEdges: the per-drain visitSimilarity edge diff
//          (W1's survey cites "the per-drain edge diff" as already available;
//          if not yet materialized as a value, diff visitSimilarity.edges
//          against the edges implied by prevLeiden/previousTopicRevision's
//          visitSimilarityRevisionId — TODO for Phase B to locate the exact
//          existing diff, do not recompute a fresh O(N) diff every drain).
//        - getEligibleVisit: canonicalUrl => the TopicVisit if
//          focusedWindowMs > 0 (same gate as eligibleVisits() in
//          leidenCpmTopicRevision.ts), else null — backed by
//          topicVisitsForBuild / whatever per-visit index the drain already
//          holds (a Map, not a fresh O(N) scan).
//        - edgesForVisit: canonicalUrl => edges incident to that node from
//          visitSimilarity.edges — same requirement, back it with an index,
//          not a filter() over the full array per call.
//        - hnswStore: loadedHnswSimilarityStore.
//        - cosineThreshold: LEIDEN_CPM_COSINE_THRESHOLD (mirrors the
//          incremental-membership overlay's existing choice).
//      On `result.overflow !== null`: do NOT serve result.revision as a
//      "new" revision (it IS the previous revision, unchanged) — enqueue a
//      repair-queue entry for the dirty region per W3's demotion pattern
//      (`{scope, reason: 'topic-subgraph-cap-exceeded', ...}`) and log
//      result.topicSizeHistogram. On success, putActiveRevision +
//      putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, ...) the
//      same way the leiden-cpm branch does today (line ~5644-5670).
//
// ---------------------------------------------------------------------
//
// What this module does: replaces "re-run global leiden-cpm on a
// cadence" with local, bounded structural refinement plus a cheap
// primary-promotion fast path — the W5 design's two complementary
// mechanisms:
//
//   Step 1 (assignment, cheap, no leiden): every DIRTY visit key that is
//   not yet a member (primary or secondary) of any topic is offered to
//   Tier A (1-hop label propagation over similarity edges to a PRIMARY
//   member) / Tier B (HNSW vector fallback) — the SAME heuristic
//   assignIncrementalMembership uses (shared via
//   topicMembershipAssignment.ts, not duplicated). NEW in W5: a
//   candidate whose supportCount or score clears the promotion bar is
//   marked for PRIMARY membership (not just a secondary affiliation);
//   its target topic becomes "dirty" for Step 2. A candidate that
//   doesn't clear the bar keeps today's behaviour — attached as a
//   SECONDARY affiliation, no structural cost.
//
//   Step 2 (structure, bounded, DynaMo-style local leiden): the dirty
//   seed is (a) previous topics touching a changed similarity edge whose
//   BOTH endpoints are already-established primary members — an edge
//   disappearing inside a topic ⇒ possible split, one appearing between
//   two DIFFERENT topics ⇒ possible merge — (b) topics a Step-1
//   candidate got promoted into, and (c) topics containing a dirty visit
//   key that is ALREADY an established member (its own metadata changed,
//   independent of any edge delta). A changed edge with only ONE established
//   endpoint is deliberately NOT a structural trigger by itself: that's
//   exactly Step 1's cheap/no-leiden case, and pulling the candidate into
//   a leiden run would let plain cosineThreshold clearance smuggle it
//   into PRIMARY membership, bypassing the promotion bar entirely. Free
//   (topic-less) nodes only enter the subgraph via (d) a MUTUALLY-new
//   edge (both endpoints topic-less — the only way a wholly new topic
//   can be BORN, since Tier A never considers candidate-to-candidate
//   edges) or by being a promoted candidate. Any previous topic reachable
//   from that seed via a >= threshold edge (the "1-hop boundary") is
//   pulled in WHOLE — never partially — so a previous topic is always
//   either fully "dirty" (rebuilt) or fully "unaffected" (carried forward
//   byte-identical); there is no partial-
//   membership limbo. leidenCpmPartition (the exact pure partitioner the
//   full-rebuild producer uses) runs on that bounded subgraph only.
//   Results are merged back via assembleTopicRevisionFromGroups scoped to
//   just the dirty previous topics, so split/merge/birth/continue/death
//   lineage and content-hash topic ids come from the SAME code path the
//   full leiden-cpm rebuild uses — no bespoke identity logic.
//
//   Bound: if the closure's node count exceeds SIDETRACK_TOPIC_SUBGRAPH_CAP
//   (default 500), nothing is rebuilt this drain — the previous revision
//   is returned unchanged, with a typed overflow report + a topic-size
//   histogram entry so the caller (Phase B) can queue the region for
//   out-of-band repair instead of silently corrupting or freezing state.
//
// Deterministic: every Set is only ever consumed after sorting into an
// array; every merge/tie-break is lexicographic. 50 repeated runs on the
// same input produce byte-identical JSON (see
// incrementalTopicRevision.test.ts).

import {
  assembleTopicRevisionFromGroups,
  type TopicVisit,
  type VisitSimilarityEdge,
} from './topicClusterer.js';
import { buildClusterIndex } from './incrementalTopicMembership.js';
import { leidenCpmPartition } from './leidenCpm.js';
import {
  computeCandidateAssignments,
  type CandidateAssignment,
} from './topicMembershipAssignment.js';
import type { LoadedSimilarityHnswStore } from './visitSimilarityHnsw.js';
import {
  TOPIC_INCREMENTAL_REVISION_KEY,
  createTopicRevisionId,
  type TopicRevision,
  type TopicRevisionTopic,
  type TopicSecondaryAffiliation,
} from '../producers/topic-revision.js';

// -- env-tunable constants --------------------------------------------

export const TOPIC_PROMOTE_SUPPORT_ENV = 'SIDETRACK_TOPIC_PROMOTE_SUPPORT';
export const TOPIC_PROMOTE_MARGIN_ENV = 'SIDETRACK_TOPIC_PROMOTE_MARGIN';
export const TOPIC_SUBGRAPH_CAP_ENV = 'SIDETRACK_TOPIC_SUBGRAPH_CAP';

export const DEFAULT_TOPIC_PROMOTE_SUPPORT = 2;
export const DEFAULT_TOPIC_PROMOTE_MARGIN = 0.03;
export const DEFAULT_TOPIC_SUBGRAPH_CAP = 500;

const resolvePositiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const resolveNonNegativeFloatEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

export const resolveTopicPromoteSupport = (override?: number): number =>
  override ?? resolvePositiveIntEnv(TOPIC_PROMOTE_SUPPORT_ENV, DEFAULT_TOPIC_PROMOTE_SUPPORT);

export const resolveTopicPromoteMargin = (override?: number): number =>
  override ?? resolveNonNegativeFloatEnv(TOPIC_PROMOTE_MARGIN_ENV, DEFAULT_TOPIC_PROMOTE_MARGIN);

export const resolveTopicSubgraphCap = (override?: number): number =>
  override ?? resolvePositiveIntEnv(TOPIC_SUBGRAPH_CAP_ENV, DEFAULT_TOPIC_SUBGRAPH_CAP);

// -- input contract (Phase B fills these from the materializer's state) --

/**
 * Returns the current TopicVisit for a canonicalUrl if it is presently
 * ELIGIBLE (mirrors leidenCpmTopicRevision.ts's eligibleVisits gate:
 * focusedWindowMs > 0 and a non-empty canonicalUrl), else null. A null
 * return drops the node from the subgraph — this is how a visit that
 * lost eligibility (or was deleted) causes its old topic to shrink or
 * die. A lookup function (not a bulk array) so a caller backed by an
 * index never has to materialize the full corpus for a bounded local
 * refinement.
 */
export type EligibleVisitLookup = (canonicalUrl: string) => TopicVisit | null;

/**
 * Returns the current similarity edges incident to a canonicalUrl (both
 * directions, unfiltered by threshold — the builder applies
 * cosineThreshold itself). Mirrors incrementalTopicMembership.ts's
 * `edges: readonly VisitSimilarityEdge[]` dependency shape, but exposed
 * per-node so bounded subgraph expansion never has to scan the whole
 * corpus's edge list.
 */
export type SimilarityEdgesAccessor = (canonicalUrl: string) => readonly VisitSimilarityEdge[];

export interface BuildIncrementalTopicRevisionInput {
  /** The revision to refine. Must be a leiden-cpm or a prior incremental revision. */
  readonly previousRevision: TopicRevision;
  /** The CURRENT (whole-corpus) visit-similarity revision id — becomes TopicRevision.visitSimilarityRevisionId. */
  readonly visitSimilarityRevisionId: string;
  /** Visit keys touched this drain (new visits, metadata changes, membership-relevant events). */
  readonly dirtyVisitKeys: ReadonlySet<string>;
  /** Similarity edges that appeared since previousRevision was built. */
  readonly addedEdges: readonly VisitSimilarityEdge[];
  /** Similarity edges that disappeared since previousRevision was built. */
  readonly removedEdges: readonly VisitSimilarityEdge[];
  readonly getEligibleVisit: EligibleVisitLookup;
  readonly edgesForVisit: SimilarityEdgesAccessor;
  /** Persisted vector store for the Tier B fallback (null ⇒ Tier A only). */
  readonly hnswStore: LoadedSimilarityHnswStore | null;
  readonly cosineThreshold: number;
  readonly topK?: number;
  readonly producedAt?: number;
  /** Overridable for tests; production reads SIDETRACK_TOPIC_SUBGRAPH_CAP. */
  readonly subgraphCap?: number;
  /** Overridable for tests; production reads SIDETRACK_TOPIC_PROMOTE_SUPPORT. */
  readonly promoteSupport?: number;
  /** Overridable for tests; production reads SIDETRACK_TOPIC_PROMOTE_MARGIN. */
  readonly promoteMargin?: number;
}

export interface TopicSizeHistogramEntry {
  readonly topicId: string;
  readonly memberCount: number;
}

export interface IncrementalTopicRevisionOverflow {
  readonly reason: 'subgraph-cap-exceeded';
  readonly subgraphSize: number;
  readonly cap: number;
  /** Previous topic ids that were candidates for this drain's local refinement. */
  readonly dirtyTopicIds: readonly string[];
}

export interface BuildIncrementalTopicRevisionResult {
  readonly revision: TopicRevision;
  readonly overflow: IncrementalTopicRevisionOverflow | null;
  readonly topicSizeHistogram: readonly TopicSizeHistogramEntry[];
  readonly promotedCount: number;
  readonly secondaryCount: number;
}

// -- internals ----------------------------------------------------------

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedUnique = (values: Iterable<string>): readonly string[] =>
  [...new Set(values)].sort(compareString);

const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** Dedupe + sort edges deterministically (byte-identical output requires
 *  a fixed edge order feeding leidenCpmPartition's floating-point sums). */
const dedupeSortedEdges = (edges: readonly VisitSimilarityEdge[]): readonly VisitSimilarityEdge[] => {
  const byPair = new Map<string, VisitSimilarityEdge>();
  for (const edge of edges) {
    byPair.set(pairKey(edge.fromVisitKey, edge.toVisitKey), edge);
  }
  return [...byPair.values()].sort((left, right) => {
    const from = compareString(left.fromVisitKey, right.fromVisitKey);
    if (from !== 0) return from;
    return compareString(left.toVisitKey, right.toVisitKey);
  });
};

export const buildIncrementalTopicRevision = async (
  input: BuildIncrementalTopicRevisionInput,
): Promise<BuildIncrementalTopicRevisionResult> => {
  const { previousRevision, cosineThreshold } = input;
  const producedAt = input.producedAt ?? Date.now();
  const promoteSupport = resolveTopicPromoteSupport(input.promoteSupport);
  const promoteMargin = resolveTopicPromoteMargin(input.promoteMargin);
  const subgraphCap = resolveTopicSubgraphCap(input.subgraphCap);

  const previousTopicById = new Map<string, TopicRevisionTopic>();
  for (const topic of previousRevision.topics) previousTopicById.set(topic.topicId, topic);
  const { memberToTopic } = buildClusterIndex(previousRevision);

  // -- Step 1: assignment (Tier A / Tier B, no leiden) -------------------
  // Candidates = dirty visits not yet a PRIMARY member of any topic.
  // (A dirty visit that's already a SECONDARY affiliation elsewhere is
  // still eligible here — this is how a previously-secondary node gets
  // reconsidered for promotion once it accrues more support.)
  const dirtyCandidates = sortedUnique(
    [...input.dirtyVisitKeys].filter((key) => key.length > 0),
  ).filter((key) => memberToTopic.get(key) === undefined);
  const candidateEdgesByPair = new Map<string, VisitSimilarityEdge>();
  for (const key of dirtyCandidates) {
    for (const edge of input.edgesForVisit(key)) {
      candidateEdgesByPair.set(pairKey(edge.fromVisitKey, edge.toVisitKey), edge);
    }
  }
  const assignments = await computeCandidateAssignments({
    candidates: dirtyCandidates,
    memberToTopic,
    edges: [...candidateEdgesByPair.values()],
    hnswStore: input.hnswStore,
    cosineThreshold,
    ...(input.topK === undefined ? {} : { topK: input.topK }),
  });

  const promoted: CandidateAssignment[] = [];
  const secondaryOnly: CandidateAssignment[] = [];
  for (const assignment of assignments) {
    const promotable =
      assignment.supportCount >= promoteSupport || assignment.score >= cosineThreshold + promoteMargin;
    if (promotable) {
      promoted.push(assignment);
    } else {
      secondaryOnly.push(assignment);
    }
  }

  // -- Step 2: dirty-topic seeding ---------------------------------------
  // A changed edge is a STRUCTURAL trigger only when BOTH endpoints are
  // already-established primary members (an edge inside a topic
  // disappearing ⇒ possible split; an edge appearing between two
  // DIFFERENT topics ⇒ possible merge). An edge with one unplaced
  // endpoint is Step 1's domain (assignment/promotion) — it must NOT
  // by itself drag an established topic through a structural rebuild;
  // without this restriction leidenCpmPartition would happily fold in
  // any candidate that merely clears cosineThreshold, silently
  // bypassing the promotion bar (supportCount/margin) entirely. A
  // candidate only enters the structural subgraph if Step 1 actually
  // promoted it (below).
  const dirtyTopicIds = new Set<string>();
  for (const edge of [...input.addedEdges, ...input.removedEdges]) {
    const fromTopic = memberToTopic.get(edge.fromVisitKey);
    const toTopic = memberToTopic.get(edge.toVisitKey);
    if (fromTopic === undefined || toTopic === undefined) continue;
    dirtyTopicIds.add(fromTopic);
    dirtyTopicIds.add(toTopic);
  }
  // A dirty visit key that's ALREADY an established primary member
  // (e.g. its own metadata changed — engagement crossed a threshold,
  // title updated — with no edge delta at all) still needs its topic
  // re-verified. This is independent of the edge-based trigger above.
  for (const key of input.dirtyVisitKeys) {
    const topicId = memberToTopic.get(key);
    if (topicId !== undefined) dirtyTopicIds.add(topicId);
  }
  for (const assignment of promoted) dirtyTopicIds.add(assignment.topicId);

  // Free (topic-less) seed nodes: only a MUTUALLY-unplaced edge (both
  // endpoints new) is a birth signal worth structurally examining — Tier
  // A never considers candidate-to-candidate edges, so this is the only
  // path a wholly new topic can ever form. A promoted candidate also
  // joins as a free node (its target topic is already dirty above; the
  // node itself must be present in the subgraph for leiden to place it).
  const freeSeedNodes = new Set<string>();
  for (const edge of [...input.addedEdges, ...input.removedEdges]) {
    const fromTopic = memberToTopic.get(edge.fromVisitKey);
    const toTopic = memberToTopic.get(edge.toVisitKey);
    if (fromTopic !== undefined || toTopic !== undefined) continue;
    freeSeedNodes.add(edge.fromVisitKey);
    freeSeedNodes.add(edge.toVisitKey);
  }
  for (const assignment of promoted) freeSeedNodes.add(assignment.canonicalUrl);

  // subgraphMembers: full membership of every dirty topic (never
  // partial) + free/new seed nodes, filtered to currently-ELIGIBLE
  // visits only (an ineligible ex-member is dropped, shrinking/killing
  // its old topic rather than silently keeping stale membership).
  const subgraphMembers = new Set<string>();
  for (const topicId of dirtyTopicIds) {
    for (const member of previousTopicById.get(topicId)?.memberCanonicalUrls ?? []) {
      if (input.getEligibleVisit(member) !== null) subgraphMembers.add(member);
    }
  }
  for (const node of freeSeedNodes) {
    if (input.getEligibleVisit(node) !== null) subgraphMembers.add(node);
  }

  // 1-hop boundary: nodes reachable from subgraphMembers via a
  // >= threshold edge. Any boundary node that belongs to a previous
  // topic NOT already dirty pulls that topic in WHOLE (one additional
  // pass, not a recursive closure) — this is what keeps "unaffected
  // previous topics untouched" actually true: a topic is never left
  // with only some of its members reassigned out from under it.
  const boundary = new Set<string>();
  for (const member of subgraphMembers) {
    for (const edge of input.edgesForVisit(member)) {
      if (edge.cosine < cosineThreshold) continue;
      const other = edge.fromVisitKey === member ? edge.toVisitKey : edge.fromVisitKey;
      if (other.length === 0 || subgraphMembers.has(other)) continue;
      boundary.add(other);
    }
  }

  const boundaryOwningTopics = new Set<string>();
  for (const node of boundary) {
    const topicId = memberToTopic.get(node);
    if (topicId !== undefined && !dirtyTopicIds.has(topicId)) boundaryOwningTopics.add(topicId);
  }
  for (const topicId of boundaryOwningTopics) {
    dirtyTopicIds.add(topicId);
    for (const member of previousTopicById.get(topicId)?.memberCanonicalUrls ?? []) {
      if (input.getEligibleVisit(member) !== null) subgraphMembers.add(member);
    }
  }
  for (const node of boundary) {
    // Free strangers (no owning topic) join as bare candidate nodes —
    // eligible only, never pulled further (bounded to this one hop).
    if (memberToTopic.get(node) === undefined && input.getEligibleVisit(node) !== null) {
      subgraphMembers.add(node);
    }
  }

  const subgraphSize = subgraphMembers.size;
  if (subgraphSize > subgraphCap) {
    const histogram: TopicSizeHistogramEntry[] = [
      { topicId: 'overflow:pending-repair', memberCount: subgraphSize },
    ];
    return {
      revision: previousRevision,
      overflow: {
        reason: 'subgraph-cap-exceeded',
        subgraphSize,
        cap: subgraphCap,
        dirtyTopicIds: [...dirtyTopicIds].sort(compareString),
      },
      topicSizeHistogram: histogram,
      promotedCount: 0,
      secondaryCount: 0,
    };
  }

  // -- Step 2: structural refinement (leiden on the bounded subgraph) ---
  const subgraphNodes = [...subgraphMembers].sort(compareString);
  const subgraphEdgesRaw: VisitSimilarityEdge[] = [];
  for (const member of subgraphMembers) {
    for (const edge of input.edgesForVisit(member)) {
      if (edge.cosine < cosineThreshold) continue;
      if (!subgraphMembers.has(edge.fromVisitKey) || !subgraphMembers.has(edge.toVisitKey)) continue;
      subgraphEdgesRaw.push(edge);
    }
  }
  const subgraphEdges = dedupeSortedEdges(subgraphEdgesRaw);

  const groups =
    subgraphNodes.length === 0 ? [] : leidenCpmPartition(subgraphNodes, subgraphEdges);

  const visitsByCanonical = new Map<string, TopicVisit>();
  for (const node of subgraphNodes) {
    const visit = input.getEligibleVisit(node);
    if (visit !== null) visitsByCanonical.set(node, visit);
  }

  const dirtyPreviousTopics = [...dirtyTopicIds]
    .map((topicId) => previousTopicById.get(topicId))
    .filter((topic): topic is TopicRevisionTopic => topic !== undefined)
    .sort((a, b) => compareString(a.topicId, b.topicId));

  const dirtyAssembled = await assembleTopicRevisionFromGroups({
    groups,
    visitsByCanonical,
    visitSimilarity: { revisionId: input.visitSimilarityRevisionId, edges: subgraphEdges },
    previousRevision: { ...previousRevision, topics: dirtyPreviousTopics },
    cosineThreshold,
    algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
    producedAt,
  });

  // -- merge back: unaffected previous topics + freshly-assembled dirty region --
  const unaffectedTopics = previousRevision.topics.filter((topic) => !dirtyTopicIds.has(topic.topicId));

  // Best-effort re-home of Step-1 secondary-only assignments: if the
  // original target topic survived untouched, attach there; if it was
  // (also) restructured, follow any surviving original member into its
  // new topic; if the topic died entirely, drop the affiliation rather
  // than invent one (matches assignIncrementalMembership's philosophy).
  const finalMemberToTopic = new Map<string, string>();
  for (const topic of unaffectedTopics) {
    for (const member of topic.memberCanonicalUrls) finalMemberToTopic.set(member, topic.topicId);
  }
  for (const topic of dirtyAssembled.topics) {
    for (const member of topic.memberCanonicalUrls) finalMemberToTopic.set(member, topic.topicId);
  }

  const secondaryByFinalTopic = new Map<string, CandidateAssignment[]>();
  for (const assignment of secondaryOnly) {
    let targetTopicId: string | undefined = assignment.topicId;
    if (dirtyTopicIds.has(assignment.topicId)) {
      const survivors = previousTopicById.get(assignment.topicId)?.memberCanonicalUrls ?? [];
      targetTopicId = survivors.map((m) => finalMemberToTopic.get(m)).find((id) => id !== undefined);
    }
    if (targetTopicId === undefined) continue;
    const list = secondaryByFinalTopic.get(targetTopicId) ?? [];
    list.push(assignment);
    secondaryByFinalTopic.set(targetTopicId, list);
  }

  const applySecondary = (topic: TopicRevisionTopic): TopicRevisionTopic => {
    const additions = secondaryByFinalTopic.get(topic.topicId);
    if (additions === undefined || additions.length === 0) return topic;
    const existing = topic.secondaryAffiliations ?? [];
    const alreadyPresent = new Set(existing.map((a) => a.canonicalUrl));
    const newOnes: TopicSecondaryAffiliation[] = additions
      .filter((a) => !alreadyPresent.has(a.canonicalUrl))
      .map((assignment) => ({
        canonicalUrl: assignment.canonicalUrl,
        score: assignment.score,
        reasons: [assignment.reason],
        supportCount: assignment.supportCount,
        maxCosine: assignment.score,
        lexicalScore: 0,
        reciprocalSupport: 0,
      }));
    if (newOnes.length === 0) return topic;
    const merged = [...existing, ...newOnes].sort((a, b) =>
      compareString(a.canonicalUrl, b.canonicalUrl),
    );
    return { ...topic, secondaryAffiliations: merged };
  };

  const finalTopics = [...unaffectedTopics.map(applySecondary), ...dirtyAssembled.topics.map(applySecondary)].sort(
    (a, b) => compareString(a.topicId, b.topicId),
  );

  const revisionId = await createTopicRevisionId({
    visitSimilarityRevisionId: input.visitSimilarityRevisionId,
    cosineThreshold,
    algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
  });

  const revision: TopicRevision = {
    revisionId,
    visitSimilarityRevisionId: input.visitSimilarityRevisionId,
    cosineThreshold,
    algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
    topics: finalTopics,
    lineage: dirtyAssembled.lineage,
    producedAt,
  };

  const topicSizeHistogram: TopicSizeHistogramEntry[] = dirtyAssembled.topics.map((topic) => ({
    topicId: topic.topicId,
    memberCount: topic.memberCanonicalUrls.length,
  }));

  return {
    revision,
    overflow: null,
    topicSizeHistogram,
    promotedCount: promoted.length,
    secondaryCount: secondaryOnly.length,
  };
};
