import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
import { projectFeedback } from '../feedback/projection.js';
import { loadDefaultUsearch } from '../recall/ann-index.js';
import {
  fingerprintFeedbackTrainingLabels,
  planRankerRetrain,
  readRankerRetrainState,
  type RankerRetrainSkipReason,
} from '../ranker/retrain.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';

type DiagnosticCandidateMetric = string | number | boolean | null;

export interface DiagnosticCandidate {
  readonly id: string;
  readonly family: 'topic' | 'similarity' | 'ranker' | 'content-lane' | 'reconcile' | 'quality';
  readonly lane: 'active' | 'standby' | 'shadow' | 'diagnostic';
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
    readonly activeModelVersion: string | null;
    readonly expectedModelVersion: string;
    readonly activeFeatureSchemaVersion: number | null;
    readonly expectedFeatureSchemaVersion: number;
    readonly needsRetrain: boolean;
    readonly trainedAt: number | null;
    readonly trainingDatasetHash: string | null;
    readonly retrainSkipReason: RankerRetrainSkipReason | null;
    readonly retrainNewLabelCount: number;
    readonly methodologySpine: MaterializerRankerMethodologySpineDiagnostics | null;
    // Honest training mix (plan TODO-R5/X1). `negativeLabelCount`
    // alone is the misleading-metric trap: it counts only explicit
    // user-feedback negatives at last train (historically 0, and even
    // those were dropped pre-fix). The model actually trains on
    // grade-0 rows — synthetic random_unrelated/recently_skipped plus
    // the now-derived visit-pair negatives. Surface all three so a
    // reader cannot mistake "0 user negatives" for "no negatives".
    readonly trainingMix: {
      readonly positivesAtTrain: number;
      readonly userFeedbackNegativesAtTrain: number;
      // grade-0 training rows from the model manifest (synthetic +
      // derived). null when the active manifest predates trainQuality
      // capture — rendered as "unknown", never as 0.
      readonly trainingNegatives: number | null;
    } | null;
    // True when the current feedback fingerprint differs from what the
    // active model was trained on — "data changed, model is behind".
    readonly datasetChangedSinceTrain: boolean;
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
}

const emptyEvents: readonly AcceptedEvent[] = [];

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
    oldestDirtySourceAgeMs !== null && oldestDirtySourceAgeMs > CONTENT_LANE_BACKLOG_WARN_MS;
  const contentLaneStatus: DiagnosticCandidate['status'] =
    connectionsDiagnostics === null
      ? 'unavailable'
      : hasDirtySourceBacklog
        ? 'warning'
        : hasDirtySourceWork
          ? 'pending'
          : 'ok';
  const hotSimilarityEnabled = envEnabled('SIDETRACK_CONNECTIONS_HOT_SIMILARITY');
  const hotTopicsEnabled = envEnabled('SIDETRACK_CONNECTIONS_HOT_TOPICS');
  const runnerMode = reconcileRunnerMode();

  return [
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
        input.ranker.loadStatus === 'ready'
          ? null
          : input.ranker.loadStatus === 'missing'
            ? 'no-active-manifest'
            : 'invalid-active-model',
      revisionId: input.ranker.activeRevisionId,
      asOf: rankerObservedAt,
      metrics: metrics({
        loadStatus: input.ranker.loadStatus,
        activeModelVersion: input.ranker.activeModelVersion,
        expectedModelVersion: input.ranker.expectedModelVersion,
        activeFeatureSchemaVersion: input.ranker.activeFeatureSchemaVersion,
        expectedFeatureSchemaVersion: input.ranker.expectedFeatureSchemaVersion,
        needsRetrain: input.ranker.needsRetrain,
        datasetChangedSinceTrain: input.ranker.datasetChangedSinceTrain,
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
      lane: 'standby',
      servingImpact: 'not-serving',
      status: hotSimilarityEnabled ? 'pending' : 'off',
      reason: hotSimilarityEnabled ? 'last-fast-path-decision-unavailable' : 'env-off',
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({
        envEnabled: hotSimilarityEnabled,
        envName: 'SIDETRACK_CONNECTIONS_HOT_SIMILARITY',
        lastFastPathDecision: null,
      }),
    },
    {
      id: 'topic.hot-incremental',
      family: 'topic',
      lane: 'standby',
      servingImpact: 'not-serving',
      status: hotTopicsEnabled ? 'pending' : 'off',
      reason: hotTopicsEnabled ? 'last-fast-path-decision-unavailable' : 'env-off',
      revisionId: null,
      asOf: liveObservedAt,
      metrics: metrics({
        envEnabled: hotTopicsEnabled,
        envName: 'SIDETRACK_CONNECTIONS_HOT_TOPICS',
        lastFastPathDecision: null,
      }),
    },
    {
      id: 'content-lane.dirty-source-queue',
      family: 'content-lane',
      lane: 'standby',
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
};

export const collectWorkGraphHealth = async ({
  vaultRoot,
  eventLog,
  connectionsDiagnostics: readConnectionsDiagnostics,
  now = () => new Date(),
}: WorkGraphHealthDeps): Promise<WorkGraphHealthReport> => {
  const collectedAt = now().toISOString();
  const merged = eventLog === undefined ? emptyEvents : await eventLog.readMerged();
  const feedback = projectFeedback(merged);
  const fingerprint = fingerprintFeedbackTrainingLabels(feedback);
  const [activeManifest, activeManifestProbe, retrainState, ann, topicRevision, diagnostics] =
    await Promise.all([
      readActiveClosestVisitRankerRevisionManifest(vaultRoot),
      readActiveClosestVisitRankerRevisionManifestProbe(vaultRoot),
      readRankerRetrainState(vaultRoot),
      annStatus(),
      createTopicRevisionStore(vaultRoot).readActiveRevision(),
      readLatestConnectionsDiagnostics(vaultRoot),
    ]);
  const augmentation = parseRankerAugmentationStatus(diagnostics);
  const activeRevision =
    activeManifest === null
      ? null
      : await readClosestVisitRankerRevision(vaultRoot, activeManifest.revisionId);
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
    retrainSkipReason: retrainPlan.action === 'skip' ? retrainPlan.reason : null,
    retrainNewLabelCount: retrainPlan.newLabelCount,
    methodologySpine: rankerMethodologySpineDiagnosticsFromTrainQuality(
      activeManifest?.trainQuality,
    ),
    trainingMix,
    datasetChangedSinceTrain,
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
  return {
    ranker,
    ann,
    feedback: {
      actionCount: countFeedbackActions(feedback.perItem),
      positiveLabelCount: feedback.positiveLabels.length,
      negativeLabelCount: feedback.negativeLabels.length,
    },
    topicProducer,
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
