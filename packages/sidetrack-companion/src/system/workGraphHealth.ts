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
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionStore,
} from '../producers/topic-revision.js';
import {
  HOT_SIMILARITY_ENV,
  HOT_TOPICS_ENV,
  hotSimilarityModeEnabled,
  hotTopicsModeEnabled,
} from '../connections/hotPathMode.js';
import { projectFeedback } from '../feedback/projection.js';
import { loadDefaultUsearch } from '../recall/ann-index.js';
import {
  MIN_RECALL_IMPRESSION_POSITIVE_GROUPS,
  RECALL_IMPRESSION_SHIP_GATE_REASON_PREFIX,
  readRecallImpressionRetrainState,
  summarizeRecallImpressionEvents,
} from '../ranker/retrain-impressions.js';
import {
  fingerprintFeedbackTrainingLabels,
  planRankerRetrain,
  readRankerRetrainState,
  type RankerRetrainSkipReason,
} from '../ranker/retrain.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';
import type { EventLog } from '../sync/eventLog.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
} from '../feedback/events.js';

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

const readEventsForHealth = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
  predicate: (event: AcceptedEvent) => boolean,
): Promise<readonly AcceptedEvent[]> => {
  if (eventLog === undefined) return emptyEvents;
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return (await eventLog.readMerged()).filter(predicate);
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunk((chunk) => {
    for (const event of chunk) {
      if (predicate(event)) events.push(event);
    }
  }, 2000);
  return events;
};

const readFeedbackEvents = (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<readonly AcceptedEvent[]> =>
  readEventsForHealth(vaultRoot, eventLog, (event) => feedbackEventTypes.has(event.type));

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
}): readonly DiagnosticCandidate[] => {
  const producedAt = input.diagnostics.producedAt;
  const diagnosticsObservedAt = producedAt;
  const liveObservedAt = input.collectedAt;
  const topicObservedAt = input.topicProducedAt ?? liveObservedAt;
  const rankerObservedAt = millisToIso(input.ranker.trainedAt) ?? liveObservedAt;
  const raw = input.diagnostics.raw;
  const shadow = raw !== null && isRecord(raw['shadowVsBaseline']) ? raw['shadowVsBaseline'] : null;
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
    // Legacy methodology spine when not populated (shipGateV2 owns this surface now).
    if (cand.id === 'ranker.methodology-spine' && cand.status === 'unavailable') return true;
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

export const collectWorkGraphHealth = async ({
  vaultRoot,
  eventLog,
  connectionsDiagnostics: readConnectionsDiagnostics,
  canonicalRecallStore,
  now = () => new Date(),
}: WorkGraphHealthDeps): Promise<WorkGraphHealthReport> => {
  const collectedAt = now().toISOString();
  const feedback = projectFeedback(await readFeedbackEvents(vaultRoot, eventLog));
  const merged = await readEventsForHealth(
    vaultRoot,
    eventLog,
    (event) => event.type === 'recall.served' || event.type === 'recall.action',
  );
  const fingerprint = fingerprintFeedbackTrainingLabels(feedback);
  const [
    activeManifest,
    activeManifestProbe,
    retrainState,
    impressionRetrainState,
    ann,
    topicRevision,
    diagnostics,
    overCollapsedRecords,
  ] = await Promise.all([
    readActiveClosestVisitRankerRevisionManifest(vaultRoot),
    readActiveClosestVisitRankerRevisionManifestProbe(vaultRoot),
    readRankerRetrainState(vaultRoot),
    readRecallImpressionRetrainState(vaultRoot),
    annStatus(),
    createTopicRevisionStore(vaultRoot).readActiveRevision(),
    readLatestConnectionsDiagnostics(vaultRoot),
    scanForOverCollapsedPageContentCached(vaultRoot),
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
  const v6ColdStartSkipReason: RankerRetrainSkipReason | null =
    impressionTraining.groupCountWithPositives < MIN_RECALL_IMPRESSION_POSITIVE_GROUPS
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
        };
  const ranker: WorkGraphHealthReport['ranker'] = {
    activeRevisionId: activeManifest?.revisionId ?? activeManifestProbe?.revisionId ?? null,
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
    retrainSkipReason:
      v6ShipGateSkipReason ?? (retrainPlan.action === 'skip' ? retrainPlan.reason : null),
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
  // Phase 0 — count recall.served + recall.action events from the
  // merged log. Cheap single pass; same data the trainer reads.
  let servedCount = 0;
  let actionCount = 0;
  const actionsByKind: Record<string, number> = {};
  for (const event of merged) {
    if (event.type === 'recall.served') {
      servedCount += 1;
    } else if (event.type === 'recall.action') {
      actionCount += 1;
      const kind = (event.payload as { actionKind?: unknown })?.actionKind;
      if (typeof kind === 'string') {
        actionsByKind[kind] = (actionsByKind[kind] ?? 0) + 1;
      }
    }
  }
  const impressionLog: WorkGraphHealthReport['impressionLog'] = {
    servedCount,
    actionCount,
    actionsByKind,
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
    recall,
    hygiene,
    candidates: buildDiagnosticCandidates({
      ranker,
      topicProducer,
      diagnostics,
      connectionsDiagnostics: connectionsDiagnosticSnapshot,
      collectedAt,
      topicProducedAt,
    }),
  };
};
