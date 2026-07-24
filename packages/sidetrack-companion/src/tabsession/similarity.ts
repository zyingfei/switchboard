import type { ConnectionsSnapshot } from '../connections/types.js';
import type { ClosestVisitRanker } from '../connections/snapshot.js';
import { generateCandidates } from '../ranker/candidates.js';
import { classifyAggregatorPage } from '../ranker/aggregatorProfiles.js';
import { extractFeatures } from '../ranker/features.js';
import type { Candidate } from '../ranker/types.js';
import type { AcceptedEvent } from '../sync/causal.js';

export interface SimilarityEvidence {
  readonly workstreamId: string;
  readonly simTopScore: number;
  readonly simMeanScore: number;
  readonly simAgreement: number;
  readonly simMargin: number;
  readonly simMatchedTerms?: readonly string[];
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

// Content channels that indicate real topical similarity (as opposed to
// behavior + title/host/path "metadata" chrome). See visitSimilarity.ts.
const CONTENT_SIMILARITY_CHANNELS = [
  'contentVector',
  'contentTerms',
  'keyphrases',
  'entities',
  'chunkSupport',
] as const;

// Structural candidate sources the aggregator guard suppresses at generation
// time; a persisted ranker edge built solely from these is a chrome artifact.
const CHROME_ONLY_SUPPRESSED_SOURCES = new Set<string>([
  'same_repo_or_domain',
  'same_title_path_tokens',
]);

// The one candidate source derived from raw `visit_resembles_visit` edges
// regardless of channel — for an aggregator pair those edges are overwhelmingly
// chrome-only (behavior + metadata), so this source can't be trusted between
// two aggregator pages. Genuine content similarity arrives via the distinct
// `content_embedding_neighborhood` / `content_term_overlap` sources instead.
const CHROME_PRONE_AGGREGATOR_SOURCES = new Set<string>(['embedding_neighborhood']);

const urlWithinNodeId = (nodeIdOrUrl: string): string | null => {
  const match = nodeIdOrUrl.match(/https?:\/\/.+$/u);
  return match ? match[0] : null;
};

// True when the visit is ANY aggregator page (feed OR item), ignoring the
// item-narrowing. Both chrome-only drops (the freshly-generated
// embedding_neighborhood candidate drop AND the persisted-edge drop) key off
// this predicate, NOT a guarded/narrowed one:
//
//   - `embedding_neighborhood` candidates are generated DIRECTLY from persisted
//     `visit_resembles_visit` edges (candidates.ts embeddingNeighborhoodGenerator),
//     so they are chrome-derived by definition. Between any two aggregator
//     pages that source is a site-skeleton false-friend.
//   - A `title_only` resemblance edge between two aggregator pages is likewise
//     a skeleton artifact regardless of feed/item.
//
// Item pages still participate fully in content-level similarity: genuine
// content edges arrive via the DISTINCT content_embedding_neighborhood /
// content_term_overlap sources and content-channel (or non-title_only) persisted
// metadata, which are NEVER dropped by either loop. So narrowing item pages OUT
// of these drops buys nothing legitimate while it would resurrect the
// 2026-07-10 false-friend at scale (a narrowed item target is unguarded, so a
// guarded-predicate gate short-circuits and lets every raw neighbor through).
const isAnyAggregatorVisit = (nodeIdOrUrl: string): boolean => {
  const url = urlWithinNodeId(nodeIdOrUrl);
  if (url === null) return false;
  return classifyAggregatorPage(url) !== 'not-aggregator';
};

// A persisted similarity edge whose signal is chrome only: a
// resemblance/continues edge with no content channel (only behavior + the
// title/host/path "metadata" channel), or a closest_visit edge the ranker
// built solely from the suppressed structural sources. Between two aggregator
// pages such an edge is a site-skeleton false-friend, not topical similarity
// (7000+ such resemblance edges exist on a real vault, scored 0.8–0.99), so
// the resolver must not attribute from it.
const isChromeOnlySimilarityEdge = (
  metadata: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  const channels = metadata?.['channels'];
  if (channels !== null && typeof channels === 'object') {
    const record = channels as Record<string, unknown>;
    const hasContent = CONTENT_SIMILARITY_CHANNELS.some((key) => {
      const value = record[key];
      return typeof value === 'number' && value > 0;
    });
    return !hasContent;
  }
  const sources = metadata?.['candidateSources'];
  if (Array.isArray(sources) && sources.length > 0) {
    return sources.every(
      (source) => typeof source === 'string' && CHROME_ONLY_SUPPRESSED_SOURCES.has(source),
    );
  }
  // The DOMINANT real shape (measured: 100% of the live vault's 51,248
  // `visit_resembles_visit` edges) carries NEITHER `channels` NOR
  // `candidateSources` — it is a cosine-only payload
  // `{cosine, threshold, evidenceTier:'title_only', evidenceProducedAt, simZ}`
  // produced by the title-only similarity builder. That IS the site-skeleton
  // false-friend the guard exists to block: `evidenceTier:'title_only'` means
  // the pair matched on embedded title (shared "| Hacker News" chrome + host/
  // path skeleton, pre-clean-corpus) with no content channel behind it. Treat
  // it as chrome-only so the persisted-edge drop actually fires on the real
  // edges (the channels/candidateSources branches above only catch the rarer
  // ranker-built shapes). A content-backed edge carries a distinct
  // evidenceTier (metadata_only / content_backed / indexed_chunks) and/or a
  // content channel, so it is never dropped here.
  const evidenceTier = metadata?.['evidenceTier'];
  if (evidenceTier === 'title_only') return true;
  return false;
};

const scoreForEdge = (kind: string, metadata?: Readonly<Record<string, unknown>>): number => {
  if (kind === 'closest_visit') return 1;
  if (kind === 'visit_continues_visit') return 0.85;
  if (kind === 'visit_resembles_visit') {
    const score = metadata?.['score'] ?? metadata?.['cosine'] ?? metadata?.['similarity'];
    const confidence = metadata?.['confidence'];
    const normalizedScore = typeof score === 'number' && Number.isFinite(score) ? score : 0.7;
    const normalizedConfidence =
      typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 1;
    return Math.max(0, Math.min(1, normalizedScore * normalizedConfidence));
  }
  return 0;
};

const scoreForCandidateSources = (candidate: Candidate): number => {
  if (candidate.sources.includes('same_canonical_url')) return 0.9;
  if (candidate.sources.includes('opener_chain')) return 0.85;
  if (candidate.sources.includes('navigation_chain')) return 0.8;
  if (candidate.sources.includes('content_embedding_neighborhood')) return 0.75;
  if (candidate.sources.includes('content_term_overlap')) return 0.7;
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
  // Any-aggregator (feed OR item) target: BOTH chrome-only drops below stay in
  // force between two aggregator pages regardless of item-narrowing. An item
  // page is a content object, but its chrome-derived signals (raw embedding
  // neighborhood, title-only resemblance) are still site-skeleton false-friends
  // — its legitimate similarity flows through the content channels, which are
  // never dropped. See isAnyAggregatorVisit for why this is not gated on the
  // narrowed predicate.
  const targetIsAnyAggregator = [...canonicalTargetVisitNodeIds].some(isAnyAggregatorVisit);
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
  const matchedTermsByWorkstream = new Map<string, Set<string>>();
  const addScore = (
    workstreamId: string | undefined,
    score: number,
    matchedTerms: readonly string[] = [],
  ): void => {
    if (workstreamId === undefined || !Number.isFinite(score) || score <= 0) return;
    const list = byWorkstream.get(workstreamId) ?? [];
    list.push(Math.max(0, Math.min(1, score)));
    byWorkstream.set(workstreamId, list);
    if (matchedTerms.length > 0) {
      const terms = matchedTermsByWorkstream.get(workstreamId) ?? new Set<string>();
      for (const term of matchedTerms) terms.add(term);
      matchedTermsByWorkstream.set(workstreamId, terms);
    }
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
                extractFeatures(candidate, {
                  merged: [...events],
                  snapshot,
                  retrievalContext: { missingRetrievalContext: true },
                }),
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
      // Skip a chrome-derived neighbor between two aggregator pages (feed OR
      // item): the only basis is `embedding_neighborhood`, which is generated
      // DIRECTLY from persisted `visit_resembles_visit` edges (candidates.ts
      // embeddingNeighborhoodGenerator) — the exact chrome-resemblance edges
      // that caused the 2026-07-10 82% mis-file. This drop MUST use the
      // any-aggregator predicate, NOT `isGuardedAggregatorVisit`: with
      // item-narrowing ON, an item target is unguarded, so gating on the
      // guarded predicate would short-circuit and let every raw-neighbor
      // candidate through unfiltered (resurrecting the false-friend at scale).
      // Dropping this source between any two aggregator pages costs an item
      // NOTHING legitimate: genuine content similarity arrives via the distinct
      // `content_embedding_neighborhood` / `content_term_overlap` sources,
      // which carry other candidate sources and pass. Item pages attribute
      // from those content channels, never from the raw embedding neighborhood.
      if (
        targetIsAnyAggregator &&
        isAnyAggregatorVisit(candidateVisitKey) &&
        item.candidate.sources.every((source) => CHROME_PRONE_AGGREGATOR_SOURCES.has(source))
      ) {
        continue;
      }
      addScore(
        visitWorkstream.get(candidateVisitKey) ??
          visitWorkstream.get(visitNodeId(candidateVisitKey)),
        item.score,
      );
    }
  }

  for (const edge of snapshot.edges) {
    const score = scoreForEdge(edge.kind, edge.metadata);
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
    // Ignore a chrome-only persisted similarity edge between two aggregator
    // pages (site-skeleton false-friend; see isChromeOnlySimilarityEdge). This
    // stays in force for item pages too (any-aggregator predicate): a title-only
    // resemblance edge between two items is a skeleton artifact, not content
    // evidence. Content-backed edges carry a content channel and are never
    // dropped here, so narrowed item pages still attribute on their content.
    if (
      targetIsAnyAggregator &&
      isAnyAggregatorVisit(other) &&
      isChromeOnlySimilarityEdge(edge.metadata)
    ) {
      continue;
    }
    const matchedTerms = [
      ...(Array.isArray(edge.metadata?.['matchedTerms'])
        ? edge.metadata['matchedTerms'].filter((term): term is string => typeof term === 'string')
        : []),
      ...(Array.isArray(edge.metadata?.['matchedKeyphrases'])
        ? edge.metadata['matchedKeyphrases'].filter(
            (term): term is string => typeof term === 'string',
          )
        : []),
      ...(Array.isArray(edge.metadata?.['matchedEntities'])
        ? edge.metadata['matchedEntities'].filter(
            (term): term is string => typeof term === 'string',
          )
        : []),
    ];
    addScore(visitWorkstream.get(other), score, matchedTerms);
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
        ...((matchedTermsByWorkstream.get(workstreamId)?.size ?? 0) === 0
          ? {}
          : {
              simMatchedTerms: [...(matchedTermsByWorkstream.get(workstreamId) ?? [])]
                .sort()
                .slice(0, 5),
            }),
      };
    });
};
