import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  getCanonicalCollisionSnapshot,
  type CanonicalCollisionSamplePair,
} from '../page-content/canonicalize-telemetry.js';
import {
  scanForOverCollapsedPageContent,
  type OverCollapsedRecord,
} from '../page-content/store.js';
import {
  rankerMethodologySpineDiagnosticsFromTrainQuality,
  type MaterializerRankerMethodologySpineDiagnostics,
} from '../connections/materializerDiagnostics.js';
import {
  expectedClosestVisitRankerSchema,
  readActiveClosestVisitRankerRevisionManifest,
  readActiveClosestVisitRankerRevisionManifestProbe,
  readClosestVisitRankerRevision,
} from '../producers/closest-visit-revision.js';
import {
  TOPIC_HDBSCAN_REVISION_KEY,
  TOPIC_INCREMENTAL_REVISION_KEY,
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionStore,
} from '../producers/topic-revision.js';
import {
  buildServedTopicProducerReport,
  type ServedTopicProducerReport,
} from '../connections/servedTopicProducer.js';
import {
  HOT_SIMILARITY_ENV,
  HOT_TOPICS_ENV,
  hotSimilarityModeEnabled,
  hotTopicsModeEnabled,
} from '../connections/hotPathMode.js';
import { projectFeedback } from '../feedback/projection.js';
import { loadDefaultUsearch } from '../recall/ann-index.js';
// Pure module (no imports) — safe to static-import into this
// status-reachable module. Surfaces the request-driven shadow-diff window;
// the enforcement flag itself is read inline from process.env below to keep
// the heavy learnedRerank.ts graph out of the status path (statusContract).
import { peekRankerShadowDiff } from '../recall-v2/rankerShadowDiff.js';
import {
  RECALL_IMPRESSION_SHIP_GATE_REASON_PREFIX,
  minRecallImpressionPositiveGroups,
  readRecallImpressionRetrainState,
  summarizeRecallImpressionEvents,
  weakNegativesEnabled,
} from '../ranker/retrain-impressions.js';
import {
  DEFAULT_RANKER_RETRAIN_COOLDOWN_MS,
  DEFAULT_RANKER_RETRAIN_LABEL_THRESHOLD,
  RANKER_RETRAIN_LABEL_THRESHOLD_ENV,
  fingerprintFeedbackTrainingLabels,
  planRankerRetrain,
  readRankerRetrainState,
  type RankerRetrainSkipReason,
} from '../ranker/retrain.js';
// Light import: onlineLabelLedger only pulls train.js (already in this
// module's graph via retrain). The SIDETRACK_ONLINE_RANKER flag is read
// from process.env directly so we do NOT static-import the heavy
// onlineHead.ts (predict/snapshot) into this status-reachable module.
import { readOnlineRankerState } from '../ranker/onlineLabelLedger.js';
// Learned aggregator-stats SHADOW (observe-only, default ON). Every module
// in this chain is lightweight (URL parsing + typed-event folding, no
// recall/embedder graph) — safe to static-import here per this file's own
// statusContract discipline (see the peekRankerShadowDiff comment above).
import { classifyAggregatorPageForUrl } from '../ranker/aggregatorProfiles.js';
import {
  applyAggregatorObservations,
  buildAggregatorShadowAgreement,
  classifyLearnedAggregatorUrl,
  createEmptyAggregatorStatsState,
  type AggregatorShadowAgreement,
} from '../ranker/learnedAggregatorStats.js';
import type { AggregatorPageType } from '../ranker/aggregatorProfiles.js';
import { aggregatorObservationsFromEvents } from '../ranker/learnedAggregatorStatsEvents.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';
import type { EventLog } from '../sync/eventLog.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_REJECTED_RELATION,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
  isUserRejectedRelationPayload,
} from '../feedback/events.js';
import { createRepairQueueStore } from '../connections/repairQueueStore.js';

// Absent/non-'0'/non-'false' = ON (shadow observe-only by default) —
// mirrors ranker/candidates.ts's aggregatorGroupingGuardEnabled call-time
// style. Set to 0/false to skip the extra typed read entirely.
const learnedAggregatorShadowEnabled = (): boolean => {
  const raw = process.env['SIDETRACK_LEARNED_AGGREGATOR']?.toLowerCase();
  return raw !== '0' && raw !== 'false';
};

// Per-type bounded window for the shadow's live event read — mirrors
// http/server.ts's SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW idiom
// (readMostRecentByType, events_accepted_at_ms_idx). NAVIGATION_COMMITTED
// and BROWSER_TIMELINE_OBSERVED are the two highest-volume event types in
// the log (one per visit / one per ~30s dwell window) — reading them
// unbounded on every health poll would be exactly the O(full history) walk
// this program's F3 goal exists to kill. `0` = kill switch, falls back to
// the unbounded type-scoped read (still indexed, just not window-capped).
const LEARNED_AGGREGATOR_WINDOW_ENV = 'SIDETRACK_LEARNED_AGGREGATOR_WINDOW';
const DEFAULT_LEARNED_AGGREGATOR_WINDOW = 20_000;
const learnedAggregatorWindow = (): number => {
  const raw = process.env[LEARNED_AGGREGATOR_WINDOW_ENV];
  if (raw === undefined || raw.length === 0) return DEFAULT_LEARNED_AGGREGATOR_WINDOW;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_LEARNED_AGGREGATOR_WINDOW;
};

// The NAVIGATION_COMMITTED/BROWSER_TIMELINE_OBSERVED events fed to the
// aggregator-stats shadow fold. Bounded (readMostRecentByType) when the
// typed store is available; falls back to readEventsForHealth's existing
// type-scoped read (readMerged()-filtered when the store itself is off)
// otherwise — the SAME fallback cost class readFeedbackEvents and the
// recall.served/action read in this file already accept, not a new
// regression class. readMostRecentByType returns most-recent-first, NOT
// causal order, so the result is sorted by acceptedAtMs ascending — required
// for aggregatorObservationsFromEvents' opener-chain resolution, which needs
// an opener's own NAVIGATION_COMMITTED folded before its child's.
const learnedAggregatorObservationEvents = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<readonly AcceptedEvent[]> => {
  const window = learnedAggregatorWindow();
  if (window <= 0) {
    return readEventsForHealth(vaultRoot, eventLog, [NAVIGATION_COMMITTED, BROWSER_TIMELINE_OBSERVED]);
  }
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return readEventsForHealth(vaultRoot, eventLog, [NAVIGATION_COMMITTED, BROWSER_TIMELINE_OBSERVED]);
  }
  const events = [
    ...store.readMostRecentByType(NAVIGATION_COMMITTED, window),
    ...store.readMostRecentByType(BROWSER_TIMELINE_OBSERVED, window),
  ];
  return [...events].sort((left, right) => left.acceptedAtMs - right.acceptedAtMs);
};

type DiagnosticCandidateMetric = string | number | boolean | null;

export interface DiagnosticCandidate {
  readonly id: string;
  readonly family: 'topic' | 'similarity' | 'ranker' | 'content-lane' | 'reconcile' | 'quality';
  readonly lane: 'active' | 'standby' | 'shadow' | 'diagnostic' | 'incremental' | 'queue';
  readonly servingImpact: 'serving' | 'not-serving' | 'observe-only';
  readonly status: 'ok' | 'off' | 'pending' | 'warning' | 'alarm' | 'unavailable';
  readonly reason: string | null;
  readonly revisionId: string | null;
  readonly asOf: string | null;
  readonly metrics: Readonly<Record<string, DiagnosticCandidateMetric>>;
}

export interface WorkGraphHealthReport {
  readonly ranker: {
    readonly activeRevisionId: string | null;
    readonly loadStatus: 'missing' | 'ready' | 'invalid-model';
    readonly loadReason: string | null;
    readonly activeModelVersion: string | null;
    readonly expectedModelVersion: string;
    readonly activeFeatureSchemaVersion: number | null;
    readonly expectedFeatureSchemaVersion: number;
    readonly needsRetrain: boolean;
    readonly trainedAt: number | null;
    readonly trainingDatasetHash: string | null;
    readonly retrainSkipReason: RankerRetrainSkipReason | null;
    readonly retrainNewLabelCount: number;
    readonly shipGateV2: {
      readonly status: 'pass' | 'fail' | 'unavailable';
      readonly reason: string;
      readonly revisionId: string;
      readonly updatedAt: number;
      readonly activeNdcgAt10: number;
      readonly baselineNdcgAt10: number;
      readonly activeMrr: number;
      readonly baselineMrr: number;
      readonly explicitRejectPrecisionDelta: number;
      // True when serving actually uses the v6 order — i.e. the enforcement
      // flag SIDETRACK_RANKER_SERVE_V6 is on AND this gate passes. A passing
      // gate with `servingGateEnforced: false` is an EARNED-BUT-INERT pass:
      // the model beat the baseline on labeled impressions but serving still
      // uses RRF + cross-encoder. Read live at health-serve time (folded on
      // in server.ts) so it reflects the current env, not the drain-time
      // artifact.
      readonly servingGateEnforced: boolean;
      // Read-only divergence between the served order and the v6-reranked
      // order, accumulated per /v2 recall request into a rolling window.
      // Null until a request records a sample (shadow off, cold model, or no
      // traffic since boot). Folded on live in server.ts — never present in
      // the drain-time artifact.
      readonly shadowDiff: {
        readonly requests: number;
        readonly meanTopKOverlap: number;
        readonly meanKendallTau: number;
        readonly topK: number;
        readonly lastComputedAt: string | null;
      } | null;
    } | null;
    readonly methodologySpine: MaterializerRankerMethodologySpineDiagnostics | null;
    // Honest training mix (plan TODO-R5/X1). `negativeLabelCount`
    // alone is the misleading-metric trap: it counts only explicit
    // user-feedback negatives at last train (historically 0, and even
    // those were dropped pre-fix). The model actually trains on
    // grade-0 rows — synthetic random_unrelated/recently_skipped plus
    // explicit user rejections. Surface all three so a
    // reader cannot mistake "0 user negatives" for "no negatives".
    readonly trainingMix: {
      readonly positivesAtTrain: number;
      readonly userFeedbackNegativesAtTrain: number;
      // grade-0 training rows from the model manifest. null when the
      // active manifest predates trainQuality
      // capture — rendered as "unknown", never as 0.
      readonly trainingNegatives: number | null;
    } | null;
    // True when the current feedback fingerprint differs from what the
    // active model was trained on — "data changed, model is behind".
    readonly datasetChangedSinceTrain: boolean;
    readonly expandedNegativeCount: number;
    readonly labelDriftWithoutFeedback: number;
    readonly rawPositiveCount: number;
    readonly rawNegativeCount: number;
    readonly groupCount: number;
    readonly avgCandidatesPerGroup: number;
    readonly positivesPerGroup: number;
    readonly explicitRejectsPerGroup: number;
    readonly unjudgedCandidatesPerGroup: number;
    readonly candidateSourceDistribution: Readonly<Record<string, number>>;
    readonly augmentation: {
      readonly status: string;
      readonly reason: string | null;
      readonly activeRevisionId: string | null;
      readonly activeModelVersion: string | null;
      readonly expectedModelVersion: string;
      readonly activeFeatureSchemaVersion: number | null;
      readonly expectedFeatureSchemaVersion: number;
      readonly needsRetrain: boolean;
      readonly modelFreshness: string | null;
      readonly methodologySpine: MaterializerRankerMethodologySpineDiagnostics | null;
      readonly closestVisitEdgeCount: number;
      readonly rankerSourceEdgeCount: number;
      readonly asOf: string | null;
    } | null;
    // Progress toward the next batch retrain — what has to happen before
    // the trained date can move. Both gates surfaced: the v6 impression
    // path (positive groups toward the floor) and the legacy label path
    // (new positive labels toward the threshold). `eligible` is true when
    // either gate is already satisfied; otherwise `retrainSkipReason`
    // carries the binding reason.
    readonly nextRetrain: {
      readonly eligible: boolean;
      readonly positiveGroups: { readonly current: number; readonly required: number };
      readonly newLabels: { readonly current: number; readonly required: number };
      readonly cooldownMs: number;
    };
    // Online-adaptation head. The batch model's trained date does NOT move
    // when this nudges weights — it is a serving-time delta layered on
    // `activeRevisionId`, live only while `baseRevisionId` matches the
    // served model (`inUse`). `enabled` reflects the SIDETRACK_ONLINE_RANKER
    // flag; `present` whether a persisted state exists.
    readonly onlineHead: {
      readonly enabled: boolean;
      readonly present: boolean;
      readonly inUse: boolean;
      readonly baseRevisionId: string | null;
      readonly updateCount: number;
      readonly activeWeightCount: number;
      // Last state write (frontier advances refresh this every drain).
      readonly updatedAtMs: number | null;
      // Last time a pairwise update actually moved the weights.
      readonly lastNudgeAtMs: number | null;
    };
  };
  readonly ann: {
    readonly backend: 'hnsw' | 'flat';
    readonly fallbackActive: boolean;
    readonly reason: string | null;
  };
  readonly feedback: {
    readonly actionCount: number;
    readonly positiveLabelCount: number;
    readonly negativeLabelCount: number;
  };
  readonly topicProducer: {
    readonly activeRevisionId: string | null;
    readonly algorithmVersion: string | null;
    readonly topicCount: number;
    readonly lineageCount: number;
  };
  // Phase 0 of the recall+ranker v2 hard-replacement. The trainer
  // (Phase 3) joins served × action by `servedContextId`. These
  // counters surface the impression-log volume on the health panel
  // so cold-start gating is auditable end-to-end.
  readonly impressionLog: {
    readonly servedCount: number;
    readonly actionCount: number;
    readonly actionsByKind: Readonly<Record<string, number>>;
  };
  // Move 2 label-density diagnostics (collect/store only — no serving
  // consumer applies either yet). `weakNegativesEnabled` reflects whether
  // shown-but-unjudged impression candidates are being densified into
  // weak-negative training rows (SIDETRACK_RANKER_WEAK_NEGATIVES). `rejected`
  // is the running count of persisted USER_REJECTED_RELATION assertions ("these
  // two pages are NOT related"); suppression of the pair is deferred behind the
  // freeze, so this is a visibility counter only.
  readonly labelChannels: {
    readonly weakNegativesEnabled: boolean;
    readonly rejectedRelations: {
      readonly count: number;
      readonly bySurface: Readonly<Record<string, number>>;
    };
  };
  // Phase 5 of the recall+ranker v2 hard-replacement. Dogfood-config
  // visibility on the health panel: what retrieval backend the
  // companion is serving, what vector store is canonical, and whether
  // the cross-encoder rerank is firing on /v2/recall. These let the
  // CFT smoke test verify "the system is actually running the new
  // architecture" without reading internal config.
  //
  // Phase 4 added canonicalVectorCounts (documents_vec +
  // documents_chunks_vec sizes) so the single-source-of-truth
  // consistency contract is auditable end-to-end.
  readonly recall: {
    readonly retrievalBackend: 'v2';
    readonly vectorStore: 'sqlite' | 'sidecar';
    readonly fusionImplementation: 'recall-v2';
    readonly crossEncoder: {
      readonly enabled: boolean;
      readonly rerankTopK: number;
    };
    readonly canonicalVectorCounts: {
      readonly documentVectorCount: number;
      readonly chunkVectorCount: number;
    };
    readonly canonicalizationTelemetry: {
      readonly trackedHostCount: number;
      readonly suspiciousHosts: readonly {
        readonly host: string;
        readonly canonicalCount: number;
        readonly rawCount: number;
        readonly collisionRatio: number;
        readonly samplePairs: readonly CanonicalCollisionSamplePair[];
      }[];
    };
  };
  readonly hygiene: {
    readonly overCollapsedRecords: {
      readonly count: number;
      readonly samples: readonly OverCollapsedRecord[];
    };
  };
  // F8 W3 — the persisted repair queue (docs/plans/2026-08-16-f8-ivm-designs.md,
  // "W3"). `depth`/`oldestEnqueuedAt` are the gauge; `status` is 'warning'
  // when depth > 100 or the oldest entry has been queued > 1h (either
  // signals the queue isn't draining — a demoted bail class that can't
  // heal via scoped recompute, e.g. the W1/W2 stores being disabled).
  // `needsRepair` mirrors the Recovery consent rule's durable marker: set
  // by the materializer when a catastrophic-recovery condition is
  // detected on a non-empty vault, cleared by a successful
  // `connections-rebuild` CLI run.
  readonly repairQueue: {
    readonly depth: number;
    readonly oldestEnqueuedAt: string | null;
    readonly oldestAgeMs: number | null;
    readonly status: 'ok' | 'warning' | 'unavailable';
    readonly needsRepair: {
      readonly reason: string;
      readonly command: string;
      readonly detectedAt: string;
    } | null;
  };
  readonly candidates: readonly DiagnosticCandidate[];
}

export interface ConnectionsDiagnosticSnapshot {
  readonly dirtySourceCount: number;
  readonly tombstonedSourceCount: number;
  readonly latestExtractionCount: number;
  readonly oldestDirtySourceAgeMs: number | null;
}

export interface WorkGraphHealthDeps {
  readonly vaultRoot: string;
  readonly eventLog?: EventLog;
  readonly connectionsDiagnostics?: () => ConnectionsDiagnosticSnapshot;
  readonly now?: () => Date;
  // Phase 4 — when provided, health reports canonical vector counts
  // from documents_vec + documents_chunks_vec. Optional because the
  // SQLite store is lazily opened on first /v2/recall; absent →
  // counts default to 0 with a comment in the report.
  readonly canonicalRecallStore?: {
    readonly allVectorEntityIds: () => ReadonlySet<string>;
    readonly allChunkVectorIds: () => ReadonlySet<string>;
  };
}

const emptyEvents: readonly AcceptedEvent[] = [];
const feedbackEventTypes = new Set<string>([
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
]);

// Type-filtered read: the health/feedback probes want a tiny typed
// subset (a few hundred feedback / recall.served / recall.action events)
// of a log that is ~92% engagement.interval. A full forEachChunk scan of
// the 370K-event store dominated the 5s health budget, so use the
// SQL-level type filter (events_type_idx) when the store is available.
const readEventsForHealth = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
  types: readonly string[],
): Promise<readonly AcceptedEvent[]> => {
  if (eventLog === undefined) return emptyEvents;
  const typeSet = new Set(types);
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return (await eventLog.readMerged()).filter((event) => typeSet.has(event.type));
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    types,
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

const readFeedbackEvents = (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<readonly AcceptedEvent[]> =>
  readEventsForHealth(vaultRoot, eventLog, [...feedbackEventTypes]);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const countFeedbackActions = (perItem: Record<string, readonly unknown[]>): number =>
  Object.values(perItem).reduce((count, actions) => count + actions.length, 0);

const annStatus = async (): Promise<WorkGraphHealthReport['ann']> => {
  try {
    await loadDefaultUsearch();
    return { backend: 'hnsw', fallbackActive: false, reason: null };
  } catch (error) {
    return { backend: 'flat', fallbackActive: true, reason: errorMessage(error) };
  }
};

// F8 W3 — repair-queue gauge + needs-repair condition (docs/plans/
// 2026-08-16-f8-ivm-designs.md, "W3"). Opened fresh (no injected dep,
// matching the `createTopicRevisionStore(vaultRoot)` inline-read pattern
// already used above) and closed immediately — this runs on the health
// poll cadence, not the drain hot path, so a per-call open/close is cheap
// and avoids holding a second long-lived handle on the sidecar. A store
// that fails to open (e.g. bun:sqlite unavailable under a non-bun test
// runner) reports 'unavailable' rather than throwing — health must never
// crash because one gauge's backing store is momentarily unreachable.
const REPAIR_QUEUE_DEPTH_WARN_THRESHOLD = 100;
const REPAIR_QUEUE_OLDEST_AGE_WARN_MS = 60 * 60 * 1000;

const readRepairQueueHealth = async (
  vaultRoot: string,
  now: () => Date,
): Promise<WorkGraphHealthReport['repairQueue']> => {
  try {
    const store = await createRepairQueueStore(vaultRoot);
    try {
      const stats = store.stats();
      const needsRepair = store.readNeedsRepair();
      const oldestAgeMs =
        stats.oldestEnqueuedAt === null
          ? null
          : now().getTime() - Date.parse(stats.oldestEnqueuedAt);
      const status: WorkGraphHealthReport['repairQueue']['status'] =
        stats.depth > REPAIR_QUEUE_DEPTH_WARN_THRESHOLD ||
        (oldestAgeMs !== null && oldestAgeMs > REPAIR_QUEUE_OLDEST_AGE_WARN_MS)
          ? 'warning'
          : 'ok';
      return {
        depth: stats.depth,
        oldestEnqueuedAt: stats.oldestEnqueuedAt,
        oldestAgeMs,
        status,
        needsRepair,
      };
    } finally {
      store.close();
    }
  } catch {
    return {
      depth: 0,
      oldestEnqueuedAt: null,
      oldestAgeMs: null,
      status: 'unavailable',
      needsRepair: null,
    };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const numberOrZero = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const booleanOrFalse = (value: unknown): boolean => (typeof value === 'boolean' ? value : false);

const CONTENT_LANE_BACKLOG_WARN_MS = 10 * 60 * 1000;
const OVER_COLLAPSED_PAGE_CONTENT_CACHE_TTL_MS = 60_000;

let overCollapsedPageContentCache: {
  readonly vaultRoot: string;
  readonly computedAtMs: number;
  readonly records: readonly OverCollapsedRecord[];
} | null = null;

const scanForOverCollapsedPageContentCached = async (
  vaultRoot: string,
): Promise<readonly OverCollapsedRecord[]> => {
  const now = Date.now();
  if (
    overCollapsedPageContentCache !== null &&
    overCollapsedPageContentCache.vaultRoot === vaultRoot &&
    now - overCollapsedPageContentCache.computedAtMs < OVER_COLLAPSED_PAGE_CONTENT_CACHE_TTL_MS
  ) {
    return overCollapsedPageContentCache.records;
  }
  const records = await scanForOverCollapsedPageContent(vaultRoot);
  overCollapsedPageContentCache = { vaultRoot, computedAtMs: now, records };
  return records;
};

const canonicalizationTelemetry = (): WorkGraphHealthReport['recall']['canonicalizationTelemetry'] => {
  const snapshot = getCanonicalCollisionSnapshot();
  const suspiciousHosts = Object.entries(snapshot.byHost)
    .map(([host, hostSnapshot]) => ({
      host,
      canonicalCount: hostSnapshot.canonicalCount,
      rawCount: hostSnapshot.rawCount,
      collisionRatio:
        hostSnapshot.canonicalCount === 0
          ? 0
          : hostSnapshot.rawCount / hostSnapshot.canonicalCount,
      samplePairs: hostSnapshot.suspiciousPairs,
    }))
    .filter((host) => host.collisionRatio > 1.5)
    .sort((left, right) => {
      const ratioDelta = right.collisionRatio - left.collisionRatio;
      if (ratioDelta !== 0) return ratioDelta;
      const rawDelta = right.rawCount - left.rawCount;
      return rawDelta !== 0 ? rawDelta : left.host.localeCompare(right.host);
    })
    .slice(0, 10);
  return {
    trackedHostCount: Object.keys(snapshot.byHost).length,
    suspiciousHosts,
  };
};

const metrics = (
  input: Readonly<Record<string, DiagnosticCandidateMetric>>,
): Readonly<Record<string, DiagnosticCandidateMetric>> => input;

const envEnabled = (name: string): boolean => process.env[name] === '1';

const reconcileRunnerMode = (): 'in-process' | 'worker-thread' | 'child-process' => {
  if (envEnabled('SIDETRACK_CONNECTIONS_INPROCESS')) return 'in-process';
  if (envEnabled('SIDETRACK_CONNECTIONS_WORKER')) return 'worker-thread';
  if (envEnabled('SIDETRACK_CONNECTIONS_CHILD')) return 'child-process';
  return 'in-process';
};

interface LatestConnectionsDiagnostics {
  readonly producedAt: string | null;
  readonly raw: Record<string, unknown> | null;
}

const parseMethodologySpineDiagnostics = (
  value: unknown,
): MaterializerRankerMethodologySpineDiagnostics | null => {
  if (!isRecord(value)) return null;
  const splitRaw = value['split'];
  const shipGateRaw = value['shipGate'];
  if (!isRecord(splitRaw) || !isRecord(shipGateRaw)) return null;
  const split =
    splitRaw['status'] === 'available' &&
    splitRaw['strategy'] === 'forward-chaining-time' &&
    splitRaw['timestampSource'] === 'supervision-event-or-visit-observed-at' &&
    numberOrNull(splitRaw['trainGroupCount']) !== null &&
    numberOrNull(splitRaw['validationGroupCount']) !== null &&
    numberOrNull(splitRaw['testGroupCount']) !== null &&
    numberOrNull(splitRaw['validationCutoffGeneratedAt']) !== null &&
    numberOrNull(splitRaw['testCutoffGeneratedAt']) !== null
      ? {
          status: 'available' as const,
          strategy: 'forward-chaining-time' as const,
          timestampSource: 'supervision-event-or-visit-observed-at' as const,
          trainGroupCount: numberOrZero(splitRaw['trainGroupCount']),
          validationGroupCount: numberOrZero(splitRaw['validationGroupCount']),
          testGroupCount: numberOrZero(splitRaw['testGroupCount']),
          validationCutoffGeneratedAt: numberOrZero(splitRaw['validationCutoffGeneratedAt']),
          testCutoffGeneratedAt: numberOrZero(splitRaw['testCutoffGeneratedAt']),
        }
      : splitRaw['status'] === 'unavailable' &&
          splitRaw['reason'] === 'insufficient-time-separated-groups'
        ? {
            status: 'unavailable' as const,
            reason: 'insufficient-time-separated-groups' as const,
          }
        : null;
  if (split === null) return null;
  const shipGateStatus = shipGateRaw['status'];
  const shipGateReason = shipGateRaw['reason'];
  if (
    (shipGateStatus !== 'pass' && shipGateStatus !== 'fail' && shipGateStatus !== 'unavailable') ||
    shipGateRaw['candidate'] !== expectedClosestVisitRankerSchema.modelVersion ||
    numberOrNull(shipGateRaw['minValidationDeltaVsBaseline']) === null ||
    numberOrNull(shipGateRaw['minReservedTestNdcg']) === null ||
    shipGateRaw['reservedTestUsedExactlyOnce'] !== true ||
    (shipGateReason !== 'active-model-cleared-validation-and-reserved-test' &&
      shipGateReason !== 'active-model-does-not-beat-comparison-baseline' &&
      shipGateReason !== 'reserved-test-below-floor' &&
      shipGateReason !== 'novel-pair-supervision-unavailable' &&
      shipGateReason !== 'validation-or-test-metric-unavailable')
  ) {
    return null;
  }
  return {
    servingGateEnforced: booleanOrFalse(value['servingGateEnforced']),
    split,
    shipGate: {
      status: shipGateStatus,
      candidate: expectedClosestVisitRankerSchema.modelVersion,
      minValidationDeltaVsBaseline: numberOrZero(shipGateRaw['minValidationDeltaVsBaseline']),
      minReservedTestNdcg: numberOrZero(shipGateRaw['minReservedTestNdcg']),
      reservedTestUsedExactlyOnce: true,
      reason: shipGateReason,
    },
  };
};

const readLatestConnectionsDiagnostics = async (
  vaultRoot: string,
): Promise<LatestConnectionsDiagnostics> => {
  try {
    const raw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { producedAt: null, raw: null };
    return { producedAt: stringOrNull(parsed['producedAt']), raw: parsed };
  } catch {
    return { producedAt: null, raw: null };
  }
};

const parseRankerAugmentationStatus = (
  diagnostics: LatestConnectionsDiagnostics,
): WorkGraphHealthReport['ranker']['augmentation'] => {
  const parsed = diagnostics.raw;
  if (parsed === null) return null;
  const rankerAugmentation = parsed['rankerAugmentation'];
  if (!isRecord(rankerAugmentation)) return null;
  return {
    status: stringOrNull(rankerAugmentation['status']) ?? 'unknown',
    reason: stringOrNull(rankerAugmentation['reason']),
    activeRevisionId: stringOrNull(rankerAugmentation['activeRevisionId']),
    activeModelVersion: stringOrNull(rankerAugmentation['activeModelVersion']),
    expectedModelVersion:
      stringOrNull(rankerAugmentation['expectedModelVersion']) ??
      expectedClosestVisitRankerSchema.modelVersion,
    activeFeatureSchemaVersion: numberOrNull(rankerAugmentation['activeFeatureSchemaVersion']),
    expectedFeatureSchemaVersion:
      numberOrNull(rankerAugmentation['expectedFeatureSchemaVersion']) ??
      expectedClosestVisitRankerSchema.featureSchemaVersion,
    needsRetrain: booleanOrFalse(rankerAugmentation['needsRetrain']),
    modelFreshness: stringOrNull(rankerAugmentation['modelFreshness']),
    methodologySpine: parseMethodologySpineDiagnostics(rankerAugmentation['methodologySpine']),
    closestVisitEdgeCount: numberOrZero(rankerAugmentation['closestVisitEdgeCount']),
    rankerSourceEdgeCount: numberOrZero(rankerAugmentation['rankerSourceEdgeCount']),
    asOf: diagnostics.producedAt,
  };
};

const candidateStatusForTopic = (
  topicProducer: WorkGraphHealthReport['topicProducer'],
): DiagnosticCandidate['status'] => {
  if (topicProducer.activeRevisionId === null) return 'pending';
  if (topicProducer.topicCount === 0) return 'warning';
  return 'ok';
};

const reasonForTopic = (topicProducer: WorkGraphHealthReport['topicProducer']): string | null => {
  if (topicProducer.activeRevisionId === null) return 'no-active-topic-revision';
  if (topicProducer.topicCount === 0) return 'no-clusters';
  return null;
};

const candidateStatusForRankerLoad = (
  loadStatus: WorkGraphHealthReport['ranker']['loadStatus'],
): DiagnosticCandidate['status'] => {
  if (loadStatus === 'ready') return 'ok';
  if (loadStatus === 'invalid-model') return 'alarm';
  return 'pending';
};

const rankerAugmentationServingImpact = (
  augmentation: WorkGraphHealthReport['ranker']['augmentation'],
): DiagnosticCandidate['servingImpact'] =>
  augmentation?.status === 'emitted' ? 'serving' : 'not-serving';

const rankerActiveModelServingImpact = (
  ranker: WorkGraphHealthReport['ranker'],
): DiagnosticCandidate['servingImpact'] =>
  ranker.loadStatus === 'invalid-model'
    ? 'serving'
    : rankerAugmentationServingImpact(ranker.augmentation);

const candidateStatusForRankerAugmentation = (
  augmentation: WorkGraphHealthReport['ranker']['augmentation'],
): DiagnosticCandidate['status'] => {
  if (augmentation === null) return 'unavailable';
  if (augmentation.status === 'emitted') return 'ok';
  if (augmentation.status === 'skipped') return 'off';
  if (augmentation.status === 'failed') return 'alarm';
  if (augmentation.status === 'absent') return 'warning';
  return 'pending';
};

const candidateStatusForMethodology = (
  spine: MaterializerRankerMethodologySpineDiagnostics | null,
): DiagnosticCandidate['status'] => {
  if (spine === null) return 'unavailable';
  if (spine.shipGate.status === 'pass') return 'ok';
  if (spine.shipGate.status === 'fail') return spine.servingGateEnforced ? 'alarm' : 'warning';
  return 'pending';
};

const candidateStatusForDrift = (
  drift: Record<string, unknown> | null,
): DiagnosticCandidate['status'] => {
  const status = drift === null ? null : stringOrNull(drift['status']);
  if (status === null) return 'unavailable';
  if (status === 'stable') return 'ok';
  if (status === 'warning' || status === 'drift') return 'warning';
  return 'pending';
};

const countStringArray = (value: unknown): number | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value.length : null;

const millisToIso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const buildDiagnosticCandidates = (input: {
  readonly ranker: WorkGraphHealthReport['ranker'];
  readonly topicProducer: WorkGraphHealthReport['topicProducer'];
  readonly diagnostics: LatestConnectionsDiagnostics;
  readonly connectionsDiagnostics: ConnectionsDiagnosticSnapshot | null;
  readonly collectedAt: string;
  readonly topicProducedAt: string | null;
  // W5 Phase B — the incremental topic-revision shadow's live revisionId +
  // churn-vs-served report, derived (in collectWorkGraphHealth) fresh from
  // the on-disk candidate-shadow revision. null when no shadow has ever
  // been persisted for this vault.
  readonly incrementalShadowRevisionId: string | null;
  readonly incrementalShadowReport: ServedTopicProducerReport | null;
  readonly incrementalShadowSecondaryCount: number | null;
  readonly repairQueue: WorkGraphHealthReport['repairQueue'];
  // Learned aggregator-stats shadow — see the collectWorkGraphHealth
  // computation this thread comes from. `null` only when the flag is off
  // (aggregatorShadowEnabled false); otherwise always populated (computed
  // live, never read from a persisted diagnostics blob).
  readonly aggregatorShadowEnabled: boolean;
  readonly aggregatorShadowAgreement: AggregatorShadowAgreement | null;
}): readonly DiagnosticCandidate[] => {
  const producedAt = input.diagnostics.producedAt;
  const diagnosticsObservedAt = producedAt;
  const liveObservedAt = input.collectedAt;
  const topicObservedAt = input.topicProducedAt ?? liveObservedAt;
  const rankerObservedAt = millisToIso(input.ranker.trainedAt) ?? liveObservedAt;
  const raw = input.diagnostics.raw;
  const shadow = raw !== null && isRecord(raw['shadowVsBaseline']) ? raw['shadowVsBaseline'] : null;
  const topicIncrementalShadow =
    raw !== null && isRecord(raw['topicIncrementalShadow']) ? raw['topicIncrementalShadow'] : null;
  const observation =
    raw !== null && isRecord(raw['shadowObservation']) ? raw['shadowObservation'] : null;
  const driftReport = raw !== null && isRecord(raw['drift']) ? raw['drift'] : null;
  const silhouette =
    driftReport !== null && isRecord(driftReport['silhouette']) ? driftReport['silhouette'] : null;
  const methodologySpine =
    input.ranker.augmentation?.methodologySpine ?? input.ranker.methodologySpine;
  const connectionsDiagnostics = input.connectionsDiagnostics;
  const dirtySourceCount = connectionsDiagnostics?.dirtySourceCount ?? null;
  const tombstonedSourceCount = connectionsDiagnostics?.tombstonedSourceCount ?? null;
  const latestExtractionCount = connectionsDiagnostics?.latestExtractionCount ?? null;
  const oldestDirtySourceAgeMs = connectionsDiagnostics?.oldestDirtySourceAgeMs ?? null;
  const hasDirtySourceWork =
    connectionsDiagnostics !== null && connectionsDiagnostics.dirtySourceCount > 0;
  const hasDirtySourceBacklog =
    hasDirtySourceWork &&
    oldestDirtySourceAgeMs !== null &&
    oldestDirtySourceAgeMs > CONTENT_LANE_BACKLOG_WARN_MS;
  const contentLaneStatus: DiagnosticCandidate['status'] =
    connectionsDiagnostics === null
      ? 'unavailable'
      : hasDirtySourceBacklog
        ? 'warning'
        : hasDirtySourceWork
          ? 'pending'
          : 'ok';
  // U2 — default-ON resolvers (was strict env==='1' opt-in).
  const hotSimilarityEnabled = hotSimilarityModeEnabled();
  const hotTopicsEnabled = hotTopicsModeEnabled();
  const hotPath = raw !== null && isRecord(raw['hotPath']) ? raw['hotPath'] : null;
  const hotSim = hotPath !== null && isRecord(hotPath['similarity']) ? hotPath['similarity'] : null;
  const hotTop = hotPath !== null && isRecord(hotPath['topics']) ? hotPath['topics'] : null;
  // Served-signal floor guard (flapping fix). The candidate status is
  // driven by CURRENT state — the last-drain `suppressedCollapse` flag OR
  // the durable `flapping` recent-window signal — NOT the lifetime
  // `suppressedCollapseCount` (which only ever increments and would pin
  // the health board `degraded` forever, i.e. alarm fatigue). The lifetime
  // count is surfaced as a metric only, for trend visibility.
  const similarityFloor =
    raw !== null && isRecord(raw['similarityFloor']) ? raw['similarityFloor'] : null;
  const runnerMode = reconcileRunnerMode();

  // Health-panel cleanup (2026-05-26): filter out perpetually-off
  // diagnostic candidates so the panel only renders meaningful state.
  // Set ids stay defined here for telemetry; the array is filtered at
  // the bottom of this function. Adding a new always-off candidate?
  // Add it to the predicate below too.
  const alwaysOffCandidateIds = new Set([
    'topic.hdbscan-standby',          // status=off, no-production-selector
    'topic.algorithm-comparison',      // status=off, no-runtime-route
    'quality.gray-zone-scorer',        // status=off, no-runtime-model-injection
  ]);
  const isStaleDiagnostic = (cand: DiagnosticCandidate): boolean => {
    if (alwaysOffCandidateIds.has(cand.id)) return true;
    // Shadow producer that nobody enabled — pure noise.
    if (cand.id === 'topic.shadow-idf-rkn-split' && cand.status === 'unavailable') return true;
    // W5 Phase B — same rule: an experiment nobody opted into (flag off,
    // or a vault/drain that predates the diagnostics wiring) is noise.
    if (cand.id === 'topic.incremental-shadow' && cand.status === 'unavailable') return true;
    // Legacy methodology spine when not populated (shipGateV2 owns this surface now).
    if (cand.id === 'ranker.methodology-spine' && cand.status === 'unavailable') return true;
    // Served-signal floor: only render the row once the diagnostic exists
    // (absent for legacy vaults / pre-fix diagnostics / any drain before
    // the first similarity revision) so it doesn't add a perpetual
    // `unavailable` row to the signal-dense panel.
    if (cand.id === 'similarity.served-signal-floor' && cand.status === 'unavailable') return true;
    return false;
  };

  const allCandidates: readonly DiagnosticCandidate[] = [
    {
      id: 'topic.active-producer',
      family: 'topic',
      lane: 'active',
      servingImpact: 'serving',
      status: candidateStatusForTopic(input.topicProducer),
      reason: reasonForTopic(input.topicProducer),
      revisionId: input.topicProducer.activeRevisionId,
      asOf: topicObservedAt,
      metrics: metrics({
        algorithmVersion: input.topicProducer.algorithmVersion,
        topicCount: input.topicProducer.topicCount,
        lineageCount: input.topicProducer.lineageCount,
      }),
    },
    {
      id: 'topic.hdbscan-standby',
      family: 'topic',
      lane: 'standby',
      servingImpact: 'not-serving',
      status: 'off',
      reason: 'no-production-selector',
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({
        algorithmVersion: TOPIC_HDBSCAN_REVISION_KEY,
        defaultAlgorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
      }),
    },
    {
      id: 'topic.algorithm-comparison',
      family: 'topic',
      lane: 'standby',
      servingImpact: 'not-serving',
      status: 'off',
      reason: 'no-runtime-route',
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({ comparisonCandidatesWritten: true }),
    },
    {
      id: 'topic.shadow-idf-rkn-split',
      family: 'topic',
      lane: 'shadow',
      servingImpact: 'observe-only',
      status:
        shadow === null
          ? 'unavailable'
          : booleanOrFalse(shadow['enabled']) === false
            ? 'off'
            : booleanOrFalse(observation?.['shadowCollapseBoundaryChanged']) ||
                booleanOrFalse(observation?.['activeCollapseBoundaryChanged'])
              ? 'warning'
              : 'ok',
      reason:
        shadow === null
          ? 'shadow-diagnostics-unavailable'
          : booleanOrFalse(shadow['enabled']) === false
            ? 'disabled'
            : booleanOrFalse(observation?.['shadowCollapseBoundaryChanged'])
              ? 'shadow-collapse-boundary-changed'
              : booleanOrFalse(observation?.['activeCollapseBoundaryChanged'])
                ? 'active-collapse-boundary-changed'
                : null,
      revisionId:
        stringOrNull(observation?.['shadowRevisionId']) ??
        stringOrNull(shadow?.['shadowRevisionId']),
      asOf: diagnosticsObservedAt,
      metrics: metrics({
        algorithmVersion:
          stringOrNull(shadow?.['shadowAlgorithmVersion']) ??
          TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
        shadowTopicCount: numberOrNull(shadow?.['shadowTopicCount']),
        baselineTopicCount: numberOrNull(shadow?.['baselineTopicCount']),
        shadowMaxTopicShare: numberOrNull(shadow?.['shadowMaxTopicShare']),
        noiseShare: numberOrNull(shadow?.['noiseShare']),
        adjacentPerVisitChurn: numberOrNull(observation?.['adjacentPerVisitChurn']),
      }),
    },
    // W5 Phase B — the incremental topic-revision producer, run as an
    // observe-only SHADOW alongside the served leiden-cpm producer on
    // every drain (SIDETRACK_TOPIC_INCREMENTAL_SHADOW, default OFF).
    // Never active/served — see connectionsMaterializer.ts's
    // `topicIncrementalShadowEnabled` wiring. topicCount/secondaryCount/
    // churn are derived LIVE from the persisted candidate-shadow revision
    // (via buildServedTopicProducerReport against the currently served
    // revision, computed in collectWorkGraphHealth); promotedCount/
    // overflow/ranThisDrain are this-drain facts threaded through the
    // diagnostics artifact (`topicIncrementalShadow`) since they cannot
    // be reconstructed from the revision file alone.
    {
      id: 'topic.incremental-shadow',
      family: 'topic',
      lane: 'shadow',
      servingImpact: 'observe-only',
      status:
        topicIncrementalShadow === null
          ? 'unavailable'
          : booleanOrFalse(topicIncrementalShadow['enabled']) === false
            ? 'off'
            : booleanOrFalse(topicIncrementalShadow['overflow'])
              ? 'warning'
              : input.incrementalShadowRevisionId === null
                ? 'pending'
                : 'ok',
      reason:
        topicIncrementalShadow === null
          ? 'shadow-diagnostics-unavailable'
          : booleanOrFalse(topicIncrementalShadow['enabled']) === false
            ? 'disabled'
            : booleanOrFalse(topicIncrementalShadow['overflow'])
              ? 'subgraph-cap-exceeded'
              : input.incrementalShadowRevisionId === null
                ? 'no-shadow-revision-yet'
                : null,
      revisionId: input.incrementalShadowRevisionId,
      asOf: diagnosticsObservedAt,
      metrics: metrics({
        algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
        baseRevisionId: input.incrementalShadowReport?.previousRevisionId ?? null,
        topicCount: input.incrementalShadowReport?.topicCount ?? null,
        secondaryCount: input.incrementalShadowSecondaryCount,
        promotedCount: numberOrNull(topicIncrementalShadow?.['promotedCount']),
        overflowCount: booleanOrFalse(topicIncrementalShadow?.['overflow'])
          ? (numberOrNull(topicIncrementalShadow?.['overflowSubgraphSize']) ?? 0)
          : 0,
        ranThisDrain: booleanOrFalse(topicIncrementalShadow?.['ranThisDrain']),
        churnP50: input.incrementalShadowReport?.churnP50 ?? null,
        churnP90: input.incrementalShadowReport?.churnP90 ?? null,
      }),
    },
    // Learned per-node aggregator-stats SHADOW (2026-08-16) — observe-only,
    // measures agreement between ranker/aggregatorProfiles.ts's hand-
    // maintained domain registry (still deciding both guards) and
    // ranker/learnedAggregatorStats.ts's behavioral classifier. See
    // docs/plans/2026-08-15-foundation-program.md's design note. `warning`
    // when the learned classifier under-reaches the registry (misses a URL
    // the registry protects) — that direction risks resurrecting the
    // 2026-07-10 false-friend if this shadow ever becomes the decider, so
    // it is surfaced loudly; the reverse (learned finds MORE hubs than the
    // registry, `learnedOnlyAggregatorCount`) is the intended, desired
    // outcome and never raises the status past `ok`.
    {
      id: 'aggregator.learned-stats-shadow',
      family: 'similarity',
      lane: 'shadow',
      servingImpact: 'observe-only',
      status: !input.aggregatorShadowEnabled
        ? 'off'
        : input.aggregatorShadowAgreement === null
          ? 'unavailable'
          : input.aggregatorShadowAgreement.totalClassified === 0
            ? 'pending'
            : input.aggregatorShadowAgreement.registryOnlyAggregatorCount > 0
              ? 'warning'
              : 'ok',
      reason: !input.aggregatorShadowEnabled
        ? 'disabled'
        : input.aggregatorShadowAgreement === null
          ? 'shadow-diagnostics-unavailable'
          : input.aggregatorShadowAgreement.totalClassified === 0
            ? 'no-urls-classified-yet'
            : input.aggregatorShadowAgreement.registryOnlyAggregatorCount > 0
              ? 'learned-under-reaches-registry'
              : null,
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({
        totalClassified: input.aggregatorShadowAgreement?.totalClassified ?? null,
        agreementCount: input.aggregatorShadowAgreement?.agreementCount ?? null,
        disagreementCount: input.aggregatorShadowAgreement?.disagreementCount ?? null,
        agreementRate: input.aggregatorShadowAgreement?.agreementRate ?? null,
        registryOnlyAggregatorCount: input.aggregatorShadowAgreement?.registryOnlyAggregatorCount ?? null,
        learnedOnlyAggregatorCount: input.aggregatorShadowAgreement?.learnedOnlyAggregatorCount ?? null,
        feedVsItemDisagreementCount: input.aggregatorShadowAgreement?.feedVsItemDisagreementCount ?? null,
      }),
    },
    {
      id: 'diagnostic.drift-sidecar',
      family: 'similarity',
      lane: 'diagnostic',
      servingImpact: 'observe-only',
      status: candidateStatusForDrift(driftReport),
      reason:
        driftReport === null
          ? 'drift-report-unavailable'
          : stringOrNull(driftReport['status']) === 'drift'
            ? 'drift-detected'
            : stringOrNull(driftReport['status']) === 'warning'
              ? 'drift-warning'
              : null,
      revisionId: stringOrNull(silhouette?.['revisionId']),
      asOf: diagnosticsObservedAt,
      metrics: metrics({
        driftStatus: stringOrNull(driftReport?.['status']),
        trippedSignalCount: countStringArray(driftReport?.['trippedSignals']),
        warningSignalCount: countStringArray(driftReport?.['warningSignals']),
        silhouette: numberOrNull(silhouette?.['silhouette']),
        silhouetteDelta: numberOrNull(silhouette?.['delta']),
      }),
    },
    {
      id: 'ranker.active-model',
      family: 'ranker',
      lane: 'active',
      servingImpact: rankerActiveModelServingImpact(input.ranker),
      status: candidateStatusForRankerLoad(input.ranker.loadStatus),
      reason:
        input.ranker.loadReason ??
        (input.ranker.loadStatus === 'ready'
          ? null
          : input.ranker.loadStatus === 'missing'
            ? 'no-active-manifest'
            : 'invalid-active-model'),
      revisionId: input.ranker.activeRevisionId,
      asOf: rankerObservedAt,
      metrics: metrics({
        loadStatus: input.ranker.loadStatus,
        loadReason: input.ranker.loadReason,
        activeModelVersion: input.ranker.activeModelVersion,
        expectedModelVersion: input.ranker.expectedModelVersion,
        activeFeatureSchemaVersion: input.ranker.activeFeatureSchemaVersion,
        expectedFeatureSchemaVersion: input.ranker.expectedFeatureSchemaVersion,
        needsRetrain: input.ranker.needsRetrain,
        datasetChangedSinceTrain: input.ranker.datasetChangedSinceTrain,
        shipGateV2Status: input.ranker.shipGateV2?.status ?? null,
        shipGateV2Reason: input.ranker.shipGateV2?.reason ?? null,
      }),
    },
    {
      id: 'ranker.augmentation',
      family: 'ranker',
      lane: 'active',
      servingImpact: rankerAugmentationServingImpact(input.ranker.augmentation),
      status: candidateStatusForRankerAugmentation(input.ranker.augmentation),
      reason:
        input.ranker.augmentation?.reason ??
        (input.ranker.augmentation === null ? 'no-diagnostics' : null),
      revisionId: input.ranker.augmentation?.activeRevisionId ?? null,
      asOf: input.ranker.augmentation?.asOf ?? diagnosticsObservedAt,
      metrics: metrics({
        status: input.ranker.augmentation?.status ?? null,
        modelFreshness: input.ranker.augmentation?.modelFreshness ?? null,
        closestVisitEdgeCount: input.ranker.augmentation?.closestVisitEdgeCount ?? null,
        rankerSourceEdgeCount: input.ranker.augmentation?.rankerSourceEdgeCount ?? null,
      }),
    },
    {
      id: 'ranker.methodology-spine',
      family: 'ranker',
      lane: 'diagnostic',
      servingImpact: 'observe-only',
      status: candidateStatusForMethodology(methodologySpine),
      reason: methodologySpine?.shipGate.reason ?? 'methodology-spine-unavailable',
      revisionId: input.ranker.activeRevisionId,
      asOf: input.ranker.augmentation?.asOf ?? rankerObservedAt ?? diagnosticsObservedAt,
      metrics: metrics({
        servingGateEnforced: methodologySpine?.servingGateEnforced ?? null,
        splitStatus: methodologySpine?.split.status ?? null,
        shipGateStatus: methodologySpine?.shipGate.status ?? null,
        shipGateCandidate: methodologySpine?.shipGate.candidate ?? null,
        shipGateV2Status: input.ranker.shipGateV2?.status ?? null,
        shipGateV2Reason: input.ranker.shipGateV2?.reason ?? null,
      }),
    },
    {
      id: 'ranker.training-mix',
      family: 'ranker',
      lane: 'diagnostic',
      servingImpact: 'observe-only',
      status: input.ranker.trainingMix === null ? 'unavailable' : 'ok',
      reason: input.ranker.trainingMix === null ? 'training-mix-unavailable' : null,
      revisionId: input.ranker.activeRevisionId,
      asOf: rankerObservedAt,
      metrics: metrics({
        positivesAtTrain: input.ranker.trainingMix?.positivesAtTrain ?? null,
        userFeedbackNegativesAtTrain:
          input.ranker.trainingMix?.userFeedbackNegativesAtTrain ?? null,
        trainingNegatives: input.ranker.trainingMix?.trainingNegatives ?? null,
        retrainNewLabelCount: input.ranker.retrainNewLabelCount,
      }),
    },
    {
      id: 'similarity.hot-incremental',
      family: 'similarity',
      // U2 — now ON by default + the actual decision is surfaced (was
      // a perpetual 'last-fast-path-decision-unavailable' standby).
      // servingImpact reflects whether the incremental path actually
      // ran this drain. Lane renamed 'standby' → 'incremental' on
      // 2026-05-27 (the IVM hot path IS the serving path in steady
      // state; "standby" misled in the panel).
      lane: 'incremental',
      servingImpact: booleanOrFalse(hotSim?.['usedHotPath']) ? 'serving' : 'not-serving',
      status: !hotSimilarityEnabled
        ? 'off'
        : hotSim === null
          ? 'pending'
          : booleanOrFalse(hotSim['usedHotPath'])
            ? 'ok'
            : 'pending',
      reason: !hotSimilarityEnabled
        ? 'env-off'
        : hotSim === null
          ? 'fast-path-decision-pending'
          : booleanOrFalse(hotSim['usedHotPath'])
            ? null
            : (stringOrNull(hotSim['reason']) ?? 'fast-path-fallback'),
      revisionId: null,
      asOf: hotSim === null ? liveObservedAt : diagnosticsObservedAt,
      metrics: metrics({
        envEnabled: hotSimilarityEnabled,
        envName: HOT_SIMILARITY_ENV,
        shouldEmbedOnHotPath:
          hotSim === null ? null : booleanOrFalse(hotSim['shouldEmbedOnHotPath']),
        usedHotPath: hotSim === null ? null : booleanOrFalse(hotSim['usedHotPath']),
        decisionReason: stringOrNull(hotSim?.['reason']),
        corpusSize: numberOrNull(hotSim?.['corpusSize']),
        newEmbedded: numberOrNull(hotSim?.['newEmbedded']),
        edgeCount: numberOrNull(hotSim?.['edgeCount']),
        runtimeMs: numberOrNull(hotSim?.['runtimeMs']),
      }),
    },
    {
      // Served-signal floor guard (flapping fix, requirement B). This
      // candidate is the visible, non-buried signal that a drain refused
      // to publish a >90% similarity-edge collapse and carried the
      // previous revision forward. `alarm` is the loudest DiagnosticCandidate
      // status; the /v1/system/health board renders the workGraph section
      // `unavailable`/`stale` on timeout but this row itself is the
      // operator-facing "the served signal flapped" flag.
      id: 'similarity.served-signal-floor',
      family: 'similarity',
      lane: 'active',
      servingImpact: 'serving',
      status:
        similarityFloor === null
          ? 'unavailable'
          : // CURRENT state only: this drain suppressed, OR the terminal
            // rendered-edge floor had to repair the served artifact (round 3),
            // OR the durable recent-window `flapping` signal is set. NOT the
            // lifetime count — that would latch `alarm` forever after a single
            // flap.
            booleanOrFalse(similarityFloor['suppressedCollapse']) ||
              booleanOrFalse(similarityFloor['renderRepaired']) ||
              booleanOrFalse(similarityFloor['flapping'])
            ? 'alarm'
            : 'ok',
      reason:
        similarityFloor === null
          ? 'similarity-floor-diagnostics-unavailable'
          : booleanOrFalse(similarityFloor['suppressedCollapse'])
            ? 'suppressed-collapse-this-drain'
            : booleanOrFalse(similarityFloor['renderRepaired'])
              ? 'rendered-collapse-repaired-this-drain'
              : booleanOrFalse(similarityFloor['flapping'])
                ? 'suppressed-collapse-recent'
                : (stringOrNull(similarityFloor['allowedResetReason']) === null
                    ? null
                    : `collapse-allowed:${stringOrNull(similarityFloor['allowedResetReason'])}`),
      revisionId: stringOrNull(similarityFloor?.['servedRevisionId']),
      asOf: diagnosticsObservedAt,
      metrics: metrics({
        suppressedCollapse:
          similarityFloor === null
            ? null
            : booleanOrFalse(similarityFloor['suppressedCollapse']),
        flapping:
          similarityFloor === null ? null : booleanOrFalse(similarityFloor['flapping']),
        suppressedCollapseCount: numberOrNull(similarityFloor?.['suppressedCollapseCount']),
        previousServedEdgeCount: numberOrNull(similarityFloor?.['previousServedEdgeCount']),
        builtEdgeCount: numberOrNull(similarityFloor?.['builtEdgeCount']),
        servedEdgeCount: numberOrNull(similarityFloor?.['servedEdgeCount']),
        allowedResetReason: stringOrNull(similarityFloor?.['allowedResetReason']),
        builtRevisionId: stringOrNull(similarityFloor?.['builtRevisionId']),
        // Round-3 render-layer — the served-artifact truth (what resolvers
        // read from current.db) + whether the terminal floor repaired it.
        renderRepaired:
          similarityFloor === null ? null : booleanOrFalse(similarityFloor['renderRepaired']),
        renderedSimilarityFamilyEdgeCount: numberOrNull(
          similarityFloor?.['renderedSimilarityFamilyEdgeCount'],
        ),
      }),
    },
    {
      id: 'topic.hot-incremental',
      family: 'topic',
      // Lane: see similarity.hot-incremental note. Same rename.
      lane: 'incremental',
      servingImpact: booleanOrFalse(hotTop?.['usedFastPath']) ? 'serving' : 'not-serving',
      status: !hotTopicsEnabled
        ? 'off'
        : hotTop === null
          ? 'pending'
          : booleanOrFalse(hotTop['usedFastPath']) || booleanOrFalse(hotTop['cacheHit'])
            ? 'ok'
            : 'pending',
      reason: !hotTopicsEnabled
        ? 'env-off'
        : hotTop === null
          ? 'fast-path-decision-pending'
          : booleanOrFalse(hotTop['usedFastPath'])
            ? null
            : booleanOrFalse(hotTop['cacheHit'])
              ? 'cache-hit'
              : 'no-accumulator-components',
      revisionId: null,
      asOf: hotTop === null ? liveObservedAt : diagnosticsObservedAt,
      metrics: metrics({
        envEnabled: hotTopicsEnabled,
        envName: HOT_TOPICS_ENV,
        usedFastPath: hotTop === null ? null : booleanOrFalse(hotTop['usedFastPath']),
        cacheHit: hotTop === null ? null : booleanOrFalse(hotTop['cacheHit']),
        componentCount: numberOrNull(hotTop?.['componentCount']),
        topicCount: numberOrNull(hotTop?.['topicCount']),
        runtimeMs: numberOrNull(hotTop?.['runtimeMs']),
      }),
    },
    {
      id: 'content-lane.dirty-source-queue',
      family: 'content-lane',
      // Queue health — not a standby alternative; rename per panel
      // cleanup 2026-05-27.
      lane: 'queue',
      servingImpact: 'not-serving',
      status: contentLaneStatus,
      reason:
        connectionsDiagnostics === null
          ? 'content-lane-snapshot-unavailable'
          : hasDirtySourceBacklog
            ? 'dirty-source-backlog'
            : hasDirtySourceWork
              ? 'dirty-source-pending'
              : null,
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({
        dirtySourceCount,
        tombstonedSourceCount,
        latestExtractionCount,
        oldestDirtySourceAgeMs,
        backlogWarnMs: CONTENT_LANE_BACKLOG_WARN_MS,
      }),
    },
    {
      // F8 W3 — repair-queue gauge + needs-repair condition row
      // (docs/plans/2026-08-16-f8-ivm-designs.md, "W3"). `reason` carries
      // the needs-repair marker's CLI command verbatim when present, so
      // the panel surfaces the exact command to run without a new UI
      // concept (Recovery consent rule item 2).
      id: 'reconcile.repair-queue',
      family: 'reconcile',
      lane: 'queue',
      servingImpact: 'not-serving',
      status:
        input.repairQueue.needsRepair !== null
          ? 'alarm'
          : input.repairQueue.status === 'unavailable'
            ? 'unavailable'
            : input.repairQueue.status === 'warning'
              ? 'warning'
              : 'ok',
      reason:
        input.repairQueue.needsRepair !== null
          ? `needs-repair: ${input.repairQueue.needsRepair.reason} — run: ${input.repairQueue.needsRepair.command}`
          : input.repairQueue.status === 'unavailable'
            ? 'repair-queue-store-unavailable'
            : input.repairQueue.status === 'warning'
              ? 'repair-queue-backlog'
              : null,
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({
        depth: input.repairQueue.depth,
        oldestEnqueuedAt: input.repairQueue.oldestEnqueuedAt,
        oldestAgeMs: input.repairQueue.oldestAgeMs,
        depthWarnThreshold: REPAIR_QUEUE_DEPTH_WARN_THRESHOLD,
        oldestAgeWarnMs: REPAIR_QUEUE_OLDEST_AGE_WARN_MS,
      }),
    },
    {
      id: 'reconcile.runner-mode',
      family: 'reconcile',
      lane: 'active',
      servingImpact: 'serving',
      status: 'ok',
      reason: runnerMode,
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({
        mode: runnerMode,
        inProcessEnv: envEnabled('SIDETRACK_CONNECTIONS_INPROCESS'),
        workerThreadEnv: envEnabled('SIDETRACK_CONNECTIONS_WORKER'),
        childProcessEnv: envEnabled('SIDETRACK_CONNECTIONS_CHILD'),
      }),
    },
    {
      id: 'quality.gray-zone-scorer',
      family: 'quality',
      lane: 'standby',
      servingImpact: 'not-serving',
      status: 'off',
      reason: 'no-runtime-model-injection',
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({ learnedModelLoaded: false }),
    },
  ];

  return allCandidates.filter((c) => !isStaleDiagnostic(c));
};

/**
 * True when v6 serving enforcement is live: the enforcement flag
 * (`SIDETRACK_RANKER_SERVE_V6`, or the legacy `SIDETRACK_RECALL_LEARNED_RERANK`
 * alias) is on AND the impression ship gate PASSED. Read inline from
 * process.env — the enforcement source of truth is learnedRerank.ts, but that
 * module pulls the heavy ranker/embedder graph the statusContract rule keeps
 * out of this status-reachable module, so the two-flag check is duplicated
 * here (and unit-tested against the enforcement path).
 */
export const rankerServingGateEnforced = (
  shipGateV2Status: 'pass' | 'fail' | 'unavailable' | null,
): boolean =>
  (process.env['SIDETRACK_RANKER_SERVE_V6'] === '1' ||
    process.env['SIDETRACK_RECALL_LEARNED_RERANK'] === '1') &&
  shipGateV2Status === 'pass';

/**
 * Overlay the LIVE, request-driven enforcement + shadow-diff signals onto a
 * workGraph report's `shipGateV2`. Needed because those two fields are read
 * at health-serve time (current env + the in-process rolling window), NOT at
 * drain time — so a report served from the drain-time artifact would
 * otherwise carry a frozen `servingGateEnforced` and a null `shadowDiff`. The
 * live `collectWorkGraphHealth` path already sets both, so this is idempotent
 * there; it exists so the artifact path (server.ts) refreshes them without a
 * full recompute. Returns the report unchanged when `shipGateV2` is null.
 */
export const withLiveShipGateV2Serving = (
  report: WorkGraphHealthReport,
  vaultRoot: string,
): WorkGraphHealthReport => {
  const shipGateV2 = report.ranker.shipGateV2;
  if (shipGateV2 === null) return report;
  return {
    ...report,
    ranker: {
      ...report.ranker,
      shipGateV2: {
        ...shipGateV2,
        servingGateEnforced: rankerServingGateEnforced(shipGateV2.status),
        shadowDiff: peekRankerShadowDiff(vaultRoot),
      },
    },
  };
};

export const collectWorkGraphHealth = async ({
  vaultRoot,
  eventLog,
  connectionsDiagnostics: readConnectionsDiagnostics,
  canonicalRecallStore,
  now = () => new Date(),
}: WorkGraphHealthDeps): Promise<WorkGraphHealthReport> => {
  const collectedAt = now().toISOString();
  const feedback = projectFeedback(await readFeedbackEvents(vaultRoot, eventLog));
  const merged = await readEventsForHealth(vaultRoot, eventLog, [
    'recall.served',
    'recall.action',
    // Move 2(b) — typed-index read so the rejected-relation diagnostics count
    // stays O(matching events), never a full-log scan.
    USER_REJECTED_RELATION,
  ]);
  // Learned aggregator-stats SHADOW (observe-only; default ON via
  // SIDETRACK_LEARNED_AGGREGATOR). Recomputed fresh from a BOUNDED typed
  // read every health poll (learnedAggregatorObservationEvents,
  // SIDETRACK_LEARNED_AGGREGATOR_WINDOW default 20,000/type) — no persisted
  // cross-poll cursor (that would live in connectionsMaterializer.ts's
  // drain, out of scope for a shadow this PR keeps out of the serving path;
  // see docs/plans/2026-08-15-foundation-program.md's design note). Changes
  // ZERO serving decisions: the registry (ranker/aggregatorProfiles.ts)
  // keeps deciding both guards; this only measures agreement.
  let aggregatorShadowAgreement: AggregatorShadowAgreement | null = null;
  if (learnedAggregatorShadowEnabled()) {
    const aggregatorEvents = await learnedAggregatorObservationEvents(vaultRoot, eventLog);
    const observations = aggregatorObservationsFromEvents(aggregatorEvents);
    const aggregatorState = applyAggregatorObservations(createEmptyAggregatorStatsState(), observations);
    const distinctUrls = new Set(observations.map((observation) => observation.canonicalUrl));
    const pairs: { readonly registryType: AggregatorPageType; readonly learnedType: AggregatorPageType }[] = [];
    for (const url of distinctUrls) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      pairs.push({
        registryType: classifyAggregatorPageForUrl(parsed),
        learnedType: classifyLearnedAggregatorUrl(aggregatorState, url),
      });
    }
    aggregatorShadowAgreement = buildAggregatorShadowAgreement(pairs);
  }
  const fingerprint = fingerprintFeedbackTrainingLabels(feedback);
  const [
    activeManifest,
    activeManifestProbe,
    retrainState,
    impressionRetrainState,
    onlineRankerState,
    ann,
    topicRevision,
    diagnostics,
    overCollapsedRecords,
    // W5 Phase B — the incremental topic-revision SHADOW's current
    // candidate-shadow revision (observe-only; never active/served). Read
    // fresh from disk (same pattern as `topicRevision` above) so the
    // topic/secondary counts + churn-vs-served in the health row reflect
    // the latest persisted shadow, not a stale drain-time snapshot.
    incrementalShadowRevision,
    repairQueue,
  ] = await Promise.all([
    readActiveClosestVisitRankerRevisionManifest(vaultRoot),
    readActiveClosestVisitRankerRevisionManifestProbe(vaultRoot),
    readRankerRetrainState(vaultRoot),
    readRecallImpressionRetrainState(vaultRoot),
    readOnlineRankerState(vaultRoot),
    annStatus(),
    createTopicRevisionStore(vaultRoot).readActiveRevision(),
    readLatestConnectionsDiagnostics(vaultRoot),
    scanForOverCollapsedPageContentCached(vaultRoot),
    createTopicRevisionStore(vaultRoot).readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY),
    readRepairQueueHealth(vaultRoot, now),
  ]);
  const augmentation = parseRankerAugmentationStatus(diagnostics);
  const activeRevision =
    activeManifest === null
      ? null
      : await readClosestVisitRankerRevision(vaultRoot, activeManifest.revisionId);
  // Round 1 #5 softening (2026-05-26): v6-from-legacy ("sparse") is no
  // longer marked invalid. The ship-gate decides serveability over
  // impression-level metrics; training source is informational only.
  // The flag is still surfaced as `trainingOrigin` for auditability.
  const activeV6FromLegacy =
    activeManifest?.modelVersion === 'lightgbm-lambdamart-v6' &&
    activeManifest.trainedFromImpressions === false;
  const retrainPlan = planRankerRetrain({ fingerprint, state: retrainState });
  const gradeHistogram = (
    activeRevision as { trainQuality?: { gradeHistogram?: Record<string, number> } } | null
  )?.trainQuality?.gradeHistogram;
  const trainingNegatives =
    gradeHistogram !== undefined && typeof gradeHistogram['0'] === 'number'
      ? gradeHistogram['0']
      : null;
  const trainingMix =
    retrainState === null
      ? null
      : {
          positivesAtTrain: retrainState.lastTrainedPositiveLabelCount,
          userFeedbackNegativesAtTrain: retrainState.lastTrainedNegativeLabelCount,
          trainingNegatives,
        };
  const datasetChangedSinceTrain =
    retrainState !== null && retrainState.lastTrainedLabelDatasetHash !== fingerprint.hash;
  const impressionTraining = summarizeRecallImpressionEvents(merged);
  // Env-aware floor — MUST match the real gate (`minRecallImpressionPositiveGroups`,
  // which honors SIDETRACK_RANKER_IMPRESSION_MIN_GROUPS). The old hardcoded
  // MIN_RECALL_IMPRESSION_POSITIVE_GROUPS diverged from the actual retrain
  // decision on dogfood companions that override the floor.
  const impressionGroupsRequired = minRecallImpressionPositiveGroups();
  const v6ColdStartSkipReason: RankerRetrainSkipReason | null =
    impressionTraining.groupCountWithPositives < impressionGroupsRequired
      ? 'insufficient_groups'
      : null;
  const activeLightgbmGate = activeManifest?.artifactQuality?.find(
    (artifact) => artifact.kind === 'lightgbm_lambdamart',
  )?.shipGate;
  const activeLightgbmV2GateFailed =
    activeLightgbmGate?.reason.startsWith(RECALL_IMPRESSION_SHIP_GATE_REASON_PREFIX) === true &&
    activeLightgbmGate.status !== 'pass';
  const v6ShipGateSkipReason: RankerRetrainSkipReason | null =
    v6ColdStartSkipReason !== null
      ? v6ColdStartSkipReason
      : impressionRetrainState?.status === 'ship_gate_failed' || activeLightgbmV2GateFailed
        ? 'ship_gate_failed'
        : null;
  const shipGateV2 =
    impressionRetrainState === null
      ? null
      : {
          status: impressionRetrainState.shipGateDecision.status,
          reason: impressionRetrainState.shipGateDecision.reason,
          revisionId: impressionRetrainState.revisionId,
          updatedAt: impressionRetrainState.updatedAt,
          activeNdcgAt10: impressionRetrainState.shipGateDecision.active.nDcgAt10,
          baselineNdcgAt10: impressionRetrainState.shipGateDecision.baseline.nDcgAt10,
          activeMrr: impressionRetrainState.shipGateDecision.active.mrr,
          baselineMrr: impressionRetrainState.shipGateDecision.baseline.mrr,
          explicitRejectPrecisionDelta:
            impressionRetrainState.shipGateDecision.deltas.explicitRejectPrecision,
          // Enforcement is live only when the flag is on AND this gate passed.
          servingGateEnforced: rankerServingGateEnforced(
            impressionRetrainState.shipGateDecision.status,
          ),
          shadowDiff: peekRankerShadowDiff(vaultRoot),
        };
  const activeRevisionId =
    activeManifest?.revisionId ?? activeManifestProbe?.revisionId ?? null;
  // Single source of truth for "would a retrain run right now" — the same
  // value surfaced as `retrainSkipReason`. `nextRetrain.eligible` is its
  // exact negation so the two never disagree.
  //
  // Precedence mirrors the DRAIN's control flow, not a fixed ranking:
  // when the impression path is cold (groups below the floor) the drain
  // falls through to the legacy label path, and that path trains AND
  // promotes unconditionally — so a train-ready legacy plan means there
  // is no skip reason, and `insufficient_groups` must not mask it (it
  // did: the panel showed "blocked" while the next drain would train).
  const retrainSkipReason: RankerRetrainSkipReason | null =
    v6ColdStartSkipReason !== null && retrainPlan.action === 'train'
      ? null
      : (v6ShipGateSkipReason ?? (retrainPlan.action === 'skip' ? retrainPlan.reason : null));
  // Next-retrain progress — surface BOTH gates the trainer checks so the
  // UI can show "what has to happen before the model retrains": the v6
  // impression path (positive groups toward the floor) and the legacy
  // label path (new positive labels toward the threshold).
  const rawNewLabelThreshold = Number(process.env[RANKER_RETRAIN_LABEL_THRESHOLD_ENV]);
  const newLabelsRequired = Math.max(
    1,
    Math.floor(
      Number.isFinite(rawNewLabelThreshold)
        ? rawNewLabelThreshold
        : DEFAULT_RANKER_RETRAIN_LABEL_THRESHOLD,
    ),
  );
  const nextRetrain = {
    eligible: retrainSkipReason === null,
    positiveGroups: {
      current: impressionTraining.groupCountWithPositives,
      required: impressionGroupsRequired,
    },
    newLabels: { current: retrainPlan.newLabelCount, required: newLabelsRequired },
    cooldownMs: DEFAULT_RANKER_RETRAIN_COOLDOWN_MS,
  };
  // Online-adaptation head. `enabled` = SIDETRACK_ONLINE_RANKER flag;
  // `inUse` = enabled AND a persisted state exists AND its base matches
  // the served model (so its clamped delta is actually blended). Read
  // from env directly to avoid a heavy onlineHead.ts import here.
  const onlineRankerFlag = process.env['SIDETRACK_ONLINE_RANKER'] === '1';
  const onlineHead = {
    enabled: onlineRankerFlag,
    present: onlineRankerState !== null,
    inUse:
      onlineRankerFlag &&
      onlineRankerState !== null &&
      onlineRankerState.baseRevisionId === activeRevisionId,
    baseRevisionId: onlineRankerState?.baseRevisionId ?? null,
    updateCount: onlineRankerState?.updateCount ?? 0,
    activeWeightCount:
      onlineRankerState === null
        ? 0
        : onlineRankerState.weights.filter((weight) => weight !== 0).length,
    updatedAtMs:
      onlineRankerState !== null && onlineRankerState.updatedAtMs > 0
        ? onlineRankerState.updatedAtMs
        : null,
    lastNudgeAtMs: onlineRankerState?.lastNudgeAtMs ?? null,
  };
  const ranker: WorkGraphHealthReport['ranker'] = {
    activeRevisionId,
    loadStatus:
      activeManifest === null
        ? activeManifestProbe === null
          ? 'missing'
          : 'invalid-model'
        : activeRevision === null
          ? 'invalid-model'
          : 'ready',
    loadReason:
      activeManifest === null
        ? activeManifestProbe === null
          ? 'no-active-manifest'
          : 'invalid-active-model'
        : activeRevision === null
          ? 'invalid-active-model'
          : null,
    activeModelVersion:
      activeManifestProbe?.activeModelVersion ?? activeManifest?.modelVersion ?? null,
    expectedModelVersion:
      activeManifestProbe?.expectedModelVersion ?? expectedClosestVisitRankerSchema.modelVersion,
    activeFeatureSchemaVersion:
      activeManifestProbe?.activeFeatureSchemaVersion ??
      activeManifest?.featureSchemaVersion ??
      null,
    expectedFeatureSchemaVersion:
      activeManifestProbe?.expectedFeatureSchemaVersion ??
      expectedClosestVisitRankerSchema.featureSchemaVersion,
    needsRetrain: activeManifestProbe?.staleModelSchema ?? false,
    trainedAt: activeManifest?.trainedAt ?? null,
    trainingDatasetHash: activeManifest?.trainingDatasetHash ?? null,
    retrainSkipReason,
    retrainNewLabelCount: retrainPlan.newLabelCount,
    shipGateV2,
    methodologySpine: rankerMethodologySpineDiagnosticsFromTrainQuality(
      activeManifest?.trainQuality,
    ),
    trainingMix,
    datasetChangedSinceTrain,
    expandedNegativeCount: 0,
    labelDriftWithoutFeedback: 0,
    rawPositiveCount: impressionTraining.rawPositiveCount,
    rawNegativeCount: impressionTraining.rawNegativeCount,
    groupCount: impressionTraining.groupCount,
    avgCandidatesPerGroup: impressionTraining.avgCandidatesPerGroup,
    positivesPerGroup: impressionTraining.positivesPerGroup,
    explicitRejectsPerGroup: impressionTraining.explicitRejectsPerGroup,
    unjudgedCandidatesPerGroup: impressionTraining.unjudgedCandidatesPerGroup,
    candidateSourceDistribution: impressionTraining.candidateSourceDistribution,
    augmentation,
    nextRetrain,
    onlineHead,
  };
  const topicProducer: WorkGraphHealthReport['topicProducer'] = {
    activeRevisionId: topicRevision?.revisionId ?? null,
    algorithmVersion: topicRevision?.algorithmVersion ?? null,
    topicCount: topicRevision?.topics.length ?? 0,
    lineageCount: topicRevision?.lineage.length ?? 0,
  };
  const connectionsDiagnosticSnapshot = readConnectionsDiagnostics?.() ?? null;
  const topicProducedAt =
    topicRevision === null ? null : new Date(topicRevision.producedAt).toISOString();
  // W5 Phase B — churn/quality of the incremental topic-revision shadow
  // vs the currently SERVED (active) topic revision, derived fresh from
  // the two on-disk revisions (never stored ahead of time) via the same
  // pure churn/lineage math the leiden-cpm served-producer report uses.
  // `producer` here is a shape placeholder only (buildServedTopicProducerReport
  // never branches on it) — the incremental shadow has no ServedTopicProducer
  // member of its own since it's never served.
  const incrementalShadowReport: ServedTopicProducerReport | null =
    incrementalShadowRevision === null
      ? null
      : buildServedTopicProducerReport('leiden-cpm', incrementalShadowRevision, topicRevision);
  const incrementalShadowSecondaryCount =
    incrementalShadowRevision === null
      ? null
      : incrementalShadowRevision.topics.reduce(
          (sum, topic) => sum + (topic.secondaryAffiliations?.length ?? 0),
          0,
        );
  // Phase 0 — count recall.served + recall.action events from the
  // merged log. Cheap single pass; same data the trainer reads.
  let servedCount = 0;
  let actionCount = 0;
  const actionsByKind: Record<string, number> = {};
  // Move 2(b) — count persisted USER_REJECTED_RELATION assertions for the
  // ranker/health diagnostics. Collect-store-only: this is a visibility
  // counter; no consumer applies the rejection to serving/edges yet.
  let rejectedRelationCount = 0;
  const rejectedRelationsBySurface: Record<string, number> = {};
  for (const event of merged) {
    if (event.type === 'recall.served') {
      servedCount += 1;
    } else if (event.type === 'recall.action') {
      actionCount += 1;
      const kind = (event.payload as { actionKind?: unknown })?.actionKind;
      if (typeof kind === 'string') {
        actionsByKind[kind] = (actionsByKind[kind] ?? 0) + 1;
      }
    } else if (event.type === USER_REJECTED_RELATION && isUserRejectedRelationPayload(event.payload)) {
      rejectedRelationCount += 1;
      const surface = event.payload.surface;
      rejectedRelationsBySurface[surface] = (rejectedRelationsBySurface[surface] ?? 0) + 1;
    }
  }
  const impressionLog: WorkGraphHealthReport['impressionLog'] = {
    servedCount,
    actionCount,
    actionsByKind,
  };
  const labelChannels: WorkGraphHealthReport['labelChannels'] = {
    weakNegativesEnabled: weakNegativesEnabled(),
    rejectedRelations: {
      count: rejectedRelationCount,
      bySurface: rejectedRelationsBySurface,
    },
  };
  // Phase 5 — dogfood-config snapshot. Values are constants here
  // because the server-side wiring is the single source of truth
  // (http/server.ts sets DOGFOOD_RERANK_TOP_K on every /v2/recall).
  //
  // Phase 4 — canonicalVectorCounts default to 0 (the SQLite store
  // is lazily opened on first /v2/recall; a health poll BEFORE that
  // legitimately sees 0). Live counts populate when the store is
  // injected via `canonicalRecallStore` dep — see WorkGraphHealthDeps.
  // The runtime canonical truth lives in
  // recall-v2/store/sqlite.ts (documents_vec + documents_chunks_vec).
  const DOGFOOD_RERANK_TOP_K = 20;
  let documentVectorCount = 0;
  let chunkVectorCount = 0;
  if (canonicalRecallStore !== undefined) {
    try {
      documentVectorCount = canonicalRecallStore.allVectorEntityIds().size;
      chunkVectorCount = canonicalRecallStore.allChunkVectorIds().size;
    } catch {
      // Store probe failures are non-fatal for health; counts stay 0.
    }
  }
  const recall: WorkGraphHealthReport['recall'] = {
    retrievalBackend: 'v2',
    vectorStore: 'sqlite',
    fusionImplementation: 'recall-v2',
    crossEncoder: {
      enabled: true,
      rerankTopK: DOGFOOD_RERANK_TOP_K,
    },
    canonicalVectorCounts: {
      documentVectorCount,
      chunkVectorCount,
    },
    canonicalizationTelemetry: canonicalizationTelemetry(),
  };
  const hygiene: WorkGraphHealthReport['hygiene'] = {
    overCollapsedRecords: {
      count: overCollapsedRecords.length,
      samples: overCollapsedRecords.slice(0, 5),
    },
  };
  return {
    ranker,
    ann,
    feedback: {
      actionCount: countFeedbackActions(feedback.perItem),
      positiveLabelCount: feedback.positiveLabels.length,
      negativeLabelCount: feedback.negativeLabels.length,
    },
    topicProducer,
    impressionLog,
    labelChannels,
    recall,
    hygiene,
    repairQueue,
    candidates: buildDiagnosticCandidates({
      ranker,
      topicProducer,
      diagnostics,
      connectionsDiagnostics: connectionsDiagnosticSnapshot,
      collectedAt,
      topicProducedAt,
      incrementalShadowRevisionId: incrementalShadowRevision?.revisionId ?? null,
      incrementalShadowReport,
      incrementalShadowSecondaryCount,
      repairQueue,
      aggregatorShadowEnabled: learnedAggregatorShadowEnabled(),
      aggregatorShadowAgreement,
    }),
  };
};
