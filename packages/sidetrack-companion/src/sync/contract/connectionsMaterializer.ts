import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  SqliteConnectionsStore,
} from '../../connections/snapshot.js';
import type { ConnectionsStore } from '../../connections/snapshot.js';
import { recomputeScope, unionScopeOutputs } from '../../connections/scopeRecompute.js';
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
import {
  buildServedTopicProducerReport,
  resolveServedTopicProducer,
  type ServedTopicProducer,
} from '../../connections/servedTopicProducer.js';
import {
  hotTopicsModeEnabled,
  type HotPathDiagnostics,
} from '../../connections/hotPathMode.js';
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
import { NAVIGATION_COMMITTED } from '../../navigation/events.js';
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
import { invalidationKeysToScopes, type Scope } from './connectionsScopes.js';
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
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { embed as defaultEmbed } from '../../recall/embedder.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import {
  ensurePageEvidenceForTimelineEntries,
  readPageEvidenceVectorMap,
} from '../../page-evidence/store.js';
import { readPageContentChunksForCanonicalUrls } from '../../page-content/store.js';
import { SELECTION_COPIED, SELECTION_PASTED } from '../../snippets/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../../threads/events.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  type BrowserTimelineObservedPayload,
  isBrowserTimelineObservedPayload,
} from '../../timeline/events.js';
import {
  buildDayProjection,
  collectTimelinePayloads,
  entryIdFor,
  groupByDay,
  type TimelineDayProjection,
  type TimelineStore,
} from '../../timeline/projection.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { isMainThread } from 'node:worker_threads';
import { sortAcceptedEvents, vectorFromEvents, type AcceptedEvent, type Dot } from '../causal.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import type { VisitSimilarityEdge, VisitSimilarityRevision } from '../../connections/types.js';
import {
  addDotsToIntervals,
  EMPTY_PROGRESS,
  frontierFromIntervals,
  intervalsContainDot,
  type MaterializerProgress,
} from './materializerProgress.js';
import {
  createEmptyTabSessionProjectionAccumulator,
  foldEventIntoTabSessionProjectionAccumulator,
  seedTabSessionProjectionAccumulatorAsync,
  tabSessionProjectionFromAccumulator,
  type TabSessionProjectionAccumulator,
} from '../../tabsession/projection.js';
import {
  applyThreadAttributionsToAccumulator,
  createEmptyUrlProjectionAccumulator,
  foldEventIntoUrlProjectionAccumulator,
  seedUrlProjectionAccumulatorAsync,
  urlProjectionFromAccumulator,
  type UrlProjectionAccumulator,
} from '../../urls/projection.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../../tabsession/events.js';

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
const DEFAULT_DRIFT_EVERY_DRAINS = 10;
const DEFAULT_DRIFT_EVERY_MS = 3_600_000;
const DRIFT_DISABLED_ENV = 'SIDETRACK_CONNECTIONS_DRIFT_DISABLED';
const INCREMENTAL_SCOPES_ENV = 'SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES';

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

const INCREMENTAL_RANKER_ENV = 'SIDETRACK_CONNECTIONS_INCREMENTAL_RANKER';
const INCREMENTAL_SIMILARITY_ENV = 'SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY';
const TOPIC_EVERY_DRAINS_ENV = 'SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS';
const TOPIC_EVERY_MS_ENV = 'SIDETRACK_CONNECTIONS_TOPIC_EVERY_MS';
const DEFAULT_TOPIC_EVERY_DRAINS = 50;
const DEFAULT_TOPIC_EVERY_MS = 300_000;
const BUSY_LAST_SUCCESS_WINDOW_MS = 60_000;

const incrementalRankerEnabled = (): boolean => process.env[INCREMENTAL_RANKER_ENV] !== '0';
const incrementalSimilarityEnabled = (): boolean =>
  process.env[INCREMENTAL_SIMILARITY_ENV] !== '0';

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
  DISPATCH_RECORDED,
  DISPATCH_LINKED,
  QUEUE_CREATED,
  QUEUE_STATUS_SET,
  ANNOTATION_CREATED,
  ANNOTATION_NOTE_SET,
  ANNOTATION_DELETED,
  CAPTURE_RECORDED,
  CAPTURE_EXTRACTION_PRODUCED,
  RECALL_TOMBSTONE_TARGET,
  NAVIGATION_COMMITTED,
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
  TAB_SESSION_ATTRIBUTION_INFERRED,
  SELECTION_COPIED,
  SELECTION_PASTED,
  // Timeline observations indirectly contribute (timeline visits
  // become nodes; same canonicalUrl produces edges to threads).
  // Including the event type here keeps freshness bound to the
  // arrival of the underlying observation, even though the
  // materializer reads the daily projection rather than the
  // event payload directly.
  BROWSER_TIMELINE_OBSERVED,
]);

export interface CreateConnectionsMaterializerDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly timelineStore: TimelineStore;
  readonly store: ConnectionsStore;
  readonly embed?: VisitSimilarityEmbedder;
  readonly topicRevisionAlgorithm?: TopicAlgorithmVersion;
  readonly topicRevisionStore?: TopicRevisionStore;
  readonly engagementClassStore?: EngagementClassRevisionStore;
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

const resolvePositiveNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

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
  const incrementalGraphView = createIncrementalConnectionsGraphView();
  // Stage 5.2 W6 per-pass skip — cache the last engagement class
  // revision so a drain whose W6 key set contains no engagement-touching
  // keys can reuse it.
  let lastEngagementClassRevision: ReturnType<typeof buildEngagementClassRevision> | undefined;
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
  let pending = false;
  let running = false;
  let dirty = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let lastFailureAtMs = 0;
  let successfulDrainCount = 0;
  let lastDriftCheckAtMs = 0;
  let lastDriftReport: DriftReport | null = null;
  let lastFrontier: Record<string, number> | undefined;
  // W1c — wall-clock of the last drain pass START. Reference for the
  // minimum interval between drain STARTS (not just the within-drain
  // while-loop continuation), so a steady trigger stream can't pace
  // full rebuilds at the weak DRAIN_DEBOUNCE_MS cadence. 0 ⇒ the
  // first drain is never deferred.
  let lastDrainStartedAtMs = 0;
  // Stage 5.2 W1a — debounce timer. Coalesces burst event arrivals
  // (e.g. multiple tabs activating in sequence, peer-event imports)
  // into one drain. Cleared when a fresh requestDrain arrives within
  // the window. unref() so a pending timer doesn't keep the process
  // alive at shutdown.
  let drainDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  type TimelineEntryWithDimensions = TimelineDayProjection['entries'][number] & {
    readonly dimensions?: unknown;
  };
  type TimelineDayProjectionWithDimensions = Omit<TimelineDayProjection, 'entries'> & {
    readonly entries: readonly TimelineEntryWithDimensions[];
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const focusedWindowMsFromPayload = (
    payload: BrowserTimelineObservedPayload,
  ): number | undefined => {
    if (!isRecord(payload.dimensions)) return undefined;
    const engagement = payload.dimensions['engagement'];
    if (!isRecord(engagement)) return undefined;
    const focused = engagement['focusedWindowMs'];
    if (typeof focused !== 'number' || !Number.isFinite(focused) || focused < 0) {
      return undefined;
    }
    return focused;
  };

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
      if (left.fromVisitKey !== right.fromVisitKey) return left.fromVisitKey < right.fromVisitKey ? -1 : 1;
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
    readonly fullRebuild: boolean;
    readonly previousSnapshot: ConnectionsSnapshot | null;
    readonly embed: VisitSimilarityEmbedder;
    readonly evidenceByCanonicalUrl: Parameters<typeof corpusForVisitEntry>[1];
  }): Promise<VisitSimilarityRevision> => {
    const activeEntries = input.entries.filter(
      (entry) => focusedWindowMsFromEntry(entry) >= input.config.engagementGateMs,
    );
    const activeVisitIds = new Set(activeEntries.map(visitKeyForVisitEntry));
    if (activeEntries.length === 0) {
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
    const touchedVisitIds = input.fullRebuild ? activeVisitIds : input.touchedVisitIds;
    const entriesToEmbed = input.fullRebuild
      ? activeEntries
      : activeEntries.filter((entry) => touchedVisitIds.has(visitKeyForVisitEntry(entry)));
    if (input.fullRebuild) await resetHnswSimilarityFiles();
    const loadedHnswStore = await hnswSimilarityStore.ensureLoaded(
      deps.vaultRoot,
      RECALL_MODEL.embeddingDim,
    );
    loadedHnswSimilarityStore = loadedHnswStore;

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

    const firstEmbedding = embeddingsByVisitKey.values().next().value;
    if (firstEmbedding !== undefined) {
      for (const visitId of input.fullRebuild ? [] : input.touchedVisitIds) {
        if (!activeVisitIds.has(visitId)) await loadedHnswStore.delete(visitId);
      }
      for (const [visitId, embedding] of embeddingsByVisitKey) {
        await loadedHnswStore.insertOrUpdate(visitId, Array.from(embedding));
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

    const edgeByPair = new Map<string, VisitSimilarityEdge>();
    for (const edge of retainedSimilarityEdgesFromSnapshot(
      input.previousSnapshot,
      touchedVisitIds,
      activeVisitIds,
    )) {
      edgeByPair.set(similarityPairKey(edge.fromVisitKey, edge.toVisitKey), edge);
    }

    const queryVisitIds = input.fullRebuild ? activeVisitIds : touchedVisitIds;
    for (const visitId of [...queryVisitIds].sort()) {
      if (!activeVisitIds.has(visitId)) continue;
      for (const neighbor of await loadedHnswStore.queryTopK(visitId, 50)) {
        if (!activeVisitIds.has(neighbor.neighborVisitId)) continue;
        const cosine = Number((1 - neighbor.distance).toFixed(6));
        if (cosine < input.config.threshold) continue;
        const [fromVisitKey, toVisitKey] = orderedSimilarityPair(visitId, neighbor.neighborVisitId);
        const key = similarityPairKey(fromVisitKey, toVisitKey);
        const existing = edgeByPair.get(key);
        if (existing === undefined || cosine > existing.cosine) {
          edgeByPair.set(key, { fromVisitKey, toVisitKey, cosine });
        }
      }
    }
    await loadedHnswStore.persist();
    return {
      revisionId: input.revisionId,
      modelId: VISIT_SIMILARITY_MODEL_ID,
      modelRevision: RECALL_MODEL.revision,
      featureSchemaVersion: VISIT_SIMILARITY_FEATURE_SCHEMA_VERSION,
      threshold: input.config.threshold,
      edges: [...edgeByPair.values()].sort((left, right) => {
        if (left.fromVisitKey !== right.fromVisitKey) {
          return left.fromVisitKey < right.fromVisitKey ? -1 : 1;
        }
        if (left.toVisitKey !== right.toVisitKey) return left.toVisitKey < right.toVisitKey ? -1 : 1;
        return left.cosine - right.cosine;
      }),
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
    const payloads = collectTimelinePayloads(
      merged.filter(
        (e) => e.type === BROWSER_TIMELINE_OBSERVED && isBrowserTimelineObservedPayload(e.payload),
      ),
    );
    const grouped = groupByDay(payloads);
    const out: TimelineDayProjectionWithDimensions[] = [];
    for (const [date, dayPayloads] of grouped) {
      const focusedByEntryId = new Map<string, number>();
      for (const payload of dayPayloads) {
        const focusedWindowMs = focusedWindowMsFromPayload(payload);
        if (focusedWindowMs === undefined) continue;
        const entryId = entryIdFor(payload);
        focusedByEntryId.set(
          entryId,
          Math.max(focusedByEntryId.get(entryId) ?? 0, focusedWindowMs),
        );
      }
      const projection = buildDayProjection(date, dayPayloads);
      const entries: TimelineEntryWithDimensions[] = projection.entries.map((entry) => {
        const focusedWindowMs = focusedByEntryId.get(entry.id);
        if (focusedWindowMs === undefined) return entry;
        return {
          ...entry,
          dimensions: { engagement: { focusedWindowMs } },
        };
      });
      out.push({ ...projection, entries });
    }
    return out;
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
  ): MaterializerProgress => ({
    ...EMPTY_PROGRESS(MATERIALIZER_NAME, MATERIALIZER_VERSION),
    appliedDotIntervals: addDotsToIntervals(
      {},
      events.map((event) => event.dot),
    ),
    appliedFrontier: vectorFromEvents(events),
    snapshotRevisionId: snapshot.snapshotRevision ?? null,
  });

  const writeSnapshotWithProgress = async (
    snapshot: ConnectionsSnapshot,
    events: readonly AcceptedEvent[],
    dirtyScopes?: ReadonlySet<Scope>,
  ): Promise<void> => {
    const progress = progressForSnapshot(events, snapshot);
    await deps.store.writeSnapshotAndProgress(snapshot, progress, dirtyScopes);
    lastFrontier = progress.appliedFrontier;
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
    const merged = await deps.eventLog.readMerged();
    const existingProgress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
    const effectiveLastFrontier =
      lastFrontier ?? existingProgress?.appliedFrontier ?? undefined;
    const pendingEventsForDrain =
      effectiveLastFrontier === undefined
        ? merged
        : merged.filter(
            (event) => event.dot.seq > (effectiveLastFrontier[event.dot.replicaId] ?? 0),
          );
    mark(`readMerged events=${String(merged.length)}`);
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
      urlAccumulator = await seedUrlProjectionAccumulatorAsync(merged);
      tabSessionAccumulator = await seedTabSessionProjectionAccumulatorAsync(merged);
      projectionAccumulatorsInitialized = true;
      mark('projectionAccumulators.seed');
    }
    const vault = await readVaultStores(deps.vaultRoot);
    mark('readVaultStores');
    await yieldToEventLoop();
    const rawTimelineDays = buildTimelineDays(merged);
    mark(`buildTimelineDays days=${String(rawTimelineDays.length)}`);
    await yieldToEventLoop();
    // Stage 5.2 W6 per-pass skip — when no engagement-touching keys
    // arrived since last drain AND a cached revision exists, reuse it.
    const engagementTouchingKey = buildKeys.some(
      (k) => k.kind === 'engagementVisit' || k.kind === 'rankerLabels',
    );
    let engagementInputs: ReturnType<typeof buildEngagementClassifierInputs>;
    let engagementClassRevision: ReturnType<typeof buildEngagementClassRevision>;
    if (!engagementTouchingKey && lastEngagementClassRevision !== undefined) {
      // Reuse cached revision; we still need the inputs for downstream
      // enrichTimelineDaysWithEngagement(...) which reads engagement
      // dimensions per visit. Recomputing inputs alone is cheaper than
      // re-running the classifier + putRevision.
      engagementInputs = buildEngagementClassifierInputs(merged, rawTimelineDays);
      engagementClassRevision = lastEngagementClassRevision;
      mark(`engagementClassifier skip (w6 reuse) inputs=${String(engagementInputs.length)}`);
    } else {
      engagementInputs = buildEngagementClassifierInputs(merged, rawTimelineDays);
      engagementClassRevision = buildEngagementClassRevision(engagementInputs, {
        producedAt: maxAcceptedAtMs(merged),
      });
      mark(`engagementClassifier inputs=${String(engagementInputs.length)}`);
      await engagementClassStore.putRevision(engagementClassRevision);
      mark('engagementClassStore.putRevision');
      lastEngagementClassRevision = engagementClassRevision;
    }
    await yieldToEventLoop();
    const timelineDays = enrichTimelineDaysWithEngagement(rawTimelineDays, engagementInputs);
    mark('enrichTimelineDays');
    await yieldToEventLoop();
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
    const similarityEligibleCount = similarityEntries.filter(
      (entry) => focusedWindowMsFromEntry(entry) >= similarityConfig.engagementGateMs,
    ).length;
    const similarityPairBudget = Math.max(
      0,
      (similarityEligibleCount * (similarityEligibleCount - 1)) / 2,
    );
    const dirtyScopes = invalidationKeysToScopes(buildKeys);
    const previousSnapshotForRanker = await deps.store.readCurrent();
    const persistentHnswSimilarityMode = incrementalSimilarityEnabled();
    const loadedHnswStoreForGate = persistentHnswSimilarityMode
      ? await hnswSimilarityStore.ensureLoaded(deps.vaultRoot, RECALL_MODEL.embeddingDim)
      : null;
    if (loadedHnswStoreForGate !== null) loadedHnswSimilarityStore = loadedHnswStoreForGate;
    const hnswFullRebuild =
      existingProgress === null ||
      existingProgress.materializerVersion !== MATERIALIZER_VERSION ||
      (loadedHnswStoreForGate?.elementCount() ?? 0) === 0 ||
      (loadedHnswStoreForGate?.recoveredFromCorruption() ?? false);
    const pageEvidenceByCanonicalUrl = await ensurePageEvidenceForTimelineEntries(
      deps.vaultRoot,
      similarityEntries,
    );
    mark(`pageEvidence.ensure records=${String(pageEvidenceByCanonicalUrl.size)}`);
    const pageEvidenceVectorsByVectorId = await readPageEvidenceVectorMap(
      deps.vaultRoot,
      pageEvidenceByCanonicalUrl.values(),
    );
    mark(`pageEvidence.vectorMapRead vectors=${String(pageEvidenceVectorsByVectorId.size)}`);
    const pageContentChunksByCanonicalUrl = await readPageContentChunksForCanonicalUrls(
      deps.vaultRoot,
      [...pageEvidenceByCanonicalUrl.keys()],
    );
    mark(
      `pageEvidence.chunkRead indexedChunkPages=${String(pageContentChunksByCanonicalUrl.size)}`,
    );
    const expectedSimilarityRevisionId = computeVisitSimilarityRevisionId(similarityEntries, {
      ...similarityConfig,
      evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
      evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId,
      pageContentChunksByCanonicalUrl,
    });
    const cachedSimilarityRevision = await readVisitSimilarityRevision(
      deps.vaultRoot,
      expectedSimilarityRevisionId,
    );
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
      const touchedVisitIds = collectTouchedVisits(dirtyScopes, pendingEventsForDrain);
      usedHotSimilarityPath = true;
      hotSimNewEmbedded = hnswFullRebuild ? similarityEligibleCount : touchedVisitIds.size;
      mark(`buildVisitSimilarityHnsw.start entries=${String(similarityEntries.length)}`);
      try {
        visitSimilarity = await buildHnswVisitSimilarity({
          entries: similarityEntries,
          revisionId: expectedSimilarityRevisionId,
          config: similarityConfig,
          touchedVisitIds,
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
        visitSimilarity = await buildVisitSimilarity(similarityEntries, deps.embed ?? defaultEmbed, {
          ...similarityConfig,
          evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
          evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId,
          pageContentChunksByCanonicalUrl,
        });
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
          visitSimilarity = await buildVisitSimilarity(
            similarityEntries,
            deps.embed ?? defaultEmbed,
            {
              ...similarityConfig,
              evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
              evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId,
              pageContentChunksByCanonicalUrl,
            },
          );
        }
      }
      visitSimilarity ??= buildVisitSimilarityIncremental({
        index: incrementalSimilarityIndex,
        entries: similarityEntries,
        embeddingsByVisitKey,
        options: {
          threshold: VISIT_SIMILARITY_DEFAULT_THRESHOLD,
          topK: VISIT_SIMILARITY_DEFAULT_TOP_K,
          evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
          evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId,
          pageContentChunksByCanonicalUrl,
        },
      });
      mark(
        `buildVisitSimilarityIncremental pairs=${String(similarityPairBudget)} newEmbedded=${String(newEntries.length)} indexSize=${String(incrementalSimilarityIndex.size())}`,
      );
    } else {
      // Legacy path with PR #141's resolved similarityConfig
      // (threshold / topK / engagementGateMs / lexical fallback).
      visitSimilarity = await buildVisitSimilarity(similarityEntries, deps.embed ?? defaultEmbed, {
        ...similarityConfig,
        evidenceByCanonicalUrl: pageEvidenceByCanonicalUrl,
        evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId,
        pageContentChunksByCanonicalUrl,
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
    const shouldRunTopicRevision =
      previousTopicRevision === null ||
      (topicSimilarityChanged && (topicCadenceDue || forcePendingTopicRecompute));
    let topicRevision;
    if (!shouldRunTopicRevision && previousTopicRevision !== null) {
      // Topic clustering (especially leiden-cpm) is global rather than
      // cheaply IVM-able. During heavy ingest we accept topics being a
      // few minutes stale; repeatedly freezing the graph for ~30 seconds
      // is worse UX than serving the previous topic revision.
      topicRevision = previousTopicRevision;
      mark(
        `topicRevision cadenceSkip drains=${String(topicDrainsSinceLastRun)} similarityChanged=${String(topicSimilarityChanged)}`,
      );
      if (topicSimilarityChanged) pendingTopicRecompute = true;
    } else if (
      previousTopicRevision !== null &&
      previousTopicRevision.revisionId === expectedTopicRevisionId
    ) {
      topicRevision = previousTopicRevision;
    } else if (useTopicAccumulatorFastPath) {
      topicRevision = await buildTopicRevisionFromAccumulator({
        accumulator: topicAccumulator,
        visits: topicVisits,
        visitSimilarity,
        ...(previousTopicRevision === null ? {} : { previousRevision: previousTopicRevision }),
      });
      mark('buildTopicRevisionFromAccumulator (w4 fast path)');
    } else {
      topicRevision = await buildSelectedTopicRevision({
        visits: topicVisits,
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
          visits: topicVisits,
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
        visits: topicVisits,
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
          visits: topicVisits,
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
          visits: topicVisits,
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
      evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId,
      engagementClassRevision,
    };
    mark('projectionAccumulators.derive');
    await yieldToEventLoop();
    const baseSnapshot = buildConnectionsSnapshot(input);
    incrementalGraphView.seed(baseSnapshot);
    if (incrementalGraphPlan.pendingEventCount > 0) {
      mark(
        `incrementalGraph plan rowLocal=${String(incrementalGraphPlan.rowLocalEventCount)} fullReducer=${String(incrementalGraphPlan.fullReducerEventCount)} ready=${String(incrementalGraphPlan.canUseRowLocalOnly)}`,
      );
    }
    mark(
      `buildConnectionsSnapshot base nodes=${String(baseSnapshot.nodes.length)} edges=${String(baseSnapshot.edges.length)}`,
    );
    const scopeIncrementalEnabled =
      process.env[INCREMENTAL_SCOPES_ENV] !== '0' &&
      process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] === '1' &&
      deps.store.replaceScopeRows !== undefined &&
      previousSnapshotForRanker !== null;
    let wroteScopeIncremental = false;
    const dirtyScopeWrites =
      process.env[INCREMENTAL_SCOPES_ENV] !== '0' &&
      previousSnapshotForRanker !== null &&
      dirtyScopes.length > 0
        ? new Set(dirtyScopes)
        : undefined;
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
        const progress = progressForSnapshot(merged, baseSnapshot);
        await deps.store.replaceScopeRows!({
          scopes: dirtyScopes,
          nodes: scoped.nodes,
          edges: scoped.edges,
          progress,
        });
        lastFrontier = progress.appliedFrontier;
        wroteScopeIncremental = true;
        mark(
          `replaceScopeRows scopes=${String(dirtyScopes.length)} nodes=${String(scoped.nodes.length)} edges=${String(scoped.edges.length)}`,
        );
      }
    }
    if (!wroteScopeIncremental) {
      await writeSnapshotWithProgress(baseSnapshot, merged, dirtyScopeWrites);
      mark('writeSnapshotAndProgress baseSnapshot');
    }
    await yieldToEventLoop();
    const rankerRetrainResult = await rankerRetrainer({
      merged,
      snapshot: baseSnapshot,
      pageEvidenceByCanonicalUrl,
      evidenceVectorsByVectorId: pageEvidenceVectorsByVectorId,
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
      // consumers (recorder).
      if (process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] !== '1') {
        closestVisitRanker = await closestVisitRankerLoader();
        mark(
          `loadClosestVisitRanker status=${closestVisitRanker.status} revision=${closestVisitRanker.activeRevisionId ?? 'none'}`,
        );
        if (closestVisitRanker.status === 'ready') {
          await yieldToEventLoop();
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
                closestVisitRanker: closestVisitRanker.ranker,
                rankerFrontier,
                inputFrontier: vectorFromEvents(merged),
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
                closestVisitRanker: closestVisitRanker.ranker,
              },
              baseSnapshot,
            );
            mark(
              `augmentConnectionsSnapshot ranker-augmented nodes=${String(finalSnapshot.nodes.length)} edges=${String(finalSnapshot.edges.length)} full=${String(producerRevisionChanged)}`,
            );
          }
          lastRankerProducerRevision = producerRevision;
          await writeSnapshotWithProgress(finalSnapshot, merged, dirtyScopeWrites);
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
      maxAcceptedAtMs: maxAcceptedAtMs(merged),
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
    await maybeRunShadowDriftCheck(finalSnapshot);
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
    if (seq <= lastWorkerDrainSeqCompleted) {
      // A newer drain already completed; ignore stale output.
      return;
    }
    if (!result.ok) {
      throw new Error(result.error ?? 'subprocess drain failed without a message');
    }
    lastWorkerDrainSeqCompleted = seq;
    const progress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
    if (progress !== null && progress.materializerVersion === MATERIALIZER_VERSION) {
      lastFrontier = progress.appliedFrontier;
    }
    lastSuccessAt = new Date().toISOString();
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

  const runShadowRebuildAndCompare = async (
    eventLog: EventLog,
    currentSnapshot: ConnectionsSnapshot,
    currentProgress: MaterializerProgress,
  ): Promise<DriftReport> => {
    const shadowRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-shadow-'));
    const shadowStore = new SqliteConnectionsStore(deps.vaultRoot, {
      databasePath: join(shadowRoot, 'current.shadow.db'),
    });
    const previousDriftDisabled = process.env[DRIFT_DISABLED_ENV];
    const previousInprocess = process.env['SIDETRACK_CONNECTIONS_INPROCESS'];
    process.env[DRIFT_DISABLED_ENV] = '1';
    process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = '1';
    try {
      const shadowMaterializer = createConnectionsMaterializer({
        ...deps,
        store: shadowStore,
        diagnosticsStore: { write: async () => undefined },
        diagnosticsLogger: () => {},
      });
      await shadowMaterializer.catchUp(eventLog);
      const shadowSnapshot = await shadowStore.readCurrent();
      if (shadowSnapshot === null) {
        throw new Error('shadow rebuild did not write a snapshot');
      }
      const shadowEvents = await eventLog.readMerged();
      return compareConnectionsDrift({
        checkedAt: diagnosticsNow().toISOString(),
        materializerVersion: MATERIALIZER_VERSION,
        liveSnapshot: currentSnapshot,
        shadowSnapshot,
        liveProgress: currentProgress,
        shadowEvents,
      });
    } finally {
      if (previousDriftDisabled === undefined) delete process.env[DRIFT_DISABLED_ENV];
      else process.env[DRIFT_DISABLED_ENV] = previousDriftDisabled;
      if (previousInprocess === undefined) delete process.env['SIDETRACK_CONNECTIONS_INPROCESS'];
      else process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = previousInprocess;
      shadowStore.close();
      await rm(shadowRoot, { recursive: true, force: true });
    }
  };

  const maybeRunShadowDriftCheck = async (currentSnapshot: ConnectionsSnapshot): Promise<void> => {
    if (process.env[DRIFT_DISABLED_ENV] === '1') return;
    successfulDrainCount += 1;
    const everyDrains = resolvePositiveNumberEnv(
      'SIDETRACK_CONNECTIONS_DRIFT_EVERY_DRAINS',
      DEFAULT_DRIFT_EVERY_DRAINS,
    );
    const everyMs = resolvePositiveNumberEnv(
      'SIDETRACK_CONNECTIONS_DRIFT_EVERY_MS',
      DEFAULT_DRIFT_EVERY_MS,
    );
    const nowMs = Date.now();
    if (successfulDrainCount % everyDrains !== 0 && nowMs - lastDriftCheckAtMs < everyMs) {
      return;
    }
    const progress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
    if (progress === null || progress.materializerVersion !== MATERIALIZER_VERSION) return;
    try {
      const report = await runShadowRebuildAndCompare(deps.eventLog, currentSnapshot, progress);
      lastDriftReport = report;
      lastDriftCheckAtMs = nowMs;
      if (report.conclusion === 'drift') {
        console.warn(
          `[connections] materializer drift detected nodes=${JSON.stringify(
            report.nodeDiff,
          )} edges=${JSON.stringify(report.edgeDiff)} missingDots=${String(
            report.missingDots.length,
          )} extraDots=${String(report.extraDots.length)}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[connections] materializer drift check failed: ${message}`);
    }
  };

  const drain = async (): Promise<void> => {
    while (dirty) {
      const passStartedAtMs = Date.now();
      lastDrainStartedAtMs = passStartedAtMs;
      dirty = false;
      try {
        if (shouldUseWorker()) {
          await drainViaWorker();
        } else {
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
      }
      // Stage 5.2 W1b — coalesce at the DRAIN level. Only relevant when
      // `dirty` was re-set DURING the rebuild (a HANDLES event arrived
      // mid-pass): without this the loop would immediately run another
      // full O(graph) rebuild with zero gap. Wait out the remainder of
      // DRAIN_MIN_INTERVAL_MS so events that arrived during the rebuild
      // + this gap collapse into the next single pass. Fire-then-
      // awaitIdle callers never hit this (dirty is false post-pass).
      if (dirty) {
        const remainingMs = resolveDrainMinIntervalMs() - (Date.now() - passStartedAtMs);
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

  const requestDrain = (): void => {
    dirty = true;
    pending = true;
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
    drainDebounceTimer = setTimeout(() => {
      drainDebounceTimer = null;
      startDrainWhenIntervalElapsed();
    }, DRAIN_DEBOUNCE_MS);
    drainDebounceTimer.unref();
  };

  const onAccepted: Materializer['onAccepted'] = (event) => {
    if (!HANDLES.has(event.type)) return;
    // Stage 5.2 W7 — accumulate Group B events into the dirty-source
    // queue before scheduling a drain. Non-Group-B events return false
    // and don't touch the queue; Group B events mark their sourceUnitId
    // dirty (or tombstoned) and optionally record the latest extraction
    // revisionId. No I/O, no chunk/embed work — that's the reconciler's
    // job. The buildAndWrite drain remains the byte-determinism reference;
    // this queue is purely for the off-path content reconciler.
    foldGroupBEventIntoQueue(dirtySourceQueue, event);
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
    incrementalGraphView.fold(event);
    requestDrain();
  };

  const resetInMemoryProjectionState = (): void => {
    projectionAccumulatorsInitialized = false;
    urlAccumulator = createEmptyUrlProjectionAccumulator();
    tabSessionAccumulator = createEmptyTabSessionProjectionAccumulator();
    incrementalGraphView.reset();
    lastEngagementClassRevision = undefined;
    lastRankerProducerRevision = undefined;
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
    try {
      const progress = await deps.store.readMaterializerProgress(MATERIALIZER_NAME);
      const merged = await deps.eventLog.readMerged();
      const versionMatches = progress?.materializerVersion === MATERIALIZER_VERSION;
      if (progress !== null && versionMatches) {
        lastFrontier = progress.appliedFrontier;
        const pendingEvents = merged.filter(
          (event) => !intervalsContainDot(progress.appliedDotIntervals, event.dot),
        );
        const ordered = sortAcceptedEvents(pendingEvents);
        if (ordered.length === 0) {
          lastBuildInvalidations = [];
          lastSuccessAt = new Date().toISOString();
          lastError = null;
          return;
        }
        if (ordered.length <= BACKLOG_FALLBACK_THRESHOLD) {
          // Phase 1 intentionally keeps the apply path as a full rebuild.
          // The durable dot-interval filter is the safety foundation for
          // Phase 2's scoped recompute.
          if (process.env[INCREMENTAL_SCOPES_ENV] !== '0') {
            for (const event of ordered) {
              for (const key of invalidationsForEvent(event)) accumulatedInvalidations.push(key);
            }
          }
        }
      }
      // 2026-05 cold-start fix: route catchUp through the worker the
      // same way drain does. The previous direct buildAndWrite()
      // pinned the main thread for the full re-projection (~30 s on a
      // 12 k-event prod vault), which queued /status and every other
      // HTTP request behind it. shouldUseWorker() respects the env
      // opt-out AND skips itself when we're already inside a worker.
      if (shouldUseWorker()) {
        await drainViaWorker();
      } else {
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
    if (lastError !== null) return 'failed';
    if (!pending) return lastSuccessAt === null ? 'degraded' : 'healthy';
    if (lastSuccessAt === null) return 'degraded';
    return Date.now() - Date.parse(lastSuccessAt) <= BUSY_LAST_SUCCESS_WINDOW_MS
      ? 'busy'
      : 'degraded';
  };

  const health: Materializer['health'] = (): MaterializerHealth => {
    const status = healthStatus();
    return {
      status,
      lastSuccessAt,
      lastError,
      pending,
      ...(lastFrontier === undefined ? {} : { frontier: lastFrontier }),
      ...(lastDriftReport === null
        ? {}
        : {
            lastDriftCheck: {
              at: lastDriftReport.checkedAt,
              conclusion: lastDriftReport.conclusion,
              nodeDiffSummary: lastDriftReport.nodeDiff,
              edgeDiffSummary: lastDriftReport.edgeDiff,
            },
          }),
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

  return {
    name: MATERIALIZER_NAME,
    handles: HANDLES,
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
