import { performance } from 'node:perf_hooks';

import { INDEX_DIM } from './indexFile.js';

// Switched from `@xenova/transformers` (wasm-only, deprecated) to
// `@huggingface/transformers` so we can run ONNX on the native Node
// runtime via `device: 'cpu'`. On Apple Silicon that path uses
// onnxruntime-node + Apple Accelerate — order-of-magnitude faster
// and lower-peak-memory than wasm. The PoC at
// `poc/recall-vector/src/recall/embedder.ts` validated this and
// produced the benchmarks in `poc/recall-vector/README.md`.
//
// Model is multilingual: `multilingual-e5-small` was chosen over
// the English-only `all-MiniLM-L6-v2` so cross-language thread /
// workstream matching works — a Chinese-titled thread still
// clusters with its English-titled workstream peers (smoke-test:
// "hello world" ↔ "你好世界" cosine = 0.901). The dimensionality
// stays 384, so the index format is unchanged — the only effect
// of the swap is that an existing index becomes "stale" per the
// lifecycle's modelId check, and the next companion start auto-
// rebuilds against the new model. ~30MB quantized; cached on disk.
//
// We tried Xenova/paraphrase-multilingual-MiniLM-L12-v2 first but
// its uploaded ONNX files for fp32 / fp16 / q8 are all incomplete
// or split across external-data refs that @huggingface/transformers
// doesn't fetch — Protobuf parsing fails at load. multilingual-e5-
// small ships clean q8 + fp16 + fp32 files of expected sizes.
export const MODEL_ID = 'Xenova/multilingual-e5-small';

type FeatureExtractor = (
  text: string,
  options: { readonly pooling: 'mean'; readonly normalize: true },
) => Promise<{ readonly data: ArrayLike<number> }>;

// Identifies which runtime backend the model loaded onto. Surfaced
// in /v1/system/health.recall.embedderDevice so the side panel can
// show the user "embedder: cpu (Accelerate)" vs "wasm" — useful
// for diagnosing slow rebuilds and for confirming the platform
// upgrade actually took effect.
//
//   cpu  — onnxruntime-node, native CPU. On Apple Silicon this
//          runs through Apple Accelerate (AMX/SIMD) and is the
//          fastest CPU path; on x86_64 macOS / Linux it uses the
//          native ONNX CPU EP.
//   wasm — JS/WASM fallback. ~5-10× slower than cpu, only used
//          if onnxruntime-node fails to load (no native binary
//          for the host platform).
//   webgpu — only reachable from a browser context (extension
//          offscreen document). Unavailable in Node.
export type EmbedderDevice = 'cpu' | 'wasm' | 'webgpu' | 'unknown';

// On Apple Silicon, onnxruntime-node CPU EP routes through the
// Accelerate framework (AMX SIMD); on x86_64 it goes through MKL
// or generic CPU. We can't introspect onnxruntime's actual EP at
// runtime through @huggingface/transformers, but we can derive a
// reasonable label from process.platform + process.arch.
export type EmbedderAccelerator = 'accelerate' | 'mkl' | 'cpu' | 'unknown';

const detectAccelerator = (): EmbedderAccelerator => {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'accelerate';
  if (process.platform === 'darwin') return 'cpu';
  if (process.platform === 'linux' || process.platform === 'win32') return 'mkl';
  return 'unknown';
};

let extractorPromise: Promise<FeatureExtractor> | undefined;
let resolvedDevice: EmbedderDevice = 'unknown';
let resolvedAccelerator: EmbedderAccelerator = 'unknown';

export const getResolvedEmbedderDevice = (): EmbedderDevice => resolvedDevice;
export const getResolvedEmbedderAccelerator = (): EmbedderAccelerator => resolvedAccelerator;

const log = (message: string): void => {
  // eslint-disable-next-line no-console
  console.info(message);
};

export const getEmbedder = async (): Promise<FeatureExtractor> => {
  if (extractorPromise === undefined) {
    const started = performance.now();
    extractorPromise = (async () => {
      const module = await import('@huggingface/transformers');
      const env = (module as { readonly env?: Record<string, unknown> }).env;
      if (env !== undefined) {
        env['allowRemoteModels'] = true;
        env['allowLocalModels'] = false;
        // Cache to disk under the user's HF cache dir so we only pay
        // the model download once across companion restarts.
        env['useFSCache'] = true;
      }
      // `device: 'cpu'` selects onnxruntime-node which on macOS uses
      // Apple Accelerate.
      //
      // dtype cascade: many community-uploaded models (especially
      // multilingual variants) ship ONLY quantized weights — no
      // fp32 file at all. Loading with the default dtype then fails
      // mid-Protobuf parsing with no useful hint. We try q8 first
      // (smallest + fastest, what most models publish) and walk up
      // through fp16 / fp32 if a given model happens to ship those
      // instead. The first one that loads sticks.
      const dtypeCandidates: readonly string[] = ['q8', 'fp16', 'fp32'];
      const errors: string[] = [];
      for (const dtype of dtypeCandidates) {
        try {
          const pipe = (await module.pipeline('feature-extraction', MODEL_ID, {
            device: 'cpu',
            dtype,
          } as Parameters<typeof module.pipeline>[2])) as unknown as FeatureExtractor;
          resolvedDevice = 'cpu';
          resolvedAccelerator = detectAccelerator();
          log(
            `[recall] loaded embedding model ${MODEL_ID} (cpu/${resolvedAccelerator}/${dtype}) in ${String(Math.round(performance.now() - started))}ms`,
          );
          return pipe;
        } catch (error) {
          errors.push(
            `${dtype}: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
          );
        }
      }
      throw new Error(
        `[recall] could not load ${MODEL_ID} on any dtype. Tried: ${errors.join(' | ')}`,
      );
    })();
  }
  return await extractorPromise;
};

const toFloat32 = (data: ArrayLike<number>): Float32Array => {
  if (data instanceof Float32Array) {
    return new Float32Array(data);
  }
  return Float32Array.from({ length: data.length }, (_, index) => data[index] ?? 0);
};

const padOrTruncate = (values: Float32Array): Float32Array => {
  if (values.length === INDEX_DIM) return values;
  const out = new Float32Array(INDEX_DIM);
  out.set(values.subarray(0, INDEX_DIM));
  return out;
};

// We embed one text per pipeline call rather than passing the whole
// batch as a single tensor. The all-at-once path used to run with
// @xenova/transformers allocated a [batch, seq, hidden] tensor that
// peaked over 1GB on a few-hundred-turn vault and macOS killed the
// process. Per-text iteration keeps peak memory bounded by the
// largest single turn (~1.5MB for our 4000-char cap). The chunked
// rebuilder still calls `embed` with batches, so we get the natural
// yield-between-batches behavior for the HTTP server's sake.
export const embed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
  if (texts.length === 0) {
    return [];
  }
  const extractor = await getEmbedder();
  const vectors: Float32Array[] = [];
  for (const text of texts) {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    vectors.push(padOrTruncate(toFloat32(output.data)));
  }
  return vectors;
};
