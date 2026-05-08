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

export const RANKER_MODEL_VERSION = 'lightgbm-lambdamart-v1' as const;
export const DEFAULT_RANKER_NUM_ROUND = 40;
export const DEFAULT_RANKER_SEED = 20260508;

export interface RankerRevision {
  readonly revisionId: string;
  readonly modelVersion: typeof RANKER_MODEL_VERSION;
  readonly featureSchemaVersion: typeof FEATURE_SCHEMA_VERSION;
  readonly trainingDatasetHash: string;
  readonly trainedAt: number;
  readonly modelBytes: ArrayBuffer;
}

export interface RankerTrainingCandidate {
  readonly candidate: Candidate;
  readonly features: CandidatePairFeatures;
}

export interface RankerTrainingRow extends RankerTrainingCandidate {
  readonly label: number;
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
  'same_workstream',
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
  'user_asserted_in_workstream',
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

const relevanceForCandidate = (
  candidate: Candidate,
  positiveWeights: ReadonlyMap<string, number>,
  negativeWeights: ReadonlyMap<string, number>,
): number | null => {
  const key = pairKey(candidate.fromVisitId, candidate.toVisitId);
  const positive = positiveWeights.get(key) ?? 0;
  const negative = negativeWeights.get(key) ?? 0;
  if (positive > negative) return Math.min(4, Math.max(1, Math.round(positive)));
  if (negative > 0 || candidateHasImplicitNegativeSource(candidate)) return 0;
  return null;
};

export const buildRankerTrainingRows = (
  feedback: FeedbackProjection,
  candidates: readonly RankerTrainingCandidate[],
): readonly RankerTrainingRow[] => {
  const positiveWeights = labelWeights(feedback.positiveLabels);
  const negativeWeights = labelWeights(feedback.negativeLabels);
  const rows: RankerTrainingRow[] = [];

  for (const item of candidates) {
    const label = relevanceForCandidate(item.candidate, positiveWeights, negativeWeights);
    if (label === null) continue;
    rows.push({ ...item, label });
  }

  return rows.sort(compareTrainingRow);
};

const compareTrainingRow = (left: RankerTrainingRow, right: RankerTrainingRow): number =>
  compareText(left.candidate.fromVisitId, right.candidate.fromVisitId) ||
  compareText(left.candidate.toVisitId, right.candidate.toVisitId) ||
  right.label - left.label;

const groupUsableRows = (
  rows: readonly RankerTrainingRow[],
): { readonly rows: readonly RankerTrainingRow[]; readonly groupSizes: readonly number[] } => {
  const byFrom = new Map<string, RankerTrainingRow[]>();
  for (const row of rows) {
    const group = byFrom.get(row.candidate.fromVisitId);
    if (group === undefined) {
      byFrom.set(row.candidate.fromVisitId, [row]);
    } else {
      group.push(row);
    }
  }

  const usableRows: RankerTrainingRow[] = [];
  const groupSizes: number[] = [];
  for (const fromId of [...byFrom.keys()].sort(compareText)) {
    const group = [...(byFrom.get(fromId) ?? [])].sort(compareTrainingRow);
    const labels = new Set(group.map((row) => row.label));
    if (group.length < 2 || labels.size < 2) continue;
    usableRows.push(...group);
    groupSizes.push(group.length);
  }

  return { rows: usableRows, groupSizes };
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

const maxGeneratedAt = (rows: readonly RankerTrainingRow[]): number => {
  let generatedAt = 0;
  for (const row of rows) {
    if (Number.isFinite(row.candidate.generatedAt)) {
      generatedAt = Math.max(generatedAt, row.candidate.generatedAt);
    }
  }
  return generatedAt;
};

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

export const trainRankerRevisionFromRows = async (
  rowsInput: readonly RankerTrainingRow[],
  options: TrainRankerOptions = {},
): Promise<RankerRevision> => {
  const { rows, groupSizes } = groupUsableRows(rowsInput);
  if (rows.length === 0 || groupSizes.length === 0) {
    throw new Error(
      'ranker training requires at least one query group with positive and negative labels',
    );
  }

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
      return {
        revisionId,
        modelVersion: RANKER_MODEL_VERSION,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        trainingDatasetHash,
        trainedAt: options.trainedAt ?? maxGeneratedAt(rows),
        modelBytes: toOwnedArrayBuffer(booster.saveModel()),
      };
    } finally {
      booster.dispose();
    }
  } finally {
    dataset.dispose();
  }
};

export const trainRankerRevision = async (input: TrainRankerInput): Promise<RankerRevision> =>
  trainRankerRevisionFromRows(
    buildRankerTrainingRows(input.feedback, input.candidates),
    input.options ?? {},
  );
