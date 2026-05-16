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
//
// MODEL_ID is the *identity string* the lifecycle compares against
// the on-disk index header to detect stale embeddings — separate
// from HF_MODEL which is what we actually pass to the pipeline.
// Suffixing the identity (e.g. with the prefix variant) means a
// change to embedding behavior triggers an auto-rebuild even
// though the underlying HF model didn't change.
import { isOfflineMode, resolveModelsDir } from './modelCache.js';
import { RECALL_MODEL, RECALL_MODEL_ID } from './modelManifest.js';

const HF_MODEL = RECALL_MODEL.modelId;
// Identity string the lifecycle compares against the on-disk index.
// Bumping `RECALL_MODEL.revision` in modelManifest.ts marks every
// existing entry stale and triggers a background rebuild.
export const MODEL_ID = RECALL_MODEL_ID;

type FeatureExtractor = (
  text: string,
  options: { readonly pooling: 'mean'; readonly normalize: true },
) => Promise<{ readonly data: ArrayLike<number> }>;

// Thrown by getEmbedder() when the loader cannot reach a usable
// model file. Most often this is the offline + empty-cache case
// (`SIDETRACK_OFFLINE_MODELS=1` / `--offline-models` with no
// pre-warmed cache), but it also catches transient HF / disk
// failures so the recall query route can map them to a typed
// 503 RECALL_MODEL_MISSING instead of a generic 500.
export class RecallModelMissingError extends Error {
  readonly code = 'RECALL_MODEL_MISSING' as const;
  constructor(
    message: string,
    readonly offline: boolean,
    readonly cacheDir: string,
  ) {
    super(message);
    this.name = 'RecallModelMissingError';
  }
}

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
    const offlineAtLoad = isOfflineMode();
    const cacheDirAtLoad = resolveModelsDir();
    extractorPromise = (async () => {
      const module = await import('@huggingface/transformers');
      const env = (module as { readonly env?: Record<string, unknown> }).env;
      if (env !== undefined) {
        // In offline mode we deny remote fetches; the embedder
        // throws if the cache is empty and the lifecycle reports
        // RECALL_MODEL_MISSING. In normal mode we allow downloads.
        env['allowRemoteModels'] = !offlineAtLoad;
        env['allowLocalModels'] = false;
        env['useFSCache'] = true;
        // Sidetrack-managed model directory. The default still
        // honors HF_HOME / HF_HUB_CACHE if set, but we point
        // transformers.js at the product-owned tree so packaging
        // can prewarm + ship a self-contained app.
        env['cacheDir'] = cacheDirAtLoad;
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
      // Pin the HF revision at load time so the runtime artifact
      // matches what the manifest claims. transformers.js accepts
      // `revision` (sha or branch) and uses it both for download and
      // the on-disk cache key — without this, `MODEL_ID` would say
      // "rev=761b…" but the loader would fetch whatever HEAD on the
      // default branch resolves to.
      const revision = RECALL_MODEL.revision;
      for (const dtype of dtypeCandidates) {
        try {
          const pipe = (await module.pipeline('feature-extraction', HF_MODEL, {
            device: 'cpu',
            dtype,
            revision,
          } as Parameters<typeof module.pipeline>[2])) as unknown as FeatureExtractor;
          resolvedDevice = 'cpu';
          resolvedAccelerator = detectAccelerator();
          log(
            `[recall] loaded embedding model ${MODEL_ID} (cpu/${resolvedAccelerator}/${dtype}/rev=${revision.slice(0, 7)}) in ${String(Math.round(performance.now() - started))}ms`,
          );
          return pipe;
        } catch (error) {
          errors.push(
            `${dtype}: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`,
          );
        }
      }
      // No dtype loaded. In offline mode this almost always means
      // the cache is empty (or partially-warmed for the wrong dtype
      // set), so surface a typed RecallModelMissingError that the
      // HTTP layer can map to 503 RECALL_MODEL_MISSING. We also use
      // it for non-offline failures whose error text suggests the
      // model is the missing piece — broader than ENOENT because
      // transformers.js wraps that in a longer message.
      const joined = errors.join(' | ');
      const looksLikeModelMissing =
        offlineAtLoad ||
        /no such file|ENOENT|Could not locate|failed to fetch|Could not load model|404/i.test(
          joined,
        );
      if (looksLikeModelMissing) {
        // Reset the cached promise so a later call (e.g. after the
        // user runs `models ensure` to pre-warm the cache) gets a
        // fresh attempt instead of replaying the failure forever.
        extractorPromise = undefined;
        throw new RecallModelMissingError(
          `[recall] embedding model ${MODEL_ID} is not available (offline=${String(offlineAtLoad)}, cacheDir=${cacheDirAtLoad}). Tried: ${joined}`,
          offlineAtLoad,
          cacheDirAtLoad,
        );
      }
      throw new Error(`[recall] could not load ${MODEL_ID} on any dtype. Tried: ${joined}`);
    })();
  }
  try {
    return await extractorPromise;
  } catch (error) {
    // Same reset — a one-shot failure shouldn't poison every later
    // call. The retry contract: the next `getEmbedder()` call after
    // a model-missing failure restarts the loader.
    if (error instanceof RecallModelMissingError) {
      extractorPromise = undefined;
    }
    throw error;
  }
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

// E5 family models (current MODEL_ID is multilingual-e5-small)
// require task-specific prefixes — feeding raw text yields collapsed
// cosine scores (~0.06 even between obviously-similar items).
// "query: " is the recommended prefix for symmetric text-text
// similarity which is what we do (thread-thread / selection-thread
// search), so we prepend it on every embedded string. Non-E5 models
// will simply prepend "query: " as part of the input — harmless
// at the cost of ~3 tokens of extra input. Switch the prefix to ""
// here if a future model swap doesn't want it.
const E5_PREFIX = 'query: ';

// We embed one text per pipeline call rather than passing the whole
// batch as a single tensor. The all-at-once path used to run with
// @xenova/transformers allocated a [batch, seq, hidden] tensor that
// peaked over 1GB on a few-hundred-turn vault and macOS killed the
// process. Per-text iteration keeps peak memory bounded by the
// largest single turn (~1.5MB for our 4000-char cap). The chunked
// rebuilder still calls `embed` with batches, so we get the natural
// yield-between-batches behavior for the HTTP server's sake.
// Test-only deterministic embedder. Activated when the env var
// `SIDETRACK_TEST_EMBEDDER=1` is set (the playwright fixture sets
// this on the spawned companion). Avoids loading the 100+MB HF
// model in CI / local test runs while still giving recall a real
// vector to index — the lexical (MiniSearch) side of the hybrid
// ranker carries the test signal; vectors are deterministic so
// the index file is still byte-stable across reruns.
const isTestEmbedderEnabled = (): boolean =>
  typeof process !== 'undefined' && process.env['SIDETRACK_TEST_EMBEDDER'] === '1';

const normalizeTestText = (text: string): string =>
  text.replace(/^(query|passage):\s*/iu, '').toLowerCase();

const testTokens = (text: string): readonly string[] =>
  normalizeTestText(text)
    .split(/[^a-z0-9_:-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

const hashToken = (token: string): number => {
  let h = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    h ^= token.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const testEvalClusterIndex = (token: string): number | null => {
  if (token === 'sidetrack_eval_postgres') return 0;
  if (token === 'sidetrack_eval_kubernetes') return 1;
  if (token === 'sidetrack_eval_negative') return 2;
  return null;
};

const testEmbed = (text: string): Float32Array => {
  // Deterministic test vectors with a small semantic affordance:
  // `sidetrack_eval_*` tokens map to fixed axes so the work-graph
  // eval pack can create predictable cosine neighborhoods. All other
  // tokens add low-weight hashed dimensions to keep same input → same
  // output without making arbitrary titles accidentally semantic.
  const v = new Float32Array(384);
  const tokens = testTokens(text);
  for (const token of tokens.length === 0 ? ['empty'] : tokens) {
    const clusterIndex = testEvalClusterIndex(token);
    if (clusterIndex !== null) {
      v[clusterIndex] = (v[clusterIndex] ?? 0) + 8;
      continue;
    }
    const hash = hashToken(token);
    const index = 16 + (hash % (384 - 16));
    const sign = (hash & 1) === 0 ? 1 : -1;
    v[index] = (v[index] ?? 0) + sign * 0.25;
  }
  // L2 normalize (e5 outputs are normalized; tests rely on cosine
  // similarity behaving sanely).
  let norm = 0;
  for (let i = 0; i < 384; i += 1) norm += (v[i] ?? 0) * (v[i] ?? 0);
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < 384; i += 1) v[i] = (v[i] ?? 0) * inv;
  return v;
};

// Override hook: when set, all production embed() calls dispatch
// to this function instead of running ONNX in-process. The runtime
// installs the embedder-sidecar client here so the recall rebuild,
// recall ingestor, and visit-similarity producer all route through
// the child process automatically. Test embedder bypasses the
// override — the deterministic embedder is sync and the child
// overhead is wasted on test inputs.
type EmbedFn = (texts: readonly string[]) => Promise<readonly Float32Array[]>;
let embedderOverride: EmbedFn | undefined;
export const setEmbedderOverride = (fn: EmbedFn | undefined): void => {
  embedderOverride = fn;
};

export const embed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
  if (texts.length === 0) {
    return [];
  }
  if (isTestEmbedderEnabled()) {
    return texts.map(testEmbed);
  }
  if (embedderOverride !== undefined) {
    return embedderOverride(texts);
  }
  const extractor = await getEmbedder();
  const vectors: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i]!;
    const output = await extractor(`${E5_PREFIX}${text}`, {
      pooling: 'mean',
      normalize: true,
    });
    vectors.push(padOrTruncate(toFloat32(output.data)));
    // Per-text yield so the event loop can accept HTTP requests
    // (especially /v1/status) between ONNX inferences. transformers
    // .js + onnxruntime-node call into native code; the C++ inference
    // runs in one shot per `extractor(text)` call (~30–50 ms on
    // Apple Silicon with Accelerate). Without this yield, a 16-text
    // batch is one 700 ms main-thread block — long enough for
    // /v1/status to time out at the panel's poll window. Yielding
    // every text turns the block into 16 × ~50 ms ticks with idle
    // slots in between; HTTP accept resumes immediately.
    //
    // Skip the trailing yield: the caller adds its own inter-batch
    // yield and a redundant setImmediate just delays completion by
    // one extra tick.
    if (i < texts.length - 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  return vectors;
};
