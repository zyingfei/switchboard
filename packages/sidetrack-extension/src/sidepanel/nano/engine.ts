// Generation-engine abstraction: ONE interface both on-device backends
// implement, so the title-synthesis eval, the budgeted title-enrichment
// worker, and the on-demand content-enrichment action all drive generation
// through a single seam — independent of WHICH model produced the text.
//
//   - Nano engine   — Chrome's built-in Prompt API (Gemini Nano). Available
//     only when LanguageModel.availability() === 'available'. Zero download
//     cost once the browser has the component.
//   - WebGPU engine — transformers.js text-generation pipeline running
//     onnx-community/gemma-3-1b-it-ONNX on the M-series GPU, with the model
//     files served by the LOCAL companion (never HF). 3.8.1's bundled ORT-web
//     aborts on this model; the extension pins the latest transformers.js
//     (^4), independent of the companion's pinned 3.8.1.
//
// STRICT LOAD GATING (user directive): the WebGPU pipeline is created ONLY by
// an explicit user action — `loadWebGpuEngine({ port })`. Nothing else — not a
// generate() call, not a policy read, not an availability probe — may trigger
// the ~800MB model fetch. Once loaded it lives as a module-level singleton.

import {
  builtinLanguageModel,
  createNanoSession,
  nanoSamplingFor,
  type BuiltinLanguageModel,
} from './titleSynthesis';
import {
  resolveGenerationOptions,
  transformersGenerationArgs,
  type GenerationOptions,
} from './generationOptions';
import {
  routeEnrichmentEngine,
  type ContentLanguage,
  type EngineAvailability,
  type EnrichmentRoute,
} from './language';

// ---------------------------------------------------------------------------
// The one interface.
// ---------------------------------------------------------------------------

export interface GenerationEngine {
  readonly kind: 'nano' | 'webgpu';
  /**
   * Generate from `prompt`. Every decoding field except `maxNewTokens` is
   * optional and defaults to the anti-degeneracy values in
   * generationOptions.ts — an unsafe decoder must not be reachable by
   * forgetting a field at a call site.
   */
  generate: (prompt: string, opts: GenerationOptions) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Output cleanup — the PoC showed the WebGPU model wraps titles in markdown
// ("**title**") and sometimes in quotes; Nano stays cleaner but the same
// cleanup is harmless there. Strip surrounding asterisks/quotes, collapse
// stray inner ** emphasis, trim, and cap. Pure + unit-tested.
//
// The cap is a PARAMETER, not a constant: this cleanup runs on gists too, and
// capping a gist at the 200-char title limit was silently truncating every
// multi-sentence summary mid-word before it was ever saved.
// ---------------------------------------------------------------------------

export const MAX_GENERATED_CHARS = 200;

export const cleanGeneratedText = (raw: string, maxChars: number): string => {
  let text = raw.trim();
  // Strip a leading/trailing run of markdown emphasis / quote chars, then any
  // inner ** emphasis markers the model sprinkles mid-line.
  text = text.replace(/^[*_"'“”‘’\s]+/u, '').replace(/[*_"'“”‘’\s]+$/u, '');
  text = text.replace(/\*\*/gu, '').replace(/__/gu, '');
  text = text.trim();
  return text.slice(0, maxChars);
};

/** Title-shaped cleanup: the same pass capped at the title contract's 200. */
export const cleanGeneratedTitle = (raw: string): string =>
  cleanGeneratedText(raw, MAX_GENERATED_CHARS);

// ---------------------------------------------------------------------------
// Nano engine.
// ---------------------------------------------------------------------------

/**
 * Build a Nano-backed engine when the built-in Prompt API is exposed AND
 * reports 'available' (the model component is present — create() will NOT
 * trigger a multi-GB download). Returns null otherwise. A passive read only;
 * never downloads.
 */
export const nanoEngineIfAvailable = async (
  lm: BuiltinLanguageModel | undefined = builtinLanguageModel(),
): Promise<GenerationEngine | null> => {
  if (lm === undefined) return null;
  let availability: string;
  try {
    availability = await lm.availability();
  } catch {
    return null;
  }
  if (availability !== 'available') return null;
  return {
    kind: 'nano',
    generate: async (prompt, opts) => {
      // Nano's ONLY decoding controls are temperature + topK at create() time
      // (clamped to this device's reported bounds); there is no repetition
      // penalty, no n-gram ban and no token budget on the Prompt API. The
      // caller's validateGeneration() pass is what actually guarantees quality
      // on this engine. See generationOptions.ts.
      const session = await createNanoSession(lm, await nanoSamplingFor(lm, opts));
      try {
        return cleanGeneratedText(
          await session.prompt(prompt),
          resolveGenerationOptions(opts).maxChars,
        );
      } finally {
        session.destroy();
      }
    },
  };
};

// ---------------------------------------------------------------------------
// WebGPU engine (transformers.js) — explicit-load singleton.
// ---------------------------------------------------------------------------

export const WEBGPU_MODEL_ID = 'onnx-community/gemma-3-1b-it-ONNX';
export const WEBGPU_MODEL_REVISION = 'main';

export interface WebGpuLoadProgress {
  /** Which artifact is downloading (model weights, tokenizer, config, …). */
  readonly file: string;
  /** 0–100, best-effort; some phases report only 'ready' without a percent. */
  readonly percent: number;
}

export interface LoadWebGpuOptions {
  /** Companion port — the model host lives at http://127.0.0.1:{port}. */
  readonly port: number;
  readonly onProgress?: (p: WebGpuLoadProgress) => void;
  /**
   * Test seam ONLY: inject a fake pipeline factory so the load path is
   * unit-testable without pulling transformers.js / a GPU. Production callers
   * never pass this — the real dynamic import is used.
   */
  readonly pipelineFactory?: PipelineFactory;
}

// A minimal shape of transformers.js's text-generation pipeline output +
// factory, narrow enough to type our call site without importing the whole lib
// at type-check time (it is loaded dynamically at runtime).
type TextGenerationOutput = ReadonlyArray<{ readonly generated_text?: unknown }>;
export type GeneratedPipeline = (
  input: string,
  opts: Record<string, unknown>,
) => Promise<TextGenerationOutput>;
export type PipelineFactory = (onProgress?: (p: WebGpuLoadProgress) => void) => Promise<{
  readonly generate: GeneratedPipeline;
}>;

let webGpuEngineSingleton: GenerationEngine | null = null;
let webGpuLoadInFlight: Promise<GenerationEngine> | null = null;

/** Whether the WebGPU engine has been explicitly loaded this session. */
export const isWebGpuLoaded = (): boolean => webGpuEngineSingleton !== null;

// --- Observable load status -------------------------------------------------
//
// The Health row owns the load BUTTON, but the Now card has to tell the user
// what the model is doing ("downloading 41%") without owning — or being able to
// start — the load. So the single load funnel below publishes its status at
// module scope and any surface can subscribe. Read-only: subscribing never
// probes and never loads.

export interface WebGpuLoadStatus {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error';
  /** Best-effort download percent while loading; null when not reported. */
  readonly percent: number | null;
  readonly file: string | null;
  readonly error: string | null;
}

let webGpuLoadStatusValue: WebGpuLoadStatus = {
  phase: 'idle',
  percent: null,
  file: null,
  error: null,
};
const webGpuLoadListeners = new Set<() => void>();

const publishWebGpuLoadStatus = (next: WebGpuLoadStatus): void => {
  webGpuLoadStatusValue = next;
  for (const listener of webGpuLoadListeners) listener();
};

/** Current load status — a plain read, safe to call in render. */
export const webGpuLoadStatus = (): WebGpuLoadStatus => webGpuLoadStatusValue;

/** Subscribe to load-status changes; returns the unsubscribe. */
export const subscribeWebGpuLoadStatus = (listener: () => void): (() => void) => {
  webGpuLoadListeners.add(listener);
  return () => {
    webGpuLoadListeners.delete(listener);
  };
};

/** Whether this browser exposes a WebGPU adapter at all (navigator.gpu). A
 * cheap synchronous presence check; the real adapter request happens at load
 * time. Used by the Health row to show an honest "not available" instead of a
 * dead button. */
export const webGpuSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  (navigator as unknown as { gpu?: unknown }).gpu !== undefined &&
  (navigator as unknown as { gpu?: unknown }).gpu !== null;

/**
 * Normalize transformers.js's progress_callback events into our
 * {file, percent} shape. transformers emits { status, file, progress?,
 * loaded?, total? } — 'progress' carries a 0–100 percent; a 'done'/'ready'
 * status carries none.
 */
const normalizeProgress = (raw: unknown): WebGpuLoadProgress | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as {
    status?: unknown;
    file?: unknown;
    name?: unknown;
    progress?: unknown;
    loaded?: unknown;
    total?: unknown;
  };
  const file =
    typeof r.file === 'string' && r.file.length > 0
      ? r.file
      : typeof r.name === 'string'
        ? r.name
        : 'model';
  let percent = 0;
  if (typeof r.progress === 'number') percent = r.progress;
  else if (typeof r.loaded === 'number' && typeof r.total === 'number' && r.total > 0)
    percent = (r.loaded / r.total) * 100;
  else if (r.status === 'done' || r.status === 'ready') percent = 100;
  return { file, percent: Math.max(0, Math.min(100, Math.round(percent))) };
};

/**
 * The real transformers.js pipeline factory. Dynamically imports the lib (kept
 * out of the static graph so the ~MB bundle only loads when the user asks),
 * points env at the LOCAL companion model host, and builds a WebGPU q4
 * text-generation pipeline. The dynamic import string is a runtime constant so
 * bundlers keep it a separate chunk.
 */
const realPipelineFactory =
  (port: number): PipelineFactory =>
  async (onProgress) => {
    const mod = (await import('@huggingface/transformers')) as unknown as {
      pipeline: (
        task: string,
        model: string,
        opts: Record<string, unknown>,
      ) => Promise<GeneratedPipeline>;
      env: {
        allowLocalModels: boolean;
        allowRemoteModels: boolean;
        remoteHost: string;
        remotePathTemplate: string;
        backends?: { onnx?: { wasm?: { wasmPaths?: string } } };
      };
    };
    const { pipeline, env } = mod;
    // Serve model files from the local companion — never HF. UNAUTHENTICATED,
    // HF-layout, long-cache: GET /v1/models/{model}/resolve/{revision}/{file}.
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.remoteHost = `http://127.0.0.1:${String(port)}/v1/models/`;
    env.remotePathTemplate = '{model}/resolve/{revision}/';
    // Load the ORT wasm/jsep glue from the extension's own bundle (public/ort/)
    // so nothing is fetched from a CDN — keeps the zero-outbound guarantee.
    // chrome.runtime is present in the extension page; guarded for the test env.
    try {
      const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } })
        .chrome?.runtime;
      if (runtime?.getURL !== undefined) {
        env.backends ??= {};
        env.backends.onnx ??= {};
        env.backends.onnx.wasm ??= {};
        env.backends.onnx.wasm.wasmPaths = runtime.getURL('ort/');
      }
    } catch {
      // Non-extension context (tests) — leave transformers' default.
    }
    const generate = await pipeline('text-generation', WEBGPU_MODEL_ID, {
      device: 'webgpu',
      dtype: 'q4',
      use_external_data_format: true,
      revision: WEBGPU_MODEL_REVISION,
      progress_callback: (raw: unknown) => {
        const p = normalizeProgress(raw);
        if (p !== null && onProgress !== undefined) onProgress(p);
      },
    });
    return { generate };
  };

/**
 * EXPLICIT load of the WebGPU engine — the ONLY path that fetches the model.
 * Idempotent: concurrent/repeat calls share one in-flight load and reuse the
 * singleton once ready. Throws if this browser has no WebGPU adapter (the
 * caller shows an honest message rather than a spinner that never resolves).
 */
export const loadWebGpuEngine = async ({
  port,
  onProgress,
  pipelineFactory,
}: LoadWebGpuOptions): Promise<GenerationEngine> => {
  if (webGpuEngineSingleton !== null) return webGpuEngineSingleton;
  if (webGpuLoadInFlight !== null) return webGpuLoadInFlight;
  if (pipelineFactory === undefined && !webGpuSupported()) {
    const message = 'WebGPU is not available in this browser.';
    publishWebGpuLoadStatus({ phase: 'error', percent: null, file: null, error: message });
    throw new Error(message);
  }
  const factory = pipelineFactory ?? realPipelineFactory(port);
  publishWebGpuLoadStatus({ phase: 'loading', percent: null, file: null, error: null });
  webGpuLoadInFlight = (async () => {
    try {
      const { generate } = await factory((p) => {
        // Mirror every progress tick into the module-level status so surfaces
        // that did NOT start the load (the Now card) can show it honestly.
        publishWebGpuLoadStatus({
          phase: 'loading',
          percent: p.percent,
          file: p.file,
          error: null,
        });
        onProgress?.(p);
      });
      const engine: GenerationEngine = {
        kind: 'webgpu',
        generate: async (prompt, opts) => {
          // The full anti-degeneracy set: cold sampling + repetition penalty +
          // n-gram ban + a sane token budget. This engine used to run GREEDY
          // with no repetition control at 220 tokens, which is precisely how a
          // 1B q4 model produces "2 224 6 224 6 …" for 61 seconds.
          const out = await generate(prompt, transformersGenerationArgs(opts));
          const first = out[0];
          const text = typeof first?.generated_text === 'string' ? first.generated_text : '';
          return cleanGeneratedText(text, resolveGenerationOptions(opts).maxChars);
        },
      };
      webGpuEngineSingleton = engine;
      publishWebGpuLoadStatus({ phase: 'ready', percent: 100, file: null, error: null });
      return engine;
    } catch (err) {
      publishWebGpuLoadStatus({
        phase: 'error',
        percent: null,
        file: null,
        error: String(err),
      });
      throw err;
    } finally {
      webGpuLoadInFlight = null;
    }
  })();
  return webGpuLoadInFlight;
};

/** Test-only: forget the loaded engine so gating tests start clean. */
export const __resetWebGpuEngineForTest = (): void => {
  webGpuEngineSingleton = null;
  webGpuLoadInFlight = null;
  publishWebGpuLoadStatus({ phase: 'idle', percent: null, file: null, error: null });
};

// ---------------------------------------------------------------------------
// Policy: which engine to use RIGHT NOW, never auto-loading anything.
// ---------------------------------------------------------------------------

export type EngineChoice = 'nano' | 'webgpu' | 'none';

/**
 * Decide the active engine WITHOUT any side effects:
 *   - 'nano'   when the built-in Prompt API is 'available',
 *   - 'webgpu' when the WebGPU engine was EXPLICITLY loaded this session,
 *   - 'none'   otherwise.
 * Nano is preferred (no download, already resident). WebGPU is only ever
 * chosen after an explicit loadWebGpuEngine() — never auto-loaded here.
 */
export const enginePolicy = async (
  lm: BuiltinLanguageModel | undefined = builtinLanguageModel(),
): Promise<EngineChoice> => {
  const nano = await nanoEngineIfAvailable(lm);
  if (nano !== null) return 'nano';
  if (isWebGpuLoaded()) return 'webgpu';
  return 'none';
};

/**
 * Resolve the engine to generate with, honoring the policy and NEVER loading.
 * Returns null when no engine is ready (nano unavailable AND webgpu not
 * explicitly loaded). This is the seam the eval / enrichment paths call —
 * generate() without a prior explicit WebGPU load yields null (no generation),
 * satisfying the "never auto-load" gate.
 */
export const resolveReadyEngine = async (
  lm: BuiltinLanguageModel | undefined = builtinLanguageModel(),
): Promise<GenerationEngine | null> => {
  const nano = await nanoEngineIfAvailable(lm);
  if (nano !== null) return nano;
  if (webGpuEngineSingleton !== null) return webGpuEngineSingleton;
  return null;
};

// ---------------------------------------------------------------------------
// Language-aware routing (see language.ts for the capability rationale).
// ---------------------------------------------------------------------------

/**
 * Snapshot what is ready right now, for the UI to render an honest state. Reads
 * only: `availability()` on the built-in API (passive) plus module state. Never
 * creates a session, never loads the WebGPU model.
 */
export const engineAvailabilitySnapshot = async (
  lm: BuiltinLanguageModel | undefined = builtinLanguageModel(),
): Promise<EngineAvailability> => {
  const status = webGpuLoadStatus();
  let nanoReady = false;
  if (lm !== undefined) {
    try {
      nanoReady = (await lm.availability()) === 'available';
    } catch {
      nanoReady = false;
    }
  }
  return {
    nanoReady,
    webGpuLoaded: isWebGpuLoaded(),
    webGpuLoading: status.phase === 'loading',
    webGpuPercent: status.percent,
    webGpuSupported: webGpuSupported(),
  };
};

export interface RoutedEngine {
  /** The engine to generate with, or null when the route is blocked. */
  readonly engine: GenerationEngine | null;
  /** The routing decision — carries the typed reason when engine is null. */
  readonly route: EnrichmentRoute;
}

/**
 * Resolve the engine for content in `language`, honoring the capability routing
 * (Chinese never reaches Nano) and NEVER loading anything. A blocked route
 * comes back with a typed reason the caller renders instead of failing silently
 * or, worse, generating in the wrong language.
 */
export const resolveEngineForLanguage = async (
  language: ContentLanguage,
  lm: BuiltinLanguageModel | undefined = builtinLanguageModel(),
): Promise<RoutedEngine> => {
  const availability = await engineAvailabilitySnapshot(lm);
  const route = routeEnrichmentEngine(language, availability);
  if (route.engine === 'nano') {
    const nano = await nanoEngineIfAvailable(lm);
    // Defensive: availability flipped between the two passive reads.
    if (nano === null) return { engine: null, route: { engine: null, reason: 'no-engine' } };
    return { engine: nano, route };
  }
  if (route.engine === 'webgpu' && webGpuEngineSingleton !== null) {
    return { engine: webGpuEngineSingleton, route };
  }
  if (route.engine === 'webgpu') {
    return { engine: null, route: { engine: null, reason: 'model-not-loaded' } };
  }
  return { engine: null, route };
};
