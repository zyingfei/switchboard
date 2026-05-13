import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../../annotations/events.js';
import { buildEngagementClassRevision } from '../../connections/engagementClassifier.js';
import { readVaultStores } from '../../connections/loader.js';
import {
  collectMaterializerDiagnostics,
  createMaterializerDiagnosticsStore,
  logMaterializerDiagnostics,
  type MaterializerDiagnostics,
  type MaterializerDiagnosticsStore,
} from '../../connections/materializerDiagnostics.js';
import {
  buildConnectionsSnapshot,
  type ClosestVisitRanker,
  type ConnectionsInput,
} from '../../connections/snapshot.js';
import type { ConnectionsStore } from '../../connections/snapshot.js';
import {
  buildTopicRevision,
  type BuildTopicRevisionInput,
  type TopicVisit,
} from '../../connections/topicClusterer.js';
import {
  deriveUserAssertedRelations,
  knownCanonicalUrlsFor,
} from '../../connections/userAssertedRelations.js';
import { buildHdbscanTopicRevision } from '../../connections/hdbscanClusterer.js';
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
  readActiveClosestVisitRankerRevisionManifest,
  readClosestVisitRankerRevision,
} from '../../producers/closest-visit-revision.js';
import {
  TOPIC_HDBSCAN_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionId,
  createTopicRevisionStore,
  resolveTopicCosineThreshold,
  type TopicAlgorithmVersion,
  type TopicRevision,
  type TopicRevisionStore,
} from '../../producers/topic-revision.js';
import { loadRankerModel, predictRanker, type LightGBMModel } from '../../ranker/predict.js';
import { maybeRetrainClosestVisitRanker, type RankerRetrainer } from '../../ranker/retrain.js';
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
} from '../../connections/visitSimilarity.js';
import {
  createDirtySourceQueue,
  foldGroupBEventIntoQueue,
  type DirtySourceQueueSnapshot,
} from '../../recall/content-lane.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { embed as defaultEmbed } from '../../recall/embedder.js';
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
import type { AcceptedEvent } from '../causal.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
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
  readonly diagnosticsStore?: MaterializerDiagnosticsStore;
  readonly diagnosticsLogger?: (diagnostics: MaterializerDiagnostics) => void;
  readonly diagnosticsNow?: () => Date;
}

type TopicRevisionBuilder = (input: BuildTopicRevisionInput) => Promise<TopicRevision>;

interface LoadedClosestVisitRanker {
  readonly ranker: ClosestVisitRanker;
  readonly model: LightGBMModel;
}

const topicRevisionBuilderFor = (algorithm: TopicAlgorithmVersion): TopicRevisionBuilder => {
  switch (algorithm) {
    case TOPIC_UNION_FIND_REVISION_KEY:
      return buildTopicRevision;
    case TOPIC_HDBSCAN_REVISION_KEY:
      return buildHdbscanTopicRevision;
  }
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
  readonly drainContentLaneQueue: (
    reconciler: ContentLaneSourceUnitReconciler,
  ) => Promise<number>;
}

export interface ContentLaneSourceUnitReconciler {
  readonly reconcileSourceUnit: (sourceUnitId: string) => Promise<boolean>;
  readonly reconcileTombstone: (sourceUnitId: string) => Promise<boolean>;
}

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
  let pending = false;
  let running = false;
  let dirty = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let lastFailureAtMs = 0;
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

  const loadClosestVisitRanker = async (): Promise<LoadedClosestVisitRanker | null> => {
    const manifest = await readActiveClosestVisitRankerRevisionManifest(deps.vaultRoot);
    if (manifest === null) return null;
    const revision = await readClosestVisitRankerRevision(deps.vaultRoot, manifest.revisionId);
    if (revision === null) return null;
    try {
      const model = await loadRankerModel(revision);
      return {
        model,
        ranker: {
          revisionId: model.revisionId,
          predict: (features) => predictRanker(features, model),
        },
      };
    } catch {
      return null;
    }
  };

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

  const buildAndWrite = async (): Promise<void> => {
    const phaseLogs = process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] === '1';
    const phaseStart = Date.now();
    let phaseLast = phaseStart;
    const mark = (label: string): void => {
      if (!phaseLogs) return;
      const now = Date.now();
      // eslint-disable-next-line no-console
      console.warn(
        `[connections-phase] ${label} dt=${String(now - phaseLast)}ms total=${String(now - phaseStart)}ms`,
      );
      phaseLast = now;
    };
    // Stage 5.2 W6 — snapshot the invalidation keys accumulated since
    // the last drain entry, then clear the accumulator. dedupe via JSON
    // sig so logs and downstream skip-gates see a normalised set.
    const buildKeys = dedupeInvalidationKeys(accumulatedInvalidations);
    accumulatedInvalidations = [];
    lastBuildInvalidations = buildKeys;
    mark(`w6 keys=${String(buildKeys.length)}`);
    const merged = await deps.eventLog.readMerged();
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
    const similarityConfig: EffectiveVisitSimilarityConfig =
      resolveVisitSimilarityConfig();
    const expectedSimilarityRevisionId = computeVisitSimilarityRevisionId(
      similarityEntries,
      similarityConfig,
    );
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
    const hotSimilarityMode =
      process.env['SIDETRACK_CONNECTIONS_HOT_SIMILARITY'] === '1';
    const hotSimilarityDecision = hotSimilarityMode
      ? decideHotPathEmbed(
          embedderWarmthTracker.snapshot(incrementalSimilarityIndex.size()),
        )
      : { shouldEmbedOnHotPath: false as const };
    let visitSimilarity;
    if (
      cachedSimilarityRevision !== null &&
      !hotSimilarityDecision.shouldEmbedOnHotPath
    ) {
      visitSimilarity = cachedSimilarityRevision;
    } else if (hotSimilarityDecision.shouldEmbedOnHotPath) {
      // Embed only entries not yet in the index. The legacy path embeds
      // every entry every drain; the fast path amortises across drains.
      const newEntries = similarityEntries.filter(
        (entry) => !incrementalSimilarityIndex.has(visitKeyForVisitEntry(entry)),
      );
      const embeddingsByVisitKey = new Map<string, Float32Array>();
      if (newEntries.length > 0) {
        const texts = newEntries.map((e) => `passage: ${corpusForVisitEntry(e)}`);
        try {
          const embedded = await (deps.embed ?? defaultEmbed)(texts);
          for (let i = 0; i < newEntries.length; i += 1) {
            const embedding = embedded[i];
            if (embedding !== undefined) {
              embeddingsByVisitKey.set(visitKeyForVisitEntry(newEntries[i]!), embedding);
            }
          }
        } catch (error) {
          // Fast-path embed failure: log + fall back to legacy path.
          // eslint-disable-next-line no-console
          console.warn(
            `[connections] W3 fast-path embed failed; falling back: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          visitSimilarity = await buildVisitSimilarity(
            similarityEntries,
            deps.embed ?? defaultEmbed,
            similarityConfig,
          );
        }
      }
      if (visitSimilarity === undefined) {
        visitSimilarity = buildVisitSimilarityIncremental({
          index: incrementalSimilarityIndex,
          entries: similarityEntries,
          embeddingsByVisitKey,
          options: { threshold: VISIT_SIMILARITY_DEFAULT_THRESHOLD, topK: VISIT_SIMILARITY_DEFAULT_TOP_K },
        });
      }
      mark(
        `buildVisitSimilarityIncremental newEmbedded=${String(newEntries.length)} indexSize=${String(incrementalSimilarityIndex.size())}`,
      );
    } else {
      // Legacy path with PR #141's resolved similarityConfig
      // (threshold / topK / engagementGateMs / lexical fallback).
      visitSimilarity = await buildVisitSimilarity(
        similarityEntries,
        deps.embed ?? defaultEmbed,
        similarityConfig,
      );
      mark('buildVisitSimilarity');
    }
    if (cachedSimilarityRevision === null && !hotSimilarityDecision.shouldEmbedOnHotPath) {
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
            ? `${e.fromVisitKey} ${e.toVisitKey}`
            : `${e.toVisitKey} ${e.fromVisitKey}`,
        ),
      );
      let removedCount = 0;
      for (const edge of prevSimilarityEdges) {
        const sig =
          edge.a < edge.b ? `${edge.a} ${edge.b}` : `${edge.b} ${edge.a}`;
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
        firstObservedAt: entry.firstSeenAt ?? entry.lastSeenAt ?? '1970-01-01T00:00:00.000Z',
        lastObservedAt: entry.lastSeenAt ?? entry.firstSeenAt ?? '1970-01-01T00:00:00.000Z',
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
    const hotTopicsMode = process.env['SIDETRACK_CONNECTIONS_HOT_TOPICS'] === '1';
    const useTopicAccumulatorFastPath =
      hotTopicsMode && (await topicAccumulator.getComponents()).length > 0;
    let topicRevision;
    if (
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
    mark(
      `topicRevision cacheHit=${String(topicRevision === previousTopicRevision)} fastPath=${String(useTopicAccumulatorFastPath)}`,
    );
    if (topicRevision !== previousTopicRevision) {
      await topicRevisionStore.putActiveRevision(topicRevision);
      mark('putActiveTopicRevision');
    }
    await yieldToEventLoop();
    const input: ConnectionsInput = {
      events: merged,
      ...vault,
      timelineDays,
      tabSessionProjection,
      urlProjection,
      visitSimilarity,
      topicRevision,
      engagementClassRevision,
    };
    mark('projectionAccumulators.derive');
    await yieldToEventLoop();
    const baseSnapshot = buildConnectionsSnapshot(input);
    mark(`buildConnectionsSnapshot base nodes=${String(baseSnapshot.nodes.length)} edges=${String(baseSnapshot.edges.length)}`);
    // Stage 5.2 W3b — publish the base snapshot immediately so HTTP
    // routes (and the side panel that reads them) have a valid current
    // snapshot to serve. The ranker-augmented build below adds
    // closest_visit edges; on a 5K-event vault that pass takes ~20s of
    // synchronous CPU which would otherwise block HTTP.
    await deps.store.putCurrent(baseSnapshot);
    mark('putCurrent baseSnapshot');
    await yieldToEventLoop();
    const rankerRetrainResult = await rankerRetrainer({ merged, snapshot: baseSnapshot });
    mark('rankerRetrainer');
    // Track the snapshot we ultimately wrote so diagnostics see the
    // ranker-augmented form when it was produced, the base form when
    // the ranker pass was skipped.
    let finalSnapshot = baseSnapshot;
    let closestVisitRanker: Awaited<ReturnType<typeof loadClosestVisitRanker>> | null = null;
    try {
      // Stage 5.2 W3b/c — gate the ranker-augmented build behind
      // SIDETRACK_SKIP_RANKER_SNAPSHOT for HTTP-latency-sensitive
      // consumers (recorder).
      if (process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] !== '1') {
        closestVisitRanker = await loadClosestVisitRanker();
        mark(`loadClosestVisitRanker ranker=${String(closestVisitRanker !== null)}`);
        if (closestVisitRanker !== null) {
          await yieldToEventLoop();
          finalSnapshot = buildConnectionsSnapshot({
            ...input,
            closestVisitRanker: closestVisitRanker.ranker,
          });
          mark(`buildConnectionsSnapshot ranker-augmented nodes=${String(finalSnapshot.nodes.length)} edges=${String(finalSnapshot.edges.length)}`);
          await deps.store.putCurrent(finalSnapshot);
          mark('putCurrent ranker-augmented');
        }
      } else {
        mark('ranker-augmented skipped (SIDETRACK_SKIP_RANKER_SNAPSHOT=1)');
      }
    } finally {
      closestVisitRanker?.model.dispose();
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
    });
    try {
      await diagnosticsStore.write(diagnostics);
    } catch (err) {
      // Diagnostics is observability — never fail the drain on its IO.
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[materializer-diag] write failed: ${message}`);
    }
    diagnosticsLogger(diagnostics);
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
  const pickSubprocessRunner = (): ((
    job: { vaultRoot: string; seq: number },
  ) => Promise<{ seq: number; ok: boolean; snapshotRevision?: string; error?: string }>) => {
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
    if (!isMainThread) return false;
    // Explicit in-process override wins (used by unit + e2e tests that
    // need to assert against in-process accumulator state).
    if (process.env['SIDETRACK_CONNECTIONS_INPROCESS'] === '1') return false;
    // Either subprocess flavour qualifies. The child_process flavour is
    // the default; the worker_thread flavour is opt-in via WORKER=1.
    if (process.env['SIDETRACK_CONNECTIONS_WORKER'] === '1') return true;
    if (process.env['SIDETRACK_CONNECTIONS_CHILD'] === '1') return true;
    return false;
  };

  const drain = async (): Promise<void> => {
    while (dirty) {
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
      if (!dirty || running) return;
      startDrain();
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
    // job. The buildAndWrite drain remains the byte-determinism oracle;
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
    requestDrain();
  };

  const catchUp: Materializer['catchUp'] = async () => {
    pending = true;
    // Stage 5.2 W2b/c wiring — catchUp is the recovery / boot-time path;
    // force a re-seed so any drift between the in-memory accumulators
    // and the event log is corrected. The next buildAndWrite (or worker
    // pass) seeds.
    projectionAccumulatorsInitialized = false;
    urlAccumulator = createEmptyUrlProjectionAccumulator();
    tabSessionAccumulator = createEmptyTabSessionProjectionAccumulator();
    // Stage 5.2 W6 per-pass — invalidate the engagement cache on
    // catchUp so the next drain rebuilds against the fresh log.
    lastEngagementClassRevision = undefined;
    try {
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
      dirty = false;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Don't spin during catchUp — leave dirty=true so the next
      // event trigger (after cooldown) retries.
      dirty = true;
    } finally {
      pending = dirty || running;
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

  const health: Materializer['health'] = (): MaterializerHealth => ({
    status: lastError !== null ? 'failed' : pending ? 'degraded' : 'healthy',
    lastSuccessAt,
    lastError,
    pending,
  });

  const getDirtySources = (): DirtySourceQueueSnapshot => dirtySourceQueue.snapshot();
  const clearDirtySources = (sourceUnitIds: readonly string[]): void => {
    dirtySourceQueue.clear(sourceUnitIds);
  };
  const getInvalidationsSinceLastBuild = (): readonly InvalidationKey[] =>
    lastBuildInvalidations;
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
    const dirty = snapshot.dirtySourceUnitIds.filter(
      (id) => !tombstones.includes(id),
    );
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
    name: 'connections',
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
