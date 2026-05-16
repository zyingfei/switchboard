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
import { createTopicRevisionStore } from '../producers/topic-revision.js';
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
}

export interface WorkGraphHealthDeps {
  readonly vaultRoot: string;
  readonly eventLog?: EventLog;
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

const readRankerAugmentationStatus = async (
  vaultRoot: string,
): Promise<WorkGraphHealthReport['ranker']['augmentation']> => {
  try {
    const raw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
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
      asOf: stringOrNull(parsed['producedAt']),
    };
  } catch {
    return null;
  }
};

export const collectWorkGraphHealth = async ({
  vaultRoot,
  eventLog,
}: WorkGraphHealthDeps): Promise<WorkGraphHealthReport> => {
  const merged = eventLog === undefined ? emptyEvents : await eventLog.readMerged();
  const feedback = projectFeedback(merged);
  const fingerprint = fingerprintFeedbackTrainingLabels(feedback);
  const [activeManifest, activeManifestProbe, retrainState, ann, topicRevision, augmentation] =
    await Promise.all([
      readActiveClosestVisitRankerRevisionManifest(vaultRoot),
      readActiveClosestVisitRankerRevisionManifestProbe(vaultRoot),
      readRankerRetrainState(vaultRoot),
      annStatus(),
      createTopicRevisionStore(vaultRoot).readActiveRevision(),
      readRankerAugmentationStatus(vaultRoot),
    ]);
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
  return {
    ranker: {
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
    },
    ann,
    feedback: {
      actionCount: countFeedbackActions(feedback.perItem),
      positiveLabelCount: feedback.positiveLabels.length,
      negativeLabelCount: feedback.negativeLabels.length,
    },
    topicProducer: {
      activeRevisionId: topicRevision?.revisionId ?? null,
      algorithmVersion: topicRevision?.algorithmVersion ?? null,
      topicCount: topicRevision?.topics.length ?? 0,
      lineageCount: topicRevision?.lineage.length ?? 0,
    },
  };
};
