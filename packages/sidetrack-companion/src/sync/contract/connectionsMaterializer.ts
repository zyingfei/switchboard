import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../../annotations/events.js';
import { buildEngagementClassRevision } from '../../connections/engagementClassifier.js';
import { createIncrementalConnectionsGraphView } from '../../connections/incrementalView.js';
import { readVaultStores } from '../../connections/loader.js';
import {
  attachDriftReport,
  collectMaterializerDiagnostics,
  createMaterializerDiagnosticsStore,
  logMaterializerDiagnostics,
  rankerMethodologySpineDiagnosticsFromTrainQuality,
  type MaterializerDiagnostics,
  type MaterializerDiagnosticsStore,
  type MaterializerPhaseDuration,
  type MaterializerRankerAugmentationCounters,
  type MaterializerRankerMethodologySpineDiagnostics,
  type MaterializerRankerModelFreshness,
} from '../../connections/materializerDiagnostics.js';
import {
  augmentConnectionsSnapshotWithClosestVisitRanker,
  augmentConnectionsSnapshotWithClosestVisitRankerFrontier,
  buildConnectionsSnapshot,
  expandRankerFrontier,
  type ClosestVisitRanker,
  type ConnectionsInput,
  type ConnectionsSnapshot,
  type ThreadVaultRecord,
} from '../../connections/snapshot.js';
import type {
  ConnectionsProjectionAccumulatorState,
  ConnectionsStore,
} from '../../connections/snapshot.js';
import {
  recomputeScope,
  unionScopeOutputs,
  type ScopeRecomputeOutput,
} from '../../connections/scopeRecompute.js';
import { extractUrlsFromText } from '../../connections/urlExtractor.js';
import {
  buildTopicRevision,
  type BuildTopicRevisionInput,
  type TopicVisit,
} from '../../connections/topicClusterer.js';
import {
  deriveUserAssertedRelations,
  knownCanonicalUrlsFor,
} from '../../connections/userAssertedRelations.js';
import {
  buildReusedShadowDiagnostics,
  buildTopicShadowCandidate,
  expectedShadowRevisionId,
  shouldBuildTopicShadowCandidate,
  type TopicShadowDiagnostics,
} from '../../connections/topicShadowCandidate.js';
import {
  buildTopicShadowObservationDiagnostics,
  type TopicShadowObservationDiagnostics,
} from '../../connections/topicShadowObservation.js';
import { buildHdbscanTopicRevision } from '../../connections/hdbscanClusterer.js';
import {
  buildLeidenCpmTopicRevision,
  LEIDEN_CPM_COSINE_THRESHOLD,
} from '../../connections/leidenCpmTopicRevision.js';
import { assignIncrementalMembership } from '../../connections/incrementalTopicMembership.js';
import {
  buildServedTopicProducerReport,
  resolveServedTopicProducer,
  type ServedTopicProducer,
} from '../../connections/servedTopicProducer.js';
import { hotTopicsModeEnabled, type HotPathDiagnostics } from '../../connections/hotPathMode.js';
import {
  buildVisitSimilarity,
  computeVisitSimilarityRevisionId,
  resolveVisitSimilarityConfig,
  type EffectiveVisitSimilarityConfig,
  type VisitSimilarityEmbedder,
} from '../../connections/visitSimilarity.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../../dispatches/events.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
} from '../../feedback/events.js';
import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
} from '../../engagement/events.js';
import {
  createEngagementFactsStore,
  type EngagementFactsStore,
} from '../../engagement/engagementFactsStore.js';
import { isNavigationCommittedPayload, NAVIGATION_COMMITTED } from '../../navigation/events.js';
import { requestBunMemoryRelease } from '../../process/bunMemory.js';
import {
  buildEngagementClassifierInputs,
  createEngagementClassRevisionStore,
  type EngagementClassRevisionStore,
} from '../../producers/engagement-class-revision.js';
import {
  expectedClosestVisitRankerSchema,
  readActiveClosestVisitRankerRevisionManifest,
  readActiveClosestVisitRankerRevisionManifestProbe,
  readClosestVisitRankerRevision,
} from '../../producers/closest-visit-revision.js';
import {
  DEFAULT_TOPIC_COSINE_THRESHOLD,
  TOPIC_HDBSCAN_REVISION_KEY,
  TOPIC_LEIDEN_CPM_REVISION_KEY,
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionId,
  createTopicRevisionStore,
  resolveTopicCosineThreshold,
  type TopicAlgorithmVersion,
  type TopicRevision,
  type TopicRevisionStore,
} from '../../producers/topic-revision.js';
import { loadRankerModel, predictRanker, type LightGBMModel } from '../../ranker/predict.js';
import {
  maybeRetrainClosestVisitRanker,
  type RankerRetrainer,
  type RankerRetrainResult,
} from '../../ranker/retrain.js';
import {
  readVisitSimilarityRevision,
  writeVisitSimilarityRevision,
} from '../../producers/visit-resembles-revision.js';
import { QUEUE_CREATED, QUEUE_STATUS_SET } from '../../queue/events.js';
import {
  dedupeInvalidationKeys,
  invalidationsForEvent,
  type InvalidationKey,
} from './invalidation.js';
import { dedupeScopeList, invalidationKeysToScopes, type Scope } from './connectionsScopes.js';
import { runReconcileInWorker } from './connectionsReconcileWorker.js';
import { runReconcileInChild } from './connectionsReconcileChildClient.js';
import {
  createEmbedderWarmthTracker,
  decideHotPathEmbed,
  type EmbedderWarmthTracker,
} from '../../connections/visitSimilarity.budget.js';
import {
  buildTopicRevisionFromAccumulator,
  IncrementalTopicClusterAccumulator,
} from '../../connections/topicClusterer.js';
import {
  IncrementalVisitSimilarityIndex,
  type IncrementalVisitSimilarityIndexOptions,
} from '../../connections/visitSimilarity.incremental.js';
import {
  buildVisitSimilarityIncremental,
  corpusForVisitEntry,
  visitKeyForVisitEntry,
  VISIT_SIMILARITY_DEFAULT_THRESHOLD,
  VISIT_SIMILARITY_DEFAULT_TOP_K,
  VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
  VISIT_SIMILARITY_MODEL_ID,
} from '../../connections/visitSimilarity.js';
import {
  createSimilarityHnswStore,
  type LoadedSimilarityHnswStore,
} from '../../connections/visitSimilarityHnsw.js';
import {
  createDirtySourceQueue,
  foldGroupBEventIntoQueue,
  type DirtySourceQueueSnapshot,
} from '../../recall/content-lane.js';
import {
  CAPTURE_RECORDED,
  isCaptureRecordedPayload,
  RECALL_TOMBSTONE_TARGET,
} from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { embed as defaultEmbed } from '../../recall/embedder.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import {
  canonicalizeEvidenceUrl,
  ensurePageEvidenceForTimelineEntries,
  readPageEvidenceMap,
  readPageEvidenceVectorMap,
} from '../../page-evidence/store.js';
import type { PageEvidenceRecord } from '../../page-evidence/types.js';
import { PAGE_EVIDENCE_EXTRACTED } from '../../page-evidence/events.js';
import { readPageContentChunksForCanonicalUrls } from '../../page-content/store.js';
import { SELECTION_COPIED, SELECTION_PASTED } from '../../snippets/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
  isThreadStatusPayload,
  isThreadUpsertedPayload,
} from '../../threads/events.js';
import { projectThread } from '../../threads/projection.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  type BrowserTimelineObservedPayload,
  isBrowserTimelineObservedPayload,
} from '../../timeline/events.js';
import { type TimelineStore } from '../../timeline/projection.js';
import {
  createTimelineFactsStore,
  type TimelineFactsStore,
} from '../../timeline/timelineFactsStore.js';
import {
  timelineDaysFromTimelineEvents,
  type TimelineDayProjectionWithDimensions,
  type TimelineEntryWithDimensions,
} from '../../timeline/timelineDays.js';
import { detectSearchUrl } from '../../timeline/sanitize.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { isMainThread } from 'node:worker_threads';
import {
  sortAcceptedEvents,
  vectorFromEvents,
  type AcceptedEvent,
  type Dot,
  type VersionVector,
} from '../causal.js';
import { eventStoreEnabled, getSharedEventStore, type EventStore } from '../eventStore.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import {
  nodeIdFor,
  type VisitSimilarityEdge,
  type VisitSimilarityRevision,
} from '../../connections/types.js';
import {
  addDotsToIntervals,
  EMPTY_PROGRESS,
  frontierFromIntervals,
  intervalsContainDot,
  type MaterializerProgress,
} from './materializerProgress.js';
import {
  createEmptyTabSessionProjectionAccumulator,
  deserializeTabSessionProjectionAccumulator,
  foldEventIntoTabSessionProjectionAccumulator,
  seedTabSessionProjectionAccumulatorAsync,
  serializeTabSessionProjectionAccumulator,
  serializeTabSessionProjection,
  tabSessionProjectionFromAccumulator,
  type TabSessionProjectionAccumulator,
} from '../../tabsession/projection.js';
import {
  applyThreadAttributionsToAccumulator,
  createEmptyUrlProjectionAccumulator,
  deserializeUrlProjectionAccumulator,
  foldEventIntoUrlProjectionAccumulator,
  seedUrlProjectionAccumulatorAsync,
  serializeUrlProjectionAccumulator,
  serializeUrlProjection,
  urlProjectionFromAccumulator,
  type UrlProjectionAccumulator,
} from '../../urls/projection.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../../tabsession/events.js';
import { URL_ATTRIBUTION_INFERRED, URL_IGNORED } from '../../urls/events.js';

// Sync Contract v1 / Class B — Connections graph materializer.
//
// Consumer-only materializer: it doesn't OWN any registry surface
// row (same shape as `recall`). It subscribes to every event type
// that produces a node or edge in the connections graph, plus a
// vault-record sweep at snapshot time for fields the event payloads
// don't carry.
//
// Trigger model:
//   - onAccepted marks the snapshot dirty + sets pending. A single
//     in-flight drainer rebuilds the entire current snapshot from
//     the merged log + vault stores. Bursts coalesce naturally.
//   - catchUp is the same drain; bypasses the failure cooldown so
//     startup / reconnect always retry.
//   - drain failure → cooldown gates onAccepted-driven retries to
//     prevent tight loops; catchUp always bypasses.

const FAILURE_COOLDOWN_MS = 5_000;
const MATERIALIZER_NAME = 'connections';
export const MATERIALIZER_VERSION = 'connections@2026-05-22-classB-phase2-local-scopes';
const BACKLOG_FALLBACK_THRESHOLD = 5_000;

// Permanent-gap sealing (default OFF). A "permanent gap" is a per-replica
// event seq the log/store skip forever (a rejected/never-emitted seq). It
// freezes frontierFromIntervals just below it, so readSince re-returns the
// whole post-gap window every drain → perpetual catch-up → the event-store
// stops ingesting → topics freeze. The seal pass advances the frontier PAST
// such a gap, but ONLY after proving the seq is absent from BOTH the log and
// the store AND aging it across consecutive drains (so a not-yet-arrived
// out-of-order dot is never skipped). Gated behind an env flag for safe
// rollout / instant rollback.
const GAP_SEAL_ENABLED = (): boolean => process.env['SIDETRACK_CONNECTIONS_GAP_SEAL'] === '1';
// Source the topic build from the FULL timeline + FULL engagement (default OFF).
// Without it, an incremental/settled drain clusters only the per-drain window
// (and older visits lack engagement -> eligibleVisits filters them), so a topic
// recompute shrinks or wipes. When on, a recompute re-derives the visit set from
// the full event log, so topics re-cluster correctly over the whole graph.
const topicFullTimelineSourceEnabled = (): boolean =>
  process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE'] === '1';
// A gap seq must be PROVEN absent (store streamed past it, absent from the
// log, never applied) for this many CONSECUTIVE drains before it is sealed.
// Reset to 0 the instant the seq reappears (out-of-order CRDT arrival).
const GAP_SEAL_MIN_AGING_DRAINS = ((): number => {
  const n = Number.parseInt(process.env['SIDETRACK_GAP_SEAL_MIN_AGING_DRAINS'] ?? '8', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
})();
// Hard cap on gap seqs probed per drain so a pathological interval set can
// never turn the seal pass into an O(gaps) scan storm.
const GAP_SEAL_MAX_CANDIDATES_PER_DRAIN = 256;
// Drift-check (shadow in-process rebuild) removed — it was costing 30s+
// per cycle and a multi-GB memory spike on the parent process, defeating
// IVM. Statistical drift via `attachDriftReport` (uses already-computed
// diagnostic series, no rebuild) is kept.
const PROJECTION_OVERLAY_RETRY_DELAYS_MS = [25, 75, 150, 300, 600, 1_200] as const;

export interface DriftReport {
  readonly checkedAt: string;
  readonly materializerVersion: string;
  readonly appliedFrontier: Record<string, number>;
  readonly missingDots: readonly Dot[];
  readonly extraDots: readonly Dot[];
  readonly nodeDiff: { readonly added: number; readonly removed: number; readonly changed: number };
  readonly edgeDiff: { readonly added: number; readonly removed: number; readonly changed: number };
  readonly conclusion: 'clean' | 'drift';
}

// Stage 5.2 W1a — debounce window between event accept and drain trigger.
// Coalesces burst arrivals (multi-tab navigation, peer-event imports) into
// a single drain instead of one rebuild per event. Sustained event streams
// at a lower frequency than this window still produce per-event drains;
// the worker_thread move (W1b) is the structural fix for those.
// Drain debounce. Bumped from 250 ms → 1500 ms to coalesce bursts of
// incoming events on a real prod vault. Each buildAndWrite is ~600 ms
// of main-thread sync CPU (buildConnectionsSnapshot dominates); with
// 250 ms debounce a 10-event burst produces 10 drains and 6 s of
// pinned main thread. 1500 ms collapses the same burst into one
// drain. Side-panel views poll their own state and don't observe a
// per-edit reactivity gap below ~2 s, so this is invisible UX-wise.
const DRAIN_DEBOUNCE_MS = 1500;
const URGENT_DRAIN_DEBOUNCE_MS = 250;

// Stage 5.2 W1b/W1c — minimum wall-clock interval between drain
// STARTS. DRAIN_DEBOUNCE_MS only coalesces a burst into ONE start;
// it does NOT bound the cadence of successive starts. Measured:
// buildConnectionsSnapshot ≈4-5s/pass, and with a steady
// extension-flush trigger stream each post-debounce start fired
// every ~DRAIN_DEBOUNCE_MS → a ~5s rebuild every ~6.5s ≈ a pinned
// core (the dogfood runaway). This floor governs BOTH the in-flight
// `while (dirty)` continuation (W1b) AND the gap between separate
// debounced starts (W1c, see startDrainWhenIntervalElapsed): a drain
// starts at most once per interval; intervening triggers coalesce
// into the next one (dirty stays set — no starvation; awaitIdle
// stays correct: dirty&&!error keeps it waiting through the defer).
// Connections is contextual ("not user-immediate-feedback" per the
// W2b note), so an interval of staleness is acceptable. Default
// raised 15s→30s so the default is sane WITHOUT the dogfood
// suppression env. Env-overridable (`SIDETRACK_CONNECTIONS_DRAIN_MIN_INTERVAL_MS`,
// set 0 to disable); resolved per call (not a frozen module const)
// so a test can set the env before constructing the materializer.
const DEFAULT_DRAIN_MIN_INTERVAL_MS = 30_000;
const resolveDrainMinIntervalMs = (): number => {
  const raw = process.env['SIDETRACK_CONNECTIONS_DRAIN_MIN_INTERVAL_MS'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DRAIN_MIN_INTERVAL_MS;
};

const TOPIC_EVERY_DRAINS_ENV = 'SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS';
const TOPIC_EVERY_MS_ENV = 'SIDETRACK_CONNECTIONS_TOPIC_EVERY_MS';
const DEFAULT_TOPIC_EVERY_DRAINS = 50;
const DEFAULT_TOPIC_EVERY_MS = 300_000;
const BUSY_LAST_SUCCESS_WINDOW_MS = 60_000;

const markPostDrain = (label: string, previousAtMs: number): number => {
  const now = Date.now();
  console.warn(`[connections-phase] post-drain.${label} dt=${String(now - previousAtMs)}ms`);
  return now;
};

const delayMs = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const isSqliteLockError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return String(error).includes('database is locked');
  }
  const code = 'code' in error ? error.code : undefined;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('database is locked') ||
    message.includes('SQLITE_BUSY') ||
    message.includes('SQLITE_LOCKED')
  );
};

export const classifyConnectionsMaterializerHealth = (input: {
  readonly pending: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly nowMs?: number;
}): MaterializerHealth['status'] => {
  if (input.lastError !== null) return 'failed';
  if (!input.pending) return input.lastSuccessAt === null ? 'degraded' : 'healthy';
  if (input.lastSuccessAt === null) return 'degraded';
  const successAtMs = Date.parse(input.lastSuccessAt);
  if (!Number.isFinite(successAtMs)) return 'degraded';
  const ageMs = Math.max(0, (input.nowMs ?? Date.now()) - successAtMs);
  return ageMs <= BUSY_LAST_SUCCESS_WINDOW_MS ? 'busy' : 'degraded';
};

// IVM is the only supported path — the env-opt-out (`=0`) was removed
// to prevent accidental regression back to full-rebuild semantics.
const incrementalRankerEnabled = (): boolean => true;
const incrementalSimilarityEnabled = (): boolean => true;
// Source engagement classifier inputs from the persistent SQLite fact
// store instead of re-walking the full AcceptedEvent[] every drain.
// Kill-switch to the legacy in-memory path (drift/replay) via env=0.
// Default OFF: part of the off-heap-fact-store approach that measured
// net-negative on memory (see eventStore.ts). Byte-equivalent + verified,
// but no memory win + sqlite overhead. Opt-in via env=1 (experimental).
const engagementFactsStoreEnabled = (): boolean =>
  process.env['SIDETRACK_ENGAGEMENT_FACTS_STORE'] === '1';
const timelineFactsStoreEnabled = (): boolean =>
  process.env['SIDETRACK_TIMELINE_FACTS_STORE'] === '1';
// Scoped re-visit no-op fast path (default ON; disable with =0 + restart
// for instant rollback). When a drain window touches scopes that own
// graph rows but carries NO graph-row-affecting event (no
// NAVIGATION_COMMITTED → scopedDeltaEvents empty, no thread event →
// dirtyThreadScopes empty, no new timeline entry → scopedTimelineDays
// empty), the scopes' graph rows are unchanged. Re-assert them from the
// previous snapshot (+ write current projections, advance frontier)
// instead of falling into the ~18s full base rebuild that pegged the
// companion on every re-visit. Same correctness basis as the existing
// metadata-only and content-lane-only scoped branches.
const scopedRevisitNoOpEnabled = (): boolean =>
  process.env['SIDETRACK_SCOPED_REVISIT_NOOP'] !== '0';
// Incremental topic membership (default OFF): between full leiden
// re-clusters, overlay newly-eligible visits onto their nearest existing
// cluster as secondary affiliations so topics stay responsive to browsing
// without an O(N) leiden pass. Instant rollback via env unset + restart.
const incrementalTopicMembershipEnabled = (): boolean =>
  process.env['SIDETRACK_CONNECTIONS_TOPIC_INCREMENTAL_MEMBERSHIP'] === '1';
const resolvePositiveIntegerEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const resolveTopicEveryDrains = (): number =>
  resolvePositiveIntegerEnv(TOPIC_EVERY_DRAINS_ENV, DEFAULT_TOPIC_EVERY_DRAINS);

const resolveTopicEveryMs = (): number =>
  resolvePositiveIntegerEnv(TOPIC_EVERY_MS_ENV, DEFAULT_TOPIC_EVERY_MS);

// Hardcoded event types this materializer reacts to. Connections
// has no registry surface, so we can't derive handles from
// eventTypesForMaterializer('connections') — and we don't want to,
// since the materializer is a CONSUMER across many event-type
// owners. The list mirrors the union of event types that affect
// connection nodes or edges; any new event type that adds to the
// graph (e.g. a future capture-note event) gets added here.
//
// Stage 5.2 W2b — high-frequency events that fold into the next
// natural drain are intentionally OMITTED from HANDLES so they do not
// each trigger a full O(events) rebuild. Specifically:
//   - `engagement.session.aggregated` fires every ~30s per active
//     tab. The engagement classifier ran inside `buildAndWrite`,
//     reading the merged log from disk every time, which produced
//     the per-event rebuild storm observed during dogfood. The
//     engagement signal is still folded into the next drain (which
//     reads the full log via `readMerged`), so the snapshot's
//     engagement-derived edges remain correct — they just refresh on
//     the next structural event (page nav, user action, etc).
//   - `visual.fingerprint.observed` always pairs with a
//     `browser.timeline.observed` event for the same nav, so its
//     arrival never triggers a structurally-new rebuild — the paired
//     timeline observation does.
//   - `page.evidence.extracted` is emitted per page-evidence
//     auto-capture (page observation / live current-tab / early
//     engagement snapshot — high frequency, multiple per nav and
//     re-emitted on engagement ticks). It is reconstructed from the
//     page-evidence store inside every drain via
//     `ensurePageEvidenceForTimelineEntries`, so leaving it OUT of
//     HANDLES keeps the snapshot's evidence-derived edges correct —
//     they just refresh on the next structural event (the paired
//     `browser.timeline.observed` nav already triggered a drain).
//     Routing it through HANDLES re-created the W2b per-event rebuild
//     storm: a steady auto-capture stream keeps `dirty` set so the
//     `drain()` while-loop rebuilds the full connections snapshot
//     back-to-back with the debounce bypassed (debounce only gates
//     the idle→drain entry, not the in-flight loop), pinning a core.
// If a session never produces a HOT event for an extended period
// (passive read of one page), the engagement classification stays
// stale until the next navigation or mutation. That is acceptable
// for current UX: engagement classification is contextual signal,
// not user-immediate-feedback.
const HANDLES: ReadonlySet<string> = new Set<string>([
  THREAD_UPSERTED,
  THREAD_ARCHIVED,
  THREAD_UNARCHIVED,
  THREAD_DELETED,
  WORKSTREAM_UPSERTED,
  WORKSTREAM_DELETED,
  NAVIGATION_COMMITTED,
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  TAB_SESSION_ATTRIBUTION_INFERRED,
  URL_ATTRIBUTION_INFERRED,
  // Timeline observations indirectly contribute (timeline visits
  // become nodes; same canonicalUrl produces edges to threads).
  // Including the event type here keeps freshness bound to the
  // arrival of the underlying observation, even though the
  // materializer reads the daily projection rather than the
  // event payload directly.
  BROWSER_TIMELINE_OBSERVED,
]);

// Events that *participate* in the connections graph but do NOT need to
// trigger a fresh structural rebuild on their own. Their effects bake
// into the next regular drain (triggered by something in HANDLES), via
// `readMerged()` of the full event log. Putting them here:
//   1. Skips the drain trigger (only progress is advanced — see
//      advanceProgressForContentOnlyEvent).
//   2. Passes `isScopedTimelineDeltaEvent`, so when they arrive mixed
//      with timeline-affecting events the gate doesn't collapse to a
//      full rebuild.
// Membership criteria: the event's invalidationsForEvent contributes
// only content-lane keys (sourceUnit / recallIndex / contentSimilarity)
// or an empty set — i.e., it does not invalidate any *graph* scope.
const CONTENT_LANE_ONLY_HANDLES: ReadonlySet<string> = new Set<string>([
  CAPTURE_EXTRACTION_PRODUCED,
  CAPTURE_RECORDED,
  ENGAGEMENT_INTERVAL_OBSERVED,
  PAGE_EVIDENCE_EXTRACTED,
  RECALL_TOMBSTONE_TARGET,
  // No-graph-impact events. These previously rode in HANDLES which made
  // every one of them trigger a full base rebuild; their invalidation
  // rules emit empty sets, so the drain produced zero dirty scopes and
  // burned ~20s of CPU recomputing nothing.
  ANNOTATION_CREATED,
  ANNOTATION_NOTE_SET,
  ANNOTATION_DELETED,
  DISPATCH_RECORDED,
  DISPATCH_LINKED,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
  // Queue events invalidate `queue` keys only; `queue` is not a
  // recomputable scope kind (see invalidationKeysToScopes in
  // connectionsScopes.ts) so it contributes zero graph rows. Routing
  // through CONTENT_LANE skips the no-op drain trigger.
  QUEUE_CREATED,
  QUEUE_STATUS_SET,
  // Selection events have no entry in INVALIDATION_RULES → empty key
  // set → no graph rows touched.
  SELECTION_COPIED,
  SELECTION_PASTED,
]);

const PROJECTION_ONLY_HANDLES: ReadonlySet<string> = new Set<string>([URL_IGNORED]);

const THREAD_SCOPED_DELTA_HANDLES: ReadonlySet<string> = new Set<string>([
  THREAD_UPSERTED,
  THREAD_ARCHIVED,
  THREAD_UNARCHIVED,
  THREAD_DELETED,
]);

const PROJECTION_OVERLAY_HANDLES: ReadonlySet<string> = new Set<string>([
  BROWSER_TIMELINE_OBSERVED,
  USER_ORGANIZED_ITEM,
  TAB_SESSION_ATTRIBUTION_INFERRED,
  URL_ATTRIBUTION_INFERRED,
  URL_IGNORED,
]);

const summarizeEventTypes = (events: readonly AcceptedEvent[], limit = 8): string => {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  });
  const shown = entries
    .slice(0, limit)
    .map(([type, count]) => `${type}:${String(count)}`)
    .join(',');
  return entries.length > limit ? `${shown},...` : shown;
};

export interface CreateConnectionsMaterializerDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly timelineStore: TimelineStore;
  readonly store: ConnectionsStore;
  readonly embed?: VisitSimilarityEmbedder;
  readonly topicRevisionAlgorithm?: TopicAlgorithmVersion;
  readonly topicRevisionStore?: TopicRevisionStore;
  readonly engagementClassStore?: EngagementClassRevisionStore;
  readonly engagementFactsStore?: EngagementFactsStore;
  readonly timelineFactsStore?: TimelineFactsStore;
  readonly eventStore?: EventStore;
  readonly rankerRetrainer?: RankerRetrainer;
  readonly closestVisitRankerLoader?: ClosestVisitRankerLoader;
  readonly diagnosticsStore?: MaterializerDiagnosticsStore;
  readonly diagnosticsLogger?: (diagnostics: MaterializerDiagnostics) => void;
  readonly diagnosticsNow?: () => Date;
}

type TopicRevisionBuilder = (input: BuildTopicRevisionInput) => Promise<TopicRevision>;

type ClosestVisitRankerLoadResult =
  | {
      readonly status: 'ready';
      readonly activeRevisionId: string;
      readonly ranker: ClosestVisitRanker;
      readonly model: LightGBMModel;
      readonly activeModelVersion?: string | null;
      readonly expectedModelVersion?: string;
      readonly activeFeatureSchemaVersion?: number | null;
      readonly expectedFeatureSchemaVersion?: number;
      readonly needsRetrain?: boolean;
      readonly methodologySpine?: MaterializerRankerMethodologySpineDiagnostics | null;
    }
  | {
      readonly status: 'missing';
      readonly activeRevisionId: null;
      readonly reason: 'no-active-manifest';
      readonly activeModelVersion?: string | null;
      readonly expectedModelVersion?: string;
      readonly activeFeatureSchemaVersion?: number | null;
      readonly expectedFeatureSchemaVersion?: number;
      readonly needsRetrain?: boolean;
      readonly methodologySpine?: MaterializerRankerMethodologySpineDiagnostics | null;
    }
  | {
      readonly status: 'invalid';
      readonly activeRevisionId: string | null;
      readonly reason:
        | 'stale-model-schema'
        | 'invalid-active-manifest'
        | 'missing-revision'
        | 'load-failed';
      readonly error: string | null;
      readonly activeModelVersion?: string | null;
      readonly expectedModelVersion?: string;
      readonly activeFeatureSchemaVersion?: number | null;
      readonly expectedFeatureSchemaVersion?: number;
      readonly needsRetrain?: boolean;
      readonly methodologySpine?: MaterializerRankerMethodologySpineDiagnostics | null;
    };

type ClosestVisitRankerLoader = () => Promise<ClosestVisitRankerLoadResult>;

const topicRevisionBuilderFor = (algorithm: TopicAlgorithmVersion): TopicRevisionBuilder => {
  switch (algorithm) {
    case TOPIC_UNION_FIND_REVISION_KEY:
      return buildTopicRevision;
    case TOPIC_HDBSCAN_REVISION_KEY:
      return buildHdbscanTopicRevision;
    case TOPIC_LEIDEN_CPM_REVISION_KEY:
      return buildLeidenCpmTopicRevision;
    case TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY:
      return buildTopicRevision;
  }
};

const normalizeVisitUrl = (url: string): string => url.replace(/#.*$/u, '').replace(/\/+$/u, '');

export const collectTouchedVisits = (
  dirtyScopes: readonly Scope[],
  pendingEvents: readonly AcceptedEvent[],
): ReadonlySet<string> => {
  const touched = new Set<string>();
  for (const scope of dirtyScopes) {
    if (scope.kind === 'url' || scope.kind === 'visit') touched.add(scope.id);
  }
  for (const event of pendingEvents) {
    if (
      event.type !== BROWSER_TIMELINE_OBSERVED ||
      !isBrowserTimelineObservedPayload(event.payload)
    ) {
      continue;
    }
    touched.add(normalizeVisitUrl(event.payload.canonicalUrl ?? event.payload.url));
  }
  return new Set([...touched].filter((visitKey) => visitKey.length > 0).sort());
};

const hnswStoreRemovalDriftRequiresFullRebuild = (
  storeVisitCount: number,
  eligibleVisitCount: number,
): boolean => {
  if (storeVisitCount <= eligibleVisitCount) return false;
  const drift = storeVisitCount - eligibleVisitCount;
  const denominator = Math.max(storeVisitCount, eligibleVisitCount, 1);
  return drift / denominator > 0.5;
};

const isHnswDimensionMismatchError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('HNSW dimension mismatch');
};

const writeShadowTopicRevision = async (
  vaultRoot: string,
  revision: TopicRevision,
): Promise<void> => {
  const root = join(vaultRoot, '_BAC', 'connections', 'topics');
  await mkdir(root, { recursive: true });
  const body = `${JSON.stringify(revision, null, 2)}\n`;
  const revisionPath = join(root, `${revision.revisionId}.json`);
  const shadowPath = join(root, 'current.shadow.json');
  const tmpRevisionPath = `${revisionPath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  const tmpShadowPath = `${shadowPath}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmpRevisionPath, body, 'utf8');
  await rename(tmpRevisionPath, revisionPath);
  await writeFile(tmpShadowPath, body, 'utf8');
  await rename(tmpShadowPath, shadowPath);
};

export interface ConnectionsMaterializer extends Materializer {
  /**
   * Stage 5.2 W7 — snapshot of source units that need re-chunking /
   * re-embedding / recall-index replace. Read-only view; reconciler
   * workers call `clearDirtySources(ids)` after successfully processing
   * each entry. Returns deterministically sorted arrays so consumers
   * can diff snapshots without normalising.
   */
  readonly getDirtySources: () => DirtySourceQueueSnapshot;
  /**
   * Stage 5.2 W7 — mark specific source units as reconciled. Called
   * by the (future) content-lane reconciler worker after it has
   * successfully replaced the source unit's chunks in the recall
   * index. Latest extraction revisionIds are retained across clears
   * (see the queue's `clear()` contract).
   */
  readonly clearDirtySources: (sourceUnitIds: readonly string[]) => void;
  /**
   * Stage 5.2 W6 — the dedupe'd InvalidationKey set consumed by the
   * most recent buildAndWrite entry. Updated atomically at the start
   * of each drain. Empty between drains (the accumulator clears
   * itself once drained). Useful for telemetry / per-pass skip
   * decisions in follow-up work.
   */
  readonly getInvalidationsSinceLastBuild: () => readonly InvalidationKey[];
  /**
   * Stage 5.2 W4 — the incremental topic accumulator. Shadow state
   * maintained alongside the legacy buildSelectedTopicRevision builder.
   * Consumers can read components without forcing a full topic
   * revision build. removeEdge is exposed for similarity-revision-flip
   * driven removals (called by the future content-lane reconciler).
   */
  readonly getTopicAccumulator: () => IncrementalTopicClusterAccumulator;
  /**
   * Stage 5.2 W3 — the embedder warmth tracker that records every
   * buildVisitSimilarity pass. Future hot-path consumers consult its
   * snapshot via `decideHotPathEmbed(tracker.snapshot(corpusSize))`.
   */
  readonly getEmbedderWarmthTracker: () => EmbedderWarmthTracker;
  /**
   * Stage 5.2 W7 — drain the dirty-source queue through the supplied
   * reconciler. Returns the number of source units processed.
   * Callers responsible for cadence (debounce) and concurrency
   * (single drain at a time). The reconciler is responsible for
   * chunking / embedding / recall-index updates; this method just
   * orchestrates and acks via clearDirtySources.
   */
  readonly drainContentLaneQueue: (reconciler: ContentLaneSourceUnitReconciler) => Promise<number>;
}

export interface ContentLaneSourceUnitReconciler {
  readonly reconcileSourceUnit: (sourceUnitId: string) => Promise<boolean>;
  readonly reconcileTombstone: (sourceUnitId: string) => Promise<boolean>;
}

const dotsFromIntervals = (
  intervals: MaterializerProgress['appliedDotIntervals'],
): readonly Dot[] => {
  const dots: Dot[] = [];
  for (const [replicaId, replicaIntervals] of Object.entries(intervals)) {
    for (const [startSeq, endSeq] of replicaIntervals) {
      for (let seq = startSeq; seq <= endSeq; seq += 1) dots.push({ replicaId, seq });
    }
  }
  return dots.sort((a, b) =>
    a.replicaId === b.replicaId ? a.seq - b.seq : a.replicaId < b.replicaId ? -1 : 1,
  );
};

const dotIntervalsHaveGaps = (intervals: MaterializerProgress['appliedDotIntervals']): boolean => {
  for (const replicaIntervals of Object.values(intervals)) {
    if (replicaIntervals.length > 1) return true;
    const [first] = replicaIntervals;
    if (first !== undefined && first[0] > 1) return true;
  }
  return false;
};

// --- Permanent-gap sealing helpers (see GAP_SEAL_* constants) ---

// Enumerate seqs that sit in a hole STRICTLY BELOW the store watermark for a
// replica. Only seqs the store has streamed PAST (watermark moved above them)
// yet never ingested are skip candidates; seqs at/above the watermark are
// simply not-yet-arrived and are never enumerated (the core data-loss guard).
export const enumerateGapCandidates = (
  intervals: MaterializerProgress['appliedDotIntervals'],
  watermark: VersionVector,
  cap: number,
): readonly Dot[] => {
  const out: Dot[] = [];
  for (const [replicaId, replicaIntervals] of Object.entries(intervals)) {
    const wm = watermark[replicaId] ?? 0;
    const first = replicaIntervals[0];
    if (first !== undefined && first[0] > 1) {
      for (let g = 1; g < first[0] && g < wm; g++) {
        out.push({ replicaId, seq: g });
        if (out.length >= cap) return out;
      }
    }
    for (let i = 0; i + 1 < replicaIntervals.length; i++) {
      const current = replicaIntervals[i];
      const next = replicaIntervals[i + 1];
      if (current === undefined || next === undefined) continue;
      const end = current[1];
      const nextStart = next[0];
      for (let g = end + 1; g < nextStart && g < wm; g++) {
        out.push({ replicaId, seq: g });
        if (out.length >= cap) return out;
      }
    }
  }
  return out;
};

// key = `${replicaId}#${seq}` → consecutive-absent drain count.
type GapAging = Record<string, number>;
const gapAgingKey = (dot: Dot): string => `${dot.replicaId}#${String(dot.seq)}`;
const gapAgingPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'current.gap-aging.json');
const readGapAging = async (vaultRoot: string): Promise<GapAging> => {
  try {
    return JSON.parse(await readFile(gapAgingPath(vaultRoot), 'utf8')) as GapAging;
  } catch {
    return {};
  }
};
// The aging counter lives in its OWN sibling file — NOT on MaterializerProgress,
// whose drain snapshot copies only its typed fields (any extra field would be
// wiped every drain). Atomic tmp+rename; removed when empty so it never leaks.
const writeGapAging = async (vaultRoot: string, aging: GapAging): Promise<void> => {
  const path = gapAgingPath(vaultRoot);
  if (Object.keys(aging).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(aging), 'utf8');
  await rename(tmp, path);
};

// Returns the dots to SEAL this drain (proven absent AND aged past threshold)
// and the next aging map to persist. proveAbsent(dot) MUST hold for store+log.
// Any candidate whose absence cannot be re-proven this drain is dropped from
// the map (counter reset to 0), so a single reappearance restarts the aging.
export const computeGapSeals = (
  candidates: readonly Dot[],
  prior: GapAging,
  proveAbsent: (dot: Dot) => boolean,
  minAging: number,
): { seals: readonly Dot[]; nextAging: GapAging } => {
  const seals: Dot[] = [];
  const nextAging: GapAging = {};
  for (const dot of candidates) {
    if (!proveAbsent(dot)) continue; // reappeared / unprovable → reset to 0
    const count = (prior[gapAgingKey(dot)] ?? 0) + 1;
    if (count >= minAging) seals.push(dot); // sealed → drop from aging map
    else nextAging[gapAgingKey(dot)] = count;
  }
  return { seals, nextAging };
};

// Shared seal pass used by BOTH the store-backed and legacy eventLog drain
// paths. Returns the (possibly gap-sealed) intervals to use for this drain's
// frontier. `watermark` is the per-replica max seq the source has streamed
// past (store watermark, or the log's max seq for the legacy path), and
// `logEvents` is the canonical log used to prove a candidate seq absent. No-op
// (returns the input intervals unchanged) when there are no proven, aged gaps —
// so on a healthy vault this is a cheap set build over the log read the caller
// already performs. Callers gate on GAP_SEAL_ENABLED() + dotIntervalsHaveGaps.
const computeSealedIntervals = async (
  vaultRoot: string,
  appliedIntervals: MaterializerProgress['appliedDotIntervals'],
  watermark: VersionVector,
  logEvents: readonly AcceptedEvent[],
  mark: (message: string) => void,
): Promise<MaterializerProgress['appliedDotIntervals']> => {
  const candidates = enumerateGapCandidates(
    appliedIntervals,
    watermark,
    GAP_SEAL_MAX_CANDIDATES_PER_DRAIN,
  );
  if (candidates.length === 0) return appliedIntervals;
  const logPresent = new Set<string>();
  for (const event of logEvents) logPresent.add(gapAgingKey(event.dot));
  const proveAbsent = (dot: Dot): boolean =>
    (watermark[dot.replicaId] ?? 0) > dot.seq && // source streamed past it
    !logPresent.has(gapAgingKey(dot)) && // absent from the canonical log
    !intervalsContainDot(appliedIntervals, dot); // never applied
  const priorAging = await readGapAging(vaultRoot);
  const { seals, nextAging } = computeGapSeals(
    candidates,
    priorAging,
    proveAbsent,
    GAP_SEAL_MIN_AGING_DRAINS,
  );
  await writeGapAging(vaultRoot, nextAging);
  if (seals.length === 0) return appliedIntervals;
  mark(`gap-seal sealed=${String(seals.length)} aging=${String(Object.keys(nextAging).length)}`);
  return addDotsToIntervals(appliedIntervals, seals);
};

const versionVectorsEqual = (left: VersionVector, right: VersionVector): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? 0) !== (right[key] ?? 0)) return false;
  }
  return true;
};

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareAcceptedEventOrder = (left: AcceptedEvent, right: AcceptedEvent): number => {
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  const replica = compareString(left.dot.replicaId, right.dot.replicaId);
  if (replica !== 0) return replica;
  if (left.dot.seq !== right.dot.seq) return left.dot.seq - right.dot.seq;
  return compareString(left.type, right.type);
};

const dotIntervalsEqual = (
  left: MaterializerProgress['appliedDotIntervals'],
  right: MaterializerProgress['appliedDotIntervals'],
): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const leftIntervals = left[key] ?? [];
    const rightIntervals = right[key] ?? [];
    if (leftIntervals.length !== rightIntervals.length) return false;
    for (let index = 0; index < leftIntervals.length; index += 1) {
      const leftInterval = leftIntervals[index];
      const rightInterval = rightIntervals[index];
      if (
        leftInterval === undefined ||
        rightInterval === undefined ||
        leftInterval[0] !== rightInterval[0] ||
        leftInterval[1] !== rightInterval[1]
      ) {
        return false;
      }
    }
  }
  return true;
};

const dotKey = (dot: Dot): string => `${dot.replicaId}\u0000${String(dot.seq)}`;

const diffByStableJson = <T extends { readonly id: string }>(
  live: readonly T[],
  shadow: readonly T[],
): { readonly added: number; readonly removed: number; readonly changed: number } => {
  const liveById = new Map(live.map((item) => [item.id, JSON.stringify(item)] as const));
  const shadowById = new Map(shadow.map((item) => [item.id, JSON.stringify(item)] as const));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, body] of shadowById) {
    const liveBody = liveById.get(id);
    if (liveBody === undefined) added += 1;
    else if (liveBody !== body) changed += 1;
  }
  for (const id of liveById.keys()) {
    if (!shadowById.has(id)) removed += 1;
  }
  return { added, removed, changed };
};

export const compareConnectionsDrift = (input: {
  readonly checkedAt: string;
  readonly materializerVersion: string;
  readonly liveSnapshot: ConnectionsSnapshot;
  readonly shadowSnapshot: ConnectionsSnapshot;
  readonly liveProgress: MaterializerProgress;
  readonly shadowEvents: readonly AcceptedEvent[];
}): DriftReport => {
  const shadowDots = input.shadowEvents.map((event) => event.dot);
  const shadowDotKeys = new Set(shadowDots.map(dotKey));
  const liveDots = dotsFromIntervals(input.liveProgress.appliedDotIntervals);
  const liveDotKeys = new Set(liveDots.map(dotKey));
  const missingDots = shadowDots.filter((dot) => !liveDotKeys.has(dotKey(dot)));
  const extraDots = liveDots.filter((dot) => !shadowDotKeys.has(dotKey(dot)));
  const nodeDiff = diffByStableJson(input.liveSnapshot.nodes, input.shadowSnapshot.nodes);
  const edgeDiff = diffByStableJson(input.liveSnapshot.edges, input.shadowSnapshot.edges);
  const conclusion =
    missingDots.length === 0 &&
    extraDots.length === 0 &&
    nodeDiff.added === 0 &&
    nodeDiff.removed === 0 &&
    nodeDiff.changed === 0 &&
    edgeDiff.added === 0 &&
    edgeDiff.removed === 0 &&
    edgeDiff.changed === 0
      ? 'clean'
      : 'drift';
  return {
    checkedAt: input.checkedAt,
    materializerVersion: input.materializerVersion,
    appliedFrontier: frontierFromIntervals(input.liveProgress.appliedDotIntervals),
    missingDots,
    extraDots,
    nodeDiff,
    edgeDiff,
    conclusion,
  };
};

export const createConnectionsMaterializer = (
  deps: CreateConnectionsMaterializerDeps,
): ConnectionsMaterializer => {
  const topicRevisionStore = deps.topicRevisionStore ?? createTopicRevisionStore(deps.vaultRoot);
  const topicRevisionAlgorithm = deps.topicRevisionAlgorithm ?? TOPIC_UNION_FIND_REVISION_KEY;
  const buildSelectedTopicRevision = topicRevisionBuilderFor(topicRevisionAlgorithm);
  const engagementClassStore =
    deps.engagementClassStore ?? createEngagementClassRevisionStore(deps.vaultRoot);
  const rankerRetrainer =
    deps.rankerRetrainer ??
    ((context) => maybeRetrainClosestVisitRanker({ vaultRoot: deps.vaultRoot, ...context }));
  // PR #141 — materializer diagnostics store. Captures per-drain
  // counters for the diagnostics route.
  const diagnosticsStore =
    deps.diagnosticsStore ?? createMaterializerDiagnosticsStore(deps.vaultRoot);
  const diagnosticsLogger = deps.diagnosticsLogger ?? logMaterializerDiagnostics;
  const diagnosticsNow = deps.diagnosticsNow ?? ((): Date => new Date());
  // Stage 5.2 W7 — in-memory dirty-source queue. Group B events
  // (capture.recorded, capture.extraction.produced, recall.tombstone.target)
  // fold into this queue on every accepted event; the content-lane
  // reconciler drains the queue off the hot path via
  // drainContentLaneQueue.
  const dirtySourceQueue = createDirtySourceQueue();
  // Stage 5.2 W6 — per-drain invalidation accumulator. Each accepted
  // event contributes invalidationsForEvent(event) (often []) and the
  // set is dedupe'd at drain entry.
  let accumulatedInvalidations: InvalidationKey[] = [];
  let lastBuildInvalidations: readonly InvalidationKey[] = [];
  // Stage 5.2 W2b/c wiring — projection accumulators. State carried
  // across drains so per-drain cost is O(events-since-last-drain)
  // instead of O(merged-log).
  let urlAccumulator: UrlProjectionAccumulator = createEmptyUrlProjectionAccumulator();
  let tabSessionAccumulator: TabSessionProjectionAccumulator =
    createEmptyTabSessionProjectionAccumulator();
  let projectionAccumulatorsInitialized = false;
  const serializeProjectionAccumulatorState = (
    progress: MaterializerProgress,
  ): ConnectionsProjectionAccumulatorState => ({
    materializerName: MATERIALIZER_NAME,
    materializerVersion: MATERIALIZER_VERSION,
    appliedDotIntervals: progress.appliedDotIntervals,
    appliedFrontier: progress.appliedFrontier,
    urlAccumulator: serializeUrlProjectionAccumulator(urlAccumulator),
    tabSessionAccumulator: serializeTabSessionProjectionAccumulator(tabSessionAccumulator),
  });
  const tryLoadProjectionAccumulatorState = async (
    progress: MaterializerProgress | null,
  ): Promise<boolean> => {
    if (progress === null || progress.materializerVersion !== MATERIALIZER_VERSION) return false;
    const readState = deps.store.readProjectionAccumulatorState;
    if (readState === undefined) return false;
    const state = await readState(MATERIALIZER_NAME);
    if (state === null) return false;
    if (state.materializerVersion !== MATERIALIZER_VERSION) return false;
    if (!versionVectorsEqual(state.appliedFrontier, progress.appliedFrontier)) return false;
    if (!dotIntervalsEqual(state.appliedDotIntervals, progress.appliedDotIntervals)) return false;
    urlAccumulator = deserializeUrlProjectionAccumulator(state.urlAccumulator);
    tabSessionAccumulator = deserializeTabSessionProjectionAccumulator(state.tabSessionAccumulator);
    projectionAccumulatorsInitialized = true;
    return true;
  };
  const incrementalGraphView = createIncrementalConnectionsGraphView();
  // Stage 5.2 W6 per-pass skip — cache the last engagement class
  // revision so a drain whose W6 key set contains no engagement-touching
  // keys can reuse it.
  let lastEngagementClassRevision: ReturnType<typeof buildEngagementClassRevision> | undefined;
  let catchUpPendingEventWindow: readonly AcceptedEvent[] | null = null;
  let requireScopedTimelineDeltaForDrain = false;
  // Persistent engagement fact store (lazy-opened; survives restart).
  // Sourced via deps for tests; defaults to the SQLite-backed store.
  let engagementFactStore: EngagementFactsStore | null = null;
  let engagementFactStoreInit: Promise<EngagementFactsStore> | null = null;
  let engagementFactStoreUnavailable = false;
  // Persistent timeline fact store (lazy-opened; survives restart).
  // This is owned by the connections materializer: catch up from merged
  // at drain start, then read within the same drain to avoid racing the
  // shared TimelineStore written by the timeline materializer.
  let timelineFactStore: TimelineFactsStore | null = null;
  let timelineFactStoreInit: Promise<TimelineFactsStore> | null = null;
  let timelineFactStoreUnavailable = false;
  let eventStore: EventStore | null = null;
  let eventStoreInit: Promise<EventStore> | null = null;
  let eventStoreUnavailable = false;
  // Returns null when the store cannot be opened (e.g. bun:sqlite is
  // unavailable under the Node test runner) — callers fall back to the
  // legacy in-memory derivation.
  const ensureEngagementFactStore = async (): Promise<EngagementFactsStore | null> => {
    if (engagementFactStore !== null) return engagementFactStore;
    if (engagementFactStoreUnavailable) return null;
    try {
      engagementFactStoreInit ??=
        deps.engagementFactsStore !== undefined
          ? Promise.resolve(deps.engagementFactsStore)
          : createEngagementFactsStore(deps.vaultRoot);
      engagementFactStore = await engagementFactStoreInit;
      return engagementFactStore;
    } catch {
      engagementFactStoreUnavailable = true;
      engagementFactStoreInit = null;
      return null;
    }
  };
  const ensureTimelineFactStore = async (): Promise<TimelineFactsStore | null> => {
    if (timelineFactStore !== null) return timelineFactStore;
    if (timelineFactStoreUnavailable) return null;
    try {
      timelineFactStoreInit ??=
        deps.timelineFactsStore !== undefined
          ? Promise.resolve(deps.timelineFactsStore)
          : createTimelineFactsStore(deps.vaultRoot);
      timelineFactStore = await timelineFactStoreInit;
      return timelineFactStore;
    } catch {
      timelineFactStoreUnavailable = true;
      timelineFactStoreInit = null;
      return null;
    }
  };
  const ensureEventStore = async (): Promise<EventStore | null> => {
    if (eventStore !== null) return eventStore;
    if (eventStoreUnavailable) return null;
    try {
      eventStoreInit ??=
        deps.eventStore !== undefined
          ? Promise.resolve(deps.eventStore)
          : getSharedEventStore(deps.vaultRoot).then((store) => {
              if (store === null) throw new Error('Event store unavailable');
              return store;
            });
      eventStore = await eventStoreInit;
      return eventStore;
    } catch {
      eventStoreUnavailable = true;
      eventStoreInit = null;
      return null;
    }
  };
  // Stage 5.2 W3 wiring — embedder warmth tracker.
  const embedderWarmthTracker: EmbedderWarmthTracker = createEmbedderWarmthTracker();
  // Stage 5.2 W4 wiring — incremental topic accumulator maintained
  // across drains.
  const topicAccumulator = new IncrementalTopicClusterAccumulator();
  // Stage 5.2 W4 — track the last accepted similarity revision id so a
  // revision flip (re-embedding, model upgrade) drives a removeEdge
  // diff against the new revision's edges.
  let lastAcceptedSimilarityRevisionId: string | undefined;
  let lastTopicRunAtMs = 0;
  let topicDrainsSinceLastRun = 0;
  let lastTopicRunSimilarityRevisionId: string | undefined;
  let pendingTopicRecompute = false;
  // Tracks the topic-revision id the persisted connections snapshot
  // currently reflects. An incremental-membership overlay mutates the topic
  // revision (adds secondaryAffiliations) but not the timeline scopes, so the
  // scoped-delta/identity snapshot paths would otherwise leave the served
  // snapshot stale (and a restart would resurface a stale snapshot). When the
  // served revision differs from this, we force a full snapshot rebuild.
  let lastSnapshotTopicRevisionId: string | undefined;
  let lastRankerProducerRevision: string | undefined;
  // Stage 5.2 W3 fast-path — incremental visit similarity index used
  // when SIDETRACK_CONNECTIONS_HOT_SIMILARITY=1 AND the embedder
  // warmth + corpus budget pass `decideHotPathEmbed`. Persisted across
  // drains so each new visit only embeds once.
  const incrementalSimilarityIndexOptions: IncrementalVisitSimilarityIndexOptions = {
    threshold: VISIT_SIMILARITY_DEFAULT_THRESHOLD,
    topK: VISIT_SIMILARITY_DEFAULT_TOP_K,
  };
  const incrementalSimilarityIndex = new IncrementalVisitSimilarityIndex(
    incrementalSimilarityIndexOptions,
  );
  const hnswSimilarityStore = createSimilarityHnswStore();
  let loadedHnswSimilarityStore: LoadedSimilarityHnswStore | null = null;
  const pageEvidenceRecordCache = new Map<string, PageEvidenceRecord>();
  let pending = false;
  let running = false;
  let dirty = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let lastFailureAtMs = 0;
  let lastFrontier: Record<string, number> | undefined;
  // W1c — wall-clock of the last drain pass START. Reference for the
  // minimum interval between drain STARTS (not just the within-drain
  // while-loop continuation), so a steady trigger stream can't pace
  // full rebuilds at the weak DRAIN_DEBOUNCE_MS cadence. 0 ⇒ the
  // first drain is never deferred.
  let lastDrainStartedAtMs = 0;
  let projectionOverlayQueue: Promise<void> = Promise.resolve();
  // Serialise scheduleForegroundNavigationOverlay calls so two
  // NAVIGATION_COMMITTED events landing within ms for the same tab
  // session don't both readMerged + buildConnectionsSnapshot + replaceScopeRows
  // and race the writes (an earlier-started but slower task can land
  // AFTER a later one and overwrite the correct overlay state).
  let foregroundNavigationOverlayQueue: Promise<void> = Promise.resolve();
  // Coalesce foreground-navigation overlays. The overlay does a FULL
  // readMerged() to optimistically resolve the newest nav chain for snappy
  // UI; queuing one per NAVIGATION_COMMITTED floods the main thread under a
  // tab-burst (each readMerged is O(whole log) and the mergedMemo is voided
  // by concurrent ingestion), pinning the event loop for tens of seconds
  // (the "wedge"). Keep at most one overlay in flight and only the newest
  // pending nav events; the authoritative graph drain supersedes the overlay
  // anyway, so we also skip entirely while a drain is pending/running.
  let pendingForegroundNavEvents: AcceptedEvent[] = [];
  let foregroundNavOverlayScheduled = false;
  // Coalesce content-only progress advancement. appendClientObservedBatch
  // dispatches accepted events synchronously; a per-event promise chain
  // can monopolize the event loop with repeated progress read/write
  // cycles. This batches those events into one macrotask and one
  // progress write, with a macrotask yield before any follow-up batch.
  let pendingContentOnlyProgressEvents: AcceptedEvent[] = [];
  let contentOnlyProgressFlushScheduled = false;
  let contentOnlyProgressFlushRunning = false;
  let progressOnlyDirty = false;
  let urgentDrainRequested = false;
  // Stage 5.2 W1a — debounce timer. Coalesces burst event arrivals
  // (e.g. multiple tabs activating in sequence, peer-event imports)
  // into one drain. Cleared when a fresh requestDrain arrives within
  // the window. unref() so a pending timer doesn't keep the process
  // alive at shutdown.
  let drainDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const focusedWindowMsFromEntry = (entry: TimelineEntryWithDimensions): number => {
    if (!isRecord(entry.dimensions)) return 0;
    const engagement = entry.dimensions['engagement'];
    if (!isRecord(engagement)) return 0;
    const focused = engagement['focusedWindowMs'];
    if (typeof focused !== 'number' || !Number.isFinite(focused) || focused < 0) {
      return 0;
    }
    return focused;
  };

  const stripFragmentAndTrailingSlash = (url: string): string =>
    url.replace(/#.*$/u, '').replace(/\/+$/u, '');

  const orderedSimilarityPair = (a: string, b: string): [string, string] =>
    a < b ? [a, b] : [b, a];

  const similarityPairKey = (a: string, b: string): string => {
    const [left, right] = orderedSimilarityPair(a, b);
    return `${left}\u0000${right}`;
  };

  const visitKeyFromTimelineNodeId = (nodeId: string): string | null => {
    const prefix = 'timeline-visit:';
    return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : null;
  };

  const retainedSimilarityEdgesFromSnapshot = (
    snapshot: ConnectionsSnapshot | null,
    touchedVisitIds: ReadonlySet<string>,
    activeVisitIds: ReadonlySet<string>,
  ): readonly VisitSimilarityEdge[] => {
    if (snapshot === null) return [];
    const byPair = new Map<string, VisitSimilarityEdge>();
    for (const edge of snapshot.edges) {
      if (edge.kind !== 'visit_resembles_visit') continue;
      const fromVisitKey = visitKeyFromTimelineNodeId(edge.fromNodeId);
      const toVisitKey = visitKeyFromTimelineNodeId(edge.toNodeId);
      if (fromVisitKey === null || toVisitKey === null) continue;
      if (
        touchedVisitIds.has(fromVisitKey) ||
        touchedVisitIds.has(toVisitKey) ||
        !activeVisitIds.has(fromVisitKey) ||
        !activeVisitIds.has(toVisitKey)
      ) {
        continue;
      }
      const cosine = edge.metadata?.['cosine'];
      if (typeof cosine !== 'number' || !Number.isFinite(cosine)) continue;
      const [fromKey, toKey] = orderedSimilarityPair(fromVisitKey, toVisitKey);
      byPair.set(similarityPairKey(fromKey, toKey), {
        fromVisitKey: fromKey,
        toVisitKey: toKey,
        cosine: Number(cosine.toFixed(6)),
      });
    }
    return [...byPair.values()].sort((left, right) => {
      if (left.fromVisitKey !== right.fromVisitKey)
        return left.fromVisitKey < right.fromVisitKey ? -1 : 1;
      if (left.toVisitKey !== right.toVisitKey) return left.toVisitKey < right.toVisitKey ? -1 : 1;
      return left.cosine - right.cosine;
    });
  };

  const cosineDistance = (left: readonly number[], right: readonly number[]): number => {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const l = left[index] ?? 0;
      const r = right[index] ?? 0;
      dot += l * r;
      leftNorm += l * l;
      rightNorm += r * r;
    }
    if (leftNorm <= 0 || rightNorm <= 0) return 1;
    return 1 - dot / Math.sqrt(leftNorm * rightNorm);
  };

  const exactHnswSimilarityEdges = async (
    store: LoadedSimilarityHnswStore,
    activeVisitIds: ReadonlySet<string>,
    threshold: number,
  ): Promise<readonly VisitSimilarityEdge[]> => {
    const embeddingsByVisitId = new Map<string, readonly number[]>();
    for (const visitId of [...activeVisitIds].sort()) {
      const embedding = await store.embedding(visitId);
      if (embedding !== null) embeddingsByVisitId.set(visitId, embedding);
    }
    const edgeByPair = new Map<string, VisitSimilarityEdge>();
    const visitIds = [...embeddingsByVisitId.keys()].sort();
    for (const visitId of visitIds) {
      const source = embeddingsByVisitId.get(visitId);
      if (source === undefined) continue;
      const ranked: { readonly visitId: string; readonly cosine: number }[] = [];
      for (const candidateVisitId of visitIds) {
        if (candidateVisitId === visitId) continue;
        const candidate = embeddingsByVisitId.get(candidateVisitId);
        if (candidate === undefined) continue;
        const cosine = Number((1 - cosineDistance(source, candidate)).toFixed(6));
        if (cosine < threshold) continue;
        ranked.push({ visitId: candidateVisitId, cosine });
      }
      ranked.sort((left, right) => {
        if (right.cosine !== left.cosine) return right.cosine - left.cosine;
        return left.visitId < right.visitId ? -1 : left.visitId > right.visitId ? 1 : 0;
      });
      for (const neighbor of ranked.slice(0, 50)) {
        const [fromVisitKey, toVisitKey] = orderedSimilarityPair(visitId, neighbor.visitId);
        const key = similarityPairKey(fromVisitKey, toVisitKey);
        const existing = edgeByPair.get(key);
        if (existing === undefined || neighbor.cosine > existing.cosine) {
          edgeByPair.set(key, { fromVisitKey, toVisitKey, cosine: neighbor.cosine });
        }
      }
    }
    return [...edgeByPair.values()].sort((left, right) => {
      if (left.fromVisitKey !== right.fromVisitKey) {
        return left.fromVisitKey < right.fromVisitKey ? -1 : 1;
      }
      if (left.toVisitKey !== right.toVisitKey) return left.toVisitKey < right.toVisitKey ? -1 : 1;
      return left.cosine - right.cosine;
    });
  };

  const resetHnswSimilarityFiles = async (): Promise<void> => {
    await loadedHnswSimilarityStore?.close();
    loadedHnswSimilarityStore = null;
    await rm(join(deps.vaultRoot, '_BAC', 'connections', 'visit-similarity-hnsw.bin'), {
      force: true,
    });
    await rm(join(deps.vaultRoot, '_BAC', 'connections', 'visit-similarity-hnsw.json'), {
      force: true,
    });
    await rm(join(deps.vaultRoot, '_BAC', 'connections', 'visit-similarity-hnsw.current'), {
      force: true,
    });
  };

  const buildHnswVisitSimilarity = async (input: {
    readonly entries: readonly TimelineEntryWithDimensions[];
    readonly revisionId: string;
    readonly config: EffectiveVisitSimilarityConfig;
    readonly touchedVisitIds: ReadonlySet<string>;
    readonly reconcileVisitIds: ReadonlySet<string>;
    readonly removalCandidateVisitIds: ReadonlySet<string>;
    readonly fullRebuild: boolean;
    readonly previousSnapshot: ConnectionsSnapshot | null;
    readonly embed: VisitSimilarityEmbedder;
    readonly evidenceByCanonicalUrl: Parameters<typeof corpusForVisitEntry>[1];
  }): Promise<VisitSimilarityRevision> => {
    const activeEntries = input.entries.filter(
      (entry) => focusedWindowMsFromEntry(entry) >= input.config.engagementGateMs,
    );
    const currentActiveEntryVisitIds = new Set(activeEntries.map(visitKeyForVisitEntry));
    if (activeEntries.length === 0 && input.fullRebuild) {
      if (input.fullRebuild) await resetHnswSimilarityFiles();
      return {
        revisionId: input.revisionId,
        modelId: VISIT_SIMILARITY_MODEL_ID,
        modelRevision: RECALL_MODEL.revision,
        featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
        threshold: input.config.threshold,
        edges: [],
        producedAt: Date.now(),
        producer: 'embedding',
      };
    }
    if (input.fullRebuild) await resetHnswSimilarityFiles();
    const loadedHnswStore = await hnswSimilarityStore.ensureLoaded(
      deps.vaultRoot,
      RECALL_MODEL.embeddingDim,
    );
    loadedHnswSimilarityStore = loadedHnswStore;
    const knownVisitIdsBeforeMutation = input.fullRebuild
      ? new Set<string>()
      : await loadedHnswStore.knownLabels();
    const staleKnownVisitIds = input.fullRebuild
      ? new Set<string>()
      : new Set(
          [...knownVisitIdsBeforeMutation].filter(
            (visitId) =>
              input.removalCandidateVisitIds.has(visitId) &&
              !currentActiveEntryVisitIds.has(visitId),
          ),
        );
    const activeVisitIds = input.fullRebuild
      ? currentActiveEntryVisitIds
      : new Set(
          [...knownVisitIdsBeforeMutation, ...currentActiveEntryVisitIds].filter(
            (visitId) => !staleKnownVisitIds.has(visitId),
          ),
        );
    const touchedVisitIds = input.fullRebuild ? activeVisitIds : input.touchedVisitIds;
    const reconcileVisitIds = input.fullRebuild
      ? activeVisitIds
      : new Set([...touchedVisitIds, ...input.reconcileVisitIds]);
    const entriesToEmbed = input.fullRebuild
      ? activeEntries
      : activeEntries.filter((entry) => reconcileVisitIds.has(visitKeyForVisitEntry(entry)));
    const incrementalHnswMutationVisitIds = new Set([...reconcileVisitIds, ...staleKnownVisitIds]);
    const edgeInvalidationVisitIds =
      input.fullRebuild || incrementalHnswMutationVisitIds.size > 0
        ? new Set([...activeVisitIds, ...staleKnownVisitIds])
        : incrementalHnswMutationVisitIds;

    const embeddingsByVisitKey = new Map<string, Float32Array>();
    if (entriesToEmbed.length > 0) {
      const texts = entriesToEmbed.map(
        (entry) => `passage: ${corpusForVisitEntry(entry, input.evidenceByCanonicalUrl)}`,
      );
      const embedded = await input.embed(texts);
      if (embedded.length !== entriesToEmbed.length) {
        throw new Error(
          `expected ${String(entriesToEmbed.length)} HNSW embeddings, received ${String(embedded.length)}`,
        );
      }
      for (let i = 0; i < entriesToEmbed.length; i += 1) {
        const entry = entriesToEmbed[i];
        const embedding = embedded[i];
        if (entry !== undefined && embedding !== undefined) {
          embeddingsByVisitKey.set(visitKeyForVisitEntry(entry), embedding);
        }
      }
    }

    let hnswMutationCount = 0;
    for (const visitId of staleKnownVisitIds) {
      await loadedHnswStore.delete(visitId);
      hnswMutationCount += 1;
      if (hnswMutationCount % 100 === 0) await yieldToEventLoop();
    }

    const firstEmbedding = embeddingsByVisitKey.values().next().value;
    if (firstEmbedding !== undefined) {
      for (const [visitId, embedding] of embeddingsByVisitKey) {
        await loadedHnswStore.insertOrUpdate(visitId, Array.from(embedding));
        hnswMutationCount += 1;
        if (hnswMutationCount % 100 === 0) await yieldToEventLoop();
      }
    } else if (input.fullRebuild) {
      return {
        revisionId: input.revisionId,
        modelId: VISIT_SIMILARITY_MODEL_ID,
        modelRevision: RECALL_MODEL.revision,
        featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
        threshold: input.config.threshold,
        edges: [],
        producedAt: Date.now(),
        producer: 'embedding',
      };
    }

    const edges =
      input.fullRebuild || incrementalHnswMutationVisitIds.size > 0
        ? await exactHnswSimilarityEdges(loadedHnswStore, activeVisitIds, input.config.threshold)
        : retainedSimilarityEdgesFromSnapshot(
            input.previousSnapshot,
            edgeInvalidationVisitIds,
            activeVisitIds,
          );
    await loadedHnswStore.persist();
    return {
      revisionId: input.revisionId,
      modelId: VISIT_SIMILARITY_MODEL_ID,
      modelRevision: RECALL_MODEL.revision,
      featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
      threshold: input.config.threshold,
      edges,
      producedAt: Date.now(),
      producer: 'embedding',
    };
  };

  const topicVisitFromEntry = (entry: TimelineEntryWithDimensions): TopicVisit => {
    const canonicalUrl = stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);
    return {
      canonicalUrl,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      focusedWindowMs: focusedWindowMsFromEntry(entry),
      firstObservedAt: entry.firstSeenAt,
      lastObservedAt: entry.lastSeenAt,
      ...(entry.workstreamId === undefined ? {} : { workstreamId: entry.workstreamId }),
    };
  };

  // Build the per-day timeline projection in-memory directly from the
  // merged event log instead of reading the timelineStore. The
  // timeline materializer also writes the same projection to disk
  // (for GET /v1/timeline) but its drain runs concurrently with this
  // materializer's drain — reading the disk-backed store would race
  // and produce stale or partial connections snapshots when the
  // timeline materializer hasn't finished yet (most visible
  // cross-replica, where peer events arrive in bursts).
  const buildTimelineDays = (
    merged: readonly AcceptedEvent[],
  ): readonly TimelineDayProjectionWithDimensions[] => {
    return timelineDaysFromTimelineEvents(
      merged.filter(
        (e) => e.type === BROWSER_TIMELINE_OBSERVED && isBrowserTimelineObservedPayload(e.payload),
      ),
    );
  };

  const dimensionsWithFocusedWindowMs = (
    entry: TimelineEntryWithDimensions,
    focusedWindowMs: number,
  ): Record<string, unknown> => {
    const dimensions = isRecord(entry.dimensions) ? entry.dimensions : {};
    const engagement = isRecord(dimensions['engagement']) ? dimensions['engagement'] : {};
    return {
      ...dimensions,
      engagement: {
        ...engagement,
        focusedWindowMs,
      },
    };
  };

  const enrichTimelineDaysWithEngagement = (
    days: readonly TimelineDayProjectionWithDimensions[],
    engagementInputs: ReturnType<typeof buildEngagementClassifierInputs>,
  ): readonly TimelineDayProjectionWithDimensions[] => {
    const focusedByCanonicalUrl = new Map<string, number>();
    for (const input of engagementInputs) {
      const canonicalUrl = stripFragmentAndTrailingSlash(input.canonicalUrl);
      focusedByCanonicalUrl.set(
        canonicalUrl,
        Math.max(focusedByCanonicalUrl.get(canonicalUrl) ?? 0, input.engagement.focusedWindowMs),
      );
    }

    return days.map((day) => ({
      ...day,
      entries: day.entries.map((entry): TimelineEntryWithDimensions => {
        const canonicalUrl = stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);
        const focusedWindowMs = Math.max(
          focusedWindowMsFromEntry(entry),
          focusedByCanonicalUrl.get(canonicalUrl) ?? 0,
        );
        if (focusedWindowMs <= 0) return entry;
        return {
          ...entry,
          dimensions: dimensionsWithFocusedWindowMs(entry, focusedWindowMs),
        };
      }),
    }));
  };

  const timelineEntryVisitKey = (entry: TimelineEntryWithDimensions): string =>
    stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);

  const pendingEventIsSearchTimelineVisit = (event: AcceptedEvent): boolean =>
    event.type === BROWSER_TIMELINE_OBSERVED &&
    isBrowserTimelineObservedPayload(event.payload) &&
    detectSearchUrl(event.payload.canonicalUrl ?? event.payload.url) !== null;

  const threadIdFromScopedDeltaEvent = (event: AcceptedEvent): string | null => {
    if (event.type === THREAD_UPSERTED && isThreadUpsertedPayload(event.payload)) {
      return event.payload.bac_id;
    }
    if (
      (event.type === THREAD_ARCHIVED ||
        event.type === THREAD_UNARCHIVED ||
        event.type === THREAD_DELETED) &&
      isThreadStatusPayload(event.payload)
    ) {
      return event.payload.bac_id;
    }
    return null;
  };

  const captureThreadIdForScopedDelta = (event: AcceptedEvent): string | null => {
    if (event.type !== CAPTURE_RECORDED || !isCaptureRecordedPayload(event.payload)) return null;
    if (typeof event.payload.threadId === 'string' && event.payload.threadId.length > 0) {
      return event.payload.threadId;
    }
    if (event.aggregateId.length > 0) return event.aggregateId;
    return event.payload.bac_id;
  };

  const captureEdgeThreadIdForScopedDelta = (event: AcceptedEvent): string | null => {
    if (event.type !== CAPTURE_RECORDED || !isCaptureRecordedPayload(event.payload)) return null;
    return event.payload.threadId ?? event.payload.bac_id;
  };

  const captureReferencedUrlsForScopedDelta = (event: AcceptedEvent): readonly string[] => {
    if (event.type !== CAPTURE_RECORDED || !isCaptureRecordedPayload(event.payload)) return [];
    const urls = new Set<string>();
    for (const turn of event.payload.turns) {
      for (const source of [turn.text, turn.markdown, turn.formattedText]) {
        if (typeof source !== 'string' || source.length === 0) continue;
        for (const url of extractUrlsFromText(source)) urls.add(normalizeVisitUrl(url));
      }
    }
    return [...urls].sort();
  };

  const eventAfterFrontier = (
    event: AcceptedEvent,
    frontier: Record<string, number> | undefined,
  ): boolean => frontier === undefined || event.dot.seq > (frontier[event.dot.replicaId] ?? 0);

  const previousSnapshotHasThreadReferenceUrls = (input: {
    readonly previousSnapshot: ConnectionsSnapshot;
    readonly event: AcceptedEvent;
    readonly urls: readonly string[];
  }): boolean => {
    const threadId = captureEdgeThreadIdForScopedDelta(input.event);
    if (threadId === null || input.urls.length === 0) return false;
    const fromNodeId = nodeIdFor('thread', threadId);
    const eventObservedAt = new Date(input.event.acceptedAtMs).toISOString();
    const wantedToNodeIds = new Set(
      input.urls.map((url) => nodeIdFor('timeline-visit', normalizeVisitUrl(url))),
    );
    const seenToNodeIds = new Set<string>();
    for (const edge of input.previousSnapshot.edges) {
      if (edge.kind !== 'thread_references_url') continue;
      if (edge.fromNodeId !== fromNodeId) continue;
      if (edge.observedAt > eventObservedAt) continue;
      if (wantedToNodeIds.has(edge.toNodeId)) seenToNodeIds.add(edge.toNodeId);
    }
    return seenToNodeIds.size === wantedToNodeIds.size;
  };

  const isThreadScopedDeltaEvent = (event: AcceptedEvent): boolean =>
    THREAD_SCOPED_DELTA_HANDLES.has(event.type);

  const SCOPED_DELTA_HARMLESS_INVALIDATION_KINDS: ReadonlySet<InvalidationKey['kind']> = new Set([
    'chunkerVersion',
    'contentEvidence',
    'contentSimilarity',
    'embeddingModelRevision',
    'extractionRevision',
    'inboxFilter',
    'queue',
    'rankerLabels',
    'recallIndex',
    'sourceUnit',
  ]);

  const SCOPED_DELTA_FULL_REBUILD_INVALIDATION_KINDS: ReadonlySet<InvalidationKey['kind']> =
    new Set(['workstreamTree']);

  const isScopedTimelineDeltaEvent = (event: AcceptedEvent): boolean => {
    const invalidationKeys = invalidationsForEvent(event);
    if (
      invalidationKeys.some((key) => SCOPED_DELTA_FULL_REBUILD_INVALIDATION_KINDS.has(key.kind))
    ) {
      return false;
    }
    if (invalidationKeysToScopes(invalidationKeys).length > 0) return true;
    return invalidationKeys.every((key) => SCOPED_DELTA_HARMLESS_INVALIDATION_KINDS.has(key.kind));
  };

  const collectScopedEventsForDelta = (
    pendingEvents: readonly AcceptedEvent[],
    allEvents: readonly AcceptedEvent[],
    scopedVisitKeys: Set<string>,
    options: {
      readonly includeCaptures?: boolean;
      readonly previousSnapshot?: ConnectionsSnapshot;
      readonly priorFrontier?: Record<string, number>;
    } = {},
  ): AcceptedEvent[] => {
    const visitIds = new Set<string>();
    const threadIds = new Set<string>();
    for (const event of pendingEvents) {
      if (event.type === NAVIGATION_COMMITTED && isNavigationCommittedPayload(event.payload)) {
        const canonicalUrl = normalizeVisitUrl(event.payload.canonicalUrl);
        scopedVisitKeys.add(canonicalUrl);
        visitIds.add(event.payload.visitId);
        for (const relatedVisitId of [event.payload.previousVisitId, event.payload.openerVisitId]) {
          if (relatedVisitId === null) continue;
          visitIds.add(relatedVisitId);
          scopedVisitKeys.add(relatedVisitId);
        }
      }
      const threadId = threadIdFromScopedDeltaEvent(event);
      if (threadId !== null) {
        threadIds.add(threadId);
      }
    }
    if (
      visitIds.size === 0 &&
      threadIds.size === 0 &&
      !(options.includeCaptures === true && scopedVisitKeys.size > 0)
    ) {
      return [];
    }
    const out: AcceptedEvent[] = [];
    const seen = new Set<string>();
    for (const event of allEvents) {
      const sig = `${event.dot.replicaId}:${String(event.dot.seq)}`;
      if (seen.has(sig)) continue;
      if (event.type === NAVIGATION_COMMITTED && isNavigationCommittedPayload(event.payload)) {
        if (!visitIds.has(event.payload.visitId)) continue;
        seen.add(sig);
        scopedVisitKeys.add(normalizeVisitUrl(event.payload.canonicalUrl));
        out.push(event);
        continue;
      }
      const threadId = threadIdFromScopedDeltaEvent(event);
      if (threadId === null || !threadIds.has(threadId)) continue;
      seen.add(sig);
      out.push(event);
    }
    if (options.includeCaptures === true) {
      const visitKeysForCaptureMatch = new Set(scopedVisitKeys);
      for (const event of allEvents) {
        if (event.type !== CAPTURE_RECORDED || !isCaptureRecordedPayload(event.payload)) continue;
        const sig = `${event.dot.replicaId}:${String(event.dot.seq)}`;
        if (seen.has(sig)) continue;
        const referencedUrls = captureReferencedUrlsForScopedDelta(event);
        const captureThreadId = captureThreadIdForScopedDelta(event);
        const threadInScope =
          threadIds.has(event.aggregateId) ||
          (captureThreadId !== null && threadIds.has(captureThreadId));
        const urlInScope = referencedUrls.some((url) => visitKeysForCaptureMatch.has(url));
        if (!threadInScope && !urlInScope) continue;
        if (!eventAfterFrontier(event, options.priorFrontier)) {
          if (
            referencedUrls.length === 0 ||
            options.previousSnapshot === undefined ||
            previousSnapshotHasThreadReferenceUrls({
              previousSnapshot: options.previousSnapshot,
              event,
              urls: referencedUrls,
            })
          ) {
            continue;
          }
        }
        seen.add(sig);
        for (const url of referencedUrls) scopedVisitKeys.add(url);
        out.push(event);
      }
    }
    return out;
  };

  const visitKeyFromTimelineNodeIdForDelta = (nodeId: string): string | null => {
    const prefix = 'timeline-visit:';
    return nodeId.startsWith(prefix) && nodeId.length > prefix.length
      ? nodeId.slice(prefix.length)
      : null;
  };

  const addSimilarityAffectedVisitKeys = (input: {
    readonly seedVisitKeys: ReadonlySet<string>;
    readonly scopedVisitKeys: Set<string>;
    readonly requiredTimelineVisitKeys: Set<string>;
    readonly previousSnapshot: ConnectionsSnapshot;
    readonly visitSimilarity: VisitSimilarityRevision;
  }): void => {
    const considerPair = (fromVisitKey: string, toVisitKey: string): void => {
      if (!input.seedVisitKeys.has(fromVisitKey) && !input.seedVisitKeys.has(toVisitKey)) return;
      input.scopedVisitKeys.add(fromVisitKey);
      input.scopedVisitKeys.add(toVisitKey);
      input.requiredTimelineVisitKeys.add(fromVisitKey);
      input.requiredTimelineVisitKeys.add(toVisitKey);
    };
    for (const edge of input.previousSnapshot.edges) {
      if (edge.kind !== 'visit_resembles_visit') continue;
      const fromVisitKey = visitKeyFromTimelineNodeIdForDelta(edge.fromNodeId);
      const toVisitKey = visitKeyFromTimelineNodeIdForDelta(edge.toNodeId);
      if (fromVisitKey === null || toVisitKey === null) continue;
      considerPair(fromVisitKey, toVisitKey);
    }
    for (const edge of input.visitSimilarity.edges) {
      considerPair(edge.fromVisitKey, edge.toVisitKey);
    }
  };

  const filterTimelineDaysForScopedDelta = (
    days: readonly TimelineDayProjectionWithDimensions[],
    input: {
      readonly requiredTimelineVisitKeys: ReadonlySet<string>;
      readonly tabSessionIds: ReadonlySet<string>;
      readonly includeTabSessionHistory: boolean;
    },
  ): readonly TimelineDayProjectionWithDimensions[] => {
    const out: TimelineDayProjectionWithDimensions[] = [];
    for (const day of days) {
      const entries = day.entries.filter((entry) => {
        if (input.requiredTimelineVisitKeys.has(timelineEntryVisitKey(entry))) return true;
        // A tab-session id on a fresh timeline observation identifies the
        // tab-session row to refresh; it is not a request to rebuild every
        // historical URL observed in that tab. Only true tab-session
        // attribution changes need the full session history because they
        // can affect fallback workstream edges for prior visit instances.
        return (
          input.includeTabSessionHistory &&
          entry.tabSessionId !== undefined &&
          input.tabSessionIds.has(entry.tabSessionId)
        );
      });
      if (entries.length > 0) out.push({ ...day, entries });
    }
    return out;
  };

  const visitInstanceScopesFromSnapshot = (
    snapshot: ConnectionsSnapshot,
    input: {
      readonly visitKeys: ReadonlySet<string>;
      readonly tabSessionIds: ReadonlySet<string>;
    },
  ): readonly Scope[] => {
    const scopes: Scope[] = [];
    const prefix = 'visit-instance:';
    for (const node of snapshot.nodes) {
      if (node.kind !== 'visit-instance' || !node.id.startsWith(prefix)) continue;
      const timelineVisitId = node.metadata['timelineVisitId'];
      const visitKey =
        typeof timelineVisitId === 'string'
          ? visitKeyFromTimelineNodeIdForDelta(timelineVisitId)
          : null;
      const tabSessionId = node.metadata['tabSessionId'];
      if (
        (visitKey !== null && input.visitKeys.has(visitKey)) ||
        (typeof tabSessionId === 'string' && input.tabSessionIds.has(tabSessionId))
      ) {
        scopes.push({ kind: 'visit', id: node.id.slice(prefix.length) });
      }
    }
    return scopes;
  };

  const scopesOwnGraphRows = (snapshot: ConnectionsSnapshot, scopes: readonly Scope[]): boolean => {
    for (const scope of scopes) {
      const scoped = recomputeScope(scope, snapshot);
      if (scoped.nodes.length > 0 || scoped.edges.length > 0) return true;
    }
    return false;
  };

  const threadNodeFromSnapshot = (
    snapshot: ConnectionsSnapshot,
    threadId: string,
  ): ConnectionsSnapshot['nodes'][number] | undefined =>
    snapshot.nodes.find((node) => node.id === nodeIdFor('thread', threadId));

  const normalizedThreadUrlFromSnapshot = (
    snapshot: ConnectionsSnapshot,
    threadId: string,
  ): string | null => {
    const node = threadNodeFromSnapshot(snapshot, threadId);
    const canonicalUrl = node?.metadata['canonicalUrl'];
    if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
      return normalizeVisitUrl(canonicalUrl);
    }
    const url = node?.metadata['url'];
    return typeof url === 'string' && url.length > 0 ? normalizeVisitUrl(url) : null;
  };

  const threadWorkstreamIdsFromSnapshot = (
    snapshot: ConnectionsSnapshot,
    threadId: string,
  ): ReadonlySet<string> => {
    const threadNodeId = nodeIdFor('thread', threadId);
    return new Set(
      snapshot.edges
        .filter((edge) => edge.kind === 'thread_in_workstream' && edge.fromNodeId === threadNodeId)
        .map((edge) => {
          const prefix = 'workstream:';
          return edge.toNodeId.startsWith(prefix) ? edge.toNodeId.slice(prefix.length) : '';
        })
        .filter((id) => id.length > 0),
    );
  };

  const setsEqual = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
    if (left.size !== right.size) return false;
    for (const item of left) {
      if (!right.has(item)) return false;
    }
    return true;
  };

  const threadDeltaFullBuildReason = (input: {
    readonly previousSnapshot: ConnectionsSnapshot;
    readonly scopedSnapshot: ConnectionsSnapshot;
    readonly threadScopes: readonly Scope[];
    readonly deletedThreadIds: ReadonlySet<string>;
  }): string | null => {
    for (const scope of input.threadScopes) {
      if (scope.kind !== 'thread' || input.deletedThreadIds.has(scope.id)) continue;
      const previousUrl = normalizedThreadUrlFromSnapshot(input.previousSnapshot, scope.id);
      const scopedUrl = normalizedThreadUrlFromSnapshot(input.scopedSnapshot, scope.id);
      if (previousUrl !== null && scopedUrl !== null && previousUrl !== scopedUrl) {
        return 'thread-url-changed';
      }
      const previousWorkstreams = threadWorkstreamIdsFromSnapshot(input.previousSnapshot, scope.id);
      const scopedWorkstreams = threadWorkstreamIdsFromSnapshot(input.scopedSnapshot, scope.id);
      if (previousWorkstreams.size > 0 && !setsEqual(previousWorkstreams, scopedWorkstreams)) {
        return 'thread-workstream-membership-changed';
      }
    }
    return null;
  };

  const filterDeletedThreadsForScopedDelta = (
    threads: readonly ThreadVaultRecord[],
    deletedThreadIds: ReadonlySet<string>,
  ): readonly ThreadVaultRecord[] =>
    deletedThreadIds.size === 0
      ? threads
      : threads.filter((thread) => !deletedThreadIds.has(thread.bac_id));

  const addEndpointNodesForScopedDelta = (input: {
    readonly output: ScopeRecomputeOutput;
    readonly previousSnapshot: ConnectionsSnapshot;
    readonly scopedSnapshot: ConnectionsSnapshot;
  }): ScopeRecomputeOutput => {
    const nodes = new Map(input.output.nodes.map((node) => [node.id, node]));
    const previousNodes = new Map(input.previousSnapshot.nodes.map((node) => [node.id, node]));
    const scopedNodes = new Map(input.scopedSnapshot.nodes.map((node) => [node.id, node]));
    for (const edge of input.output.edges) {
      for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
        if (nodes.has(nodeId)) continue;
        const node = previousNodes.get(nodeId) ?? scopedNodes.get(nodeId);
        if (node !== undefined) nodes.set(nodeId, node);
      }
    }
    return {
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...input.output.edges].sort((a, b) => a.id.localeCompare(b.id)),
    };
  };

  const preserveThreadRowsForScopedDelta = (input: {
    readonly output: ScopeRecomputeOutput;
    readonly previousSnapshot: ConnectionsSnapshot;
    readonly scopedSnapshot: ConnectionsSnapshot;
    readonly threadScopes: readonly Scope[];
    readonly deletedThreadIds: ReadonlySet<string>;
  }): ScopeRecomputeOutput => {
    if (input.threadScopes.length === 0) {
      return addEndpointNodesForScopedDelta({
        output: input.output,
        previousSnapshot: input.previousSnapshot,
        scopedSnapshot: input.scopedSnapshot,
      });
    }
    const nodes = new Map(input.output.nodes.map((node) => [node.id, node]));
    const edges = new Map(input.output.edges.map((edge) => [edge.id, edge]));
    const scopesToPreserve = input.threadScopes.filter(
      (scope) => scope.kind === 'thread' && !input.deletedThreadIds.has(scope.id),
    );
    const previousRows = unionScopeOutputs(
      scopesToPreserve.map((scope) => recomputeScope(scope, input.previousSnapshot)),
    );
    for (const node of previousRows.nodes) {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }
    for (const edge of previousRows.edges) {
      if (edge.kind === 'thread_in_workstream') continue;
      const existing = edges.get(edge.id);
      if (existing === undefined || edge.observedAt < existing.observedAt) edges.set(edge.id, edge);
    }
    return addEndpointNodesForScopedDelta({
      output: {
        nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
        edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
      },
      previousSnapshot: input.previousSnapshot,
      scopedSnapshot: input.scopedSnapshot,
    });
  };

  const newestNavigationCommittedEvents = (
    events: readonly AcceptedEvent[],
    limit: number,
  ): AcceptedEvent[] =>
    events
      .filter((event) => event.type === NAVIGATION_COMMITTED)
      .sort((left, right) => {
        if (left.acceptedAtMs !== right.acceptedAtMs) return right.acceptedAtMs - left.acceptedAtMs;
        return right.dot.seq - left.dot.seq;
      })
      .slice(0, limit)
      .sort((left, right) => {
        if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
        return left.dot.seq - right.dot.seq;
      });

  const timelineObservedEventFromNavigation = (event: AcceptedEvent): AcceptedEvent | null => {
    if (event.type !== NAVIGATION_COMMITTED || !isNavigationCommittedPayload(event.payload)) {
      return null;
    }
    const observedAt = new Date(event.payload.commitTimestamp);
    if (!Number.isFinite(observedAt.getTime())) return null;
    const payload: BrowserTimelineObservedPayload = {
      eventId: `navigation-foreground:${event.payload.visitId}`,
      observedAt: observedAt.toISOString(),
      url: event.payload.url,
      canonicalUrl: event.payload.canonicalUrl,
      provider: 'generic',
      transition: 'updated',
      tabIdHash: event.payload.tabSessionIdHash,
      windowIdHash: event.payload.windowSessionIdHash,
      tabSessionId: event.payload.tabSessionIdHash,
      payloadVersion: 1,
    };
    return {
      clientEventId: `${event.clientEventId}:foreground-timeline`,
      dot: event.dot,
      deps: event.deps,
      aggregateId: `browser.timeline.observed:${event.payload.tabSessionIdHash}:${event.payload.canonicalUrl}`,
      type: BROWSER_TIMELINE_OBSERVED,
      payload,
      acceptedAtMs: event.acceptedAtMs,
      ...(event.hlc === undefined ? {} : { hlc: event.hlc }),
    };
  };

  const writeForegroundNavigationDelta = async (input: {
    readonly pendingEventsForDrain: readonly AcceptedEvent[];
    readonly merged: readonly AcceptedEvent[];
    readonly existingProgress: MaterializerProgress | null;
    readonly timelineDays?: readonly TimelineDayProjectionWithDimensions[];
    readonly tabSessionProjection?: ReturnType<typeof tabSessionProjectionFromAccumulator>;
    readonly urlProjection?: ReturnType<typeof urlProjectionFromAccumulator>;
    readonly mark: (label: string) => void;
  }): Promise<boolean> => {
    const replaceScopeRows = deps.store.replaceScopeRows;
    if (
      replaceScopeRows === undefined ||
      input.existingProgress === null ||
      input.existingProgress.materializerVersion !== MATERIALIZER_VERSION ||
      input.pendingEventsForDrain.length === 0
    ) {
      return false;
    }

    // Foreground UI only needs the newest committed navigation chain to
    // stop showing "direct visit" after an HN click. The full drain below
    // still consumes the complete pending set and advances progress.
    const foregroundNavigationEvents = newestNavigationCommittedEvents(
      input.pendingEventsForDrain,
      4,
    );
    if (foregroundNavigationEvents.length === 0) return false;

    const scopedVisitKeys = new Set<string>();
    const currentVisitKeys = new Set<string>();
    const scopedNavigationEvents = collectScopedEventsForDelta(
      foregroundNavigationEvents,
      input.merged,
      scopedVisitKeys,
    );
    if (scopedNavigationEvents.length === 0) return false;

    const tabSessionIds = new Set<string>();
    for (const event of foregroundNavigationEvents) {
      if (!isNavigationCommittedPayload(event.payload)) continue;
      currentVisitKeys.add(normalizeVisitUrl(event.payload.canonicalUrl));
      const sessionId = event.payload.tabSessionIdHash;
      if (typeof sessionId === 'string' && sessionId.length > 0) tabSessionIds.add(sessionId);
    }
    const requiredTimelineVisitKeys = new Set(scopedVisitKeys);
    const scopedTimelineDays =
      input.timelineDays === undefined
        ? buildTimelineDays(
            scopedNavigationEvents.flatMap((event) => {
              const timelineEvent = timelineObservedEventFromNavigation(event);
              return timelineEvent === null ? [] : [timelineEvent];
            }),
          )
        : filterTimelineDaysForScopedDelta(input.timelineDays, {
            requiredTimelineVisitKeys,
            tabSessionIds,
            includeTabSessionHistory: false,
          });
    const tabSessionProjection =
      input.tabSessionProjection ??
      tabSessionProjectionFromAccumulator(createEmptyTabSessionProjectionAccumulator());
    const scopedSnapshot = buildConnectionsSnapshot({
      events: scopedNavigationEvents,
      threads: [],
      workstreams: [],
      dispatches: [],
      queueItems: [],
      reminders: [],
      codingSessions: [],
      timelineDays: scopedTimelineDays,
      tabSessionProjection,
      ...(input.urlProjection === undefined ? {} : { urlProjection: input.urlProjection }),
    });
    // Deliberately omit scope:url=X from the replace set. Per
    // connectionsScopes, edges like closest_visit / visit_resembles_visit
    // / annotation that incident URL X have primaryScope = scope:url=X.
    // If we include scope:url=X here, replaceScopeRows orphan-deletes
    // every one of those historical edges (only this scoped snapshot's
    // brand-new visit_in_tab_session + visit_instance_same_url_as_timeline_visit
    // edges are in the replace input) — leaving readResolverSubgraphForUrl(X)
    // empty of similarity neighbours for the ~250ms between this overlay
    // commit and the next full drain.
    //
    // The new visit-instance node still gets membership inserted into
    // scope:url=X via INSERT OR IGNORE on the upsert side (scopesForGraphRows
    // computes it from the node's own kind/id), so the URL keeps the
    // new visit; we just don't touch the URL's other historical members.
    const rowLocalScopes = dedupeScopeList([
      ...[...tabSessionIds.values()].map((id) => ({ kind: 'tab-session' as const, id })),
      ...visitInstanceScopesFromSnapshot(scopedSnapshot, {
        visitKeys: currentVisitKeys,
        tabSessionIds,
      }),
    ]);
    if (rowLocalScopes.length === 0) return false;
    await replaceScopeRows({
      scopes: rowLocalScopes,
      nodes: scopedSnapshot.nodes,
      edges: scopedSnapshot.edges,
      // Do not mark the dots applied here. This is a UI-latency overlay;
      // the deterministic full/scoped drain below advances progress.
      // 'snapshot-revision-only' is required because input.existingProgress
      // was read OUTSIDE the BEGIN IMMEDIATE — a concurrent drain that
      // committed in the meantime would otherwise have its progress
      // overwritten with our stale snapshot.
      progress: input.existingProgress,
      progressMode: 'snapshot-revision-only',
      metadata: {
        ...(scopedSnapshot.urlProjection === undefined
          ? {}
          : { urlProjection: scopedSnapshot.urlProjection }),
        tabSessionProjection: scopedSnapshot.tabSessionProjection,
      },
    });
    input.mark(
      `foregroundNavigationDelta scopes=${String(rowLocalScopes.length)} nodes=${String(scopedSnapshot.nodes.length)} edges=${String(scopedSnapshot.edges.length)} entries=${String(scopedTimelineDays.reduce((sum, day) => sum + day.entries.length, 0))} nav=${String(scopedNavigationEvents.length)}`,
    );
    return true;
  };

  const maxAcceptedAtMs = (events: readonly AcceptedEvent[]): number =>
    events.reduce((max, event) => Math.max(max, event.acceptedAtMs), 0);

  const countClosestVisitEdges = (snapshot: ConnectionsSnapshot): number =>
    snapshot.edges.filter((edge) => edge.kind === 'closest_visit').length;

  const countRankerSourceEdges = (snapshot: ConnectionsSnapshot): number =>
    snapshot.edges.filter((edge) => edge.producedBy.source === 'ranker').length;

  const modelFreshnessFor = (
    result: RankerRetrainResult | null,
  ): MaterializerRankerModelFreshness => {
    if (result === null) return 'unknown';
    if (result.status === 'trained') return 'fresh';
    if (result.status === 'failed') return 'stale';
    return result.newLabelCount > 0 ? 'stale' : 'fresh';
  };

  const rankerAugmentationCounters = (input: {
    readonly status: MaterializerRankerAugmentationCounters['status'];
    readonly reason: string | null;
    readonly activeRevisionId: string | null;
    readonly activeModelVersion: string | null;
    readonly expectedModelVersion: string;
    readonly activeFeatureSchemaVersion: number | null;
    readonly expectedFeatureSchemaVersion: number;
    readonly needsRetrain: boolean;
    readonly modelFreshness: MaterializerRankerModelFreshness;
    readonly methodologySpine: MaterializerRankerMethodologySpineDiagnostics | null;
    readonly baseSnapshot: ConnectionsSnapshot;
    readonly finalSnapshot: ConnectionsSnapshot;
  }): MaterializerRankerAugmentationCounters => ({
    status: input.status,
    reason: input.reason,
    activeRevisionId: input.activeRevisionId,
    activeModelVersion: input.activeModelVersion,
    expectedModelVersion: input.expectedModelVersion,
    activeFeatureSchemaVersion: input.activeFeatureSchemaVersion,
    expectedFeatureSchemaVersion: input.expectedFeatureSchemaVersion,
    needsRetrain: input.needsRetrain,
    modelFreshness: input.modelFreshness,
    methodologySpine: input.methodologySpine,
    baseEdgeCount: input.baseSnapshot.edges.length,
    finalEdgeCount: input.finalSnapshot.edges.length,
    closestVisitEdgeCount: countClosestVisitEdges(input.finalSnapshot),
    rankerSourceEdgeCount: countRankerSourceEdges(input.finalSnapshot),
  });

  const schemaDiagnosticsFor = (
    result: ClosestVisitRankerLoadResult | null,
  ): Pick<
    MaterializerRankerAugmentationCounters,
    | 'activeModelVersion'
    | 'expectedModelVersion'
    | 'activeFeatureSchemaVersion'
    | 'expectedFeatureSchemaVersion'
    | 'needsRetrain'
    | 'methodologySpine'
  > => ({
    activeModelVersion:
      result?.activeModelVersion ??
      (result?.status === 'ready' ? expectedClosestVisitRankerSchema.modelVersion : null),
    expectedModelVersion:
      result?.expectedModelVersion ?? expectedClosestVisitRankerSchema.modelVersion,
    activeFeatureSchemaVersion:
      result?.activeFeatureSchemaVersion ??
      (result?.status === 'ready' ? expectedClosestVisitRankerSchema.featureSchemaVersion : null),
    expectedFeatureSchemaVersion:
      result?.expectedFeatureSchemaVersion ?? expectedClosestVisitRankerSchema.featureSchemaVersion,
    needsRetrain: result?.needsRetrain ?? false,
    methodologySpine: result?.methodologySpine ?? null,
  });

  const loadClosestVisitRanker = async (): Promise<ClosestVisitRankerLoadResult> => {
    const manifest = await readActiveClosestVisitRankerRevisionManifest(deps.vaultRoot);
    if (manifest === null) {
      const probe = await readActiveClosestVisitRankerRevisionManifestProbe(deps.vaultRoot);
      if (probe !== null) {
        return {
          status: 'invalid',
          activeRevisionId: probe.revisionId,
          reason: probe.staleModelSchema ? 'stale-model-schema' : 'invalid-active-manifest',
          error: null,
          activeModelVersion: probe.activeModelVersion,
          expectedModelVersion: probe.expectedModelVersion,
          activeFeatureSchemaVersion: probe.activeFeatureSchemaVersion,
          expectedFeatureSchemaVersion: probe.expectedFeatureSchemaVersion,
          needsRetrain: probe.staleModelSchema,
          methodologySpine: null,
        };
      }
      return {
        status: 'missing',
        activeRevisionId: null,
        reason: 'no-active-manifest',
        needsRetrain: false,
        methodologySpine: null,
      };
    }
    const methodologySpine = rankerMethodologySpineDiagnosticsFromTrainQuality(
      manifest.trainQuality,
    );
    const revision = await readClosestVisitRankerRevision(deps.vaultRoot, manifest.revisionId);
    if (revision === null) {
      return {
        status: 'invalid',
        activeRevisionId: manifest.revisionId,
        reason: 'missing-revision',
        error: null,
        activeModelVersion: manifest.modelVersion,
        expectedModelVersion: expectedClosestVisitRankerSchema.modelVersion,
        activeFeatureSchemaVersion: manifest.featureSchemaVersion,
        expectedFeatureSchemaVersion: expectedClosestVisitRankerSchema.featureSchemaVersion,
        needsRetrain: false,
        methodologySpine,
      };
    }
    try {
      const model = await loadRankerModel(revision);
      return {
        status: 'ready',
        activeRevisionId: manifest.revisionId,
        model,
        activeModelVersion: manifest.modelVersion,
        expectedModelVersion: expectedClosestVisitRankerSchema.modelVersion,
        activeFeatureSchemaVersion: manifest.featureSchemaVersion,
        expectedFeatureSchemaVersion: expectedClosestVisitRankerSchema.featureSchemaVersion,
        needsRetrain: false,
        methodologySpine,
        ranker: {
          revisionId: model.revisionId,
          predict: (features) => predictRanker(features, model),
        },
      };
    } catch (err) {
      return {
        status: 'invalid',
        activeRevisionId: manifest.revisionId,
        reason: 'load-failed',
        error: err instanceof Error ? err.message : String(err),
        activeModelVersion: manifest.modelVersion,
        expectedModelVersion: expectedClosestVisitRankerSchema.modelVersion,
        activeFeatureSchemaVersion: manifest.featureSchemaVersion,
        expectedFeatureSchemaVersion: expectedClosestVisitRankerSchema.featureSchemaVersion,
        needsRetrain: false,
        methodologySpine,
      };
    }
  };
  const closestVisitRankerLoader =
    deps.closestVisitRankerLoader ??
    ((): Promise<ClosestVisitRankerLoadResult> => loadClosestVisitRanker());
  const disposedRankerModels = new WeakSet<object>();

  // Stage 5.2 W1b — cooperative yielding. Each major sync-CPU phase
  // is preceded by `yieldToEventLoop()` so HTTP request handlers and
  // other I/O callbacks get a turn between phases. HTTP P99 during
  // reconcile becomes "max phase duration" instead of "full rebuild
  // duration." A future PR may move execution to a worker_thread,
  // which would drop P99 to ~0; this is the lower-risk first step.
  const yieldToEventLoop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  const progressForSnapshot = (
    events: readonly AcceptedEvent[],
    snapshot: ConnectionsSnapshot,
  ): MaterializerProgress => {
    const appliedDotIntervals = addDotsToIntervals(
      {},
      events.map((event) => event.dot),
    );
    return {
      ...EMPTY_PROGRESS(MATERIALIZER_NAME, MATERIALIZER_VERSION),
      appliedDotIntervals,
      appliedFrontier: frontierFromIntervals(appliedDotIntervals),
      snapshotRevisionId: snapshot.snapshotRevision ?? null,
    };
  };

  const buildAndWrite = async (): Promise<ConnectionsSnapshot> => {
    const phaseLogs = process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] === '1';
    const phaseStart = Date.now();
    let phaseLast = phaseStart;
    const phaseDurations: MaterializerPhaseDuration[] = [];
    const mark = (label: string): void => {
      const now = Date.now();
      const durationMs = now - phaseLast;
      const totalMs = now - phaseStart;
      phaseDurations.push({ label, durationMs, totalMs });
      if (phaseLogs) {
        console.warn(
          `[connections-phase] ${label} dt=${String(durationMs)}ms total=${String(totalMs)}ms`,
        );
      }
      phaseLast = now;
    };
    // Stage 5.2 W6 — snapshot the invalidation keys accumulated since
    // the last drain entry, then clear the accumulator. dedupe via JSON
    // sig so logs and downstream skip-gates see a normalised set.
    const buildKeys = dedupeInvalidationKeys(accumulatedInvalidations);
    accumulatedInvalidations = [];
    lastBuildInvalidations = buildKeys;
    const incrementalGraphPlan = incrementalGraphView.drainPlan();
    mark(`w6 keys=${String(buildKeys.length)}`);
    const existingProgress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
    const storeBackedEvents = eventStoreEnabled() ? await ensureEventStore() : null;
    const effectiveLastFrontier = lastFrontier ?? existingProgress?.appliedFrontier ?? undefined;
    let merged: readonly AcceptedEvent[];
    let pendingEventsForDrain: readonly AcceptedEvent[];
    let maxAcceptedAtMsForDrain: number;
    let drainFrontier: VersionVector;
    let drainProgressDotIntervals: MaterializerProgress['appliedDotIntervals'] | null = null;
    let loadedProjectionAccumulatorState = false;
    const existingProgressMatches =
      existingProgress !== null && existingProgress.materializerVersion === MATERIALIZER_VERSION;
    const forcedPendingEventWindow = catchUpPendingEventWindow;
    if (forcedPendingEventWindow !== null) {
      if (!existingProgressMatches) {
        throw new Error('connections catchUp chunk requires current materializer progress');
      }
      pendingEventsForDrain = forcedPendingEventWindow;
      merged = forcedPendingEventWindow;
      maxAcceptedAtMsForDrain = maxAcceptedAtMs(forcedPendingEventWindow);
      drainProgressDotIntervals = addDotsToIntervals(
        existingProgress.appliedDotIntervals,
        forcedPendingEventWindow.map((event) => event.dot),
      );
      drainFrontier = frontierFromIntervals(drainProgressDotIntervals);
      mark(`catchUp.chunk scopedWindow events=${String(forcedPendingEventWindow.length)}`);
    } else if (storeBackedEvents !== null) {
      const ingested = await storeBackedEvents.catchUpFromJsonl(
        join(deps.vaultRoot, '_BAC', 'log'),
      );
      if (
        existingProgress !== null &&
        existingProgress.materializerVersion === MATERIALIZER_VERSION &&
        dotIntervalsHaveGaps(existingProgress.appliedDotIntervals)
      ) {
        for (const event of await deps.eventLog.readMerged()) {
          if (!intervalsContainDot(existingProgress.appliedDotIntervals, event.dot)) {
            storeBackedEvents.ingest(event);
          }
        }
      }
      // Permanent-gap seal pass (default OFF). Runs once per normal drain,
      // AFTER catchUpFromJsonl + the gaps-backfill above (so the store mirrors
      // the log when we probe), BEFORE readSince consumes the frontier.
      let baseIntervalsForDrain = existingProgress?.appliedDotIntervals ?? {};
      if (
        GAP_SEAL_ENABLED() &&
        existingProgress !== null &&
        existingProgress.materializerVersion === MATERIALIZER_VERSION &&
        dotIntervalsHaveGaps(existingProgress.appliedDotIntervals)
      ) {
        baseIntervalsForDrain = await computeSealedIntervals(
          deps.vaultRoot,
          existingProgress.appliedDotIntervals,
          storeBackedEvents.watermark(),
          await deps.eventLog.readMerged(),
          mark,
        );
      }
      // readSince advances by the per-replica FRONTIER (a dense seq
      // watermark). When appliedDotIntervals has a PERMANENT gap (a seq the
      // log skips forever — e.g. a recall-domain seq the connections store
      // never ingests), frontierFromIntervals freezes just below that gap, so
      // readSince re-returns every already-applied event above it on every
      // drain — a runaway full rebuild. Filter by the dot intervals (exactly
      // as the loadedProjectionAccumulatorState sibling path below does) so
      // already-applied events are dropped regardless of where the frontier
      // sits. With no/mismatched progress (cold build) keep everything.
      const storeBackedPending = storeBackedEvents.readSince(effectiveLastFrontier ?? {});
      pendingEventsForDrain =
        existingProgress !== null &&
        existingProgress.materializerVersion === MATERIALIZER_VERSION
          ? storeBackedPending.filter(
              (event) => !intervalsContainDot(existingProgress.appliedDotIntervals, event.dot),
            )
          : storeBackedPending;
      merged = pendingEventsForDrain;
      maxAcceptedAtMsForDrain = storeBackedEvents.maxAcceptedAtMs();
      drainProgressDotIntervals = addDotsToIntervals(
        baseIntervalsForDrain,
        pendingEventsForDrain.map((event) => event.dot),
      );
      drainFrontier = frontierFromIntervals(drainProgressDotIntervals);
      mark(
        `eventStore.catchUp ingested=${String(ingested)} pending=${String(
          pendingEventsForDrain.length,
        )} total=${String(storeBackedEvents.count())}`,
      );
      if (process.env['SIDETRACK_EVENT_STORE_VERIFY'] === '1') {
        const legacy = await deps.eventLog.readMerged();
        const legacySinceFrontier =
          effectiveLastFrontier === undefined
            ? legacy
            : legacy.filter(
                (event) => event.dot.seq > (effectiveLastFrontier[event.dot.replicaId] ?? 0),
              );
        // Mirror the dot-interval filter applied to pendingEventsForDrain so
        // the byte-equivalence check stays meaningful across permanent gaps.
        const legacyPending =
          existingProgress !== null &&
          existingProgress.materializerVersion === MATERIALIZER_VERSION
            ? legacySinceFrontier.filter(
                (event) => !intervalsContainDot(existingProgress.appliedDotIntervals, event.dot),
              )
            : legacySinceFrontier;
        const pendingMatches =
          JSON.stringify(pendingEventsForDrain) === JSON.stringify(legacyPending);
        const maxMatches = maxAcceptedAtMsForDrain === maxAcceptedAtMs(legacy);
        console.warn(
          `[event-store] verify pendingMatch=${String(pendingMatches)} maxMatch=${String(
            maxMatches,
          )} storePending=${String(pendingEventsForDrain.length)} legacyPending=${String(
            legacyPending.length,
          )} storeMax=${String(maxAcceptedAtMsForDrain)} legacyMax=${String(
            maxAcceptedAtMs(legacy),
          )}`,
        );
      }
    } else {
      loadedProjectionAccumulatorState =
        !projectionAccumulatorsInitialized &&
        (await tryLoadProjectionAccumulatorState(existingProgress));
      if (loadedProjectionAccumulatorState && existingProgressMatches) {
        const readFrontier = dotIntervalsHaveGaps(existingProgress.appliedDotIntervals)
          ? frontierFromIntervals(existingProgress.appliedDotIntervals)
          : existingProgress.appliedFrontier;
        const tail = await deps.eventLog.readMergedSince(readFrontier);
        pendingEventsForDrain = sortAcceptedEvents(
          tail.filter(
            (event) => !intervalsContainDot(existingProgress.appliedDotIntervals, event.dot),
          ),
        );
        merged = pendingEventsForDrain;
        maxAcceptedAtMsForDrain = maxAcceptedAtMs(pendingEventsForDrain);
        drainProgressDotIntervals = addDotsToIntervals(
          existingProgress.appliedDotIntervals,
          pendingEventsForDrain.map((event) => event.dot),
        );
        drainFrontier = frontierFromIntervals(drainProgressDotIntervals);
        mark(`readMergedSince events=${String(pendingEventsForDrain.length)}`);
      } else {
        merged = await deps.eventLog.readMerged();
        pendingEventsForDrain =
          effectiveLastFrontier === undefined
            ? merged
            : merged.filter(
                (event) => event.dot.seq > (effectiveLastFrontier[event.dot.replicaId] ?? 0),
              );
        maxAcceptedAtMsForDrain = maxAcceptedAtMs(merged);
        drainFrontier = vectorFromEvents(merged);
        mark(`readMerged events=${String(merged.length)}`);
      }
    }
    const progressForDrainSnapshot = (snapshot: ConnectionsSnapshot): MaterializerProgress =>
      storeBackedEvents === null && drainProgressDotIntervals === null
        ? progressForSnapshot(merged, snapshot)
        : {
            ...EMPTY_PROGRESS(MATERIALIZER_NAME, MATERIALIZER_VERSION),
            appliedDotIntervals: drainProgressDotIntervals ?? {},
            appliedFrontier: drainFrontier,
            snapshotRevisionId: snapshot.snapshotRevision ?? null,
          };
    const writeSnapshotWithDrainProgress = async (
      snapshot: ConnectionsSnapshot,
      dirtyScopesForWrite?: ReadonlySet<Scope>,
    ): Promise<void> => {
      const progress = progressForDrainSnapshot(snapshot);
      await deps.store.writeSnapshotAndProgress(
        snapshot,
        progress,
        dirtyScopesForWrite,
        serializeProjectionAccumulatorState(progress),
      );
      lastFrontier = progress.appliedFrontier;
    };
    await writeForegroundNavigationDelta({
      pendingEventsForDrain,
      merged,
      existingProgress,
      mark,
    });
    // Stage 5.2 W2b/c wiring — first build (or post-catchUp reset)
    // seeds the projection accumulators from the full event log; same
    // cost as the legacy projectUrls(merged) + projectTabSessions(merged)
    // calls below. Subsequent drains reuse the accumulator state that
    // onAccepted has been folding into.
    if (!projectionAccumulatorsInitialized) {
      // Async seeders yield every 500 events so /status (and every
      // other HTTP request) interleaves with the cold-start fold over
      // 10k+ events. Switching to the sync versions reintroduces the
      // 30-second main-thread stall observed against real prod vaults.
      if (storeBackedEvents !== null) {
        urlAccumulator = createEmptyUrlProjectionAccumulator();
        tabSessionAccumulator = createEmptyTabSessionProjectionAccumulator();
        await storeBackedEvents.forEachChunk((chunk) => {
          for (const event of chunk) {
            foldEventIntoUrlProjectionAccumulator(urlAccumulator, event);
            foldEventIntoTabSessionProjectionAccumulator(tabSessionAccumulator, event);
          }
        }, 2000);
      } else {
        urlAccumulator = await seedUrlProjectionAccumulatorAsync(merged);
        tabSessionAccumulator = await seedTabSessionProjectionAccumulatorAsync(merged);
      }
      projectionAccumulatorsInitialized = true;
      mark('projectionAccumulators.seed');
    }
    if (loadedProjectionAccumulatorState || forcedPendingEventWindow !== null) {
      for (const event of [...pendingEventsForDrain].sort(compareAcceptedEventOrder)) {
        foldEventIntoUrlProjectionAccumulator(urlAccumulator, event);
        foldEventIntoTabSessionProjectionAccumulator(tabSessionAccumulator, event);
      }
      mark(`projectionAccumulators.resumeFold events=${String(pendingEventsForDrain.length)}`);
    }
    const vault = await readVaultStores(deps.vaultRoot);
    mark('readVaultStores');
    await yieldToEventLoop();
    // Timeline days. Default: read from the connections materializer's
    // own persistent SQLite fact store after catching it up from this
    // drain's merged log. This deliberately does NOT read the shared
    // TimelineStore, whose writer can race this materializer's drain.
    const timelineFactStore = timelineFactsStoreEnabled() ? await ensureTimelineFactStore() : null;
    let rawTimelineDays: readonly TimelineDayProjectionWithDimensions[];
    if (timelineFactStore !== null) {
      await timelineFactStore.catchUp(
        storeBackedEvents === null || forcedPendingEventWindow !== null
          ? merged
          : storeBackedEvents.readSince(timelineFactStore.watermark()),
      );
      rawTimelineDays = timelineFactStore.readTimelineDays();
      mark(`timelineFactStore.readTimelineDays days=${String(rawTimelineDays.length)}`);
      if (process.env['SIDETRACK_TIMELINE_FACTS_VERIFY'] === '1') {
        const legacy = buildTimelineDays(merged);
        const matches = JSON.stringify(legacy) === JSON.stringify(rawTimelineDays);
        console.warn(
          `[timeline-facts] verify match=${String(matches)} store=${String(
            rawTimelineDays.length,
          )} legacy=${String(legacy.length)}`,
        );
      }
    } else {
      rawTimelineDays = buildTimelineDays(merged);
      mark(`buildTimelineDays days=${String(rawTimelineDays.length)}`);
    }
    await yieldToEventLoop();
    // Engagement classifier inputs. Default: read from the persistent
    // SQLite fact store (byte-equivalent to the legacy full-walk; see
    // engagementFactsStore.test.ts), keeping the store current via an
    // idempotent, watermark-gated catchUp over the IVM delta. The store
    // decouples this derivation from the full AcceptedEvent[] retained in
    // mergedMemo. Kill-switch falls back to the legacy in-memory walk.
    let engagementInputs: ReturnType<typeof buildEngagementClassifierInputs>;
    const factStore = engagementFactsStoreEnabled() ? await ensureEngagementFactStore() : null;
    if (factStore !== null) {
      // Always catch up from the full merged set, filtered by the fact
      // store's OWN persisted watermark (not the materializer frontier).
      // pendingEventsForDrain is frontier-based and can permanently omit
      // SELECTION_* / ENGAGEMENT_SESSION_AGGREGATED events that advanced
      // progress without a drain (content-only / non-graph-handle paths).
      // The seq-filter over merged is O(n) integer compares + idempotent
      // inserts (~0 on a warm store) — cheap vs the legacy 3x object walk.
      await factStore.catchUp(
        storeBackedEvents === null || forcedPendingEventWindow !== null
          ? merged
          : storeBackedEvents.readSince(factStore.watermark()),
      );
      engagementInputs = factStore.readClassifierInputs(rawTimelineDays);
      mark(`engagementFactStore.readClassifierInputs inputs=${String(engagementInputs.length)}`);
      // Drift check: compare against the legacy full-walk on real data
      // (off by default; opt-in for verification / ongoing drift alerts).
      if (process.env['SIDETRACK_ENGAGEMENT_FACTS_VERIFY'] === '1') {
        const legacy = buildEngagementClassifierInputs(merged, rawTimelineDays);
        const matches = JSON.stringify(legacy) === JSON.stringify(engagementInputs);
        console.warn(
          `[engagement-facts] verify match=${String(matches)} store=${String(
            engagementInputs.length,
          )} legacy=${String(legacy.length)}`,
        );
      }
    } else {
      engagementInputs = buildEngagementClassifierInputs(merged, rawTimelineDays);
      mark(`engagementClassifier (legacy) inputs=${String(engagementInputs.length)}`);
    }
    // Stage 5.2 W6 per-pass skip — when no engagement-touching keys
    // arrived since last drain AND a cached revision exists, reuse it
    // (skips the classifier + putRevision; inputs are still needed for
    // enrichTimelineDaysWithEngagement below).
    const engagementTouchingKey = buildKeys.some(
      (k) => k.kind === 'engagementVisit' || k.kind === 'rankerLabels',
    );
    let engagementClassRevision: ReturnType<typeof buildEngagementClassRevision>;
    if (!engagementTouchingKey && lastEngagementClassRevision !== undefined) {
      engagementClassRevision = lastEngagementClassRevision;
      mark(`engagementClassifier skip (w6 reuse) inputs=${String(engagementInputs.length)}`);
    } else {
      engagementClassRevision = buildEngagementClassRevision(engagementInputs, {
        producedAt: maxAcceptedAtMsForDrain,
      });
      mark(`engagementClassifier revision inputs=${String(engagementInputs.length)}`);
      await engagementClassStore.putRevision(engagementClassRevision);
      mark('engagementClassStore.putRevision');
      lastEngagementClassRevision = engagementClassRevision;
    }
    await yieldToEventLoop();
    const timelineDays = enrichTimelineDaysWithEngagement(rawTimelineDays, engagementInputs);
    mark('enrichTimelineDays');
    await yieldToEventLoop();
    const dirtyScopes = invalidationKeysToScopes(buildKeys);
    const previousSnapshotForRanker = await deps.store.readCurrent();
    // Stage 5.2 W3 — skip-gate the most expensive pass. The revisionId
    // is a hash over (model + threshold + topK + gate + per-visit
    // corpus/focus). If the same set of visits has already been
    // processed, the on-disk revision is reusable byte-for-byte — no
    // need to re-embed.
    const similarityEntries = timelineDays.flatMap((day) => day.entries);
    // PR #141 — resolve the similarity config once so the same
    // (threshold / topK / engagementGateMs / lexical fallback) values
    // feed both the revision id + the build call. Honors env overrides:
    // SIDETRACK_SIMILARITY_{THRESHOLD,MIN_ENGAGEMENT_MS,TOP_K} +
    // SIDETRACK_SIMILARITY_LEXICAL_{THRESHOLD,FALLBACK_ENABLED}.
    const similarityConfig: EffectiveVisitSimilarityConfig = resolveVisitSimilarityConfig();
    const activeSimilarityEntries = similarityEntries.filter(
      (entry) => focusedWindowMsFromEntry(entry) >= similarityConfig.engagementGateMs,
    );
    const similarityEligibleVisitIds = new Set(activeSimilarityEntries.map(visitKeyForVisitEntry));
    const similarityEligibleCount = similarityEligibleVisitIds.size;
    const similarityPairBudget = Math.max(
      0,
      (similarityEligibleCount * (similarityEligibleCount - 1)) / 2,
    );
    const pendingTimelineVisitIds = new Set(
      pendingEventsForDrain
        .filter(
          (event) =>
            event.type === BROWSER_TIMELINE_OBSERVED &&
            isBrowserTimelineObservedPayload(event.payload),
        )
        .map((event) =>
          normalizeVisitUrl(
            (event.payload as BrowserTimelineObservedPayload).canonicalUrl ??
              (event.payload as BrowserTimelineObservedPayload).url,
          ),
        )
        .filter((visitKey) => visitKey.length > 0),
    );
    const persistentHnswSimilarityMode = incrementalSimilarityEnabled();
    let hnswDimensionMismatchRequiresFullRebuild = false;
    let loadedHnswStoreForGate: LoadedSimilarityHnswStore | null = null;
    if (persistentHnswSimilarityMode) {
      try {
        loadedHnswStoreForGate = await hnswSimilarityStore.ensureLoaded(
          deps.vaultRoot,
          RECALL_MODEL.embeddingDim,
        );
      } catch (err) {
        if (!isHnswDimensionMismatchError(err)) throw err;
        hnswDimensionMismatchRequiresFullRebuild = true;
        await resetHnswSimilarityFiles();
        loadedHnswStoreForGate = await hnswSimilarityStore.ensureLoaded(
          deps.vaultRoot,
          RECALL_MODEL.embeddingDim,
        );
      }
    }
    if (loadedHnswStoreForGate !== null) loadedHnswSimilarityStore = loadedHnswStoreForGate;
    const knownHnswVisitIds = persistentHnswSimilarityMode
      ? ((await loadedHnswStoreForGate?.knownLabels()) ?? new Set<string>())
      : new Set<string>();
    const staleHnswVisitIds = persistentHnswSimilarityMode
      ? new Set(
          [...knownHnswVisitIds].filter(
            (visitId) =>
              pendingTimelineVisitIds.has(visitId) && !similarityEligibleVisitIds.has(visitId),
          ),
        )
      : new Set<string>();
    const hnswActiveVisitIdsForGate = persistentHnswSimilarityMode
      ? new Set(
          [...knownHnswVisitIds, ...similarityEligibleVisitIds].filter(
            (visitId) => !staleHnswVisitIds.has(visitId),
          ),
        )
      : new Set<string>();
    const hnswStoreVisitCount = loadedHnswStoreForGate?.elementCount() ?? 0;
    const hnswFullRebuild =
      persistentHnswSimilarityMode &&
      (hnswDimensionMismatchRequiresFullRebuild ||
        (existingProgress !== null &&
          existingProgress.materializerVersion !== MATERIALIZER_VERSION) ||
        (loadedHnswStoreForGate?.recoveredFromCorruption() ?? false) ||
        hnswStoreRemovalDriftRequiresFullRebuild(
          hnswStoreVisitCount,
          hnswActiveVisitIdsForGate.size,
        ));
    const fullPageEvidenceEnsure =
      previousSnapshotForRanker === null ||
      existingProgress === null ||
      existingProgress.materializerVersion !== MATERIALIZER_VERSION;
    const hnswTouchedVisitIds = persistentHnswSimilarityMode
      ? new Set(
          [...similarityEligibleVisitIds].filter((visitId) => !knownHnswVisitIds.has(visitId)),
        )
      : new Set<string>();
    const hnswReconcileVisitIds = persistentHnswSimilarityMode
      ? new Set(
          [...pendingTimelineVisitIds].filter((visitId) => similarityEligibleVisitIds.has(visitId)),
        )
      : new Set<string>();
    const hnswRequiresFullCorpusEdgeRequery =
      persistentHnswSimilarityMode &&
      !hnswFullRebuild &&
      hnswActiveVisitIdsForGate.size === similarityEligibleVisitIds.size &&
      (hnswTouchedVisitIds.size > 0 ||
        hnswReconcileVisitIds.size > 0 ||
        staleHnswVisitIds.size > 0);
    const hnswScopedDeltaVisitIds = persistentHnswSimilarityMode
      ? hnswRequiresFullCorpusEdgeRequery
        ? new Set([...hnswActiveVisitIdsForGate, ...staleHnswVisitIds])
        : new Set([...hnswTouchedVisitIds, ...hnswReconcileVisitIds])
      : new Set<string>();
    const entriesToEnsureForPageEvidence = fullPageEvidenceEnsure
      ? similarityEntries
      : similarityEntries.filter((entry) =>
          pendingTimelineVisitIds.has(timelineEntryVisitKey(entry)),
        );
    const pendingHasSearchVisit = pendingEventsForDrain.some(pendingEventIsSearchTimelineVisit);
    const canAttemptBoundedScopedDelta =
      !fullPageEvidenceEnsure &&
      persistentHnswSimilarityMode &&
      previousSnapshotForRanker !== null &&
      existingProgress !== null &&
      existingProgress.materializerVersion === MATERIALIZER_VERSION &&
      deps.store.replaceScopeRows !== undefined &&
      pendingEventsForDrain.length > 0 &&
      pendingEventsForDrain.every(isScopedTimelineDeltaEvent) &&
      !pendingHasSearchVisit &&
      !hnswFullRebuild;
    const pageEvidenceByCanonicalUrlMutable = new Map<string, PageEvidenceRecord>();
    const pageEvidenceByCanonicalUrl: ReadonlyMap<string, PageEvidenceRecord> =
      pageEvidenceByCanonicalUrlMutable;
    const entriesForVisitKeys = (
      visitKeys: ReadonlySet<string>,
    ): readonly TimelineEntryWithDimensions[] => {
      if (visitKeys.size === 0) return [];
      const seen = new Set<string>();
      const out: TimelineEntryWithDimensions[] = [];
      for (const entry of similarityEntries) {
        const visitKey = timelineEntryVisitKey(entry);
        if (!visitKeys.has(visitKey) || seen.has(visitKey)) continue;
        seen.add(visitKey);
        out.push(entry);
      }
      return out;
    };
    const loadPageEvidenceForRawUrls = async (rawUrls: readonly string[]): Promise<number> => {
      const uniqueRawUrls: string[] = [];
      const seen = new Set<string>();
      for (const rawUrl of rawUrls) {
        const canonicalUrl = canonicalizeEvidenceUrl(rawUrl);
        if (seen.has(canonicalUrl)) continue;
        seen.add(canonicalUrl);
        uniqueRawUrls.push(rawUrl);
      }
      const urlsToRead = uniqueRawUrls.filter(
        (rawUrl) => !pageEvidenceRecordCache.has(canonicalizeEvidenceUrl(rawUrl)),
      );
      for (const [canonicalUrl, record] of await readPageEvidenceMap(deps.vaultRoot, urlsToRead)) {
        pageEvidenceRecordCache.set(canonicalUrl, record);
      }
      for (const rawUrl of uniqueRawUrls) {
        const canonicalUrl = canonicalizeEvidenceUrl(rawUrl);
        const record = pageEvidenceRecordCache.get(canonicalUrl);
        if (record !== undefined) pageEvidenceByCanonicalUrlMutable.set(canonicalUrl, record);
      }
      return urlsToRead.length;
    };
    const loadPageEvidenceForEntries = async (
      entries: readonly TimelineEntryWithDimensions[],
    ): Promise<number> =>
      loadPageEvidenceForRawUrls(entries.map((entry) => entry.canonicalUrl ?? entry.url));
    if (fullPageEvidenceEnsure) {
      const ensured = await ensurePageEvidenceForTimelineEntries(deps.vaultRoot, similarityEntries);
      pageEvidenceRecordCache.clear();
      for (const [canonicalUrl, record] of ensured) {
        pageEvidenceRecordCache.set(canonicalUrl, record);
        pageEvidenceByCanonicalUrlMutable.set(canonicalUrl, record);
      }
    } else {
      const initialEvidenceEntries = canAttemptBoundedScopedDelta
        ? entriesForVisitKeys(
            new Set([
              ...pendingTimelineVisitIds,
              ...hnswTouchedVisitIds,
              ...hnswReconcileVisitIds,
              ...dirtyScopes.filter((scope) => scope.kind === 'url').map((scope) => scope.id),
            ]),
          )
        : similarityEntries;
      await loadPageEvidenceForEntries(initialEvidenceEntries);
      const ensured = await ensurePageEvidenceForTimelineEntries(
        deps.vaultRoot,
        entriesToEnsureForPageEvidence,
        { rebuildManifestAfterWrite: false },
      );
      for (const [canonicalUrl, record] of ensured) {
        pageEvidenceRecordCache.set(canonicalUrl, record);
        pageEvidenceByCanonicalUrlMutable.set(canonicalUrl, record);
      }
    }
    mark(
      `pageEvidence.ensure records=${String(pageEvidenceByCanonicalUrl.size)} ensured=${String(entriesToEnsureForPageEvidence.length)} full=${String(fullPageEvidenceEnsure)} bounded=${String(canAttemptBoundedScopedDelta)}`,
    );
    let pageEvidenceVectorsByVectorId:
      | Awaited<ReturnType<typeof readPageEvidenceVectorMap>>
      | undefined;
    let pageContentChunksByCanonicalUrl:
      | Awaited<ReturnType<typeof readPageContentChunksForCanonicalUrls>>
      | undefined;
    const readPageEvidenceVectorsForDrain = async (): Promise<
      Awaited<ReturnType<typeof readPageEvidenceVectorMap>>
    > => {
      if (pageEvidenceVectorsByVectorId === undefined) {
        pageEvidenceVectorsByVectorId = await readPageEvidenceVectorMap(
          deps.vaultRoot,
          pageEvidenceByCanonicalUrl.values(),
        );
        mark(`pageEvidence.vectorMapRead vectors=${String(pageEvidenceVectorsByVectorId.size)}`);
      }
      return pageEvidenceVectorsByVectorId;
    };
    const readSimilarityEvidenceExtras = async (): Promise<{
      readonly evidenceVectorsByVectorId: Awaited<ReturnType<typeof readPageEvidenceVectorMap>>;
      readonly pageContentChunksByCanonicalUrl: Awaited<
        ReturnType<typeof readPageContentChunksForCanonicalUrls>
      >;
    }> => {
      const evidenceVectorsByVectorId = await readPageEvidenceVectorsForDrain();
      if (pageContentChunksByCanonicalUrl === undefined) {
        pageContentChunksByCanonicalUrl = await readPageContentChunksForCanonicalUrls(
          deps.vaultRoot,
          [...pageEvidenceByCanonicalUrl.keys()],
        );
        mark(
          `pageEvidence.chunkRead indexedChunkPages=${String(
            pageContentChunksByCanonicalUrl.size,
          )}`,
        );
      }
      return { evidenceVectorsByVectorId, pageContentChunksByCanonicalUrl };
    };
    if (!persistentHnswSimilarityMode) await readSimilarityEvidenceExtras();
    const expectedSimilarityRevisionId = computeVisitSimilarityRevisionId(similarityEntries, {
      ...similarityConfig,
      evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
      ...(pageEvidenceVectorsByVectorId === undefined
        ? {}
        : { evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId }),
      ...(pageContentChunksByCanonicalUrl === undefined ? {} : { pageContentChunksByCanonicalUrl }),
    });
    const cachedSimilarityRevision = persistentHnswSimilarityMode
      ? null
      : await readVisitSimilarityRevision(deps.vaultRoot, expectedSimilarityRevisionId);
    mark(
      `similarity probe entries=${String(similarityEntries.length)} cacheHit=${String(cachedSimilarityRevision !== null)}`,
    );
    const similarityStartedAtMs = Date.now();
    // Stage 5.2 W3 fast path — when SIDETRACK_CONNECTIONS_HOT_SIMILARITY=1
    // AND the embedder warmth + corpus budget passes decideHotPathEmbed,
    // skip the legacy pairwise rebuild + ANN ranker and use the
    // IncrementalVisitSimilarityIndex for cosine-only top-K. The
    // resulting revisionId carries a `:incremental` suffix so on-disk
    // cached revisions stay distinct from the legacy hybrid path.
    const hotSimilarityMode = !persistentHnswSimilarityMode && false;
    const hotSimCorpusSize = incrementalSimilarityIndex.size();
    const hotSimilarityDecision = hotSimilarityMode
      ? decideHotPathEmbed(embedderWarmthTracker.snapshot(hotSimCorpusSize))
      : { shouldEmbedOnHotPath: false as const };
    // U2 — captured for HotPathDiagnostics (no extra compute; locals
    // the drain already produces).
    let usedHotSimilarityPath = false;
    let hotSimNewEmbedded: number | null = null;
    let visitSimilarity: VisitSimilarityRevision;
    if (persistentHnswSimilarityMode) {
      const touchedVisitIds = hnswTouchedVisitIds;
      const reconcileVisitIds = hnswReconcileVisitIds;
      usedHotSimilarityPath = true;
      hotSimNewEmbedded = hnswFullRebuild ? similarityEligibleCount : touchedVisitIds.size;
      mark(`buildVisitSimilarityHnsw.start entries=${String(similarityEntries.length)}`);
      try {
        visitSimilarity = await buildHnswVisitSimilarity({
          entries: similarityEntries,
          revisionId: expectedSimilarityRevisionId,
          config: similarityConfig,
          touchedVisitIds,
          reconcileVisitIds,
          removalCandidateVisitIds: pendingTimelineVisitIds,
          fullRebuild: hnswFullRebuild,
          previousSnapshot: previousSnapshotForRanker,
          embed: deps.embed ?? defaultEmbed,
          evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
        });
        mark(
          `buildVisitSimilarityHnsw full=${String(hnswFullRebuild)} touched=${String(touchedVisitIds.size)} edges=${String(visitSimilarity.edges.length)}`,
        );
      } catch (err) {
        mark(
          `buildVisitSimilarityHnsw.fallback error=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        const extras = await readSimilarityEvidenceExtras();
        visitSimilarity = await buildVisitSimilarity(
          similarityEntries,
          deps.embed ?? defaultEmbed,
          {
            ...similarityConfig,
            evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
            evidenceVectorsByVectorId: extras.evidenceVectorsByVectorId,
            pageContentChunksByCanonicalUrl: extras.pageContentChunksByCanonicalUrl,
          },
        );
      }
    } else if (cachedSimilarityRevision !== null) {
      // U2 — a valid cached revision means the W3 skip-gate id (a pure
      // function of inputs+config) matched: the inputs are unchanged,
      // so the cached revision IS the correct output. Reuse it
      // unconditionally — even when the hot decision says "embed".
      // The pre-U2 `&& !shouldEmbedOnHotPath` qualifier let default-on
      // hot mode bypass the cache and re-embed on UNCHANGED inputs
      // (the legacy drain never populates the in-memory incremental
      // index, which also does not survive child-per-drain), flipping
      // the revisionId (`:incremental` suffix) every drain and
      // cascading to defeat the topic + shadow skip-gates — i.e. the
      // exact per-drain re-embed/rebuild the connections CPU work
      // removed. The hot path still engages on a genuine cache miss
      // (new/changed inputs) where amortised embedding is the win.
      visitSimilarity = cachedSimilarityRevision;
    } else if (hotSimilarityDecision.shouldEmbedOnHotPath) {
      // Embed only entries not yet in the index. The legacy path embeds
      // every entry every drain; the fast path amortises across drains.
      const newEntries = similarityEntries.filter(
        (entry) => !incrementalSimilarityIndex.has(visitKeyForVisitEntry(entry)),
      );
      usedHotSimilarityPath = true;
      hotSimNewEmbedded = newEntries.length;
      const embeddingsByVisitKey = new Map<string, Float32Array>();
      if (newEntries.length > 0) {
        const texts = newEntries.map(
          (e) => `passage: ${corpusForVisitEntry(e, pageEvidenceByCanonicalUrl)}`,
        );
        try {
          const embedded = await (deps.embed ?? defaultEmbed)(texts);
          for (let i = 0; i < newEntries.length; i += 1) {
            const entry = newEntries[i];
            const embedding = embedded[i];
            if (entry !== undefined && embedding !== undefined) {
              embeddingsByVisitKey.set(visitKeyForVisitEntry(entry), embedding);
            }
          }
        } catch (error) {
          // Fast-path embed failure: log + fall back to legacy path.
          console.warn(
            `[connections] W3 fast-path embed failed; falling back: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          const extras = await readSimilarityEvidenceExtras();
          visitSimilarity = await buildVisitSimilarity(
            similarityEntries,
            deps.embed ?? defaultEmbed,
            {
              ...similarityConfig,
              evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
              evidenceVectorsByVectorId: extras.evidenceVectorsByVectorId,
              pageContentChunksByCanonicalUrl: extras.pageContentChunksByCanonicalUrl,
            },
          );
        }
      }
      const extras = await readSimilarityEvidenceExtras();
      visitSimilarity ??= buildVisitSimilarityIncremental({
        index: incrementalSimilarityIndex,
        entries: similarityEntries,
        embeddingsByVisitKey,
        options: {
          threshold: VISIT_SIMILARITY_DEFAULT_THRESHOLD,
          topK: VISIT_SIMILARITY_DEFAULT_TOP_K,
          evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
          evidenceVectorsByVectorId: extras.evidenceVectorsByVectorId,
          pageContentChunksByCanonicalUrl: extras.pageContentChunksByCanonicalUrl,
        },
      });
      mark(
        `buildVisitSimilarityIncremental pairs=${String(similarityPairBudget)} newEmbedded=${String(newEntries.length)} indexSize=${String(incrementalSimilarityIndex.size())}`,
      );
    } else {
      // Legacy path with PR #141's resolved similarityConfig
      // (threshold / topK / engagementGateMs / lexical fallback).
      const extras = await readSimilarityEvidenceExtras();
      visitSimilarity = await buildVisitSimilarity(similarityEntries, deps.embed ?? defaultEmbed, {
        ...similarityConfig,
        evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
        evidenceVectorsByVectorId: extras.evidenceVectorsByVectorId,
        pageContentChunksByCanonicalUrl: extras.pageContentChunksByCanonicalUrl,
      });
      mark(`buildVisitSimilarity pairs=${String(similarityPairBudget)}`);
    }
    // U2 — similarity-stage wall time for HotPathDiagnostics (the
    // visitSimilarity revision is finalized here).
    const hotSimRuntimeMs = Date.now() - similarityStartedAtMs;
    if (
      persistentHnswSimilarityMode ||
      (cachedSimilarityRevision === null && !hotSimilarityDecision.shouldEmbedOnHotPath)
    ) {
      // Stage 5.2 W3 wiring — record embedder latency only on cache miss
      // (cache hits don't exercise the embedder). Divide by entry count
      // for a per-embed proxy when entries > 0; treat the full pass as
      // a single embed event when entries = 0.
      const elapsedMs = Date.now() - similarityStartedAtMs;
      const perEmbedMs =
        similarityEntries.length > 0 ? elapsedMs / similarityEntries.length : elapsedMs;
      embedderWarmthTracker.recordEmbed(perEmbedMs);
      await writeVisitSimilarityRevision(deps.vaultRoot, visitSimilarity);
      mark('writeVisitSimilarityRevision');
    }
    // Stage 5.2 W4 wiring — fold the current similarity edges into the
    // incremental topic accumulator. On a revision-id flip (re-embedding
    // shifted relative distances) we drop edges that disappeared from
    // the new revision via removeEdge so the accumulator's union-find
    // stays accurate.
    if (lastAcceptedSimilarityRevisionId !== visitSimilarity.revisionId) {
      // Stage 5.2 W4 — revision-flip diff. When the similarity producer
      // emits a new revisionId, edges present in the old revision but
      // missing from the new one route through removeEdge so the
      // union-find stays consistent. This is the "removal-aware
      // fallback" from the design doc, now actually wired (the
      // accumulator's getEdges() exposes the ledger for diffing).
      const prevSimilarityEdges = topicAccumulator
        .getEdges()
        .filter((edge) => edge.source === 'similarity');
      const newSimilarityPairs = new Set<string>(
        visitSimilarity.edges.map((e) =>
          e.fromVisitKey < e.toVisitKey
            ? `${e.fromVisitKey}\u0000${e.toVisitKey}`
            : `${e.toVisitKey}\u0000${e.fromVisitKey}`,
        ),
      );
      let removedCount = 0;
      for (const edge of prevSimilarityEdges) {
        const sig = edge.a < edge.b ? `${edge.a}\u0000${edge.b}` : `${edge.b}\u0000${edge.a}`;
        if (!newSimilarityPairs.has(sig)) {
          topicAccumulator.removeEdge(edge.a, edge.b);
          removedCount += 1;
        }
      }
      mark(`topicAccumulator.revisionFlip removed=${String(removedCount)}`);
      lastAcceptedSimilarityRevisionId = visitSimilarity.revisionId;
    }
    for (const entry of similarityEntries) {
      // Map TimelineEntry → TopicVisit. focusedWindowMs is read from
      // engagement dimensions; engagement gate applied by caller path —
      // we just need a deterministic accumulator-friendly shape.
      const canonicalUrl = entry.canonicalUrl ?? entry.url;
      if (typeof canonicalUrl !== 'string' || canonicalUrl.length === 0) continue;
      topicAccumulator.addVisit({
        canonicalUrl,
        ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
        focusedWindowMs: 60_000, // sentinel — accumulator doesn't gate, builder does
        firstObservedAt: entry.firstSeenAt,
        lastObservedAt: entry.lastSeenAt,
      });
    }
    const topicCosineThreshold = resolveTopicCosineThreshold();
    for (const edge of visitSimilarity.edges) {
      topicAccumulator.addSimilarityEdge(edge, topicCosineThreshold);
    }
    mark('topicAccumulator.fold');
    const previousTopicRevision = await topicRevisionStore.readActiveRevision();
    mark('readActiveTopicRevision');
    await yieldToEventLoop();
    // Stage 5.2 W2b/c wiring — derive the URL + tabSession projections
    // from the long-lived accumulators. PR #141's thread→URL attribution
    // propagation runs on the accumulator's records before deriving so
    // the synthetic `source: 'thread'` attribution survives.
    applyThreadAttributionsToAccumulator(urlAccumulator, vault.threads);
    const urlProjection = urlProjectionFromAccumulator(urlAccumulator);
    const tabSessionProjection = tabSessionProjectionFromAccumulator(tabSessionAccumulator);
    // Stage 5.2 W4 — topic-revision skip-gate. The TopicRevision id is
    // derived from (visitSimilarityRevisionId + cosineThreshold +
    // algorithmVersion). PR #141 also threads userAssertedRelations
    // through the builder so workstream/thread membership propagates as
    // topic-cluster bias.
    const topicVisits = timelineDays.flatMap((day) => day.entries.map(topicVisitFromEntry));
    const userAssertedRelations = deriveUserAssertedRelations({
      urlProjection,
      tabSessionProjection,
      knownCanonicalUrls: knownCanonicalUrlsFor(topicVisits),
    });
    const expectedTopicRevisionId = await createTopicRevisionId({
      visitSimilarityRevisionId: visitSimilarity.revisionId,
      cosineThreshold: topicCosineThreshold,
      algorithmVersion: topicRevisionAlgorithm,
    });
    // Stage 5.2 W4 fast path — when SIDETRACK_CONNECTIONS_HOT_TOPICS=1
    // AND the topic accumulator has at least one cluster, use
    // buildTopicRevisionFromAccumulator (byte-equal output modulo
    // producedAt with buildSelectedTopicRevision over the same inputs).
    // The accumulator has been kept in sync with the similarity edges
    // above via the revision-flip diff + per-drain addSimilarityEdge.
    // PR #141's userAssertedRelations are still passed when falling
    // through to the legacy builder.
    const hotTopicsMode = hotTopicsModeEnabled();
    const topicComponentCount = (await topicAccumulator.getComponents()).length;
    // U2 — the accumulator fast path is test-asserted byte-equal to
    // the UNION-FIND builder only. When a different topic algorithm is
    // explicitly selected (HDBSCAN / idf-rkn via deps), it must NOT be
    // silently overridden by the accumulator, so gate the fast path on
    // the selected algorithm being the union-find baseline (the
    // default — so default-on still engages it for the normal case).
    const useTopicAccumulatorFastPath =
      hotTopicsMode &&
      topicRevisionAlgorithm === TOPIC_UNION_FIND_REVISION_KEY &&
      topicComponentCount > 0;
    const topicBuildStartedAtMs = Date.now();
    if (previousTopicRevision !== null && lastTopicRunSimilarityRevisionId === undefined) {
      lastTopicRunSimilarityRevisionId = previousTopicRevision.visitSimilarityRevisionId;
      lastTopicRunAtMs = Date.now();
    }
    topicDrainsSinceLastRun += 1;
    const topicSimilarityChanged = lastTopicRunSimilarityRevisionId !== visitSimilarity.revisionId;
    const topicCadenceDue =
      topicDrainsSinceLastRun >= resolveTopicEveryDrains() ||
      Date.now() - lastTopicRunAtMs >= resolveTopicEveryMs();
    const forcePendingTopicRecompute = pendingTopicRecompute && topicSimilarityChanged;
    // Full-timeline topic source (default OFF; see topicFullTimelineSourceEnabled).
    // `topicVisits` above is derived from this drain's window — on a settled/
    // incremental drain that is a tiny slice (and older visits carry no
    // engagement), so a recompute would shrink/wipe the revision. When enabled
    // and a recompute is imminent (non-catch-up cadence), re-derive the visit set
    // from the FULL event log WITH FULL engagement (so eligibleVisits' focused-
    // window gate sees every engaged visit), exactly like the cold boot. Cadence-
    // gated so normal scoped drains pay nothing.
    const topicRecomputeImminent =
      previousTopicRevision === null ||
      (!requireScopedTimelineDeltaForDrain &&
        topicSimilarityChanged &&
        (topicCadenceDue || forcePendingTopicRecompute));
    let topicVisitsForBuild = topicVisits;
    if (topicFullTimelineSourceEnabled() && topicRecomputeImminent) {
      const fullTopicEvents = await deps.eventLog.readMerged();
      const fullTopicTimeline = buildTimelineDays(fullTopicEvents);
      const fullTopicEngagement = buildEngagementClassifierInputs(
        fullTopicEvents,
        fullTopicTimeline,
      );
      topicVisitsForBuild = enrichTimelineDaysWithEngagement(
        fullTopicTimeline,
        fullTopicEngagement,
      ).flatMap((day) => day.entries.map(topicVisitFromEntry));
      mark(
        `topicVisitsForBuild full=${String(topicVisitsForBuild.length)} window=${String(topicVisits.length)}`,
      );
    }
    // Never recompute topics during the catch-up drain when a revision already
    // exists to preserve. The catch-up serves a SCOPED window — timelineDays is
    // empty (buildTimelineDays days=0), so `topicVisits` is empty and any
    // leiden/union-find build would produce 0 topics and overwrite the active
    // revision via putActiveRevision (a topic wipe). Each catch-up chunk also
    // writes a fresh visitSimilarity revision (touched=0 but new id), so
    // topicSimilarityChanged stays true and the cadence eventually fires
    // mid-catch-up — exactly the path that corrupts. Full topic recompute
    // belongs to a real (non-catch-up) drain that has the whole timeline. When
    // there is NO previous revision, building from whatever is available is
    // harmless (0 → 0) and the next real drain produces the real clusters.
    const shouldRunTopicRevision =
      previousTopicRevision === null ||
      (!requireScopedTimelineDeltaForDrain &&
        (!topicFullTimelineSourceEnabled() || topicVisitsForBuild.length > 0) &&
        topicSimilarityChanged &&
        (topicCadenceDue || forcePendingTopicRecompute));
    let topicRevision;
    if (!shouldRunTopicRevision && previousTopicRevision !== null) {
      // Topic clustering (especially leiden-cpm) is global rather than
      // cheaply IVM-able. During heavy ingest we accept topics being a
      // few minutes stale; repeatedly freezing the graph for ~30 seconds
      // is worse UX than serving the previous topic revision.
      mark(
        `topicRevision cadenceSkip drains=${String(topicDrainsSinceLastRun)} similarityChanged=${String(topicSimilarityChanged)}`,
      );
      // Incremental topic membership (default OFF): instead of serving the
      // frozen revision verbatim, overlay newly-eligible visits onto their
      // nearest existing leiden cluster as SECONDARY affiliations (no leiden
      // pass). The overlay accumulates onto the previous served revision; the
      // next full leiden (on cadence) overwrites the active slot and
      // re-converges with zero churn.
      const useIncremental =
        incrementalTopicMembershipEnabled() &&
        topicSimilarityChanged &&
        resolveServedTopicProducer() === 'leiden-cpm' &&
        previousTopicRevision.algorithmVersion === TOPIC_LEIDEN_CPM_REVISION_KEY;
      if (!useIncremental) {
        topicRevision = previousTopicRevision;
        // Force a full recompute on the next similarity-changing drain so
        // topics don't stay frozen for the whole cadence window — but ONLY
        // when the overlay feature is OFF. With the overlay on, it provides
        // responsiveness and the natural cadence handles the full rebuild;
        // forcing here would pre-empt/wipe the overlay on the next drain.
        if (topicSimilarityChanged && !incrementalTopicMembershipEnabled()) {
          pendingTopicRecompute = true;
        }
      } else {
        // Candidate pool = every embedded (similarity-eligible) visit, read
        // from the persisted HNSW labels — available on EVERY drain, unlike
        // the full topicVisits list which is empty on scoped/engagement-only
        // drains. assignIncrementalMembership filters out visits already
        // clustered (primary OR secondary in the accumulated previous
        // revision), so the work is O(unclustered·k): a one-time catch-up
        // after each full leiden, then only the per-drain-new embeds. The
        // augmented revision accumulates onto previousTopicRevision; the next
        // full leiden resets the active slot (re-converges, no churn).
        const candidateCanonicalUrls =
          loadedHnswSimilarityStore !== null
            ? [...(await loadedHnswSimilarityStore.knownLabels())]
            : [];
        const augmented = await assignIncrementalMembership({
          baseRevision: previousTopicRevision,
          candidateCanonicalUrls,
          edges: visitSimilarity.edges,
          hnswStore: loadedHnswSimilarityStore,
          cosineThreshold: LEIDEN_CPM_COSINE_THRESHOLD,
        });
        const sumSecondaries = (rev: typeof augmented): number =>
          rev.topics.reduce((sum, topic) => sum + (topic.secondaryAffiliations?.length ?? 0), 0);
        const placed = sumSecondaries(augmented) - sumSecondaries(previousTopicRevision);
        mark(
          `incrementalTopicMembership candidates=${String(candidateCanonicalUrls.length)} placed=${String(placed)} edges=${String(visitSimilarity.edges.length)}`,
        );
        if (augmented.revisionId === previousTopicRevision.revisionId) {
          // Unchanged overlay — preserve object identity so topicSame stays
          // true and the cheap scoped-delta snapshot path is not disabled.
          topicRevision = previousTopicRevision;
        } else {
          // Persist the overlay to the active slot always. During the boot
          // catch-up the scoped delta is REQUIRED (serving a changed revision
          // flips topicSame=false and throws), so serve the previous revision
          // THIS drain; the first post-catch-up drain then detects the active
          // overlay via topicSnapshotStale and full-rebuilds to render it.
          await topicRevisionStore.putActiveRevision(augmented);
          topicRevision = requireScopedTimelineDeltaForDrain ? previousTopicRevision : augmented;
        }
        // Do NOT set pendingTopicRecompute here: the overlay already provides
        // responsiveness, so the next full leiden fires on the natural cadence
        // rather than the very next drain (which would immediately wipe it).
      }
    } else if (
      previousTopicRevision !== null &&
      previousTopicRevision.revisionId === expectedTopicRevisionId
    ) {
      topicRevision = previousTopicRevision;
    } else if (useTopicAccumulatorFastPath) {
      topicRevision = await buildTopicRevisionFromAccumulator({
        accumulator: topicAccumulator,
        visits: topicVisitsForBuild,
        visitSimilarity,
        ...(previousTopicRevision === null ? {} : { previousRevision: previousTopicRevision }),
      });
      mark('buildTopicRevisionFromAccumulator (w4 fast path)');
    } else {
      topicRevision = await buildSelectedTopicRevision({
        visits: topicVisitsForBuild,
        visitSimilarity,
        options: { cosineThreshold: topicCosineThreshold },
        ...(userAssertedRelations.length === 0 ? {} : { userAssertedRelations }),
        ...(previousTopicRevision === null ? {} : { previousRevision: previousTopicRevision }),
      });
    }
    if (shouldRunTopicRevision) {
      lastTopicRunAtMs = Date.now();
      topicDrainsSinceLastRun = 0;
      lastTopicRunSimilarityRevisionId = visitSimilarity.revisionId;
      pendingTopicRecompute = false;
    }
    mark(
      `topicRevision cacheHit=${String(topicRevision === previousTopicRevision)} fastPath=${String(useTopicAccumulatorFastPath)}`,
    );
    // U2 — decision + cheap counters for the (now default-on)
    // incremental hot paths. No baseline re-run: every field is a
    // local the drain already produced. Surfaced via workGraphHealth
    // similarity.hot-incremental / topic.hot-incremental.
    const hotPathDiagnostics: HotPathDiagnostics = {
      similarity: {
        enabled: hotSimilarityMode,
        shouldEmbedOnHotPath: hotSimilarityDecision.shouldEmbedOnHotPath,
        reason:
          'reason' in hotSimilarityDecision && hotSimilarityDecision.reason !== undefined
            ? hotSimilarityDecision.reason
            : null,
        usedHotPath: usedHotSimilarityPath,
        corpusSize: hotSimCorpusSize,
        newEmbedded: hotSimNewEmbedded,
        edgeCount: visitSimilarity.edges.length,
        runtimeMs: hotSimRuntimeMs,
      },
      topics: {
        enabled: hotTopicsMode,
        usedFastPath: useTopicAccumulatorFastPath,
        cacheHit: topicRevision === previousTopicRevision,
        componentCount: topicComponentCount,
        topicCount: topicRevision.topics.length,
        runtimeMs: Date.now() - topicBuildStartedAtMs,
      },
    };
    const canPreserveThreadQuoteEdges =
      previousSnapshotForRanker !== null &&
      existingProgress !== null &&
      existingProgress.materializerVersion === MATERIALIZER_VERSION &&
      pendingEventsForDrain.every((event) => event.type !== CAPTURE_RECORDED);
    const preservedThreadQuoteEdges = canPreserveThreadQuoteEdges
      ? previousSnapshotForRanker.edges.filter((edge) => edge.kind === 'thread_quotes_thread')
      : undefined;
    // W2 — SERVED TOPIC PRODUCER selection (feature-flagged, instant
    // rollback via SIDETRACK_TOPIC_PRODUCER + restart):
    //  - 'leiden-cpm'    = G: the W0c-stable winner that beats the
    //                      retired idf-rkn-split (3× blind-judged).
    //  - 'idf-rkn-split' = pre-W2 path (shadow flip), UNCHANGED.
    //  - 'union-find'    = conservative baseline fallback.
    let servedTopicRevision = topicRevision;
    let topicShadowDiagnostics: TopicShadowDiagnostics | null = null;
    let topicShadowObservation: TopicShadowObservationDiagnostics | null = null;
    const servedProducer: ServedTopicProducer = resolveServedTopicProducer();
    const topicCadenceSkipped = !shouldRunTopicRevision && previousTopicRevision !== null;
    if (servedProducer === 'leiden-cpm' && !topicCadenceSkipped) {
      // Skip-gated like the shadow (revisionId is a pure fn of
      // visitSimilarity.revisionId + threshold + algo). Lineage via
      // the dedicated leiden candidate slot ⇒ same-algorithm topic-id
      // continuity across drains (W2 acceptance, not bespoke).
      const prevLeiden = await topicRevisionStore.readCandidateShadowRevision(
        TOPIC_LEIDEN_CPM_REVISION_KEY,
      );
      const expectedLeidenId = await createTopicRevisionId({
        visitSimilarityRevisionId: visitSimilarity.revisionId,
        cosineThreshold: LEIDEN_CPM_COSINE_THRESHOLD,
        algorithmVersion: TOPIC_LEIDEN_CPM_REVISION_KEY,
      });
      let leidenRevision;
      if (prevLeiden !== null && prevLeiden.revisionId === expectedLeidenId) {
        leidenRevision = prevLeiden;
        mark(`servedProducer=leiden-cpm cacheHit topics=${String(leidenRevision.topics.length)}`);
      } else {
        leidenRevision = await buildLeidenCpmTopicRevision({
          visits: topicVisitsForBuild,
          visitSimilarity,
          ...(userAssertedRelations.length === 0 ? {} : { userAssertedRelations }),
          ...(prevLeiden === null ? {} : { previousRevision: prevLeiden }),
        });
        await topicRevisionStore.putCandidateShadowRevision(
          TOPIC_LEIDEN_CPM_REVISION_KEY,
          leidenRevision,
        );
        mark(`servedProducer=leiden-cpm build topics=${String(leidenRevision.topics.length)}`);
      }
      servedTopicRevision = leidenRevision;
      await topicRevisionStore.putActiveRevision(leidenRevision);
    }
    // Non-leiden producers ('idf-rkn-split' default, 'union-find')
    // keep the EXACT pre-W2 path: shadow-off ⇒ the selected baseline
    // is served (G1 guard); shadow-on ⇒ the idf-rkn flip below. The
    // only W2 change is excluding the case where leiden already served.
    if (
      servedProducer !== 'leiden-cpm' &&
      !shouldBuildTopicShadowCandidate() &&
      topicRevision !== previousTopicRevision
    ) {
      await topicRevisionStore.putActiveRevision(topicRevision);
      mark('putActiveTopicRevision');
    }
    // FLIP (shadow->active): idf-rkn-split path, unchanged from pre-W2.
    // `topicRevision` stays the BASELINE input so the shadow-vs-baseline
    // A/B observation remains meaningful; `servedTopicRevision` is what
    // we persist active + feed into the served snapshot.
    if (
      servedProducer !== 'leiden-cpm' &&
      !topicCadenceSkipped &&
      shouldBuildTopicShadowCandidate()
    ) {
      const previousShadowRevision = await topicRevisionStore.readShadowRevision();
      // Stage 5.2 W4 (shadow) — skip-gate, mirroring the baseline
      // topic-revision reuse above. The shadow revision id is a
      // deterministic function of its inputs, so when nothing relevant
      // changed we reuse the persisted shadow instead of recomputing
      // the expensive idf-rkn-split clustering. Recomputing it every
      // drain (unconditionally, even on baseline cache-hit) was the
      // dominant per-drain CPU cost behind the constant-CPU runaway.
      const expectedShadowId = await expectedShadowRevisionId({
        visits: topicVisitsForBuild,
        visitSimilarity,
        evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
        cosineThreshold: DEFAULT_TOPIC_COSINE_THRESHOLD,
      });
      if (
        previousShadowRevision !== null &&
        previousShadowRevision.revisionId === expectedShadowId
      ) {
        // Unchanged — reuse. Mirrors the baseline guard: the prior
        // shadow is already the active/served revision on disk so the
        // expensive buildTopicShadowCandidate is skipped (the CPU
        // win). G2 — but we DO recompute the shadow-vs-baseline A/B
        // diagnostics from the reused revision (cheap: prune only, no
        // clustering) so the HealthPanel experiments lane and the
        // workGraphHealth `topic.shadow-idf-rkn-split` candidate are
        // populated every drain instead of being perpetually
        // "unavailable" on skip drains.
        servedTopicRevision = previousShadowRevision;
        // G1 — keep idf-rkn-split the ACTIVE revision even on the
        // skip path. Without this, skip drains left the starved
        // union-find baseline as the persisted active revision.
        await topicRevisionStore.putActiveRevision(previousShadowRevision);
        topicShadowDiagnostics = buildReusedShadowDiagnostics({
          visits: topicVisitsForBuild,
          visitSimilarity,
          userAssertedRelations,
          baselineRevision: topicRevision,
          evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
          reusedRevision: previousShadowRevision,
        });
        topicShadowObservation = buildTopicShadowObservationDiagnostics({
          baselineRevision: topicRevision,
          previousBaselineRevision: previousTopicRevision,
          // Shadow is unchanged this drain, so shadow-vs-prior-shadow
          // churn is 0 by construction (reused === previous).
          shadowRevision: previousShadowRevision,
          previousShadowRevision,
        });
        mark(
          `topicShadowCandidate cacheHit=true (skip rebuild, kept active, A/B emitted topics=${String(topicShadowDiagnostics.shadowTopicCount)})`,
        );
      } else {
        const shadow = await buildTopicShadowCandidate({
          visits: topicVisitsForBuild,
          visitSimilarity,
          userAssertedRelations,
          baselineRevision: topicRevision,
          evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
          ...(previousTopicRevision === null ? {} : { previousRevision: previousTopicRevision }),
          cosineThreshold: DEFAULT_TOPIC_COSINE_THRESHOLD,
        });
        await writeShadowTopicRevision(deps.vaultRoot, shadow.revision);
        topicShadowDiagnostics = shadow.diagnostics;
        topicShadowObservation = buildTopicShadowObservationDiagnostics({
          baselineRevision: topicRevision,
          previousBaselineRevision: previousTopicRevision,
          shadowRevision: shadow.revision,
          previousShadowRevision,
        });
        mark(
          `topicShadowCandidate ${shadow.diagnostics.candidate} topics=${String(shadow.diagnostics.shadowTopicCount)} max=${String(shadow.diagnostics.shadowMaxTopicSize)} edges=${String(shadow.diagnostics.edgeCountAfterPruning)}`,
        );
        // Promote the shadow clustering to the active/served revision
        // so GET /v1/connections (no topicVariant) and the
        // materialized snapshot serve it, and current.json mirrors
        // current.shadow.json.
        servedTopicRevision = shadow.revision;
        await topicRevisionStore.putActiveRevision(shadow.revision);
        mark('topicShadowCandidate->active (flip)');
      }
    }
    // W2 step 5 — served-producer marker + observability (the
    // post-flip auto-rollback signal). algorithmVersion on the
    // revision already records the producer; this adds churn/lineage.
    const servedTopicProducerReport = buildServedTopicProducerReport(
      servedProducer,
      servedTopicRevision,
      previousTopicRevision,
    );
    mark(
      `servedProducer=${servedProducer} topics=${String(
        servedTopicProducerReport.topicCount,
      )} churnP90=${String(servedTopicProducerReport.churnP90)}`,
    );
    await yieldToEventLoop();
    const input: ConnectionsInput = {
      events: merged,
      ...vault,
      timelineDays,
      tabSessionProjection,
      urlProjection,
      visitSimilarity,
      topicRevision: servedTopicRevision,
      pageEvidenceByCanonicalUrl,
      ...(pageEvidenceVectorsByVectorId === undefined
        ? {}
        : { evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId }),
      engagementClassRevision,
      ...(preservedThreadQuoteEdges === undefined ? {} : { preservedThreadQuoteEdges }),
    };
    mark('projectionAccumulators.derive');
    await yieldToEventLoop();
    const dirtyScopeWrites =
      previousSnapshotForRanker !== null && dirtyScopes.length > 0
        ? new Set(dirtyScopes)
        : undefined;
    let scopedTimelineDeltaApplied = false;
    let baseSnapshot: ConnectionsSnapshot =
      previousSnapshotForRanker ?? buildConnectionsSnapshot(input);
    const baseSnapshotPrebuilt = previousSnapshotForRanker === null;
    const previousSnapshotForScopedDelta = previousSnapshotForRanker;
    const replaceScopeRowsForScopedDelta = deps.store.replaceScopeRows;
    let scopedTimelineDeltaSkipDetail = 'gate';
    // The served snapshot is stale w.r.t. topics when the served revision id
    // differs from what the snapshot last reflected (an incremental overlay
    // changed it within this process). Then the cheap scoped-delta path (which
    // never touches topic edges) must be skipped so the full rebuild below
    // re-renders visit_in_topic edges. Never force this during the catch-up (it
    // requires the scoped path). `undefined` means we have not published a
    // snapshot yet this process — the persisted snapshot was written from the
    // same revision readActiveRevision() now returns, so it is NOT stale; only
    // a drift we caused this process (lastSnapshotTopicRevisionId set, then the
    // served revision changed) marks it stale.
    const topicSnapshotStale =
      !requireScopedTimelineDeltaForDrain &&
      lastSnapshotTopicRevisionId !== undefined &&
      servedTopicRevision.revisionId !== lastSnapshotTopicRevisionId;
    const scopedTimelineDeltaGate = {
      incrementalScopes: true,
      feature: true,
      hasPrevious: previousSnapshotForRanker !== null,
      hasProgress: existingProgress !== null,
      version:
        existingProgress !== null && existingProgress.materializerVersion === MATERIALIZER_VERSION,
      replace: deps.store.replaceScopeRows !== undefined,
      pending: pendingEventsForDrain.length > 0,
      allScopedEvents: pendingEventsForDrain.every(isScopedTimelineDeltaEvent),
      topicSame: servedTopicRevision === previousTopicRevision,
      topicSnapshotFresh: !topicSnapshotStale,
      hnswNotFull: !hnswFullRebuild,
    };
    if (
      scopedTimelineDeltaGate.incrementalScopes &&
      scopedTimelineDeltaGate.feature &&
      previousSnapshotForScopedDelta !== null &&
      scopedTimelineDeltaGate.hasProgress &&
      scopedTimelineDeltaGate.version &&
      replaceScopeRowsForScopedDelta !== undefined &&
      scopedTimelineDeltaGate.pending &&
      scopedTimelineDeltaGate.allScopedEvents &&
      scopedTimelineDeltaGate.topicSame &&
      scopedTimelineDeltaGate.topicSnapshotFresh &&
      scopedTimelineDeltaGate.hnswNotFull
    ) {
      const timelineVisitKeys = new Set(
        similarityEntries.map((entry) => timelineEntryVisitKey(entry)),
      );
      for (const node of previousSnapshotForScopedDelta.nodes) {
        const visitKey = visitKeyFromTimelineNodeIdForDelta(node.id);
        if (visitKey !== null) timelineVisitKeys.add(visitKey);
      }
      const scopedVisitKeys = new Set(
        dirtyScopes
          .filter((scope) => scope.kind === 'url' && timelineVisitKeys.has(scope.id))
          .map((scope) => scope.id),
      );
      const tabSessionIds = new Set(
        dirtyScopes.filter((scope) => scope.kind === 'tab-session').map((scope) => scope.id),
      );
      const scopedDeltaEvents = collectScopedEventsForDelta(
        pendingEventsForDrain,
        merged,
        scopedVisitKeys,
        {
          includeCaptures: true,
          previousSnapshot: previousSnapshotForScopedDelta,
          ...(existingProgress === null ? {} : { priorFrontier: existingProgress.appliedFrontier }),
        },
      );
      const dirtyThreadScopes = dirtyScopes.filter((scope) => scope.kind === 'thread');
      const deletedThreadIdsForScopedDelta = new Set<string>();
      for (const scope of dirtyThreadScopes) {
        if (projectThread(scope.id, scopedDeltaEvents).deleted) {
          deletedThreadIdsForScopedDelta.add(scope.id);
        }
      }
      for (const threadId of deletedThreadIdsForScopedDelta) {
        const previousUrl = normalizedThreadUrlFromSnapshot(
          previousSnapshotForScopedDelta,
          threadId,
        );
        if (previousUrl !== null) scopedVisitKeys.add(previousUrl);
      }
      for (const event of pendingEventsForDrain) {
        if (
          event.type === BROWSER_TIMELINE_OBSERVED &&
          isBrowserTimelineObservedPayload(event.payload)
        ) {
          scopedVisitKeys.add(normalizeVisitUrl(event.payload.canonicalUrl ?? event.payload.url));
          if (event.payload.tabSessionId !== undefined) {
            tabSessionIds.add(event.payload.tabSessionId);
          }
        }
      }
      for (const visitId of hnswScopedDeltaVisitIds) scopedVisitKeys.add(visitId);
      const requiredTimelineVisitKeys = new Set(scopedVisitKeys);
      addSimilarityAffectedVisitKeys({
        seedVisitKeys: scopedVisitKeys,
        scopedVisitKeys,
        requiredTimelineVisitKeys,
        previousSnapshot: previousSnapshotForScopedDelta,
        visitSimilarity,
      });
      const scopedTimelineDayFilter = {
        requiredTimelineVisitKeys,
        tabSessionIds,
        includeTabSessionHistory: pendingEventsForDrain.some(
          (event) => event.type === TAB_SESSION_ATTRIBUTION_INFERRED,
        ),
      };
      let scopedTimelineDays = filterTimelineDaysForScopedDelta(timelineDays, scopedTimelineDayFilter);
      const missingRequiredTimelineVisitKeys = (): Set<string> => {
        const present = new Set(
          scopedTimelineDays
            .flatMap((day) => day.entries)
            .map((entry) => timelineEntryVisitKey(entry)),
        );
        return new Set([...requiredTimelineVisitKeys].filter((visitKey) => !present.has(visitKey)));
      };
      let missingRequiredVisitKeys = missingRequiredTimelineVisitKeys();
      if (missingRequiredVisitKeys.size > 0 && hnswScopedDeltaVisitIds.size > 0) {
        const fullRawTimelineDays =
          timelineFactStore === null
            ? buildTimelineDays(await deps.eventLog.readMerged())
            : timelineFactStore.readTimelineDays();
        scopedTimelineDays = filterTimelineDaysForScopedDelta(
          enrichTimelineDaysWithEngagement(fullRawTimelineDays, engagementInputs),
          scopedTimelineDayFilter,
        );
        mark(
          `scopedTimelineDelta.fullTimelineRead missing=${String(
            missingRequiredVisitKeys.size,
          )} entries=${String(scopedTimelineDays.reduce((sum, day) => sum + day.entries.length, 0))}`,
        );
        missingRequiredVisitKeys = missingRequiredTimelineVisitKeys();
      }
      const hasRequiredTimelineRows = missingRequiredVisitKeys.size === 0;
      if (!hasRequiredTimelineRows) {
        scopedTimelineDeltaSkipDetail = `missing-required-timeline-entries:${String(
          missingRequiredVisitKeys.size,
        )}`;
      }
      if (
        (scopedTimelineDays.length > 0 ||
          scopedDeltaEvents.length > 0 ||
          dirtyThreadScopes.length > 0) &&
        !pendingHasSearchVisit &&
        hasRequiredTimelineRows
      ) {
        if (canAttemptBoundedScopedDelta && scopedTimelineDays.length > 0) {
          const beforeScopedEvidenceRecords = pageEvidenceByCanonicalUrl.size;
          const readCount = await loadPageEvidenceForEntries(
            scopedTimelineDays.flatMap((day) => day.entries),
          );
          if (readCount > 0 || pageEvidenceByCanonicalUrl.size !== beforeScopedEvidenceRecords) {
            mark(
              `pageEvidence.scopedRead records=${String(pageEvidenceByCanonicalUrl.size)} read=${String(readCount)} entries=${String(scopedTimelineDays.reduce((sum, day) => sum + day.entries.length, 0))}`,
            );
          }
        }
        const {
          preservedThreadQuoteEdges: _preservedThreadQuoteEdges,
          topicRevision: _topicRevision,
          closestVisitRanker: _closestVisitRanker,
          crossReplica: _crossReplica,
          ...scopedInputBase
        } = input;
        void _preservedThreadQuoteEdges;
        void _topicRevision;
        void _closestVisitRanker;
        void _crossReplica;
        const scopedSnapshot = buildConnectionsSnapshot({
          ...scopedInputBase,
          events: scopedDeltaEvents,
          threads: filterDeletedThreadsForScopedDelta(
            scopedInputBase.threads,
            deletedThreadIdsForScopedDelta,
          ),
          workstreams: [],
          dispatches: [],
          queueItems: [],
          reminders: [],
          codingSessions: [],
          timelineDays: scopedTimelineDays,
        });
        const threadFullBuildReason = threadDeltaFullBuildReason({
          previousSnapshot: previousSnapshotForScopedDelta,
          scopedSnapshot,
          threadScopes: dirtyThreadScopes,
          deletedThreadIds: deletedThreadIdsForScopedDelta,
        });
        if (threadFullBuildReason !== null) {
          scopedTimelineDeltaSkipDetail = threadFullBuildReason;
        } else {
          const rowLocalScopes = dedupeScopeList([
            ...[...scopedVisitKeys.values()].map((id) => ({ kind: 'url' as const, id })),
            ...[...tabSessionIds.values()].map((id) => ({ kind: 'tab-session' as const, id })),
            ...visitInstanceScopesFromSnapshot(scopedSnapshot, {
              visitKeys: scopedVisitKeys,
              tabSessionIds,
            }),
            ...dirtyThreadScopes,
          ]);
          const rawScoped = unionScopeOutputs(
            rowLocalScopes.map((scope) => recomputeScope(scope, scopedSnapshot)),
          );
          const scoped = preserveThreadRowsForScopedDelta({
            output: rawScoped,
            previousSnapshot: previousSnapshotForScopedDelta,
            scopedSnapshot,
            threadScopes: dirtyThreadScopes,
            deletedThreadIds: deletedThreadIdsForScopedDelta,
          });
          const progress = progressForDrainSnapshot(scopedSnapshot);
          await replaceScopeRowsForScopedDelta({
            scopes: rowLocalScopes,
            nodes: scoped.nodes,
            edges: scoped.edges,
            progress,
            projectionAccumulatorState: serializeProjectionAccumulatorState(progress),
            metadata: {
              ...(scopedSnapshot.urlProjection === undefined
                ? {}
                : { urlProjection: scopedSnapshot.urlProjection }),
              tabSessionProjection: scopedSnapshot.tabSessionProjection,
            },
          });
          lastFrontier = progress.appliedFrontier;
          baseSnapshot = (await deps.store.readCurrent()) ?? scopedSnapshot;
          incrementalGraphView.seed(baseSnapshot);
          scopedTimelineDeltaApplied = true;
          const scopedNavigationEventCount = scopedDeltaEvents.filter(
            (event) => event.type === NAVIGATION_COMMITTED,
          ).length;
          const scopedThreadEventCount = scopedDeltaEvents.filter(isThreadScopedDeltaEvent).length;
          const scopedCaptureEventCount = scopedDeltaEvents.filter(
            (event) => event.type === CAPTURE_RECORDED,
          ).length;
          mark(
            `replaceScopeRows scopedTimelineDelta scopes=${String(rowLocalScopes.length)} nodes=${String(scoped.nodes.length)} edges=${String(scoped.edges.length)} entries=${String(scopedTimelineDays.reduce((sum, day) => sum + day.entries.length, 0))} nav=${String(scopedNavigationEventCount)} thread=${String(scopedThreadEventCount)} capture=${String(scopedCaptureEventCount)} events=${String(scopedDeltaEvents.length)} hnswNotFull=${String(scopedTimelineDeltaGate.hnswNotFull)}`,
          );
        }
      } else if (
        scopedTimelineDays.length === 0 &&
        dirtyScopes.length > 0 &&
        !scopesOwnGraphRows(previousSnapshotForScopedDelta, dirtyScopes)
      ) {
        const progress = progressForDrainSnapshot(previousSnapshotForScopedDelta);
        await replaceScopeRowsForScopedDelta({
          scopes: dirtyScopes,
          nodes: [],
          edges: [],
          progress,
          projectionAccumulatorState: serializeProjectionAccumulatorState(progress),
          metadata: {
            urlProjection: serializeUrlProjection(urlProjection),
            tabSessionProjection: serializeTabSessionProjection(tabSessionProjection),
          },
        });
        lastFrontier = progress.appliedFrontier;
        baseSnapshot = (await deps.store.readCurrent()) ?? previousSnapshotForScopedDelta;
        incrementalGraphView.seed(baseSnapshot);
        scopedTimelineDeltaApplied = true;
        mark(
          `replaceScopeRows scopedTimelineDeltaMetadataOnly scopes=${String(dirtyScopes.length)} entries=0`,
        );
      } else if (
        scopedRevisitNoOpEnabled() &&
        scopedTimelineDays.length === 0 &&
        scopedDeltaEvents.length === 0 &&
        dirtyThreadScopes.length === 0 &&
        dirtyScopes.length > 0 &&
        !pendingHasSearchVisit &&
        scopesOwnGraphRows(previousSnapshotForScopedDelta, dirtyScopes)
      ) {
        // Re-visit / graph-inert window. The window's events marked these
        // scopes dirty but NONE affect graph rows: no NAVIGATION_COMMITTED
        // (scopedDeltaEvents===0), no thread event (dirtyThreadScopes===0),
        // no new timeline entry (scopedTimelineDays===0). The graph-row
        // work (navigation edges, thread membership) arrives on its own
        // drain via the main apply branch; projection-overlay effects
        // (BROWSER_TIMELINE_OBSERVED lastSeen, attribution) are captured by
        // the projection write below. So the dirty scopes' graph rows are
        // unchanged — re-assert them from the previous snapshot (a no-op
        // row rewrite that KEEPS the rows the !scopesOwnGraphRows branch
        // above would wrongly clear) and advance the frontier, instead of
        // the ~18s full base rebuild this case used to fall into on every
        // re-visit.
        const scoped = unionScopeOutputs(
          dirtyScopes.map((scope) => recomputeScope(scope, previousSnapshotForScopedDelta)),
        );
        const progress = progressForDrainSnapshot(previousSnapshotForScopedDelta);
        await replaceScopeRowsForScopedDelta({
          scopes: dirtyScopes,
          nodes: scoped.nodes,
          edges: scoped.edges,
          progress,
          projectionAccumulatorState: serializeProjectionAccumulatorState(progress),
          metadata: {
            urlProjection: serializeUrlProjection(urlProjection),
            tabSessionProjection: serializeTabSessionProjection(tabSessionProjection),
          },
        });
        lastFrontier = progress.appliedFrontier;
        baseSnapshot = (await deps.store.readCurrent()) ?? previousSnapshotForScopedDelta;
        incrementalGraphView.seed(baseSnapshot);
        scopedTimelineDeltaApplied = true;
        mark(
          `replaceScopeRows scopedTimelineDeltaRevisitNoOp scopes=${String(dirtyScopes.length)} nodes=${String(scoped.nodes.length)} edges=${String(scoped.edges.length)} pending=${String(pendingEventsForDrain.length)}`,
        );
      } else if (
        requireScopedTimelineDeltaForDrain &&
        scopedTimelineDays.length === 0 &&
        dirtyScopes.length === 0
      ) {
        // Catch-up content-lane-only chunk (e.g. a backlog of
        // ENGAGEMENT_INTERVAL_OBSERVED). These events invalidate no graph
        // scope (CONTENT_LANE_ONLY_HANDLES → empty graph-scope set), so the
        // served graph is byte-identical; only the frontier must move. Without
        // this branch the chunk falls through to the throw below
        // (requireScopedTimelineDeltaForDrain), the frontier never advances,
        // and the next catchUp re-reads the same chunk forever — a runaway
        // that freezes the snapshot. Advance progress with an empty-scope
        // write (no node/edge rows change; #writeProgressRows persists the
        // chunk's dots + frontier) and serve the prior snapshot unchanged.
        const progress = progressForDrainSnapshot(previousSnapshotForScopedDelta);
        await replaceScopeRowsForScopedDelta({
          scopes: [],
          nodes: [],
          edges: [],
          progress,
          projectionAccumulatorState: serializeProjectionAccumulatorState(progress),
          metadata: {
            urlProjection: serializeUrlProjection(urlProjection),
            tabSessionProjection: serializeTabSessionProjection(tabSessionProjection),
          },
        });
        lastFrontier = progress.appliedFrontier;
        baseSnapshot = (await deps.store.readCurrent()) ?? previousSnapshotForScopedDelta;
        incrementalGraphView.seed(baseSnapshot);
        scopedTimelineDeltaApplied = true;
        mark(
          `replaceScopeRows scopedTimelineDeltaContentLaneOnly entries=0 pending=${String(pendingEventsForDrain.length)}`,
        );
      } else {
        scopedTimelineDeltaSkipDetail =
          scopedTimelineDays.length === 0
            ? 'no-timeline-entries-with-owned-rows'
            : pendingHasSearchVisit
              ? 'pending-search-visit'
              : 'unknown-inner';
      }
    }
    if (!scopedTimelineDeltaApplied) {
      mark(
        `scopedTimelineDelta skip reason=${scopedTimelineDeltaSkipDetail} inc=${String(scopedTimelineDeltaGate.incrementalScopes)} feature=${String(scopedTimelineDeltaGate.feature)} prev=${String(scopedTimelineDeltaGate.hasPrevious)} progress=${String(scopedTimelineDeltaGate.hasProgress)} version=${String(scopedTimelineDeltaGate.version)} replace=${String(scopedTimelineDeltaGate.replace)} pending=${String(pendingEventsForDrain.length)} allScoped=${String(scopedTimelineDeltaGate.allScopedEvents)} topicSame=${String(scopedTimelineDeltaGate.topicSame)} topicStale=${String(topicSnapshotStale)} hnswNotFull=${String(scopedTimelineDeltaGate.hnswNotFull)} dirtyScopes=${String(dirtyScopes.length)} types=${summarizeEventTypes(pendingEventsForDrain)}`,
      );
      if (requireScopedTimelineDeltaForDrain) {
        throw new Error(
          `connections catchUp chunk could not apply scoped delta: ${scopedTimelineDeltaSkipDetail}`,
        );
      }
      if (canAttemptBoundedScopedDelta) {
        const readCount = await loadPageEvidenceForEntries(similarityEntries);
        mark(
          `pageEvidence.fullBuildRead records=${String(pageEvidenceByCanonicalUrl.size)} read=${String(readCount)}`,
        );
      }
      if (!baseSnapshotPrebuilt) {
        // Full-rebuild fallback (scoped-delta could not apply; NOT a catch-up,
        // which threw above). In the store-backed path `input.events` (= merged)
        // is only the pending WINDOW, so buildConnectionsSnapshot would yield a
        // window-only graph that then OVERWRITES the full snapshot — a shrink
        // (e.g. a search-visit drain on a small window collapsing ~9k nodes to a
        // few hundred). The non-store-backed path already rebuilds from the full
        // log (merged = eventLog.readMerged()); mirror that here so the fallback
        // produces the COMPLETE graph. Every other input field (timelineDays,
        // projections, similarity, topics) is already full-scope, so only the
        // event set needs widening. The view is seeded from this base and is not
        // re-folded with `merged` in this path, so there is no double-apply.
        // Use storeBackedEvents.readSince({}) — the SAME full-event source the
        // cold build uses (proven to yield the complete graph) — not
        // deps.eventLog.readMerged(), which is partial in the store-backed setup.
        const fullBuildEvents =
          storeBackedEvents !== null ? storeBackedEvents.readSince({}) : merged;
        baseSnapshot =
          fullBuildEvents === merged
            ? buildConnectionsSnapshot(input)
            : buildConnectionsSnapshot({ ...input, events: fullBuildEvents });
      }
      incrementalGraphView.seed(baseSnapshot);
      if (incrementalGraphPlan.pendingEventCount > 0) {
        mark(
          `incrementalGraph plan rowLocal=${String(incrementalGraphPlan.rowLocalEventCount)} fullReducer=${String(incrementalGraphPlan.fullReducerEventCount)} ready=${String(incrementalGraphPlan.canUseRowLocalOnly)}`,
        );
      }
      mark(
        `buildConnectionsSnapshot base nodes=${String(baseSnapshot.nodes.length)} edges=${String(baseSnapshot.edges.length)}`,
      );
    }
    const scopeIncrementalEnabled =
      !scopedTimelineDeltaApplied &&
      process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] === '1' &&
      deps.store.replaceScopeRows !== undefined &&
      previousSnapshotForRanker !== null;
    let wroteScopeIncremental = scopedTimelineDeltaApplied;
    // Stage 5.2 W3b — publish the base snapshot immediately so HTTP
    // routes (and the side panel that reads them) have a valid current
    // snapshot to serve. The ranker-augmented build below adds
    // closest_visit edges; on a 5K-event vault that pass takes ~20s of
    // synchronous CPU which would otherwise block HTTP.
    if (scopeIncrementalEnabled) {
      if (dirtyScopes.length > 0) {
        const scoped = unionScopeOutputs(
          dirtyScopes.map((scope) => recomputeScope(scope, baseSnapshot)),
        );
        const progress = progressForDrainSnapshot(baseSnapshot);
        await deps.store.replaceScopeRows!({
          scopes: dirtyScopes,
          nodes: scoped.nodes,
          edges: scoped.edges,
          progress,
          projectionAccumulatorState: serializeProjectionAccumulatorState(progress),
          metadata: {
            ...(baseSnapshot.urlProjection === undefined
              ? {}
              : { urlProjection: baseSnapshot.urlProjection }),
            tabSessionProjection: baseSnapshot.tabSessionProjection,
          },
        });
        lastFrontier = progress.appliedFrontier;
        wroteScopeIncremental = true;
        mark(
          `replaceScopeRows scopes=${String(dirtyScopes.length)} nodes=${String(scoped.nodes.length)} edges=${String(scoped.edges.length)}`,
        );
      }
    }
    if (!wroteScopeIncremental) {
      await writeSnapshotWithDrainProgress(baseSnapshot, dirtyScopeWrites);
      mark('writeSnapshotAndProgress baseSnapshot');
    }
    // Record which topic revision the freshly-published snapshot reflects, so
    // a later overlay change (or restart) can detect drift and force a rebuild
    // (topicSnapshotStale above). The catch-up serves the prior snapshot and
    // must not claim freshness, so only record outside the catch-up.
    if (!requireScopedTimelineDeltaForDrain) {
      lastSnapshotTopicRevisionId = servedTopicRevision.revisionId;
    }
    await yieldToEventLoop();
    const rankerRetrainResult = await rankerRetrainer({
      merged,
      snapshot: baseSnapshot,
      pageEvidenceByCanonicalUrl,
      ...(pageEvidenceVectorsByVectorId === undefined
        ? {}
        : { evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId }),
    });
    mark('rankerRetrainer');
    // Track the snapshot we ultimately wrote so diagnostics see the
    // ranker-augmented form when it was produced, the base form when
    // the ranker pass was skipped.
    let finalSnapshot = wroteScopeIncremental
      ? ((await deps.store.readCurrent()) ?? baseSnapshot)
      : baseSnapshot;
    let closestVisitRanker: ClosestVisitRankerLoadResult | null = null;
    let rankerAugmentation = rankerAugmentationCounters({
      status: 'not-run',
      reason: null,
      activeRevisionId: null,
      ...schemaDiagnosticsFor(null),
      modelFreshness: 'unknown',
      baseSnapshot,
      finalSnapshot,
    });
    try {
      // Stage 5.2 W3b/c — gate the ranker-augmented build behind
      // SIDETRACK_SKIP_RANKER_SNAPSHOT for HTTP-latency-sensitive
      // consumers (recorder). The `RANKER_ON_SCOPED_DELTA=1` opt-in
      // (run the ranker on every scoped delta = slow) was removed —
      // the ranker is always deferred when a scoped delta applies
      // and the loader is absent, matching the IVM contract.
      const deferRankerForScopedTimelineDelta =
        scopedTimelineDeltaApplied && deps.closestVisitRankerLoader === undefined;
      if (deferRankerForScopedTimelineDelta) {
        mark('ranker-augmented skipped (scopedTimelineDelta)');
        rankerAugmentation = rankerAugmentationCounters({
          status: 'skipped',
          reason: 'scopedTimelineDelta',
          activeRevisionId: null,
          ...schemaDiagnosticsFor(null),
          modelFreshness: 'unknown',
          baseSnapshot,
          finalSnapshot,
        });
      } else if (process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] !== '1') {
        closestVisitRanker = await closestVisitRankerLoader();
        mark(
          `loadClosestVisitRanker status=${closestVisitRanker.status} revision=${closestVisitRanker.activeRevisionId ?? 'none'}`,
        );
        if (closestVisitRanker.status === 'ready') {
          await yieldToEventLoop();
          const rankerEvidenceVectorsByVectorId = await readPageEvidenceVectorsForDrain();
          const previousClosestVisitEdges =
            previousSnapshotForRanker?.edges.filter((edge) => edge.kind === 'closest_visit') ?? [];
          const currentSnapshot =
            previousSnapshotForRanker === null
              ? null
              : {
                  ...baseSnapshot,
                  edges: [...baseSnapshot.edges, ...previousClosestVisitEdges],
                  edgeCount: baseSnapshot.edges.length + previousClosestVisitEdges.length,
                };
          const producerRevision = closestVisitRanker.ranker.revisionId;
          const currentSnapshotRankerRevision = currentSnapshot?.edges.find(
            (edge) => edge.kind === 'closest_visit' && edge.producedBy.source === 'ranker',
          )?.producedBy.revisionId;
          const producerRevisionChanged =
            (lastRankerProducerRevision !== undefined &&
              lastRankerProducerRevision !== producerRevision) ||
            (currentSnapshotRankerRevision !== undefined &&
              currentSnapshotRankerRevision !== producerRevision);
          const touchedVisitIds = collectTouchedVisits(dirtyScopes, pendingEventsForDrain);
          const canUseIncrementalRanker =
            incrementalRankerEnabled() &&
            currentSnapshot !== null &&
            touchedVisitIds.size > 0 &&
            !producerRevisionChanged;
          if (canUseIncrementalRanker) {
            const rankerFrontier = expandRankerFrontier(touchedVisitIds, currentSnapshot, {
              includeSameUrlSiblings: true,
              includeSameTabSession: true,
              includeSameWorkstream: true,
              includeSameThread: true,
              includePriorClosestNeighbors: true,
              includeSimEdgeChanged: true,
            });
            finalSnapshot = augmentConnectionsSnapshotWithClosestVisitRankerFrontier(
              {
                ...input,
                evidenceVectorsByVectorId: rankerEvidenceVectorsByVectorId,
                closestVisitRanker: closestVisitRanker.ranker,
                rankerFrontier,
                inputFrontier: drainFrontier,
              },
              currentSnapshot,
            );
            mark(
              `augmentConnectionsSnapshot ranker-frontier visits=${String(rankerFrontier.size)} nodes=${String(finalSnapshot.nodes.length)} edges=${String(finalSnapshot.edges.length)}`,
            );
          } else {
            finalSnapshot = augmentConnectionsSnapshotWithClosestVisitRanker(
              {
                ...input,
                evidenceVectorsByVectorId: rankerEvidenceVectorsByVectorId,
                closestVisitRanker: closestVisitRanker.ranker,
              },
              baseSnapshot,
            );
            mark(
              `augmentConnectionsSnapshot ranker-augmented nodes=${String(finalSnapshot.nodes.length)} edges=${String(finalSnapshot.edges.length)} full=${String(producerRevisionChanged)}`,
            );
          }
          lastRankerProducerRevision = producerRevision;
          await writeSnapshotWithDrainProgress(finalSnapshot, dirtyScopeWrites);
          mark('writeSnapshotAndProgress ranker-augmented');
          rankerAugmentation = rankerAugmentationCounters({
            status: 'emitted',
            reason: null,
            activeRevisionId: closestVisitRanker.activeRevisionId,
            ...schemaDiagnosticsFor(closestVisitRanker),
            modelFreshness: modelFreshnessFor(rankerRetrainResult),
            baseSnapshot,
            finalSnapshot,
          });
        } else {
          const reason =
            closestVisitRanker.status === 'missing'
              ? closestVisitRanker.reason
              : `${closestVisitRanker.reason}${closestVisitRanker.error === null ? '' : `:${closestVisitRanker.error}`}`;
          rankerAugmentation = rankerAugmentationCounters({
            status: 'absent',
            reason,
            activeRevisionId: closestVisitRanker.activeRevisionId,
            ...schemaDiagnosticsFor(closestVisitRanker),
            modelFreshness: null,
            baseSnapshot,
            finalSnapshot,
          });
        }
      } else {
        mark('ranker-augmented skipped (SIDETRACK_SKIP_RANKER_SNAPSHOT=1)');
        rankerAugmentation = rankerAugmentationCounters({
          status: 'skipped',
          reason: 'SIDETRACK_SKIP_RANKER_SNAPSHOT=1',
          activeRevisionId: null,
          ...schemaDiagnosticsFor(null),
          modelFreshness: 'unknown',
          baseSnapshot,
          finalSnapshot,
        });
      }
    } finally {
      if (
        closestVisitRanker?.status === 'ready' &&
        typeof closestVisitRanker.model === 'object' &&
        !disposedRankerModels.has(closestVisitRanker.model)
      ) {
        disposedRankerModels.add(closestVisitRanker.model);
        closestVisitRanker.model.dispose();
      }
    }
    // PR #141 — write the diagnostics artifact after publishing. Uses
    // `finalSnapshot` so the artifact reflects whichever snapshot the
    // HTTP routes will see.
    const diagnostics = collectMaterializerDiagnostics({
      producedAt: diagnosticsNow().toISOString(),
      maxAcceptedAtMs: maxAcceptedAtMsForDrain,
      engagementGateMs: similarityConfig.engagementGateMs,
      similarityEffectiveConfig: similarityConfig,
      timelineEntries: timelineDays.flatMap((day) => day.entries),
      visitSimilarity,
      topicRevision,
      rankerRetrainResult,
      events: merged,
      urlProjection,
      snapshot: finalSnapshot,
      rankerAugmentation,
      pageEvidenceRecords: [...pageEvidenceByCanonicalUrl.values()],
      phaseDurations,
      ...(topicShadowDiagnostics === null ? {} : { topicShadowDiagnostics }),
      ...(topicShadowObservation === null ? {} : { topicShadowObservation }),
      hotPathDiagnostics,
      servedTopicProducerReport,
    });
    // Statistical drift/evaluation layer — feed the diagnostic series
    // through the change detectors and fold the status into the
    // artifact. `attachDriftReport` wraps all of its own I/O; it never
    // throws, so the drain stays unaffected by the drift layer.
    const driftRun = await attachDriftReport({
      diagnostics,
      topics: topicRevision.topics,
      similarityEdges: visitSimilarity.edges,
      vaultRoot: deps.vaultRoot,
    });
    if (driftRun.stateError !== null) {
      console.warn(`[materializer-diag] drift state persist failed: ${driftRun.stateError}`);
    }
    const diagnosticsWithDrift = driftRun.diagnostics;
    try {
      await diagnosticsStore.write(diagnosticsWithDrift);
    } catch (err) {
      // Diagnostics is observability — never fail the drain on its IO.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[materializer-diag] write failed: ${message}`);
    }
    diagnosticsLogger(diagnosticsWithDrift);
    return finalSnapshot;
  };

  // Stage 5.2 W1 — worker drain sequence counter. Increments per
  // worker invocation; stale results (lower seq than the latest
  // observed completion) are ignored. Single-vault materializer, so
  // out-of-order completions are rare but possible if the OS schedules
  // workers unpredictably.
  let workerDrainSeq = 0;
  let lastWorkerDrainSeqCompleted = -1;

  // Pick the off-main-thread runner. child_process.fork is the safe
  // path — worker_threads triggers V8 heap corruption when native
  // addons (onnx/usearch/sharp) load in two isolates of the same
  // process. The child_process path is the default; the worker_thread
  // path is retained only for opt-in stress testing.
  const pickSubprocessRunner = (): ((job: {
    vaultRoot: string;
    seq: number;
  }) => Promise<{ seq: number; ok: boolean; snapshotRevision?: string; error?: string }>) => {
    if (process.env['SIDETRACK_CONNECTIONS_WORKER'] === '1') {
      return runReconcileInWorker;
    }
    return runReconcileInChild;
  };

  const drainViaWorker = async (): Promise<void> => {
    workerDrainSeq += 1;
    const seq = workerDrainSeq;
    const runner = pickSubprocessRunner();
    const result = await runner({ vaultRoot: deps.vaultRoot, seq });
    let postDrainAtMs = markPostDrain('ipc-result', Date.now());
    if (seq <= lastWorkerDrainSeqCompleted) {
      // A newer drain already completed; ignore stale output.
      return;
    }
    if (!result.ok) {
      throw new Error(result.error ?? 'subprocess drain failed without a message');
    }
    lastWorkerDrainSeqCompleted = seq;
    const progress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
    postDrainAtMs = markPostDrain('snapshot-revision.reload-progress', postDrainAtMs);
    if (progress !== null && progress.materializerVersion === MATERIALIZER_VERSION) {
      lastFrontier = progress.appliedFrontier;
    }
    postDrainAtMs = markPostDrain('route-cache.memo-rebuild.skipped-lazy', postDrainAtMs);
    lastSuccessAt = new Date().toISOString();
    postDrainAtMs = markPostDrain('health.lastSuccessAt', postDrainAtMs);
    // The subprocess re-instantiated its own materializer + accumulators
    // inside the child context. The main-thread in-process state
    // (urlAccumulator, tabSessionAccumulator, lastEngagementClassRevision)
    // is now potentially stale relative to the on-disk snapshot. Force
    // a re-seed on the next in-process drain so future fallback paths
    // start fresh.
    projectionAccumulatorsInitialized = false;
    urlAccumulator = createEmptyUrlProjectionAccumulator();
    tabSessionAccumulator = createEmptyTabSessionProjectionAccumulator();
    lastEngagementClassRevision = undefined;
    markPostDrain('observer.accumulator-reset', postDrainAtMs);
  };

  // Decide whether the next pass (catchUp or drain) should be offloaded
  // to a worker_thread instead of running buildAndWrite on the main
  // thread. Three things matter:
  //
  //   1. Are we already running INSIDE a worker? The worker entry
  //      script calls `materializer.catchUp(eventLog)` itself — if
  //      that catchUp also tried to spawn a worker, we'd recurse
  //      forever. `isMainThread === false` short-circuits the check.
  //
  //   2. The explicit env `SIDETRACK_CONNECTIONS_WORKER` opts the
  //      pass into worker mode. With this change catchUp honours the
  //      env too — the previous code path bypassed it, so a cold-
  //      start rebuild over a real prod vault (12 k+ events) pinned
  //      the main thread for 30+ seconds and queued /status behind
  //      every other CPU-bound projection pass. The CLI sets this env
  //      at startup so end users get the worker by default; tests
  //      and programmatic users that import startCompanion directly
  //      keep the in-process path so they can assert on in-process
  //      accumulator state.
  //
  //   3. Per-pass overrides aren't supported — workers are spawned
  //      per drain (`runReconcileInWorker`), so we pay ~50ms of
  //      spawn cost per pass. Negligible vs. the 30s+ rebuilds the
  //      worker is replacing.
  const shouldUseWorker = (): boolean => {
    // isMainThread blocks worker_threads recursion.
    if (!isMainThread) return false;
    // Defense-in-depth against child_process recursion. If this
    // process has an IPC channel to a parent (i.e. it was launched
    // via fork()), refuse to spawn another subprocess. The child
    // entry script also clears the env explicitly; this guard is a
    // belt-and-suspenders second line so future callers that miss
    // the env reset don't accidentally spawn a fork bomb.
    if (typeof process.send === 'function') return false;
    // Explicit in-process override wins (used by unit + e2e tests
    // that need to assert against in-process accumulator state).
    if (process.env['SIDETRACK_CONNECTIONS_INPROCESS'] === '1') return false;
    // Either subprocess flavour qualifies. The child_process flavour is
    // the default; the worker_thread flavour is opt-in via WORKER=1.
    if (process.env['SIDETRACK_CONNECTIONS_WORKER'] === '1') return true;
    if (process.env['SIDETRACK_CONNECTIONS_CHILD'] === '1') return true;
    return false;
  };

  const drain = async (): Promise<void> => {
    while (dirty) {
      const passStartedAtMs = Date.now();
      lastDrainStartedAtMs = passStartedAtMs;
      urgentDrainRequested = false;
      dirty = false;
      let releaseMemoryAfterPass = false;
      try {
        if (progressOnlyDirty && (await tryAdvanceNoGraphBacklog())) {
          progressOnlyDirty = false;
        } else if (shouldUseWorker()) {
          progressOnlyDirty = false;
          releaseMemoryAfterPass = true;
          await drainViaWorker();
        } else {
          progressOnlyDirty = false;
          releaseMemoryAfterPass = true;
          await buildAndWrite();
        }
        lastSuccessAt = new Date().toISOString();
        lastError = null;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastFailureAtMs = Date.now();
        // Re-flag dirty so the next trigger retries; exit drain to
        // avoid tight-retry on persistent failures.
        dirty = true;
        return;
      } finally {
        if (releaseMemoryAfterPass) requestBunMemoryRelease();
      }
      // Stage 5.2 W1b — coalesce at the DRAIN level. Only relevant when
      // `dirty` was re-set DURING the rebuild (a HANDLES event arrived
      // mid-pass): without this the loop would immediately run another
      // full O(graph) rebuild with zero gap. Wait out the remainder of
      // DRAIN_MIN_INTERVAL_MS so events that arrived during the rebuild
      // + this gap collapse into the next single pass. Fire-then-
      // awaitIdle callers never hit this (dirty is false post-pass).
      if (dirty) {
        const remainingMs = urgentDrainRequested
          ? 0
          : resolveDrainMinIntervalMs() - (Date.now() - passStartedAtMs);
        if (remainingMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingMs));
        }
      }
    }
  };

  const startDrain = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await drain();
      } finally {
        running = false;
        pending = dirty;
      }
    })();
  };

  // Stage 5.2 W1c — enforce a true minimum interval between drain
  // STARTS. DRAIN_DEBOUNCE_MS only coalesces a burst into one start;
  // with a steady trigger stream each post-debounce start still fired
  // every ~DRAIN_DEBOUNCE_MS, so a ~5s buildConnectionsSnapshot ran
  // ~every 6.5s (the runaway). Defer the start until
  // DRAIN_MIN_INTERVAL_MS has elapsed since the last drain START;
  // intervening triggers coalesce into it (dirty stays set ⇒ no
  // starvation). Re-arms itself via the same unref'd debounce slot.
  // The first drain (lastDrainStartedAtMs===0) is never deferred.
  const startDrainWhenIntervalElapsed = (): void => {
    if (!dirty || running) return;
    if (urgentDrainRequested) {
      startDrain();
      return;
    }
    const minIntervalMs = resolveDrainMinIntervalMs();
    const sinceLastStartMs = Date.now() - lastDrainStartedAtMs;
    if (sinceLastStartMs < minIntervalMs) {
      if (drainDebounceTimer !== null) clearTimeout(drainDebounceTimer);
      drainDebounceTimer = setTimeout(() => {
        drainDebounceTimer = null;
        startDrainWhenIntervalElapsed();
      }, minIntervalMs - sinceLastStartMs);
      drainDebounceTimer.unref();
      return;
    }
    startDrain();
  };

  const flushContentOnlyProgressEvents = async (): Promise<void> => {
    const writeProgress = deps.store.writeMaterializerProgress;
    const batch = pendingContentOnlyProgressEvents;
    pendingContentOnlyProgressEvents = [];
    if (writeProgress === undefined || batch.length === 0) return;
    const requeueBatch = (): void => {
      pendingContentOnlyProgressEvents = [...batch, ...pendingContentOnlyProgressEvents];
      if (contentOnlyProgressFlushScheduled) return;
      contentOnlyProgressFlushScheduled = true;
      const timer = setTimeout(() => {
        contentOnlyProgressFlushScheduled = false;
        void flushContentOnlyProgressEvents();
      }, 25);
      timer.unref?.();
    };
    contentOnlyProgressFlushRunning = true;
    const startedAtMs = Date.now();
    try {
      if (running || dirty) {
        requeueBatch();
        return;
      }
      const progress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
      if (running || dirty) {
        requeueBatch();
        return;
      }
      if (progress === null || progress.materializerVersion !== MATERIALIZER_VERSION) return;
      const unapplied = batch.filter(
        (event) => !intervalsContainDot(progress.appliedDotIntervals, event.dot),
      );
      if (unapplied.length > 0) {
        const appliedDotIntervals = addDotsToIntervals(
          progress.appliedDotIntervals,
          unapplied.map((event) => event.dot),
        );
        const nextProgress: MaterializerProgress = {
          ...progress,
          appliedDotIntervals,
          appliedFrontier: frontierFromIntervals(appliedDotIntervals),
        };
        if (running || dirty) {
          requeueBatch();
          return;
        }
        await writeProgress(nextProgress);
        lastFrontier = nextProgress.appliedFrontier;
        lastSuccessAt = new Date().toISOString();
        lastError = null;
      }
      const durationMs = Date.now() - startedAtMs;
      if (batch.length >= 25 || durationMs >= 250) {
        console.warn(
          `[connections] content-only progress batch events=${String(batch.length)} advanced=${String(unapplied.length)} dt=${String(durationMs)}ms pending=${String(pendingContentOnlyProgressEvents.length)}`,
        );
      }
    } catch (error: unknown) {
      console.warn(
        `[connections] content-only progress advance failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      contentOnlyProgressFlushRunning = false;
      if (pendingContentOnlyProgressEvents.length > 0) {
        scheduleContentOnlyProgressAdvance();
      }
    }
  };

  function scheduleContentOnlyProgressAdvance(event?: AcceptedEvent): void {
    if (event !== undefined) pendingContentOnlyProgressEvents.push(event);
    if (contentOnlyProgressFlushScheduled || contentOnlyProgressFlushRunning) return;
    contentOnlyProgressFlushScheduled = true;
    setImmediate(() => {
      contentOnlyProgressFlushScheduled = false;
      void flushContentOnlyProgressEvents();
    });
  }

  const applyProjectionOverlayWithRetry = async (
    applyProjectionEventOverlay: (event: AcceptedEvent) => Promise<string | null>,
    event: AcceptedEvent,
  ): Promise<string | null> => {
    let retryIndex = 0;
    while (true) {
      try {
        return await applyProjectionEventOverlay(event);
      } catch (error) {
        const delay = PROJECTION_OVERLAY_RETRY_DELAYS_MS[retryIndex];
        if (!isSqliteLockError(error) || delay === undefined) {
          throw error;
        }
        retryIndex += 1;
        await delayMs(delay);
      }
    }
  };

  const tryAdvanceNoGraphEvents = async (
    progress: MaterializerProgress,
    ordered: readonly AcceptedEvent[],
  ): Promise<boolean> => {
    const writeProgress = deps.store.writeMaterializerProgress;
    if (writeProgress === undefined) return false;
    if (
      !ordered.every(
        (event) =>
          CONTENT_LANE_ONLY_HANDLES.has(event.type) || PROJECTION_ONLY_HANDLES.has(event.type),
      )
    ) {
      return false;
    }
    let snapshotRevisionId = progress.snapshotRevisionId;
    const projectionEvents = ordered.filter((event) => PROJECTION_ONLY_HANDLES.has(event.type));
    if (projectionEvents.length > 0) {
      const applyProjectionEventOverlay = deps.store.applyProjectionEventOverlay;
      if (applyProjectionEventOverlay === undefined) return false;
      for (const event of projectionEvents) {
        const nextRevisionId = await applyProjectionOverlayWithRetry(
          applyProjectionEventOverlay,
          event,
        );
        if (nextRevisionId === null) return false;
        snapshotRevisionId = nextRevisionId;
      }
    }
    const appliedDotIntervals = addDotsToIntervals(
      progress.appliedDotIntervals,
      ordered.map((event) => event.dot),
    );
    const nextProgress: MaterializerProgress = {
      ...progress,
      appliedDotIntervals,
      appliedFrontier: frontierFromIntervals(appliedDotIntervals),
      snapshotRevisionId,
    };
    await writeProgress(nextProgress);
    lastFrontier = nextProgress.appliedFrontier;
    lastBuildInvalidations = [];
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    return true;
  };

  const tryAdvanceNoGraphBacklog = async (): Promise<boolean> => {
    const progress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
    if (progress === null || progress.materializerVersion !== MATERIALIZER_VERSION) return false;
    lastFrontier = progress.appliedFrontier;
    // Watermark-resume: read only events past the applied frontier instead of
    // materializing the whole ~190k-event log on the main thread. The
    // subsequent intervalsContainDot filter still drops any already-applied
    // (e.g. gapped) dot, so this stays byte-equivalent to the full-log path:
    // every UNapplied dot is by definition past the contiguous frontier, and
    // applied-but-gapped dots are filtered out either way.
    const merged = await deps.eventLog.readMergedSince(progress.appliedFrontier);
    const ordered = sortAcceptedEvents(
      merged.filter((event) => !intervalsContainDot(progress.appliedDotIntervals, event.dot)),
    );
    if (ordered.length === 0) {
      lastBuildInvalidations = [];
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      return true;
    }
    return tryAdvanceNoGraphEvents(progress, ordered);
  };

  const requestDrain = (options: { readonly urgent?: boolean } = {}): void => {
    dirty = true;
    pending = true;
    if (options.urgent === true) urgentDrainRequested = true;
    if (running) return;
    // Failure cooldown gate — same pattern as timelineMaterializer.
    // catchUp bypasses this gate; onAccepted respects it.
    const sinceFailureMs = Date.now() - lastFailureAtMs;
    if (lastError !== null && sinceFailureMs < FAILURE_COOLDOWN_MS) return;
    // Stage 5.2 W1a — debounce: coalesce burst event arrivals into a
    // single drain. Each requestDrain resets the timer, so a steady
    // stream of events triggers exactly one drain after the burst
    // settles (or at debounceMs after the latest arrival).
    if (drainDebounceTimer !== null) clearTimeout(drainDebounceTimer);
    drainDebounceTimer = setTimeout(
      () => {
        drainDebounceTimer = null;
        startDrainWhenIntervalElapsed();
      },
      urgentDrainRequested ? URGENT_DRAIN_DEBOUNCE_MS : DRAIN_DEBOUNCE_MS,
    );
    drainDebounceTimer.unref();
  };

  const scheduleProjectionOverlay = (event: AcceptedEvent): void => {
    if (!PROJECTION_OVERLAY_HANDLES.has(event.type)) return;
    const applyProjectionEventOverlay = deps.store.applyProjectionEventOverlay;
    if (applyProjectionEventOverlay === undefined) return;
    projectionOverlayQueue = projectionOverlayQueue
      .catch(() => undefined)
      .then(async () => {
        await applyProjectionOverlayWithRetry(applyProjectionEventOverlay, event);
      })
      .catch((error: unknown) => {
        console.warn(
          `[connections] projection overlay failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };

  const scheduleForegroundNavigationOverlay = (event: AcceptedEvent): void => {
    if (event.type !== NAVIGATION_COMMITTED || !isNavigationCommittedPayload(event.payload)) {
      return;
    }
    if (deps.store.replaceScopeRows === undefined) return;
    // Coalesce: a tab-burst fires many NAVIGATION_COMMITTED events in quick
    // succession. Queuing one overlay (one full readMerged) per event chains
    // dozens of O(whole-log) merges in the microtask queue, starving the
    // event-loop timer for tens of seconds (the "wedge"). Instead keep only
    // the newest few nav events pending and at most one overlay in flight;
    // writeForegroundNavigationDelta already resolves only the newest chain
    // (newestNavigationCommittedEvents(..., 4)), and the authoritative graph
    // drain reconciles everything regardless, so collapsing the burst into a
    // single overlay pass is behaviour-preserving for the UI.
    pendingForegroundNavEvents.push(event);
    if (pendingForegroundNavEvents.length > 4) {
      pendingForegroundNavEvents = pendingForegroundNavEvents.slice(-4);
    }
    if (foregroundNavOverlayScheduled) return;
    foregroundNavOverlayScheduled = true;
    foregroundNavigationOverlayQueue = foregroundNavigationOverlayQueue
      .catch(() => undefined)
      .then(async () => {
        foregroundNavOverlayScheduled = false;
        const events = pendingForegroundNavEvents;
        pendingForegroundNavEvents = [];
        if (events.length === 0) return;
        const existingProgress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
        if (
          existingProgress === null ||
          existingProgress.materializerVersion !== MATERIALIZER_VERSION
        ) {
          return;
        }
        const merged = await deps.eventLog.readMerged();
        const startedAtMs = Date.now();
        await writeForegroundNavigationDelta({
          pendingEventsForDrain: events,
          merged,
          existingProgress,
          mark: (label) => {
            if (process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] !== '1') return;
            console.warn(
              `[connections-phase] accepted.${label} dt=${String(Date.now() - startedAtMs)}ms`,
            );
          },
        });
      })
      .catch((error: unknown) => {
        foregroundNavOverlayScheduled = false;
        console.warn(
          `[connections] foreground navigation overlay failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };

  const onAccepted: Materializer['onAccepted'] = (event) => {
    const handlesGraph = HANDLES.has(event.type);
    const handlesContentLaneOnly = CONTENT_LANE_ONLY_HANDLES.has(event.type);
    const handlesProjectionOnly = PROJECTION_ONLY_HANDLES.has(event.type);
    if (!handlesGraph && !handlesContentLaneOnly && !handlesProjectionOnly) return;
    // Stage 5.2 W7 — accumulate Group B events into the dirty-source
    // queue before scheduling a drain. Non-Group-B events return false
    // and don't touch the queue; Group B events mark their sourceUnitId
    // dirty (or tombstoned) and optionally record the latest extraction
    // revisionId. No I/O, no chunk/embed work — that's the reconciler's
    // job. The buildAndWrite drain remains the byte-determinism reference;
    // this queue is purely for the off-path content reconciler.
    foldGroupBEventIntoQueue(dirtySourceQueue, event);
    if (event.type === PAGE_EVIDENCE_EXTRACTED && isRecord(event.payload)) {
      const canonicalUrl = event.payload['canonicalUrl'];
      if (typeof canonicalUrl === 'string') {
        pageEvidenceRecordCache.delete(canonicalizeEvidenceUrl(canonicalUrl));
      }
    }
    if (!handlesGraph) {
      // PROJECTION_OVERLAY_HANDLES events that aren't graph handles
      // (URL_IGNORED today) still need their in-memory accumulator
      // fold here. Without this fold, the next drain — which builds
      // urlProjection from urlAccumulator — would miss URL_IGNORED
      // and only the snapshot-metadata merge with the catchUp-time
      // overlay would save the ignore (fragile: depends on urlRecordFreshness
      // tiebreaks). The PERSISTED overlay write is left to tryAdvanceNoGraphEvents
      // inside catchUp/drain (called via requestDrain below) so we
      // don't double-apply the same dot — scheduleProjectionOverlay
      // here would fire on top of the catchUp-time overlay, and
      // applyProjectionEventOverlay isn't deduped against
      // appliedDotIntervals.
      if (PROJECTION_OVERLAY_HANDLES.has(event.type) && projectionAccumulatorsInitialized) {
        foldEventIntoUrlProjectionAccumulator(urlAccumulator, event);
        foldEventIntoTabSessionProjectionAccumulator(tabSessionAccumulator, event);
      }
      if (handlesContentLaneOnly) {
        scheduleContentOnlyProgressAdvance(event);
        return;
      }
      progressOnlyDirty = true;
      requestDrain();
      return;
    }
    progressOnlyDirty = false;
    // Stage 5.2 W6 — accumulate invalidation keys for this event so the
    // next drain can answer "which slices are dirty?" Most events
    // contribute one or two keys; ANNOTATION_* / DISPATCH_* return [].
    const keys = invalidationsForEvent(event);
    if (keys.length > 0) {
      for (const key of keys) accumulatedInvalidations.push(key);
    }
    // Stage 5.2 W2b/c — fold the event into the projection accumulators
    // so the next buildAndWrite drains O(events-since-last-drain)
    // instead of re-projecting the entire log. The fold is a no-op for
    // event types neither projection cares about. Skipped before the
    // first buildAndWrite seeds the accumulators from the log; we
    // detect that via the initialized flag.
    if (projectionAccumulatorsInitialized) {
      foldEventIntoUrlProjectionAccumulator(urlAccumulator, event);
      foldEventIntoTabSessionProjectionAccumulator(tabSessionAccumulator, event);
    }
    scheduleProjectionOverlay(event);
    scheduleForegroundNavigationOverlay(event);
    incrementalGraphView.fold(event);
    requestDrain({
      urgent: event.type === NAVIGATION_COMMITTED || event.type === BROWSER_TIMELINE_OBSERVED,
    });
  };

  const resetInMemoryProjectionState = (): void => {
    projectionAccumulatorsInitialized = false;
    urlAccumulator = createEmptyUrlProjectionAccumulator();
    tabSessionAccumulator = createEmptyTabSessionProjectionAccumulator();
    incrementalGraphView.reset();
    lastEngagementClassRevision = undefined;
    lastRankerProducerRevision = undefined;
  };

  const catchUpInScopedChunks = async (
    ordered: readonly AcceptedEvent[],
  ): Promise<{ readonly applied: boolean; readonly reason: string }> => {
    const previousSnapshot = await deps.store.readCurrent();
    if (previousSnapshot === null) return { applied: false, reason: 'no-current-snapshot' };
    if (deps.store.replaceScopeRows === undefined) {
      return { applied: false, reason: 'replaceScopeRows-unavailable' };
    }
    if (!ordered.every(isScopedTimelineDeltaEvent)) {
      return { applied: false, reason: 'non-scoped-events' };
    }
    if (process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] === '1') {
      console.warn(
        `[connections-phase] catchUp.chunkedScoped start events=${String(
          ordered.length,
        )} chunkSize=${String(BACKLOG_FALLBACK_THRESHOLD)}`,
      );
    }
    for (let offset = 0; offset < ordered.length; offset += BACKLOG_FALLBACK_THRESHOLD) {
      const progress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
      if (progress === null || progress.materializerVersion !== MATERIALIZER_VERSION) {
        return { applied: false, reason: 'progress-version-mismatch' };
      }
      const chunk = ordered
        .slice(offset, offset + BACKLOG_FALLBACK_THRESHOLD)
        .filter((event) => !intervalsContainDot(progress.appliedDotIntervals, event.dot));
      if (chunk.length === 0) continue;
      for (const event of chunk) {
        for (const key of invalidationsForEvent(event)) accumulatedInvalidations.push(key);
      }
      catchUpPendingEventWindow = chunk;
      requireScopedTimelineDeltaForDrain = true;
      try {
        await buildAndWrite();
      } finally {
        catchUpPendingEventWindow = null;
        requireScopedTimelineDeltaForDrain = false;
        requestBunMemoryRelease();
      }
      lastSuccessAt = new Date().toISOString();
      lastError = null;
    }
    return { applied: true, reason: 'chunked-scoped' };
  };

  const catchUp: Materializer['catchUp'] = async () => {
    pending = true;
    if (running) {
      await awaitIdle();
      return;
    }
    running = true;
    // Stage 5.2 W2b/c wiring — catchUp is the recovery / boot-time path;
    // force a re-seed so any drift between the in-memory accumulators
    // and the event log is corrected. The next buildAndWrite (or worker
    // pass) seeds.
    resetInMemoryProjectionState();
    dirty = false;
    let releaseMemoryAfterCatchUp = false;
    try {
      progressOnlyDirty = false;
      let progress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
      const versionMatches = progress?.materializerVersion === MATERIALIZER_VERSION;
      const useWorkerForCatchUp = shouldUseWorker();
      if (progress !== null && versionMatches) {
        lastFrontier = progress.appliedFrontier;
        // Pre-seal permanent gaps BEFORE computing the pending backlog. A frozen
        // frontier here (frontierFromIntervals stalled below a permanent hole)
        // makes readMergedSince re-return the whole post-gap window, which trips
        // the chunked catch-up path below — and the chunked path (by design)
        // skips the per-drain seal. So without this a frozen vault can never
        // self-heal in worker/child mode. Sealing advances the frontier so the
        // backlog collapses to the genuinely-new tail and the normal drain runs.
        // Watermark + absence are derived from the canonical log (vectorFromEvents
        // is the log's per-replica max). Aged + persisted exactly like the
        // store-backed seal; no-op when the flag is off.
        if (
          GAP_SEAL_ENABLED() &&
          dotIntervalsHaveGaps(progress.appliedDotIntervals) &&
          deps.store.writeMaterializerProgress !== undefined
        ) {
          const fullLogForSeal = await deps.eventLog.readMerged();
          const sealMark = (message: string): void => {
            if (process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] === '1') {
              console.log(`[connections-phase] ${message}`);
            }
          };
          const sealed = await computeSealedIntervals(
            deps.vaultRoot,
            progress.appliedDotIntervals,
            vectorFromEvents(fullLogForSeal),
            fullLogForSeal,
            sealMark,
          );
          if (sealed !== progress.appliedDotIntervals) {
            progress = {
              ...progress,
              appliedDotIntervals: sealed,
              appliedFrontier: frontierFromIntervals(sealed),
            };
            await deps.store.writeMaterializerProgress(progress);
            lastFrontier = progress.appliedFrontier;
          }
        }
        const sealedAppliedIntervals = progress.appliedDotIntervals;
        const pendingEvents = (
          await deps.eventLog.readMergedSince(
            dotIntervalsHaveGaps(sealedAppliedIntervals)
              ? frontierFromIntervals(sealedAppliedIntervals)
              : progress.appliedFrontier,
          )
        ).filter((event) => !intervalsContainDot(sealedAppliedIntervals, event.dot));
        const ordered = sortAcceptedEvents(pendingEvents);
        if (ordered.length === 0) {
          lastBuildInvalidations = [];
          lastSuccessAt = new Date().toISOString();
          lastError = null;
          return;
        }
        if (
          ordered.every(
            (event) =>
              CONTENT_LANE_ONLY_HANDLES.has(event.type) || PROJECTION_ONLY_HANDLES.has(event.type),
          )
        ) {
          const writeProgress = deps.store.writeMaterializerProgress;
          if (writeProgress !== undefined) {
            if (await tryAdvanceNoGraphEvents(progress, ordered)) return;
          }
        }
        if (ordered.length > BACKLOG_FALLBACK_THRESHOLD && !useWorkerForCatchUp) {
          const chunked = await catchUpInScopedChunks(ordered);
          if (chunked.applied) {
            lastBuildInvalidations = [];
            lastSuccessAt = new Date().toISOString();
            lastError = null;
            return;
          }
          if (chunked.reason !== 'no-current-snapshot') {
            throw new Error(`connections catchUp large backlog cannot chunk: ${chunked.reason}`);
          }
        }
        if (ordered.length <= BACKLOG_FALLBACK_THRESHOLD) {
          // Phase 1 intentionally keeps the apply path as a full rebuild.
          // The durable dot-interval filter is the safety foundation for
          // Phase 2's scoped recompute.
          for (const event of ordered) {
            for (const key of invalidationsForEvent(event)) accumulatedInvalidations.push(key);
          }
        }
      }
      // 2026-05 cold-start fix: route catchUp through the worker the
      // same way drain does. The previous direct buildAndWrite()
      // pinned the main thread for the full re-projection (~30 s on a
      // 12 k-event prod vault), which queued /status and every other
      // HTTP request behind it. shouldUseWorker() respects the env
      // opt-out AND skips itself when we're already inside a worker.
      if (useWorkerForCatchUp) {
        releaseMemoryAfterCatchUp = true;
        await drainViaWorker();
      } else {
        releaseMemoryAfterCatchUp = true;
        await buildAndWrite();
      }
      lastSuccessAt = new Date().toISOString();
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Don't spin during catchUp — leave dirty=true so the next
      // event trigger (after cooldown) retries.
      dirty = true;
    } finally {
      if (releaseMemoryAfterCatchUp) requestBunMemoryRelease();
      running = false;
      pending = dirty || running;
      if (dirty && lastError === null) startDrain();
    }
  };

  const awaitIdle: Materializer['awaitIdle'] = async () => {
    // "Idle" = no in-flight drain AND no pending retry that the
    // failure-cooldown gate isn't currently blocking. After a failed
    // drain the materializer leaves dirty=true so the NEXT trigger
    // retries; if no further trigger arrives, dirty stays true
    // forever and a naive `while (running || dirty)` would spin
    // forever even though work is permanently parked. Treat a
    // sustained failure (lastError !== null AND no in-flight drain)
    // as idle — callers checking `health()` see `status: 'failed'`
    // and can act on it.
    while (running || (dirty && lastError === null)) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const healthStatus = (): MaterializerHealth['status'] => {
    return classifyConnectionsMaterializerHealth({ pending, lastSuccessAt, lastError });
  };

  const health: Materializer['health'] = (): MaterializerHealth => {
    const status = healthStatus();
    return {
      status,
      lastSuccessAt,
      lastError,
      pending,
      ...(lastFrontier === undefined ? {} : { frontier: lastFrontier }),
    };
  };

  const getDirtySources = (): DirtySourceQueueSnapshot => dirtySourceQueue.snapshot();
  const clearDirtySources = (sourceUnitIds: readonly string[]): void => {
    dirtySourceQueue.clear(sourceUnitIds);
  };
  const getInvalidationsSinceLastBuild = (): readonly InvalidationKey[] => lastBuildInvalidations;
  const getTopicAccumulator = (): IncrementalTopicClusterAccumulator => topicAccumulator;
  const getEmbedderWarmthTracker = (): EmbedderWarmthTracker => embedderWarmthTracker;

  // Stage 5.2 W7 — content-lane reconciler entry point. Snapshot the
  // dirty queue + tombstones, walk them through the supplied reconciler,
  // ack each via clearDirtySources. The reconciler is responsible for
  // the heavy lifting (chunking, embedding, recall index replace) —
  // this method just orchestrates. Tombstoned units are reconciled
  // first to ensure index removals happen before chunk re-adds during
  // a re-add-then-tombstone-then-re-add sequence on the same source.
  const drainContentLaneQueue = async (
    reconciler: ContentLaneSourceUnitReconciler,
  ): Promise<number> => {
    const snapshot = dirtySourceQueue.snapshot();
    const tombstones = snapshot.tombstonedSourceUnitIds;
    const dirty = snapshot.dirtySourceUnitIds.filter((id) => !tombstones.includes(id));
    const processed: string[] = [];
    for (const sourceUnitId of tombstones) {
      try {
        const ok = await reconciler.reconcileTombstone(sourceUnitId);
        if (ok) processed.push(sourceUnitId);
      } catch {
        // Reconciler error: leave entry in queue so next drain retries.
      }
    }
    for (const sourceUnitId of dirty) {
      try {
        const ok = await reconciler.reconcileSourceUnit(sourceUnitId);
        if (ok) processed.push(sourceUnitId);
      } catch {
        // Same retry policy.
      }
    }
    if (processed.length > 0) dirtySourceQueue.clear(processed);
    return processed.length;
  };

  // The runner gates event dispatch on `m.handles.has(event.type)`. The
  // materializer ALSO accepts content-lane-only and projection-only events
  // (see onAccepted's three-way classification), so `handles` must report
  // the union — otherwise the runner silently swallows those event types
  // and onAccepted never runs for them.
  const allHandles: ReadonlySet<string> = new Set<string>([
    ...HANDLES,
    ...CONTENT_LANE_ONLY_HANDLES,
    ...PROJECTION_ONLY_HANDLES,
  ]);
  return {
    name: MATERIALIZER_NAME,
    handles: allHandles,
    onAccepted,
    catchUp,
    awaitIdle,
    health,
    getDirtySources,
    clearDirtySources,
    getInvalidationsSinceLastBuild,
    getTopicAccumulator,
    getEmbedderWarmthTracker,
    drainContentLaneQueue,
  };
};
