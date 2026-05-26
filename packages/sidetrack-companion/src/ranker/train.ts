import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Booster, Dataset, loadLGB } from '@wlearn/lightgbm';

import type { FeedbackProjection, FeedbackTrainingLabel } from '../feedback/projection.js';
import {
  CANDIDATE_PAIR_FEATURE_KEYS,
  FEATURE_SCHEMA_VERSION,
  type CandidatePairFeatures,
} from './feature-schema.js';
import type { Candidate } from './types.js';

// Bumped v4 → v5 alongside FEATURE_SCHEMA_VERSION 4 → 5: the
// `container_negative_match` feature joined the input vector (Step 7
// of the incremental-ranker plan). A v4 model trained without that
// column would silently mis-score pairs that should now read the
// new feature, so the manifest validator pins this exact string and
// the retrain loop produces a fresh v5 model.
//
// Bumped v2 → v3 alongside FEATURE_SCHEMA_VERSION 2 → 3: the
// closest_visit scorer no longer consumes workstream-identity leakage
// features. The manifest validator pins this exact string, so a model
// persisted under v2 fails to load and the retrain loop produces a
// fresh non-leaky model instead of reusing leaked weights.
export const RANKER_MODEL_VERSION = 'lightgbm-lambdamart-v5' as const;

// Step 2 of the incremental-ranker plan — every artifact the training
// pipeline produces gets its own ship-gate, surfaced as one entry in
// `RankerRevision.artifactQuality`. The selector (Step 4) reads this
// list to pick the served artifact instead of hard-coding LightGBM.
//
// `logistic_online` + `lightgbm_plus_online_lr` are placeholders for
// Steps 6+8 of the plan and won't appear in revisions until those
// artifacts exist. The active-revision view stays correct when older
// manifests omit the field entirely.
export type RankerArtifactKind =
  | 'graph_baseline'
  | 'logistic_batch'
  | 'logistic_online'
  | 'lightgbm_lambdamart'
  | 'lightgbm_plus_online_lr';

export interface RankerArtifactShipGate {
  readonly status: 'pass' | 'fail' | 'unavailable';
  readonly reason: string;
}

export interface RankerArtifactQuality {
  readonly kind: RankerArtifactKind;
  // Echoes the canonical version string (e.g. `lightgbm-lambdamart-v4`)
  // so the selector can cross-check against the manifest's modelVersion.
  readonly candidate: string;
  readonly validationMetric?: RankerMetric;
  readonly reservedTestMetric?: RankerMetric;
  readonly shipGate: RankerArtifactShipGate;
}

export const DEFAULT_RANKER_NUM_ROUND = 40;
export const DEFAULT_RANKER_SEED = 20260508;
// k for the in-sample NDCG@k offline metric captured at train time.
export const RANKER_IN_SAMPLE_NDCG_K = 5;
export const RANKER_HELD_OUT_NDCG_K = 5;
export const DETERMINISTIC_BASELINE_VERSION =
  'deterministic-feature-baseline-v2-no-content-priors' as const;
export const REGULARIZED_LOGISTIC_REGRESSION_VERSION =
  'regularized-logistic-regression-v1' as const;
const RANKER_MODEL_CHOICE_MIN_VALIDATION_DELTA = 0.005;
const RANKER_SHIP_GATE_MIN_RESERVED_TEST_NDCG = 0.5;

export type RankerGrade = '0' | '1' | '2' | '3' | '4';

export interface RankerMetric {
  readonly kind: string;
  readonly value: number;
}

/**
 * Additive, optional train-time observability captured straight after
 * the booster finishes. NONE of these fields feed back into ranking —
 * they exist purely so a health board can spot a degenerate model
 * (e.g. every score identical) without re-loading the model. All
 * sub-objects are optional so older manifests/readers stay valid; the
 * presence of `trainQuality` itself never affects the refuse-to-score
 * schema invariant (featureSchemaVersion is unchanged).
 */
export interface RankerTrainQuality {
  /** Count of training rows per relevance grade 0..4. Always present. */
  readonly gradeHistogram: Record<RankerGrade, number>;
  /**
   * Labeling accountability for the candidate pool passed to training.
   * Unlabeled candidates are still excluded because there is no
   * supervision for them, but the exclusion is now explicit and visible
   * instead of being a silent `null` drop.
   */
  readonly candidateLabeling: {
    readonly totalCandidates: number;
    readonly labeledRows: number;
    readonly positiveRows: number;
    readonly negativeRows: number;
    readonly implicitNegativeRows: number;
    readonly unlabeledCandidateCount: number;
  };
  /**
   * Spread of the freshly trained model's scores over the SAME training
   * rows. Computed by reusing the in-process booster (a single extra
   * `predict` over the already-encoded feature matrix — no second model
   * load). A near-zero `stdDev` / tiny `distinctRatio` means the model
   * collapsed to a constant.
   */
  readonly scoreSpread?: {
    readonly p05: number;
    readonly p50: number;
    readonly p95: number;
    readonly stdDev: number;
    readonly distinctRatio: number;
  };
  /**
   * In-sample (NOT held-out) ranking quality of the trained model's
   * ordering vs. the graded labels, averaged over query groups.
   * In-sample is acceptable here and explicitly labeled as such.
   */
  readonly inSampleMetric?: {
    readonly kind: string;
    readonly value: number;
  };
  /**
   * Time-split held-out metric when the training rows contain enough
   * query groups across at least two candidate timestamps. Unlike the
   * in-sample metric, these rows are not included in the trained model.
   */
  readonly heldOutMetric?: {
    readonly kind: string;
    readonly value: number;
    readonly trainGroupCount: number;
    readonly heldOutGroupCount: number;
    readonly cutoffGeneratedAt: number;
  };
  /**
   * Phase-0 methodology-spine diagnostics. These are evaluator outputs,
   * not scorer inputs: they help distinguish "correctly silent because
   * there is no genuine supervision" from "silently broken".
   */
  readonly methodologySpine?: {
    readonly split:
      | {
          readonly status: 'available';
          readonly strategy: 'forward-chaining-time';
          readonly timestampSource: 'supervision-event-or-visit-observed-at';
          readonly trainGroupCount: number;
          readonly validationGroupCount: number;
          readonly testGroupCount: number;
          readonly validationCutoffGeneratedAt: number;
          readonly testCutoffGeneratedAt: number;
        }
      | {
          readonly status: 'unavailable';
          readonly reason: 'insufficient-time-separated-groups';
        };
    readonly novelPairSlice: {
      readonly rowCount: number;
      readonly groupCount: number;
      readonly positiveRows: number;
      readonly negativeRows: number;
      readonly sourceKinds: readonly string[];
      readonly metric?: RankerMetric;
    };
    readonly labelPermutation: {
      readonly seed: number;
      readonly rowCount: number;
      readonly groupCount: number;
      readonly metric?: RankerMetric;
    };
    readonly workstreamFeatureAblation: {
      readonly droppedFeatures: readonly string[];
      readonly status: 'not-in-feature-vector';
    };
    readonly reservedTestMetric?: {
      readonly kind: string;
      readonly value: number;
      readonly rowCount: number;
      readonly groupCount: number;
    };
    readonly tuning: {
      readonly status: 'available' | 'unavailable';
      readonly strategy: 'validation-num-round-grid';
      readonly requestedNumRound: number;
      readonly selectedNumRound: number;
      readonly validationCandidateCount: number;
      readonly candidates: readonly {
        readonly numRound: number;
        readonly metric?: RankerMetric;
      }[];
      readonly reason?: 'split-unavailable' | 'validation-metric-unavailable';
    };
    readonly modelChoice: {
      readonly deterministicBaseline: {
        readonly candidate: typeof DETERMINISTIC_BASELINE_VERSION;
        readonly validationMetric?: RankerMetric;
        readonly reservedTestMetric?: RankerMetric;
      };
      readonly activeModel: {
        readonly candidate: typeof RANKER_MODEL_VERSION;
        readonly validationMetric?: RankerMetric;
        readonly reservedTestMetric?: RankerMetric;
      };
      readonly regularizedLogisticRegression: {
        readonly candidate: typeof REGULARIZED_LOGISTIC_REGRESSION_VERSION;
        readonly validationMetric?: RankerMetric;
        readonly reservedTestMetric?: RankerMetric;
      };
      readonly graduation: {
        readonly status: 'earned' | 'not-earned' | 'unavailable';
        readonly minValidationDelta: number;
        readonly validationDelta?: number;
        readonly comparisonCandidate?:
          | typeof DETERMINISTIC_BASELINE_VERSION
          | typeof REGULARIZED_LOGISTIC_REGRESSION_VERSION;
        readonly reason:
          | 'active-model-beats-comparison-baseline'
          | 'active-model-does-not-beat-comparison-baseline'
          | 'validation-metric-unavailable';
      };
    };
    readonly shipGate: {
      readonly status: 'pass' | 'fail' | 'unavailable';
      readonly candidate: typeof RANKER_MODEL_VERSION;
      readonly minValidationDeltaVsBaseline: number;
      readonly minReservedTestNdcg: number;
      readonly reservedTestUsedExactlyOnce: true;
      readonly reason:
        | 'active-model-cleared-validation-and-reserved-test'
        | 'active-model-does-not-beat-comparison-baseline'
        | 'reserved-test-below-floor'
        | 'novel-pair-supervision-unavailable'
        | 'validation-or-test-metric-unavailable';
    };
  };
}

// Step 3 — feature-stats version marker for the persisted LR weights.
// The current LR trains on raw features (no per-feature normalization),
// so this is `'no-normalization-v1'`. When real normalization stats
// (mean/std) land alongside the weights, bump this string and the
// loader refuses to score with mismatched normalization.
export const LOGISTIC_BATCH_FEATURE_STATS_VERSION = 'no-normalization-v1' as const;

export interface RankerRevision {
  readonly revisionId: string;
  readonly modelVersion: typeof RANKER_MODEL_VERSION;
  readonly featureSchemaVersion: typeof FEATURE_SCHEMA_VERSION;
  readonly trainingDatasetHash: string;
  readonly trainedAt: number;
  readonly modelBytes: ArrayBuffer;
  readonly trainQuality?: RankerTrainQuality;
  // Per-artifact quality + ship-gate records. One entry per artifact the
  // training pipeline produced this revision (graph_baseline,
  // logistic_batch, lightgbm_lambdamart today; logistic_online and
  // lightgbm_plus_online_lr land with later plan steps). Optional so
  // older manifests stay readable.
  readonly artifactQuality?: readonly RankerArtifactQuality[];
  // Step 3 — the regularized LR's trained weights, persisted as a
  // first-class peer artifact alongside the LightGBM model bytes.
  // Length = RANKER_FEATURE_KEYS.length + 1 (bias + per-feature weight).
  // Today `predict.ts` only consumes the LightGBM path; Step 4 wires
  // the LR dispatch so the selector can route to whichever artifact
  // passes its ship-gate. Optional so older manifests stay readable.
  readonly logisticBatchWeights?: readonly number[];
  readonly logisticBatchFeatureStatsVersion?: typeof LOGISTIC_BATCH_FEATURE_STATS_VERSION;
}

export interface RankerTrainingCandidate {
  readonly candidate: Candidate;
  readonly features: CandidatePairFeatures;
}

export interface RankerTrainingRow extends RankerTrainingCandidate {
  readonly label: number;
}

export interface RankerTrainingLabelingSummary {
  readonly totalCandidates: number;
  readonly labeledRows: number;
  readonly positiveRows: number;
  readonly negativeRows: number;
  readonly implicitNegativeRows: number;
  readonly unlabeledCandidateCount: number;
}

export interface RankerTrainingRowsResult {
  readonly rows: readonly RankerTrainingRow[];
  readonly labelingSummary: RankerTrainingLabelingSummary;
}

export interface TrainRankerOptions {
  readonly seed?: number;
  readonly numRound?: number;
  readonly trainedAt?: number;
}

export interface TrainRankerInput {
  readonly feedback: FeedbackProjection;
  readonly candidates: readonly RankerTrainingCandidate[];
  readonly options?: TrainRankerOptions;
}

type RankerFeatureKey = Exclude<keyof CandidatePairFeatures, 'schemaVersion'>;

export const RANKER_FEATURE_KEYS = [
  'opener_chain_depth',
  'in_navigation_chain',
  'same_canonical_url',
  'same_host',
  'same_repo',
  'same_search_query',
  'same_copied_snippet_count',
  'shared_title_tokens',
  'shared_path_tokens',
  'cosine_similarity',
  'recency_score_from',
  'recency_score_to',
  'engagement_class_match',
  'return_count_from',
  'return_count_to',
  'user_asserted_in_thread',
  // R5 lineage/page-quality features remain after the v3 de-leak. The
  // removed workstream-identity fields still exist on the debug feature
  // object for other consumers, but they are not model inputs.
  'same_active_topic',
  'topic_lineage_merge_split_related',
  'page_quality_tier_from',
  'page_quality_tier_to',
  'shared_content_terms',
  'shared_content_keyphrases',
  'content_weighted_jaccard',
  'content_vector_cosine',
  'content_entity_overlap',
  'content_evidence_tier_from',
  'content_evidence_tier_to',
  'content_both_available',
  'content_quality_pair_min',
  'chunk_support_count',
  'max_chunk_pair_score',
] as const satisfies readonly RankerFeatureKey[];

const PREDICT_CONTRIB_BIAS_SLOT_COUNT = 1;
export const RANKER_MODEL_FEATURE_COUNT =
  RANKER_FEATURE_KEYS.length + PREDICT_CONTRIB_BIAS_SLOT_COUNT;

interface LightGbmWasm {
  readonly HEAPU8: Uint8Array;
  readonly HEAP32: Int32Array;
  readonly _malloc: (size: number) => number;
  readonly _free: (ptr: number) => void;
  readonly _wl_lgb_dataset_set_field: (
    datasetHandle: number,
    fieldPtr: number,
    dataPtr: number,
    length: number,
    dataType: number,
  ) => number;
  readonly _wl_lgb_get_last_error: () => number;
  readonly UTF8ToString: (ptr: number) => string;
}

const LIGHTGBM_C_API_DTYPE_INT32 = 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLightGbmWasm = (value: unknown): value is LightGbmWasm =>
  isRecord(value) &&
  value['HEAPU8'] instanceof Uint8Array &&
  value['HEAP32'] instanceof Int32Array &&
  typeof value['_malloc'] === 'function' &&
  typeof value['_free'] === 'function' &&
  typeof value['_wl_lgb_dataset_set_field'] === 'function' &&
  typeof value['_wl_lgb_get_last_error'] === 'function' &&
  typeof value['UTF8ToString'] === 'function';

const hasGetWasm = (value: unknown): value is { readonly getWasm: () => unknown } =>
  isRecord(value) && typeof value['getWasm'] === 'function';

const sha256Hex = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const toOwnedArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const pairKey = (fromId: string, toId: string): string => `${fromId}\u0000${toId}`;

const labelWeights = (labels: readonly FeedbackTrainingLabel[]): ReadonlyMap<string, number> => {
  const weights = new Map<string, number>();
  for (const label of labels) {
    const key = pairKey(label.fromId, label.toId);
    weights.set(key, (weights.get(key) ?? 0) + label.weight);
  }
  return weights;
};

const candidateHasImplicitNegativeSource = (candidate: Candidate): boolean =>
  candidate.sources.some(
    (source) => source === 'random_unrelated' || source === 'recently_skipped',
  );

type CandidateTrainingLabel =
  | { readonly kind: 'positive'; readonly label: number }
  | { readonly kind: 'negative'; readonly label: 0; readonly implicit: false }
  | { readonly kind: 'negative'; readonly label: 0; readonly implicit: true }
  | { readonly kind: 'unlabeled' };

const trainingLabelForCandidate = (
  candidate: Candidate,
  positiveWeights: ReadonlyMap<string, number>,
  negativeWeights: ReadonlyMap<string, number>,
): CandidateTrainingLabel => {
  const key = pairKey(candidate.fromVisitId, candidate.toVisitId);
  const positive = positiveWeights.get(key) ?? 0;
  const negative = negativeWeights.get(key) ?? 0;
  if (positive > negative) {
    return { kind: 'positive', label: Math.min(4, Math.max(1, Math.round(positive))) };
  }
  if (negative > 0) return { kind: 'negative', label: 0, implicit: false };
  if (candidateHasImplicitNegativeSource(candidate)) {
    return { kind: 'negative', label: 0, implicit: true };
  }
  return { kind: 'unlabeled' };
};

export const buildRankerTrainingRowsWithSummary = (
  feedback: FeedbackProjection,
  candidates: readonly RankerTrainingCandidate[],
): RankerTrainingRowsResult => {
  const positiveWeights = labelWeights(feedback.positiveLabels);
  const negativeWeights = labelWeights(feedback.negativeLabels);
  const rows: RankerTrainingRow[] = [];
  let positiveRows = 0;
  let negativeRows = 0;
  let implicitNegativeRows = 0;
  let unlabeledCandidateCount = 0;

  for (const item of candidates) {
    const label = trainingLabelForCandidate(item.candidate, positiveWeights, negativeWeights);
    if (label.kind === 'unlabeled') {
      unlabeledCandidateCount += 1;
      continue;
    }
    if (label.kind === 'positive') positiveRows += 1;
    if (label.kind === 'negative') {
      negativeRows += 1;
      if (label.implicit) implicitNegativeRows += 1;
    }
    rows.push({ ...item, label: label.label });
  }

  const sortedRows = rows.sort(compareTrainingRow);
  return {
    rows: sortedRows,
    labelingSummary: {
      totalCandidates: candidates.length,
      labeledRows: sortedRows.length,
      positiveRows,
      negativeRows,
      implicitNegativeRows,
      unlabeledCandidateCount,
    },
  };
};

export const buildRankerTrainingRows = (
  feedback: FeedbackProjection,
  candidates: readonly RankerTrainingCandidate[],
): readonly RankerTrainingRow[] => buildRankerTrainingRowsWithSummary(feedback, candidates).rows;

const compareTrainingRow = (left: RankerTrainingRow, right: RankerTrainingRow): number =>
  compareText(left.candidate.fromVisitId, right.candidate.fromVisitId) ||
  compareText(left.candidate.toVisitId, right.candidate.toVisitId) ||
  right.label - left.label;

interface UsableRankerRowGroup {
  readonly fromId: string;
  readonly rows: readonly RankerTrainingRow[];
  readonly generatedAt: number;
}

const maxGeneratedAt = (rows: readonly RankerTrainingRow[]): number => {
  let generatedAt = 0;
  for (const row of rows) {
    if (Number.isFinite(row.candidate.generatedAt)) {
      generatedAt = Math.max(generatedAt, row.candidate.generatedAt);
    }
  }
  return generatedAt;
};

const usableRowGroups = (rows: readonly RankerTrainingRow[]): readonly UsableRankerRowGroup[] => {
  const byFrom = new Map<string, RankerTrainingRow[]>();
  for (const row of rows) {
    const group = byFrom.get(row.candidate.fromVisitId);
    if (group === undefined) {
      byFrom.set(row.candidate.fromVisitId, [row]);
    } else {
      group.push(row);
    }
  }

  const groups: UsableRankerRowGroup[] = [];
  for (const fromId of [...byFrom.keys()].sort(compareText)) {
    const group = [...(byFrom.get(fromId) ?? [])].sort(compareTrainingRow);
    const labels = new Set(group.map((row) => row.label));
    if (group.length < 2 || labels.size < 2) continue;
    groups.push({ fromId, rows: group, generatedAt: maxGeneratedAt(group) });
  }
  return groups;
};

const flattenRowGroups = (
  groups: readonly UsableRankerRowGroup[],
): { readonly rows: readonly RankerTrainingRow[]; readonly groupSizes: readonly number[] } => {
  const rows: RankerTrainingRow[] = [];
  const groupSizes: number[] = [];
  for (const group of groups) {
    rows.push(...group.rows);
    groupSizes.push(group.rows.length);
  }
  return { rows, groupSizes };
};

interface TimeSplitRankerRows {
  readonly trainGroups: readonly UsableRankerRowGroup[];
  readonly heldOutGroups: readonly UsableRankerRowGroup[];
  readonly testGroups: readonly UsableRankerRowGroup[];
  readonly cutoffGeneratedAt: number;
  readonly testCutoffGeneratedAt: number;
}

const timeSplitGroups = (groups: readonly UsableRankerRowGroup[]): TimeSplitRankerRows | null => {
  if (groups.length < 4) return null;
  const sorted = [...groups].sort(
    (left, right) => left.generatedAt - right.generatedAt || compareText(left.fromId, right.fromId),
  );
  if (new Set(sorted.map((group) => group.generatedAt)).size < 2) return null;
  const testCount = Math.max(1, Math.floor(sorted.length * 0.2));
  const validationPool = sorted.slice(0, sorted.length - testCount);
  const testGroups = sorted.slice(sorted.length - testCount);
  const heldOutCount = Math.max(1, Math.floor(validationPool.length * 0.2));
  const trainGroups = validationPool.slice(0, validationPool.length - heldOutCount);
  const heldOutGroups = validationPool.slice(validationPool.length - heldOutCount);
  if (trainGroups.length === 0 || heldOutGroups.length === 0 || testGroups.length === 0) {
    return null;
  }
  const cutoffGeneratedAt = Math.max(...trainGroups.map((group) => group.generatedAt));
  const earliestHeldOut = Math.min(...heldOutGroups.map((group) => group.generatedAt));
  if (earliestHeldOut <= cutoffGeneratedAt) return null;
  const testCutoffGeneratedAt = Math.max(...heldOutGroups.map((group) => group.generatedAt));
  const earliestTest = Math.min(...testGroups.map((group) => group.generatedAt));
  if (earliestTest <= testCutoffGeneratedAt) return null;
  return { trainGroups, heldOutGroups, testGroups, cutoffGeneratedAt, testCutoffGeneratedAt };
};

const defaultLabelingSummary = (
  rows: readonly RankerTrainingRow[],
): RankerTrainingLabelingSummary => {
  let positiveRows = 0;
  let negativeRows = 0;
  for (const row of rows) {
    if (row.label > 0) positiveRows += 1;
    else negativeRows += 1;
  }
  return {
    totalCandidates: rows.length,
    labeledRows: rows.length,
    positiveRows,
    negativeRows,
    implicitNegativeRows: 0,
    unlabeledCandidateCount: 0,
  };
};

const stableFeatureObject = (
  features: CandidatePairFeatures,
): Record<keyof CandidatePairFeatures, number> => {
  const out = {} as Record<keyof CandidatePairFeatures, number>;
  for (const key of CANDIDATE_PAIR_FEATURE_KEYS) {
    out[key] = features[key] ?? 0;
  }
  return out;
};

const stableDatasetBody = (
  rows: readonly RankerTrainingRow[],
  groupSizes: readonly number[],
  trainingConfig: Required<Pick<TrainRankerOptions, 'seed' | 'numRound'>>,
): string =>
  JSON.stringify({
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    groupSizes,
    trainingConfig,
    rows: rows.map((row) => ({
      fromVisitId: row.candidate.fromVisitId,
      toVisitId: row.candidate.toVisitId,
      sources: [...row.candidate.sources].sort(compareText),
      label: row.label,
      features: stableFeatureObject(row.features),
    })),
  });

export const createRankerRevisionId = (trainingDatasetHash: string): string =>
  sha256Hex(
    [RANKER_MODEL_VERSION, String(FEATURE_SCHEMA_VERSION), trainingDatasetHash].join('\n'),
  ).slice(0, 16);

const featureValue = (features: CandidatePairFeatures, key: RankerFeatureKey): number => {
  const value = features[key] ?? 0;
  return Number.isFinite(value) ? value : 0;
};

export const encodeRankerFeatureMatrix = (
  features: readonly CandidatePairFeatures[],
): Float32Array => {
  const matrix = new Float32Array(features.length * RANKER_FEATURE_KEYS.length);
  for (let rowIndex = 0; rowIndex < features.length; rowIndex += 1) {
    const row = features[rowIndex];
    if (row === undefined) throw new Error('ranker feature row is missing');
    for (let columnIndex = 0; columnIndex < RANKER_FEATURE_KEYS.length; columnIndex += 1) {
      const key = RANKER_FEATURE_KEYS[columnIndex];
      if (key === undefined) throw new Error('ranker feature key is missing');
      matrix[rowIndex * RANKER_FEATURE_KEYS.length + columnIndex] = featureValue(row, key);
    }
  }
  return matrix;
};

const labelsForRows = (rows: readonly RankerTrainingRow[]): Float32Array =>
  new Float32Array(rows.map((row) => row.label));

const lightGbmParamString = (
  options: Required<Pick<TrainRankerOptions, 'seed' | 'numRound'>>,
): string =>
  [
    'objective=lambdarank',
    'metric=ndcg',
    'verbosity=-1',
    `seed=${String(options.seed)}`,
    'deterministic=true',
    'num_threads=1',
    'force_row_wise=true',
    'min_data_in_leaf=1',
    'min_data_in_bin=1',
    'num_leaves=7',
    'learning_rate=0.12',
    'label_gain=0,1,3,7,15',
  ].join(' ');

const loadLightGbmWasmInternals = async (): Promise<LightGbmWasm> => {
  await loadLGB();
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve('@wlearn/lightgbm');
  const moduleUrl = pathToFileURL(join(dirname(indexPath), 'wasm.js')).href;
  const moduleValue = (await import(moduleUrl)) as unknown;
  if (!hasGetWasm(moduleValue)) {
    throw new Error('@wlearn/lightgbm internals did not expose getWasm');
  }
  const wasm = moduleValue.getWasm();
  if (!isLightGbmWasm(wasm)) {
    throw new Error('@wlearn/lightgbm internals do not match the expected WASM shape');
  }
  return wasm;
};

const withCString = <T>(wasm: LightGbmWasm, value: string, fn: (ptr: number) => T): T => {
  const bytes = new TextEncoder().encode(`${value}\0`);
  const ptr = wasm._malloc(bytes.length);
  wasm.HEAPU8.set(bytes, ptr);
  try {
    return fn(ptr);
  } finally {
    wasm._free(ptr);
  }
};

const lightGbmLastError = (wasm: LightGbmWasm): string =>
  wasm.UTF8ToString(wasm._wl_lgb_get_last_error());

const setLightGbmGroupField = async (
  dataset: Dataset,
  groupSizes: readonly number[],
): Promise<void> => {
  const wasm = await loadLightGbmWasmInternals();
  const groups = new Int32Array(groupSizes);
  const ptr = wasm._malloc(groups.byteLength);
  wasm.HEAP32.set(groups, ptr / 4);
  try {
    const result = withCString(wasm, 'group', (fieldPtr) =>
      wasm._wl_lgb_dataset_set_field(
        dataset.handle,
        fieldPtr,
        ptr,
        groups.length,
        LIGHTGBM_C_API_DTYPE_INT32,
      ),
    );
    if (result !== 0) {
      throw new Error(`LightGBM group field failed: ${lightGbmLastError(wasm)}`);
    }
  } finally {
    wasm._free(ptr);
  }
};

const gradeHistogramForRows = (rows: readonly RankerTrainingRow[]): Record<RankerGrade, number> => {
  const histogram: Record<RankerGrade, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 };
  for (const row of rows) {
    const grade = Math.min(4, Math.max(0, Math.round(row.label)));
    const key = String(grade) as RankerGrade;
    histogram[key] += 1;
  }
  return histogram;
};

const percentile = (sorted: readonly number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const rank = fraction * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (rank - lowerIndex);
};

const scoreSpread = (scores: readonly number[]): RankerTrainQuality['scoreSpread'] => {
  if (scores.length === 0) return undefined;
  const sorted = [...scores].sort((left, right) => left - right);
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;
  // Round to a stable precision so a "distinct" count isn't inflated by
  // float noise from an effectively-constant model.
  const distinct = new Set(scores.map((score) => score.toFixed(9))).size;
  return {
    p05: percentile(sorted, 0.05),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    stdDev: Math.sqrt(variance),
    distinctRatio: distinct / scores.length,
  };
};

const dcgAtK = (gains: readonly number[], k: number): number => {
  let dcg = 0;
  const limit = Math.min(k, gains.length);
  for (let i = 0; i < limit; i += 1) {
    dcg += (gains[i] ?? 0) / Math.log2(i + 2);
  }
  return dcg;
};

const ndcgForGroupedRows = (
  rows: readonly RankerTrainingRow[],
  groupSizes: readonly number[],
  scores: readonly number[],
  k: number,
): number | undefined => {
  let offset = 0;
  let sum = 0;
  let counted = 0;
  for (const size of groupSizes) {
    const indices = Array.from({ length: size }, (_, i) => offset + i);
    const ideal = [...indices]
      .map((index) => rows[index]?.label ?? 0)
      .sort((left, right) => right - left);
    const idealDcg = dcgAtK(ideal, k);
    if (idealDcg > 0) {
      const predictedOrder = [...indices].sort(
        (left, right) => (scores[right] ?? 0) - (scores[left] ?? 0),
      );
      const predictedGains = predictedOrder.map((index) => rows[index]?.label ?? 0);
      sum += dcgAtK(predictedGains, k) / idealDcg;
      counted += 1;
    }
    offset += size;
  }
  if (counted === 0) return undefined;
  return sum / counted;
};

const rowHasNovelPairSource = (row: RankerTrainingRow): boolean =>
  row.candidate.sources.some(
    (source) => source === 'user_confirmed' || source === 'same_copied_snippet',
  );

const groupedSlice = (
  rows: readonly RankerTrainingRow[],
  groupSizes: readonly number[],
  scores: readonly number[],
  predicate: (row: RankerTrainingRow) => boolean,
): {
  readonly rows: readonly RankerTrainingRow[];
  readonly groupSizes: readonly number[];
  readonly scores: readonly number[];
} => {
  const slicedRows: RankerTrainingRow[] = [];
  const slicedScores: number[] = [];
  const slicedGroupSizes: number[] = [];
  let offset = 0;
  for (const size of groupSizes) {
    const groupRows = rows.slice(offset, offset + size);
    if (!groupRows.some(predicate)) {
      offset += size;
      continue;
    }
    for (let index = offset; index < offset + size; index += 1) {
      const row = rows[index];
      const score = scores[index];
      if (row === undefined || score === undefined) continue;
      slicedRows.push(row);
      slicedScores.push(score);
    }
    slicedGroupSizes.push(size);
    offset += size;
  }
  return { rows: slicedRows, groupSizes: slicedGroupSizes, scores: slicedScores };
};

const rowLabelCounts = (
  rows: readonly RankerTrainingRow[],
): { readonly positiveRows: number; readonly negativeRows: number } => {
  let positiveRows = 0;
  let negativeRows = 0;
  for (const row of rows) {
    if (row.label > 0) positiveRows += 1;
    else negativeRows += 1;
  }
  return { positiveRows, negativeRows };
};

const deterministicShuffle = <T>(items: readonly T[], seed: number): readonly T[] => {
  const result = [...items];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    const current = result[index];
    const swap = result[swapIndex];
    if (current === undefined || swap === undefined) continue;
    result[index] = swap;
    result[swapIndex] = current;
  }
  return result;
};

const permutedLabelRows = (
  rows: readonly RankerTrainingRow[],
  groupSizes: readonly number[],
  seed: number,
): readonly RankerTrainingRow[] => {
  const permuted: RankerTrainingRow[] = [];
  let offset = 0;
  for (const size of groupSizes) {
    const groupRows = rows.slice(offset, offset + size);
    const labels = deterministicShuffle(
      groupRows.map((row) => row.label),
      seed + offset,
    );
    for (let index = 0; index < groupRows.length; index += 1) {
      const row = groupRows[index];
      const label = labels[index];
      if (row === undefined || label === undefined) continue;
      permuted.push({ ...row, label });
    }
    offset += size;
  }
  return permuted;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const cappedPositive = (value: number, cap: number): number =>
  Math.min(cap, Math.max(0, value)) / cap;

// Step 4 — single-row deterministic baseline score, exported so the
// selector's serving dispatch can use it as the `graph_baseline`
// fallback when no learned artifact passes its ship-gate. The array
// form `deterministicBaselineScores` below stays for the
// training-time evaluation path.
export const deterministicBaselineScore = (features: CandidatePairFeatures): number =>
  2.8 * clamp01(features.cosine_similarity) +
  0.9 * features.same_canonical_url +
  0.75 * features.in_navigation_chain +
  0.55 * features.same_repo +
  0.45 * features.same_search_query +
  0.4 * cappedPositive(features.same_copied_snippet_count, 3) +
  0.45 * cappedPositive(features.shared_title_tokens, 6) +
  0.35 * cappedPositive(features.shared_path_tokens, 6) +
  0.3 * features.engagement_class_match +
  0.25 * features.same_active_topic +
  0.2 * features.topic_lineage_merge_split_related +
  0.15 * clamp01(features.recency_score_to) +
  0.1 * cappedPositive(features.return_count_to, 5) +
  0.05 * cappedPositive(features.page_quality_tier_to, 3) -
  0.08 * cappedPositive(features.opener_chain_depth, 6);

const deterministicBaselineScores = (rows: readonly RankerTrainingRow[]): readonly number[] =>
  rows.map((row) => deterministicBaselineScore(row.features));

const metric = (kind: string, value: number | undefined): RankerMetric | undefined =>
  value === undefined ? undefined : { kind, value };

const logisticFeatureValue = (features: CandidatePairFeatures, key: RankerFeatureKey): number => {
  const value = featureValue(features, key);
  switch (key) {
    case 'opener_chain_depth':
      return cappedPositive(value, 6);
    case 'same_copied_snippet_count':
      return cappedPositive(value, 3);
    case 'shared_title_tokens':
    case 'shared_path_tokens':
      return cappedPositive(value, 6);
    case 'return_count_from':
    case 'return_count_to':
      return cappedPositive(value, 5);
    case 'page_quality_tier_from':
    case 'page_quality_tier_to':
    case 'content_evidence_tier_from':
    case 'content_evidence_tier_to':
    case 'content_quality_pair_min':
      return cappedPositive(value, 3);
    case 'shared_content_terms':
      return cappedPositive(value, 6);
    case 'shared_content_keyphrases':
    case 'content_entity_overlap':
      return cappedPositive(value, 4);
    case 'chunk_support_count':
      return cappedPositive(value, 5);
    case 'cosine_similarity':
    case 'content_weighted_jaccard':
    case 'content_vector_cosine':
    case 'max_chunk_pair_score':
    case 'recency_score_from':
    case 'recency_score_to':
      return clamp01(value);
    case 'same_workstream':
    case 'same_canonical_url':
    case 'same_search_query':
    case 'in_navigation_chain':
    case 'same_host':
    case 'same_repo':
    case 'engagement_class_match':
    case 'user_asserted_in_thread':
    case 'user_asserted_in_workstream':
    case 'same_active_topic':
    case 'topic_lineage_merge_split_related':
    case 'content_both_available':
    case 'container_negative_match':
      return value;
  }
};

const logisticFeatureVector = (features: CandidatePairFeatures): readonly number[] =>
  RANKER_FEATURE_KEYS.map((key) => logisticFeatureValue(features, key));

const sigmoid = (value: number): number => {
  if (value >= 35) return 1;
  if (value <= -35) return 0;
  return 1 / (1 + Math.exp(-value));
};

const dotWithBias = (weights: readonly number[], features: readonly number[]): number => {
  let score = weights[0] ?? 0;
  for (let index = 0; index < features.length; index += 1) {
    score += (weights[index + 1] ?? 0) * (features[index] ?? 0);
  }
  return score;
};

const trainRegularizedLogisticRegression = (
  rows: readonly RankerTrainingRow[],
): readonly number[] | undefined => {
  if (rows.length === 0) return undefined;
  const featureRows = rows.map((row) => logisticFeatureVector(row.features));
  const weights = new Array(RANKER_FEATURE_KEYS.length + 1).fill(0) as number[];
  const learningRate = 0.08;
  const l2 = 0.01;
  const iterations = 120;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradients = new Array(weights.length).fill(0) as number[];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const features = featureRows[rowIndex];
      if (row === undefined || features === undefined) continue;
      const label = row.label > 0 ? 1 : 0;
      const error = sigmoid(dotWithBias(weights, features)) - label;
      gradients[0] = (gradients[0] ?? 0) + error;
      for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
        gradients[featureIndex + 1] =
          (gradients[featureIndex + 1] ?? 0) + error * (features[featureIndex] ?? 0);
      }
    }
    for (let index = 0; index < weights.length; index += 1) {
      const regularization = index === 0 ? 0 : l2 * (weights[index] ?? 0);
      weights[index] =
        (weights[index] ?? 0) -
        learningRate * ((gradients[index] ?? 0) / rows.length + regularization);
    }
  }
  return weights;
};

const logisticRegressionScores = (
  rows: readonly RankerTrainingRow[],
  weights: readonly number[] | undefined,
): readonly number[] | undefined =>
  weights === undefined
    ? undefined
    : rows.map((row) => sigmoid(dotWithBias(weights, logisticFeatureVector(row.features))));

// Step 4 — single-row sigmoid(w · x + bias) score, exported so the
// selector's serving dispatch can apply the LR weights persisted on
// the revision (Step 3) when `logistic_batch` is the selected
// artifact. Mirrors `deterministicBaselineScore` shape (one row, one
// number) so the dispatch surface is uniform across artifact kinds.
export const scoreLogisticBatch = (
  features: CandidatePairFeatures,
  weights: readonly number[],
): number => sigmoid(dotWithBias(weights, logisticFeatureVector(features)));

// Step 6 — exported so the online pairwise update (RankNet) module
// can call into the same feature-vectorization the batch LR uses.
// Keeping one definition keeps online and batch paths bytewise
// comparable on the same input.
export { logisticFeatureVector, sigmoid };

const scoreEvaluationRowsWithFreshBooster = async (
  trainRows: readonly RankerTrainingRow[],
  trainGroupSizes: readonly number[],
  evalRows: readonly RankerTrainingRow[],
  trainingConfig: Required<Pick<TrainRankerOptions, 'seed' | 'numRound'>>,
  params: string,
): Promise<readonly number[] | undefined> => {
  if (trainRows.length === 0 || trainGroupSizes.length === 0 || evalRows.length === 0) {
    return undefined;
  }
  try {
    const trainMatrix = encodeRankerFeatureMatrix(trainRows.map((row) => row.features));
    const dataset = new Dataset(trainMatrix, trainRows.length, RANKER_FEATURE_KEYS.length, params);
    try {
      dataset.setLabel(labelsForRows(trainRows));
      await setLightGbmGroupField(dataset, trainGroupSizes);
      const booster = new Booster(dataset.handle, params);
      try {
        for (let iteration = 0; iteration < trainingConfig.numRound; iteration += 1) {
          booster.update();
        }
        const evalMatrix = encodeRankerFeatureMatrix(evalRows.map((row) => row.features));
        const rawScores = booster.predict(
          evalMatrix,
          evalRows.length,
          RANKER_FEATURE_KEYS.length,
          {},
        );
        const scores: number[] = [];
        for (const score of rawScores) {
          if (Number.isFinite(score)) scores.push(score);
        }
        return scores.length === evalRows.length ? scores : undefined;
      } finally {
        booster.dispose();
      }
    } finally {
      dataset.dispose();
    }
  } catch {
    // Methodology-spine controls are diagnostic only; a failed control
    // should not turn a successful active-model retrain into a failed one.
    return undefined;
  }
};

interface ValidationTuningCandidate {
  readonly numRound: number;
  readonly metric?: RankerMetric;
}

interface ValidationTuningResult {
  readonly status: 'available' | 'unavailable';
  readonly selectedNumRound: number;
  readonly candidates: readonly ValidationTuningCandidate[];
  readonly reason?: 'split-unavailable' | 'validation-metric-unavailable';
}

const tuningNumRoundCandidates = (requestedNumRound: number): readonly number[] =>
  [
    ...new Set(
      [
        Math.max(1, Math.floor(requestedNumRound / 2)),
        requestedNumRound,
        Math.max(requestedNumRound + 1, requestedNumRound * 2),
      ].map((value) => Math.max(1, Math.floor(value))),
    ),
  ].sort((left, right) => left - right);

const tuneNumRoundOnValidation = async (
  trainRows: readonly RankerTrainingRow[],
  trainGroupSizes: readonly number[],
  validationGroups: readonly UsableRankerRowGroup[] | null,
  seed: number,
  requestedNumRound: number,
): Promise<ValidationTuningResult> => {
  if (validationGroups === null) {
    return {
      status: 'unavailable',
      selectedNumRound: requestedNumRound,
      candidates: [],
      reason: 'split-unavailable',
    };
  }
  const validation = flattenRowGroups(validationGroups);
  const candidates: ValidationTuningCandidate[] = [];
  for (const numRound of tuningNumRoundCandidates(requestedNumRound)) {
    const scores = await scoreEvaluationRowsWithFreshBooster(
      trainRows,
      trainGroupSizes,
      validation.rows,
      { seed, numRound },
      lightGbmParamString({ seed, numRound }),
    );
    const value =
      scores === undefined
        ? undefined
        : ndcgForGroupedRows(
            validation.rows,
            validation.groupSizes,
            scores,
            RANKER_HELD_OUT_NDCG_K,
          );
    candidates.push({
      numRound,
      ...(value === undefined
        ? {}
        : { metric: { kind: `validation ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`, value } }),
    });
  }

  const scored = candidates.filter(
    (candidate): candidate is ValidationTuningCandidate & { readonly metric: RankerMetric } =>
      candidate.metric !== undefined,
  );
  if (scored.length === 0) {
    return {
      status: 'unavailable',
      selectedNumRound: requestedNumRound,
      candidates,
      reason: 'validation-metric-unavailable',
    };
  }

  const selected = scored.reduce((best, candidate) => {
    if (candidate.metric.value > best.metric.value) return candidate;
    if (candidate.metric.value < best.metric.value) return best;
    if (candidate.numRound === requestedNumRound) return candidate;
    if (best.numRound === requestedNumRound) return best;
    return candidate.numRound < best.numRound ? candidate : best;
  });

  return {
    status: 'available',
    selectedNumRound: selected.numRound,
    candidates,
  };
};

const modelChoiceGraduation = (
  activeValidation: RankerMetric | undefined,
  baselineValidation: RankerMetric | undefined,
  logisticValidation: RankerMetric | undefined,
): NonNullable<RankerTrainQuality['methodologySpine']>['modelChoice']['graduation'] => {
  const comparison =
    baselineValidation !== undefined &&
    (logisticValidation === undefined || baselineValidation.value >= logisticValidation.value)
      ? { candidate: DETERMINISTIC_BASELINE_VERSION, metric: baselineValidation }
      : logisticValidation === undefined
        ? undefined
        : { candidate: REGULARIZED_LOGISTIC_REGRESSION_VERSION, metric: logisticValidation };
  if (activeValidation === undefined || comparison === undefined) {
    return {
      status: 'unavailable',
      minValidationDelta: RANKER_MODEL_CHOICE_MIN_VALIDATION_DELTA,
      reason: 'validation-metric-unavailable',
    };
  }
  const validationDelta = activeValidation.value - comparison.metric.value;
  if (validationDelta >= RANKER_MODEL_CHOICE_MIN_VALIDATION_DELTA) {
    return {
      status: 'earned',
      minValidationDelta: RANKER_MODEL_CHOICE_MIN_VALIDATION_DELTA,
      validationDelta,
      comparisonCandidate: comparison.candidate,
      reason: 'active-model-beats-comparison-baseline',
    };
  }
  return {
    status: 'not-earned',
    minValidationDelta: RANKER_MODEL_CHOICE_MIN_VALIDATION_DELTA,
    validationDelta,
    comparisonCandidate: comparison.candidate,
    reason: 'active-model-does-not-beat-comparison-baseline',
  };
};

// Per-artifact ship-gate decision. Each artifact is judged on its own
// merits — the legacy single-shipGate (below) bakes in the
// LightGBM-vs-baseline assumption that the selector (Step 4) replaces.
//
// Gate semantics mirror the legacy gate's separation of concerns:
// VALIDATION drives the model-vs-baseline comparison, RESERVED-TEST
// is the absolute floor consulted exactly once. Codex review of PR
// #229 caught that using reserved-test for BOTH the delta AND the
// floor lets reserved-test performance drive model choice, defeating
// the "used exactly once" invariant the legacy shipGate names.
//
// - `graph_baseline` passes whenever its reservedTestMetric exists;
//   it's the deterministic fallback the selector ships when nothing
//   else clears. `unavailable` only when no test split could be built.
//   Never `fail` — the baseline can't fail to be itself.
// - `logistic_batch` / `lightgbm_lambdamart` must:
//     1. beat the baseline's VALIDATION NDCG by
//        RANKER_MODEL_CHOICE_MIN_VALIDATION_DELTA (model-vs-baseline);
//     2. clear the absolute RESERVED-TEST floor
//        RANKER_SHIP_GATE_MIN_RESERVED_TEST_NDCG (floor consulted
//        exactly once);
//     3. have novel-pair supervision (`novelPositiveRows > 0`).
const artifactShipGate = (
  kind: RankerArtifactKind,
  validation: RankerMetric | undefined,
  reservedTest: RankerMetric | undefined,
  baselineValidation: RankerMetric | undefined,
  novelPositiveRows: number,
): RankerArtifactShipGate => {
  if (kind === 'graph_baseline') {
    if (reservedTest === undefined) {
      return { status: 'unavailable', reason: 'reserved-test-metric-unavailable' };
    }
    return { status: 'pass', reason: 'deterministic-baseline-available' };
  }
  // Trained artifacts: logistic_batch, lightgbm_lambdamart (others land
  // with later steps).
  if (
    validation === undefined ||
    reservedTest === undefined ||
    baselineValidation === undefined
  ) {
    return { status: 'unavailable', reason: 'validation-or-test-metric-unavailable' };
  }
  if (novelPositiveRows === 0) {
    return { status: 'unavailable', reason: 'novel-pair-supervision-unavailable' };
  }
  const delta = validation.value - baselineValidation.value;
  if (delta < RANKER_MODEL_CHOICE_MIN_VALIDATION_DELTA) {
    return {
      status: 'fail',
      reason: 'artifact-does-not-beat-baseline',
    };
  }
  if (reservedTest.value < RANKER_SHIP_GATE_MIN_RESERVED_TEST_NDCG) {
    return { status: 'fail', reason: 'reserved-test-below-floor' };
  }
  return { status: 'pass', reason: 'artifact-cleared-baseline-and-floor' };
};

const shipGate = (
  graduation: NonNullable<RankerTrainQuality['methodologySpine']>['modelChoice']['graduation'],
  activeReservedTest: RankerMetric | undefined,
  novelPositiveRows: number,
): NonNullable<RankerTrainQuality['methodologySpine']>['shipGate'] => {
  const base = {
    candidate: RANKER_MODEL_VERSION,
    minValidationDeltaVsBaseline: RANKER_MODEL_CHOICE_MIN_VALIDATION_DELTA,
    minReservedTestNdcg: RANKER_SHIP_GATE_MIN_RESERVED_TEST_NDCG,
    reservedTestUsedExactlyOnce: true as const,
  };
  if (graduation.status === 'unavailable' || activeReservedTest === undefined) {
    return { ...base, status: 'unavailable', reason: 'validation-or-test-metric-unavailable' };
  }
  if (novelPositiveRows === 0) {
    return { ...base, status: 'unavailable', reason: 'novel-pair-supervision-unavailable' };
  }
  if (graduation.status !== 'earned') {
    return {
      ...base,
      status: 'fail',
      reason: 'active-model-does-not-beat-comparison-baseline',
    };
  }
  if (activeReservedTest.value < RANKER_SHIP_GATE_MIN_RESERVED_TEST_NDCG) {
    return { ...base, status: 'fail', reason: 'reserved-test-below-floor' };
  }
  return { ...base, status: 'pass', reason: 'active-model-cleared-validation-and-reserved-test' };
};

export const trainRankerRevisionFromRows = async (
  rowsInput: readonly RankerTrainingRow[],
  options: TrainRankerOptions = {},
  labelingSummary: RankerTrainingLabelingSummary = defaultLabelingSummary(rowsInput),
): Promise<RankerRevision> => {
  const allGroups = usableRowGroups(rowsInput);
  if (allGroups.length === 0) {
    throw new Error(
      'ranker training requires at least one query group with positive and negative labels',
    );
  }
  const split = timeSplitGroups(allGroups);
  const { rows, groupSizes } = flattenRowGroups(split?.trainGroups ?? allGroups);

  const seed = options.seed ?? DEFAULT_RANKER_SEED;
  const requestedNumRound = options.numRound ?? DEFAULT_RANKER_NUM_ROUND;
  const tuning = await tuneNumRoundOnValidation(
    rows,
    groupSizes,
    split?.heldOutGroups ?? null,
    seed,
    requestedNumRound,
  );
  const numRound = tuning.selectedNumRound;
  const trainingDatasetHash = sha256Hex(stableDatasetBody(rows, groupSizes, { seed, numRound }));
  const revisionId = createRankerRevisionId(trainingDatasetHash);
  const params = lightGbmParamString({ seed, numRound });
  const matrix = encodeRankerFeatureMatrix(rows.map((row) => row.features));
  await loadLGB();
  const dataset = new Dataset(matrix, rows.length, RANKER_FEATURE_KEYS.length, params);

  try {
    dataset.setLabel(labelsForRows(rows));
    await setLightGbmGroupField(dataset, groupSizes);
    const booster = new Booster(dataset.handle, params);
    try {
      for (let iteration = 0; iteration < numRound; iteration += 1) {
        booster.update();
      }
      // Reuse the in-process booster + the already-encoded `matrix` for
      // a single extra prediction pass. This is the SAME model that was
      // just trained — no second load, no behavior change to ranking.
      const rawScores = booster.predict(matrix, rows.length, RANKER_FEATURE_KEYS.length, {});
      const scores: number[] = [];
      for (const score of rawScores) {
        if (Number.isFinite(score)) scores.push(score);
      }
      const spread = scores.length === rows.length ? scoreSpread(scores) : undefined;
      const ndcg =
        scores.length === rows.length
          ? ndcgForGroupedRows(rows, groupSizes, scores, RANKER_IN_SAMPLE_NDCG_K)
          : undefined;
      const scoreEvaluationRows = (groups: readonly UsableRankerRowGroup[]) => {
        const evalRows = flattenRowGroups(groups);
        if (evalRows.rows.length === 0 || evalRows.groupSizes.length === 0) return null;
        const evalMatrix = encodeRankerFeatureMatrix(evalRows.rows.map((row) => row.features));
        const rawEvalScores = booster.predict(
          evalMatrix,
          evalRows.rows.length,
          RANKER_FEATURE_KEYS.length,
          {},
        );
        const evalScores: number[] = [];
        for (const score of rawEvalScores) {
          if (Number.isFinite(score)) evalScores.push(score);
        }
        if (evalScores.length !== evalRows.rows.length) return null;
        return { ...evalRows, scores: evalScores };
      };
      const heldOutEval = split === null ? null : scoreEvaluationRows(split.heldOutGroups);
      const heldOutValue =
        heldOutEval === null
          ? undefined
          : ndcgForGroupedRows(
              heldOutEval.rows,
              heldOutEval.groupSizes,
              heldOutEval.scores,
              RANKER_HELD_OUT_NDCG_K,
            );
      const heldOut =
        split === null || heldOutValue === undefined
          ? undefined
          : {
              kind: `time-split held-out ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
              value: heldOutValue,
              trainGroupCount: split.trainGroups.length,
              heldOutGroupCount: split.heldOutGroups.length,
              cutoffGeneratedAt: split.cutoffGeneratedAt,
            };
      const activeValidationMetric = metric(
        `active validation ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
        heldOutValue,
      );
      const baselineValidationValue =
        heldOutEval === null
          ? undefined
          : ndcgForGroupedRows(
              heldOutEval.rows,
              heldOutEval.groupSizes,
              deterministicBaselineScores(heldOutEval.rows),
              RANKER_HELD_OUT_NDCG_K,
            );
      const baselineValidationMetric = metric(
        `deterministic baseline validation ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
        baselineValidationValue,
      );
      const logisticWeights = trainRegularizedLogisticRegression(rows);
      const logisticValidationScores =
        heldOutEval === null
          ? undefined
          : logisticRegressionScores(heldOutEval.rows, logisticWeights);
      const logisticValidationValue =
        heldOutEval === null || logisticValidationScores === undefined
          ? undefined
          : ndcgForGroupedRows(
              heldOutEval.rows,
              heldOutEval.groupSizes,
              logisticValidationScores,
              RANKER_HELD_OUT_NDCG_K,
            );
      const logisticValidationMetric = metric(
        `regularized logistic regression validation ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
        logisticValidationValue,
      );
      const testEval = split === null ? null : scoreEvaluationRows(split.testGroups);
      const testValue =
        testEval === null
          ? undefined
          : ndcgForGroupedRows(
              testEval.rows,
              testEval.groupSizes,
              testEval.scores,
              RANKER_HELD_OUT_NDCG_K,
            );
      const activeReservedTestMetric = metric(
        `active reserved-test ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
        testValue,
      );
      const baselineReservedTestValue =
        testEval === null
          ? undefined
          : ndcgForGroupedRows(
              testEval.rows,
              testEval.groupSizes,
              deterministicBaselineScores(testEval.rows),
              RANKER_HELD_OUT_NDCG_K,
            );
      const baselineReservedTestMetric = metric(
        `deterministic baseline reserved-test ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
        baselineReservedTestValue,
      );
      const logisticReservedTestScores =
        testEval === null ? undefined : logisticRegressionScores(testEval.rows, logisticWeights);
      const logisticReservedTestValue =
        testEval === null || logisticReservedTestScores === undefined
          ? undefined
          : ndcgForGroupedRows(
              testEval.rows,
              testEval.groupSizes,
              logisticReservedTestScores,
              RANKER_HELD_OUT_NDCG_K,
            );
      const logisticReservedTestMetric = metric(
        `regularized logistic regression reserved-test ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
        logisticReservedTestValue,
      );
      const novelSlice =
        heldOutEval === null
          ? { rows: [], groupSizes: [], scores: [] }
          : groupedSlice(
              heldOutEval.rows,
              heldOutEval.groupSizes,
              heldOutEval.scores,
              rowHasNovelPairSource,
            );
      const novelCounts = rowLabelCounts(novelSlice.rows);
      const novelValue =
        novelSlice.rows.length === 0
          ? undefined
          : ndcgForGroupedRows(
              novelSlice.rows,
              novelSlice.groupSizes,
              novelSlice.scores,
              RANKER_HELD_OUT_NDCG_K,
            );
      const permutationSeed = DEFAULT_RANKER_SEED;
      const permutedTrainRows =
        heldOutEval === null ? [] : permutedLabelRows(rows, groupSizes, permutationSeed);
      const permutedScores =
        heldOutEval === null
          ? undefined
          : await scoreEvaluationRowsWithFreshBooster(
              permutedTrainRows,
              groupSizes,
              heldOutEval.rows,
              { seed, numRound },
              params,
            );
      const permutedValue =
        heldOutEval === null || permutedScores === undefined
          ? undefined
          : ndcgForGroupedRows(
              heldOutEval.rows,
              heldOutEval.groupSizes,
              permutedScores,
              RANKER_HELD_OUT_NDCG_K,
            );
      const graduation = modelChoiceGraduation(
        activeValidationMetric,
        baselineValidationMetric,
        logisticValidationMetric,
      );
      const methodologySpine: RankerTrainQuality['methodologySpine'] = {
        split:
          split === null
            ? {
                status: 'unavailable',
                reason: 'insufficient-time-separated-groups',
              }
            : {
                status: 'available',
                strategy: 'forward-chaining-time',
                timestampSource: 'supervision-event-or-visit-observed-at',
                trainGroupCount: split.trainGroups.length,
                validationGroupCount: split.heldOutGroups.length,
                testGroupCount: split.testGroups.length,
                validationCutoffGeneratedAt: split.cutoffGeneratedAt,
                testCutoffGeneratedAt: split.testCutoffGeneratedAt,
              },
        novelPairSlice: {
          rowCount: novelSlice.rows.length,
          groupCount: novelSlice.groupSizes.length,
          positiveRows: novelCounts.positiveRows,
          negativeRows: novelCounts.negativeRows,
          sourceKinds: ['user_confirmed', 'same_copied_snippet'],
          ...(novelValue === undefined
            ? {}
            : {
                metric: {
                  kind: `novel-pair validation ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
                  value: novelValue,
                },
              }),
        },
        labelPermutation: {
          seed: permutationSeed,
          rowCount: heldOutEval?.rows.length ?? 0,
          groupCount: heldOutEval?.groupSizes.length ?? 0,
          ...(permutedValue === undefined
            ? {}
            : {
                metric: {
                  kind: `label-permutation validation ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
                  value: permutedValue,
                },
              }),
        },
        workstreamFeatureAblation: {
          droppedFeatures: ['same_workstream', 'user_asserted_in_workstream'],
          status: 'not-in-feature-vector',
        },
        ...(testValue === undefined || testEval === null
          ? {}
          : {
              reservedTestMetric: {
                kind: `reserved-test ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
                value: testValue,
                rowCount: testEval.rows.length,
                groupCount: testEval.groupSizes.length,
              },
            }),
        tuning: {
          status: tuning.status,
          strategy: 'validation-num-round-grid',
          requestedNumRound,
          selectedNumRound: tuning.selectedNumRound,
          validationCandidateCount: tuning.candidates.length,
          candidates: tuning.candidates,
          ...(tuning.reason === undefined ? {} : { reason: tuning.reason }),
        },
        modelChoice: {
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
            ...(activeValidationMetric === undefined
              ? {}
              : { validationMetric: activeValidationMetric }),
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
          graduation,
        },
        shipGate: shipGate(graduation, activeReservedTestMetric, novelCounts.positiveRows),
      };
      // Per-artifact quality records — one per trained artifact. The
      // selector (Step 4) reads this to dispatch serving without
      // hard-coding LightGBM. Logistic-online + combiner kinds will
      // join the list when Steps 6+8 implement them.
      const artifactQuality: readonly RankerArtifactQuality[] = [
        {
          kind: 'graph_baseline',
          candidate: DETERMINISTIC_BASELINE_VERSION,
          ...(baselineValidationMetric === undefined
            ? {}
            : { validationMetric: baselineValidationMetric }),
          ...(baselineReservedTestMetric === undefined
            ? {}
            : { reservedTestMetric: baselineReservedTestMetric }),
          shipGate: artifactShipGate(
            'graph_baseline',
            baselineValidationMetric,
            baselineReservedTestMetric,
            baselineValidationMetric,
            novelCounts.positiveRows,
          ),
        },
        {
          kind: 'logistic_batch',
          candidate: REGULARIZED_LOGISTIC_REGRESSION_VERSION,
          ...(logisticValidationMetric === undefined
            ? {}
            : { validationMetric: logisticValidationMetric }),
          ...(logisticReservedTestMetric === undefined
            ? {}
            : { reservedTestMetric: logisticReservedTestMetric }),
          shipGate: artifactShipGate(
            'logistic_batch',
            logisticValidationMetric,
            logisticReservedTestMetric,
            baselineValidationMetric,
            novelCounts.positiveRows,
          ),
        },
        {
          kind: 'lightgbm_lambdamart',
          candidate: RANKER_MODEL_VERSION,
          ...(activeValidationMetric === undefined
            ? {}
            : { validationMetric: activeValidationMetric }),
          ...(activeReservedTestMetric === undefined
            ? {}
            : { reservedTestMetric: activeReservedTestMetric }),
          shipGate: artifactShipGate(
            'lightgbm_lambdamart',
            activeValidationMetric,
            activeReservedTestMetric,
            baselineValidationMetric,
            novelCounts.positiveRows,
          ),
        },
      ];
      const trainQuality: RankerTrainQuality = {
        gradeHistogram: gradeHistogramForRows(rows),
        candidateLabeling: labelingSummary,
        ...(spread === undefined ? {} : { scoreSpread: spread }),
        ...(ndcg === undefined
          ? {}
          : {
              inSampleMetric: {
                kind: `in-sample ndcg@${String(RANKER_IN_SAMPLE_NDCG_K)}`,
                value: ndcg,
              },
            }),
        ...(heldOut === undefined ? {} : { heldOutMetric: heldOut }),
        methodologySpine,
      };
      return {
        revisionId,
        modelVersion: RANKER_MODEL_VERSION,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        trainingDatasetHash,
        trainedAt: options.trainedAt ?? maxGeneratedAt(rowsInput),
        modelBytes: toOwnedArrayBuffer(booster.saveModel()),
        trainQuality,
        artifactQuality,
        // Step 3 — keep the regularized LR weights instead of letting
        // `trainRegularizedLogisticRegression(rows)` discard them. The
        // selector + dispatch (Step 4) will load these from the manifest
        // so serving can route to LR when LightGBM fails its gate.
        // `undefined` only when the training row set is empty (which
        // already short-circuits earlier with an error).
        ...(logisticWeights === undefined
          ? {}
          : {
              logisticBatchWeights: [...logisticWeights],
              logisticBatchFeatureStatsVersion: LOGISTIC_BATCH_FEATURE_STATS_VERSION,
            }),
      };
    } finally {
      booster.dispose();
    }
  } finally {
    dataset.dispose();
  }
};

export const trainRankerRevision = async (input: TrainRankerInput): Promise<RankerRevision> =>
  (() => {
    const trainingRows = buildRankerTrainingRowsWithSummary(input.feedback, input.candidates);
    return trainRankerRevisionFromRows(
      trainingRows.rows,
      input.options ?? {},
      trainingRows.labelingSummary,
    );
  })();
