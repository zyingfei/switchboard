import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FEATURE_SCHEMA_VERSION } from '../ranker/feature-schema.js';
import {
  COMBINER_FEATURE_COUNT,
  DETERMINISTIC_BASELINE_VERSION,
  LOGISTIC_BATCH_FEATURE_STATS_VERSION,
  RANKER_FEATURE_KEYS,
  RANKER_MODEL_VERSION,
  REGULARIZED_LOGISTIC_REGRESSION_VERSION,
  type RankerArtifactKind,
  type RankerArtifactQuality,
  type RankerArtifactShipGate,
  type RankerRevision,
  type RankerTrainQuality,
} from '../ranker/train.js';

const CLOSEST_VISIT_REVISION_DIR = '_BAC/connections/closest-visit';

export interface ClosestVisitRankerRevisionManifest {
  readonly revisionId: string;
  readonly modelVersion: RankerRevision['modelVersion'];
  readonly featureSchemaVersion: RankerRevision['featureSchemaVersion'];
  readonly trainingDatasetHash: string;
  readonly trainedAt: number;
  readonly trainedFromImpressions: boolean;
  readonly modelByteLength: number;
  readonly modelSha256: string;
  /**
   * Optional train-time observability. Absent on manifests written
   * before this field existed; readers must treat it as best-effort.
   * Its presence/absence never gates scoring (featureSchemaVersion is
   * unchanged) so the refuse-to-score invariant is preserved.
   */
  readonly trainQuality?: RankerTrainQuality;
  /**
   * Per-artifact ship-gate records (Step 2 of the incremental-ranker
   * plan). One entry per trained artifact (graph_baseline,
   * logistic_batch, lightgbm_lambdamart today; logistic_online and
   * lightgbm_plus_online_lr land with later steps). Optional with
   * lenient parse so older manifests stay readable.
   */
  readonly artifactQuality?: readonly RankerArtifactQuality[];
  /**
   * Step 3 — the regularized LR's trained weights, persisted alongside
   * the LightGBM bytes so the selector (Step 4) can route scoring to
   * LR when LightGBM fails its ship-gate. Length = RANKER_FEATURE_KEYS
   * + 1 (bias). `featureStatsVersion` records the normalization regime
   * the weights expect; the loader refuses to score under a different
   * regime (future-proof: the current trainer uses raw features /
   * `'no-normalization-v1'`).
   */
  readonly logisticBatchWeights?: readonly number[];
  readonly logisticBatchFeatureStatsVersion?: typeof LOGISTIC_BATCH_FEATURE_STATS_VERSION;
  /**
   * Step 8 — combiner weights (bias + per-COMBINER_FEATURE_KIND, 4
   * floats total). Serving applies these to per-artifact scores
   * computed from the same revision's lgb + lr_batch + baseline.
   * Optional with lenient parse so older manifests stay readable.
   */
  readonly combinerWeights?: readonly number[];
  /**
   * Step 9 — per-container bias offsets (framework only; algorithm
   * is plan-deferred until replay-eval evidence justifies it).
   * Container ID → bias scalar; serving adds bias_c to the global
   * LR's score for the candidate's shared container. Optional with
   * lenient parse.
   */
  readonly perContainerBiases?: {
    readonly perWorkstream: Readonly<Record<string, number>>;
    readonly perTopic: Readonly<Record<string, number>>;
  };
}

export interface ClosestVisitRankerRevisionManifestProbe {
  readonly revisionId: string | null;
  readonly activeModelVersion: string | null;
  readonly expectedModelVersion: typeof RANKER_MODEL_VERSION;
  readonly activeFeatureSchemaVersion: number | null;
  readonly expectedFeatureSchemaVersion: typeof FEATURE_SCHEMA_VERSION;
  readonly staleModelSchema: boolean;
}

export const expectedClosestVisitRankerSchema = {
  modelVersion: RANKER_MODEL_VERSION,
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const toOwnedArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const modelBytesFor = (revision: RankerRevision): Uint8Array => new Uint8Array(revision.modelBytes);

export const closestVisitRevisionDir = (vaultRoot: string): string =>
  join(vaultRoot, CLOSEST_VISIT_REVISION_DIR);

export const closestVisitRevisionManifestPath = (vaultRoot: string, revisionId: string): string =>
  join(closestVisitRevisionDir(vaultRoot), `${revisionId}.json`);

export const closestVisitRevisionModelPath = (vaultRoot: string, revisionId: string): string =>
  join(closestVisitRevisionDir(vaultRoot), `${revisionId}.model.b64`);

export const activeClosestVisitRevisionManifestPath = (vaultRoot: string): string =>
  join(closestVisitRevisionDir(vaultRoot), 'current.json');

const manifestForRevision = (revision: RankerRevision): ClosestVisitRankerRevisionManifest => {
  const modelBytes = modelBytesFor(revision);
  return {
    revisionId: revision.revisionId,
    modelVersion: revision.modelVersion,
    featureSchemaVersion: revision.featureSchemaVersion,
    trainingDatasetHash: revision.trainingDatasetHash,
    trainedAt: revision.trainedAt,
    trainedFromImpressions: revision.trainedFromImpressions,
    modelByteLength: modelBytes.byteLength,
    modelSha256: sha256Hex(modelBytes),
    ...(revision.trainQuality === undefined ? {} : { trainQuality: revision.trainQuality }),
    ...(revision.artifactQuality === undefined
      ? {}
      : { artifactQuality: revision.artifactQuality }),
    ...(revision.logisticBatchWeights === undefined
      ? {}
      : { logisticBatchWeights: revision.logisticBatchWeights }),
    ...(revision.logisticBatchFeatureStatsVersion === undefined
      ? {}
      : { logisticBatchFeatureStatsVersion: revision.logisticBatchFeatureStatsVersion }),
    ...(revision.combinerWeights === undefined
      ? {}
      : { combinerWeights: revision.combinerWeights }),
    ...(revision.perContainerBiases === undefined
      ? {}
      : { perContainerBiases: revision.perContainerBiases }),
  };
};

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const isGradeHistogram = (value: unknown): value is RankerTrainQuality['gradeHistogram'] => {
  if (!isRecord(value)) return false;
  return (['0', '1', '2', '3', '4'] as const).every(
    (grade) =>
      typeof value[grade] === 'number' && Number.isInteger(value[grade]) && value[grade] >= 0,
  );
};

const normalizeCandidateLabeling = (
  value: unknown,
): RankerTrainQuality['candidateLabeling'] | undefined => {
  if (!isRecord(value)) return undefined;
  const totalCandidates = value['totalCandidates'];
  const labeledRows = value['labeledRows'];
  const positiveRows = value['positiveRows'];
  const negativeRows = value['negativeRows'];
  const implicitNegativeRows = value['implicitNegativeRows'];
  const unlabeledCandidateCount = value['unlabeledCandidateCount'];
  if (
    typeof totalCandidates !== 'number' ||
    typeof labeledRows !== 'number' ||
    typeof positiveRows !== 'number' ||
    typeof negativeRows !== 'number' ||
    typeof implicitNegativeRows !== 'number' ||
    typeof unlabeledCandidateCount !== 'number'
  ) {
    return undefined;
  }
  return {
    totalCandidates,
    labeledRows,
    positiveRows,
    negativeRows,
    implicitNegativeRows,
    unlabeledCandidateCount,
  };
};

const normalizeSimpleMetric = (
  value: unknown,
): { readonly kind: string; readonly value: number } | undefined =>
  isRecord(value) && typeof value['kind'] === 'string' && isFiniteNumber(value['value'])
    ? { kind: value['kind'], value: value['value'] }
    : undefined;

const stringArrayOrUndefined = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;

const normalizeTuning = (
  value: unknown,
): NonNullable<RankerTrainQuality['methodologySpine']>['tuning'] => {
  const fallback = {
    status: 'unavailable' as const,
    strategy: 'validation-num-round-grid' as const,
    requestedNumRound: 0,
    selectedNumRound: 0,
    validationCandidateCount: 0,
    candidates: [],
    reason: 'split-unavailable' as const,
  };
  if (!isRecord(value)) return fallback;
  const rawCandidates = value['candidates'];
  const candidates =
    Array.isArray(rawCandidates) &&
    rawCandidates.every(
      (candidate) =>
        isRecord(candidate) &&
        isFiniteNumber(candidate['numRound']) &&
        (candidate['metric'] === undefined ||
          normalizeSimpleMetric(candidate['metric']) !== undefined),
    )
      ? rawCandidates.map((candidate) => {
          if (!isRecord(candidate) || !isFiniteNumber(candidate['numRound'])) {
            return { numRound: 0 };
          }
          const metric = normalizeSimpleMetric(candidate['metric']);
          return {
            numRound: candidate['numRound'],
            ...(metric === undefined ? {} : { metric }),
          };
        })
      : [];
  const reason =
    value['reason'] === 'split-unavailable' || value['reason'] === 'validation-metric-unavailable'
      ? value['reason']
      : undefined;
  if (
    (value['status'] !== 'available' && value['status'] !== 'unavailable') ||
    value['strategy'] !== 'validation-num-round-grid' ||
    !isFiniteNumber(value['requestedNumRound']) ||
    !isFiniteNumber(value['selectedNumRound']) ||
    !isFiniteNumber(value['validationCandidateCount'])
  ) {
    return fallback;
  }
  return {
    status: value['status'],
    strategy: 'validation-num-round-grid',
    requestedNumRound: value['requestedNumRound'],
    selectedNumRound: value['selectedNumRound'],
    validationCandidateCount: value['validationCandidateCount'],
    candidates,
    ...(reason === undefined ? {} : { reason }),
  };
};

const normalizeModelChoice = (
  value: unknown,
): NonNullable<RankerTrainQuality['methodologySpine']>['modelChoice'] => {
  const fallback = {
    deterministicBaseline: {
      candidate: DETERMINISTIC_BASELINE_VERSION,
    },
    activeModel: {
      candidate: RANKER_MODEL_VERSION,
    },
    regularizedLogisticRegression: {
      candidate: REGULARIZED_LOGISTIC_REGRESSION_VERSION,
    },
    graduation: {
      status: 'unavailable' as const,
      minValidationDelta: 0.005,
      reason: 'validation-metric-unavailable' as const,
    },
  };
  if (!isRecord(value)) return fallback;
  const baselineRaw = value['deterministicBaseline'];
  const activeRaw = value['activeModel'];
  const logisticRaw = value['regularizedLogisticRegression'];
  const graduationRaw = value['graduation'];
  if (
    !isRecord(baselineRaw) ||
    baselineRaw['candidate'] !== DETERMINISTIC_BASELINE_VERSION ||
    !isRecord(activeRaw) ||
    activeRaw['candidate'] !== RANKER_MODEL_VERSION ||
    !isRecord(logisticRaw) ||
    logisticRaw['candidate'] !== REGULARIZED_LOGISTIC_REGRESSION_VERSION ||
    !isRecord(graduationRaw) ||
    !isFiniteNumber(graduationRaw['minValidationDelta'])
  ) {
    return fallback;
  }
  const graduationReason = graduationRaw['reason'];
  const graduationStatus = graduationRaw['status'];
  if (
    (graduationStatus !== 'earned' &&
      graduationStatus !== 'not-earned' &&
      graduationStatus !== 'unavailable') ||
    (graduationReason !== 'active-model-beats-comparison-baseline' &&
      graduationReason !== 'active-model-does-not-beat-comparison-baseline' &&
      graduationReason !== 'validation-metric-unavailable')
  ) {
    return fallback;
  }
  const baselineValidationMetric = normalizeSimpleMetric(baselineRaw['validationMetric']);
  const baselineReservedTestMetric = normalizeSimpleMetric(baselineRaw['reservedTestMetric']);
  const activeValidationMetric = normalizeSimpleMetric(activeRaw['validationMetric']);
  const activeReservedTestMetric = normalizeSimpleMetric(activeRaw['reservedTestMetric']);
  const logisticValidationMetric = normalizeSimpleMetric(logisticRaw['validationMetric']);
  const logisticReservedTestMetric = normalizeSimpleMetric(logisticRaw['reservedTestMetric']);
  const validationDelta = isFiniteNumber(graduationRaw['validationDelta'])
    ? graduationRaw['validationDelta']
    : undefined;
  const comparisonCandidate =
    graduationRaw['comparisonCandidate'] === DETERMINISTIC_BASELINE_VERSION ||
    graduationRaw['comparisonCandidate'] === REGULARIZED_LOGISTIC_REGRESSION_VERSION
      ? graduationRaw['comparisonCandidate']
      : undefined;
  return {
    deterministicBaseline: {
      candidate: DETERMINISTIC_BASELINE_VERSION,
      ...(baselineValidationMetric === undefined
        ? {}
        : { validationMetric: baselineValidationMetric }),
      ...(baselineReservedTestMetric === undefined
        ? {}
        : { reservedTestMetric: baselineReservedTestMetric }),
    },
    activeModel: {
      candidate: RANKER_MODEL_VERSION,
      ...(activeValidationMetric === undefined ? {} : { validationMetric: activeValidationMetric }),
      ...(activeReservedTestMetric === undefined
        ? {}
        : { reservedTestMetric: activeReservedTestMetric }),
    },
    regularizedLogisticRegression: {
      candidate: REGULARIZED_LOGISTIC_REGRESSION_VERSION,
      ...(logisticValidationMetric === undefined
        ? {}
        : { validationMetric: logisticValidationMetric }),
      ...(logisticReservedTestMetric === undefined
        ? {}
        : { reservedTestMetric: logisticReservedTestMetric }),
    },
    graduation: {
      status: graduationStatus,
      minValidationDelta: graduationRaw['minValidationDelta'],
      ...(validationDelta === undefined ? {} : { validationDelta }),
      ...(comparisonCandidate === undefined ? {} : { comparisonCandidate }),
      reason: graduationReason,
    },
  };
};

const normalizeShipGate = (
  value: unknown,
): NonNullable<RankerTrainQuality['methodologySpine']>['shipGate'] => {
  const fallback = {
    status: 'unavailable' as const,
    candidate: RANKER_MODEL_VERSION,
    minValidationDeltaVsBaseline: 0.005,
    minReservedTestNdcg: 0.5,
    reservedTestUsedExactlyOnce: true as const,
    reason: 'validation-or-test-metric-unavailable' as const,
  };
  if (!isRecord(value)) return fallback;
  const status = value['status'];
  const reason = value['reason'];
  if (
    (status !== 'pass' && status !== 'fail' && status !== 'unavailable') ||
    value['candidate'] !== RANKER_MODEL_VERSION ||
    !isFiniteNumber(value['minValidationDeltaVsBaseline']) ||
    !isFiniteNumber(value['minReservedTestNdcg']) ||
    value['reservedTestUsedExactlyOnce'] !== true ||
    (reason !== 'active-model-cleared-validation-and-reserved-test' &&
      reason !== 'active-model-does-not-beat-comparison-baseline' &&
      reason !== 'reserved-test-below-floor' &&
      reason !== 'novel-pair-supervision-unavailable' &&
      reason !== 'validation-or-test-metric-unavailable')
  ) {
    return fallback;
  }
  return {
    status,
    candidate: RANKER_MODEL_VERSION,
    minValidationDeltaVsBaseline: value['minValidationDeltaVsBaseline'],
    minReservedTestNdcg: value['minReservedTestNdcg'],
    reservedTestUsedExactlyOnce: true,
    reason,
  };
};

const normalizeMethodologySpine = (
  value: unknown,
): RankerTrainQuality['methodologySpine'] | undefined => {
  if (!isRecord(value)) return undefined;
  const splitRaw = value['split'];
  if (!isRecord(splitRaw)) return undefined;
  const split =
    splitRaw['status'] === 'available' &&
    splitRaw['strategy'] === 'forward-chaining-time' &&
    splitRaw['timestampSource'] === 'supervision-event-or-visit-observed-at' &&
    isFiniteNumber(splitRaw['trainGroupCount']) &&
    isFiniteNumber(splitRaw['validationGroupCount']) &&
    isFiniteNumber(splitRaw['testGroupCount']) &&
    isFiniteNumber(splitRaw['validationCutoffGeneratedAt']) &&
    isFiniteNumber(splitRaw['testCutoffGeneratedAt'])
      ? {
          status: 'available' as const,
          strategy: 'forward-chaining-time' as const,
          timestampSource: 'supervision-event-or-visit-observed-at' as const,
          trainGroupCount: splitRaw['trainGroupCount'],
          validationGroupCount: splitRaw['validationGroupCount'],
          testGroupCount: splitRaw['testGroupCount'],
          validationCutoffGeneratedAt: splitRaw['validationCutoffGeneratedAt'],
          testCutoffGeneratedAt: splitRaw['testCutoffGeneratedAt'],
        }
      : splitRaw['status'] === 'unavailable' &&
          splitRaw['reason'] === 'insufficient-time-separated-groups'
        ? {
            status: 'unavailable' as const,
            reason: 'insufficient-time-separated-groups' as const,
          }
        : undefined;
  if (split === undefined) return undefined;

  const novelRaw = value['novelPairSlice'];
  const sourceKinds = isRecord(novelRaw)
    ? stringArrayOrUndefined(novelRaw['sourceKinds'])
    : undefined;
  if (
    !isRecord(novelRaw) ||
    !isFiniteNumber(novelRaw['rowCount']) ||
    !isFiniteNumber(novelRaw['groupCount']) ||
    !isFiniteNumber(novelRaw['positiveRows']) ||
    !isFiniteNumber(novelRaw['negativeRows']) ||
    sourceKinds === undefined
  ) {
    return undefined;
  }
  const novelMetric = normalizeSimpleMetric(novelRaw['metric']);

  const permutationRaw = value['labelPermutation'];
  if (
    !isRecord(permutationRaw) ||
    !isFiniteNumber(permutationRaw['seed']) ||
    !isFiniteNumber(permutationRaw['rowCount']) ||
    !isFiniteNumber(permutationRaw['groupCount'])
  ) {
    return undefined;
  }
  const permutationMetric = normalizeSimpleMetric(permutationRaw['metric']);

  const ablationRaw = value['workstreamFeatureAblation'];
  const droppedFeatures = isRecord(ablationRaw)
    ? stringArrayOrUndefined(ablationRaw['droppedFeatures'])
    : undefined;
  if (
    !isRecord(ablationRaw) ||
    droppedFeatures === undefined ||
    ablationRaw['status'] !== 'not-in-feature-vector'
  ) {
    return undefined;
  }

  const testRaw = value['reservedTestMetric'];
  const reservedTestMetric =
    isRecord(testRaw) &&
    typeof testRaw['kind'] === 'string' &&
    isFiniteNumber(testRaw['value']) &&
    isFiniteNumber(testRaw['rowCount']) &&
    isFiniteNumber(testRaw['groupCount'])
      ? {
          kind: testRaw['kind'],
          value: testRaw['value'],
          rowCount: testRaw['rowCount'],
          groupCount: testRaw['groupCount'],
        }
      : undefined;

  return {
    split,
    novelPairSlice: {
      rowCount: novelRaw['rowCount'],
      groupCount: novelRaw['groupCount'],
      positiveRows: novelRaw['positiveRows'],
      negativeRows: novelRaw['negativeRows'],
      sourceKinds,
      ...(novelMetric === undefined ? {} : { metric: novelMetric }),
    },
    labelPermutation: {
      seed: permutationRaw['seed'],
      rowCount: permutationRaw['rowCount'],
      groupCount: permutationRaw['groupCount'],
      ...(permutationMetric === undefined ? {} : { metric: permutationMetric }),
    },
    workstreamFeatureAblation: {
      droppedFeatures,
      status: 'not-in-feature-vector',
    },
    ...(reservedTestMetric === undefined ? {} : { reservedTestMetric }),
    tuning: normalizeTuning(value['tuning']),
    modelChoice: normalizeModelChoice(value['modelChoice']),
    shipGate: normalizeShipGate(value['shipGate']),
  };
};

// Lenient: a malformed `trainQuality` is pure observability, so it is
// dropped rather than failing the whole manifest. A manifest without
// `trainQuality` (older writers) is also valid — returns undefined.
const normalizeTrainQuality = (value: unknown): RankerTrainQuality | undefined => {
  if (!isRecord(value)) return undefined;
  if (!isGradeHistogram(value['gradeHistogram'])) return undefined;
  const candidateLabeling = normalizeCandidateLabeling(value['candidateLabeling']);
  if (candidateLabeling === undefined) return undefined;
  const spreadRaw = value['scoreSpread'];
  const spread =
    isRecord(spreadRaw) &&
    isFiniteNumber(spreadRaw['p05']) &&
    isFiniteNumber(spreadRaw['p50']) &&
    isFiniteNumber(spreadRaw['p95']) &&
    isFiniteNumber(spreadRaw['stdDev']) &&
    isFiniteNumber(spreadRaw['distinctRatio'])
      ? {
          p05: spreadRaw['p05'],
          p50: spreadRaw['p50'],
          p95: spreadRaw['p95'],
          stdDev: spreadRaw['stdDev'],
          distinctRatio: spreadRaw['distinctRatio'],
        }
      : undefined;
  const metricRaw = value['inSampleMetric'];
  const metric =
    isRecord(metricRaw) &&
    typeof metricRaw['kind'] === 'string' &&
    isFiniteNumber(metricRaw['value'])
      ? { kind: metricRaw['kind'], value: metricRaw['value'] }
      : undefined;
  const heldOutRaw = value['heldOutMetric'];
  const heldOut =
    isRecord(heldOutRaw) &&
    typeof heldOutRaw['kind'] === 'string' &&
    isFiniteNumber(heldOutRaw['value']) &&
    isFiniteNumber(heldOutRaw['trainGroupCount']) &&
    isFiniteNumber(heldOutRaw['heldOutGroupCount']) &&
    isFiniteNumber(heldOutRaw['cutoffGeneratedAt'])
      ? {
          kind: heldOutRaw['kind'],
          value: heldOutRaw['value'],
          trainGroupCount: heldOutRaw['trainGroupCount'],
          heldOutGroupCount: heldOutRaw['heldOutGroupCount'],
          cutoffGeneratedAt: heldOutRaw['cutoffGeneratedAt'],
        }
      : undefined;
  const methodologySpine = normalizeMethodologySpine(value['methodologySpine']);
  return {
    gradeHistogram: value['gradeHistogram'],
    candidateLabeling,
    ...(spread === undefined ? {} : { scoreSpread: spread }),
    ...(metric === undefined ? {} : { inSampleMetric: metric }),
    ...(heldOut === undefined ? {} : { heldOutMetric: heldOut }),
    ...(methodologySpine === undefined ? {} : { methodologySpine }),
  };
};

// Pinned to the *current* ranker constants (not inline literals): a
// manifest persisted under an older model version or feature-schema
// version fails validation, so `readClosestVisitRankerRevision`
// returns null and the caller treats it as "no usable model" and
// retrains. This is the back-compat gate — it prevents handing a
// stale-feature-count booster a wider feature row (which LightGBM
// would silently mis-score or the contribution decoder would throw
// on).
const isManifest = (value: unknown): value is ClosestVisitRankerRevisionManifest => {
  if (!isRecord(value)) return false;
  return (
    typeof value['revisionId'] === 'string' &&
    value['revisionId'].length > 0 &&
    value['modelVersion'] === RANKER_MODEL_VERSION &&
    value['featureSchemaVersion'] === FEATURE_SCHEMA_VERSION &&
    typeof value['trainingDatasetHash'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(value['trainingDatasetHash']) &&
    typeof value['trainedAt'] === 'number' &&
    Number.isFinite(value['trainedAt']) &&
    typeof value['modelByteLength'] === 'number' &&
    Number.isInteger(value['modelByteLength']) &&
    value['modelByteLength'] >= 0 &&
    typeof value['modelSha256'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(value['modelSha256'])
  );
};

const ARTIFACT_KINDS: readonly RankerArtifactKind[] = [
  'graph_baseline',
  'logistic_batch',
  'logistic_online',
  'lightgbm_lambdamart',
  'lightgbm_plus_online_lr',
];
const isArtifactKind = (value: unknown): value is RankerArtifactKind =>
  typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value);

const SHIP_GATE_STATUSES: readonly RankerArtifactShipGate['status'][] = [
  'pass',
  'fail',
  'unavailable',
];
const isShipGateStatus = (value: unknown): value is RankerArtifactShipGate['status'] =>
  typeof value === 'string' && (SHIP_GATE_STATUSES as readonly string[]).includes(value);

const normalizeMetric = (value: unknown): { kind: string; value: number } | undefined =>
  isRecord(value) && typeof value['kind'] === 'string' && isFiniteNumber(value['value'])
    ? { kind: value['kind'], value: value['value'] }
    : undefined;

// Lenient per-entry parser. A malformed entry is dropped; the rest of
// the array stays. An entirely malformed/absent `artifactQuality`
// returns undefined so older manifests stay valid.
const normalizeArtifactQuality = (
  value: unknown,
): readonly RankerArtifactQuality[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: RankerArtifactQuality[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (!isArtifactKind(entry['kind'])) continue;
    if (typeof entry['candidate'] !== 'string') continue;
    const gate = entry['shipGate'];
    if (!isRecord(gate)) continue;
    if (!isShipGateStatus(gate['status'])) continue;
    if (typeof gate['reason'] !== 'string') continue;
    const validationMetric = normalizeMetric(entry['validationMetric']);
    const reservedTestMetric = normalizeMetric(entry['reservedTestMetric']);
    out.push({
      kind: entry['kind'],
      candidate: entry['candidate'],
      shipGate: { status: gate['status'], reason: gate['reason'] },
      ...(validationMetric === undefined ? {} : { validationMetric }),
      ...(reservedTestMetric === undefined ? {} : { reservedTestMetric }),
    });
  }
  return out.length === 0 ? undefined : out;
};

// Lenient parser for the LR weights. The expected length is
// `RANKER_FEATURE_KEYS.length + 1` (bias + per-feature). A length
// mismatch or any non-finite entry drops the whole vector so the
// selector falls back to LightGBM or the baseline rather than
// scoring with a stale-schema weight vector.
const LOGISTIC_BATCH_WEIGHTS_LENGTH = RANKER_FEATURE_KEYS.length + 1;
const normalizeLogisticBatchWeights = (value: unknown): readonly number[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (value.length !== LOGISTIC_BATCH_WEIGHTS_LENGTH) return undefined;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return undefined;
    out.push(entry);
  }
  return out;
};

const normalizeLogisticBatchFeatureStatsVersion = (
  value: unknown,
): typeof LOGISTIC_BATCH_FEATURE_STATS_VERSION | undefined =>
  value === LOGISTIC_BATCH_FEATURE_STATS_VERSION ? value : undefined;

// Combiner weights (Step 8) = bias + per-COMBINER_FEATURE_KIND
// (4 floats total). Length mismatch or any non-finite entry drops
// the whole vector so the selector falls back to a singleton
// artifact rather than scoring against a stale-shape combiner.
const COMBINER_WEIGHTS_LENGTH = COMBINER_FEATURE_COUNT + 1;
const normalizeCombinerWeights = (value: unknown): readonly number[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  if (value.length !== COMBINER_WEIGHTS_LENGTH) return undefined;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return undefined;
    out.push(entry);
  }
  return out;
};

// Per-container biases (Step 9) — Record<containerId, finite number>.
// Lenient: a non-record value or a record with any non-finite entry
// drops the whole map for that container kind so a stale-shape
// persisted state can't pollute serving.
const normalizeBiasRecord = (value: unknown): Readonly<Record<string, number>> | undefined => {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return undefined;
    out[key] = entry;
  }
  return out;
};

const normalizePerContainerBiases = (
  value: unknown,
):
  | {
      readonly perWorkstream: Readonly<Record<string, number>>;
      readonly perTopic: Readonly<Record<string, number>>;
    }
  | undefined => {
  if (!isRecord(value)) return undefined;
  const perWorkstream = normalizeBiasRecord(value['perWorkstream']) ?? {};
  const perTopic = normalizeBiasRecord(value['perTopic']) ?? {};
  return { perWorkstream, perTopic };
};

// Coerce a validated manifest record into the typed shape, normalizing
// the optional `trainQuality` + `artifactQuality` + LR weights (drop
// if malformed/absent — none of these gate scoring on their own).
const finalizeManifest = (
  value: ClosestVisitRankerRevisionManifest,
): ClosestVisitRankerRevisionManifest => {
  const trainQuality = normalizeTrainQuality(
    (value as { readonly trainQuality?: unknown }).trainQuality,
  );
  const artifactQuality = normalizeArtifactQuality(
    (value as { readonly artifactQuality?: unknown }).artifactQuality,
  );
  const logisticBatchWeights = normalizeLogisticBatchWeights(
    (value as { readonly logisticBatchWeights?: unknown }).logisticBatchWeights,
  );
  const logisticBatchFeatureStatsVersion = normalizeLogisticBatchFeatureStatsVersion(
    (value as { readonly logisticBatchFeatureStatsVersion?: unknown })
      .logisticBatchFeatureStatsVersion,
  );
  // Weights without a recognized stats version are unusable — drop both
  // so the selector treats LR as absent rather than mis-scoring.
  const lrUsable =
    logisticBatchWeights !== undefined && logisticBatchFeatureStatsVersion !== undefined;
  const combinerWeights = normalizeCombinerWeights(
    (value as { readonly combinerWeights?: unknown }).combinerWeights,
  );
  const perContainerBiases = normalizePerContainerBiases(
    (value as { readonly perContainerBiases?: unknown }).perContainerBiases,
  );
  return {
    revisionId: value.revisionId,
    modelVersion: value.modelVersion,
    featureSchemaVersion: value.featureSchemaVersion,
    trainingDatasetHash: value.trainingDatasetHash,
    trainedAt: value.trainedAt,
    trainedFromImpressions:
      (value as { readonly trainedFromImpressions?: unknown }).trainedFromImpressions === true,
    modelByteLength: value.modelByteLength,
    modelSha256: value.modelSha256,
    ...(trainQuality === undefined ? {} : { trainQuality }),
    ...(artifactQuality === undefined ? {} : { artifactQuality }),
    ...(lrUsable
      ? {
          logisticBatchWeights,
          logisticBatchFeatureStatsVersion,
        }
      : {}),
    ...(combinerWeights === undefined ? {} : { combinerWeights }),
    ...(perContainerBiases === undefined ? {} : { perContainerBiases }),
  };
};

export const readClosestVisitRankerRevisionManifest = async (
  vaultRoot: string,
  revisionId: string,
): Promise<ClosestVisitRankerRevisionManifest | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(closestVisitRevisionManifestPath(vaultRoot, revisionId), 'utf8'),
    ) as unknown;
    return isManifest(parsed) ? finalizeManifest(parsed) : null;
  } catch {
    return null;
  }
};

export const readActiveClosestVisitRankerRevisionManifest = async (
  vaultRoot: string,
): Promise<ClosestVisitRankerRevisionManifest | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(activeClosestVisitRevisionManifestPath(vaultRoot), 'utf8'),
    ) as unknown;
    return isManifest(parsed) ? finalizeManifest(parsed) : null;
  } catch {
    return null;
  }
};

export const readActiveClosestVisitRankerRevisionManifestProbe = async (
  vaultRoot: string,
): Promise<ClosestVisitRankerRevisionManifestProbe | null> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(activeClosestVisitRevisionManifestPath(vaultRoot), 'utf8'),
    );
    if (!isRecord(parsed)) {
      return {
        revisionId: null,
        activeModelVersion: null,
        expectedModelVersion: RANKER_MODEL_VERSION,
        activeFeatureSchemaVersion: null,
        expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
        staleModelSchema: false,
      };
    }
    const activeModelVersion = stringOrNull(parsed['modelVersion']);
    const activeFeatureSchemaVersion = numberOrNull(parsed['featureSchemaVersion']);
    return {
      revisionId: stringOrNull(parsed['revisionId']),
      activeModelVersion,
      expectedModelVersion: RANKER_MODEL_VERSION,
      activeFeatureSchemaVersion,
      expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      staleModelSchema:
        (activeModelVersion !== null && activeModelVersion !== RANKER_MODEL_VERSION) ||
        (activeFeatureSchemaVersion !== null &&
          activeFeatureSchemaVersion !== FEATURE_SCHEMA_VERSION),
    };
  } catch {
    return null;
  }
};

export const writeClosestVisitRankerRevision = async (
  vaultRoot: string,
  revision: RankerRevision,
): Promise<void> => {
  const dir = closestVisitRevisionDir(vaultRoot);
  await mkdir(dir, { recursive: true });
  const manifest = manifestForRevision(revision);
  await writeAtomic(
    closestVisitRevisionManifestPath(vaultRoot, revision.revisionId),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeAtomic(
    closestVisitRevisionModelPath(vaultRoot, revision.revisionId),
    `${Buffer.from(modelBytesFor(revision)).toString('base64')}\n`,
  );
};

export const writeActiveClosestVisitRankerRevision = async (
  vaultRoot: string,
  revision: RankerRevision,
): Promise<void> => {
  await writeClosestVisitRankerRevision(vaultRoot, revision);
  await writeAtomic(
    activeClosestVisitRevisionManifestPath(vaultRoot),
    `${JSON.stringify(manifestForRevision(revision), null, 2)}\n`,
  );
};

export const readClosestVisitRankerRevision = async (
  vaultRoot: string,
  revisionId: string,
): Promise<RankerRevision | null> => {
  const manifest = await readClosestVisitRankerRevisionManifest(vaultRoot, revisionId);
  if (manifest === null) return null;
  try {
    const bytes = Buffer.from(
      (await readFile(closestVisitRevisionModelPath(vaultRoot, revisionId), 'utf8')).trim(),
      'base64',
    );
    if (
      bytes.byteLength !== manifest.modelByteLength ||
      sha256Hex(bytes) !== manifest.modelSha256
    ) {
      return null;
    }
    return {
      revisionId: manifest.revisionId,
      modelVersion: manifest.modelVersion,
      featureSchemaVersion: manifest.featureSchemaVersion,
      trainingDatasetHash: manifest.trainingDatasetHash,
      trainedAt: manifest.trainedAt,
      trainedFromImpressions: manifest.trainedFromImpressions,
      modelBytes: toOwnedArrayBuffer(bytes),
      ...(manifest.trainQuality === undefined ? {} : { trainQuality: manifest.trainQuality }),
      // Codex review of PR #229: the persisted manifest carries
      // artifactQuality + LR weights through `finalizeManifest`, but
      // this loader was dropping them on the way out, so the selector
      // saw `artifactQuality === undefined` after restart and fell
      // back to the baseline. Propagate every new manifest field so
      // the persisted-reload path matches the in-memory write path.
      ...(manifest.artifactQuality === undefined
        ? {}
        : { artifactQuality: manifest.artifactQuality }),
      ...(manifest.logisticBatchWeights === undefined
        ? {}
        : { logisticBatchWeights: manifest.logisticBatchWeights }),
      ...(manifest.logisticBatchFeatureStatsVersion === undefined
        ? {}
        : {
            logisticBatchFeatureStatsVersion: manifest.logisticBatchFeatureStatsVersion,
          }),
      // Step 8 — propagate the combiner weights through the
      // full-revision loader for the same reason the prior fields
      // do (Codex review of #229). Without this the selector sees
      // `combinerWeights === undefined` on reload and can't pick
      // `lightgbm_plus_online_lr`.
      ...(manifest.combinerWeights === undefined
        ? {}
        : { combinerWeights: manifest.combinerWeights }),
      // Step 9 — same lesson applied prospectively. The hierarchical
      // bias-computation algorithm is plan-deferred, but the manifest
      // schema + loader still propagate the field so the future
      // training pass can populate it without another loader fix.
      ...(manifest.perContainerBiases === undefined
        ? {}
        : { perContainerBiases: manifest.perContainerBiases }),
    };
  } catch {
    return null;
  }
};

export const listClosestVisitRankerRevisionIds = async (
  vaultRoot: string,
): Promise<readonly string[]> => {
  const entries = await readdir(closestVisitRevisionDir(vaultRoot)).catch(
    () => [] as readonly string[],
  );
  return entries
    .filter((name) => name.endsWith('.json') && name !== 'current.json')
    .map((name) => name.replace(/\.json$/u, ''))
    .sort();
};
