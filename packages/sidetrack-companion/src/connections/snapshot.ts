import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
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
  type TopicRevision,
} from '../producers/topic-revision.js';
import { QUEUE_CREATED, isQueueCreatedPayload } from '../queue/events.js';
import { CAPTURE_RECORDED, isCaptureRecordedPayload } from '../recall/events.js';
import { generateCandidates } from '../ranker/candidates.js';
import { FEATURE_SCHEMA_VERSION, type CandidatePairFeatures } from '../ranker/feature-schema.js';
import { extractFeatures } from '../ranker/features.js';
import type { Candidate } from '../ranker/types.js';
import { projectSnippetLineage } from '../snippets/projection.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import type { TabSessionProjection } from '../tabsession/projection.js';
import type { UrlProjection } from '../urls/projection.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';
import { THREAD_UPSERTED, isThreadUpsertedPayload } from '../threads/events.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  isBrowserTimelineObservedPayload,
  type TimelineTransition,
} from '../timeline/events.js';
import type { TimelineDayProjection } from '../timeline/projection.js';
import { detectSearchUrl } from '../timeline/sanitize.js';
import { VISUAL_FINGERPRINT_OBSERVED } from '../visual/events.js';
import { projectVisualFingerprints } from '../visual/projection.js';
import { WORKSTREAM_UPSERTED, isWorkstreamUpsertedPayload } from '../workstreams/events.js';
import type { EngagementClassRevision } from './engagementClassifier.js';
import { findThreadQuotes, type ThreadText } from './quoteIndex.js';
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
  readonly topicWorkstreamShareThreshold?: number;
  readonly crossReplica?: CrossReplicaMaterialization;
  readonly engagementClassRevision?: EngagementClassRevision;
  readonly closestVisitRanker?: ClosestVisitRanker;
  readonly scope?: ConnectionsSnapshotScope;
}

export interface ClosestVisitRankerPrediction {
  readonly score: number;
  readonly contributions: Readonly<Record<keyof CandidatePairFeatures, number>>;
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
  return sorted as ConnectionNodeMetadata;
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

const visitKeyFromNodeOrRaw = (value: string): string =>
  value.startsWith(TIMELINE_VISIT_NODE_PREFIX)
    ? value.slice(TIMELINE_VISIT_NODE_PREFIX.length)
    : stripFragmentAndTrailingSlash(value);

const visitInstanceKey = (input: {
  readonly tabSessionId: string;
  readonly visitKey: string;
  readonly firstSeenAt: string;
}): string => `${input.tabSessionId}:${input.firstSeenAt}:${input.visitKey}`;

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
      (entry.transition !== undefined && VISIT_INSTANCE_INCREMENTING_TRANSITIONS.has(entry.transition)
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
  contributions: Readonly<Record<keyof CandidatePairFeatures, number>>,
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
  for (const event of input.events) {
    const observedAtIso = new Date(event.acceptedAtMs).toISOString();
    trackObservedAt(observedAtIso);
    const replicaId = event.dot.replicaId;

    if (event.type === THREAD_UPSERTED && isThreadUpsertedPayload(event.payload)) {
      const p = event.payload;
      const threadKey = p.bac_id;
      // The thread payload's lastSeenAt is the user-relevant
      // timestamp (the moment the user touched the thread); track
      // it for global maxObservedAt so the snapshot updatedAt
      // reflects user-perspective time, not just runner accept
      // time.
      trackObservedAt(p.lastSeenAt);
      upsertNode(nodes, {
        kind: 'thread',
        key: threadKey,
        label: p.title ?? p.threadUrl ?? threadKey,
        observedAt: p.lastSeenAt ?? observedAtIso,
        replicaId,
        metadata: {
          provider: p.provider,
          url: p.threadUrl,
          title: p.title,
          ...(p.primaryWorkstreamId === undefined ? {} : { workstreamId: p.primaryWorkstreamId }),
        },
      });
      if (p.primaryWorkstreamId !== undefined) {
        // Edge target may not exist yet; we create the workstream
        // node lazily so the edge has a valid endpoint either way.
        const wsKey = p.primaryWorkstreamId;
        upsertNode(nodes, {
          kind: 'workstream',
          key: wsKey,
          label: wsKey,
          observedAt: observedAtIso,
          replicaId,
        });
        const fromId = nodeIdFor('thread', threadKey);
        const toId = nodeIdFor('workstream', wsKey);
        upsertEdge(edges, {
          kind: 'thread_in_workstream',
          fromNodeId: fromId,
          toNodeId: toId,
          observedAt: observedAtIso,
          producedBy: {
            source: 'event-log',
            eventType: THREAD_UPSERTED,
            dot: { replicaId, seq: event.dot.seq },
          },
          confidence: 'asserted',
        });
      }
      continue;
    }

    if (event.type === WORKSTREAM_UPSERTED && isWorkstreamUpsertedPayload(event.payload)) {
      const p = event.payload;
      upsertNode(nodes, {
        kind: 'workstream',
        key: p.bac_id,
        label: p.title ?? p.bac_id,
        observedAt: observedAtIso,
        replicaId,
        metadata: {
          title: p.title,
        },
      });
      if (typeof p.parentId === 'string' && p.parentId.length > 0) {
        upsertNode(nodes, {
          kind: 'workstream',
          key: p.parentId,
          label: p.parentId,
          observedAt: observedAtIso,
          replicaId,
        });
        upsertEdge(edges, {
          kind: 'workstream_parent_of',
          fromNodeId: nodeIdFor('workstream', p.parentId),
          toNodeId: nodeIdFor('workstream', p.bac_id),
          observedAt: observedAtIso,
          producedBy: {
            source: 'event-log',
            eventType: WORKSTREAM_UPSERTED,
            dot: { replicaId, seq: event.dot.seq },
          },
          confidence: 'asserted',
        });
      }
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
  for (const r of input.reminders) {
    const reminderId = r.bac_id ?? `${r.threadId}@${r.detectedAt ?? ''}`;
    trackObservedAt(r.detectedAt);
    upsertNode(nodes, {
      kind: 'inbound-reminder',
      key: reminderId,
      label: r.threadId,
      ...(r.detectedAt === undefined ? {} : { observedAt: r.detectedAt }),
      metadata: {
        ...(r.provider === undefined ? {} : { provider: r.provider }),
        ...(r.status === undefined ? {} : { status: r.status }),
        threadId: r.threadId,
      },
    });
    upsertNode(nodes, { kind: 'thread', key: r.threadId, label: r.threadId });
    upsertEdge(edges, {
      kind: 'reminder_for_thread',
      fromNodeId: nodeIdFor('inbound-reminder', reminderId),
      toNodeId: nodeIdFor('thread', r.threadId),
      observedAt: r.detectedAt ?? '',
      producedBy: { source: 'reminder-store', recordId: reminderId },
      confidence: 'asserted',
    });
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
          ...(searchQuery === undefined ? {} : { searchQuery }),
          ...(engagementClass === undefined
            ? {}
            : { engagement: { class: engagementClass.class } }),
        },
      });
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
    const tabSessionLabel =
      tabSessionLatestTitle ??
      instance.title ??
      hostFromUrl(tabSessionLatestUrl ?? instance.url) ??
      instance.tabSessionId;
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
      const openerRecord = input.tabSessionProjection.bySessionId.get(
        instance.openerTabSessionId,
      );
      const openerLabel =
        openerRecord?.latestTitle ??
        hostFromUrl(openerRecord?.latestUrl) ??
        instance.openerTabSessionId;
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
      lookupCanonical === undefined
        ? undefined
        : input.urlProjection?.byCanonicalUrl.get(lookupCanonical)?.currentAttribution;
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
      urlAttribution !== undefined && urlAttribution.workstreamId !== null
        ? { ...urlAttribution, origin: 'canonical-url' as const }
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
        ? (node.metadata['canonicalUrl'] as string)
        : undefined) ??
      (typeof node.metadata['url'] === 'string' ? (node.metadata['url'] as string) : undefined);
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
      if (typeof turn.markdown === 'string' && turn.markdown.length > 0) parts.push(turn.markdown);
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

    for (const topic of [...topicRevision.topics].sort((a, b) =>
      a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0,
    )) {
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
          },
        });
        upsertEdge(edges, {
          kind: 'visit_in_topic',
          fromNodeId: nodeIdFor('timeline-visit', memberCanonicalUrl),
          toNodeId: nodeIdFor('topic', topic.topicId),
          observedAt: topic.metadata.lastObservedAt,
          producedBy: topicProducedBy,
          confidence: 'inferred',
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
    const ranker = input.closestVisitRanker;
    const threshold = ranker.threshold ?? 0.3;
    const topK = Math.max(0, Math.floor(ranker.topK ?? 5));
    const baseSnapshot = snapshotFromAccumulators(input.scope, nodes, edges, maxObservedAt);
    const baseNodeById = new Map(baseSnapshot.nodes.map((node) => [node.id, node] as const));
    const visitKeys = [
      ...new Set(
        baseSnapshot.nodes
          .filter((node) => node.kind === 'timeline-visit')
          .map((node) => visitKeyFromNodeOrRaw(node.id))
          .filter((visitKey) => visitKey.length > 0),
      ),
    ].sort();
    const merged = [...input.events];

    const observedAtForVisit = (visitKey: string): string => {
      const node = baseNodeById.get(nodeIdFor('timeline-visit', visitKey));
      return node?.lastSeenAt ?? node?.firstSeenAt ?? visitObservedAtByKey.get(visitKey) ?? '';
    };

    for (const fromVisitKey of visitKeys) {
      if (topK === 0) break;
      const scoredCandidates = generateCandidates(fromVisitKey, {
        merged,
        existingEdges: [...baseSnapshot.edges],
      })
        .map((candidate) => {
          const toVisitKey = visitKeyFromNodeOrRaw(candidate.toVisitId);
          if (!baseNodeById.has(nodeIdFor('timeline-visit', toVisitKey))) return null;
          const features = extractFeatures(candidate, {
            merged,
            snapshot: baseSnapshot,
          });
          const prediction = ranker.predict(features, candidate);
          if (!Number.isFinite(prediction.score) || prediction.score < threshold) {
            return null;
          }
          return {
            candidate,
            toVisitKey,
            score: roundRankerMetric(prediction.score),
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
        trackObservedAt(observedAt);
        upsertEdge(edges, {
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
            score: scored.score,
            featureSchemaVersion: FEATURE_SCHEMA_VERSION,
            topContributions: scored.topContributions,
          },
        });
      }
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
  return snapshotFromAccumulators(input.scope, nodes, edges, maxObservedAt);
};

// ---------------------------------------------------------------------------
// On-disk store: rolling current.json + daily snapshots.
// ---------------------------------------------------------------------------

export interface ConnectionsStore {
  readonly putCurrent: (snapshot: ConnectionsSnapshot) => Promise<void>;
  readonly readCurrent: () => Promise<ConnectionsSnapshot | null>;
  readonly putDay: (date: string, snapshot: ConnectionsSnapshot) => Promise<void>;
  readonly readDay: (date: string) => Promise<ConnectionsSnapshot | null>;
  readonly listDays: () => Promise<readonly string[]>;
}

const SNAPSHOTS_DIR = 'snapshots';

export const createConnectionsStore = (vaultRoot: string): ConnectionsStore => {
  const root = join(vaultRoot, '_BAC', 'connections');
  const snapshotsDir = join(root, SNAPSHOTS_DIR);
  const currentPath = join(root, 'current.json');

  const writeAtomic = async (path: string, body: string): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${createRevision()}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  };

  const dayPath = (date: string): string => join(snapshotsDir, `${date}.json`);

  const putCurrent = async (snapshot: ConnectionsSnapshot): Promise<void> => {
    await writeAtomic(currentPath, JSON.stringify(snapshot, null, 2));
  };
  const readCurrent = async (): Promise<ConnectionsSnapshot | null> => {
    try {
      return JSON.parse(await readFile(currentPath, 'utf8')) as ConnectionsSnapshot;
    } catch {
      return null;
    }
  };

  const putDay = async (date: string, snapshot: ConnectionsSnapshot): Promise<void> => {
    await writeAtomic(dayPath(date), JSON.stringify(snapshot, null, 2));
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

  return { putCurrent, readCurrent, putDay, readDay, listDays };
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
