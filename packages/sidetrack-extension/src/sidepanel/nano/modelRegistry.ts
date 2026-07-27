// WHICH MODEL is behind each engine — declared, not assumed.
//
// WHY THIS EXISTS. The comparison surface (compareEngines.ts) pits Chrome's
// built-in model against our local WebGPU model on the same document. That
// comparison is only honest if the reader can see what is actually being
// compared, because the two are NOT the same size:
//
//   Chrome built-in  — component manifest BaseModelSpec "v3Nano", component
//                      version 2025.8.8.1141. Nano-2 class, ~3.25B parameters,
//                      4-bit quantized. weights.bin on disk measures
//                      4,269,932,544 bytes (4.27 GB).
//   Our WebGPU model — onnx-community/gemma-3-1b-it-ONNX at dtype q4, roughly
//                      819 MB on disk. That is about ONE THIRD the parameters.
//
// So any "Nano beat our model" reading is confounded by model size. Two things
// follow, and both live here: every engine carries a DECLARED identity (params +
// quantization) that the comparison renders, and the local model is SELECTABLE
// so a size-matched fight is possible at all.
//
// STRICT LOAD GATING IS UNCHANGED. Selecting a model here writes a preference;
// it never downloads anything. The ~800MB (or ~3.3GB) fetch stays reachable
// from exactly one place — the explicit Health → Experiments load button — and
// that button states the selected model's size before the user commits.
//
// Pure data + pure helpers, plus a two-function preference accessor over
// chrome.storage.local. No model, no network, no React.

import { readDeviceValue, writeDeviceValue } from './deviceStore';
import { GIST_MAX_NEW_TOKENS, GIST_OUTPUT_MAX_CHARS } from './generationOptions';

/** The three backends a generation can run on. 'remote' is opt-in and off by default. */
export type EngineKind = 'nano' | 'webgpu' | 'remote';

/**
 * What a row in the comparison says about the model that produced it. Every
 * field is DECLARED (read off a manifest or a model card), never inferred from
 * the output — a comparison that guesses at model size is worse than none.
 */
export interface EngineIdentity {
  readonly kind: EngineKind;
  /** Short surface name: 'Chrome built-in' | 'local' | 'remote'. */
  readonly label: string;
  /** The model itself, as it is named on the wire / in the enrichment payload. */
  readonly modelName: string;
  /** Human parameter count, e.g. '~3.25B'. */
  readonly params: string;
  /** Numeric parameter count in billions; null when the provider does not say. */
  readonly paramsBillions: number | null;
  /** '4-bit' | 'q4' | 'unknown' (a hosted provider does not disclose it). */
  readonly quantization: string;
  /** On-disk weight size in bytes; null when not applicable/known. */
  readonly approxBytesOnDisk: number | null;
}

// ---------------------------------------------------------------------------
// Chrome's built-in model — measured facts, not folklore.
// ---------------------------------------------------------------------------

/** Optimization-guide component version the facts below were read from. */
export const NANO_COMPONENT_VERSION = '2025.8.8.1141';
/** BaseModelSpec string in that component's manifest. */
export const NANO_BASE_MODEL_SPEC = 'v3Nano';
/** weights.bin on disk, in bytes. */
export const NANO_WEIGHTS_BYTES = 4_269_932_544;
/** Nano-2 class parameter count. */
export const NANO_PARAMS_BILLIONS = 3.25;

export const NANO_IDENTITY: EngineIdentity = {
  kind: 'nano',
  label: 'Chrome built-in',
  modelName: 'gemini-nano',
  params: '~3.25B',
  paramsBillions: NANO_PARAMS_BILLIONS,
  quantization: '4-bit',
  approxBytesOnDisk: NANO_WEIGHTS_BYTES,
};

// ---------------------------------------------------------------------------
// The local (WebGPU) model registry.
// ---------------------------------------------------------------------------

/**
 * One selectable local model. `maxInputChars` / `maxNewTokens` live HERE and
 * not in a per-engine-kind table because they are a property of the MODEL: a
 * 4B model does roughly four times the work per token, so it needs a smaller
 * input slice to land in the same latency band as the 1B default.
 */
export interface LocalModelSpec {
  /** HF-layout id, served by the local companion (never fetched from HF). */
  readonly id: string;
  readonly revision: string;
  readonly label: string;
  readonly params: string;
  readonly paramsBillions: number;
  /** transformers.js dtype — also the user-facing quantization string. */
  readonly quantization: string;
  readonly approxBytesOnDisk: number;
  /**
   * 'verified' = this exact id has actually been loaded from the companion
   * model host in this repo. 'unverified' = the entry is declared from the
   * model card but NOT proven to resolve here; the load button says so and a
   * failed load reports the honest reason instead of silently falling back to
   * some other id. We do not guess at substitute ids.
   */
  readonly status: 'verified' | 'unverified';
  readonly statusNote: string;
  /** Per-generation input cap in characters — see limitsNote. */
  readonly maxInputChars: number;
  /** Output token budget handed to transformers.js. */
  readonly maxNewTokens: number;
  /** Hard character cap applied to the cleaned output. */
  readonly maxOutputChars: number;
  /** How the input cap was arrived at — stated, never a bare magic number. */
  readonly limitsNote: string;
}

/** The default: unchanged behavior from before the registry existed. */
export const DEFAULT_LOCAL_MODEL_ID = 'onnx-community/gemma-3-1b-it-ONNX';

/**
 * The 1B default's input cap. LATENCY-DERIVED, not context-derived: the
 * 2026-07-27 tuning run on an M-series GPU fed 2000-character inputs and took
 * roughly 13 seconds per gist. The model's context window is far larger; 2000
 * is the point where a single on-demand summary still feels like an action
 * rather than a background job.
 */
export const WEBGPU_1B_MAX_INPUT_CHARS = 2000;
/**
 * The 4B option's input cap. DECLARED, NOT MEASURED — no live run of this model
 * exists in this repo. Scaled from the 1B measurement by parameter count: ~4x
 * the compute per token, so half the input slice keeps a single gist in the
 * same order of magnitude as the measured ~13s rather than pushing it into
 * minutes. Re-measure and update this number once the model has actually run.
 */
export const WEBGPU_4B_MAX_INPUT_CHARS = 1000;

export const LOCAL_MODELS: readonly LocalModelSpec[] = [
  {
    id: DEFAULT_LOCAL_MODEL_ID,
    revision: 'main',
    label: '1B q4 (fast)',
    params: '1B',
    paramsBillions: 1,
    quantization: 'q4',
    approxBytesOnDisk: 819_000_000,
    status: 'verified',
    statusNote: 'loaded from the companion model host; ~13s per gist on an M2.',
    maxInputChars: WEBGPU_1B_MAX_INPUT_CHARS,
    maxNewTokens: GIST_MAX_NEW_TOKENS,
    maxOutputChars: GIST_OUTPUT_MAX_CHARS,
    limitsNote:
      'Latency-derived: the 2026-07-27 tuning run used 2000-char inputs at ~13s per gist.',
  },
  {
    id: 'onnx-community/gemma-3-4b-it-ONNX',
    revision: 'main',
    label: '4B q4 (matched to Nano)',
    params: '4B',
    paramsBillions: 4,
    quantization: 'q4',
    approxBytesOnDisk: 3_300_000_000,
    status: 'unverified',
    statusNote:
      'Declared from the model card, NOT yet loaded here. If the id does not resolve against the companion model host the load reports that error — no substitute id is guessed.',
    maxInputChars: WEBGPU_4B_MAX_INPUT_CHARS,
    maxNewTokens: GIST_MAX_NEW_TOKENS,
    maxOutputChars: GIST_OUTPUT_MAX_CHARS,
    limitsNote:
      'Declared, not measured: scaled from the 1B latency measurement by parameter count (~4x compute per token).',
  },
];

/** Look a spec up by id, falling back to the default rather than throwing. */
export const localModelSpec = (id: string | null | undefined): LocalModelSpec => {
  // The registry is a module constant with at least one entry, so the default
  // branch cannot actually miss; the ?? is there so a future empty registry
  // fails a type check rather than returning undefined at runtime.
  return LOCAL_MODELS.find((m) => m.id === id) ?? LOCAL_MODELS[0];
};

/** The identity a local model presents in a comparison row: "local · 1B · q4". */
export const localModelIdentity = (spec: LocalModelSpec): EngineIdentity => ({
  kind: 'webgpu',
  label: 'local',
  modelName: shortModelName(spec.id),
  params: spec.params,
  paramsBillions: spec.paramsBillions,
  quantization: spec.quantization,
  approxBytesOnDisk: spec.approxBytesOnDisk,
});

/**
 * 'onnx-community/gemma-3-1b-it-ONNX' → 'gemma-3-1b-it'. This is the string the
 * content-enrichment contract stores as `model`, so it must stay stable for the
 * default model (existing rows in the vault say 'gemma-3-1b-it').
 */
export function shortModelName(id: string): string {
  const tail = id.split('/').pop() ?? id;
  return tail.replace(/-ONNX$/iu, '');
}

/** The identity a hosted provider presents. Size is genuinely unknown to us. */
export const remoteIdentity = (modelName: string): EngineIdentity => ({
  kind: 'remote',
  label: 'remote',
  modelName,
  params: 'provider-side',
  paramsBillions: null,
  quantization: 'unknown',
  approxBytesOnDisk: null,
});

// ---------------------------------------------------------------------------
// Rendering helpers.
// ---------------------------------------------------------------------------

/** "~800MB" / "3.3GB" — the number the load button states before committing. */
export const formatModelSize = (bytes: number | null): string => {
  if (bytes === null || bytes <= 0) return 'unknown size';
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
  return `${String(Math.round(bytes / 100_000_000) * 100)}MB`;
};

/** "Chrome built-in · ~3.25B · 4-bit" — the matchup line on a comparison row. */
export const describeIdentity = (identity: EngineIdentity): string =>
  [identity.label, identity.params, identity.quantization].join(' · ');

// ---------------------------------------------------------------------------
// Selection (chrome.storage.local — see deviceStore.ts).
// ---------------------------------------------------------------------------

export const LOCAL_MODEL_STORAGE_KEY = 'sidetrack.localModel.v1';

/** Read the selected local model id; the default when nothing is stored. */
export const readSelectedLocalModelId = async (): Promise<string> => {
  const stored = await readDeviceValue<string>(LOCAL_MODEL_STORAGE_KEY);
  return typeof stored === 'string' && LOCAL_MODELS.some((m) => m.id === stored)
    ? stored
    : DEFAULT_LOCAL_MODEL_ID;
};

/** Persist the selection. Writing it never downloads anything. */
export const writeSelectedLocalModelId = async (id: string): Promise<void> => {
  await writeDeviceValue(LOCAL_MODEL_STORAGE_KEY, localModelSpec(id).id);
};
