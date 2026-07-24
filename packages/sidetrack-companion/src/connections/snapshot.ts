import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ANNOTATION_CREATED, isAnnotationCreatedPayload } from '../annotations/events.js';
import {
  classifyCrossReplicaContinuations,
  continuationEdgeForPrediction,
} from '../continuation/classifier.js';
import {
  DISPATCH_LINKED,
  DISPATCH_RECORDED,
  isDispatchLinkedPayload,
  isDispatchRecordedPayload,
} from '../dispatches/events.js';
import { createRevision } from '../domain/ids.js';
import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import {
  buildCrossReplicaMaterialization,
  replicaIdFromNodeId,
  type CrossReplicaMaterialization,
} from '../materializers/cross-replica.js';
import {
  NAVIGATION_COMMITTED,
  isNavigationCommittedPayload,
  type NavigationCommittedPayload,
} from '../navigation/events.js';
import {
  DEFAULT_TOPIC_WORKSTREAM_SHARE_THRESHOLD,
  type TopicNodeMetadata,
  type TopicRevision,
  type TopicRevisionTopic,
  type TopicSecondaryAffiliation,
} from '../producers/topic-revision.js';
import { QUEUE_CREATED, isQueueCreatedPayload } from '../queue/events.js';
import type {
  PageEvidenceRecord,
  PageEvidenceSimilarityMetadata,
} from '../page-evidence/types.js';
import { CAPTURE_RECORDED, isCaptureRecordedPayload } from '../recall/events.js';
import { generateCandidates } from '../ranker/candidates.js';
import { FEATURE_SCHEMA_VERSION, type CandidatePairFeatures } from '../ranker/feature-schema.js';
import { extractFeatures } from '../ranker/features.js';
import type { Candidate, CandidateSource } from '../ranker/types.js';
import { projectSnippetLineage } from '../snippets/projection.js';
import type { AcceptedEvent, RegisterProjection } from '../sync/causal.js';
import type { MaterializerProgress } from '../sync/contract/materializerProgress.js';
import { scopesForGraphRows, type Scope } from '../sync/contract/connectionsScopes.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import {
  foldEventIntoTabSessionProjectionAccumulator,
  serializeTabSessionProjection,
  tabSessionProjectionAccumulatorFromSerialized,
  tabSessionProjectionFromAccumulator,
  type SerializedTabSessionProjectionAccumulator,
  type SerializedTabSessionProjection,
  type TabSessionRecord,
  type TabSessionProjection,
} from '../tabsession/projection.js';
import {
  foldEventIntoUrlProjectionAccumulator,
  serializeUrlProjection,
  type SerializedUrlProjectionAccumulator,
  type SerializedUrlProjection,
  type UrlAttribution,
  type UrlPageEvidenceSummary,
  type UrlProjection,
  type UrlVisitRecord,
  urlProjectionAccumulatorFromSerialized,
  urlProjectionFromAccumulator,
} from '../urls/projection.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
  isThreadStatusPayload,
  isThreadUpsertedPayload,
} from '../threads/events.js';
import { projectThread } from '../threads/projection.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  isBrowserTimelineObservedPayload,
  type TimelineTransition,
} from '../timeline/events.js';
import type { TimelineDayProjection } from '../timeline/projection.js';
import { detectSearchUrl } from '../timeline/sanitize.js';
import { VISUAL_FINGERPRINT_OBSERVED } from '../visual/events.js';
import { projectVisualFingerprints } from '../visual/projection.js';
import {
  WORKSTREAM_DELETED,
  WORKSTREAM_UPSERTED,
  isWorkstreamDeletedPayload,
  isWorkstreamUpsertedPayload,
} from '../workstreams/events.js';
import { projectWorkstream } from '../workstreams/projection.js';
import type { EngagementClassRevision } from './engagementClassifier.js';
import { findThreadQuotes, type ThreadText } from './quoteIndex.js';
import { anisotropyZScore } from './visitSimilarity.js';
import {
  edgeIdFor,
  nodeIdFor,
  type ConnectionEdge,
  type ConnectionEdgeKind,
  type ConnectionNode,
  type ConnectionNodeKind,
  type ConnectionNodeMetadata,
  type ConnectionsSnapshot,
  type ConnectionsSnapshotScope,
  type VisitSimilarityRevision,
} from './types.js';
import { extractUrlsFromText } from './urlExtractor.js';

export type { ConnectionsSnapshot } from './types.js';

// Sync Contract v1 / Class B — Connections snapshot reducer.
//
// Pure function over the merged event log + companion vault
// records. Same input → byte-equivalent output across replays and
// replicas. No wall-clock, no inference, no time-proximity edges.
//
// Edge set:
//   thread_in_workstream                 thread.primaryWorkstreamId
//   workstream_parent_of                 workstream.parentId
//   dispatch_from_thread                 dispatch record sourceThreadId
//   dispatch_in_workstream               dispatch record workstreamId
//   dispatch_reply_landed_in_thread      dispatch.linked event
//   dispatch_requested_coding_session    dispatch record mcpRequest
//   queue_targets_thread / _workstream   queue.created event
//   reminder_for_thread                  reminder record threadId
//   coding_session_in_workstream         coding session workstreamId
//   timeline_same_url_as_thread          canonical-URL match
//   annotation_targets_thread            annotation URL matches thread URL
//   thread_references_url                URL in capture.recorded turn text
//   dispatch_references_url              URL in dispatch.recorded body
//   annotation_references_url            URL in annotation.created note
//   thread_quotes_thread                 ≥40-char substring across capture turns
//   thread_text_mentions_search_query    captured text contains a search-URL
//                                         visit's query (whole-word match)
//   visit_resembles_visit                deterministic visit similarity
//                                        revision over title/host/path
//   visit_in_tab_session                  timeline projection records a
//                                         stable tabSessionId for a visit
//   tab_session_opener_chain              child tab-session opened from a
//                                         parent tab-session
//   visit_in_workstream                   Phase 2: explicit tab-session
//                                         attribution to workstream
//   previous_visit_in_tab_session         chrome.webNavigation same-tab
//                                         sequence evidence
//   opener_visit                          chrome.webNavigation opener tab
//                                         evidence
//   visit_in_topic                         topic-clusterer membership edge
//   topic_in_workstream                    topic-clusterer dominant
//                                         workstream edge (>=75% members)
//   topic.lineage                          topic split/merge revision edge
//   snippet_copied_from_visit             hash-only copy/paste lineage
//   snippet_pasted_into_<dest>            paste destination edge
//   snippet_reused_across_threads         same snippet pasted into >=2 threads
//   visit_continues_visit                 inferred cross-replica
//                                         continuation handoff
//   closest_visit                         learned ranker top-K visit
//                                         relation with feature
//                                         contributions
//   visit_in_template                     DOM-skeleton hash grouping
//
// `annotation_targets_workstream` is declared in the edge-kind union
// for completeness but not yet emitted (workstream-anchored
// annotations land in a follow-up PR).

// Minimal record shapes pulled from the companion vault. Defined
// locally so this module doesn't depend on the HTTP schema package.
// The materializer's loader is responsible for producing these.

export interface ThreadVaultRecord {
  readonly bac_id: string;
  readonly title?: string;
  readonly threadUrl?: string;
  readonly canonicalUrl?: string;
  readonly provider?: string;
  readonly lastSeenAt?: string;
  readonly primaryWorkstreamId?: string;
}

export interface WorkstreamVaultRecord {
  readonly bac_id: string;
  readonly title?: string;
  readonly parentId?: string;
  readonly children?: readonly string[];
  readonly tags?: readonly string[];
  readonly privacy?: string;
}

export interface DispatchVaultRecord {
  readonly bac_id: string;
  readonly title?: string;
  readonly target?: { readonly provider?: string };
  readonly status?: string;
  readonly createdAt?: string;
  readonly sourceThreadId?: string;
  readonly workstreamId?: string;
  readonly mcpRequest?: {
    readonly codingSessionId?: string;
  };
}

export interface QueueVaultRecord {
  readonly bac_id: string;
  readonly title?: string;
  readonly scope?: string;
  readonly targetId?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly threadId?: string;
  readonly workstreamId?: string;
}

export interface ReminderVaultRecord {
  readonly bac_id?: string;
  readonly threadId: string;
  readonly provider?: string;
  readonly detectedAt?: string;
  readonly status?: string;
}

export interface CodingSessionVaultRecord {
  readonly bac_id: string;
  readonly workstreamId?: string;
  readonly tool?: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly name?: string;
  readonly attachedAt?: string;
  readonly lastSeenAt?: string;
  readonly status?: string;
}

export interface ConnectionsInput {
  readonly events: readonly AcceptedEvent[];
  readonly threads: readonly ThreadVaultRecord[];
  readonly workstreams: readonly WorkstreamVaultRecord[];
  readonly dispatches: readonly DispatchVaultRecord[];
  readonly queueItems: readonly QueueVaultRecord[];
  readonly reminders: readonly ReminderVaultRecord[];
  readonly codingSessions: readonly CodingSessionVaultRecord[];
  readonly timelineDays: readonly TimelineDayProjection[];
  readonly tabSessionProjection: TabSessionProjection;
  // Per-canonical-URL attribution (preferred over tab-session
  // attribution for visit-instance edges — the user attributes pages,
  // not tabs). Optional for back-compat with older callers that haven't
  // wired the projection yet.
  readonly urlProjection?: UrlProjection;
  readonly visitSimilarity?: VisitSimilarityRevision;
  readonly topicRevision?: TopicRevision;
  readonly pageEvidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>;
  readonly evidenceVectorsByVectorId?: ReadonlyMap<string, Float32Array>;
  readonly topicWorkstreamShareThreshold?: number;
  readonly crossReplica?: CrossReplicaMaterialization;
  readonly engagementClassRevision?: EngagementClassRevision;
  readonly closestVisitRanker?: ClosestVisitRanker;
  readonly preservedThreadQuoteEdges?: readonly ConnectionEdge[];
  readonly scope?: ConnectionsSnapshotScope;
}

export interface ClosestVisitRankerPrediction {
  readonly score: number;
  readonly rankerKind?: 'lightgbm_lambdamart' | 'graph_baseline' | string;
  readonly contributions: Readonly<Partial<Record<keyof CandidatePairFeatures, number>>>;
}

export interface ClosestVisitRanker {
  readonly revisionId: string;
  readonly threshold?: number;
  readonly topK?: number;
  readonly predict: (
    features: CandidatePairFeatures,
    candidate: Candidate,
  ) => ClosestVisitRankerPrediction;
}

const RANKER_SERVING_SOURCE_PRIORITY = new Map<CandidateSource, number>(
  (
    [
      'user_confirmed',
      'content_embedding_neighborhood',
      'content_term_overlap',
      'embedding_neighborhood',
      'opener_chain',
      'navigation_chain',
      'same_canonical_url',
      'same_copied_snippet',
      'same_search_query',
      'same_title_path_tokens',
      'same_repo_or_domain',
      'cross_replica_continuation',
      'recently_skipped',
      'random_unrelated',
    ] satisfies readonly CandidateSource[]
  ).map((source, index) => [source, index] as const),
);

const rankerServingPriority = (candidate: Candidate): number =>
  Math.min(...candidate.sources.map((source) => RANKER_SERVING_SOURCE_PRIORITY.get(source) ?? 999));

const primaryRankerCandidateSource = (candidate: Candidate): CandidateSource | null =>
  [...candidate.sources].sort(
    (left, right) =>
      (RANKER_SERVING_SOURCE_PRIORITY.get(left) ?? 999) -
        (RANKER_SERVING_SOURCE_PRIORITY.get(right) ?? 999) || left.localeCompare(right),
  )[0] ?? null;

const compareRankerServingCandidate = (left: Candidate, right: Candidate): number =>
  rankerServingPriority(left) - rankerServingPriority(right) ||
  right.generatedAt - left.generatedAt ||
  compareString(left.toVisitId, right.toVisitId);

const registerMetadata = <T>(
  projection: RegisterProjection<T>,
): Record<string, unknown> | undefined => {
  if (projection.status === 'resolved') return undefined;
  return {
    causalRegister: {
      status: 'conflict',
      candidates: projection.candidates.map((candidate) => ({
        value: candidate.value,
        event: candidate.event,
        replicaId: candidate.replicaId,
        acceptedAtMs: candidate.acceptedAtMs,
      })),
    },
  };
};

// Internal accumulator for nodes — allows merging origin replica
// ids and merging metadata from multiple sources.
interface AccumNode {
  readonly id: string;
  readonly kind: ConnectionNodeKind;
  label: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  originReplicaIds: Set<string>;
  metadata: Record<string, unknown>;
}

const sortAlphaById = <T extends { id: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// SQLITE_BUSY / SQLITE_LOCKED detection. The resolver cache is a pure
// optimization that shares current.db with the drain child's long write
// transactions; when the child holds the write lock, a cache read/write
// can throw "database is locked". We must never fail a resolve for that —
// degrade to computing without the cache instead. Mirrors the predicate
// in sync/contract/connectionsMaterializer.ts (kept local; that copy is
// module-private).
const isSqliteLockError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return String(error).includes('database is locked');
  }
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('database is locked') ||
    message.includes('SQLITE_BUSY') ||
    message.includes('SQLITE_LOCKED')
  );
};

const evidenceMetadataForNode = (
  input: ConnectionsInput,
  canonicalUrl: string,
): Record<string, unknown> | undefined => {
  const evidence = input.pageEvidenceByCanonicalUrl?.get(canonicalUrl);
  if (evidence === undefined) return undefined;
  return {
    tier: evidence.evidenceTier,
    evidenceRevision: evidence.evidenceRevision,
    updatedAt: evidence.updatedAt,
    termCount: evidence.content?.terms.length ?? 0,
    keyphraseCount: evidence.content?.keyphrases.length ?? 0,
    entityCount: evidence.content?.entities.length ?? 0,
    ...(evidence.content?.quality === undefined ? {} : { quality: evidence.content.quality }),
    ...(evidence.content?.docEmbeddingRef === undefined
      ? {}
      : {
          vector: {
            modelId: evidence.content.docEmbeddingRef.modelId,
            modelVersion: evidence.content.docEmbeddingRef.modelVersion,
            dimensions: evidence.content.docEmbeddingRef.dimensions,
          },
        }),
  };
};

// Spreadable wrapper: returns {} or { pageEvidence: ... } in one call so
// the per-node loops don't pay for evidenceMetadataForNode TWICE (once for
// the undefined check, once for the value). With ~6000 nodes per rebuild,
// the duplication was a measurable share of buildConnectionsSnapshot.
const pageEvidenceField = (
  input: ConnectionsInput,
  canonicalUrl: string,
): { pageEvidence: Record<string, unknown> } | Record<string, never> => {
  const meta = evidenceMetadataForNode(input, canonicalUrl);
  return meta === undefined ? {} : { pageEvidence: meta };
};

const pageEvidenceSummaryForUrl = (evidence: PageEvidenceRecord): UrlPageEvidenceSummary => ({
  tier: evidence.evidenceTier,
  evidenceRevision: evidence.evidenceRevision,
  semanticFeatureRevision: evidence.semanticFeatureRevision,
  updatedAt: evidence.updatedAt,
  termCount: evidence.content?.terms.length ?? 0,
  keyphraseCount: evidence.content?.keyphrases.length ?? 0,
  entityCount: evidence.content?.entities.length ?? 0,
  ...(evidence.content?.quality === undefined ? {} : { quality: evidence.content.quality }),
  ...(evidence.content?.docEmbeddingRef === undefined
    ? {}
    : {
        vector: {
          modelId: evidence.content.docEmbeddingRef.modelId,
          modelVersion: evidence.content.docEmbeddingRef.modelVersion,
          dimensions: evidence.content.docEmbeddingRef.dimensions,
        },
      }),
});

const urlProjectionWithPageEvidence = (
  projection: UrlProjection,
  evidenceByCanonicalUrl: ReadonlyMap<string, PageEvidenceRecord> | undefined,
): UrlProjection => {
  if (evidenceByCanonicalUrl === undefined || evidenceByCanonicalUrl.size === 0) {
    return projection;
  }
  return {
    schemaVersion: projection.schemaVersion,
    byCanonicalUrl: new Map(
      [...projection.byCanonicalUrl.entries()].map(([canonicalUrl, record]) => {
        const evidence = evidenceByCanonicalUrl.get(canonicalUrl);
        return [
          canonicalUrl,
          evidence === undefined
            ? record
            : {
                ...record,
                pageEvidence: pageEvidenceSummaryForUrl(evidence),
              },
        ] as const;
      }),
    ),
  };
};

const compactMetadata = (m: Record<string, unknown>): ConnectionNodeMetadata => {
  // Drop undefined entries so the same logical metadata produces
  // byte-identical JSON across runs.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  // Sort keys for deterministic JSON.stringify output.
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
};

const upsertNode = (
  nodes: Map<string, AccumNode>,
  input: {
    kind: ConnectionNodeKind;
    key: string;
    label: string;
    observedAt?: string;
    replicaId?: string;
    metadata?: Record<string, unknown>;
  },
): AccumNode => {
  const id = nodeIdFor(input.kind, input.key);
  const existing = nodes.get(id);
  if (existing === undefined) {
    const node: AccumNode = {
      id,
      kind: input.kind,
      label: input.label,
      ...(input.observedAt === undefined
        ? {}
        : { firstSeenAt: input.observedAt, lastSeenAt: input.observedAt }),
      originReplicaIds: new Set<string>(input.replicaId !== undefined ? [input.replicaId] : []),
      metadata: { ...(input.metadata ?? {}) },
    };
    nodes.set(id, node);
    return node;
  }
  // Merge: keep the longer label (proxies "richer source"); extend
  // first/last seen; union replica ids; merge metadata (existing wins
  // unless the new value is more specific).
  if (input.label.length > existing.label.length) existing.label = input.label;
  if (input.observedAt !== undefined) {
    if (existing.firstSeenAt === undefined || input.observedAt < existing.firstSeenAt) {
      existing.firstSeenAt = input.observedAt;
    }
    if (existing.lastSeenAt === undefined || input.observedAt > existing.lastSeenAt) {
      existing.lastSeenAt = input.observedAt;
    }
  }
  if (input.replicaId !== undefined) existing.originReplicaIds.add(input.replicaId);
  for (const [k, v] of Object.entries(input.metadata ?? {})) {
    if (v === undefined) continue;
    if (existing.metadata[k] === undefined) existing.metadata[k] = v;
  }
  return existing;
};

// Same idempotency rule as nodes — same source observation across
// replays produces the same edge id, so re-runs collapse to a stable
// set.
const upsertEdge = (
  edges: Map<string, ConnectionEdge>,
  input: Omit<ConnectionEdge, 'id'>,
): void => {
  const id = edgeIdFor(input.kind, input.fromNodeId, input.toNodeId);
  // Keep the EARLIEST observedAt as the canonical "first observed
  // this connection" — same input → same output. Re-derives stable.
  const existing = edges.get(id);
  if (existing === undefined) {
    edges.set(id, { id, ...input });
    return;
  }
  if (input.observedAt < existing.observedAt) {
    edges.set(id, { id, ...input });
  }
};

// Move 4 (b) — evidence-tier provenance stamp for inferred similarity
// edges. This is READ/EMIT metadata only: it records WHICH evidence the
// producer actually used to form the edge, so downstream consumers (and
// the aggregator chrome-only guard, once lifted) can distinguish a
// content-vector edge from a chrome/title-only one. It does NOT change
// scoring, thresholds, or which edges serve — deriving it from the
// already-computed channels is purely additive.
//
//   content_vector — a doc-embedding cosine was present on the pair
//                     (channels.contentVector), i.e. real content
//                     similarity on both endpoints.
//   metadata       — page-evidence channels were present but no content
//                     vector (title/host/path "metadata" + behavior).
//   title_only     — the served HNSW/cosine-only edge with no evidence
//                     on either endpoint (the known false-friend class);
//                     the producer emitted no channel metadata at all.
//
// NOTE: the aggregator guard (tabsession/similarity.ts
// isChromeOnlySimilarityEdge) still keys off metadata.channels, which
// these title-only served edges never carry — so it stays inert until it
// is taught to read this tier. Teaching the guard is a serving-behavior
// change gated behind the P1 freeze (ADR-0011); see followups.
export type SimilarityEvidenceTier = 'title_only' | 'metadata' | 'content_vector';

const evidenceTierForSimilarityMetadata = (
  metadata: PageEvidenceSimilarityMetadata | undefined,
): SimilarityEvidenceTier => {
  if (metadata === undefined) return 'title_only';
  const contentVector = metadata.channels.contentVector;
  if (typeof contentVector === 'number' && contentVector > 0) return 'content_vector';
  return 'metadata';
};

// The closest_visit ranker edge carries no page-evidence channels; its
// evidence is the candidate SOURCE the ranker actually matched on. Map
// those to the same tier vocabulary so both similarity-edge kinds report
// provenance consistently:
//   content_embedding_neighborhood — doc-embedding cosine on both
//     endpoints => content_vector.
//   content_term_overlap / structural-metadata sources (title/path/host,
//     repo/domain, search query, copied snippet, opener/nav chains,
//     user-confirmed, cross-replica continuation) => metadata.
//   otherwise (only the title-only `embedding_neighborhood` HNSW source,
//     or the chrome-prone structural-only class) => title_only.
// Same rationale as the guard's channel classification in
// tabsession/similarity.ts (embedding_neighborhood is chrome-prone; the
// content_* sources are the genuine-content ones).
const CONTENT_VECTOR_CANDIDATE_SOURCES = new Set<CandidateSource>([
  'content_embedding_neighborhood',
]);
const TITLE_ONLY_CANDIDATE_SOURCES = new Set<CandidateSource>([
  'embedding_neighborhood',
  'same_repo_or_domain',
  'same_title_path_tokens',
  'recently_skipped',
  'random_unrelated',
]);

const evidenceTierForCandidateSources = (
  sources: readonly CandidateSource[],
): SimilarityEvidenceTier => {
  if (sources.some((source) => CONTENT_VECTOR_CANDIDATE_SOURCES.has(source))) {
    return 'content_vector';
  }
  if (sources.some((source) => !TITLE_ONLY_CANDIDATE_SOURCES.has(source))) {
    return 'metadata';
  }
  return 'title_only';
};

const snapshotFromAccumulators = (
  scope: ConnectionsSnapshotScope | undefined,
  nodes: ReadonlyMap<string, AccumNode>,
  edges: ReadonlyMap<string, ConnectionEdge>,
  maxObservedAt: string,
): ConnectionsSnapshot => {
  const finalNodes: ConnectionNode[] = [];
  for (const node of nodes.values()) {
    finalNodes.push({
      id: node.id,
      kind: node.kind,
      label: node.label,
      ...(node.firstSeenAt === undefined ? {} : { firstSeenAt: node.firstSeenAt }),
      ...(node.lastSeenAt === undefined ? {} : { lastSeenAt: node.lastSeenAt }),
      originReplicaIds: [...node.originReplicaIds].sort(),
      metadata: compactMetadata(node.metadata),
    });
  }

  const sortedNodes = sortAlphaById(finalNodes);
  const sortedEdges = sortAlphaById([...edges.values()]);
  return {
    scope: scope ?? {},
    nodes: sortedNodes,
    edges: sortedEdges,
    updatedAt: maxObservedAt.length > 0 ? maxObservedAt : '1970-01-01T00:00:00.000Z',
    nodeCount: sortedNodes.length,
    edgeCount: sortedEdges.length,
  };
};

const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

const currentUrlAttributionFor = (
  input: ConnectionsInput,
  canonicalUrl: string,
): UrlAttribution | undefined =>
  input.urlProjection?.byCanonicalUrl.get(stripFragmentAndTrailingSlash(canonicalUrl))
    ?.currentAttribution;

// Stage 5 / T5 — `timeline_same_url_as_thread` gates. Pre-T5 the edge
// fired whenever a timeline-visit's canonical URL matched a thread's
// URL, which is noisy: shared URLs across tabs, reloads, preview
// pages, and unrelated visits to a chat host all triggered it.
//
// T5 demotes the edge by requiring at least the same provider OR a
// reasonable title overlap, AND a recency window. Edges that pass keep
// `confidence: 'inferred'` and gain a `metadata.evidence` blob
// recording which gates fired. Edges that don't pass are simply not
// emitted.
//
// These gates intentionally err on the side of dropping signal — the
// retro's diagnosis was that the existing edge family was the only
// inferred kind at scale (8 of 9 edges) and the weakest signal. T5
// trades coverage for honesty.

export const TIMELINE_SAME_URL_AS_THREAD_TITLE_JACCARD_THRESHOLD = 0.25;
export const TIMELINE_SAME_URL_AS_THREAD_RECENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const TIMELINE_SAME_URL_AS_THREAD_TITLE_JACCARD_ENV =
  'SIDETRACK_TIMELINE_SAME_URL_AS_THREAD_TITLE_JACCARD';
export const TIMELINE_SAME_URL_AS_THREAD_RECENCY_WINDOW_MS_ENV =
  'SIDETRACK_TIMELINE_SAME_URL_AS_THREAD_RECENCY_WINDOW_MS';

const readEnvNumberSnapshot = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const titleJaccardThreshold = (): number => {
  const env = readEnvNumberSnapshot(TIMELINE_SAME_URL_AS_THREAD_TITLE_JACCARD_ENV);
  if (env === undefined) return TIMELINE_SAME_URL_AS_THREAD_TITLE_JACCARD_THRESHOLD;
  return Math.min(Math.max(env, 0), 1);
};

const recencyWindowMs = (): number => {
  const env = readEnvNumberSnapshot(TIMELINE_SAME_URL_AS_THREAD_RECENCY_WINDOW_MS_ENV);
  if (env === undefined) return TIMELINE_SAME_URL_AS_THREAD_RECENCY_WINDOW_MS;
  return Math.max(0, env);
};

const tokenizeTitle = (title: string | undefined): ReadonlySet<string> => {
  const set = new Set<string>();
  if (title === undefined) return set;
  for (const raw of title.split(/\s+/u)) {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) continue;
    set.add(trimmed);
  }
  return set;
};

const titleJaccard = (left: string | undefined, right: string | undefined): number => {
  const leftTokens = tokenizeTitle(left);
  const rightTokens = tokenizeTitle(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] =
    leftTokens.size <= rightTokens.size ? [leftTokens, rightTokens] : [rightTokens, leftTokens];
  for (const token of smaller) {
    if (larger.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

// Returns null when the candidate edge should not be emitted; otherwise
// returns the evidence blob to record on `edge.metadata.evidence`.
export interface TimelineSameUrlAsThreadGateInput {
  readonly visitTitle?: string;
  readonly visitProvider?: string;
  readonly visitObservedAt: string;
  readonly threadTitle?: string;
  readonly threadProvider?: string;
  readonly threadLastSeenAt?: string;
}

export interface TimelineSameUrlAsThreadEvidence {
  readonly providerMatched: boolean;
  readonly titleJaccard: number;
  readonly recencyDeltaMs: number | null;
}

export const evaluateTimelineSameUrlAsThreadGate = (
  input: TimelineSameUrlAsThreadGateInput,
): TimelineSameUrlAsThreadEvidence | null => {
  const providerMatched =
    input.visitProvider !== undefined &&
    input.threadProvider !== undefined &&
    input.visitProvider.length > 0 &&
    input.visitProvider === input.threadProvider;
  const jaccard = titleJaccard(input.visitTitle, input.threadTitle);
  // Provider OR title-overlap. When neither side has a title we fall
  // back to requiring a provider match.
  const overlapPasses = providerMatched || jaccard >= titleJaccardThreshold();
  if (!overlapPasses) return null;
  // Recency window. When the thread has no `lastSeenAt`, skip the
  // recency check — the metadata isn't available to reject on.
  let recencyDeltaMs: number | null = null;
  if (input.threadLastSeenAt !== undefined) {
    const left = Date.parse(input.visitObservedAt);
    const right = Date.parse(input.threadLastSeenAt);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      recencyDeltaMs = Math.abs(left - right);
      if (recencyDeltaMs > recencyWindowMs()) return null;
    }
  }
  return { providerMatched, titleJaccard: jaccard, recencyDeltaMs };
};

const TIMELINE_VISIT_NODE_PREFIX = 'timeline-visit:';
const VISIT_INSTANCE_NODE_KIND = 'visit-instance' as const;
const VISIT_INSTANCE_INCREMENTING_TRANSITIONS: ReadonlySet<TimelineTransition> =
  new Set<TimelineTransition>(['activated', 'updated']);

interface VisitInstanceAccumulator {
  readonly tabSessionId: string;
  readonly visitKey: string;
  readonly firstSeenAt: string;
  lastSeenAt: string;
  url: string;
  canonicalUrl?: string;
  title?: string;
  provider?: string;
  openerTabSessionId?: string;
  visitCount: number;
  replicaIds: Set<string>;
}

export const visitKeyFromNodeOrRaw = (value: string): string =>
  value.startsWith(TIMELINE_VISIT_NODE_PREFIX)
    ? value.slice(TIMELINE_VISIT_NODE_PREFIX.length)
    : stripFragmentAndTrailingSlash(value);

const topicNodeIdFromTopicId = (topicId: string): string => nodeIdFor('topic', topicId);

const visitNodeIdFromNodeOrRaw = (value: string): string =>
  value.startsWith(TIMELINE_VISIT_NODE_PREFIX)
    ? value
    : nodeIdFor('timeline-visit', visitKeyFromNodeOrRaw(value));

const memberNodeIdsFor = (members: readonly string[]): ReadonlySet<string> =>
  new Set(members.map((member) => nodeIdFor('timeline-visit', member)));

const normalizedMemberNodeIds = (members: readonly string[] | undefined): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const member of members ?? []) {
    out.add(visitNodeIdFromNodeOrRaw(member));
  }
  return out;
};

const memberOverlapMatches = (
  actionMemberNodeIds: ReadonlySet<string>,
  topicMemberCanonicalUrls: readonly string[],
): boolean => {
  if (actionMemberNodeIds.size < 2 || topicMemberCanonicalUrls.length < 2) return false;
  const topicMemberNodeIds = memberNodeIdsFor(topicMemberCanonicalUrls);
  let overlap = 0;
  for (const memberId of actionMemberNodeIds) {
    if (topicMemberNodeIds.has(memberId)) overlap += 1;
  }
  if (overlap < 2) return false;
  return overlap / actionMemberNodeIds.size >= 0.8 && overlap / topicMemberNodeIds.size >= 0.5;
};

interface TopicActionProjection {
  readonly hiddenTopics: readonly {
    readonly topicKeys: ReadonlySet<string>;
    readonly memberNodeIds: ReadonlySet<string>;
  }[];
  readonly suppressedVisitTopicPairs: readonly {
    readonly visitNodeId: string;
    readonly topicKeys: ReadonlySet<string>;
    readonly memberNodeIds: ReadonlySet<string>;
  }[];
  readonly mergeRequests: readonly {
    readonly sourceTopicKeys: ReadonlySet<string>;
    readonly targetTopicKeys: ReadonlySet<string>;
    readonly sourceMemberNodeIds: ReadonlySet<string>;
  }[];
}

const topicKeysForAction = (value: string | null | undefined): ReadonlySet<string> => {
  const out = new Set<string>();
  if (value === undefined || value === null || value.length === 0) return out;
  out.add(value);
  if (!value.startsWith('topic:')) {
    out.add(topicNodeIdFromTopicId(value));
  } else {
    out.add(topicNodeIdFromTopicId(value));
    const unprefixed = value.replace(/^topic:/u, '');
    if (unprefixed.length > 0) out.add(unprefixed);
  }
  return out;
};

const topicKeysMatch = (
  topicKeys: ReadonlySet<string>,
  topicId: string,
  topicNodeId: string,
): boolean => topicKeys.has(topicId) || topicKeys.has(topicNodeId);

const topicActionMatches = (
  action: { readonly topicKeys: ReadonlySet<string>; readonly memberNodeIds: ReadonlySet<string> },
  topic: TopicRevisionTopic,
): boolean =>
  topicKeysMatch(action.topicKeys, topic.topicId, topicNodeIdFromTopicId(topic.topicId)) ||
  memberOverlapMatches(action.memberNodeIds, topic.memberCanonicalUrls);

const buildTopicActionProjection = (events: readonly AcceptedEvent[]): TopicActionProjection => {
  const hiddenTopics: TopicActionProjection['hiddenTopics'][number][] = [];
  const suppressedVisitTopicPairs: TopicActionProjection['suppressedVisitTopicPairs'][number][] =
    [];
  const mergeRequests: TopicActionProjection['mergeRequests'][number][] = [];

  for (const event of events) {
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) {
      continue;
    }
    const payload = event.payload;
    const memberNodeIds = normalizedMemberNodeIds(payload.details?.memberIds);
    if (payload.itemKind === 'topic' && payload.action === 'ignore') {
      hiddenTopics.push({
        topicKeys: topicKeysForAction(payload.itemId),
        memberNodeIds,
      });
      continue;
    }
    if (payload.itemKind === 'visit' && payload.action === 'ignore') {
      suppressedVisitTopicPairs.push({
        visitNodeId: visitNodeIdFromNodeOrRaw(payload.itemId),
        topicKeys: topicKeysForAction(payload.fromContainer ?? payload.details?.targetTopicId),
        memberNodeIds,
      });
      continue;
    }
    if (payload.itemKind === 'topic' && payload.action === 'split') {
      for (const memberId of payload.details?.memberIds ?? []) {
        suppressedVisitTopicPairs.push({
          visitNodeId: visitNodeIdFromNodeOrRaw(memberId),
          topicKeys: topicKeysForAction(payload.itemId),
          memberNodeIds,
        });
      }
      continue;
    }
    if (payload.itemKind === 'topic' && payload.action === 'merge') {
      const targetTopicId =
        payload.details?.targetTopicId ?? payload.toContainer ?? payload.details?.mergeMembers?.[0];
      mergeRequests.push({
        sourceTopicKeys: topicKeysForAction(payload.itemId),
        targetTopicKeys: topicKeysForAction(targetTopicId),
        sourceMemberNodeIds: memberNodeIds,
      });
    }
  }

  return { hiddenTopics, suppressedVisitTopicPairs, mergeRequests };
};

const topicIsHiddenByUser = (actions: TopicActionProjection, topic: TopicRevisionTopic): boolean =>
  actions.hiddenTopics.some((action) => topicActionMatches(action, topic));

const visitTopicPairSuppressedByUser = (
  actions: TopicActionProjection,
  topic: TopicRevisionTopic,
  memberCanonicalUrl: string,
): boolean => {
  const visitNodeId = nodeIdFor('timeline-visit', memberCanonicalUrl);
  const topicNodeId = topicNodeIdFromTopicId(topic.topicId);
  return actions.suppressedVisitTopicPairs.some(
    (action) =>
      action.visitNodeId === visitNodeId &&
      (topicKeysMatch(action.topicKeys, topic.topicId, topicNodeId) ||
        memberOverlapMatches(action.memberNodeIds, topic.memberCanonicalUrls)),
  );
};

interface ProjectedTopic {
  readonly topicId: string;
  readonly memberCanonicalUrls: readonly string[];
  readonly metadata: TopicNodeMetadata & { readonly secondaryCount?: number };
  readonly secondaryAffiliations: readonly TopicSecondaryAffiliation[];
}

const mergeTopicMetadata = (
  entries: readonly {
    readonly metadata: TopicNodeMetadata;
    readonly memberCount: number;
    readonly secondaryCount: number;
  }[],
  memberCount: number,
): ProjectedTopic['metadata'] => {
  const representativeTitles = [
    ...new Set(entries.flatMap((entry) => entry.metadata.representativeTitles)),
  ].slice(0, 5);
  const firstObservedAt =
    entries.map((entry) => entry.metadata.firstObservedAt).sort(compareString)[0] ?? '';
  const lastObservedAt =
    entries.map((entry) => entry.metadata.lastObservedAt).sort((a, b) => compareString(b, a))[0] ??
    '';
  const weightedCohesion = entries.reduce(
    (sum, entry) => sum + entry.metadata.cohesion * Math.max(1, entry.memberCount),
    0,
  );
  const weightedMembers = entries.reduce((sum, entry) => sum + Math.max(1, entry.memberCount), 0);
  const dominant = entries.find((entry) => entry.metadata.dominantWorkstreamId !== undefined)
    ?.metadata.dominantWorkstreamId;
  const secondaryCount = entries.reduce((sum, entry) => sum + entry.secondaryCount, 0);
  return {
    memberCount,
    ...(dominant === undefined ? {} : { dominantWorkstreamId: dominant }),
    representativeTitles,
    firstObservedAt,
    lastObservedAt,
    cohesion: weightedMembers === 0 ? 0 : Number((weightedCohesion / weightedMembers).toFixed(6)),
    ...(secondaryCount > 0 ? { secondaryCount } : {}),
  };
};

const projectedTopicsForUserActions = (
  topics: readonly TopicRevisionTopic[],
  actions: TopicActionProjection,
): readonly ProjectedTopic[] => {
  const activeTopics = topics.filter((topic) => !topicIsHiddenByUser(actions, topic));
  const topicByNodeId = new Map(
    activeTopics.map((topic) => [topicNodeIdFromTopicId(topic.topicId), topic] as const),
  );
  const topicNodeIdByKey = new Map<string, string>();
  for (const topic of activeTopics) {
    const topicNodeId = topicNodeIdFromTopicId(topic.topicId);
    topicNodeIdByKey.set(topic.topicId, topicNodeId);
    topicNodeIdByKey.set(topicNodeId, topicNodeId);
  }

  const redirectByNodeId = new Map<string, string>();
  for (const request of actions.mergeRequests) {
    const targetNodeId = [...request.targetTopicKeys]
      .map((key) => topicNodeIdByKey.get(key))
      .find((candidate): candidate is string => candidate !== undefined);
    if (targetNodeId === undefined) continue;
    for (const topic of activeTopics) {
      const sourceNodeId = topicNodeIdFromTopicId(topic.topicId);
      const sourceMatches =
        topicKeysMatch(request.sourceTopicKeys, topic.topicId, sourceNodeId) ||
        memberOverlapMatches(request.sourceMemberNodeIds, topic.memberCanonicalUrls);
      if (sourceMatches && sourceNodeId !== targetNodeId)
        redirectByNodeId.set(sourceNodeId, targetNodeId);
    }
  }

  const rootFor = (nodeId: string): string => {
    let current = nodeId;
    const seen = new Set<string>();
    while (redirectByNodeId.has(current) && !seen.has(current)) {
      seen.add(current);
      current = redirectByNodeId.get(current) ?? current;
    }
    return current;
  };

  const grouped = new Map<
    string,
    {
      readonly targetTopic: TopicRevisionTopic;
      readonly memberCanonicalUrls: Set<string>;
      readonly secondaryByUrl: Map<string, TopicSecondaryAffiliation>;
      readonly metadataEntries: {
        readonly metadata: TopicNodeMetadata;
        readonly memberCount: number;
        readonly secondaryCount: number;
      }[];
    }
  >();

  for (const topic of activeTopics) {
    const topicNodeId = topicNodeIdFromTopicId(topic.topicId);
    const targetNodeId = rootFor(topicNodeId);
    const targetTopic = topicByNodeId.get(targetNodeId) ?? topic;
    const existing = grouped.get(targetNodeId) ?? {
      targetTopic,
      memberCanonicalUrls: new Set<string>(),
      secondaryByUrl: new Map<string, TopicSecondaryAffiliation>(),
      metadataEntries: [],
    };

    for (const member of topic.memberCanonicalUrls) {
      if (visitTopicPairSuppressedByUser(actions, topic, member)) continue;
      if (
        targetTopic.topicId !== topic.topicId &&
        visitTopicPairSuppressedByUser(actions, targetTopic, member)
      ) {
        continue;
      }
      existing.memberCanonicalUrls.add(member);
    }
    for (const affiliation of topic.secondaryAffiliations ?? []) {
      if (visitTopicPairSuppressedByUser(actions, topic, affiliation.canonicalUrl)) continue;
      const current = existing.secondaryByUrl.get(affiliation.canonicalUrl);
      if (current === undefined || affiliation.score > current.score) {
        existing.secondaryByUrl.set(affiliation.canonicalUrl, affiliation);
      }
    }
    existing.metadataEntries.push({
      metadata: topic.metadata,
      memberCount: topic.memberCanonicalUrls.length,
      secondaryCount: topic.secondaryAffiliations?.length ?? 0,
    });
    grouped.set(targetNodeId, existing);
  }

  return [...grouped.values()]
    .map((group) => {
      const memberCanonicalUrls = [...group.memberCanonicalUrls].sort(compareString);
      const secondaryAffiliations = [...group.secondaryByUrl.values()].sort((left, right) =>
        left.canonicalUrl === right.canonicalUrl
          ? right.score - left.score
          : compareString(left.canonicalUrl, right.canonicalUrl),
      );
      return {
        topicId: group.targetTopic.topicId,
        memberCanonicalUrls,
        metadata: mergeTopicMetadata(
          group.metadataEntries.map((entry) =>
            entry.metadata === group.targetTopic.metadata
              ? { ...entry, memberCount: memberCanonicalUrls.length }
              : entry,
          ),
          memberCanonicalUrls.length,
        ),
        secondaryAffiliations,
      };
    })
    .filter(
      (topic) => topic.memberCanonicalUrls.length > 0 || topic.secondaryAffiliations.length > 0,
    )
    .sort((left, right) => compareString(left.topicId, right.topicId));
};

const visitInstanceKey = (input: {
  readonly tabSessionId: string;
  readonly visitKey: string;
  readonly firstSeenAt: string;
}): string => `${input.tabSessionId}:${input.firstSeenAt}:${input.visitKey}`;

const threadKeyFromNodeId = (nodeId: string): string | null => {
  const prefix = 'thread:';
  return nodeId.startsWith(prefix) && nodeId.length > prefix.length
    ? nodeId.slice(prefix.length)
    : null;
};

const collectVisitInstances = (input: {
  readonly events: readonly AcceptedEvent[];
  readonly timelineDays: readonly TimelineDayProjection[];
}): readonly VisitInstanceAccumulator[] => {
  const groups = new Map<string, VisitInstanceAccumulator>();
  const upsert = (entry: {
    readonly tabSessionId: string;
    readonly visitKey: string;
    readonly observedAt: string;
    readonly url: string;
    readonly canonicalUrl?: string;
    readonly title?: string;
    readonly provider?: string;
    readonly openerTabSessionId?: string;
    readonly transition?: TimelineTransition;
    readonly visitCount?: number;
    readonly replicaId?: string;
  }): void => {
    const groupKey = `${entry.tabSessionId}\u0000${entry.visitKey}`;
    const existing = groups.get(groupKey);
    const increments =
      entry.visitCount ??
      (entry.transition !== undefined &&
      VISIT_INSTANCE_INCREMENTING_TRANSITIONS.has(entry.transition)
        ? 1
        : 0);
    if (existing === undefined) {
      groups.set(groupKey, {
        tabSessionId: entry.tabSessionId,
        visitKey: entry.visitKey,
        firstSeenAt: entry.observedAt,
        lastSeenAt: entry.observedAt,
        url: entry.url,
        ...(entry.canonicalUrl === undefined ? {} : { canonicalUrl: entry.canonicalUrl }),
        ...(entry.title === undefined || entry.title.length === 0 ? {} : { title: entry.title }),
        ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        ...(entry.openerTabSessionId === undefined || entry.openerTabSessionId.length === 0
          ? {}
          : { openerTabSessionId: entry.openerTabSessionId }),
        visitCount: increments,
        replicaIds: new Set(entry.replicaId === undefined ? [] : [entry.replicaId]),
      });
      return;
    }
    if (entry.observedAt > existing.lastSeenAt) {
      existing.lastSeenAt = entry.observedAt;
      existing.url = entry.url;
      if (entry.canonicalUrl !== undefined) existing.canonicalUrl = entry.canonicalUrl;
      if (entry.title !== undefined && entry.title.length > 0) existing.title = entry.title;
      if (entry.provider !== undefined) existing.provider = entry.provider;
      if (entry.openerTabSessionId !== undefined && entry.openerTabSessionId.length > 0) {
        existing.openerTabSessionId = entry.openerTabSessionId;
      }
    }
    existing.visitCount += increments;
    if (entry.replicaId !== undefined) existing.replicaIds.add(entry.replicaId);
  };

  for (const event of input.events) {
    if (event.type !== BROWSER_TIMELINE_OBSERVED) continue;
    if (!isBrowserTimelineObservedPayload(event.payload)) continue;
    const payload = event.payload;
    if (payload.tabSessionId === undefined || payload.tabSessionId.length === 0) continue;
    const visitKey = stripFragmentAndTrailingSlash(payload.canonicalUrl ?? payload.url);
    upsert({
      tabSessionId: payload.tabSessionId,
      visitKey,
      observedAt: payload.observedAt,
      url: payload.url,
      ...(payload.canonicalUrl === undefined ? {} : { canonicalUrl: payload.canonicalUrl }),
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.provider === undefined ? {} : { provider: payload.provider }),
      ...(payload.openerTabSessionId === undefined
        ? {}
        : { openerTabSessionId: payload.openerTabSessionId }),
      transition: payload.transition,
      replicaId: event.dot.replicaId,
    });
  }

  for (const day of input.timelineDays) {
    for (const entry of day.entries) {
      if (entry.tabSessionId === undefined || entry.tabSessionId.length === 0) continue;
      const visitKey = stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);
      const groupKey = `${entry.tabSessionId}\u0000${visitKey}`;
      if (groups.has(groupKey)) continue;
      upsert({
        tabSessionId: entry.tabSessionId,
        visitKey,
        observedAt: entry.firstSeenAt,
        url: entry.url,
        ...(entry.canonicalUrl === undefined ? {} : { canonicalUrl: entry.canonicalUrl }),
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        ...(entry.openerTabSessionId === undefined
          ? {}
          : { openerTabSessionId: entry.openerTabSessionId }),
        visitCount: entry.visitCount,
      });
      const inserted = groups.get(groupKey);
      if (inserted !== undefined) inserted.lastSeenAt = entry.lastSeenAt;
    }
  }

  return [...groups.values()].sort(
    (left, right) =>
      left.tabSessionId.localeCompare(right.tabSessionId) ||
      left.firstSeenAt.localeCompare(right.firstSeenAt) ||
      left.visitKey.localeCompare(right.visitKey),
  );
};

const roundRankerMetric = (value: number): number => Number(value.toFixed(6));

const topClosestVisitContributions = (
  contributions: Readonly<Partial<Record<keyof CandidatePairFeatures, number>>>,
  limit: number,
): readonly { readonly feature: string; readonly weight: number }[] =>
  (Object.entries(contributions) as readonly [keyof CandidatePairFeatures, number][])
    .filter(
      ([feature, weight]) => feature !== 'schemaVersion' && Number.isFinite(weight) && weight !== 0,
    )
    .sort(
      (left, right) => Math.abs(right[1]) - Math.abs(left[1]) || left[0].localeCompare(right[0]),
    )
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(([feature, weight]) => ({ feature, weight: roundRankerMetric(weight) }));

export interface RankerFrontierOptions {
  readonly includeSameUrlSiblings?: boolean;
  readonly includeSameTabSession?: boolean;
  readonly includeSameWorkstream?: boolean;
  readonly includeSameThread?: boolean;
  readonly includePriorClosestNeighbors?: boolean;
  readonly includeSimEdgeChanged?: boolean;
}

const timelineVisitKeyFromNodeId = (nodeId: string): string | null =>
  nodeId.startsWith('timeline-visit:') && nodeId.length > 'timeline-visit:'.length
    ? nodeId.slice('timeline-visit:'.length)
    : null;

export const expandRankerFrontier = (
  touchedVisitIds: ReadonlySet<string> | readonly string[],
  currentSnapshot: ConnectionsSnapshot,
  options: RankerFrontierOptions = {},
): ReadonlySet<string> => {
  const resolvedOptions = {
    includeSameUrlSiblings: options.includeSameUrlSiblings ?? true,
    includeSameTabSession: options.includeSameTabSession ?? true,
    includeSameWorkstream: options.includeSameWorkstream ?? true,
    includeSameThread: options.includeSameThread ?? true,
    includePriorClosestNeighbors: options.includePriorClosestNeighbors ?? true,
    includeSimEdgeChanged: options.includeSimEdgeChanged ?? true,
  };
  const frontier = new Set<string>([...touchedVisitIds].filter((id) => id.length > 0));
  if (frontier.size === 0) return frontier;

  const visitNodeByKey = new Map<string, ConnectionNode>();
  const visitKeyByCanonicalUrl = new Map<string, Set<string>>();
  const visitKeysByWorkstream = new Map<string, Set<string>>();
  const visitKeysByTabSession = new Map<string, Set<string>>();
  const visitInstanceTimelineById = new Map<string, string>();
  const visitInstanceTabSessionById = new Map<string, string>();
  const threadIdsByVisitKey = new Map<string, Set<string>>();
  const visitKeysByThreadId = new Map<string, Set<string>>();

  const addToIndex = (index: Map<string, Set<string>>, key: string, visitKey: string): void => {
    const existing = index.get(key);
    if (existing === undefined) index.set(key, new Set([visitKey]));
    else existing.add(visitKey);
  };

  for (const node of currentSnapshot.nodes) {
    if (node.kind === 'timeline-visit') {
      const visitKey = timelineVisitKeyFromNodeId(node.id);
      if (visitKey === null) continue;
      visitNodeByKey.set(visitKey, node);
      const canonicalUrl = node.metadata['canonicalUrl'];
      if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
        addToIndex(visitKeyByCanonicalUrl, canonicalUrl, visitKey);
      }
      const workstreamId = node.metadata['workstreamId'];
      if (typeof workstreamId === 'string' && workstreamId.length > 0) {
        addToIndex(visitKeysByWorkstream, workstreamId, visitKey);
      }
    } else if (node.kind === 'visit-instance') {
      const timelineVisitId = node.metadata['timelineVisitId'];
      const tabSessionId = node.metadata['tabSessionId'];
      const visitKey =
        typeof timelineVisitId === 'string' ? timelineVisitKeyFromNodeId(timelineVisitId) : null;
      if (visitKey !== null) visitInstanceTimelineById.set(node.id, visitKey);
      if (typeof tabSessionId === 'string' && tabSessionId.length > 0) {
        visitInstanceTabSessionById.set(node.id, tabSessionId);
        if (visitKey !== null) addToIndex(visitKeysByTabSession, tabSessionId, visitKey);
      }
    }
  }

  for (const edge of currentSnapshot.edges) {
    if (edge.kind === 'visit_instance_in_tab_session') {
      const visitKey = visitInstanceTimelineById.get(edge.fromNodeId);
      const tabSessionId = edge.toNodeId.startsWith('tab-session:')
        ? edge.toNodeId.slice('tab-session:'.length)
        : visitInstanceTabSessionById.get(edge.fromNodeId);
      if (visitKey !== undefined && tabSessionId !== undefined && tabSessionId.length > 0) {
        addToIndex(visitKeysByTabSession, tabSessionId, visitKey);
      }
    } else if (edge.kind === 'visit_in_workstream') {
      const visitKey = timelineVisitKeyFromNodeId(edge.fromNodeId);
      const workstreamId = edge.toNodeId.startsWith('workstream:')
        ? edge.toNodeId.slice('workstream:'.length)
        : null;
      if (visitKey !== null && workstreamId !== null) {
        addToIndex(visitKeysByWorkstream, workstreamId, visitKey);
      }
    } else if (edge.kind === 'timeline_same_url_as_thread') {
      const visitKey = timelineVisitKeyFromNodeId(edge.fromNodeId);
      const threadId = edge.toNodeId.startsWith('thread:')
        ? edge.toNodeId.slice('thread:'.length)
        : null;
      if (visitKey !== null && threadId !== null) {
        addToIndex(threadIdsByVisitKey, visitKey, threadId);
        addToIndex(visitKeysByThreadId, threadId, visitKey);
      }
    }
  }

  const seed = [...frontier];
  for (const visitKey of seed) {
    const node = visitNodeByKey.get(visitKey);
    if (node !== undefined && resolvedOptions.includeSameUrlSiblings) {
      const canonicalUrl = node.metadata['canonicalUrl'];
      if (typeof canonicalUrl === 'string') {
        for (const sibling of visitKeyByCanonicalUrl.get(canonicalUrl) ?? []) frontier.add(sibling);
      }
    }
    if (resolvedOptions.includeSameWorkstream) {
      const workstreamId = node?.metadata['workstreamId'];
      if (typeof workstreamId === 'string') {
        for (const sibling of visitKeysByWorkstream.get(workstreamId) ?? []) frontier.add(sibling);
      }
    }
    if (resolvedOptions.includeSameTabSession) {
      for (const [tabSessionId, members] of visitKeysByTabSession.entries()) {
        if (!members.has(visitKey)) continue;
        for (const sibling of visitKeysByTabSession.get(tabSessionId) ?? []) frontier.add(sibling);
      }
    }
    if (resolvedOptions.includeSameThread) {
      for (const threadId of threadIdsByVisitKey.get(visitKey) ?? []) {
        for (const sibling of visitKeysByThreadId.get(threadId) ?? []) frontier.add(sibling);
      }
    }
  }

  if (resolvedOptions.includePriorClosestNeighbors || resolvedOptions.includeSimEdgeChanged) {
    for (const edge of currentSnapshot.edges) {
      const includeClosest =
        resolvedOptions.includePriorClosestNeighbors && edge.kind === 'closest_visit';
      const includeSimilarity =
        resolvedOptions.includeSimEdgeChanged && edge.kind === 'visit_resembles_visit';
      if (!includeClosest && !includeSimilarity) continue;
      const fromVisitKey = timelineVisitKeyFromNodeId(edge.fromNodeId);
      const toVisitKey = timelineVisitKeyFromNodeId(edge.toNodeId);
      if (fromVisitKey === null || toVisitKey === null) continue;
      if (frontier.has(fromVisitKey)) frontier.add(toVisitKey);
      if (frontier.has(toVisitKey)) frontier.add(fromVisitKey);
    }
  }

  return new Set([...frontier].sort());
};

export const closestVisitRankerEdgesForSnapshot = (
  input: ConnectionsInput,
  baseSnapshot: ConnectionsSnapshot,
  ranker: ClosestVisitRanker,
  visitFrontier?: ReadonlySet<string>,
): readonly ConnectionEdge[] => {
  const threshold = ranker.threshold ?? 0.3;
  const topK = Math.max(0, Math.floor(ranker.topK ?? 5));
  if (topK === 0) return [];
  const maxServingCandidatesPerVisit = Math.max(topK * 2, 10);
  const baseNodeById = new Map(baseSnapshot.nodes.map((node) => [node.id, node] as const));
  const visitKeys = [
    ...new Set(
      baseSnapshot.nodes
        .filter((node) => node.kind === 'timeline-visit')
        .map((node) => visitKeyFromNodeOrRaw(node.id))
        .filter(
          (visitKey) =>
            visitKey.length > 0 && (visitFrontier === undefined || visitFrontier.has(visitKey)),
        ),
    ),
  ].sort();
  const merged = [...input.events];
  const rankerCandidateContext = {
    merged,
    existingEdges: [...baseSnapshot.edges],
    ...(input.pageEvidenceByCanonicalUrl === undefined
      ? {}
      : { pageEvidenceByCanonicalUrl: input.pageEvidenceByCanonicalUrl }),
    ...(input.evidenceVectorsByVectorId === undefined
      ? {}
      : { evidenceVectorsByVectorId: input.evidenceVectorsByVectorId }),
  };
  const rankerFeatureContext = {
    merged,
    snapshot: baseSnapshot,
    retrievalContext: { missingRetrievalContext: true },
  };
  const rankerEdges = new Map<string, ConnectionEdge>();

  const observedAtForVisit = (visitKey: string): string => {
    const node = baseNodeById.get(nodeIdFor('timeline-visit', visitKey));
    return node?.lastSeenAt ?? node?.firstSeenAt ?? '';
  };

  for (const fromVisitKey of visitKeys) {
    const scoredCandidates = [...generateCandidates(fromVisitKey, rankerCandidateContext)]
      .sort(compareRankerServingCandidate)
      .slice(0, maxServingCandidatesPerVisit)
      .map((candidate) => {
        const toVisitKey = visitKeyFromNodeOrRaw(candidate.toVisitId);
        if (!baseNodeById.has(nodeIdFor('timeline-visit', toVisitKey))) return null;
        const features = extractFeatures(candidate, rankerFeatureContext);
        const prediction = ranker.predict(features, candidate);
        if (!Number.isFinite(prediction.score) || prediction.score < threshold) {
          return null;
        }
        return {
          candidate,
          toVisitKey,
          score: roundRankerMetric(prediction.score),
          ...(prediction.rankerKind === undefined ? {} : { rankerKind: prediction.rankerKind }),
          topContributions: topClosestVisitContributions(prediction.contributions, 3),
        };
      })
      .filter(
        (
          candidate,
        ): candidate is {
          readonly candidate: Candidate;
          readonly toVisitKey: string;
          readonly score: number;
          readonly rankerKind?: string;
          readonly topContributions: readonly {
            readonly feature: string;
            readonly weight: number;
          }[];
        } => candidate !== null,
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.toVisitKey.localeCompare(right.toVisitKey) ||
          left.candidate.generatedAt - right.candidate.generatedAt,
      )
      .slice(0, topK);

    for (const scored of scoredCandidates) {
      const fromObservedAt = observedAtForVisit(fromVisitKey);
      const toObservedAt = observedAtForVisit(scored.toVisitKey);
      const observedAt = fromObservedAt > toObservedAt ? fromObservedAt : toObservedAt;
      upsertEdge(rankerEdges, {
        kind: 'closest_visit',
        fromNodeId: nodeIdFor('timeline-visit', fromVisitKey),
        toNodeId: nodeIdFor('timeline-visit', scored.toVisitKey),
        observedAt,
        producedBy: {
          source: 'ranker',
          revisionId: ranker.revisionId,
        },
        confidence: 'inferred',
        family: 'urlmatch',
        metadata: {
          // PR C intentionally skips aggregate per-kind score histograms in
          // focusHealth diagnostics; keep the per-edge score authoritative here.
          score: scored.score,
          ...(scored.rankerKind === undefined ? {} : { rankerKind: scored.rankerKind }),
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          candidateSources: [...scored.candidate.sources],
          primaryCandidateSource: primaryRankerCandidateSource(scored.candidate),
          topContributions: scored.topContributions,
          // Move 4 (b) — evidence-tier provenance derived from the
          // candidate source the ranker matched on (read/emit only, no
          // score/threshold change). The closest_visit edge is a ranker
          // prediction, not an embedding-revision edge, so its "produced
          // at" provenance is the ranker revision already carried in
          // producedBy.revisionId; there is no distinct endpoint-embedding
          // timestamp to stamp here.
          evidenceTier: evidenceTierForCandidateSources(scored.candidate.sources),
        },
      });
    }
  }

  return sortAlphaById([...rankerEdges.values()]);
};

const tagClosestVisitRankerEdge = (
  edge: ConnectionEdge,
  input: {
    readonly producerRevision: string;
    readonly inputFrontier: Readonly<Record<string, number>>;
  },
): ConnectionEdge => ({
  ...edge,
  metadata: {
    ...(edge.metadata ?? {}),
    producer: 'closest-visit',
    producerRevision: input.producerRevision,
    inputFrontier: input.inputFrontier,
  },
});

// ---------------------------------------------------------------------------
// Pass 1: walk events, populate nodes + emit event-derived edges.
// Pass 2: walk vault records, hydrate node metadata + emit
//         vault-derived edges.
// Pass 3: cross-cutting joins (timeline ↔ thread URL, annotation ↔
//         thread URL).
// Pass 4: content-derived URL refs — extract URLs from
//         capture.recorded turn text / dispatch.recorded body /
//         annotation.created note; emit *_references_url edges when
//         the URL matches a timeline-visit canonical key.
// Pass 5: cross-thread substring quotes — emit thread_quotes_thread
//         edges when one captured turn contains a contiguous ≥40-char
//         substring of another's.
// Pass 6: search-query content match.
// Pass 7: injected visit-similarity revision emits visit_resembles_visit.
// Pass 8: topic-clusterer active revision — emit topic nodes,
//         visit_in_topic / topic_in_workstream membership edges, and
//         topic.lineage split/merge edges.
// Pass 9: cross-replica visit evidence.
// Pass 10: hash-only snippet lineage.
// Pass 11: cross-replica continuation classifier.
// Pass 12: learned closest_visit ranker edge emission.
// Pass 13: DOM-skeleton template grouping.
// ---------------------------------------------------------------------------

export const buildConnectionsSnapshot = (input: ConnectionsInput): ConnectionsSnapshot => {
  const nodes = new Map<string, AccumNode>();
  const edges = new Map<string, ConnectionEdge>();
  let maxObservedAt = '';

  const trackObservedAt = (s: string | undefined): void => {
    if (s !== undefined && s > maxObservedAt) maxObservedAt = s;
  };

  // -------------------------------------------------------------------
  // Pass 1 — events: thread.upserted, workstream.upserted, dispatch.linked,
  // queue.created, annotation.created. Each produces a node and may emit
  // edges that are derivable from the event payload alone.
  // -------------------------------------------------------------------
  // Per-bacId event buckets. Without these, each projectThread /
  // projectWorkstream call re-filters all of input.events — at ~160k
  // events × ~100 aggregates that is 16M ops and was the dominant
  // cost of buildConnectionsSnapshot (observed ~16s, blocking
  // /v1/status). One pass populates both id sets and the per-bacId
  // event slices so each projector receives only its relevant
  // events (typically a handful).
  const threadEventsByBacId = new Map<string, AcceptedEvent[]>();
  const workstreamEventsByBacId = new Map<string, AcceptedEvent[]>();
  const pushBucket = (
    map: Map<string, AcceptedEvent[]>,
    bacId: string,
    event: AcceptedEvent,
  ): void => {
    const existing = map.get(bacId);
    if (existing === undefined) map.set(bacId, [event]);
    else existing.push(event);
  };
  for (const event of input.events) {
    if (event.type === THREAD_UPSERTED && isThreadUpsertedPayload(event.payload)) {
      pushBucket(threadEventsByBacId, event.payload.bac_id, event);
    } else if (
      (event.type === THREAD_ARCHIVED ||
        event.type === THREAD_UNARCHIVED ||
        event.type === THREAD_DELETED) &&
      isThreadStatusPayload(event.payload)
    ) {
      pushBucket(threadEventsByBacId, event.payload.bac_id, event);
    } else if (event.type === WORKSTREAM_UPSERTED && isWorkstreamUpsertedPayload(event.payload)) {
      pushBucket(workstreamEventsByBacId, event.payload.bac_id, event);
    } else if (event.type === WORKSTREAM_DELETED && isWorkstreamDeletedPayload(event.payload)) {
      pushBucket(workstreamEventsByBacId, event.payload.bac_id, event);
    }
  }

  for (const threadId of [...threadEventsByBacId.keys()].sort()) {
    const projection = projectThread(threadId, threadEventsByBacId.get(threadId) ?? []);
    if (projection.deleted) continue;
    const observedAtIso = new Date(projection.updatedAtMs).toISOString();
    trackObservedAt(observedAtIso);
    const record =
      projection.record.status === 'resolved'
        ? projection.record.value
        : projection.record.candidates[0]?.value;
    if (record === undefined) continue;
    trackObservedAt(record.lastSeenAt);
    const candidateEvents =
      projection.record.status === 'resolved'
        ? projection.record.event === undefined
          ? []
          : [projection.record.event]
        : projection.record.candidates.map((candidate) => candidate.event);
    upsertNode(nodes, {
      kind: 'thread',
      key: record.bac_id,
      label: record.title ?? record.threadUrl ?? record.bac_id,
      observedAt: record.lastSeenAt ?? observedAtIso,
      ...(candidateEvents[0] === undefined ? {} : { replicaId: candidateEvents[0].replicaId }),
      metadata: {
        provider: record.provider,
        url: record.threadUrl,
        title: record.title,
        ...(record.primaryWorkstreamId === undefined
          ? {}
          : { workstreamId: record.primaryWorkstreamId }),
        ...registerMetadata(projection.record),
      },
    });
    for (const event of candidateEvents.slice(1)) {
      upsertNode(nodes, {
        kind: 'thread',
        key: record.bac_id,
        label: record.title ?? record.threadUrl ?? record.bac_id,
        observedAt: record.lastSeenAt ?? observedAtIso,
        replicaId: event.replicaId,
      });
    }
    const membershipCandidates =
      projection.record.status === 'resolved'
        ? record.primaryWorkstreamId === undefined || projection.record.event === undefined
          ? []
          : [{ workstreamId: record.primaryWorkstreamId, event: projection.record.event }]
        : projection.record.candidates
            .filter((candidate) => candidate.value.primaryWorkstreamId !== undefined)
            .map((candidate) => ({
              workstreamId: candidate.value.primaryWorkstreamId!,
              event: candidate.event,
            }));
    for (const candidate of membershipCandidates) {
      const wsKey = candidate.workstreamId;
      upsertNode(nodes, {
        kind: 'workstream',
        key: wsKey,
        label: wsKey,
        observedAt: observedAtIso,
        replicaId: candidate.event.replicaId,
      });
      upsertEdge(edges, {
        kind: 'thread_in_workstream',
        fromNodeId: nodeIdFor('thread', record.bac_id),
        toNodeId: nodeIdFor('workstream', wsKey),
        observedAt: observedAtIso,
        producedBy: {
          source: 'event-log',
          eventType: THREAD_UPSERTED,
          dot: candidate.event,
        },
        confidence: 'asserted',
        ...(projection.record.status === 'resolved'
          ? {}
          : { metadata: { causalRegisterStatus: 'conflict' } }),
      });
    }
  }

  for (const workstreamId of [...workstreamEventsByBacId.keys()].sort()) {
    const projection = projectWorkstream(
      workstreamId,
      workstreamEventsByBacId.get(workstreamId) ?? [],
    );
    if (projection.deleted) continue;
    const observedAtIso = new Date(projection.updatedAtMs).toISOString();
    trackObservedAt(observedAtIso);
    const record =
      projection.record.status === 'resolved'
        ? projection.record.value
        : projection.record.candidates[0]?.value;
    if (record === undefined) continue;
    const candidateEvents =
      projection.record.status === 'resolved'
        ? projection.record.event === undefined
          ? []
          : [projection.record.event]
        : projection.record.candidates.map((candidate) => candidate.event);
    upsertNode(nodes, {
      kind: 'workstream',
      key: record.bac_id,
      label: record.title ?? record.bac_id,
      observedAt: observedAtIso,
      ...(candidateEvents[0] === undefined ? {} : { replicaId: candidateEvents[0].replicaId }),
      metadata: {
        title: record.title,
        ...registerMetadata(projection.record),
      },
    });
    for (const event of candidateEvents.slice(1)) {
      upsertNode(nodes, {
        kind: 'workstream',
        key: record.bac_id,
        label: record.title ?? record.bac_id,
        observedAt: observedAtIso,
        replicaId: event.replicaId,
      });
    }
    const parentCandidates =
      projection.record.status === 'resolved'
        ? record.parentId === undefined || projection.record.event === undefined
          ? []
          : [{ parentId: record.parentId, event: projection.record.event }]
        : projection.record.candidates
            .filter((candidate) => candidate.value.parentId !== undefined)
            .map((candidate) => ({
              parentId: candidate.value.parentId!,
              event: candidate.event,
            }));
    for (const candidate of parentCandidates) {
      upsertNode(nodes, {
        kind: 'workstream',
        key: candidate.parentId,
        label: candidate.parentId,
        observedAt: observedAtIso,
        replicaId: candidate.event.replicaId,
      });
      upsertEdge(edges, {
        kind: 'workstream_parent_of',
        fromNodeId: nodeIdFor('workstream', candidate.parentId),
        toNodeId: nodeIdFor('workstream', record.bac_id),
        observedAt: observedAtIso,
        producedBy: {
          source: 'event-log',
          eventType: WORKSTREAM_UPSERTED,
          dot: candidate.event,
        },
        confidence: 'asserted',
        ...(projection.record.status === 'resolved'
          ? {}
          : { metadata: { causalRegisterStatus: 'conflict' } }),
      });
    }
  }

  for (const event of input.events) {
    const observedAtIso = new Date(event.acceptedAtMs).toISOString();
    trackObservedAt(observedAtIso);
    const replicaId = event.dot.replicaId;

    if (
      event.type === THREAD_UPSERTED ||
      event.type === THREAD_ARCHIVED ||
      event.type === THREAD_UNARCHIVED ||
      event.type === THREAD_DELETED ||
      event.type === WORKSTREAM_UPSERTED ||
      event.type === WORKSTREAM_DELETED
    ) {
      continue;
    }

    if (event.type === DISPATCH_LINKED && isDispatchLinkedPayload(event.payload)) {
      const p = event.payload;
      // Both endpoint nodes — they're populated more richly by
      // vault records in pass 2; this lazy creation guarantees the
      // edge points at SOMETHING.
      upsertNode(nodes, {
        kind: 'dispatch',
        key: p.dispatchId,
        label: p.dispatchId,
        observedAt: observedAtIso,
        replicaId,
      });
      upsertNode(nodes, {
        kind: 'thread',
        key: p.threadId,
        label: p.threadId,
        observedAt: observedAtIso,
        replicaId,
      });
      upsertEdge(edges, {
        kind: 'dispatch_reply_landed_in_thread',
        fromNodeId: nodeIdFor('dispatch', p.dispatchId),
        toNodeId: nodeIdFor('thread', p.threadId),
        observedAt: observedAtIso,
        producedBy: {
          source: 'event-log',
          eventType: DISPATCH_LINKED,
          dot: { replicaId, seq: event.dot.seq },
        },
        confidence: 'observed',
      });
      continue;
    }

    if (event.type === QUEUE_CREATED && isQueueCreatedPayload(event.payload)) {
      const p = event.payload;
      const label = p.text.length > 0 ? p.text.slice(0, 80) : p.bac_id;
      upsertNode(nodes, {
        kind: 'queue-item',
        key: p.bac_id,
        label,
        observedAt: observedAtIso,
        replicaId,
        metadata: {
          ...(p.status === undefined ? {} : { status: p.status }),
          title: label,
        },
      });
      if (typeof p.targetId === 'string' && p.targetId.length > 0) {
        if (p.scope === 'thread') {
          upsertNode(nodes, {
            kind: 'thread',
            key: p.targetId,
            label: p.targetId,
            observedAt: observedAtIso,
            replicaId,
          });
          upsertEdge(edges, {
            kind: 'queue_targets_thread',
            fromNodeId: nodeIdFor('queue-item', p.bac_id),
            toNodeId: nodeIdFor('thread', p.targetId),
            observedAt: observedAtIso,
            producedBy: {
              source: 'event-log',
              eventType: QUEUE_CREATED,
              dot: { replicaId, seq: event.dot.seq },
            },
            confidence: 'asserted',
          });
        } else if (p.scope === 'workstream') {
          upsertNode(nodes, {
            kind: 'workstream',
            key: p.targetId,
            label: p.targetId,
            observedAt: observedAtIso,
            replicaId,
          });
          upsertEdge(edges, {
            kind: 'queue_targets_workstream',
            fromNodeId: nodeIdFor('queue-item', p.bac_id),
            toNodeId: nodeIdFor('workstream', p.targetId),
            observedAt: observedAtIso,
            producedBy: {
              source: 'event-log',
              eventType: QUEUE_CREATED,
              dot: { replicaId, seq: event.dot.seq },
            },
            confidence: 'asserted',
          });
        }
      }
      continue;
    }

    if (event.type === ANNOTATION_CREATED && isAnnotationCreatedPayload(event.payload)) {
      const p = event.payload;
      upsertNode(nodes, {
        kind: 'annotation',
        key: p.bac_id,
        label: p.note.length > 0 ? p.note.slice(0, 80) : p.bac_id,
        observedAt: observedAtIso,
        replicaId,
        metadata: {
          url: p.url,
          title: p.pageTitle,
        },
      });
      // The annotation_targets_thread edge is materialized in
      // pass 3 (it requires URL matching against thread records).
      continue;
    }
  }

  // -------------------------------------------------------------------
  // Pass 2 — vault records. These provide rich metadata that the
  // event payloads don't carry (dispatch sourceThreadId, mcpRequest,
  // workstream.children, coding session details, reminders).
  // -------------------------------------------------------------------
  for (const t of input.threads) {
    upsertNode(nodes, {
      kind: 'thread',
      key: t.bac_id,
      label: t.title ?? t.threadUrl ?? t.bac_id,
      ...(t.lastSeenAt === undefined ? {} : { observedAt: t.lastSeenAt }),
      metadata: {
        ...(t.provider === undefined ? {} : { provider: t.provider }),
        ...(t.threadUrl === undefined ? {} : { url: t.threadUrl }),
        ...((t.canonicalUrl ?? t.threadUrl) ? { canonicalUrl: t.canonicalUrl ?? t.threadUrl } : {}),
        ...(t.title === undefined ? {} : { title: t.title }),
      },
    });
    // The thread vault record is the projection source-of-truth for
    // current primaryWorkstreamId. Emit `thread_in_workstream` from
    // here as well as from THREAD_UPSERTED events — otherwise a
    // partial-log scenario (catchup, archive-import) would be missing
    // the membership edge whenever the upsert event has scrolled out.
    if (typeof t.primaryWorkstreamId === 'string' && t.primaryWorkstreamId.length > 0) {
      upsertNode(nodes, {
        kind: 'workstream',
        key: t.primaryWorkstreamId,
        label: t.primaryWorkstreamId,
      });
      upsertEdge(edges, {
        kind: 'thread_in_workstream',
        fromNodeId: nodeIdFor('thread', t.bac_id),
        toNodeId: nodeIdFor('workstream', t.primaryWorkstreamId),
        observedAt: t.lastSeenAt ?? '',
        producedBy: { source: 'workboard-state', recordId: t.bac_id },
        confidence: 'asserted',
      });
    }
  }
  for (const w of input.workstreams) {
    upsertNode(nodes, {
      kind: 'workstream',
      key: w.bac_id,
      label: w.title ?? w.bac_id,
      metadata: { title: w.title },
    });
    // Treat children[] as a richer source than parentId — a parent
    // record IS the source of truth for the parent_of relationship
    // (a child's parentId might lag if events arrive out of order).
    if (Array.isArray(w.children)) {
      for (const childId of w.children) {
        if (typeof childId !== 'string' || childId.length === 0) continue;
        upsertNode(nodes, { kind: 'workstream', key: childId, label: childId });
        upsertEdge(edges, {
          kind: 'workstream_parent_of',
          fromNodeId: nodeIdFor('workstream', w.bac_id),
          toNodeId: nodeIdFor('workstream', childId),
          observedAt: '', // vault record without observedAt; sentinel sorts first
          producedBy: { source: 'workboard-state', recordId: w.bac_id },
          confidence: 'asserted',
        });
      }
    }
  }
  for (const d of input.dispatches) {
    trackObservedAt(d.createdAt);
    upsertNode(nodes, {
      kind: 'dispatch',
      key: d.bac_id,
      label: d.title ?? d.bac_id,
      ...(d.createdAt === undefined ? {} : { observedAt: d.createdAt }),
      metadata: {
        ...(d.target?.provider === undefined ? {} : { provider: d.target.provider }),
        ...(d.title === undefined ? {} : { title: d.title }),
        ...(d.status === undefined ? {} : { status: d.status }),
      },
    });
    if (typeof d.sourceThreadId === 'string' && d.sourceThreadId.length > 0) {
      upsertNode(nodes, { kind: 'thread', key: d.sourceThreadId, label: d.sourceThreadId });
      upsertEdge(edges, {
        kind: 'dispatch_from_thread',
        fromNodeId: nodeIdFor('thread', d.sourceThreadId),
        toNodeId: nodeIdFor('dispatch', d.bac_id),
        observedAt: d.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: d.bac_id },
        confidence: 'asserted',
      });
    }
    if (typeof d.workstreamId === 'string' && d.workstreamId.length > 0) {
      upsertNode(nodes, { kind: 'workstream', key: d.workstreamId, label: d.workstreamId });
      upsertEdge(edges, {
        kind: 'dispatch_in_workstream',
        fromNodeId: nodeIdFor('dispatch', d.bac_id),
        toNodeId: nodeIdFor('workstream', d.workstreamId),
        observedAt: d.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: d.bac_id },
        confidence: 'asserted',
      });
    }
    if (typeof d.mcpRequest?.codingSessionId === 'string') {
      upsertNode(nodes, {
        kind: 'coding-session',
        key: d.mcpRequest.codingSessionId,
        label: d.mcpRequest.codingSessionId,
      });
      upsertEdge(edges, {
        kind: 'dispatch_requested_coding_session',
        fromNodeId: nodeIdFor('dispatch', d.bac_id),
        toNodeId: nodeIdFor('coding-session', d.mcpRequest.codingSessionId),
        observedAt: d.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: d.bac_id },
        confidence: 'asserted',
      });
    }
  }
  for (const q of input.queueItems) {
    upsertNode(nodes, {
      kind: 'queue-item',
      key: q.bac_id,
      label: q.title ?? q.bac_id,
      ...(q.createdAt === undefined ? {} : { observedAt: q.createdAt }),
      metadata: {
        ...(q.title === undefined ? {} : { title: q.title }),
        ...(q.status === undefined ? {} : { status: q.status }),
      },
    });
    // Resolve target via vault (covers cases where queue.created
    // wasn't in the events window).
    const tid = q.threadId ?? (q.scope === 'thread' ? q.targetId : undefined);
    const wid = q.workstreamId ?? (q.scope === 'workstream' ? q.targetId : undefined);
    if (typeof tid === 'string' && tid.length > 0) {
      upsertNode(nodes, { kind: 'thread', key: tid, label: tid });
      upsertEdge(edges, {
        kind: 'queue_targets_thread',
        fromNodeId: nodeIdFor('queue-item', q.bac_id),
        toNodeId: nodeIdFor('thread', tid),
        observedAt: q.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: q.bac_id },
        confidence: 'asserted',
      });
    }
    if (typeof wid === 'string' && wid.length > 0) {
      upsertNode(nodes, { kind: 'workstream', key: wid, label: wid });
      upsertEdge(edges, {
        kind: 'queue_targets_workstream',
        fromNodeId: nodeIdFor('queue-item', q.bac_id),
        toNodeId: nodeIdFor('workstream', wid),
        observedAt: q.createdAt ?? '',
        producedBy: { source: 'workboard-state', recordId: q.bac_id },
        confidence: 'asserted',
      });
    }
  }
  // Inbound-reminder projection (2026-05-27): suppressed by default.
  // Every chatgpt capture writes a reminder record to `_BAC/reminders/`
  // with status='new', and the prior projection promoted each one to
  // a graph node + reminder_for_thread edge. Per user audit: on a
  // mature vault this is 400+ vestigial "new" reminders polluting
  // node and edge counts (~6% of nodes), and the follow-up UI flow
  // these were meant to power was never wired. We KEEP the JSON
  // records on disk (a future inbox feature can read them directly)
  // but stop projecting them into the connections graph. To re-enable
  // for a real reminder-inbox surface: filter to status !== 'new' OR
  // gate on an explicit env / user-pref flag.
  for (const r of input.reminders) {
    void r;
  }
  for (const c of input.codingSessions) {
    const obs = c.lastSeenAt ?? c.attachedAt;
    trackObservedAt(obs);
    upsertNode(nodes, {
      kind: 'coding-session',
      key: c.bac_id,
      label: c.name ?? c.bac_id,
      ...(obs === undefined ? {} : { observedAt: obs }),
      metadata: {
        ...(c.status === undefined ? {} : { status: c.status }),
        ...(c.name === undefined ? {} : { title: c.name }),
        ...(c.cwd === undefined ? {} : { sourcePath: c.cwd }),
        ...(c.tool === undefined ? {} : { provider: c.tool }),
      },
    });
    if (typeof c.workstreamId === 'string' && c.workstreamId.length > 0) {
      upsertNode(nodes, { kind: 'workstream', key: c.workstreamId, label: c.workstreamId });
      upsertEdge(edges, {
        kind: 'coding_session_in_workstream',
        fromNodeId: nodeIdFor('coding-session', c.bac_id),
        toNodeId: nodeIdFor('workstream', c.workstreamId),
        observedAt: c.attachedAt ?? '',
        producedBy: { source: 'coding-session-store', recordId: c.bac_id },
        confidence: 'asserted',
      });
    }
  }

  // -------------------------------------------------------------------
  // Pass 3 — cross-cutting joins by canonical URL.
  //   timeline_same_url_as_thread:    timeline visit URL ↔ thread URL
  //   annotation_targets_thread:      annotation URL ↔ thread URL
  // -------------------------------------------------------------------
  // Build URL → thread id map. canonicalUrl preferred; fall back to
  // threadUrl (with fragment + trailing-slash normalization).
  const threadIdByUrl = new Map<string, string>();
  const threadByBacId = new Map<string, ThreadVaultRecord>();
  const visitObservedAtByKey = new Map<string, string>();
  for (const t of input.threads) {
    threadByBacId.set(t.bac_id, t);
    const candidate = t.canonicalUrl ?? t.threadUrl;
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    threadIdByUrl.set(stripFragmentAndTrailingSlash(candidate), t.bac_id);
  }
  // Add timeline visit nodes; emit timeline_same_url_as_thread edges
  // when there's a thread match.
  const engagementClassByCanonicalUrl = new Map<
    string,
    EngagementClassRevision['classifications'][number]
  >();
  for (const classification of input.engagementClassRevision?.classifications ?? []) {
    engagementClassByCanonicalUrl.set(
      stripFragmentAndTrailingSlash(classification.canonicalUrl),
      classification,
    );
  }

  for (const day of input.timelineDays) {
    trackObservedAt(day.updatedAt);
    for (const entry of day.entries) {
      const visitKey = stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);
      const urlAttribution = currentUrlAttributionFor(input, visitKey);
      const effectiveVisitWorkstreamId =
        urlAttribution === undefined
          ? entry.workstreamId !== undefined && entry.workstreamId.length > 0
            ? entry.workstreamId
            : undefined
          : urlAttribution.workstreamId === null
            ? undefined
            : urlAttribution.workstreamId;
      const priorVisitObservedAt = visitObservedAtByKey.get(visitKey);
      if (priorVisitObservedAt === undefined || entry.lastSeenAt > priorVisitObservedAt) {
        visitObservedAtByKey.set(visitKey, entry.lastSeenAt);
      }
      // Extract the search query from search-shaped URLs so pass 6
      // can deterministically match it against captured turn text /
      // dispatch bodies / annotation notes. Host-agnostic detection
      // — see timeline/sanitize.ts:detectSearchUrl.
      const searchInfo = detectSearchUrl(entry.canonicalUrl ?? entry.url);
      const searchQuery = searchInfo === null ? undefined : searchInfo.query.trim().toLowerCase();
      const engagementClass = engagementClassByCanonicalUrl.get(visitKey);
      upsertNode(nodes, {
        kind: 'timeline-visit',
        key: visitKey,
        label: entry.title ?? visitKey,
        observedAt: entry.lastSeenAt,
        metadata: {
          url: entry.url,
          canonicalUrl: entry.canonicalUrl,
          title: entry.title,
          provider: entry.provider,
          visitCount: entry.visitCount,
          // 2026-05 fix: surface the active-workstream id the
          // extension stamped onto the timeline event (TimelineEntry
          // carries it from the observer; the e2e suite asserts
          // `metadata.workstreamId === <wsId>` on every captured
          // timeline-visit, and the snapshot was silently dropping
          // it). The visit_in_workstream edge is also emitted later
          // in the pass — this metadata is the "what flow was the
          // user in when this happened" hint, separate from the
          // edge.
          ...(effectiveVisitWorkstreamId === undefined
            ? {}
            : {
                workstreamId: effectiveVisitWorkstreamId,
                workstreamAttributionOrigin:
                  urlAttribution === undefined ? 'timeline-entry' : 'canonical-url',
              }),
          ...(searchQuery === undefined ? {} : { searchQuery }),
          ...(engagementClass === undefined
            ? {}
            : {
                engagement: {
                  class: engagementClass.class,
                  focusedWindowMs: engagementClass.focusedWindowMs,
                  scrollEvents: engagementClass.scrollEvents,
                },
              }),
          ...pageEvidenceField(input, visitKey),
        },
      });
      // 2026-05 fix: emit the `visit_in_workstream` edge that the
      // ranker, similarity producer, and tab-session resolver all
      // consume but no companion code was producing. The original
      // intent (see `timeline/events.ts` "Phase 2 restores
      // visit_in_workstream") was to restore it via explicit
      // tab-session attribution — that path never landed, leaving
      // every consumer staring at empty arrays. The extension now
      // stamps `workstreamId` on every timeline event (via the
      // active-workstream cache in `timeline/wiring.ts`), so the
      // projection's `entry.workstreamId` is populated for ambient
      // browsing inside a focused workstream. Emit one edge per
      // (visit, workstream) pair so the snapshot reflects the
      // attribution.
      if (effectiveVisitWorkstreamId !== undefined) {
        upsertNode(nodes, {
          kind: 'workstream',
          key: effectiveVisitWorkstreamId,
          label: effectiveVisitWorkstreamId,
        });
        if (urlAttribution !== undefined && urlAttribution.workstreamId !== null) {
          upsertEdge(edges, {
            kind: 'visit_in_workstream',
            fromNodeId: nodeIdFor('timeline-visit', visitKey),
            toNodeId: nodeIdFor('workstream', effectiveVisitWorkstreamId),
            observedAt: urlAttribution.observedAt,
            producedBy: {
              source: 'event-log',
              eventType:
                urlAttribution.source === 'inferred'
                  ? URL_ATTRIBUTION_INFERRED
                  : USER_ORGANIZED_ITEM,
              dot: { replicaId: urlAttribution.replicaId, seq: urlAttribution.seq },
            },
            confidence: urlAttribution.source === 'inferred' ? 'inferred' : 'asserted',
            metadata: {
              attributionSource: urlAttribution.source,
              attributionOrigin: 'canonical-url',
            },
          });
        } else {
          upsertEdge(edges, {
            kind: 'visit_in_workstream',
            fromNodeId: nodeIdFor('timeline-visit', visitKey),
            toNodeId: nodeIdFor('workstream', effectiveVisitWorkstreamId),
            observedAt: entry.lastSeenAt,
            producedBy: { source: 'timeline-projection' },
            // 'inferred' — the active-workstream pointer at observation
            // time is an inference about user intent, not a direct
            // observation about the URL→workstream relationship. The
            // sister `timeline_same_url_as_thread` edge nearby also
            // uses 'inferred' for the same reason. The e2e suite at
            // `connections-mvp-user-story.spec.ts:291` and downstream
            // resolver code rely on this classification to decide
            // whether to weight the edge as evidence.
            confidence: 'inferred',
          });
        }
      }
      const threadId = threadIdByUrl.get(visitKey);
      if (threadId !== undefined) {
        const thread = threadByBacId.get(threadId);
        const evidence = evaluateTimelineSameUrlAsThreadGate({
          ...(entry.title === undefined ? {} : { visitTitle: entry.title }),
          ...(entry.provider === undefined ? {} : { visitProvider: entry.provider }),
          visitObservedAt: entry.lastSeenAt,
          ...(thread?.title === undefined ? {} : { threadTitle: thread.title }),
          ...(thread?.provider === undefined ? {} : { threadProvider: thread.provider }),
          ...(thread?.lastSeenAt === undefined ? {} : { threadLastSeenAt: thread.lastSeenAt }),
        });
        if (evidence !== null) {
          upsertNode(nodes, { kind: 'thread', key: threadId, label: threadId });
          upsertEdge(edges, {
            kind: 'timeline_same_url_as_thread',
            fromNodeId: nodeIdFor('timeline-visit', visitKey),
            toNodeId: nodeIdFor('thread', threadId),
            observedAt: entry.lastSeenAt,
            producedBy: { source: 'timeline-projection' },
            confidence: 'inferred',
            metadata: {
              evidence: {
                providerMatched: evidence.providerMatched,
                titleJaccard: Number(evidence.titleJaccard.toFixed(4)),
                ...(evidence.recencyDeltaMs === null
                  ? {}
                  : { recencyDeltaMs: evidence.recencyDeltaMs }),
              },
            },
          });
        }
      }
    }
  }

  for (const instance of collectVisitInstances({
    events: input.events,
    timelineDays: input.timelineDays,
  })) {
    const instanceKey = visitInstanceKey(instance);
    const instanceNodeId = nodeIdFor(VISIT_INSTANCE_NODE_KIND, instanceKey);
    const timelineVisitNodeId = nodeIdFor('timeline-visit', instance.visitKey);
    // Engagement is URL-aggregate (the classifier keys by canonicalUrl,
    // not by tab session). Mirroring the same blob onto every
    // visit-instance of the URL means three tabs of the same page will
    // report the same "focused 2m 30s" — known trade-off, called out in
    // the Flow Path tooltip.
    const instanceEngagement = engagementClassByCanonicalUrl.get(instance.visitKey);
    upsertNode(nodes, {
      kind: VISIT_INSTANCE_NODE_KIND,
      key: instanceKey,
      label: instance.title ?? instance.visitKey,
      observedAt: instance.firstSeenAt,
      metadata: {
        url: instance.url,
        canonicalUrl: instance.canonicalUrl,
        title: instance.title,
        provider: instance.provider,
        visitCount: instance.visitCount,
        tabSessionId: instance.tabSessionId,
        timelineVisitId: timelineVisitNodeId,
        ...(instanceEngagement === undefined
          ? {}
          : {
              engagement: {
                class: instanceEngagement.class,
                focusedWindowMs: instanceEngagement.focusedWindowMs,
                scrollEvents: instanceEngagement.scrollEvents,
              },
            }),
      },
    });
    for (const replicaId of [...instance.replicaIds].sort()) {
      upsertNode(nodes, {
        kind: VISIT_INSTANCE_NODE_KIND,
        key: instanceKey,
        label: instance.title ?? instance.visitKey,
        observedAt: instance.firstSeenAt,
        replicaId,
      });
    }
    upsertNode(nodes, {
      kind: 'timeline-visit',
      key: instance.visitKey,
      label: instance.title ?? instance.visitKey,
      observedAt: instance.lastSeenAt,
      metadata: {
        url: instance.url,
        canonicalUrl: instance.canonicalUrl,
        title: instance.title,
        provider: instance.provider,
        ...pageEvidenceField(input, instance.visitKey),
      },
    });
    // Hydrate the tab-session node from the projection so frontend
    // surfaces (Connections nodes, AttributionProvenance anchors,
    // FlowPath labels) can render a human-friendly title instead of
    // the raw tabSessionId. The frontend's entityDisplay layer is the
    // load-bearing guard against id leaks — this just makes the
    // server-side label informative too.
    const tabSessionRecord = input.tabSessionProjection.bySessionId.get(instance.tabSessionId);
    const tabSessionLatestTitle = tabSessionRecord?.latestTitle;
    const tabSessionLatestUrl = tabSessionRecord?.latestUrl;
    const tabSessionProvider = tabSessionRecord?.provider ?? instance.provider;
    const tabSessionLastActivityAt = tabSessionRecord?.lastActivityAt;
    const hostFromUrl = (raw: string | undefined): string | undefined => {
      if (raw === undefined || raw.length === 0) return undefined;
      try {
        const host = new URL(raw).host;
        return host.length > 0 ? host : undefined;
      } catch {
        return undefined;
      }
    };
    // Last-resort label is the kind-name placeholder, never the raw
    // tses_ id — the extension's entityDisplay also strips id-like
    // labels, but the wire should not carry them in the first place.
    const tabSessionLabel =
      tabSessionLatestTitle ??
      instance.title ??
      hostFromUrl(tabSessionLatestUrl ?? instance.url) ??
      '(tab session)';
    upsertNode(nodes, {
      kind: 'tab-session',
      key: instance.tabSessionId,
      label: tabSessionLabel,
      observedAt: instance.firstSeenAt,
      metadata: {
        latestTitle: tabSessionLatestTitle,
        latestUrl: tabSessionLatestUrl,
        canonicalUrl: instance.canonicalUrl,
        provider: tabSessionProvider,
        lastActivityAt: tabSessionLastActivityAt,
      },
    });
    upsertEdge(edges, {
      kind: 'visit_instance_same_url_as_timeline_visit',
      fromNodeId: instanceNodeId,
      toNodeId: timelineVisitNodeId,
      observedAt: instance.firstSeenAt,
      producedBy: { source: 'timeline-projection' },
      confidence: 'observed',
    });
    upsertEdge(edges, {
      kind: 'visit_instance_in_tab_session',
      fromNodeId: instanceNodeId,
      toNodeId: nodeIdFor('tab-session', instance.tabSessionId),
      observedAt: instance.firstSeenAt,
      producedBy: { source: 'timeline-projection' },
      confidence: 'observed',
    });
    if (
      instance.openerTabSessionId !== undefined &&
      instance.openerTabSessionId.length > 0 &&
      instance.openerTabSessionId !== instance.tabSessionId
    ) {
      // Same hydration for the opener — degrade gracefully when its
      // projection record is absent.
      const openerRecord = input.tabSessionProjection.bySessionId.get(instance.openerTabSessionId);
      const openerLabel =
        openerRecord?.latestTitle ?? hostFromUrl(openerRecord?.latestUrl) ?? '(tab session)';
      upsertNode(nodes, {
        kind: 'tab-session',
        key: instance.openerTabSessionId,
        label: openerLabel,
        ...(openerRecord === undefined
          ? {}
          : {
              metadata: {
                latestTitle: openerRecord.latestTitle,
                latestUrl: openerRecord.latestUrl,
                provider: openerRecord.provider,
                lastActivityAt: openerRecord.lastActivityAt,
              },
            }),
      });
      upsertEdge(edges, {
        kind: 'tab_session_opener_chain',
        fromNodeId: nodeIdFor('tab-session', instance.tabSessionId),
        toNodeId: nodeIdFor('tab-session', instance.openerTabSessionId),
        observedAt: instance.firstSeenAt,
        producedBy: { source: 'timeline-projection' },
        confidence: 'observed',
      });
    }
    // URL attribution is the primary source for `visit_instance_in_workstream`
    // edges — the user attributes pages, not tabs. Tab-session attribution
    // still drives `tab_session_in_workstream` and acts as a fallback when
    // no URL attribution exists yet.
    //
    // Stage 5 / T6 — `tab_session_in_workstream` is intentionally
    // dormant in dogfood post-Phase-B: the side panel currently routes
    // user moves to `itemKind='canonical-url'`, so user-asserted
    // tab-session attributions arrive only from cross-replica sync or
    // legacy clients. Do not delete the projection / route / emission
    // path — it remains the only way tab-group pulls, sticky labels,
    // and older replicas express attribution. T1 diagnostics report
    // `tabSessionAttributionInferredCount` and
    // `userAssertions.byItemKind['tab-session']` so dormancy is
    // measurable. See `docs/architecture.md` § Stage 5 / Class B edge
    // inventory.
    const lookupCanonical = instance.canonicalUrl ?? instance.url;
    const urlAttribution =
      lookupCanonical === undefined ? undefined : currentUrlAttributionFor(input, lookupCanonical);
    const tabSessionAttribution = input.tabSessionProjection.bySessionId.get(
      instance.tabSessionId,
    )?.currentAttribution;
    if (tabSessionAttribution !== undefined && tabSessionAttribution.workstreamId !== null) {
      upsertNode(nodes, {
        kind: 'workstream',
        key: tabSessionAttribution.workstreamId,
        label: tabSessionAttribution.workstreamId,
      });
      upsertEdge(edges, {
        kind: 'tab_session_in_workstream',
        fromNodeId: nodeIdFor('tab-session', instance.tabSessionId),
        toNodeId: nodeIdFor('workstream', tabSessionAttribution.workstreamId),
        observedAt: tabSessionAttribution.observedAt,
        producedBy: {
          source: 'event-log',
          eventType:
            tabSessionAttribution.source === 'inferred'
              ? TAB_SESSION_ATTRIBUTION_INFERRED
              : USER_ORGANIZED_ITEM,
          dot: { replicaId: tabSessionAttribution.replicaId, seq: tabSessionAttribution.seq },
        },
        confidence: tabSessionAttribution.source === 'inferred' ? 'inferred' : 'asserted',
        metadata: { attributionSource: tabSessionAttribution.source },
      });
    }
    // Pick the effective attribution for the visit-instance: URL takes
    // precedence; tab-session is the fallback.
    const effective =
      urlAttribution !== undefined
        ? urlAttribution.workstreamId === null
          ? null
          : { ...urlAttribution, origin: 'canonical-url' as const }
        : tabSessionAttribution !== undefined && tabSessionAttribution.workstreamId !== null
          ? { ...tabSessionAttribution, origin: 'tab-session' as const }
          : null;
    if (effective === null || effective.workstreamId === null) continue;
    upsertNode(nodes, {
      kind: 'workstream',
      key: effective.workstreamId,
      label: effective.workstreamId,
    });
    upsertEdge(edges, {
      kind: 'visit_instance_in_workstream',
      fromNodeId: instanceNodeId,
      toNodeId: nodeIdFor('workstream', effective.workstreamId),
      observedAt: instance.firstSeenAt,
      producedBy: {
        source: 'event-log',
        eventType:
          effective.source === 'inferred'
            ? effective.origin === 'canonical-url'
              ? URL_ATTRIBUTION_INFERRED
              : TAB_SESSION_ATTRIBUTION_INFERRED
            : USER_ORGANIZED_ITEM,
        dot: { replicaId: effective.replicaId, seq: effective.seq },
      },
      confidence: effective.source === 'inferred' ? 'inferred' : 'asserted',
      metadata: {
        attributionSource: effective.source,
        attributionOrigin: effective.origin,
      },
    });
  }

  const navigationByVisitId = new Map<
    string,
    {
      readonly canonicalUrl: string;
      readonly observedAt: string;
      readonly payload: NavigationCommittedPayload;
      readonly event: AcceptedEvent;
    }
  >();
  for (const event of input.events) {
    if (event.type !== NAVIGATION_COMMITTED) continue;
    if (!isNavigationCommittedPayload(event.payload)) continue;
    const canonicalUrl = stripFragmentAndTrailingSlash(event.payload.canonicalUrl);
    if (canonicalUrl.length === 0) continue;
    const observedAt = new Date(event.payload.commitTimestamp);
    if (!Number.isFinite(observedAt.getTime())) continue;
    navigationByVisitId.set(event.payload.visitId, {
      canonicalUrl,
      observedAt: observedAt.toISOString(),
      payload: event.payload,
      event,
    });
  }

  const visitNodeIdForNavigationVisit = (visitId: string): string => {
    const navigation = navigationByVisitId.get(visitId);
    return nodeIdFor('timeline-visit', navigation?.canonicalUrl ?? visitId);
  };

  const ensureNavigationVisitNode = (visitId: string): void => {
    const navigation = navigationByVisitId.get(visitId);
    if (navigation === undefined) {
      upsertNode(nodes, { kind: 'timeline-visit', key: visitId, label: visitId });
      return;
    }
    upsertNode(nodes, {
      kind: 'timeline-visit',
      key: navigation.canonicalUrl,
      label: navigation.payload.url,
      observedAt: navigation.observedAt,
      replicaId: navigation.event.dot.replicaId,
      metadata: {
        url: navigation.payload.url,
        canonicalUrl: navigation.canonicalUrl,
        tabSessionIdHash: navigation.payload.tabSessionIdHash,
        windowSessionIdHash: navigation.payload.windowSessionIdHash,
        navigationSequence: navigation.payload.navigationSequence,
      },
    });
  };

  const emitNavigationEdge = (input: {
    readonly kind: 'previous_visit_in_tab_session' | 'opener_visit';
    readonly fromVisitId: string;
    readonly toVisitId: string;
    readonly current: {
      readonly observedAt: string;
      readonly payload: NavigationCommittedPayload;
      readonly event: AcceptedEvent;
    };
  }): void => {
    ensureNavigationVisitNode(input.fromVisitId);
    ensureNavigationVisitNode(input.toVisitId);
    const fromNodeId = visitNodeIdForNavigationVisit(input.fromVisitId);
    const toNodeId = visitNodeIdForNavigationVisit(input.toVisitId);
    if (fromNodeId === toNodeId) return;
    upsertEdge(edges, {
      kind: input.kind,
      fromNodeId,
      toNodeId,
      observedAt: input.current.observedAt,
      producedBy: {
        source: 'event-log',
        eventType: NAVIGATION_COMMITTED,
        dot: {
          replicaId: input.current.event.dot.replicaId,
          seq: input.current.event.dot.seq,
        },
      },
      confidence: 'observed',
      metadata: {
        currentVisitId: input.current.payload.visitId,
        tabSessionIdHash: input.current.payload.tabSessionIdHash,
        navigationSequence: input.current.payload.navigationSequence,
      },
    });
  };

  for (const current of navigationByVisitId.values()) {
    if (current.payload.previousVisitId !== null) {
      emitNavigationEdge({
        kind: 'previous_visit_in_tab_session',
        fromVisitId: current.payload.previousVisitId,
        toVisitId: current.payload.visitId,
        current,
      });
    }
    if (current.payload.openerVisitId !== null) {
      emitNavigationEdge({
        kind: 'opener_visit',
        fromVisitId: current.payload.openerVisitId,
        toVisitId: current.payload.visitId,
        current,
      });
    }
  }
  // Annotations → thread (URL match).
  for (const event of input.events) {
    if (event.type !== ANNOTATION_CREATED) continue;
    if (!isAnnotationCreatedPayload(event.payload)) continue;
    const url = event.payload.url;
    if (typeof url !== 'string' || url.length === 0) continue;
    const threadId = threadIdByUrl.get(stripFragmentAndTrailingSlash(url));
    if (threadId === undefined) continue;
    upsertNode(nodes, { kind: 'thread', key: threadId, label: threadId });
    upsertEdge(edges, {
      kind: 'annotation_targets_thread',
      fromNodeId: nodeIdFor('annotation', event.payload.bac_id),
      toNodeId: nodeIdFor('thread', threadId),
      observedAt: new Date(event.acceptedAtMs).toISOString(),
      producedBy: {
        source: 'event-log',
        eventType: ANNOTATION_CREATED,
        dot: { replicaId: event.dot.replicaId, seq: event.dot.seq },
      },
      confidence: 'observed',
    });
  }

  // -------------------------------------------------------------------
  // Pass 4 — content-derived URL refs. For each event whose payload
  // carries free text that may include URLs (capture turns, dispatch
  // bodies, annotation notes), pull URLs through the same canonical-
  // form pipeline timeline visits use, then emit a *_references_url
  // edge whenever the URL matches an existing timeline-visit node.
  //
  // Skip on no-match — no phantom visit nodes (same posture as
  // timeline_same_url_as_thread).
  // -------------------------------------------------------------------
  const visitIdByCanonical = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== 'timeline-visit') continue;
    // Visit node keys are the canonical URL (post-strip) by
    // construction in pass 3. Re-derive from metadata defensively in
    // case future code paths add timeline-visit nodes elsewhere.
    const canonicalUrl =
      (typeof node.metadata['canonicalUrl'] === 'string'
        ? node.metadata['canonicalUrl']
        : undefined) ??
      (typeof node.metadata['url'] === 'string' ? node.metadata['url'] : undefined);
    const key =
      canonicalUrl !== undefined
        ? stripFragmentAndTrailingSlash(canonicalUrl)
        : node.id.slice('timeline-visit:'.length);
    visitIdByCanonical.set(key, node.id);
  }

  const emitUrlRefEdge = (input: {
    fromNodeId: string;
    canonicalUrl: string;
    observedAt: string;
    kind: 'thread_references_url' | 'dispatch_references_url' | 'annotation_references_url';
    eventType: string;
    replicaId: string;
    seq: number;
  }): void => {
    const visitId = visitIdByCanonical.get(input.canonicalUrl);
    if (visitId === undefined) return;
    upsertEdge(edges, {
      kind: input.kind,
      fromNodeId: input.fromNodeId,
      toNodeId: visitId,
      observedAt: input.observedAt,
      producedBy: {
        source: 'event-log',
        eventType: input.eventType,
        dot: { replicaId: input.replicaId, seq: input.seq },
      },
      confidence: 'observed',
    });
  };

  for (const event of input.events) {
    const observedAtIso = new Date(event.acceptedAtMs).toISOString();
    const replicaId = event.dot.replicaId;
    const seq = event.dot.seq;

    if (event.type === CAPTURE_RECORDED && isCaptureRecordedPayload(event.payload)) {
      const p = event.payload;
      // The capture event's `bac_id` is the per-capture event id;
      // `threadId` is the thread aggregate id when the producer
      // knows it. Prefer threadId so URL-ref edges and quote edges
      // attribute to the actual thread node — falling back to
      // `bac_id` keeps unit-test fixtures (which use `bac_id` as
      // the thread id) working.
      const threadKey = p.threadId ?? p.bac_id;
      upsertNode(nodes, { kind: 'thread', key: threadKey, label: p.title ?? threadKey });
      const threadNodeId = nodeIdFor('thread', threadKey);
      const seenForThisEvent = new Set<string>();
      for (const turn of p.turns ?? []) {
        const sources: (string | undefined)[] = [turn.text, turn.markdown, turn.formattedText];
        for (const source of sources) {
          if (typeof source !== 'string' || source.length === 0) continue;
          for (const url of extractUrlsFromText(source)) {
            if (seenForThisEvent.has(url)) continue;
            seenForThisEvent.add(url);
            emitUrlRefEdge({
              fromNodeId: threadNodeId,
              canonicalUrl: url,
              observedAt: observedAtIso,
              kind: 'thread_references_url',
              eventType: CAPTURE_RECORDED,
              replicaId,
              seq,
            });
          }
        }
      }
      continue;
    }

    if (event.type === DISPATCH_RECORDED && isDispatchRecordedPayload(event.payload)) {
      const p = event.payload;
      upsertNode(nodes, {
        kind: 'dispatch',
        key: p.bac_id,
        label: p.title ?? p.bac_id,
        observedAt: p.createdAt,
        metadata: {
          ...(p.target.provider === undefined ? {} : { provider: p.target.provider }),
          ...(p.title === undefined ? {} : { title: p.title }),
        },
      });
      const dispatchNodeId = nodeIdFor('dispatch', p.bac_id);
      // Phase 4 cross-replica fix: emit the structural dispatch
      // edges from the event payload too. Vault pass 2 already
      // emits these from the local JSONL — this pass handles the
      // case where the dispatch event arrived via the relay (peer
      // companion) so the JSONL stays on the originating replica.
      // The same edge id (kind:from:to) means upsertEdge dedups;
      // both passes producing the same edge is a no-op when both
      // run, and the event-derived path is the only emitter when
      // only the relay-imported event is available.
      if (typeof p.sourceThreadId === 'string' && p.sourceThreadId.length > 0) {
        upsertNode(nodes, {
          kind: 'thread',
          key: p.sourceThreadId,
          label: p.sourceThreadId,
        });
        upsertEdge(edges, {
          kind: 'dispatch_from_thread',
          fromNodeId: nodeIdFor('thread', p.sourceThreadId),
          toNodeId: dispatchNodeId,
          observedAt: p.createdAt,
          producedBy: {
            source: 'event-log',
            eventType: DISPATCH_RECORDED,
            dot: { replicaId, seq },
          },
          confidence: 'observed',
        });
      }
      if (typeof p.workstreamId === 'string' && p.workstreamId.length > 0) {
        upsertNode(nodes, {
          kind: 'workstream',
          key: p.workstreamId,
          label: p.workstreamId,
        });
        upsertEdge(edges, {
          kind: 'dispatch_in_workstream',
          fromNodeId: dispatchNodeId,
          toNodeId: nodeIdFor('workstream', p.workstreamId),
          observedAt: p.createdAt,
          producedBy: {
            source: 'event-log',
            eventType: DISPATCH_RECORDED,
            dot: { replicaId, seq },
          },
          confidence: 'observed',
        });
      }
      if (p.mcpRequest !== undefined && typeof p.mcpRequest.codingSessionId === 'string') {
        upsertNode(nodes, {
          kind: 'coding-session',
          key: p.mcpRequest.codingSessionId,
          label: p.mcpRequest.codingSessionId,
        });
        upsertEdge(edges, {
          kind: 'dispatch_requested_coding_session',
          fromNodeId: dispatchNodeId,
          toNodeId: nodeIdFor('coding-session', p.mcpRequest.codingSessionId),
          observedAt: p.createdAt,
          producedBy: {
            source: 'event-log',
            eventType: DISPATCH_RECORDED,
            dot: { replicaId, seq },
          },
          confidence: 'observed',
        });
      }
      for (const url of extractUrlsFromText(p.body)) {
        emitUrlRefEdge({
          fromNodeId: dispatchNodeId,
          canonicalUrl: url,
          observedAt: observedAtIso,
          kind: 'dispatch_references_url',
          eventType: DISPATCH_RECORDED,
          replicaId,
          seq,
        });
      }
      continue;
    }

    if (event.type === ANNOTATION_CREATED && isAnnotationCreatedPayload(event.payload)) {
      const p = event.payload;
      // Annotation node was already upserted in pass 1; reuse its id.
      const annotationNodeId = nodeIdFor('annotation', p.bac_id);
      for (const url of extractUrlsFromText(p.note)) {
        emitUrlRefEdge({
          fromNodeId: annotationNodeId,
          canonicalUrl: url,
          observedAt: observedAtIso,
          kind: 'annotation_references_url',
          eventType: ANNOTATION_CREATED,
          replicaId,
          seq,
        });
      }
      continue;
    }
  }

  // -------------------------------------------------------------------
  // Pass 5 — cross-thread substring quotes. Group capture.recorded
  // events by threadId, sort each group by (acceptedAtMs, replicaId,
  // seq) for order-independent concatenation, then run the deterministic
  // shingle index. Emit thread_quotes_thread edges per qualifying pair.
  // -------------------------------------------------------------------
  if (input.preservedThreadQuoteEdges !== undefined) {
    for (const edge of input.preservedThreadQuoteEdges) {
      const fromThreadId = threadKeyFromNodeId(edge.fromNodeId);
      const toThreadId = threadKeyFromNodeId(edge.toNodeId);
      if (fromThreadId !== null) {
        upsertNode(nodes, { kind: 'thread', key: fromThreadId, label: fromThreadId });
      }
      if (toThreadId !== null) {
        upsertNode(nodes, { kind: 'thread', key: toThreadId, label: toThreadId });
      }
      trackObservedAt(edge.observedAt);
      const { id: _id, ...edgeInput } = edge;
      void _id;
      upsertEdge(edges, edgeInput);
    }
  } else {
    interface CaptureGroupEntry {
      readonly text: string;
      readonly acceptedAtMs: number;
      readonly observedAt: string;
      readonly replicaId: string;
      readonly seq: number;
    }
    const captureByThread = new Map<string, CaptureGroupEntry[]>();
    for (const event of input.events) {
      if (event.type !== CAPTURE_RECORDED) continue;
      if (!isCaptureRecordedPayload(event.payload)) continue;
      const p = event.payload;
      const parts: string[] = [];
      for (const turn of p.turns ?? []) {
        if (typeof turn.text === 'string' && turn.text.length > 0) parts.push(turn.text);
        if (typeof turn.markdown === 'string' && turn.markdown.length > 0)
          parts.push(turn.markdown);
        if (typeof turn.formattedText === 'string' && turn.formattedText.length > 0)
          parts.push(turn.formattedText);
      }
      if (parts.length === 0) continue;
      // Group by the actual thread id (with bac_id fallback for the
      // unit-test convention).
      const threadKey = p.threadId ?? p.bac_id;
      const list = captureByThread.get(threadKey);
      const entry: CaptureGroupEntry = {
        text: parts.join('\n'),
        acceptedAtMs: event.acceptedAtMs,
        observedAt: new Date(event.acceptedAtMs).toISOString(),
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
      };
      if (list === undefined) {
        captureByThread.set(threadKey, [entry]);
      } else {
        list.push(entry);
      }
    }

    const threadTexts: ThreadText[] = [];
    // Track the latest observation + a representative dot per thread,
    // so the emitted edge's observedAt is order-independent and the
    // producedBy dot is deterministic.
    const threadLatest = new Map<
      string,
      { readonly observedAt: string; readonly replicaId: string; readonly seq: number }
    >();
    // Sort threads by id for deterministic threadTexts iteration order.
    const sortedThreadIds = [...captureByThread.keys()].sort();
    for (const threadId of sortedThreadIds) {
      const entries = captureByThread.get(threadId)!;
      entries.sort((a, b) => {
        if (a.acceptedAtMs !== b.acceptedAtMs) return a.acceptedAtMs - b.acceptedAtMs;
        if (a.replicaId !== b.replicaId) return a.replicaId < b.replicaId ? -1 : 1;
        return a.seq - b.seq;
      });
      threadTexts.push({ threadId, text: entries.map((e) => e.text).join('\n') });
      const last = entries[entries.length - 1]!;
      threadLatest.set(threadId, {
        observedAt: last.observedAt,
        replicaId: last.replicaId,
        seq: last.seq,
      });
    }

    if (threadTexts.length >= 2) {
      const quoteMatches = findThreadQuotes(threadTexts);
      for (const match of quoteMatches) {
        // Lazy-create both endpoint thread nodes.
        upsertNode(nodes, { kind: 'thread', key: match.fromThreadId, label: match.fromThreadId });
        upsertNode(nodes, { kind: 'thread', key: match.toThreadId, label: match.toThreadId });
        const fromLatest = threadLatest.get(match.fromThreadId);
        const toLatest = threadLatest.get(match.toThreadId);
        const observedAt =
          fromLatest === undefined || toLatest === undefined
            ? ''
            : fromLatest.observedAt > toLatest.observedAt
              ? fromLatest.observedAt
              : toLatest.observedAt;
        // Pick the "from" thread's dot for provenance — that's the
        // thread whose capture event surfaced the quote.
        const fromDot = fromLatest ?? toLatest;
        upsertEdge(edges, {
          kind: 'thread_quotes_thread',
          fromNodeId: nodeIdFor('thread', match.fromThreadId),
          toNodeId: nodeIdFor('thread', match.toThreadId),
          observedAt,
          producedBy: {
            source: 'event-log',
            eventType: CAPTURE_RECORDED,
            recordId: match.recordIdHashPrefix,
            ...(fromDot === undefined
              ? {}
              : { dot: { replicaId: fromDot.replicaId, seq: fromDot.seq } }),
          },
          confidence: 'inferred',
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // Pass 6 — search-query content match. For each timeline-visit node
  // with a `metadata.searchQuery` (set in pass 3 from generic search-
  // URL detection), scan every CAPTURE_RECORDED turn / DISPATCH_RECORDED
  // body / ANNOTATION_CREATED note. Emit `thread_text_mentions_search_query`
  // when the query appears as a whole-word substring (case-insensitive).
  // Closes the "I searched X and asked the AI about X without pasting
  // the URL" gap.
  //
  // Min query length 4 chars to avoid noisy matches from common short
  // queries like "ai" or "ml" that would connect everywhere.
  // -------------------------------------------------------------------
  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  interface SearchVisitInfo {
    readonly visitNodeId: string;
    readonly query: string; // lowercased + trimmed
    readonly observedAt: string;
  }
  const searchVisits: SearchVisitInfo[] = [];
  for (const node of nodes.values()) {
    if (node.kind !== 'timeline-visit') continue;
    const q = node.metadata['searchQuery'];
    if (typeof q !== 'string' || q.trim().length < 4) continue;
    searchVisits.push({
      visitNodeId: node.id,
      query: q.trim().toLowerCase(),
      observedAt: node.lastSeenAt ?? '',
    });
  }
  if (searchVisits.length > 0) {
    // Pre-compile a regex per query (whole-word match,
    // case-insensitive). Reused across every event scan.
    const compiledQueries = searchVisits.map((sv) => ({
      ...sv,
      regex: new RegExp(`\\b${escapeRegex(sv.query)}\\b`, 'iu'),
    }));
    const matchTextAgainstQueries = (
      fromNodeId: string,
      text: string,
      observedAt: string,
      eventType: string,
      replicaId: string | undefined,
      seq: number | undefined,
    ): void => {
      if (text.length === 0) return;
      for (const cq of compiledQueries) {
        if (!cq.regex.test(text)) continue;
        upsertEdge(edges, {
          kind: 'thread_text_mentions_search_query',
          fromNodeId,
          toNodeId: cq.visitNodeId,
          observedAt: observedAt > cq.observedAt ? observedAt : cq.observedAt,
          producedBy: {
            source: 'event-log',
            eventType,
            ...(replicaId === undefined || seq === undefined ? {} : { dot: { replicaId, seq } }),
          },
          confidence: 'inferred',
        });
      }
    };
    for (const event of input.events) {
      const observedAtIso = new Date(event.acceptedAtMs).toISOString();
      const replicaId = event.dot.replicaId;
      const seq = event.dot.seq;
      if (event.type === CAPTURE_RECORDED && isCaptureRecordedPayload(event.payload)) {
        const p = event.payload;
        const threadKey = p.threadId ?? p.bac_id;
        const threadNodeId = nodeIdFor('thread', threadKey);
        for (const turn of p.turns ?? []) {
          for (const source of [turn.text, turn.markdown, turn.formattedText]) {
            if (typeof source !== 'string' || source.length === 0) continue;
            matchTextAgainstQueries(
              threadNodeId,
              source,
              observedAtIso,
              CAPTURE_RECORDED,
              replicaId,
              seq,
            );
          }
        }
      } else if (event.type === DISPATCH_RECORDED && isDispatchRecordedPayload(event.payload)) {
        const p = event.payload;
        matchTextAgainstQueries(
          nodeIdFor('dispatch', p.bac_id),
          p.body,
          observedAtIso,
          DISPATCH_RECORDED,
          replicaId,
          seq,
        );
      } else if (event.type === ANNOTATION_CREATED && isAnnotationCreatedPayload(event.payload)) {
        const p = event.payload;
        matchTextAgainstQueries(
          nodeIdFor('annotation', p.bac_id),
          p.note,
          observedAtIso,
          ANNOTATION_CREATED,
          replicaId,
          seq,
        );
      }
    }
  }

  // -------------------------------------------------------------------
  // Pass 7 — visit similarity. The producer owns cosine computation
  // and revision identity; this reducer only materializes valid
  // edges whose endpoints are present in the timeline projection.
  // -------------------------------------------------------------------
  if (input.visitSimilarity !== undefined) {
    for (const similarityEdge of input.visitSimilarity.edges) {
      if (
        similarityEdge.fromVisitKey === similarityEdge.toVisitKey ||
        similarityEdge.fromVisitKey.length === 0 ||
        similarityEdge.toVisitKey.length === 0 ||
        !Number.isFinite(similarityEdge.cosine) ||
        similarityEdge.cosine < input.visitSimilarity.threshold
      ) {
        continue;
      }
      const fromObservedAt = visitObservedAtByKey.get(similarityEdge.fromVisitKey);
      const toObservedAt = visitObservedAtByKey.get(similarityEdge.toVisitKey);
      if (fromObservedAt === undefined || toObservedAt === undefined) continue;
      const observedAt = fromObservedAt > toObservedAt ? fromObservedAt : toObservedAt;
      trackObservedAt(observedAt);
      upsertEdge(edges, {
        kind: 'visit_resembles_visit',
        fromNodeId: nodeIdFor('timeline-visit', similarityEdge.fromVisitKey),
        toNodeId: nodeIdFor('timeline-visit', similarityEdge.toVisitKey),
        observedAt,
        producedBy: {
          source: 'visit-similarity',
          revisionId: input.visitSimilarity.revisionId,
        },
        confidence: 'inferred',
        family: 'urlmatch',
        // RCA 2026-05: the similarity producer computes cosine + uses
        // a threshold to gate emission, but the snapshot previously
        // wrote no metadata at all. The side panel's Why-related
        // panel hardcoded `cosine: 0.85, threshold: 0.85` because it
        // had no real values to display — every "via similarity"
        // chip lied about the actual score. Persist both so the UI
        // shows "cosine 0.87 (≥0.85)" instead of guessing.
        metadata: {
          cosine: Number(similarityEdge.cosine.toFixed(4)),
          threshold: Number(input.visitSimilarity.threshold.toFixed(4)),
          ...(similarityEdge.metadata === undefined ? {} : similarityEdge.metadata),
          // Move 4 (b) — evidence-tier provenance stamped at PRODUCE time
          // (this edge is being emitted/updated now). Derived from the
          // channels the producer actually used; read/emit only. The
          // producedAt is the endpoint embeddings' produce time (the
          // similarity revision's producedAt), so a later TTL/staleness or
          // precision-sampling pass has an age to key off. Adding these
          // keys revs only edges emitted from now on — the snapshotRevision
          // hash is over counts, not edge metadata, and edges_index only
          // extracts id/kind, so byte-equality of untouched edges holds.
          evidenceTier: evidenceTierForSimilarityMetadata(similarityEdge.metadata),
          evidenceProducedAt: input.visitSimilarity.producedAt,
          // Anisotropy z-score — additive metadata (default-on). Raw
          // cosine is not centered at 0 for this encoder: random
          // unrelated pairs sit at mean 0.825, sd 0.029 (2026-07-14
          // vault study), so 0.85 ≈ noise-p80. simZ re-centers the
          // stamped cosine against that baseline (how many sd above the
          // noise floor) so downstream consumers / the eval spine can
          // read edge quality on a calibrated scale. Purely additive:
          // same byte-equality argument as evidenceTier above — new/
          // updated edges only, snapshotRevision hashes counts not
          // metadata, edges_index extracts id/kind.
          simZ: anisotropyZScore(similarityEdge.cosine),
        },
      });
    }
  }

  // -------------------------------------------------------------------
  // Pass 8 — topic-clusterer active revision. The topic revision is a
  // Class E artifact produced outside this reducer; the reducer only
  // projects its deterministic nodes and edges into the Connections
  // graph. Singleton topic components are already suppressed from
  // revision.topics, but lineage can still point at singleton
  // content-derived topic ids.
  // -------------------------------------------------------------------
  if (input.topicRevision !== undefined) {
    const topicRevision = input.topicRevision;
    const topicUserActions = buildTopicActionProjection(input.events);
    const topicProducedBy = {
      source: 'topic-clusterer',
      revisionId: topicRevision.revisionId,
    } as const;
    const workstreamShareThreshold =
      input.topicWorkstreamShareThreshold ?? DEFAULT_TOPIC_WORKSTREAM_SHARE_THRESHOLD;

    const visitWorkstreamIdFor = (canonicalUrl: string): string | undefined => {
      const node = nodes.get(nodeIdFor('timeline-visit', canonicalUrl));
      const value = node?.metadata['workstreamId'];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };

    const projectedTopics = projectedTopicsForUserActions(
      [...topicRevision.topics].sort((a, b) => compareString(a.topicId, b.topicId)),
      topicUserActions,
    );
    const projectedTopicIds = new Set(projectedTopics.map((topic) => topic.topicId));
    for (const topic of projectedTopics) {
      const topicNode = upsertNode(nodes, {
        kind: 'topic',
        key: topic.topicId,
        label: topic.metadata.representativeTitles[0] ?? topic.topicId,
        observedAt: topic.metadata.lastObservedAt,
        metadata: { ...topic.metadata },
      });
      topicNode.firstSeenAt = topic.metadata.firstObservedAt;
      topicNode.lastSeenAt = topic.metadata.lastObservedAt;
      trackObservedAt(topic.metadata.lastObservedAt);

      for (const memberCanonicalUrl of topic.memberCanonicalUrls) {
        upsertNode(nodes, {
          kind: 'timeline-visit',
          key: memberCanonicalUrl,
          label: memberCanonicalUrl,
          observedAt: topic.metadata.lastObservedAt,
          metadata: {
            canonicalUrl: memberCanonicalUrl,
            ...pageEvidenceField(input, memberCanonicalUrl),
          },
        });
        upsertEdge(edges, {
          kind: 'visit_in_topic',
          fromNodeId: nodeIdFor('timeline-visit', memberCanonicalUrl),
          toNodeId: nodeIdFor('topic', topic.topicId),
          observedAt: topic.metadata.lastObservedAt,
          producedBy: topicProducedBy,
          confidence: 'inferred',
          metadata: {
            affiliation: 'primary',
          },
        });
      }

      for (const affiliation of topic.secondaryAffiliations) {
        upsertNode(nodes, {
          kind: 'timeline-visit',
          key: affiliation.canonicalUrl,
          label: affiliation.canonicalUrl,
          observedAt: topic.metadata.lastObservedAt,
          metadata: {
            canonicalUrl: affiliation.canonicalUrl,
            ...pageEvidenceField(input, affiliation.canonicalUrl),
          },
        });
        upsertEdge(edges, {
          kind: 'visit_in_topic',
          fromNodeId: nodeIdFor('timeline-visit', affiliation.canonicalUrl),
          toNodeId: nodeIdFor('topic', topic.topicId),
          observedAt: topic.metadata.lastObservedAt,
          producedBy: topicProducedBy,
          confidence: 'inferred',
          metadata: {
            affiliation: 'secondary',
            score: affiliation.score,
            reasons: affiliation.reasons,
            supportCount: affiliation.supportCount,
            maxCosine: affiliation.maxCosine,
            lexicalScore: affiliation.lexicalScore,
            reciprocalSupport: affiliation.reciprocalSupport,
          },
        });
      }

      if (topic.metadata.dominantWorkstreamId !== undefined) {
        let dominantCount = 0;
        for (const memberCanonicalUrl of topic.memberCanonicalUrls) {
          if (visitWorkstreamIdFor(memberCanonicalUrl) === topic.metadata.dominantWorkstreamId) {
            dominantCount += 1;
          }
        }
        const share =
          topic.memberCanonicalUrls.length === 0
            ? 0
            : dominantCount / topic.memberCanonicalUrls.length;
        if (share >= workstreamShareThreshold) {
          upsertNode(nodes, {
            kind: 'workstream',
            key: topic.metadata.dominantWorkstreamId,
            label: topic.metadata.dominantWorkstreamId,
          });
          upsertEdge(edges, {
            kind: 'topic_in_workstream',
            fromNodeId: nodeIdFor('topic', topic.topicId),
            toNodeId: nodeIdFor('workstream', topic.metadata.dominantWorkstreamId),
            observedAt: topic.metadata.lastObservedAt,
            producedBy: topicProducedBy,
            confidence: 'inferred',
          });
        }
      }
    }

    for (const lineage of topicRevision.lineage) {
      if (!projectedTopicIds.has(lineage.toTopicId)) continue;
      trackObservedAt(lineage.observedAt);
      upsertEdge(edges, {
        kind: 'topic.lineage',
        fromNodeId: nodeIdFor('topic', lineage.fromTopicId),
        toNodeId: nodeIdFor('topic', lineage.toTopicId),
        observedAt: lineage.observedAt,
        producedBy: topicProducedBy,
        confidence: 'observed',
        metadata: { lineageKind: lineage.kind },
      });
    }
  }

  // -------------------------------------------------------------------
  // Pass 9 — cross-replica visit evidence. Navigation commits from
  // the merged log are reduced into one edge per shared
  // (canonicalUrl, replicaId) pair. Replica nodes exist only as
  // graph endpoints for this observed evidence.
  // -------------------------------------------------------------------
  const crossReplica = input.crossReplica ?? buildCrossReplicaMaterialization(input.events);
  const replicaSummaryById = new Map(
    crossReplica.replicas.map((replica) => [replica.replicaId, replica] as const),
  );
  const timelineVisitPrefix = 'timeline-visit:';
  for (const edge of crossReplica.edges) {
    const replicaId = replicaIdFromNodeId(edge.toNodeId);
    if (replicaId === null) continue;
    if (!edge.fromNodeId.startsWith(timelineVisitPrefix)) continue;

    const visitKey = edge.fromNodeId.slice(timelineVisitPrefix.length);
    if (visitKey.length === 0) continue;

    const replicaSummary = replicaSummaryById.get(replicaId);
    const replicaFirstSeenAt = replicaSummary?.firstSeenAt ?? edge.observedAt;
    const replicaLastSeenAt = replicaSummary?.lastSeenAt ?? edge.observedAt;
    trackObservedAt(edge.observedAt);
    trackObservedAt(replicaLastSeenAt);

    const existingVisitNode = nodes.get(edge.fromNodeId);
    upsertNode(nodes, {
      kind: 'timeline-visit',
      key: visitKey,
      label: existingVisitNode?.label ?? visitKey,
      observedAt: edge.observedAt,
      replicaId,
      metadata: {
        canonicalUrl: visitKey,
      },
    });
    upsertNode(nodes, {
      kind: 'replica',
      key: replicaId,
      label: replicaId,
      observedAt: replicaFirstSeenAt,
      replicaId,
      metadata: {
        replicaId,
        firstSeenAt: replicaFirstSeenAt,
        lastSeenAt: replicaLastSeenAt,
      },
    });
    if (replicaLastSeenAt !== replicaFirstSeenAt) {
      upsertNode(nodes, {
        kind: 'replica',
        key: replicaId,
        label: replicaId,
        observedAt: replicaLastSeenAt,
        replicaId,
      });
    }
    upsertEdge(edges, {
      kind: edge.kind,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      observedAt: edge.observedAt,
      producedBy: edge.producedBy,
      confidence: edge.confidence,
      family: 'urlmatch',
    });
  }

  // -------------------------------------------------------------------
  // Pass 10 — hash-only snippet lineage. The projection matches
  // selection.pasted to selection.copied within a 24-hour window by
  // exact SHA-256 hash or SimHash64 Hamming <= 3. No raw text enters
  // this reducer.
  // -------------------------------------------------------------------
  const snippetRevisionId = 'snippet-lineage:v1:hash';
  const lineages = projectSnippetLineage(input.events).lineages;
  const threadDestinationsBySnippet = new Map<string, Set<string>>();
  const pastedAtBySnippetThread = new Map<string, string>();

  const edgeKindForDestination = (kind: string): ConnectionEdgeKind | null => {
    if (kind === 'thread') return 'snippet_pasted_into_thread';
    if (kind === 'dispatch') return 'snippet_pasted_into_dispatch';
    if (kind === 'search') return 'snippet_pasted_into_search';
    if (kind === 'note') return 'snippet_pasted_into_note';
    if (kind === 'capture') return 'snippet_pasted_into_capture';
    return null;
  };
  const nodeKindForDestination = (kind: string): ConnectionNodeKind | null => {
    if (kind === 'thread') return 'thread';
    if (kind === 'dispatch') return 'dispatch';
    if (kind === 'search') return 'timeline-visit';
    if (kind === 'note') return 'annotation';
    if (kind === 'capture') return 'annotation';
    return null;
  };

  for (const lineage of lineages) {
    const observedAt = new Date(lineage.pastedAtMs).toISOString();
    trackObservedAt(observedAt);
    upsertNode(nodes, {
      kind: 'snippet',
      key: lineage.snippetId,
      label: lineage.snippetId,
      observedAt,
      replicaId: lineage.pasteDot.replicaId,
      metadata: {
        charHashPrefix: lineage.selectionHash.slice(0, 12),
        match: lineage.match,
        charCount: lineage.charCount,
        lineCount: lineage.lineCount,
        contentKindHint: lineage.contentKindHint,
      },
    });
    upsertNode(nodes, {
      kind: 'timeline-visit',
      key: lineage.copiedVisitId,
      label: lineage.copiedVisitId,
      observedAt: new Date(lineage.copiedAtMs).toISOString(),
      replicaId: lineage.copyDot.replicaId,
    });
    upsertEdge(edges, {
      kind: 'snippet_copied_from_visit',
      fromNodeId: nodeIdFor('snippet', lineage.snippetId),
      toNodeId: nodeIdFor('timeline-visit', lineage.copiedVisitId),
      observedAt: new Date(lineage.copiedAtMs).toISOString(),
      producedBy: {
        source: 'snippet-lineage',
        revisionId: snippetRevisionId,
      },
      confidence: 'observed',
    });

    const destinationNodeKind = nodeKindForDestination(lineage.destinationKind);
    const destinationEdgeKind = edgeKindForDestination(lineage.destinationKind);
    if (destinationNodeKind !== null && destinationEdgeKind !== null) {
      upsertNode(nodes, {
        kind: destinationNodeKind,
        key: lineage.destinationId,
        label: lineage.destinationId,
        observedAt,
        replicaId: lineage.pasteDot.replicaId,
      });
      upsertEdge(edges, {
        kind: destinationEdgeKind,
        fromNodeId: nodeIdFor('snippet', lineage.snippetId),
        toNodeId: nodeIdFor(destinationNodeKind, lineage.destinationId),
        observedAt,
        producedBy: {
          source: 'snippet-lineage',
          revisionId: snippetRevisionId,
        },
        confidence: 'observed',
      });
    }

    if (lineage.destinationKind === 'thread') {
      const set = threadDestinationsBySnippet.get(lineage.snippetId) ?? new Set<string>();
      set.add(lineage.destinationId);
      threadDestinationsBySnippet.set(lineage.snippetId, set);
      pastedAtBySnippetThread.set(`${lineage.snippetId}|${lineage.destinationId}`, observedAt);
    }
  }

  for (const [snippetId, threadIds] of threadDestinationsBySnippet) {
    if (threadIds.size < 2) continue;
    for (const threadId of [...threadIds].sort()) {
      upsertEdge(edges, {
        kind: 'snippet_reused_across_threads',
        fromNodeId: nodeIdFor('snippet', snippetId),
        toNodeId: nodeIdFor('thread', threadId),
        observedAt: pastedAtBySnippetThread.get(`${snippetId}|${threadId}`) ?? '',
        producedBy: {
          source: 'snippet-lineage',
          revisionId: snippetRevisionId,
        },
        confidence: 'inferred',
      });
    }
  }

  // -------------------------------------------------------------------
  // Pass 11 — cross-replica continuation classifier. Candidate pairs
  // are limited to URLs already evidenced by visit_observed_on_replica;
  // the classifier then uses the S18 feature extractor plus
  // continuation-specific timing and copy/paste signals.
  // -------------------------------------------------------------------
  const continuationPredictions = classifyCrossReplicaContinuations({
    merged: input.events,
    snapshot: snapshotFromAccumulators(input.scope, nodes, edges, maxObservedAt),
  });
  for (const prediction of continuationPredictions) {
    trackObservedAt(prediction.fromObservedAt);
    trackObservedAt(prediction.toObservedAt);
    upsertNode(nodes, {
      kind: 'timeline-visit',
      key: prediction.fromVisitId,
      label: prediction.fromUrl,
      observedAt: prediction.fromObservedAt,
      replicaId: prediction.fromReplicaId,
      metadata: {
        url: prediction.fromUrl,
        canonicalUrl: prediction.canonicalUrl,
        replicaId: prediction.fromReplicaId,
      },
    });
    upsertNode(nodes, {
      kind: 'timeline-visit',
      key: prediction.toVisitId,
      label: prediction.toUrl,
      observedAt: prediction.toObservedAt,
      replicaId: prediction.toReplicaId,
      metadata: {
        url: prediction.toUrl,
        canonicalUrl: prediction.canonicalUrl,
        replicaId: prediction.toReplicaId,
      },
    });
    const edge = continuationEdgeForPrediction(prediction);
    upsertEdge(edges, {
      kind: edge.kind,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      observedAt: edge.observedAt,
      producedBy: edge.producedBy,
      confidence: edge.confidence,
      family: edge.family,
      ...(edge.metadata === undefined ? {} : { metadata: edge.metadata }),
    });
  }

  // -------------------------------------------------------------------
  // Pass 12 — closest_visit ranker edge emission. Candidate
  // generation and feature extraction are deterministic; the active
  // ranker scorer is injected by the materializer after loading the
  // Class E revision.
  // -------------------------------------------------------------------
  if (input.closestVisitRanker !== undefined) {
    const baseSnapshot = snapshotFromAccumulators(input.scope, nodes, edges, maxObservedAt);
    for (const edge of closestVisitRankerEdgesForSnapshot(
      input,
      baseSnapshot,
      input.closestVisitRanker,
    )) {
      trackObservedAt(edge.observedAt);
      const { id: _id, ...edgeInput } = edge;
      void _id;
      upsertEdge(edges, edgeInput);
    }
  }

  // -------------------------------------------------------------------
  // Pass 13 — DOM-skeleton template grouping. Visual fingerprint
  // events carry only a SHA-256 hash of the canonical tag tree plus
  // boolean class/id presence. The reducer groups visits by that hash
  // without reading page text, attributes, screenshots, or pixels.
  // -------------------------------------------------------------------
  const visualFingerprints = projectVisualFingerprints(input.events);
  for (const fingerprint of visualFingerprints.fingerprints) {
    trackObservedAt(fingerprint.observedAt);
    upsertNode(nodes, {
      kind: 'timeline-visit',
      key: fingerprint.visitId,
      label: fingerprint.visitId,
      observedAt: fingerprint.observedAt,
      replicaId: fingerprint.replicaId,
      metadata: {
        canonicalUrl: fingerprint.visitId,
      },
    });
    upsertNode(nodes, {
      kind: 'template',
      key: fingerprint.domHash,
      label: `template:${fingerprint.domHash.slice(0, 12)}`,
      observedAt: fingerprint.observedAt,
      replicaId: fingerprint.replicaId,
      metadata: {
        domHash: fingerprint.domHash,
      },
    });
    upsertEdge(edges, {
      kind: 'visit_in_template',
      fromNodeId: nodeIdFor('timeline-visit', fingerprint.visitId),
      toNodeId: nodeIdFor('template', fingerprint.domHash),
      observedAt: fingerprint.observedAt,
      producedBy: {
        source: 'event-log',
        eventType: VISUAL_FINGERPRINT_OBSERVED,
        dot: { replicaId: fingerprint.replicaId, seq: fingerprint.seq },
      },
      confidence: 'observed',
      family: 'urlmatch',
    });
  }

  // -------------------------------------------------------------------
  // Materialize: convert accumulators to deterministic snapshot.
  // -------------------------------------------------------------------
  const base = snapshotFromAccumulators(input.scope, nodes, edges, maxObservedAt);
  // Stage 5.2 R1 — embed the URL and tab-session projections so HTTP
  // routes serve from the committed snapshot. tabSessionProjection is
  // always provided by the materializer; urlProjection is optional on
  // ConnectionsInput for back-compat with older callers.
  const tabSessionProjection = serializeTabSessionProjection(input.tabSessionProjection);
  const urlProjection =
    input.urlProjection === undefined
      ? undefined
      : serializeUrlProjection(
          urlProjectionWithPageEvidence(input.urlProjection, input.pageEvidenceByCanonicalUrl),
        );
  // Stage 5.2 R4 — stable per-snapshot revision id over byte-deterministic
  // contents. Cheap hash so side panel + resolver can detect stale reads
  // without diffing the whole snapshot.
  const snapshotRevision = computeSnapshotRevision({
    updatedAt: base.updatedAt,
    nodeCount: base.nodeCount,
    edgeCount: base.edgeCount,
    urlProjectionKeyCount:
      urlProjection === undefined ? 0 : Object.keys(urlProjection.byCanonicalUrl).length,
    tabSessionProjectionKeyCount: Object.keys(tabSessionProjection.bySessionId).length,
  });
  return {
    ...base,
    ...(urlProjection === undefined ? {} : { urlProjection }),
    tabSessionProjection,
    snapshotRevision,
  };
};

const computeSnapshotRevision = (parts: {
  readonly updatedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly urlProjectionKeyCount: number;
  readonly tabSessionProjectionKeyCount: number;
}): string => {
  const hasher = createHash('sha256');
  hasher.update(parts.updatedAt);
  hasher.update('|');
  hasher.update(String(parts.nodeCount));
  hasher.update('|');
  hasher.update(String(parts.edgeCount));
  hasher.update('|');
  hasher.update(String(parts.urlProjectionKeyCount));
  hasher.update('|');
  hasher.update(String(parts.tabSessionProjectionKeyCount));
  return hasher.digest('hex').slice(0, 16);
};

export const augmentConnectionsSnapshotWithClosestVisitRanker = (
  input: ConnectionsInput & { readonly closestVisitRanker: ClosestVisitRanker },
  baseSnapshot: ConnectionsSnapshot,
): ConnectionsSnapshot => {
  const edges = new Map<string, ConnectionEdge>(
    baseSnapshot.edges
      .filter((edge) => edge.kind !== 'closest_visit')
      .map((edge) => [edge.id, edge] as const),
  );
  const baseWithoutClosestVisit = {
    ...baseSnapshot,
    edges: [...edges.values()],
    edgeCount: edges.size,
  };
  let maxObservedAt = baseWithoutClosestVisit.updatedAt;
  for (const edge of closestVisitRankerEdgesForSnapshot(
    input,
    baseWithoutClosestVisit,
    input.closestVisitRanker,
  )) {
    if (edge.observedAt > maxObservedAt) maxObservedAt = edge.observedAt;
    const taggedEdge = tagClosestVisitRankerEdge(edge, {
      producerRevision: input.closestVisitRanker.revisionId,
      inputFrontier: {},
    });
    const { id: _id, ...edgeInput } = taggedEdge;
    void _id;
    upsertEdge(edges, edgeInput);
  }
  const sortedEdges = sortAlphaById([...edges.values()]);
  const updatedAt = maxObservedAt.length > 0 ? maxObservedAt : baseSnapshot.updatedAt;
  return {
    ...baseSnapshot,
    edges: sortedEdges,
    updatedAt,
    edgeCount: sortedEdges.length,
    snapshotRevision: computeSnapshotRevision({
      updatedAt,
      nodeCount: baseSnapshot.nodeCount,
      edgeCount: sortedEdges.length,
      urlProjectionKeyCount:
        baseSnapshot.urlProjection === undefined
          ? 0
          : Object.keys(baseSnapshot.urlProjection.byCanonicalUrl).length,
      tabSessionProjectionKeyCount:
        baseSnapshot.tabSessionProjection === undefined
          ? 0
          : Object.keys(baseSnapshot.tabSessionProjection.bySessionId).length,
    }),
  };
};

export const augmentConnectionsSnapshotWithClosestVisitRankerFrontier = (
  input: ConnectionsInput & {
    readonly closestVisitRanker: ClosestVisitRanker;
    readonly rankerFrontier: ReadonlySet<string>;
    readonly inputFrontier: Readonly<Record<string, number>>;
  },
  currentSnapshot: ConnectionsSnapshot,
): ConnectionsSnapshot => {
  const frontierNodeIds = new Set(
    [...input.rankerFrontier].map((visitKey) => nodeIdFor('timeline-visit', visitKey)),
  );
  const preservedEdges = currentSnapshot.edges.filter(
    (edge) =>
      edge.kind !== 'closest_visit' ||
      (!frontierNodeIds.has(edge.fromNodeId) && !frontierNodeIds.has(edge.toNodeId)),
  );
  const baseWithoutFrontierClosestVisit = {
    ...currentSnapshot,
    edges: preservedEdges,
    edgeCount: preservedEdges.length,
  };
  const edges = new Map<string, ConnectionEdge>(preservedEdges.map((edge) => [edge.id, edge]));
  let maxObservedAt = baseWithoutFrontierClosestVisit.updatedAt;
  for (const edge of closestVisitRankerEdgesForSnapshot(
    input,
    baseWithoutFrontierClosestVisit,
    input.closestVisitRanker,
    input.rankerFrontier,
  )) {
    if (edge.observedAt > maxObservedAt) maxObservedAt = edge.observedAt;
    edges.set(
      edge.id,
      tagClosestVisitRankerEdge(edge, {
        producerRevision: input.closestVisitRanker.revisionId,
        inputFrontier: input.inputFrontier,
      }),
    );
  }
  const sortedEdges = sortAlphaById([...edges.values()]);
  const updatedAt = maxObservedAt.length > 0 ? maxObservedAt : currentSnapshot.updatedAt;
  return {
    ...currentSnapshot,
    edges: sortedEdges,
    updatedAt,
    edgeCount: sortedEdges.length,
    snapshotRevision: computeSnapshotRevision({
      updatedAt,
      nodeCount: currentSnapshot.nodeCount,
      edgeCount: sortedEdges.length,
      urlProjectionKeyCount:
        currentSnapshot.urlProjection === undefined
          ? 0
          : Object.keys(currentSnapshot.urlProjection.byCanonicalUrl).length,
      tabSessionProjectionKeyCount:
        currentSnapshot.tabSessionProjection === undefined
          ? 0
          : Object.keys(currentSnapshot.tabSessionProjection.bySessionId).length,
    }),
  };
};

// ---------------------------------------------------------------------------
// On-disk store: rolling current.json + daily snapshots.
// ---------------------------------------------------------------------------

export interface ConnectionsStore {
  readonly putCurrent: (snapshot: ConnectionsSnapshot) => Promise<void>;
  readonly vacuum?: () => Promise<void>;
  readonly cacheResolverResult?: (
    visitId: string,
    snapshotRevision: string,
    result: unknown,
  ) => Promise<void>;
  readonly getCachedResolverResult?: (
    visitId: string,
    snapshotRevision: string,
  ) => Promise<unknown | null>;
  readonly writeSnapshotAndProgress: (
    snapshot: ConnectionsSnapshot,
    progress: MaterializerProgress,
    dirtyScopes?: ReadonlySet<Scope>,
    projectionAccumulatorState?: ConnectionsProjectionAccumulatorState,
  ) => Promise<void>;
  readonly readProjectionAccumulatorState?: (
    name: string,
  ) => Promise<ConnectionsProjectionAccumulatorState | null>;
  readonly applyProjectionEventOverlay?: (event: AcceptedEvent) => Promise<string | null>;
  readonly writeMaterializerProgress?: (progress: MaterializerProgress) => Promise<void>;
  readonly readMaterializerProgress: (name: string) => Promise<MaterializerProgress | null>;
  readonly readSnapshotMetadata?: () => Promise<StoredConnectionsMetadata | null>;
  readonly readScopesForNode?: (nodeId: string) => Promise<Scope[]>;
  readonly readScopesForEdge?: (src: string, dst: string) => Promise<Scope[]>;
  readonly readNodesForScope?: (scope: Scope) => Promise<string[]>;
  readonly readEdgesForScope?: (
    scope: Scope,
  ) => Promise<Array<{ readonly src: string; readonly dst: string }>>;
  readonly replaceScopeRows?: (input: {
    readonly scopes: readonly Scope[];
    readonly nodes: readonly ConnectionNode[];
    readonly edges: readonly ConnectionEdge[];
    readonly progress: MaterializerProgress;
    readonly metadata?: {
      readonly urlProjection?: ConnectionsSnapshot['urlProjection'];
      readonly tabSessionProjection?: ConnectionsSnapshot['tabSessionProjection'];
    };
    readonly projectionAccumulatorState?: ConnectionsProjectionAccumulatorState;
    // 'replace' (default): persist input.progress verbatim, advancing
    // both applied dot intervals and snapshotRevisionId. Used by the
    // deterministic drain path that has freshly-computed progress.
    // 'snapshot-revision-only': used by the foreground-navigation
    // overlay (UI-latency fast path). The caller's input.progress may
    // be a STALE snapshot (read before the BEGIN IMMEDIATE that a
    // concurrent drain or sibling overlay just committed against);
    // writing it back verbatim would regress applied dot intervals.
    // In this mode the implementation reads persisted progress INSIDE
    // the transaction, keeps appliedDotIntervals/appliedFrontier as
    // observed, and only advances snapshotRevisionId.
    readonly progressMode?: 'replace' | 'snapshot-revision-only';
  }) => Promise<void>;
  readonly readCurrent: () => Promise<ConnectionsSnapshot | null>;
  readonly putDay: (date: string, snapshot: ConnectionsSnapshot) => Promise<void>;
  readonly readDay: (date: string) => Promise<ConnectionsSnapshot | null>;
  readonly listDays: () => Promise<readonly string[]>;
}

const SNAPSHOTS_DIR = 'snapshots';
const CONNECTIONS_STORE_JSON_FLAG = 'json';
const projectionAccumulatorMetadataKey = (name: string): string =>
  `projection_accumulators:${name}`;

interface SqliteStatement {
  readonly run: (...params: readonly unknown[]) => unknown;
  readonly get: (...params: readonly unknown[]) => unknown;
  readonly all: (...params: readonly unknown[]) => readonly unknown[];
}

interface SqliteDatabase {
  readonly exec: (sql: string) => unknown;
  readonly query: (sql: string) => SqliteStatement;
  readonly close?: () => void;
}

interface SqliteModule {
  readonly Database: new (
    filename: string,
    options?: { readonly create?: boolean; readonly readwrite?: boolean },
  ) => SqliteDatabase;
}

const loadSqlite = async (): Promise<SqliteModule> => {
  const module = (await import('bun:sqlite')) as Partial<SqliteModule>;
  if (typeof module.Database !== 'function') {
    throw new Error('bun:sqlite Database export is unavailable');
  }
  return { Database: module.Database };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const textField = (value: unknown, field: string): string => {
  if (!isRecord(value) || typeof value[field] !== 'string') {
    throw new Error(`SQLite connections row is missing text field: ${field}`);
  }
  return value[field];
};

export interface StoredConnectionsMetadata {
  readonly scope: ConnectionsSnapshotScope;
  readonly updatedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly urlProjection?: ConnectionsSnapshot['urlProjection'];
  readonly tabSessionProjection?: ConnectionsSnapshot['tabSessionProjection'];
  readonly snapshotRevision?: string;
}

export interface ConnectionsProjectionAccumulatorState {
  readonly materializerName: string;
  readonly materializerVersion: string;
  readonly appliedDotIntervals: MaterializerProgress['appliedDotIntervals'];
  readonly appliedFrontier: MaterializerProgress['appliedFrontier'];
  readonly urlAccumulator: SerializedUrlProjectionAccumulator;
  readonly tabSessionAccumulator: SerializedTabSessionProjectionAccumulator;
}

const metadataForSnapshot = (snapshot: ConnectionsSnapshot): StoredConnectionsMetadata => ({
  scope: snapshot.scope,
  updatedAt: snapshot.updatedAt,
  nodeCount: snapshot.nodeCount,
  edgeCount: snapshot.edgeCount,
  ...(snapshot.urlProjection === undefined ? {} : { urlProjection: snapshot.urlProjection }),
  ...(snapshot.tabSessionProjection === undefined
    ? {}
    : { tabSessionProjection: snapshot.tabSessionProjection }),
  ...(snapshot.snapshotRevision === undefined
    ? {}
    : { snapshotRevision: snapshot.snapshotRevision }),
});

const snapshotFromParts = (
  metadata: StoredConnectionsMetadata,
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  options?: { readonly preserveMetadataCounts?: boolean },
): ConnectionsSnapshot => ({
  scope: metadata.scope,
  nodes,
  edges,
  updatedAt: metadata.updatedAt,
  nodeCount: options?.preserveMetadataCounts === true ? metadata.nodeCount : nodes.length,
  edgeCount: options?.preserveMetadataCounts === true ? metadata.edgeCount : edges.length,
  ...(metadata.urlProjection === undefined ? {} : { urlProjection: metadata.urlProjection }),
  ...(metadata.tabSessionProjection === undefined
    ? {}
    : { tabSessionProjection: metadata.tabSessionProjection }),
  ...(metadata.snapshotRevision === undefined
    ? {}
    : { snapshotRevision: metadata.snapshotRevision }),
});

const edgeBucketKey = (edge: ConnectionEdge): string => `${edge.fromNodeId}\u0000${edge.toNodeId}`;
// IVM is the only supported path — env-opt-out removed.
const incrementalScopesEnabled = (): boolean => true;
const SQLITE_IN_CLAUSE_CHUNK_SIZE = 400;
const RESOLVER_SUBGRAPH_HOPS = 4;
const RESOLVER_URL_SUBGRAPH_HOPS = 2;

const chunked = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

const placeholdersFor = (count: number): string =>
  Array.from({ length: count }, () => '?').join(',');

const normalizeResolverUrl = (url: string): string => url.replace(/#.*$/u, '').replace(/\/+$/u, '');

const maxIso = (left: string, right: string | undefined): string => {
  if (right === undefined || right.length === 0) return left;
  return right > left ? right : left;
};

const projectionOverlayUpdatedAt = (input: {
  readonly fallback: string;
  readonly urlProjection?: SerializedUrlProjection;
  readonly tabSessionProjection?: SerializedTabSessionProjection;
}): string => {
  let updatedAt = input.fallback;
  for (const record of Object.values(input.urlProjection?.byCanonicalUrl ?? {})) {
    updatedAt = maxIso(updatedAt, record.firstSeenAt);
    updatedAt = maxIso(updatedAt, record.lastSeenAt);
    updatedAt = maxIso(updatedAt, record.currentAttribution?.observedAt);
    updatedAt = maxIso(updatedAt, record.currentIgnored?.observedAt);
  }
  for (const record of Object.values(input.tabSessionProjection?.bySessionId ?? {})) {
    updatedAt = maxIso(updatedAt, record.openedAt);
    updatedAt = maxIso(updatedAt, record.lastActivityAt);
    updatedAt = maxIso(updatedAt, record.closedAt);
    updatedAt = maxIso(updatedAt, record.currentAttribution?.observedAt);
  }
  return updatedAt;
};

const maxIsoValue = (fallback: string, ...values: readonly (string | undefined)[]): string => {
  let out = fallback;
  for (const value of values) {
    if (value !== undefined && value.length > 0 && value > out) out = value;
  }
  return out;
};

const urlRecordFreshness = (record: UrlVisitRecord): string =>
  maxIsoValue(
    record.firstSeenAt,
    record.lastSeenAt,
    record.currentAttribution?.observedAt,
    record.currentIgnored?.observedAt,
    record.pageEvidence?.updatedAt,
  );

const tabSessionRecordFreshness = (record: TabSessionRecord): string =>
  maxIsoValue(
    record.openedAt,
    record.lastActivityAt,
    record.closedAt,
    record.currentAttribution?.observedAt,
  );

const fresherPageEvidence = (
  left: UrlPageEvidenceSummary | undefined,
  right: UrlPageEvidenceSummary | undefined,
): UrlPageEvidenceSummary | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return right.updatedAt > left.updatedAt ? right : left;
};

const mergeUrlProjectionForWrite = (
  incoming: SerializedUrlProjection | undefined,
  existing: SerializedUrlProjection | undefined,
): SerializedUrlProjection | undefined => {
  // Preserve the persisted projection when the caller didn't bring a new
  // one. An earlier `return incoming` here silently dropped the persisted
  // urlProjection whenever any putCurrent / writeSnapshotAndProgress
  // landed without urlProjection in the snapshot (partial subgraph, test
  // fixture, downgrade path). The incremental path at L4729 already
  // guards before calling, but defensive callers (and the tabSession
  // sibling below) need the merge function itself to be safe.
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  const byCanonicalUrl: Record<string, UrlVisitRecord> = {};
  const keys = [
    ...new Set([...Object.keys(incoming.byCanonicalUrl), ...Object.keys(existing.byCanonicalUrl)]),
  ].sort();
  for (const key of keys) {
    const incomingRecord = incoming.byCanonicalUrl[key];
    const existingRecord = existing.byCanonicalUrl[key];
    if (incomingRecord === undefined) {
      if (existingRecord !== undefined) byCanonicalUrl[key] = existingRecord;
      continue;
    }
    if (existingRecord === undefined) {
      byCanonicalUrl[key] = incomingRecord;
      continue;
    }
    const selected =
      urlRecordFreshness(existingRecord) > urlRecordFreshness(incomingRecord)
        ? existingRecord
        : incomingRecord;
    const evidence = fresherPageEvidence(incomingRecord.pageEvidence, existingRecord.pageEvidence);
    byCanonicalUrl[key] =
      evidence === undefined
        ? selected
        : {
            ...selected,
            pageEvidence: evidence,
          };
  }
  return {
    schemaVersion: incoming.schemaVersion,
    byCanonicalUrl,
  };
};

const mergeTabSessionProjectionForWrite = (
  incoming: SerializedTabSessionProjection | undefined,
  existing: SerializedTabSessionProjection | undefined,
): SerializedTabSessionProjection | undefined => {
  // See mergeUrlProjectionForWrite above — same persistence-preservation
  // invariant. Returning `incoming` when only existing is defined drops
  // the persisted tabSession projection.
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  const bySessionId: Record<string, TabSessionRecord> = {};
  const sessionIds = [
    ...new Set([...Object.keys(incoming.bySessionId), ...Object.keys(existing.bySessionId)]),
  ].sort();
  for (const sessionId of sessionIds) {
    const incomingRecord = incoming.bySessionId[sessionId];
    const existingRecord = existing.bySessionId[sessionId];
    if (incomingRecord === undefined) {
      if (existingRecord !== undefined) bySessionId[sessionId] = existingRecord;
      continue;
    }
    if (existingRecord === undefined) {
      bySessionId[sessionId] = incomingRecord;
      continue;
    }
    bySessionId[sessionId] =
      tabSessionRecordFreshness(existingRecord) > tabSessionRecordFreshness(incomingRecord)
        ? existingRecord
        : incomingRecord;
  }

  const openSessionsByTabId: Record<string, string> = {};
  const tabIds = [
    ...new Set([
      ...Object.keys(incoming.openSessionsByTabId),
      ...Object.keys(existing.openSessionsByTabId),
    ]),
  ].sort();
  for (const tabId of tabIds) {
    const incomingSessionId = incoming.openSessionsByTabId[tabId];
    const existingSessionId = existing.openSessionsByTabId[tabId];
    if (incomingSessionId === undefined) {
      if (existingSessionId !== undefined) openSessionsByTabId[tabId] = existingSessionId;
      continue;
    }
    if (existingSessionId === undefined) {
      openSessionsByTabId[tabId] = incomingSessionId;
      continue;
    }
    const incomingRecord = bySessionId[incomingSessionId];
    const existingRecord = bySessionId[existingSessionId];
    if (
      existingRecord !== undefined &&
      (incomingRecord === undefined ||
        tabSessionRecordFreshness(existingRecord) > tabSessionRecordFreshness(incomingRecord))
    ) {
      openSessionsByTabId[tabId] = existingSessionId;
    } else {
      openSessionsByTabId[tabId] = incomingSessionId;
    }
  }

  return {
    schemaVersion: incoming.schemaVersion,
    bySessionId,
    openSessionsByTabId,
  };
};

const metadataForSnapshotWrite = (
  snapshot: ConnectionsSnapshot,
  existing: StoredConnectionsMetadata | null,
): StoredConnectionsMetadata => {
  const incoming = metadataForSnapshot(snapshot);
  if (existing === null) return incoming;
  const urlProjection = mergeUrlProjectionForWrite(incoming.urlProjection, existing.urlProjection);
  const tabSessionProjection = mergeTabSessionProjectionForWrite(
    incoming.tabSessionProjection,
    existing.tabSessionProjection,
  );
  const updatedAt = projectionOverlayUpdatedAt({
    fallback: incoming.updatedAt,
    ...(urlProjection === undefined ? {} : { urlProjection }),
    ...(tabSessionProjection === undefined ? {} : { tabSessionProjection }),
  });
  const projectionChanged =
    updatedAt !== incoming.updatedAt ||
    JSON.stringify(urlProjection ?? null) !== JSON.stringify(incoming.urlProjection ?? null) ||
    JSON.stringify(tabSessionProjection ?? null) !==
      JSON.stringify(incoming.tabSessionProjection ?? null);
  const snapshotRevision = projectionChanged
    ? computeSnapshotRevision({
        updatedAt,
        nodeCount: incoming.nodeCount,
        edgeCount: incoming.edgeCount,
        urlProjectionKeyCount:
          urlProjection === undefined ? 0 : Object.keys(urlProjection.byCanonicalUrl).length,
        tabSessionProjectionKeyCount:
          tabSessionProjection === undefined
            ? 0
            : Object.keys(tabSessionProjection.bySessionId).length,
      })
    : incoming.snapshotRevision;
  return {
    ...incoming,
    updatedAt,
    ...(urlProjection === undefined ? {} : { urlProjection }),
    ...(tabSessionProjection === undefined ? {} : { tabSessionProjection }),
    ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
  };
};

const metadataStringArray = (row: unknown): string[] => {
  if (row === null || row === undefined) return [];
  const parsed = JSON.parse(textField(row, 'data')) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is string => typeof value === 'string');
};

const patchSortedOrder = (input: {
  readonly current: readonly string[];
  readonly removed: ReadonlySet<string>;
  readonly added: ReadonlySet<string>;
}): string[] => {
  const ids = new Set<string>();
  for (const id of input.current) {
    if (!input.removed.has(id)) ids.add(id);
  }
  for (const id of input.added) ids.add(id);
  return [...ids].sort();
};

const edgeIdsFromSerializedBucket = (serialized: string): string[] => {
  const parsed = JSON.parse(serialized) as unknown;
  if (!Array.isArray(parsed)) return [];
  const edgeIds: string[] = [];
  for (const value of parsed) {
    if (isRecord(value) && typeof value['id'] === 'string') edgeIds.push(value['id']);
  }
  return edgeIds;
};

const maxObservedAtForRows = (
  fallback: string,
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
): string => {
  let updatedAt = fallback;
  for (const node of nodes) {
    if (node.firstSeenAt !== undefined && node.firstSeenAt > updatedAt)
      updatedAt = node.firstSeenAt;
    if (node.lastSeenAt !== undefined && node.lastSeenAt > updatedAt) updatedAt = node.lastSeenAt;
  }
  for (const edge of edges) {
    if (edge.observedAt > updatedAt) updatedAt = edge.observedAt;
  }
  return updatedAt;
};

export class SqliteConnectionsStore implements ConnectionsStore {
  readonly #root: string;
  readonly #snapshotsDir: string;
  readonly #databasePath: string;
  readonly #currentJsonPath: string;
  #db: SqliteDatabase | null = null;
  #initialized = false;
  #resolverCachePruneScheduledFor: string | null = null;
  #resolverCacheCurrentRevision: string | null = null;
  readonly #resolverCacheStaleRevisions = new Set<string>();
  // readCurrent memo, keyed on snapshotRevision. Without this, every
  // cold resolve repeats the ~17K JSON.parses to materialize the whole
  // snapshot; with it, sibling resolves within the same revision share
  // a single bulk read. Invalidated when any readCurrent-input writer
  // commits (see #bumpWriteSeq).
  #cachedSnapshot: { readonly revision: string; readonly value: ConnectionsSnapshot } | null = null;
  // Idle eviction. The cached snapshot is the second-largest JS-heap
  // holder (~150 MB inflated for 6700 nodes + 25k edges). Drains read
  // it back-to-back during a burst, but it's referenced rarely
  // between bursts. Evict after CACHED_SNAPSHOT_IDLE_MS of no access
  // so the GC can reclaim during idle stretches; the next reader pays
  // the paged-read cost again (sub-100ms per page). Eviction is
  // independent of the H6 writer-interleave retry — that loop already
  // re-enters the paged-read path on stale.
  static readonly #CACHED_SNAPSHOT_IDLE_MS = 60_000;
  #cachedSnapshotLastAccessMs = 0;
  #cachedSnapshotSweepTimer: ReturnType<typeof setTimeout> | null = null;
  #dropCachedSnapshot = (): void => {
    this.#cachedSnapshot = null;
    this.#cachedSnapshotLastAccessMs = 0;
    this.#cancelCachedSnapshotSweep();
  };
  #cancelCachedSnapshotSweep = (): void => {
    if (this.#cachedSnapshotSweepTimer !== null) {
      clearTimeout(this.#cachedSnapshotSweepTimer);
      this.#cachedSnapshotSweepTimer = null;
    }
  };
  #scheduleCachedSnapshotSweep = (delayMs: number): void => {
    this.#cancelCachedSnapshotSweep();
    const t = setTimeout(() => {
      this.#cachedSnapshotSweepTimer = null;
      if (this.#cachedSnapshot === null) return;
      const idleMs = Date.now() - this.#cachedSnapshotLastAccessMs;
      if (idleMs >= SqliteConnectionsStore.#CACHED_SNAPSHOT_IDLE_MS) {
        this.#cachedSnapshot = null;
      } else {
        this.#scheduleCachedSnapshotSweep(SqliteConnectionsStore.#CACHED_SNAPSHOT_IDLE_MS - idleMs);
      }
    }, delayMs);
    t.unref?.();
    this.#cachedSnapshotSweepTimer = t;
  };

  constructor(vaultRoot: string, options?: { readonly databasePath?: string }) {
    this.#root = join(vaultRoot, '_BAC', 'connections');
    this.#snapshotsDir = join(this.#root, SNAPSHOTS_DIR);
    this.#databasePath = options?.databasePath ?? join(this.#root, 'current.db');
    this.#currentJsonPath = join(this.#root, 'current.json');
  }

  async #database(): Promise<SqliteDatabase> {
    if (this.#db === null) {
      if (this.#databasePath !== ':memory:') {
        await mkdir(this.#root, { recursive: true });
      }
      const sqlite = await loadSqlite();
      this.#db = new sqlite.Database(this.#databasePath, { create: true, readwrite: true });
    }
    if (!this.#initialized) {
      this.#db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 2500;
        CREATE TABLE IF NOT EXISTS nodes (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS edges (
          src TEXT NOT NULL,
          dst TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (src, dst)
        );
        CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
        CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
        -- Queryable edge index (P3): edge_id -> (src, dst, kind). Lets
        -- readEdge do an O(1) bucket lookup instead of a full-table scan, and
        -- enables server-side edgeKind filtering. It is NEVER read during
        -- snapshot reconstruction (readCurrent/readSubgraph), so it is
        -- byte-invisible to the served graph and to snapshotRevision (a
        -- metadata-only hash). Auto-maintained by triggers off the edges
        -- bucket JSON, so EVERY writer (writeCurrentRows, replaceScopeRows,
        -- future) keeps it in sync without per-site code. Edge IDs encode
        -- (kind, from, to) and the bucket key is (from, to), so each edge_id
        -- maps to a fixed (src, dst) — it can never move buckets.
        CREATE TABLE IF NOT EXISTS edges_index (
          edge_id TEXT PRIMARY KEY,
          src TEXT NOT NULL,
          dst TEXT NOT NULL,
          kind TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_edges_index_kind ON edges_index(kind);
        CREATE TRIGGER IF NOT EXISTS trg_edges_index_ai AFTER INSERT ON edges BEGIN
          INSERT OR REPLACE INTO edges_index (edge_id, src, dst, kind)
          SELECT json_extract(e.value, '$.id'), NEW.src, NEW.dst, json_extract(e.value, '$.kind')
          FROM json_each(NEW.data) e;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_edges_index_au AFTER UPDATE ON edges BEGIN
          DELETE FROM edges_index WHERE src = OLD.src AND dst = OLD.dst;
          INSERT OR REPLACE INTO edges_index (edge_id, src, dst, kind)
          SELECT json_extract(e.value, '$.id'), NEW.src, NEW.dst, json_extract(e.value, '$.kind')
          FROM json_each(NEW.data) e;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_edges_index_ad AFTER DELETE ON edges BEGIN
          DELETE FROM edges_index WHERE src = OLD.src AND dst = OLD.dst;
        END;
        CREATE TABLE IF NOT EXISTS connections_scope_nodes (
          scope_kind TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          PRIMARY KEY (scope_kind, scope_id, node_id)
        );
        CREATE INDEX IF NOT EXISTS idx_scope_nodes_node
          ON connections_scope_nodes (node_id);
        CREATE TABLE IF NOT EXISTS connections_scope_edges (
          scope_kind TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          edge_src TEXT NOT NULL,
          edge_dst TEXT NOT NULL,
          PRIMARY KEY (scope_kind, scope_id, edge_src, edge_dst)
        );
        CREATE INDEX IF NOT EXISTS idx_scope_edges_edge
          ON connections_scope_edges (edge_src, edge_dst);
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connections_materializer_meta (
          materializer_name TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          snapshot_revision_id TEXT,
          applied_frontier TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connections_applied_intervals (
          materializer_name TEXT NOT NULL,
          replica_id TEXT NOT NULL,
          start_seq INTEGER NOT NULL,
          end_seq INTEGER NOT NULL,
          PRIMARY KEY (materializer_name, replica_id, start_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_applied_intervals_lookup
          ON connections_applied_intervals (materializer_name, replica_id, start_seq, end_seq);
        CREATE TABLE IF NOT EXISTS connections_resolver_cache (
          visit_id TEXT NOT NULL,
          snapshot_revision TEXT NOT NULL,
          result_json TEXT NOT NULL,
          computed_at TEXT NOT NULL,
          PRIMARY KEY (visit_id, snapshot_revision)
        );
      `);
      // One-time backfill of edges_index for DBs created before it existed;
      // the triggers maintain it on every subsequent edge write. Gated to run
      // at most once (index empty while edges exist) so steady-state boots
      // skip the json_each scan.
      const edgesIndexNeedsBackfill =
        (
          this.#db
            .query(
              'SELECT ((SELECT COUNT(*) FROM edges) > 0 AND (SELECT COUNT(*) FROM edges_index) = 0) AS need',
            )
            .get() as { need: number } | undefined
        )?.need === 1;
      if (edgesIndexNeedsBackfill) {
        this.#db.exec(`
          INSERT OR IGNORE INTO edges_index (edge_id, src, dst, kind)
          SELECT json_extract(e.value, '$.id'), edges.src, edges.dst, json_extract(e.value, '$.kind')
          FROM edges, json_each(edges.data) e;
        `);
      }
      this.#initialized = true;
    }
    return this.#db;
  }

  async #readMetadata(db: SqliteDatabase): Promise<StoredConnectionsMetadata | null> {
    const metadataRow = db.query('SELECT data FROM metadata WHERE key = ?').get('current');
    if (metadataRow === null || metadataRow === undefined) {
      return await this.#bootstrapFromJson(db);
    }
    return JSON.parse(textField(metadataRow, 'data')) as StoredConnectionsMetadata;
  }

  async #bootstrapFromJson(db: SqliteDatabase): Promise<StoredConnectionsMetadata | null> {
    try {
      const snapshot = JSON.parse(
        await readFile(this.#currentJsonPath, 'utf8'),
      ) as ConnectionsSnapshot;
      this.#writeCurrentRows(db, snapshot, null);
      return metadataForSnapshot(snapshot);
    } catch (error) {
      if ((isRecord(error) && error['code'] === 'ENOENT') || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  #readNodesByIds(db: SqliteDatabase, nodeIds: readonly string[]): Map<string, ConnectionNode> {
    const out = new Map<string, ConnectionNode>();
    const uniqueNodeIds = [...new Set(nodeIds)].filter((nodeId) => nodeId.length > 0);
    for (const batch of chunked(uniqueNodeIds, SQLITE_IN_CLAUSE_CHUNK_SIZE)) {
      if (batch.length === 0) continue;
      const rows = db
        .query(`SELECT data FROM nodes WHERE id IN (${placeholdersFor(batch.length)})`)
        .all(...batch);
      for (const row of rows) {
        const node = JSON.parse(textField(row, 'data')) as ConnectionNode;
        out.set(node.id, node);
      }
    }
    return out;
  }

  #readIncidentEdgesForNodes(
    db: SqliteDatabase,
    nodeIds: readonly string[],
  ): readonly ConnectionEdge[] {
    const out = new Map<string, ConnectionEdge>();
    const uniqueNodeIds = [...new Set(nodeIds)].filter((nodeId) => nodeId.length > 0);
    for (const batch of chunked(uniqueNodeIds, SQLITE_IN_CLAUSE_CHUNK_SIZE)) {
      if (batch.length === 0) continue;
      const placeholders = placeholdersFor(batch.length);
      const rows = db
        .query(`SELECT data FROM edges WHERE src IN (${placeholders}) OR dst IN (${placeholders})`)
        .all(...batch, ...batch);
      for (const row of rows) {
        for (const edge of JSON.parse(textField(row, 'data')) as ConnectionEdge[]) {
          out.set(edge.id, edge);
        }
      }
    }
    return [...out.values()];
  }

  #threadResolverSeedNodeIds(
    db: SqliteDatabase,
    input: {
      readonly threadId: string;
      readonly providerThreadId?: string;
      readonly threadUrl?: string;
    },
  ): readonly string[] {
    const seedNodeIds = new Set<string>();
    const threadNodeIds = new Set([nodeIdFor('thread', input.threadId)]);
    if (input.providerThreadId !== undefined && input.providerThreadId.length > 0) {
      threadNodeIds.add(nodeIdFor('thread', input.providerThreadId));
    }
    for (const threadNodeId of threadNodeIds) seedNodeIds.add(threadNodeId);

    const canonicalUrls = new Set<string>();
    if (input.threadUrl !== undefined && input.threadUrl.length > 0) {
      canonicalUrls.add(input.threadUrl);
      canonicalUrls.add(normalizeResolverUrl(input.threadUrl));
    }

    for (const row of db.query("SELECT data FROM nodes WHERE id LIKE 'thread:%'").all()) {
      const node = JSON.parse(textField(row, 'data')) as ConnectionNode;
      const metadataThreadId =
        typeof node.metadata.threadId === 'string' ? node.metadata.threadId : undefined;
      const metadataCanonical =
        typeof node.metadata.canonicalUrl === 'string'
          ? node.metadata.canonicalUrl
          : typeof node.metadata.url === 'string'
            ? node.metadata.url
            : undefined;
      if (
        threadNodeIds.has(node.id) ||
        metadataThreadId === input.threadId ||
        (input.providerThreadId !== undefined && metadataThreadId === input.providerThreadId) ||
        (metadataCanonical !== undefined &&
          canonicalUrls.has(normalizeResolverUrl(metadataCanonical)))
      ) {
        seedNodeIds.add(node.id);
        if (metadataCanonical !== undefined) {
          canonicalUrls.add(metadataCanonical);
          canonicalUrls.add(normalizeResolverUrl(metadataCanonical));
        }
      }
    }

    for (const canonicalUrl of canonicalUrls) {
      seedNodeIds.add(nodeIdFor('timeline-visit', canonicalUrl));
    }

    return [...seedNodeIds].sort();
  }

  async #readTraversedSubgraph(
    seedNodeIds: readonly string[],
    options: { readonly hops?: number; readonly preserveMetadataCounts?: boolean },
  ): Promise<ConnectionsSnapshot | null> {
    const db = await this.#database();
    const metadata = await this.#readMetadata(db);
    if (metadata === null) return null;

    const maxHops = options.hops ?? Number.POSITIVE_INFINITY;
    const visited = new Set<string>();
    let frontier = new Set<string>();
    for (const id of this.#readNodesByIds(db, seedNodeIds).keys()) {
      visited.add(id);
      frontier.add(id);
    }

    const edgeById = new Map<string, ConnectionEdge>();
    for (let depth = 0; frontier.size > 0 && depth < maxHops; depth += 1) {
      const next = new Set<string>();
      const incidentEdges = this.#readIncidentEdgesForNodes(db, [...frontier]);
      const endpointCandidates = new Set<string>();
      for (const edge of incidentEdges) {
        edgeById.set(edge.id, edge);
        if (!visited.has(edge.fromNodeId)) endpointCandidates.add(edge.fromNodeId);
        if (!visited.has(edge.toNodeId)) endpointCandidates.add(edge.toNodeId);
      }
      const existingEndpointNodes = this.#readNodesByIds(db, [...endpointCandidates]);
      for (const endpoint of existingEndpointNodes.keys()) {
        if (!visited.has(endpoint)) {
          visited.add(endpoint);
          next.add(endpoint);
        }
      }
      frontier = next;
    }

    for (const edge of this.#readIncidentEdgesForNodes(db, [...visited])) {
      if (visited.has(edge.fromNodeId) && visited.has(edge.toNodeId)) {
        edgeById.set(edge.id, edge);
      }
    }

    const nodes = [...this.#readNodesByIds(db, [...visited]).values()];
    return snapshotFromParts(
      metadata,
      sortAlphaById(nodes),
      sortAlphaById([...edgeById.values()]),
      {
        ...(options.preserveMetadataCounts === undefined
          ? {}
          : { preserveMetadataCounts: options.preserveMetadataCounts }),
      },
    );
  }

  readonly readSnapshotMetadata = async (): Promise<StoredConnectionsMetadata | null> => {
    const db = await this.#database();
    return await this.#readMetadata(db);
  };

  readonly readProjectionAccumulatorState = async (
    name: string,
  ): Promise<ConnectionsProjectionAccumulatorState | null> => {
    const db = await this.#database();
    const row = db
      .query('SELECT data FROM metadata WHERE key = ?')
      .get(projectionAccumulatorMetadataKey(name));
    if (row === null || row === undefined) return null;
    return JSON.parse(textField(row, 'data')) as ConnectionsProjectionAccumulatorState;
  };

  readonly vacuum = async (): Promise<void> => {
    const db = await this.#database();
    db.exec('VACUUM');
  };

  readonly cacheResolverResult = async (
    visitId: string,
    snapshotRevision: string,
    result: unknown,
  ): Promise<void> => {
    // Best-effort write. The cache lives in current.db, which the drain
    // child locks for long write transactions; a locked write must NEVER
    // fail the resolve — the caller already has the computed result and
    // will serve it. Skip caching this time; the next drain re-primes it.
    try {
      const db = await this.#database();
      db.query(
        `INSERT INTO connections_resolver_cache
          (visit_id, snapshot_revision, result_json, computed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(visit_id, snapshot_revision) DO UPDATE SET
           result_json = excluded.result_json,
           computed_at = excluded.computed_at`,
      ).run(visitId, snapshotRevision, JSON.stringify(result), new Date().toISOString());
    } catch (error) {
      if (isSqliteLockError(error)) return;
      throw error;
    }
  };

  readonly getCachedResolverResult = async (
    visitId: string,
    snapshotRevision: string,
  ): Promise<unknown | null> => {
    if (this.#resolverCacheStaleRevisions.has(snapshotRevision)) {
      return null;
    }
    if (
      this.#resolverCacheCurrentRevision !== null &&
      this.#resolverCacheCurrentRevision !== snapshotRevision
    ) {
      this.#resolverCacheStaleRevisions.add(this.#resolverCacheCurrentRevision);
      this.#resolverCacheCurrentRevision = snapshotRevision;
      this.#scheduleResolverCachePrune(snapshotRevision);
      return null;
    }
    this.#resolverCacheCurrentRevision = snapshotRevision;
    // Best-effort read. If the drain child holds the write lock, the
    // SELECT can throw "database is locked" — degrade to a cache miss
    // (null) so the caller computes the result inline rather than 500ing.
    try {
      const db = await this.#database();
      const row = db
        .query(
          `SELECT result_json
           FROM connections_resolver_cache
           WHERE visit_id = ? AND snapshot_revision = ?`,
        )
        .get(visitId, snapshotRevision);
      this.#scheduleResolverCachePrune(snapshotRevision);
      if (row === null || row === undefined) return null;
      return JSON.parse(textField(row, 'result_json')) as unknown;
    } catch (error) {
      if (isSqliteLockError(error)) return null;
      throw error;
    }
  };

  #scheduleResolverCachePrune(snapshotRevision: string): void {
    if (this.#resolverCachePruneScheduledFor === snapshotRevision) return;
    this.#resolverCachePruneScheduledFor = snapshotRevision;
    setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const db = await this.#database();
          db.query('DELETE FROM connections_resolver_cache WHERE snapshot_revision != ?').run(
            snapshotRevision,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[connections] resolver cache prune failed: ${message}`);
        } finally {
          if (this.#resolverCachePruneScheduledFor === snapshotRevision) {
            this.#resolverCachePruneScheduledFor = null;
          }
        }
      })();
    }, 0).unref?.();
  }

  readonly putCurrent = async (snapshot: ConnectionsSnapshot): Promise<void> => {
    const db = await this.#database();
    this.#writeCurrentRows(db, snapshot, null);
  };

  readonly writeSnapshotAndProgress = async (
    snapshot: ConnectionsSnapshot,
    progress: MaterializerProgress,
    dirtyScopes?: ReadonlySet<Scope>,
    projectionAccumulatorState?: ConnectionsProjectionAccumulatorState,
  ): Promise<void> => {
    const db = await this.#database();
    const shouldBootstrapScopeMembership = this.#writeCurrentRows(
      db,
      snapshot,
      progress,
      dirtyScopes,
      projectionAccumulatorState,
    );
    if (shouldBootstrapScopeMembership) {
      setImmediate(() => {
        void this.#bootstrapScopeMembership(snapshot).catch(() => undefined);
      });
    }
  };

  readonly applyProjectionEventOverlay = async (event: AcceptedEvent): Promise<string | null> => {
    const db = await this.#database();
    const bootstrapped = await this.#readMetadata(db);
    if (bootstrapped === null) return null;

    db.exec('BEGIN IMMEDIATE');
    try {
      const metadataRow = db.query('SELECT data FROM metadata WHERE key = ?').get('current');
      if (metadataRow === null || metadataRow === undefined) {
        db.exec('COMMIT');
        return null;
      }
      const metadata = JSON.parse(textField(metadataRow, 'data')) as StoredConnectionsMetadata;
      if (metadata.urlProjection === undefined && metadata.tabSessionProjection === undefined) {
        db.exec('COMMIT');
        return null;
      }

      const urlProjection =
        metadata.urlProjection === undefined
          ? undefined
          : (() => {
              const accumulator = urlProjectionAccumulatorFromSerialized(metadata.urlProjection);
              foldEventIntoUrlProjectionAccumulator(accumulator, event);
              return serializeUrlProjection(urlProjectionFromAccumulator(accumulator));
            })();
      const tabSessionProjection =
        metadata.tabSessionProjection === undefined
          ? undefined
          : (() => {
              const accumulator = tabSessionProjectionAccumulatorFromSerialized(
                metadata.tabSessionProjection,
              );
              foldEventIntoTabSessionProjectionAccumulator(accumulator, event);
              return serializeTabSessionProjection(
                tabSessionProjectionFromAccumulator(accumulator),
              );
            })();
      const updatedAt = projectionOverlayUpdatedAt({
        fallback: metadata.updatedAt,
        ...(urlProjection === undefined ? {} : { urlProjection }),
        ...(tabSessionProjection === undefined ? {} : { tabSessionProjection }),
      });
      const snapshotRevision = computeSnapshotRevision({
        updatedAt,
        nodeCount: metadata.nodeCount,
        edgeCount: metadata.edgeCount,
        urlProjectionKeyCount:
          urlProjection === undefined ? 0 : Object.keys(urlProjection.byCanonicalUrl).length,
        tabSessionProjectionKeyCount:
          tabSessionProjection === undefined
            ? 0
            : Object.keys(tabSessionProjection.bySessionId).length,
      });
      const nextMetadata: StoredConnectionsMetadata = {
        ...metadata,
        updatedAt,
        ...(urlProjection === undefined ? {} : { urlProjection }),
        ...(tabSessionProjection === undefined ? {} : { tabSessionProjection }),
        snapshotRevision,
      };
      db.query(
        'INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data',
      ).run('current', JSON.stringify(nextMetadata));
      // H6: applyProjectionEventOverlay mutates metadata.current —
      // bump the commit token so readCurrent's pre/post check sees
      // this commit.
      this.#bumpWriteSeq(db);
      db.exec('COMMIT');
      this.#dropCachedSnapshot();
      return snapshotRevision;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  readonly writeMaterializerProgress = async (progress: MaterializerProgress): Promise<void> => {
    const db = await this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#writeProgressRows(db, progress);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  readonly readScopesForNode = async (nodeId: string): Promise<Scope[]> => {
    const db = await this.#database();
    return db
      .query(
        `SELECT scope_kind, scope_id
         FROM connections_scope_nodes
         WHERE node_id = ?
         ORDER BY scope_kind, scope_id`,
      )
      .all(nodeId)
      .map((row) => ({
        kind: textField(row, 'scope_kind') as Scope['kind'],
        id: textField(row, 'scope_id'),
      }));
  };

  readonly readScopesForEdge = async (src: string, dst: string): Promise<Scope[]> => {
    const db = await this.#database();
    return db
      .query(
        `SELECT scope_kind, scope_id
         FROM connections_scope_edges
         WHERE edge_src = ? AND edge_dst = ?
         ORDER BY scope_kind, scope_id`,
      )
      .all(src, dst)
      .map((row) => ({
        kind: textField(row, 'scope_kind') as Scope['kind'],
        id: textField(row, 'scope_id'),
      }));
  };

  readonly readNodesForScope = async (scope: Scope): Promise<string[]> => {
    const db = await this.#database();
    return db
      .query(
        `SELECT node_id
         FROM connections_scope_nodes
         WHERE scope_kind = ? AND scope_id = ?
         ORDER BY node_id`,
      )
      .all(scope.kind, scope.id)
      .map((row) => textField(row, 'node_id'));
  };

  readonly readEdgesForScope = async (
    scope: Scope,
  ): Promise<Array<{ readonly src: string; readonly dst: string }>> => {
    const db = await this.#database();
    return db
      .query(
        `SELECT edge_src, edge_dst
         FROM connections_scope_edges
         WHERE scope_kind = ? AND scope_id = ?
         ORDER BY edge_src, edge_dst`,
      )
      .all(scope.kind, scope.id)
      .map((row) => ({ src: textField(row, 'edge_src'), dst: textField(row, 'edge_dst') }));
  };

  readonly replaceScopeRows = async (input: {
    readonly scopes: readonly Scope[];
    readonly nodes: readonly ConnectionNode[];
    readonly edges: readonly ConnectionEdge[];
    readonly progress: MaterializerProgress;
    readonly metadata?: {
      readonly urlProjection?: ConnectionsSnapshot['urlProjection'];
      readonly tabSessionProjection?: ConnectionsSnapshot['tabSessionProjection'];
    };
    readonly projectionAccumulatorState?: ConnectionsProjectionAccumulatorState;
    readonly progressMode?: 'replace' | 'snapshot-revision-only';
  }): Promise<void> => {
    const db = await this.#database();
    const edgeBuckets = new Map<string, ConnectionEdge[]>();
    for (const edge of input.edges) {
      const key = edgeBucketKey(edge);
      const bucket = edgeBuckets.get(key) ?? [];
      bucket.push(edge);
      edgeBuckets.set(key, bucket);
    }
    const memberships = scopesForGraphRows({ nodes: input.nodes, edges: input.edges });
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS temp_replace_scopes (
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        PRIMARY KEY (scope_kind, scope_id)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS temp_replace_nodes (
        node_id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS temp_replace_edges (
        edge_src TEXT NOT NULL,
        edge_dst TEXT NOT NULL,
        PRIMARY KEY (edge_src, edge_dst)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS temp_replace_new_edges (
        edge_src TEXT NOT NULL,
        edge_dst TEXT NOT NULL,
        PRIMARY KEY (edge_src, edge_dst)
      ) WITHOUT ROWID;
      DELETE FROM temp_replace_scopes;
      DELETE FROM temp_replace_nodes;
      DELETE FROM temp_replace_edges;
      DELETE FROM temp_replace_new_edges;
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      const insertTempScope = db.query(
        `INSERT OR IGNORE INTO temp_replace_scopes (scope_kind, scope_id)
         VALUES (?, ?)`,
      );
      const insertTempNewEdge = db.query(
        `INSERT OR IGNORE INTO temp_replace_new_edges (edge_src, edge_dst)
         VALUES (?, ?)`,
      );
      const deleteScopeNodes = db.query(
        `DELETE FROM connections_scope_nodes
         WHERE EXISTS (
           SELECT 1
           FROM temp_replace_scopes s
           WHERE s.scope_kind = connections_scope_nodes.scope_kind
             AND s.scope_id = connections_scope_nodes.scope_id
         )`,
      );
      const deleteScopeEdges = db.query(
        `DELETE FROM connections_scope_edges
         WHERE EXISTS (
           SELECT 1
           FROM temp_replace_scopes s
           WHERE s.scope_kind = connections_scope_edges.scope_kind
             AND s.scope_id = connections_scope_edges.scope_id
         )`,
      );
      const deleteOrphanNodes = db.query(
        `DELETE FROM nodes
         WHERE id IN (SELECT node_id FROM temp_replace_nodes)
           AND NOT EXISTS (
             SELECT 1
             FROM connections_scope_nodes c
             WHERE c.node_id = nodes.id
           )`,
      );
      const deleteOrphanEdges = db.query(
        `DELETE FROM edges
         WHERE EXISTS (
           SELECT 1
           FROM temp_replace_edges t
           WHERE t.edge_src = edges.src AND t.edge_dst = edges.dst
         )
           AND NOT EXISTS (
             SELECT 1
             FROM connections_scope_edges c
             WHERE c.edge_src = edges.src AND c.edge_dst = edges.dst
           )`,
      );
      const upsertNode = db.query(
        'INSERT INTO nodes (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      );
      const upsertEdge = db.query(
        'INSERT INTO edges (src, dst, data) VALUES (?, ?, ?) ON CONFLICT(src, dst) DO UPDATE SET data = excluded.data',
      );
      const insertScopeNode = db.query(
        `INSERT OR IGNORE INTO connections_scope_nodes
          (scope_kind, scope_id, node_id)
         VALUES (?, ?, ?)`,
      );
      const insertScopeEdge = db.query(
        `INSERT OR IGNORE INTO connections_scope_edges
          (scope_kind, scope_id, edge_src, edge_dst)
         VALUES (?, ?, ?, ?)`,
      );
      const selectMetadata = db.query('SELECT data FROM metadata WHERE key = ?');
      const metadataRow = selectMetadata.get('current');
      const previousMetadata: StoredConnectionsMetadata =
        metadataRow === null || metadataRow === undefined
          ? {
              scope: {},
              updatedAt: '1970-01-01T00:00:00.000Z',
              nodeCount: 0,
              edgeCount: 0,
            }
          : (JSON.parse(textField(metadataRow, 'data')) as StoredConnectionsMetadata);
      const upsertMetadata = db.query(
        'INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data',
      );
      const removedNodeOrderIds = new Set<string>();
      const addedNodeOrderIds = new Set<string>();
      const removedEdgeOrderIds = new Set<string>();
      const addedEdgeOrderIds = new Set<string>();
      let nodeOrder = metadataStringArray(selectMetadata.get('node_order'));
      let edgeOrder = metadataStringArray(selectMetadata.get('edge_order'));

      for (const scope of input.scopes) {
        insertTempScope.run(scope.kind, scope.id);
      }
      for (const key of edgeBuckets.keys()) {
        const [src, dst] = key.split('\u0000');
        if (src === undefined || dst === undefined) throw new Error('invalid edge bucket key');
        insertTempNewEdge.run(src, dst);
      }

      db.query(
        `INSERT OR IGNORE INTO temp_replace_nodes (node_id)
         SELECT DISTINCT n.node_id
         FROM connections_scope_nodes n
         JOIN temp_replace_scopes s
           ON s.scope_kind = n.scope_kind AND s.scope_id = n.scope_id`,
      ).run();
      db.query(
        `INSERT OR IGNORE INTO temp_replace_edges (edge_src, edge_dst)
         SELECT DISTINCT e.edge_src, e.edge_dst
         FROM connections_scope_edges e
         JOIN temp_replace_scopes s
           ON s.scope_kind = e.scope_kind AND s.scope_id = e.scope_id`,
      ).run();

      for (const row of db
        .query(
          `SELECT e.data
           FROM edges e
           JOIN temp_replace_new_edges n
             ON n.edge_src = e.src AND n.edge_dst = e.dst`,
        )
        .all()) {
        for (const edgeId of edgeIdsFromSerializedBucket(textField(row, 'data'))) {
          removedEdgeOrderIds.add(edgeId);
        }
      }

      deleteScopeNodes.run();
      deleteScopeEdges.run();

      for (const row of db
        .query(
          `SELECT n.id
           FROM nodes n
           JOIN temp_replace_nodes t ON t.node_id = n.id
           WHERE NOT EXISTS (
             SELECT 1
             FROM connections_scope_nodes c
             WHERE c.node_id = n.id
           )`,
        )
        .all()) {
        removedNodeOrderIds.add(textField(row, 'id'));
      }
      for (const row of db
        .query(
          `SELECT e.data
           FROM edges e
           JOIN temp_replace_edges t
             ON t.edge_src = e.src AND t.edge_dst = e.dst
           WHERE NOT EXISTS (
             SELECT 1
             FROM connections_scope_edges c
             WHERE c.edge_src = e.src AND c.edge_dst = e.dst
           )`,
        )
        .all()) {
        for (const edgeId of edgeIdsFromSerializedBucket(textField(row, 'data'))) {
          removedEdgeOrderIds.add(edgeId);
        }
      }
      deleteOrphanNodes.run();
      deleteOrphanEdges.run();

      for (const node of input.nodes) {
        upsertNode.run(node.id, JSON.stringify(node));
        addedNodeOrderIds.add(node.id);
        for (const scope of memberships.nodeScopes.get(node.id) ?? []) {
          insertScopeNode.run(scope.kind, scope.id, node.id);
        }
      }
      for (const [key, bucket] of edgeBuckets.entries()) {
        const [src, dst] = key.split('\u0000');
        if (src === undefined || dst === undefined) throw new Error('invalid edge bucket key');
        upsertEdge.run(src, dst, JSON.stringify(sortAlphaById(bucket)));
        for (const edge of bucket) addedEdgeOrderIds.add(edge.id);
        for (const scope of memberships.edgeScopes.get(key) ?? []) {
          insertScopeEdge.run(scope.kind, scope.id, src, dst);
        }
      }

      nodeOrder = patchSortedOrder({
        current: nodeOrder,
        removed: removedNodeOrderIds,
        added: addedNodeOrderIds,
      });
      edgeOrder = patchSortedOrder({
        current: edgeOrder,
        removed: removedEdgeOrderIds,
        added: addedEdgeOrderIds,
      });
      const urlProjection =
        input.metadata?.urlProjection === undefined
          ? previousMetadata.urlProjection
          : mergeUrlProjectionForWrite(
              input.metadata.urlProjection,
              previousMetadata.urlProjection,
            );
      const tabSessionProjection =
        input.metadata?.tabSessionProjection === undefined
          ? previousMetadata.tabSessionProjection
          : mergeTabSessionProjectionForWrite(
              input.metadata.tabSessionProjection,
              previousMetadata.tabSessionProjection,
            );
      const rowUpdatedAt = maxObservedAtForRows(
        previousMetadata.updatedAt,
        input.nodes,
        input.edges,
      );
      const updatedAt = projectionOverlayUpdatedAt({
        fallback: rowUpdatedAt,
        ...(urlProjection === undefined ? {} : { urlProjection }),
        ...(tabSessionProjection === undefined ? {} : { tabSessionProjection }),
      });
      const snapshotRevision = computeSnapshotRevision({
        updatedAt,
        nodeCount: nodeOrder.length,
        edgeCount: edgeOrder.length,
        urlProjectionKeyCount:
          urlProjection === undefined ? 0 : Object.keys(urlProjection.byCanonicalUrl).length,
        tabSessionProjectionKeyCount:
          tabSessionProjection === undefined
            ? 0
            : Object.keys(tabSessionProjection.bySessionId).length,
      });
      const metadata: StoredConnectionsMetadata = {
        ...previousMetadata,
        updatedAt,
        nodeCount: nodeOrder.length,
        edgeCount: edgeOrder.length,
        ...(urlProjection === undefined ? {} : { urlProjection }),
        ...(tabSessionProjection === undefined ? {} : { tabSessionProjection }),
        snapshotRevision,
      };
      upsertMetadata.run('current', JSON.stringify(metadata));
      upsertMetadata.run('node_order', JSON.stringify(nodeOrder));
      upsertMetadata.run('edge_order', JSON.stringify(edgeOrder));
      if (input.projectionAccumulatorState !== undefined) {
        upsertMetadata.run(
          projectionAccumulatorMetadataKey(input.projectionAccumulatorState.materializerName),
          JSON.stringify(input.projectionAccumulatorState),
        );
      }
      const baseProgress =
        input.progressMode === 'snapshot-revision-only'
          ? // Read persisted progress INSIDE this transaction so we don't
            // regress applied dot intervals on top of a concurrent drain
            // that committed between the caller's pre-transaction read of
            // input.progress and our BEGIN IMMEDIATE acquisition. Falls
            // back to input.progress if nothing is persisted yet (i.e.
            // the overlay is the very first writer for this materializer).
            (this.#readPersistedProgressInTx(db, input.progress.materializerName) ?? input.progress)
          : input.progress;
      this.#writeProgressRows(db, {
        ...baseProgress,
        snapshotRevisionId: snapshotRevision,
      });
      // H6: replaceScopeRows mutates nodes/edges/current/node_order/
      // edge_order — all inputs to readCurrent. Bump the commit
      // token so the pre/post check fires.
      this.#bumpWriteSeq(db);
      db.exec('COMMIT');
      this.#dropCachedSnapshot();
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  /** Monotonic commit token used by `readCurrent`'s pre/post check.
   *  Bump from INSIDE every transaction that mutates any of the rows
   *  `readCurrent` consumes (nodes, edges, metadata.current,
   *  metadata.node_order, metadata.edge_order). Centralized so adding
   *  a new writer can't accidentally bypass the consistency check —
   *  caller just invokes this right before COMMIT. */
  #bumpWriteSeq(db: SqliteDatabase): void {
    const row = db.query('SELECT data FROM metadata WHERE key = ?').get('write_seq');
    const prev =
      row === null || row === undefined ? 0 : Number.parseInt(textField(row, 'data'), 10) || 0;
    db.query(
      'INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data',
    ).run('write_seq', String(prev + 1));
  }

  async #bootstrapScopeMembership(snapshot: ConnectionsSnapshot): Promise<void> {
    const scopes = scopesForGraphRows({ nodes: snapshot.nodes, edges: snapshot.edges });
    const scopeKeys = new Set<string>();
    for (const nodeScopes of scopes.nodeScopes.values()) {
      for (const scope of nodeScopes) scopeKeys.add(`${scope.kind}\u0000${scope.id}`);
    }
    for (const edgeScopes of scopes.edgeScopes.values()) {
      for (const scope of edgeScopes) scopeKeys.add(`${scope.kind}\u0000${scope.id}`);
    }
    const db = await this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      const insertScopeNode = db.query(
        `INSERT OR IGNORE INTO connections_scope_nodes
          (scope_kind, scope_id, node_id)
         VALUES (?, ?, ?)`,
      );
      const insertScopeEdge = db.query(
        `INSERT OR IGNORE INTO connections_scope_edges
          (scope_kind, scope_id, edge_src, edge_dst)
         VALUES (?, ?, ?, ?)`,
      );
      db.query('DELETE FROM connections_scope_nodes').run();
      db.query('DELETE FROM connections_scope_edges').run();
      for (const [nodeId, nodeScopes] of scopes.nodeScopes.entries()) {
        for (const scope of nodeScopes) insertScopeNode.run(scope.kind, scope.id, nodeId);
      }
      for (const [key, edgeScopes] of scopes.edgeScopes.entries()) {
        const [src, dst] = key.split('\u0000');
        if (src === undefined || dst === undefined) throw new Error('invalid edge scope key');
        for (const scope of edgeScopes) insertScopeEdge.run(scope.kind, scope.id, src, dst);
      }
      db.exec('COMMIT');
      console.warn(
        `[connections-phase] scopeMembership.bootstrap mode=A scopes=${String(scopeKeys.size)}`,
      );
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  #writeCurrentRows(
    db: SqliteDatabase,
    snapshot: ConnectionsSnapshot,
    progress: MaterializerProgress | null,
    dirtyScopes?: ReadonlySet<Scope>,
    projectionAccumulatorState?: ConnectionsProjectionAccumulatorState,
  ): boolean {
    const nodeIds = snapshot.nodes.map((node) => node.id);
    const edgeBuckets = new Map<string, readonly ConnectionEdge[]>();
    for (const edge of snapshot.edges) {
      const key = edgeBucketKey(edge);
      const existing = edgeBuckets.get(key) ?? [];
      edgeBuckets.set(key, [...existing, edge]);
    }
    const edgeKeys = [...edgeBuckets.keys()].map((key) => {
      const [src, dst] = key.split('\u0000');
      if (src === undefined || dst === undefined) {
        throw new Error('invalid edge bucket key');
      }
      return { src, dst };
    });

    db.exec('BEGIN IMMEDIATE');
    try {
      const upsertNode = db.query(
        'INSERT INTO nodes (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      );
      const upsertEdge = db.query(
        'INSERT INTO edges (src, dst, data) VALUES (?, ?, ?) ON CONFLICT(src, dst) DO UPDATE SET data = excluded.data',
      );
      const upsertMetadata = db.query(
        'INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data',
      );
      const selectMetadata = db.query('SELECT data FROM metadata WHERE key = ?');
      const deleteNode = db.query('DELETE FROM nodes WHERE id = ?');
      const deleteEdge = db.query('DELETE FROM edges WHERE src = ? AND dst = ?');
      const deleteAllScopeNodes = db.query('DELETE FROM connections_scope_nodes');
      const deleteAllScopeEdges = db.query('DELETE FROM connections_scope_edges');
      const deleteScopeNodes = db.query(
        'DELETE FROM connections_scope_nodes WHERE scope_kind = ? AND scope_id = ?',
      );
      const deleteScopeEdges = db.query(
        'DELETE FROM connections_scope_edges WHERE scope_kind = ? AND scope_id = ?',
      );
      const insertScopeNode = db.query(
        `INSERT OR IGNORE INTO connections_scope_nodes
          (scope_kind, scope_id, node_id)
         VALUES (?, ?, ?)`,
      );
      const insertScopeEdge = db.query(
        `INSERT OR IGNORE INTO connections_scope_edges
          (scope_kind, scope_id, edge_src, edge_dst)
         VALUES (?, ?, ?, ?)`,
      );

      const currentNodeData = new Map(
        db
          .query('SELECT id, data FROM nodes')
          .all()
          .map((row) => [textField(row, 'id'), textField(row, 'data')] as const),
      );
      for (const node of snapshot.nodes) {
        const body = JSON.stringify(node);
        if (currentNodeData.get(node.id) !== body) {
          upsertNode.run(node.id, body);
        }
        currentNodeData.delete(node.id);
      }
      for (const staleId of currentNodeData.keys()) {
        deleteNode.run(staleId);
      }

      const currentEdgeData = new Map<string, string>(
        db
          .query('SELECT src, dst, data FROM edges')
          .all()
          .map(
            (row) =>
              [
                `${textField(row, 'src')}\u0000${textField(row, 'dst')}`,
                textField(row, 'data'),
              ] as const,
          ),
      );
      for (const { src, dst } of edgeKeys) {
        const key = `${src}\u0000${dst}`;
        const bucket = edgeBuckets.get(key) ?? [];
        const body = JSON.stringify(bucket);
        if (currentEdgeData.get(key) !== body) {
          upsertEdge.run(src, dst, body);
        }
        currentEdgeData.delete(key);
      }
      for (const staleKey of currentEdgeData.keys()) {
        const [src, dst] = staleKey.split('\u0000');
        if (src !== undefined && dst !== undefined) deleteEdge.run(src, dst);
      }

      const scopeMembershipEmpty =
        incrementalScopesEnabled() &&
        (
          db.query('SELECT COUNT(*) AS count FROM connections_scope_nodes').get() as
            | { readonly count: number }
            | undefined
        )?.count === 0 &&
        (
          db.query('SELECT COUNT(*) AS count FROM connections_scope_edges').get() as
            | { readonly count: number }
            | undefined
        )?.count === 0;
      if (incrementalScopesEnabled() && !scopeMembershipEmpty) {
        const memberships = scopesForGraphRows({ nodes: snapshot.nodes, edges: snapshot.edges });
        const dirtyScopeKeys =
          dirtyScopes === undefined
            ? null
            : new Set([...dirtyScopes].map((scope) => `${scope.kind}\u0000${scope.id}`));
        if (dirtyScopes === undefined) {
          deleteAllScopeNodes.run();
          deleteAllScopeEdges.run();
        } else {
          for (const scope of dirtyScopes) {
            deleteScopeNodes.run(scope.kind, scope.id);
            deleteScopeEdges.run(scope.kind, scope.id);
          }
        }
        for (const [nodeId, scopes] of memberships.nodeScopes.entries()) {
          for (const scope of scopes) {
            if (dirtyScopeKeys !== null && !dirtyScopeKeys.has(`${scope.kind}\u0000${scope.id}`)) {
              continue;
            }
            insertScopeNode.run(scope.kind, scope.id, nodeId);
          }
        }
        for (const [key, scopes] of memberships.edgeScopes.entries()) {
          const [src, dst] = key.split('\u0000');
          if (src === undefined || dst === undefined) throw new Error('invalid edge scope key');
          for (const scope of scopes) {
            if (dirtyScopeKeys !== null && !dirtyScopeKeys.has(`${scope.kind}\u0000${scope.id}`)) {
              continue;
            }
            insertScopeEdge.run(scope.kind, scope.id, src, dst);
          }
        }
      }

      const metadataRow = selectMetadata.get('current');
      const existingMetadata =
        metadataRow === null || metadataRow === undefined
          ? null
          : (JSON.parse(textField(metadataRow, 'data')) as StoredConnectionsMetadata);
      upsertMetadata.run(
        'current',
        JSON.stringify(metadataForSnapshotWrite(snapshot, existingMetadata)),
      );
      upsertMetadata.run('node_order', JSON.stringify(nodeIds));
      upsertMetadata.run('edge_order', JSON.stringify(snapshot.edges.map((edge) => edge.id)));
      if (projectionAccumulatorState !== undefined) {
        upsertMetadata.run(
          projectionAccumulatorMetadataKey(projectionAccumulatorState.materializerName),
          JSON.stringify(projectionAccumulatorState),
        );
      }
      // H6: writeCurrentRows mutates nodes/edges/current/node_order/
      // edge_order — all readCurrent inputs. Bump the commit token.
      this.#bumpWriteSeq(db);
      if (progress !== null) this.#writeProgressRows(db, progress);
      db.exec('COMMIT');
      // Invalidate the readCurrent memo — the next read will see the
      // new snapshotRevision and rebuild.
      this.#dropCachedSnapshot();
      return progress !== null && scopeMembershipEmpty;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // Synchronous read of persisted MaterializerProgress for use inside a
  // BEGIN IMMEDIATE transaction (so the result can't race a concurrent
  // writer). Mirrors readMaterializerProgress but without async hops.
  // Returns null when no row has been written for the named materializer.
  #readPersistedProgressInTx(db: SqliteDatabase, name: string): MaterializerProgress | null {
    const metaRow = db
      .query(
        `SELECT materializer_name, version, snapshot_revision_id, applied_frontier
         FROM connections_materializer_meta
         WHERE materializer_name = ?`,
      )
      .get(name);
    if (metaRow === null || metaRow === undefined) return null;
    if (!isRecord(metaRow)) return null;
    const appliedDotIntervals: Record<string, Array<readonly [number, number]>> = {};
    for (const row of db
      .query(
        `SELECT replica_id, start_seq, end_seq
         FROM connections_applied_intervals
         WHERE materializer_name = ?
         ORDER BY replica_id, start_seq, end_seq`,
      )
      .all(name)) {
      if (!isRecord(row)) continue;
      const replicaId = row['replica_id'];
      const startSeq = row['start_seq'];
      const endSeq = row['end_seq'];
      if (
        typeof replicaId !== 'string' ||
        typeof startSeq !== 'number' ||
        typeof endSeq !== 'number'
      ) {
        continue;
      }
      const intervals = appliedDotIntervals[replicaId] ?? [];
      intervals.push([startSeq, endSeq]);
      appliedDotIntervals[replicaId] = intervals;
    }
    const snapshotRevisionId = metaRow['snapshot_revision_id'];
    const appliedFrontier = metaRow['applied_frontier'];
    return {
      materializerName: textField(metaRow, 'materializer_name'),
      materializerVersion: textField(metaRow, 'version'),
      appliedDotIntervals,
      appliedFrontier:
        typeof appliedFrontier === 'string'
          ? (JSON.parse(appliedFrontier) as Record<string, number>)
          : {},
      snapshotRevisionId: typeof snapshotRevisionId === 'string' ? snapshotRevisionId : null,
    };
  }

  #writeProgressRows(db: SqliteDatabase, progress: MaterializerProgress): void {
    const upsertMeta = db.query(
      `INSERT INTO connections_materializer_meta
        (materializer_name, version, snapshot_revision_id, applied_frontier, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(materializer_name) DO UPDATE SET
         version = excluded.version,
         snapshot_revision_id = excluded.snapshot_revision_id,
         applied_frontier = excluded.applied_frontier,
         updated_at = excluded.updated_at`,
    );
    const deleteIntervals = db.query(
      'DELETE FROM connections_applied_intervals WHERE materializer_name = ?',
    );
    const insertInterval = db.query(
      `INSERT INTO connections_applied_intervals
        (materializer_name, replica_id, start_seq, end_seq)
       VALUES (?, ?, ?, ?)`,
    );

    upsertMeta.run(
      progress.materializerName,
      progress.materializerVersion,
      progress.snapshotRevisionId,
      JSON.stringify(progress.appliedFrontier),
      new Date().toISOString(),
    );
    deleteIntervals.run(progress.materializerName);
    for (const [replicaId, intervals] of Object.entries(progress.appliedDotIntervals)) {
      for (const [startSeq, endSeq] of intervals) {
        insertInterval.run(progress.materializerName, replicaId, startSeq, endSeq);
      }
    }
  }

  readonly readMaterializerProgress = async (
    name: string,
  ): Promise<MaterializerProgress | null> => {
    const db = await this.#database();
    const metaRow = db
      .query(
        `SELECT materializer_name, version, snapshot_revision_id, applied_frontier
         FROM connections_materializer_meta
         WHERE materializer_name = ?`,
      )
      .get(name);
    if (metaRow === null || metaRow === undefined) return null;

    const appliedDotIntervals: Record<string, Array<readonly [number, number]>> = {};
    for (const row of db
      .query(
        `SELECT replica_id, start_seq, end_seq
         FROM connections_applied_intervals
         WHERE materializer_name = ?
         ORDER BY replica_id, start_seq, end_seq`,
      )
      .all(name)) {
      if (!isRecord(row)) throw new Error('SQLite progress row is not a record');
      const replicaId = row['replica_id'];
      const startSeq = row['start_seq'];
      const endSeq = row['end_seq'];
      if (
        typeof replicaId !== 'string' ||
        typeof startSeq !== 'number' ||
        typeof endSeq !== 'number'
      ) {
        throw new Error('SQLite progress row has invalid interval fields');
      }
      const intervals = appliedDotIntervals[replicaId] ?? [];
      intervals.push([startSeq, endSeq]);
      appliedDotIntervals[replicaId] = intervals;
    }
    if (!isRecord(metaRow)) throw new Error('SQLite progress metadata row is not a record');
    const snapshotRevisionId = metaRow['snapshot_revision_id'];
    const appliedFrontier = metaRow['applied_frontier'];
    return {
      materializerName: textField(metaRow, 'materializer_name'),
      materializerVersion: textField(metaRow, 'version'),
      appliedDotIntervals,
      appliedFrontier:
        typeof appliedFrontier === 'string'
          ? (JSON.parse(appliedFrontier) as Record<string, number>)
          : {},
      snapshotRevisionId: typeof snapshotRevisionId === 'string' ? snapshotRevisionId : null,
    };
  };

  readonly readCurrent = async (): Promise<ConnectionsSnapshot | null> => {
    // Retry loop for the rare write-interleave: if the writer commits
    // a new snapshot revision between our metadata-read and the final
    // page, we restart. In steady state this never fires (one writer,
    // single reader); during a heavy drain it might retry once.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const result = await this.#readCurrentAttempt();
      if (result !== 'stale') return result;
    }
    // After max attempts, fall back to the "honest stale" read: take
    // whatever the latest committed metadata says, accept mild
    // inconsistency in flight. No worse than the pre-paged version.
    const fallback = await this.#readCurrentAttempt(true);
    // acceptStale=true never returns the 'stale' sentinel.
    return fallback === 'stale' ? null : fallback;
  };

  /** One attempt at reading the current snapshot.
   *
   *  Returns:
   *  - `null` if metadata is missing (no snapshot yet)
   *  - the snapshot value on success
   *  - the sentinel `'stale'` if the snapshot_revision changed between
   *    our pre-read metadata and the post-read re-check. Caller
   *    retries.
   *
   *  When `acceptStale` is true, skips the revision re-check and
   *  returns whatever was read (used as the final-attempt fallback).
   *
   *  Per Codex review 2026-05-25: a writer can commit between the
   *  paged reads, so a single response could otherwise mix two
   *  snapshot revisions. We can't use a long-held read transaction
   *  (BEGIN DEFERRED with awaits would hold a SHARED lock across
   *  event-loop turns — bad). Instead, validate the revision didn't
   *  change pre-vs-post. Paged reads are sub-100ms each, so the
   *  window for a writer to slip in is tiny. */
  #readCurrentAttempt = async (
    acceptStale = false,
  ): Promise<ConnectionsSnapshot | null | 'stale'> => {
    const db = await this.#database();
    const metadata = await this.#readMetadata(db);
    if (metadata === null) return null;
    const revisionKey = metadata.snapshotRevision ?? '';
    if (this.#cachedSnapshot !== null && this.#cachedSnapshot.revision === revisionKey) {
      this.#cachedSnapshotLastAccessMs = Date.now();
      return this.#cachedSnapshot.value;
    }
    if (this.#cachedSnapshot !== null) {
      // The fork-per-drain child writes new current.db revisions without
      // touching this main-process memo. Release the stale full graph
      // before paging the replacement into JS objects so the allocator can
      // reuse those freed pages instead of growing for old + new graphs.
      this.#dropCachedSnapshot();
    }
    // H6: capture write_seq BEFORE any paged read. We compare the
    // post-read value with this to detect a writer that committed
    // between our reads. snapshotRevision alone isn't sufficient —
    // it's a content-hash of metadata-only fields, so two distinct
    // commits could produce the same revision. write_seq is bumped
    // by #bumpWriteSeq from every transaction that mutates
    // readCurrent inputs (#writeCurrentRows, replaceScopeRows,
    // applyProjectionEventOverlay) and is the strict commit token.
    const preSeqRow = db.query('SELECT data FROM metadata WHERE key = ?').get('write_seq');
    const preWriteSeq =
      preSeqRow === null || preSeqRow === undefined
        ? 0
        : Number.parseInt(textField(preSeqRow, 'data'), 10) || 0;
    // Edge rows store JSON ARRAYS (one row contains many edges), so a
    // page size that's OK for nodes can be expensive in edge parsing.
    // Use a smaller page for edges; both are well under the runtime's
    // 250ms `[api.stall]` threshold per chunk.
    const NODE_PAGE_SIZE = 500;
    const EDGE_PAGE_SIZE = 200;
    const yieldToLoop = (): Promise<void> =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    const nodesById = new Map<string, ConnectionNode>();
    const nodePageStmt = db.query('SELECT data FROM nodes ORDER BY id LIMIT ? OFFSET ?');
    for (let offset = 0; ; offset += NODE_PAGE_SIZE) {
      const page = nodePageStmt.all(NODE_PAGE_SIZE, offset);
      if (page.length === 0) break;
      for (const row of page) {
        const node = JSON.parse(textField(row, 'data')) as ConnectionNode;
        nodesById.set(node.id, node);
      }
      if (page.length < NODE_PAGE_SIZE) break;
      await yieldToLoop();
    }
    const edgeById = new Map<string, ConnectionEdge>();
    const edgePageStmt = db.query('SELECT data FROM edges ORDER BY src, dst LIMIT ? OFFSET ?');
    for (let offset = 0; ; offset += EDGE_PAGE_SIZE) {
      const page = edgePageStmt.all(EDGE_PAGE_SIZE, offset);
      if (page.length === 0) break;
      for (const row of page) {
        const arr = JSON.parse(textField(row, 'data')) as ConnectionEdge[];
        for (const edge of arr) edgeById.set(edge.id, edge);
      }
      if (page.length < EDGE_PAGE_SIZE) break;
      await yieldToLoop();
    }
    // H6 — read order rows BEFORE the consistency check, then verify
    // write_seq didn't move during ANY of the reads. Writer commits
    // current/node_order/edge_order atomically in one transaction
    // (#writeCurrentRows), so a single post-read write_seq check
    // covers all four input rows. snapshotRevision-based equality
    // could pass even when content changed; write_seq cannot.
    const nodeOrderRow = db.query('SELECT data FROM metadata WHERE key = ?').get('node_order');
    const edgeOrderRow = db.query('SELECT data FROM metadata WHERE key = ?').get('edge_order');
    if (!acceptStale) {
      const postSeqRow = db.query('SELECT data FROM metadata WHERE key = ?').get('write_seq');
      const postWriteSeq =
        postSeqRow === null || postSeqRow === undefined
          ? 0
          : Number.parseInt(textField(postSeqRow, 'data'), 10) || 0;
      if (postWriteSeq !== preWriteSeq) return 'stale';
    }
    const nodeOrder =
      nodeOrderRow === null || nodeOrderRow === undefined
        ? [...nodesById.keys()].sort()
        : (JSON.parse(textField(nodeOrderRow, 'data')) as string[]);
    const edgeOrder =
      edgeOrderRow === null || edgeOrderRow === undefined
        ? [...edgeById.keys()].sort()
        : (JSON.parse(textField(edgeOrderRow, 'data')) as string[]);
    // H7: chunk the tail materialization too — node_order can be 5k+,
    // edge_order can be 12k+, each .flatMap was a single sync pass.
    const TAIL_CHUNK = 1000;
    const nodes: ConnectionNode[] = [];
    for (let i = 0; i < nodeOrder.length; i += TAIL_CHUNK) {
      const slice = nodeOrder.slice(i, i + TAIL_CHUNK);
      for (const id of slice) {
        const node = nodesById.get(id);
        if (node !== undefined) nodes.push(node);
      }
      if (i + TAIL_CHUNK < nodeOrder.length) await yieldToLoop();
    }
    const edges: ConnectionEdge[] = [];
    for (let i = 0; i < edgeOrder.length; i += TAIL_CHUNK) {
      const slice = edgeOrder.slice(i, i + TAIL_CHUNK);
      for (const id of slice) {
        const edge = edgeById.get(id);
        if (edge !== undefined) edges.push(edge);
      }
      if (i + TAIL_CHUNK < edgeOrder.length) await yieldToLoop();
    }
    const result = snapshotFromParts(metadata, nodes, edges);
    this.#cachedSnapshot = { revision: revisionKey, value: result };
    this.#cachedSnapshotLastAccessMs = Date.now();
    // Anchor the eviction timer to install time, not last-access.
    // Same race avoidance as the eventLog mergedMemo sweep.
    this.#scheduleCachedSnapshotSweep(SqliteConnectionsStore.#CACHED_SNAPSHOT_IDLE_MS);
    return result;
  };

  readonly readSubgraph = async (
    nodeIds: readonly string[],
  ): Promise<ConnectionsSnapshot | null> => {
    const db = await this.#database();
    const metadata = await this.#readMetadata(db);
    if (metadata === null) return null;

    const wanted = [...new Set(nodeIds)].sort();
    if (wanted.length === 0) {
      return snapshotFromParts(metadata, [], []);
    }

    const nodeById = new Map<string, ConnectionNode>();
    const getNode = db.query('SELECT data FROM nodes WHERE id = ?');
    for (const nodeId of wanted) {
      const row = getNode.get(nodeId);
      if (row !== null && row !== undefined) {
        const node = JSON.parse(textField(row, 'data')) as ConnectionNode;
        nodeById.set(node.id, node);
      }
    }

    const wantedSet = new Set(wanted);
    const edges: ConnectionEdge[] = [];
    const edgesFrom = db.query('SELECT data FROM edges WHERE src = ?');
    for (const nodeId of wanted) {
      for (const row of edgesFrom.all(nodeId)) {
        const bucket = JSON.parse(textField(row, 'data')) as ConnectionEdge[];
        edges.push(
          ...bucket.filter(
            (edge) => wantedSet.has(edge.fromNodeId) && wantedSet.has(edge.toNodeId),
          ),
        );
      }
    }

    return snapshotFromParts(metadata, sortAlphaById([...nodeById.values()]), sortAlphaById(edges));
  };

  readonly readSubgraphForNode = async (
    nodeId: string,
    hops: number,
  ): Promise<ConnectionsSnapshot | null> =>
    await this.#readTraversedSubgraph([nodeId], { hops: Math.max(0, Math.min(hops, 4)) });

  readonly readResolverSubgraphForTabSession = async (
    tabSessionId: string,
  ): Promise<ConnectionsSnapshot | null> =>
    await this.#readTraversedSubgraph([nodeIdFor('tab-session', tabSessionId)], {
      hops: RESOLVER_SUBGRAPH_HOPS,
    });

  readonly readResolverSubgraphForUrl = async (
    canonicalUrl: string,
  ): Promise<ConnectionsSnapshot | null> => await this.readResolverSubgraphForUrls([canonicalUrl]);

  readonly readResolverSubgraphForUrls = async (
    canonicalUrls: readonly string[],
  ): Promise<ConnectionsSnapshot | null> => {
    const seedNodeIds = new Set<string>();
    for (const canonicalUrl of canonicalUrls) {
      if (canonicalUrl.length === 0) continue;
      seedNodeIds.add(nodeIdFor('timeline-visit', canonicalUrl));
      seedNodeIds.add(nodeIdFor('timeline-visit', normalizeResolverUrl(canonicalUrl)));
    }
    return await this.#readTraversedSubgraph([...seedNodeIds], {
      hops: RESOLVER_URL_SUBGRAPH_HOPS,
    });
  };

  readonly readResolverSubgraphForThread = async (_input: {
    readonly threadId: string;
    readonly providerThreadId?: string;
    readonly threadUrl?: string;
  }): Promise<ConnectionsSnapshot | null> => {
    const db = await this.#database();
    return await this.#readTraversedSubgraph(this.#threadResolverSeedNodeIds(db, _input), {
      hops: RESOLVER_SUBGRAPH_HOPS,
    });
  };

  readonly readEdge = async (edgeId: string): Promise<ConnectionEdge | null> => {
    const db = await this.#database();
    // O(1) path: edges_index maps edge_id -> (src, dst), so we read only that
    // one bucket via the (src, dst) primary key instead of scanning every
    // edge bucket. The index is auto-maintained by triggers (see #database).
    const idxRow = db.query('SELECT src, dst FROM edges_index WHERE edge_id = ?').get(edgeId);
    if (idxRow !== null && idxRow !== undefined) {
      const bucketRow = db
        .query('SELECT data FROM edges WHERE src = ? AND dst = ?')
        .get(textField(idxRow, 'src'), textField(idxRow, 'dst'));
      if (bucketRow !== null && bucketRow !== undefined) {
        const match = (JSON.parse(textField(bucketRow, 'data')) as ConnectionEdge[]).find(
          (edge) => edge.id === edgeId,
        );
        if (match !== undefined) return match;
      }
    }
    // Fallback full scan: covers an index miss (e.g. an edge written in the
    // same tick a pre-index DB is being backfilled). Correctness over speed.
    for (const row of db.query('SELECT data FROM edges').all()) {
      const match = (JSON.parse(textField(row, 'data')) as ConnectionEdge[]).find(
        (edge) => edge.id === edgeId,
      );
      if (match !== undefined) return match;
    }
    return null;
  };

  readonly putDay = async (date: string, snapshot: ConnectionsSnapshot): Promise<void> => {
    await writeConnectionsSnapshotJson(join(this.#snapshotsDir, `${date}.json`), snapshot);
  };

  readonly readDay = async (date: string): Promise<ConnectionsSnapshot | null> => {
    try {
      return JSON.parse(
        await readFile(join(this.#snapshotsDir, `${date}.json`), 'utf8'),
      ) as ConnectionsSnapshot;
    } catch {
      return null;
    }
  };

  readonly listDays = async (): Promise<readonly string[]> => {
    try {
      const entries = await readdir(this.#snapshotsDir);
      return entries
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map((name) => name.replace(/\.json$/u, ''))
        .sort();
    } catch {
      return [];
    }
  };

  close(): void {
    this.#db?.close?.();
    this.#db = null;
    this.#initialized = false;
  }
}

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${createRevision()}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const writeConnectionsSnapshotJson = async (
  path: string,
  snapshot: ConnectionsSnapshot,
): Promise<void> => {
  await writeAtomic(path, JSON.stringify(snapshot, null, 2));
};

export const createConnectionsStore = (vaultRoot: string): ConnectionsStore => {
  if (process.env['SIDETRACK_CONNECTIONS_STORE'] !== CONNECTIONS_STORE_JSON_FLAG) {
    return new SqliteConnectionsStore(vaultRoot);
  }

  const root = join(vaultRoot, '_BAC', 'connections');
  const snapshotsDir = join(root, SNAPSHOTS_DIR);
  const currentPath = join(root, 'current.json');
  const progressPath = join(root, 'current.progress.json');

  const dayPath = (date: string): string => join(snapshotsDir, `${date}.json`);

  // Stage 5.2 W5 — store-level skip-write. The materializer publishes
  // snapshots on every drain even when the inputs haven't changed;
  // skip the 200KB+ write when the snapshotRevision id is unchanged.
  let lastWrittenRevision: string | null = null;

  const putCurrent = async (snapshot: ConnectionsSnapshot): Promise<void> => {
    const revision = snapshot.snapshotRevision;
    if (revision !== undefined && revision === lastWrittenRevision) {
      // Same revision as last write — disk already has this snapshot.
      return;
    }
    await writeConnectionsSnapshotJson(currentPath, snapshot);
    if (revision !== undefined) lastWrittenRevision = revision;
  };

  const writeSnapshotAndProgress = async (
    snapshot: ConnectionsSnapshot,
    progress: MaterializerProgress,
    _dirtyScopes?: ReadonlySet<Scope>,
    projectionAccumulatorState?: ConnectionsProjectionAccumulatorState,
  ): Promise<void> => {
    await putCurrent(snapshot);
    await writeAtomic(
      progressPath,
      JSON.stringify(
        projectionAccumulatorState === undefined
          ? progress
          : { ...progress, projectionAccumulatorState },
        null,
        2,
      ),
    );
  };

  const writeMaterializerProgress = async (progress: MaterializerProgress): Promise<void> => {
    await writeAtomic(progressPath, JSON.stringify(progress, null, 2));
  };

  const readMaterializerProgress = async (name: string): Promise<MaterializerProgress | null> => {
    try {
      const progress = JSON.parse(await readFile(progressPath, 'utf8')) as MaterializerProgress;
      return progress.materializerName === name ? progress : null;
    } catch {
      return null;
    }
  };

  const readProjectionAccumulatorState = async (
    name: string,
  ): Promise<ConnectionsProjectionAccumulatorState | null> => {
    try {
      const progress = JSON.parse(await readFile(progressPath, 'utf8')) as {
        readonly projectionAccumulatorState?: ConnectionsProjectionAccumulatorState;
      };
      const state = progress.projectionAccumulatorState;
      if (state === undefined) return null;
      return state.materializerName === name ? state : null;
    } catch {
      return null;
    }
  };

  // P-perf — readCurrent() memoization keyed on current.json
  // (mtimeMs,size), mirroring readMerged()'s proven memo in
  // sync/eventLog.ts. current.json is ~20MB; re-reading + JSON.parse
  // on every resolve cache-miss / projection overlay was the dominant
  // CPU cost. putCurrent's skip-write means the file only changes
  // when the snapshot REVISION actually changed — so an unchanged
  // graph keeps a stable signature and the memo holds (no re-parse
  // storm on benign drains); a genuinely changed graph correctly
  // invalidates and re-parses (correctness > the parse cost — proven
  // by the connectionsRoutes/timelineRelaySync contract tests).
  // Single-flight collapses concurrent misses; snapshot is read-only
  // by contract for every caller.
  let currentMemo: { signature: string; value: ConnectionsSnapshot } | null = null;
  let currentInFlight: {
    signature: string;
    promise: Promise<ConnectionsSnapshot | null>;
  } | null = null;
  const readCurrent = async (): Promise<ConnectionsSnapshot | null> => {
    let signature: string;
    try {
      const s = await stat(currentPath);
      signature = `${String(s.mtimeMs)}:${String(s.size)}`;
    } catch {
      currentMemo = null;
      return null;
    }
    if (currentMemo !== null && currentMemo.signature === signature) {
      return currentMemo.value;
    }
    if (currentInFlight !== null && currentInFlight.signature === signature) {
      return currentInFlight.promise;
    }
    const promise = (async (): Promise<ConnectionsSnapshot | null> => {
      try {
        const value = JSON.parse(await readFile(currentPath, 'utf8')) as ConnectionsSnapshot;
        currentMemo = { signature, value };
        return value;
      } catch {
        return null;
      } finally {
        if (currentInFlight !== null && currentInFlight.signature === signature) {
          currentInFlight = null;
        }
      }
    })();
    currentInFlight = { signature, promise };
    return promise;
  };

  const putDay = async (date: string, snapshot: ConnectionsSnapshot): Promise<void> => {
    await writeConnectionsSnapshotJson(dayPath(date), snapshot);
  };
  const readDay = async (date: string): Promise<ConnectionsSnapshot | null> => {
    try {
      return JSON.parse(await readFile(dayPath(date), 'utf8')) as ConnectionsSnapshot;
    } catch {
      return null;
    }
  };

  const listDays = async (): Promise<readonly string[]> => {
    try {
      const entries = await readdir(snapshotsDir);
      return entries
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map((name) => name.replace(/\.json$/u, ''))
        .sort();
    } catch {
      return [];
    }
  };

  return {
    putCurrent,
    writeSnapshotAndProgress,
    writeMaterializerProgress,
    readMaterializerProgress,
    readProjectionAccumulatorState,
    readCurrent,
    putDay,
    readDay,
    listDays,
  };
};

// Subgraph helpers — used by the HTTP routes + MCP tools to crop a
// snapshot to a specific anchor or path.

export const subgraphForNode = (
  snapshot: ConnectionsSnapshot,
  nodeId: string,
  hops: number,
): ConnectionsSnapshot => {
  if (hops < 0) hops = 0;
  if (hops > 4) hops = 4;
  const visited = new Set<string>([nodeId]);
  let frontier = new Set<string>([nodeId]);
  const allEdges = new Map(snapshot.edges.map((e) => [e.id, e] as const));
  const keptEdges = new Map<string, ConnectionEdge>();

  for (let h = 0; h < hops; h += 1) {
    const next = new Set<string>();
    for (const edge of allEdges.values()) {
      if (frontier.has(edge.fromNodeId) && !visited.has(edge.toNodeId)) {
        keptEdges.set(edge.id, edge);
        next.add(edge.toNodeId);
      }
      if (frontier.has(edge.toNodeId) && !visited.has(edge.fromNodeId)) {
        keptEdges.set(edge.id, edge);
        next.add(edge.fromNodeId);
      }
      // Edges between two already-visited nodes still belong in the
      // subgraph (closed-loop links).
      if (visited.has(edge.fromNodeId) && visited.has(edge.toNodeId)) {
        keptEdges.set(edge.id, edge);
      }
    }
    for (const id of next) visited.add(id);
    frontier = next;
    if (frontier.size === 0) break;
  }

  const allNodes = new Map(snapshot.nodes.map((n) => [n.id, n] as const));
  const keptNodes: ConnectionNode[] = [];
  for (const id of visited) {
    const n = allNodes.get(id);
    if (n !== undefined) keptNodes.push(n);
  }

  return {
    scope: { ...(snapshot.scope ?? {}), nodeId, hops },
    nodes: sortAlphaById(keptNodes),
    edges: sortAlphaById([...keptEdges.values()]),
    updatedAt: snapshot.updatedAt,
    nodeCount: keptNodes.length,
    edgeCount: keptEdges.size,
    ...(snapshot.snapshotRevision === undefined
      ? {}
      : { snapshotRevision: snapshot.snapshotRevision }),
  };
};

export const findPath = (
  snapshot: ConnectionsSnapshot,
  fromNodeId: string,
  toNodeId: string,
  maxHops = 4,
):
  | { found: true; nodes: readonly ConnectionNode[]; edges: readonly ConnectionEdge[] }
  | { found: false } => {
  if (fromNodeId === toNodeId) {
    const node = snapshot.nodes.find((n) => n.id === fromNodeId);
    if (node !== undefined) return { found: true, nodes: [node], edges: [] };
    return { found: false };
  }
  // BFS over undirected edges; return the first path found.
  const adjacency = new Map<string, ConnectionEdge[]>();
  for (const edge of snapshot.edges) {
    const a = adjacency.get(edge.fromNodeId) ?? [];
    a.push(edge);
    adjacency.set(edge.fromNodeId, a);
    const b = adjacency.get(edge.toNodeId) ?? [];
    b.push(edge);
    adjacency.set(edge.toNodeId, b);
  }
  const queue: { nodeId: string; pathNodes: string[]; pathEdges: ConnectionEdge[] }[] = [
    { nodeId: fromNodeId, pathNodes: [fromNodeId], pathEdges: [] },
  ];
  const visited = new Set<string>([fromNodeId]);
  while (queue.length > 0) {
    const { nodeId, pathNodes, pathEdges } = queue.shift()!;
    if (pathEdges.length >= maxHops) continue;
    for (const edge of adjacency.get(nodeId) ?? []) {
      const otherEnd = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
      if (visited.has(otherEnd)) continue;
      visited.add(otherEnd);
      const nextNodes = [...pathNodes, otherEnd];
      const nextEdges = [...pathEdges, edge];
      if (otherEnd === toNodeId) {
        const nodeMap = new Map(snapshot.nodes.map((n) => [n.id, n] as const));
        return {
          found: true,
          nodes: nextNodes
            .map((id) => nodeMap.get(id))
            .filter((n): n is ConnectionNode => n !== undefined),
          edges: nextEdges,
        };
      }
      queue.push({ nodeId: otherEnd, pathNodes: nextNodes, pathEdges: nextEdges });
    }
  }
  return { found: false };
};
