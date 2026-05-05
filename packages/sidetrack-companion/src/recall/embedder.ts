import { performance } from 'node:perf_hooks';

import { INDEX_DIM } from './indexFile.js';

// Switched from `@xenova/transformers` (wasm-only, deprecated) to
// `@huggingface/transformers` so we can run ONNX on the native Node
// runtime via `device: 'cpu'`. On Apple Silicon that path uses
// onnxruntime-node + Apple Accelerate — order-of-magnitude faster
// and lower-peak-memory than wasm. The PoC at
// `poc/recall-vector/src/recall/embedder.ts` validated this and
// produced the benchmarks in `poc/recall-vector/README.md`.
export const MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';

type FeatureExtractor = (
  text: string,
  options: { readonly pooling: 'mean'; readonly normalize: true },
) => Promise<{ readonly data: ArrayLike<number> }>;

let extractorPromise: Promise<FeatureExtractor> | undefined;

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
      // Apple Accelerate. If that fails (e.g. older Linux without
      // the onnxruntime-node binary) we fall back to the wasm path.
      try {
        const pipe = (await module.pipeline('feature-extraction', MODEL_ID, {
          device: 'cpu',
        })) as unknown as FeatureExtractor;
        log(
          `[recall] loaded embedding model ${MODEL_ID} (cpu) in ${String(Math.round(performance.now() - started))}ms`,
        );
        return pipe;
      } catch (cpuError) {
        log(
          `[recall] cpu device unavailable (${cpuError instanceof Error ? cpuError.message : 'unknown'}), falling back to wasm`,
        );
        const pipe = (await module.pipeline('feature-extraction', MODEL_ID, {
          device: 'wasm',
        })) as unknown as FeatureExtractor;
        log(
          `[recall] loaded embedding model ${MODEL_ID} (wasm) in ${String(Math.round(performance.now() - started))}ms`,
        );
        return pipe;
      }
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
