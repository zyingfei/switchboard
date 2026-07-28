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
import { transformersGenerationArgs } from './generationOptions';
import {
  routeEnrichmentEngine,
  type ContentLanguage,
  type EngineAvailability,
  type EnrichmentRoute,
} from './language';
import { appleEngineFrom } from './appleEngine';
import { probeAppleService, type AppleServiceInfo } from './appleService';
import {
  cleanGeneratedText,
  outputCharCapOf,
  type GenerationEngine,
} from './generationEngine';
import {
  cachedNanoLimits,
  limitsFor,
  localModelLimits,
  observeNanoSessionLimits,
  type EngineLimits,
} from './engineLimits';
import {
  DEFAULT_LOCAL_MODEL_ID,
  NANO_IDENTITY,
  localModelIdentity,
  localModelSpec,
  readSelectedLocalModelId,
  type EngineIdentity,
  type EngineKind,
  type LocalModelSpec,
  externalDataChunkCount,
} from './modelRegistry';
import { readRemoteConfig, remoteConfigReady, remoteHostOf } from './remoteConfig';
import { remoteEngineFrom } from './remoteEngine';

// ---------------------------------------------------------------------------
// The one interface — defined in generationEngine.ts (so the adapters can
// depend on it without importing this wiring module) and re-exported here so
// every existing `from './engine'` import keeps working.
// ---------------------------------------------------------------------------

export {
  cleanGeneratedText,
  cleanGeneratedTitle,
  MAX_GENERATED_CHARS,
  type GenerationEngine,
} from './generationEngine';

/** The identity to render for an engine, defaulting by kind for bare stubs. */
export const engineIdentityOf = (engine: GenerationEngine): EngineIdentity =>
  engine.identity ??
  (engine.kind === 'nano'
    ? NANO_IDENTITY
    : engine.kind === 'webgpu'
      ? localModelIdentity(localModelSpec(DEFAULT_LOCAL_MODEL_ID))
      : {
          kind: 'remote',
          label: 'remote',
          modelName: 'remote model',
          params: 'provider-side',
          paramsBillions: null,
          quantization: 'unknown',
          approxBytesOnDisk: null,
        });

/** The limits for an engine, defaulting by kind for bare stubs. */
export const engineLimitsOf = (engine: GenerationEngine): EngineLimits =>
  engine.limits ?? limitsFor(engine.kind);

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
    identity: NANO_IDENTITY,
    // The REAL quota once a session has reported it (see the generate() body);
    // the documented constant until then. Reading it here costs nothing — no
    // extra session is created just to ask.
    limits: cachedNanoLimits(),
    generate: async (prompt, opts) => {
      // Nano's ONLY decoding controls are temperature + topK at create() time
      // (clamped to this device's reported bounds); there is no repetition
      // penalty, no n-gram ban and no token budget on the Prompt API. The
      // caller's validateGeneration() pass is what actually guarantees quality
      // on this engine. See generationOptions.ts.
      const session = await createNanoSession(lm, await nanoSamplingFor(lm, opts));
      try {
        // Learn this device's REAL input quota from the session we just had to
        // create anyway (inputQuota / measureInputUsage, both guarded). Memoized
        // after the first success — no extra session, no extra round trip.
        await observeNanoSessionLimits(session);
        return cleanGeneratedText(await session.prompt(prompt), outputCharCapOf(opts));
      } finally {
        session.destroy();
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Remote engine (OPTIONAL, default OFF) — see remoteConfig.ts for the privacy
// contract. This resolver is the ONLY place the panel builds a remote engine.
// ---------------------------------------------------------------------------

/**
 * Build the remote engine if — and only if — the user explicitly enabled it AND
 * supplied a key. Returns null in every other case, including "enabled but no
 * key" and "key stored but never enabled". Reads chrome.storage.local; never
 * makes a network call (no key validation, no model list — those would be
 * outbound traffic the user did not ask for).
 */
export const remoteEngineIfConfigured = async (): Promise<GenerationEngine | null> =>
  remoteEngineFrom(await readRemoteConfig());

// ---------------------------------------------------------------------------
// Apple Foundation Models — on-device, through a local service.
// ---------------------------------------------------------------------------

/**
 * Probe result cache. The probe is a loopback GET that answers in milliseconds
 * or not at all, but routing asks for availability on every enrichment, and
 * hammering a port on every keystroke is rude even when it is local.
 *
 * Cached for APPLE_PROBE_TTL_MS, NOT for the session: the user can start or
 * stop `apfel --serve` at any moment, and an engine that stayed "ready" for an
 * hour after the service died would fail every generation with a confusing
 * error instead of quietly routing elsewhere.
 */
export const APPLE_PROBE_TTL_MS = 30_000;

let appleProbeCache: { at: number; info: AppleServiceInfo } | null = null;

/**
 * Probe override. WHY THIS EXISTS, and why the default is "absent" under test:
 *
 * The real probe is a GET to a loopback port. That makes a UNIT TEST'S RESULT
 * DEPEND ON WHETHER A DAEMON HAPPENS TO BE RUNNING ON THE DEVELOPER'S MACHINE —
 * caught for real on 2026-07-28, when five unrelated engine/remote tests started
 * failing with "expected 'apple' to be 'none'" purely because `apfel --serve`
 * was up in another terminal. CI would have been green, which is worse: the
 * suite would be lying about what it verified.
 *
 * So tests/setup.ts installs an ABSENT probe globally, making hermeticity the
 * default and any Apple-available test an explicit, visible opt-in.
 */
let appleProbeOverride: (() => Promise<AppleServiceInfo>) | null = null;

/**
 * Replace the probe (tests only). Pass null to restore the real one.
 * Always clears the cache, so an override can never be shadowed by a result
 * captured before it was installed.
 */
export const setAppleProbeForTest = (
  probe: (() => Promise<AppleServiceInfo>) | null,
): void => {
  appleProbeOverride = probe;
  appleProbeCache = null;
};

/** Drop the cached probe — test seam, and the hook for a manual Health re-check. */
export const resetAppleProbeCache = (): void => {
  appleProbeCache = null;
};

/**
 * Current Apple-service status, cached. Never throws, never starts anything.
 * `force` bypasses the cache for an explicit user-initiated re-check.
 */
export const appleServiceStatus = async (
  force = false,
  now: number = Date.now(),
): Promise<AppleServiceInfo> => {
  if (!force && appleProbeCache !== null && now - appleProbeCache.at < APPLE_PROBE_TTL_MS) {
    return appleProbeCache.info;
  }
  const info = await (appleProbeOverride ?? probeAppleService)();
  appleProbeCache = { at: now, info };
  return info;
};

/** The Apple engine when the local service is up, else null. */
export const appleEngineIfAvailable = async (): Promise<GenerationEngine | null> =>
  appleEngineFrom(await appleServiceStatus());

// ---------------------------------------------------------------------------
// WebGPU engine (transformers.js) — explicit-load singleton.
// ---------------------------------------------------------------------------

/**
 * The DEFAULT local model. The full selectable set (and the declared parameter
 * count / quantization / on-disk size of each) lives in modelRegistry.ts — the
 * id is no longer hardcoded here because a 1B-vs-3.25B comparison that does not
 * say so is misleading, and the fix is letting the user pick a size-matched
 * model. Kept exported under the old name so existing imports keep resolving.
 */
export const WEBGPU_MODEL_ID = DEFAULT_LOCAL_MODEL_ID;
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
  /**
   * Which registry model to load. Absent → the stored selection, else the
   * default. Selecting a model never downloads anything; THIS call does, and
   * only this call.
   */
  readonly modelId?: string;
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
let webGpuLoadedSpec: LocalModelSpec | null = null;

/** Whether the WebGPU engine has been explicitly loaded this session. */
export const isWebGpuLoaded = (): boolean => webGpuEngineSingleton !== null;

/** WHICH local model is loaded, or null when none is. Read-only. */
export const loadedLocalModel = (): LocalModelSpec | null => webGpuLoadedSpec;

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
  (port: number, spec: LocalModelSpec): PipelineFactory =>
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
    const generate = await pipeline('text-generation', spec.id, {
      device: 'webgpu',
      dtype: spec.quantization,
      // NOT `true`: that means exactly ONE external-data chunk (transformers.js
      // types it boolean|number). A model whose graph is split across more
      // shards needs the COUNT, or the runtime preloads only the first and
      // fails deserializing tensors that live in the rest.
      use_external_data_format: externalDataChunkCount(spec),
      revision: spec.revision,
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
  modelId,
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
  const spec = localModelSpec(modelId ?? (await readSelectedLocalModelId()));
  const factory = pipelineFactory ?? realPipelineFactory(port, spec);
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
        identity: localModelIdentity(spec),
        limits: localModelLimits(spec),
        generate: async (prompt, opts) => {
          // CHAT MESSAGES, not a raw string. gemma-3-1b-IT is
          // instruction-tuned: handed a bare string, a text-generation
          // pipeline does pure CONTINUATION — the model keeps writing the
          // prompt instead of answering it. That is exactly what the live
          // corpus showed (2026-07-27): a saved gist that read "The system
          // will use only information from the text provided. If the text
          // cannot be summarized accurately, please skip. # Content: # ---"
          // — our own instructions, echoed back and then looped. The
          // original PoC used chat messages and produced clean output; the
          // regression happened on the way from PoC to product.
          //
          // With a message array transformers.js applies the model's chat
          // template and returns ONLY the assistant turn, so there is a real
          // answer boundary and no instruction echo. The response shape
          // differs too: generated_text is the message ARRAY, so the reply is
          // its last entry's content (string form kept as a fallback for
          // pipelines that still flatten).
          let out;
          try {
            out = await generate(
              [{ role: 'user', content: prompt }] as never,
              transformersGenerationArgs(opts),
            );
          } catch (err) {
            // A FATAL BACKEND ERROR POISONS THE SESSION, so it must not leave
            // the engine sitting there looking ready.
            //
            // Measured 2026-07-28: one over-long chunk produced
            //   "failed to call OrtRun() ... buffer_manager.cc Download(...)"
            // and from then on EVERY subsequent generation failed the same way
            // — including documents that had just succeeded moments earlier.
            // The WebGPU context is gone, but the singleton still answers
            // isWebGpuLoaded(), so routing kept choosing it and the user saw
            // the local model "stop working" for the rest of the session with
            // no explanation and no way back short of reopening the panel.
            //
            // Dropping the singleton makes the next attempt route elsewhere
            // and makes the Health button able to load a fresh context, which
            // is the only actual recovery.
            if (isFatalBackendError(err)) unloadWebGpuEngine(String(err));
            throw err;
          }
          const first = out[0];
          const raw = first?.generated_text;
          const text =
            typeof raw === 'string'
              ? raw
              : Array.isArray(raw)
                ? String((raw[raw.length - 1] as { content?: unknown } | undefined)?.content ?? '')
                : '';
          return cleanGeneratedText(text, outputCharCapOf(opts));
        },
      };
      webGpuEngineSingleton = engine;
      webGpuLoadedSpec = spec;
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

/**
 * Errors that mean the WebGPU CONTEXT itself is dead, not that this one
 * generation went wrong.
 *
 * All three shapes were observed live on 2026-07-28 driving real vault
 * documents through the shipped chunker:
 *
 *   failed to call OrtRun() ... webgpu/buffer_manager.cc Download(...)
 *   RuntimeError: memory access out of bounds
 *   RuntimeError: null function
 *
 * Matched on message text because that is genuinely all ORT gives us — there
 * is no typed error class to narrow on. Deliberately NARROW: a mis-match here
 * unloads a perfectly good engine and costs the user a reload, so it only
 * catches the phrases that have actually been seen to be terminal.
 */
export const isFatalBackendError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /failed to call OrtRun/iu.test(message) ||
    /memory access out of bounds/iu.test(message) ||
    /null function/iu.test(message) ||
    /device is lost/iu.test(message)
  );
};

/**
 * Drop the loaded engine after its backend died. Not a user action and not an
 * error path of its own — it is how the session becomes recoverable. The load
 * status goes to 'error' with the reason so Health shows what happened instead
 * of quietly reverting to "not loaded".
 */
export const unloadWebGpuEngine = (reason: string): void => {
  webGpuEngineSingleton = null;
  webGpuLoadedSpec = null;
  publishWebGpuLoadStatus({
    phase: 'error',
    percent: null,
    file: null,
    error: `the local model's GPU context was lost and it has been unloaded — load it again to retry (${reason.slice(0, 160)})`,
  });
};

/** Test-only: forget the loaded engine so gating tests start clean. */
export const __resetWebGpuEngineForTest = (): void => {
  webGpuEngineSingleton = null;
  webGpuLoadInFlight = null;
  webGpuLoadedSpec = null;
  publishWebGpuLoadStatus({ phase: 'idle', percent: null, file: null, error: null });
};

// ---------------------------------------------------------------------------
// Policy: which engine to use RIGHT NOW, never auto-loading anything.
// ---------------------------------------------------------------------------

export type EngineChoice = EngineKind | 'none';

/**
 * Decide the active engine WITHOUT any side effects:
 *   - 'nano'   when the built-in Prompt API is 'available',
 *   - 'webgpu' when the WebGPU engine was EXPLICITLY loaded this session,
 *   - 'remote' when the user explicitly enabled the remote engine WITH a key,
 *   - 'none'   otherwise.
 * Local-first precedence, always: nano (no download, already resident) beats
 * the loaded local model, which beats the remote engine — the only one that
 * sends text off the device. WebGPU is only ever chosen after an explicit
 * loadWebGpuEngine(); remote is only ever chosen after an explicit opt-in.
 */
export const enginePolicy = async (
  lm: BuiltinLanguageModel | undefined = builtinLanguageModel(),
): Promise<EngineChoice> => {
  const nano = await nanoEngineIfAvailable(lm);
  if (nano !== null) return 'nano';
  if ((await appleServiceStatus()).available) return 'apple';
  if (isWebGpuLoaded()) return 'webgpu';
  if (remoteConfigReady(await readRemoteConfig())) return 'remote';
  return 'none';
};

/**
 * Resolve the engine to generate with, honoring the policy and NEVER loading.
 * Returns null when no engine is ready (nano unavailable, webgpu not explicitly
 * loaded, remote not explicitly enabled with a key). This is the seam the eval /
 * enrichment paths call — generate() without a prior explicit WebGPU load yields
 * null (no generation), satisfying the "never auto-load" gate.
 */
export const resolveReadyEngine = async (
  lm: BuiltinLanguageModel | undefined = builtinLanguageModel(),
): Promise<GenerationEngine | null> => {
  const nano = await nanoEngineIfAvailable(lm);
  if (nano !== null) return nano;
  const apple = await appleEngineIfAvailable();
  if (apple !== null) return apple;
  if (webGpuEngineSingleton !== null) return webGpuEngineSingleton;
  return await remoteEngineIfConfigured();
};

/**
 * EVERY engine that could run RIGHT NOW, local-first, for the comparison
 * surface. Reads only — no probe starts a download and no remote request is
 * made. An engine absent from this list simply cannot run this session.
 */
export const readyEngines = async (
  lm: BuiltinLanguageModel | undefined = builtinLanguageModel(),
): Promise<readonly GenerationEngine[]> => {
  const engines: GenerationEngine[] = [];
  const nano = await nanoEngineIfAvailable(lm);
  if (nano !== null) engines.push(nano);
  if (webGpuEngineSingleton !== null) engines.push(webGpuEngineSingleton);
  const remote = await remoteEngineIfConfigured();
  if (remote !== null) engines.push(remote);
  return engines;
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
  // Remote readiness is a STORAGE read, never a network probe: asking the
  // provider whether the key works would itself be outbound traffic.
  const remote = await readRemoteConfig();
  // Apple readiness IS a probe, and that is fine precisely because it is the
  // opposite of the remote case: a GET to a loopback port, which cannot leave
  // the machine and cannot be observed by anyone. It is cached (TTL above) so
  // a re-render does not re-ask.
  const apple = await appleServiceStatus();
  return {
    nanoReady,
    appleReady: apple.available,
    webGpuLoaded: isWebGpuLoaded(),
    webGpuLoading: status.phase === 'loading',
    webGpuPercent: status.percent,
    webGpuSupported: webGpuSupported(),
    remoteReady: remoteConfigReady(remote),
    remoteHost: remoteConfigReady(remote) ? remoteHostOf(remote.baseUrl) : null,
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
  if (route.engine === 'apple') {
    // Re-probe rather than trusting the snapshot: `apfel --serve` can be
    // stopped between the availability read and the click, and a stale "ready"
    // must degrade to a routed fallback, never to a failed generation.
    const apple = await appleEngineIfAvailable();
    if (apple !== null) return { engine: apple, route };
    // The service went away. Fall through to whatever else is loaded rather
    // than reporting no-engine — WebGPU may well be sitting right there.
    if (webGpuEngineSingleton !== null) {
      return { engine: webGpuEngineSingleton, route: { engine: 'webgpu' } };
    }
    return { engine: null, route: { engine: null, reason: 'model-not-loaded' } };
  }
  if (route.engine === 'webgpu' && webGpuEngineSingleton !== null) {
    return { engine: webGpuEngineSingleton, route };
  }
  if (route.engine === 'webgpu') {
    return { engine: null, route: { engine: null, reason: 'model-not-loaded' } };
  }
  if (route.engine === 'remote') {
    // Re-read the config rather than trusting the snapshot: the user may have
    // cleared the key between the probe and the click, and a stale "ready" must
    // never turn into an outbound request.
    const remote = await remoteEngineIfConfigured();
    if (remote === null) return { engine: null, route: { engine: null, reason: 'no-engine' } };
    return { engine: remote, route };
  }
  return { engine: null, route };
};
