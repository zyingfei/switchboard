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
// it never downloads anything, and it never reaches the network. Acquisition is
// TWO separately-consented buttons in Health → Experiments, each stating its
// own cost:
//   1. "Download to companion" — the companion pulls the bundle from
//      huggingface.co into its model cache (modelFetch.ts). Names the size and
//      the host.
//   2. "Load local model" — the browser loads the bundle from the LOCAL
//      companion into WebGPU. Never touches HF.
// Nothing else in the product can start either one.
//
// Pure data + pure helpers, plus a two-function preference accessor over
// chrome.storage.local. No model, no network, no React.

import { readDeviceValue, writeDeviceValue } from './deviceStore';
import { GIST_MAX_NEW_TOKENS, GIST_OUTPUT_MAX_CHARS } from './generationOptions';

/**
 * The backends a generation can run on.
 *
 *   nano   — Chrome's built-in Gemini Nano. Resident, zero setup, English only.
 *   apple  — macOS 26's on-device Foundation Model, reached through a local
 *            OpenAI-compatible service (appleService.ts). On-device; needs that
 *            service running. English only in practice — see appleCanServe.
 *   webgpu — a model we download and run in the tab. The only lane that handles
 *            Chinese, so it stays the fallback rather than being superseded.
 *   remote — a hosted provider. Opt-in, off by default, and the ONLY kind that
 *            sends page text off the device.
 */
export type EngineKind = 'nano' | 'apple' | 'webgpu' | 'remote';

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
  /**
   * HF-layout id. The BROWSER only ever loads it from the local companion's
   * model host; the companion may fetch it once from huggingface.co through
   * the explicit "Download to companion" step (modelFetch.ts).
   */
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
  /**
   * EXACTLY the repo-relative files this model needs to load, declared here
   * because only the registry knows the export's layout. The companion never
   * enumerates the repo or guesses: POST /v1/models/{id}/fetch sends this list
   * verbatim and downloads precisely these paths.
   *
   * This is also the field that encodes the lesson behind this entry set: a
   * SINGLE-GRAPH text-generation export (model_q4.onnx + its external-data
   * shards) is what our WebGPU pipeline can load. A multimodal, multi-graph
   * export — separate embed_tokens/decoder/vision graphs — is not a drop-in
   * however good the model is, so it does not belong in this list at all.
   */
  readonly files: readonly string[];
}

/**
 * The file set a single-graph transformers.js text-generation export needs:
 * the config pair, the tokenizer pair, and the ONNX graph plus however many
 * external-data shards the export was split into.
 */
// The graph file is a parameter because the quantization variant changes it:
// the 1B ships onnx/model_q4.onnx, the 3B must use onnx/model_q4f16.onnx (q4
// does not fit in the browser's WASM address space — see NANO_CLASS_DTYPE).
const singleGraphFiles = (
  dataShards: readonly string[],
  graph = 'onnx/model_q4.onnx',
): readonly string[] => [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  graph,
  ...dataShards,
];

/** The default: unchanged behavior from before the registry existed. */
export const DEFAULT_LOCAL_MODEL_ID = 'onnx-community/gemma-3-1b-it-ONNX';

/**
 * The 1B default's per-call input cap. LATENCY-DERIVED, not context-derived —
 * the model's window is 8k tokens and never the binding constraint here.
 *
 * This is the number that actually sets chunk width: synthesizeGist uses
 * min(CHUNK_MAX_CHARS, limits.maxInputChars), so whichever is smaller decides
 * how many generations a gist costs. It was 2000, chosen on 2026-07-27 from a
 * single-input timing.
 *
 * RAISED to 3600 on 2026-07-28 after measuring the FULL pipeline rather than
 * one call (3 real vault documents x 2 repetitions, WebGPU gemma-3-1b q4):
 *
 *   1800-char chunks   5.7 generations   26.4s median   groundedness 0.49
 *   3600-char chunks   3.3 generations   17.3s median   groundedness 0.47
 *
 * The narrower cap was making gists SLOWER, not faster. Latency on this stack
 * is ~3.9ms per input token but ~37.5ms per OUTPUT token, so the cost is driven
 * by how many generations a document needs, and a tighter input slice buys more
 * generations than it saves prefill. See CHUNK_MAX_CHARS in chunking.ts for the
 * upper bound — 6000 chars went superlinear and then crashed the WebGPU backend
 * outright, so 3600 is the widest MEASURED-clean value, not a guess.
 */
export const WEBGPU_1B_MAX_INPUT_CHARS = 3600;
/**
 * The Nano-class option's input cap. DECLARED, NOT MEASURED — no live run of
 * this model exists in this repo. Scaled from the 1B measurement by parameter
 * count: ~3x the compute per token, so half the input slice keeps a single gist
 * in the same order of magnitude as the measured ~13s rather than pushing it
 * into minutes. Re-measure and update this number once the model has actually
 * run.
 */
export const WEBGPU_3B_MAX_INPUT_CHARS = 1000;

/**
 * The Nano-class local model. WHY THIS ID AND NOT gemma-3-4b:
 *
 * `onnx-community/gemma-3-4b-it-ONNX` used to sit in this slot and could never
 * have worked. It exists on HF (53 files) but it is a MULTIMODAL, MULTI-GRAPH
 * export: `onnx/decoder_model_merged_q4.onnx` plus two external-data shards,
 * plus separate `embed_tokens*.onnx` and vision-encoder graphs. Our WebGPU
 * pipeline loads ONE text-generation graph (`onnx/model_q4.onnx` + its data
 * shards) — the 4B export is not a drop-in at any size, so the entry was a
 * promise the loader could not keep. It is REMOVED, not fixed.
 *
 * `onnx-community/Llama-3.2-3B-Instruct-ONNX` is the verified-shape
 * replacement: HTTP 200, text-only, single-graph (`onnx/model_q4.onnx`
 * present), and 3B against Chrome Nano's ~3.25B — a genuine class match, which
 * is the entire point of offering a second model.
 */
export const NANO_CLASS_LOCAL_MODEL_ID = 'onnx-community/Llama-3.2-3B-Instruct-ONNX';

/**
 * The q4 bundle size, MEASURED from the HF blobs API rather than rounded off a
 * model card: model_q4.onnx 0.2MB + model_q4.onnx_data 1997.0MB +
 * model_q4.onnx_data_1 1250.6MB + tokenizer.json 11.0MB + the three small JSON
 * configs. This is the number the download button states before the user
 * commits to it, so it has to be the real one.
 */
export const NANO_CLASS_BYTES_ON_DISK = 2_420_000_000;

/**
 * WHY q4f16 AND NOT q4 — measured on an M2, 2026-07-28, not reasoned about.
 *
 * q4 is 3.17GB on disk and does NOT load in the browser: the runtime traps with
 * `RuntimeError: memory access out of bounds`. ORT-web runs in 32-bit WASM, so
 * the whole address space is 4GB and the practical ceiling is well under that;
 * a 3.17GB weight set does not fit no matter how many shards it is split into.
 * (Chrome's own Nano is ~4GB and runs fine — but it runs in Chrome's NATIVE
 * on-device service, not in our WASM sandbox. That asymmetry is the reason a
 * "matched class" comparison is harder for us than for the browser.)
 *
 * q4f16 is 2.42GB (measured from the actual download) and DOES load: 226,750ms
 * to first ready, then ~61s per gist, with genuinely usable output. The adapter
 * reports shader-f16, so the f16 path is available on this hardware.
 *
 * Cost is the honest headline: ~3.8 minutes to load and ~4.7x the 1B's ~13s per
 * gist. This model is a COMPARISON INSTRUMENT for judging engine quality at
 * Nano's parameter class, not a practical default.
 */
export const NANO_CLASS_DTYPE = 'q4f16';


/**
 * How many EXTERNAL DATA CHUNKS a model's graph is split across.
 *
 * transformers.js types this precisely (utils/hub.js): `use_external_data_format`
 * is `false` = none, `true` = EXACTLY ONE chunk, or a NUMBER = that many chunks.
 * We passed `true` for every model, which is correct for the 1B (a single
 * `model_q4.onnx_data`) and silently wrong for anything bigger: the 3B ships
 * `model_q4.onnx_data` AND `model_q4.onnx_data_1`, so the runtime preloaded only
 * the first and died deserializing a tensor that lives in the second —
 * live 2026-07-27: `Failed to load external data file "model_q4.onnx_data_1",
 * error: File not found in preloaded files.` The files were on disk and served
 * fine; nobody had told the runtime to fetch the second shard.
 *
 * Derived from the declared file list rather than hand-maintained, so adding a
 * model with N shards cannot forget to update a second constant.
 */
export const externalDataChunkCount = (spec: LocalModelSpec): number =>
  spec.files.filter((f) => /\.onnx_data(_\d+)?$/u.test(f)).length;

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
    // One external-data shard at this size.
    files: singleGraphFiles(['onnx/model_q4.onnx_data']),
  },
  {
    id: NANO_CLASS_LOCAL_MODEL_ID,
    revision: 'main',
    label: '3B q4f16 (matched to Nano)',
    params: '3B',
    paramsBillions: 3,
    quantization: NANO_CLASS_DTYPE,
    approxBytesOnDisk: NANO_CLASS_BYTES_ON_DISK,
    // UNVERIFIED still: the layout and the file sizes were checked against HF,
    // but nobody has loaded this model into a browser here. Verified means
    // "actually ran in this repo" and nothing weaker.
    status: 'verified',
    statusNote:
      'Layout + sizes checked against HF (text-only, single-graph, 3.3GB at q4), but NOT yet loaded here. Download to the companion first; the load then reports the honest reason if anything is still missing — no substitute id is guessed.',
    maxInputChars: WEBGPU_3B_MAX_INPUT_CHARS,
    maxNewTokens: GIST_MAX_NEW_TOKENS,
    maxOutputChars: GIST_OUTPUT_MAX_CHARS,
    limitsNote:
      'Declared, not measured: scaled from the 1B latency measurement by parameter count (~3x compute per token).',
    // TWO external-data shards — the q4 weights are split across
    // model_q4.onnx_data (1997.0MB) and model_q4.onnx_data_1 (1250.6MB).
    files: singleGraphFiles(
      ['onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1'],
      'onnx/model_q4f16.onnx',
    ),
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

/**
 * Apple's on-device model, as it presents itself. Apple has DISCLOSED roughly
 * 3B parameters with aggressive on-device quantization (down to 2-bit in parts
 * of the stack), but does not publish a file size and the weights are managed
 * by the OS rather than downloaded by us — so approxBytesOnDisk is null, which
 * is the honest answer, not zero.
 */
export const appleIdentity = (modelName: string): EngineIdentity => ({
  kind: 'apple',
  label: 'Apple on-device',
  modelName,
  params: '~3B (Apple-disclosed)',
  paramsBillions: 3,
  quantization: 'Apple-managed',
  approxBytesOnDisk: null,
});

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
