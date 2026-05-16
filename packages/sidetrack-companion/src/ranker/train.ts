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

// Bumped v2 → v3 alongside FEATURE_SCHEMA_VERSION 2 → 3: the
// closest_visit scorer no longer consumes workstream-identity leakage
// features. The manifest validator pins this exact string, so a model
// persisted under v2 fails to load and the retrain loop produces a
// fresh non-leaky model instead of reusing leaked weights.
export const RANKER_MODEL_VERSION = 'lightgbm-lambdamart-v3' as const;
export const DEFAULT_RANKER_NUM_ROUND = 40;
export const DEFAULT_RANKER_SEED = 20260508;
// k for the in-sample NDCG@k offline metric captured at train time.
export const RANKER_IN_SAMPLE_NDCG_K = 5;
export const RANKER_HELD_OUT_NDCG_K = 5;

export type RankerGrade = '0' | '1' | '2' | '3' | '4';

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
}

export interface RankerRevision {
  readonly revisionId: string;
  readonly modelVersion: typeof RANKER_MODEL_VERSION;
  readonly featureSchemaVersion: typeof FEATURE_SCHEMA_VERSION;
  readonly trainingDatasetHash: string;
  readonly trainedAt: number;
  readonly modelBytes: ArrayBuffer;
  readonly trainQuality?: RankerTrainQuality;
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
  readonly cutoffGeneratedAt: number;
}

const timeSplitGroups = (groups: readonly UsableRankerRowGroup[]): TimeSplitRankerRows | null => {
  if (groups.length < 3) return null;
  const sorted = [...groups].sort(
    (left, right) => left.generatedAt - right.generatedAt || compareText(left.fromId, right.fromId),
  );
  if (new Set(sorted.map((group) => group.generatedAt)).size < 2) return null;
  const heldOutCount = Math.max(1, Math.floor(sorted.length * 0.2));
  const trainGroups = sorted.slice(0, sorted.length - heldOutCount);
  const heldOutGroups = sorted.slice(sorted.length - heldOutCount);
  if (trainGroups.length === 0 || heldOutGroups.length === 0) return null;
  const cutoffGeneratedAt = Math.max(...trainGroups.map((group) => group.generatedAt));
  const earliestHeldOut = Math.min(...heldOutGroups.map((group) => group.generatedAt));
  if (earliestHeldOut <= cutoffGeneratedAt) return null;
  return { trainGroups, heldOutGroups, cutoffGeneratedAt };
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
    out[key] = features[key];
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
  const value = features[key];
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
  const numRound = options.numRound ?? DEFAULT_RANKER_NUM_ROUND;
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
      const heldOut = (() => {
        if (split === null) return undefined;
        const heldOutRows = flattenRowGroups(split.heldOutGroups);
        if (heldOutRows.rows.length === 0 || heldOutRows.groupSizes.length === 0) {
          return undefined;
        }
        const heldOutMatrix = encodeRankerFeatureMatrix(
          heldOutRows.rows.map((row) => row.features),
        );
        const rawHeldOutScores = booster.predict(
          heldOutMatrix,
          heldOutRows.rows.length,
          RANKER_FEATURE_KEYS.length,
          {},
        );
        const heldOutScores: number[] = [];
        for (const score of rawHeldOutScores) {
          if (Number.isFinite(score)) heldOutScores.push(score);
        }
        if (heldOutScores.length !== heldOutRows.rows.length) return undefined;
        const value = ndcgForGroupedRows(
          heldOutRows.rows,
          heldOutRows.groupSizes,
          heldOutScores,
          RANKER_HELD_OUT_NDCG_K,
        );
        if (value === undefined) return undefined;
        return {
          kind: `time-split held-out ndcg@${String(RANKER_HELD_OUT_NDCG_K)}`,
          value,
          trainGroupCount: split.trainGroups.length,
          heldOutGroupCount: split.heldOutGroups.length,
          cutoffGeneratedAt: split.cutoffGeneratedAt,
        };
      })();
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
      };
      return {
        revisionId,
        modelVersion: RANKER_MODEL_VERSION,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        trainingDatasetHash,
        trainedAt: options.trainedAt ?? maxGeneratedAt(rowsInput),
        modelBytes: toOwnedArrayBuffer(booster.saveModel()),
        trainQuality,
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
