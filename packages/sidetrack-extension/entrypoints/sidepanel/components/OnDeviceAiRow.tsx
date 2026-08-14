import { useCallback, useEffect, useRef, useState } from 'react';

import {
  builtinLanguageModel,
  TITLE_PROMPT_PREFIX,
} from '../../../src/sidepanel/nano/titleSynthesis';
import {
  runTitleEnrichment,
  selectJunkTitledThreads,
  type TitleEnrichmentStats,
} from '../../../src/sidepanel/nano/enrichmentWorker';
import {
  isWebGpuLoaded,
  appleServiceStatus,
  loadWebGpuEngine,
  readyEngines,
  resolveReadyEngine,
  webGpuSupported,
  type WebGpuLoadProgress,
} from '../../../src/sidepanel/nano/engine';
import {
  compareEngines,
  compareStatusCopy,
  type CompareOutcome,
} from '../../../src/sidepanel/nano/compareEngines';
import {
  formatEngineLimits,
  formatReduction,
  limitsFor,
  probeNanoLimits,
} from '../../../src/sidepanel/nano/engineLimits';
import {
  DEFAULT_LOCAL_MODEL_ID,
  LOCAL_MODELS,
  localModelSpec,
  readSelectedLocalModelId,
  writeSelectedLocalModelId,
} from '../../../src/sidepanel/nano/modelRegistry';
import { formatBytes } from '../../../src/util/bytes';
import {
  downloadButtonLabel,
  fetchProgressLabel,
  isNotCachedError,
  notCachedMessage,
  probeModelCached,
  readModelFetchStatus,
  startModelFetch,
  type ModelFetchStatus,
} from '../../../src/sidepanel/nano/modelFetch';
import {
  readRemoteConfig,
  remoteConfigReady,
  remoteHostOf,
  remotePrivacyDetail,
  remotePrivacyMarker,
} from '../../../src/sidepanel/nano/remoteConfig';
import { RemoteEngineRow } from './RemoteEngineRow';
import { TITLE_GENERATION } from '../../../src/sidepanel/nano/generationOptions';
import { detectContentLanguage } from '../../../src/sidepanel/nano/language';
import {
  formatScores,
  scoreGeneration,
  type GenerationScores,
} from '../../../src/sidepanel/nano/scoreGeneration';
import {
  validateGeneration,
  type GenerationRejectionReason,
} from '../../../src/sidepanel/nano/validateGeneration';

// On-device AI (Gemini Nano / Chrome built-in Prompt API) availability row
// for the Health panel's Experiments drill.
//
// This is a BROWSER capability, not a companion candidate lane — the panel
// probes its own extension context (the Prompt API is exposed to extension
// pages on Chrome 138+) and reports what it finds. PoC evidence
// (poc/nano-title-synthesis/README.md): the API surface exists in the test
// browser but Chrome for Testing cannot deliver the model component; regular
// Chrome can. This row makes the per-browser truth visible so the title-
// synthesis quality gate can run where the model actually lands.
//
// The multi-GB model download starts ONLY from the explicit button —
// availability() is a passive read; create() is the download trigger and is
// never called without user intent.
//
// Session settings, the title prompt, junk selection, and the budgeted
// persisting worker live in ../../../../src/sidepanel/nano/* so the
// observe-only eval below and the "Enrich titles" run share one synthesis
// path.

export type OnDeviceAiState =
  | 'no-api'
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available'
  | 'error';

const STATE_COPY: Record<OnDeviceAiState, string> = {
  'no-api': 'not exposed by this browser',
  unavailable: 'this device/browser cannot run the model',
  downloadable: 'model not downloaded yet',
  downloading: 'model downloading…',
  available: 'ready',
  error: 'probe failed',
};

// ---- title-synthesis eval (the PoC quality gate, run where the model
// actually exists — poc/nano-title-synthesis/README.md) -------------------
//
// Observe-only: reads junk-titled threads from the companion, titles them
// with Nano ON-DEVICE, and renders before→after + latency for human
// judgment. No writes anywhere; nothing feeds serving. Junk selection is
// STRUCTURAL (empty / URL-shaped / verbatim-recurring across ≥3 threads) —
// no vocabulary lists.

const EVAL_MAX_ITEMS = 8;
const EVAL_MARKDOWN_CHARS = 2200;
// The comparison feeds every engine the SAME document. It is deliberately NOT
// truncated to the eval's 2200 chars: each engine reduces the document to its
// OWN input cap through the chunking path, and the row reports the reduction —
// that difference is part of what is being compared.
const COMPARE_MARKDOWN_CHARS = 20_000;
/** A document thinner than this cannot discriminate between two engines. */
const COMPARE_MIN_CHARS = 400;
// The budgeted enrichment run titles up to this many junk-titled threads per
// click and PERSISTS them (unlike the observe-only eval above).
const ENRICH_BUDGET = 10;
// How often the row asks the companion how its download is going. A multi-GB
// transfer is minutes long, so a slow poll is plenty — and each poll is a
// loopback GET of a tiny JSON body.
const MODEL_FETCH_POLL_MS = 1500;

export interface TitleEvalResult {
  readonly threadId: string;
  readonly before: string;
  readonly after: string;
  readonly ms: number;
  /**
   * Deterministic quality signals for `after`, measured against the source
   * markdown (scoreGeneration.ts). Null for rows that never generated (thin
   * content, engine error). Observe-only — the eval still writes nothing.
   */
  readonly scores: GenerationScores | null;
  /**
   * What the write-path validator WOULD have done with this output. Null means
   * it would have been accepted. This is the number the user asked for: quality
   * judged numerically, not by eyeball.
   */
  readonly rejection: GenerationRejectionReason | null;
}

export interface OnDeviceAiRowProps {
  readonly companionPort?: number | null;
  readonly bridgeKey?: string | null;
}

export function OnDeviceAiRow({ companionPort, bridgeKey }: OnDeviceAiRowProps = {}) {
  const [state, setState] = useState<OnDeviceAiState>('no-api');
  const [progress, setProgress] = useState<number | null>(null);
  const [kicked, setKicked] = useState(false);
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalResults, setEvalResults] = useState<readonly TitleEvalResult[] | null>(null);
  const [evalNote, setEvalNote] = useState<string | null>(null);
  const [enrichRunning, setEnrichRunning] = useState(false);
  const [enrichStats, setEnrichStats] = useState<TitleEnrichmentStats | null>(null);
  const [enrichNote, setEnrichNote] = useState<string | null>(null);
  // WebGPU (transformers.js) fallback engine — used when Nano is NOT
  // 'available'. STRICT: the ~800MB model is fetched ONLY by the explicit
  // "Load local model" button below (loadWebGpuEngine); never as a side effect.
  // Seeded from the module singleton: the engine outlives this row (the Health
  // panel is opened and closed repeatedly), so a model loaded earlier this
  // session must read "ready" here instead of re-offering the ~800MB load.
  const [webGpuState, setWebGpuState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    isWebGpuLoaded() ? 'ready' : 'idle',
  );
  const [webGpuProgress, setWebGpuProgress] = useState<WebGpuLoadProgress | null>(null);
  const [webGpuError, setWebGpuError] = useState<string | null>(null);
  // WHICH local model the load button will fetch. Selecting is free — it writes
  // a preference and downloads nothing (modelRegistry.ts).
  const [localModelId, setLocalModelId] = useState<string>(DEFAULT_LOCAL_MODEL_ID);
  // Is the SELECTED model actually on the companion? Until this landed, the row
  // offered a load for models the companion had never heard of and the click
  // died on transformers.js' raw "Could not locate file: http://127.0.0.1:…".
  // 'unknown' before the probe answers; 'missing' swaps the load button for the
  // download that would make the load possible.
  const [cacheState, setCacheState] = useState<'unknown' | 'cached' | 'missing'>('unknown');
  const [fetchStatus, setFetchStatus] = useState<ModelFetchStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Bumped whenever the cache answer may have changed (download finished), so
  // the probe below re-runs without the user reopening the panel.
  const [cacheNonce, setCacheNonce] = useState(0);
  // The optional remote engine's armed state + destination, for the privacy
  // marker and the engine-precedence label. A storage read, never a network one.
  const [remoteArmed, setRemoteArmed] = useState(false);
  const [remoteHost, setRemoteHost] = useState<string | null>(null);
  const [remoteNonce, setRemoteNonce] = useState(0);
  // Comparative generation — observe-only, like the eval above it.
  const [compareRunning, setCompareRunning] = useState(false);
  const [compareOutcome, setCompareOutcome] = useState<CompareOutcome | null>(null);
  const [compareNote, setCompareNote] = useState<string | null>(null);
  // Apple on-device service availability. Probed once per mount (the probe
  // has its own TTL cache); without this the Experiments drill contradicted
  // the Now card — "Apple ready" there, "cannot run the model" here.
  const [appleReady, setAppleReady] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    void appleServiceStatus()
      .then((info) => {
        if (!cancelled) setAppleReady(info.available);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const probe = useCallback(async (): Promise<void> => {
    const lm = builtinLanguageModel();
    if (lm === undefined) {
      setState('no-api');
      return;
    }
    try {
      const availability = await lm.availability();
      if (!mountedRef.current) return;
      setState(
        availability === 'available' ||
          availability === 'downloadable' ||
          availability === 'downloading' ||
          availability === 'unavailable'
          ? availability
          : 'error',
      );
    } catch {
      if (mountedRef.current) setState('error');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void probe();
    return () => {
      mountedRef.current = false;
    };
  }, [probe]);

  // Stored local-model selection. A read; never a load.
  useEffect(() => {
    void (async () => {
      const stored = await readSelectedLocalModelId();
      if (mountedRef.current) setLocalModelId(stored);
    })();
  }, []);

  // Remote-engine armed state. Re-read whenever the config block reports a
  // change, so the marker and the precedence label never lag the setting.
  useEffect(() => {
    void (async () => {
      const config = await readRemoteConfig();
      if (!mountedRef.current) return;
      const armed = remoteConfigReady(config);
      setRemoteArmed(armed);
      setRemoteHost(armed ? remoteHostOf(config.baseUrl) : null);
    })();
  }, [remoteNonce]);

  // While a download is in flight, refresh the availability read on a slow
  // cadence so the row converges to 'available' without a manual reopen.
  useEffect(() => {
    if (state !== 'downloading') return undefined;
    const timer = window.setInterval(() => {
      void probe();
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [state, probe]);

  const startDownload = useCallback((): void => {
    const lm = builtinLanguageModel();
    if (lm === undefined) return;
    setKicked(true);
    void lm
      .create({
        monitor: (m) => {
          m.addEventListener('downloadprogress', (e) => {
            if (mountedRef.current) setProgress(e.loaded);
          });
        },
      })
      .then((session) => {
        session.destroy();
        if (mountedRef.current) setState('available');
      })
      .catch(() => {
        if (mountedRef.current) void probe();
      });
    setState('downloading');
  }, [probe]);

  // IS THE SELECTED MODEL ON THE COMPANION? A HEAD against the companion's own
  // model host — loopback, no auth, no bytes. Re-runs on selection change and
  // after a download completes. An indeterminate answer (companion hiccup)
  // leaves the state alone rather than guessing "missing" and hiding a load
  // that would have worked.
  useEffect(() => {
    if (companionPort === null || companionPort === undefined) return;
    void (async () => {
      const cached = await probeModelCached({
        port: companionPort,
        spec: localModelSpec(localModelId),
      });
      if (!mountedRef.current || cached === null) return;
      setCacheState(cached ? 'cached' : 'missing');
    })();
  }, [companionPort, localModelId, cacheNonce]);

  // EXPLICIT COMPANION DOWNLOAD — the only path that pulls model weights across
  // the public internet, and a SEPARATE consent from the load below. The button
  // states the size and names huggingface.co before this can run.
  const downloadToCompanion = useCallback(async (): Promise<void> => {
    if (companionPort === null || companionPort === undefined) return;
    if (bridgeKey === null || bridgeKey === undefined) return;
    setFetchError(null);
    try {
      const started = await startModelFetch({
        port: companionPort,
        bridgeKey,
        spec: localModelSpec(localModelId),
      });
      if (mountedRef.current) setFetchStatus(started);
    } catch (err) {
      if (mountedRef.current) setFetchError(String(err instanceof Error ? err.message : err));
    }
  }, [companionPort, bridgeKey, localModelId]);

  // Follow the companion's background job while it runs. Multi-GB transfers take
  // minutes, so the panel polls rather than holding a request open.
  useEffect(() => {
    if (fetchStatus === null || fetchStatus.state !== 'running') return undefined;
    if (companionPort === null || companionPort === undefined) return undefined;
    if (bridgeKey === null || bridgeKey === undefined) return undefined;
    const modelId = fetchStatus.modelId;
    let stopped = false;
    const tick = async (): Promise<void> => {
      const next = await readModelFetchStatus({ port: companionPort, bridgeKey, modelId });
      if (stopped || !mountedRef.current) return;
      setFetchStatus(next);
      if (next.state === 'done') {
        // The companion can now serve it — re-probe so the Load button appears
        // through the SAME check that hid it, not through a local assumption.
        setCacheNonce((n) => n + 1);
      }
      if (next.state === 'error') setFetchError(next.error ?? 'download failed');
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, MODEL_FETCH_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [fetchStatus, companionPort, bridgeKey]);

  // EXPLICIT WebGPU load — the ONLY path that pulls the model into the browser,
  // and only reachable via the button below (rendered when Nano is unavailable).
  // Loads from the LOCAL companion; never from huggingface.co.
  const loadWebGpu = useCallback(async (): Promise<void> => {
    if (companionPort === null || companionPort === undefined) return;
    if (!webGpuSupported()) {
      setWebGpuState('error');
      setWebGpuError('WebGPU not available in this browser');
      return;
    }
    const spec = localModelSpec(localModelId);
    // PRE-CHECK. Loading a model the companion does not have fails deep inside
    // transformers.js with a raw URL the user cannot act on. Ask first, and if
    // the answer is "not cached" say the actionable thing instead — the row's
    // download button appears in the same render.
    const cached = await probeModelCached({ port: companionPort, spec });
    if (cached === false) {
      if (!mountedRef.current) return;
      setCacheState('missing');
      setWebGpuState('error');
      setWebGpuError(notCachedMessage(spec));
      return;
    }
    setWebGpuState('loading');
    setWebGpuError(null);
    setWebGpuProgress(null);
    try {
      await loadWebGpuEngine({
        port: companionPort,
        // The SELECTED model — the same explicit button, whichever size the user
        // picked. Nothing else in the product can start this load.
        modelId: localModelId,
        onProgress: (p) => {
          if (mountedRef.current) setWebGpuProgress(p);
        },
      });
      if (mountedRef.current) setWebGpuState('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      const raw = String(err);
      setWebGpuState('error');
      // Belt for the pre-check's braces: a file deleted mid-session, or a cache
      // holding config.json but not the weights, still surfaces as the step the
      // user can take rather than as the missing URL.
      if (isNotCachedError(raw)) {
        setCacheState('missing');
        setWebGpuError(notCachedMessage(spec));
      } else {
        setWebGpuError(raw);
      }
    }
  }, [companionPort, localModelId]);

  // COMPARATIVE GENERATION — the same document through every available engine,
  // rendered side by side with scores. STRICTLY OBSERVE-ONLY: two GETs to read a
  // document, then pure in-memory generation. Nothing is POSTed, nothing is
  // stored, nothing feeds serving.
  const runCompare = useCallback(async (): Promise<void> => {
    if (
      companionPort === null ||
      companionPort === undefined ||
      bridgeKey === null ||
      bridgeKey === undefined
    ) {
      return;
    }
    setCompareRunning(true);
    setCompareOutcome(null);
    setCompareNote(null);
    try {
      // Measure Chrome's REAL input quota before printing anyone's limits —
      // this is the one user-initiated surface that shows them side by side.
      await probeNanoLimits(builtinLanguageModel());
      const engines = await readyEngines();
      if (engines.length === 0) {
        setCompareNote('no engine is available to compare');
        return;
      }
      const headers = { 'x-bac-bridge-key': bridgeKey };
      const listRes = await fetch(`http://127.0.0.1:${String(companionPort)}/v1/threads`, {
        headers,
      });
      if (!listRes.ok) {
        setCompareNote(`thread list failed (${String(listRes.status)})`);
        return;
      }
      const listBody = (await listRes.json()) as {
        readonly data?: readonly { readonly bac_id: string }[];
      };
      const threads = listBody.data ?? [];
      let document = '';
      for (const t of threads.slice(0, EVAL_MAX_ITEMS)) {
        const mdRes = await fetch(
          `http://127.0.0.1:${String(companionPort)}/v1/threads/${encodeURIComponent(t.bac_id)}/markdown`,
          { headers },
        );
        const mdBody = mdRes.ok
          ? ((await mdRes.json().catch(() => null)) as { data?: { markdown?: string } } | null)
          : null;
        const markdown = (mdBody?.data?.markdown ?? '').slice(0, COMPARE_MARKDOWN_CHARS);
        if (markdown.trim().length >= COMPARE_MIN_CHARS) {
          document = markdown;
          break;
        }
      }
      if (document.length === 0) {
        setCompareNote('no document long enough to compare on');
        return;
      }
      const outcome = await compareEngines({ document, engines });
      if (!mountedRef.current) return;
      setCompareOutcome(outcome);
    } catch (err) {
      if (mountedRef.current) setCompareNote(`comparison failed: ${String(err)}`);
    } finally {
      if (mountedRef.current) setCompareRunning(false);
    }
  }, [companionPort, bridgeKey]);

  const runTitleEval = useCallback(async (): Promise<void> => {
    const engine = await resolveReadyEngine();
    if (
      engine === null ||
      companionPort === null ||
      companionPort === undefined ||
      bridgeKey === null ||
      bridgeKey === undefined
    ) {
      return;
    }
    setEvalRunning(true);
    setEvalResults(null);
    setEvalNote(null);
    try {
      const headers = { 'x-bac-bridge-key': bridgeKey };
      const listRes = await fetch(`http://127.0.0.1:${String(companionPort)}/v1/threads`, {
        headers,
      });
      if (!listRes.ok) {
        setEvalNote(`thread list failed (${String(listRes.status)})`);
        return;
      }
      const listBody = (await listRes.json()) as {
        readonly data?: readonly { readonly bac_id: string; readonly title?: string }[];
      };
      const threads = listBody.data ?? [];
      // Structural junk selection (shared with the enrichment worker): empty,
      // URL-shaped, or a title recurring verbatim across ≥3 distinct threads
      // (provider defaults recur; real titles don't).
      const junk = selectJunkTitledThreads(threads, EVAL_MAX_ITEMS);
      if (junk.length === 0) {
        setEvalNote('no junk-titled threads found — nothing to evaluate');
        return;
      }
      const results: TitleEvalResult[] = [];
      for (const t of junk) {
        const mdRes = await fetch(
          `http://127.0.0.1:${String(companionPort)}/v1/threads/${encodeURIComponent(t.bac_id)}/markdown`,
          { headers },
        );
        const mdBody = mdRes.ok
          ? ((await mdRes.json().catch(() => null)) as { data?: { markdown?: string } } | null)
          : null;
        const markdown = (mdBody?.data?.markdown ?? '').slice(0, EVAL_MARKDOWN_CHARS);
        if (markdown.trim().length < 80) {
          results.push({
            threadId: t.bac_id,
            before: t.title ?? '',
            after: '(content too thin — skipped)',
            ms: 0,
            scores: null,
            rejection: null,
          });
          continue;
        }
        const started = Date.now();
        let after: string;
        let failed = false;
        try {
          after = await engine.generate(`${TITLE_PROMPT_PREFIX}\n${markdown}`, TITLE_GENERATION);
        } catch (err) {
          after = `(error: ${String(err)})`;
          failed = true;
        }
        // Score EVERY generated row and show what the write-path validator
        // would say about it. Still observe-only: nothing is persisted.
        const verdict = failed
          ? null
          : validateGeneration(after, {
              kind: 'title',
              language: detectContentLanguage(markdown),
            });
        results.push({
          threadId: t.bac_id,
          before: t.title ?? '',
          after,
          ms: Date.now() - started,
          scores: failed ? null : scoreGeneration(after, markdown),
          rejection: verdict === null || verdict.ok ? null : verdict.reason,
        });
        if (!mountedRef.current) return;
        setEvalResults([...results]);
      }
      setEvalResults(results);
    } finally {
      if (mountedRef.current) setEvalRunning(false);
    }
  }, [companionPort, bridgeKey]);

  // The budgeted enrichment run: unlike the observe-only eval, this PERSISTS
  // synthesized titles via the companion (POST /v1/enrichment/titles) so they
  // feed the recommendation corpus. User-intent only — the button IS the run.
  const runEnrichment = useCallback(async (): Promise<void> => {
    const engine = await resolveReadyEngine();
    if (
      engine === null ||
      companionPort === null ||
      companionPort === undefined ||
      bridgeKey === null ||
      bridgeKey === undefined
    ) {
      return;
    }
    setEnrichRunning(true);
    setEnrichStats(null);
    setEnrichNote(null);
    try {
      const stats = await runTitleEnrichment({
        port: companionPort,
        bridgeKey,
        budget: ENRICH_BUDGET,
        // Route through whichever engine is ready. When it's the Nano-direct
        // path resolveReadyEngine returns a nano engine; passing it explicitly
        // is equivalent to the old default, and lets a loaded WebGPU engine
        // drive the persisting run too.
        engine,
      });
      if (!mountedRef.current) return;
      if (stats.generated === 0) {
        setEnrichNote('nothing to enrich — no new junk-titled threads');
      } else {
        setEnrichStats(stats);
      }
    } catch (err) {
      if (mountedRef.current) setEnrichNote(`enrichment failed: ${String(err)}`);
    } finally {
      if (mountedRef.current) setEnrichRunning(false);
    }
  }, [companionPort, bridgeKey]);

  const companionConnected =
    companionPort !== null &&
    companionPort !== undefined &&
    bridgeKey !== null &&
    bridgeKey !== undefined;
  // Nano is preferred; a loaded WebGPU engine is the fallback. Labels reflect
  // which is active so the user knows what produced the text.
  const nanoReady = state === 'available';
  const webGpuReady = webGpuState === 'ready';
  // Engine precedence, LOCAL-FIRST and identical to routing (engine.ts):
  // Nano → Apple on-device service → the loaded local model → the opt-in
  // remote engine. Remote is last because it is the only one that sends text
  // off the device.
  const activeEngineLabel: 'Nano' | 'Apple' | 'WebGPU' | 'Remote' | null = nanoReady
    ? 'Nano'
    : appleReady
      ? 'Apple'
      : webGpuReady
        ? 'WebGPU'
        : remoteArmed
          ? 'Remote'
          : null;
  const engineReady = activeEngineLabel !== null;
  const selectedSpec = localModelSpec(localModelId);
  // The limits of whatever would run right now — stated before anything runs.
  const activeLimits =
    activeEngineLabel === 'Nano'
      ? limitsFor('nano')
      : activeEngineLabel === 'Apple'
        ? limitsFor('apple')
        : activeEngineLabel === 'WebGPU'
          ? limitsFor('webgpu', localModelId)
          : activeEngineLabel === 'Remote'
            ? limitsFor('remote')
            : null;
  // The marker is tied to the ACTIVE engine, not merely to the setting: if a
  // local model is ready, remote is not what runs, and claiming text leaves the
  // device would be as dishonest as hiding it when it does.
  const remoteIsActive = activeEngineLabel === 'Remote' && remoteHost !== null;
  const evalAvailable = engineReady && companionConnected;
  // Offer the WebGPU load ONLY when Nano is not available (Nano is cheaper —
  // already resident, no download) AND the companion is connected (the model
  // host lives there). If the browser has no WebGPU adapter, we show an honest
  // "not available" line instead of a button that would only ever error.
  const showWebGpuLoad = !nanoReady && companionConnected && webGpuState !== 'ready';
  const webGpuSupportedHere = webGpuSupported();
  const downloadInFlight = fetchStatus !== null && fetchStatus.state === 'running';

  return (
    <div className="sx-callout" data-testid="hp-ondevice-ai">
      <strong>On-device AI (Gemini Nano)</strong>
      {' · '}
      <span data-testid="hp-ondevice-ai-state">{STATE_COPY[state]}</span>
      {state === 'downloading' && progress !== null ? (
        <span className="mono"> {String(Math.round(progress * 100))}%</span>
      ) : null}
      {state === 'downloadable' && !kicked ? (
        <button
          type="button"
          className="sx-btn"
          style={{ marginLeft: 8 }}
          onClick={startDownload}
        >
          Download model
        </button>
      ) : null}
      {/* WHICH local model. Selecting is free — it stores a preference and
          downloads nothing; the load button below states the size of whatever
          is selected before the user commits to it. Locked once a model is
          loaded: swapping mid-session would need a panel reload. */}
      {companionConnected && !nanoReady ? (
        <div className="mono" style={{ marginTop: 4 }}>
          <label>
            Local model{' '}
            <select
              value={localModelId}
              disabled={webGpuState === 'loading' || webGpuReady}
              onChange={(e) => {
                const next = e.target.value;
                setLocalModelId(next);
                // Every per-model answer is now stale: the new selection has its
                // own cache state and its own (possibly absent) download job.
                setCacheState('unknown');
                setFetchStatus(null);
                setFetchError(null);
                setWebGpuError(null);
                void writeSelectedLocalModelId(next);
              }}
              data-testid="hp-ondevice-ai-model-select"
            >
              {LOCAL_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · ~{formatBytes(m.approxBytesOnDisk)}
                </option>
              ))}
            </select>
          </label>
          <span style={{ marginLeft: 8 }} data-testid="hp-ondevice-ai-model-note">
            {selectedSpec.status === 'verified' ? '' : 'unverified · '}
            {selectedSpec.statusNote}
          </span>
        </div>
      ) : null}
      {/* WebGPU fallback — shown when Nano isn't available and the companion
          (the model host) is connected. TWO buttons, never both: the model has
          to be ON THE COMPANION before it can be loaded into the browser, and
          offering a load that cannot succeed is what produced the raw
          "Could not locate file" error this row now prevents. No adapter →
          honest line instead of either button. */}
      {showWebGpuLoad ? (
        webGpuSupportedHere ? (
          downloadInFlight ? (
            <span className="mono" style={{ marginLeft: 8 }} data-testid="hp-ondevice-ai-model-download-busy">
              Downloading to companion…
            </span>
          ) : cacheState === 'missing' ? (
            // NOT ON THE COMPANION. State the full cost — how much, and from
            // which non-loopback host — because this is the one step that
            // leaves the machine.
            <button
              type="button"
              className="sx-btn"
              style={{ marginLeft: 8 }}
              onClick={() => {
                void downloadToCompanion();
              }}
              data-testid="hp-ondevice-ai-model-download"
            >
              {downloadButtonLabel(selectedSpec)}
            </button>
          ) : (
            <button
              type="button"
              className="sx-btn"
              style={{ marginLeft: 8 }}
              disabled={webGpuState === 'loading'}
              onClick={() => {
                void loadWebGpu();
              }}
              data-testid="hp-ondevice-ai-webgpu-load"
            >
              {webGpuState === 'loading'
                ? 'Loading local model…'
                : `Load local model (WebGPU · ~${formatBytes(selectedSpec.approxBytesOnDisk)}, from companion)`}
            </button>
          )
        ) : (
          <span className="mono" style={{ marginLeft: 8 }} data-testid="hp-ondevice-ai-webgpu-unsupported">
            WebGPU not available in this browser
          </span>
        )
      ) : null}
      {/* Companion-download progress, straight from the job status: files,
          percent, and which file is moving. */}
      {downloadInFlight && fetchStatus !== null ? (
        <div className="mono" data-testid="hp-ondevice-ai-model-download-progress" style={{ marginTop: 4 }}>
          {fetchProgressLabel(fetchStatus)}
        </div>
      ) : null}
      {fetchError !== null ? (
        <div className="mono" data-testid="hp-ondevice-ai-model-download-error" style={{ marginTop: 4 }}>
          Download failed: {fetchError}
        </div>
      ) : null}
      {webGpuState === 'loading' && webGpuProgress !== null ? (
        <div className="mono" data-testid="hp-ondevice-ai-webgpu-progress" style={{ marginTop: 4 }}>
          {webGpuProgress.file} · {String(webGpuProgress.percent)}%
        </div>
      ) : null}
      {webGpuReady ? (
        <span className="mono" style={{ marginLeft: 8 }} data-testid="hp-ondevice-ai-webgpu-state">
          local model ready (WebGPU)
        </span>
      ) : null}
      {webGpuState === 'error' && webGpuError !== null ? (
        <div className="mono" data-testid="hp-ondevice-ai-webgpu-error" style={{ marginTop: 4 }}>
          {webGpuError}
        </div>
      ) : null}
      {/* The active engine's caps, so "2-3 sentences from a 40k-char page" is
          explicable up front rather than a mystery after the fact. */}
      {activeLimits !== null ? (
        <div className="mono" title={activeLimits.note} data-testid="hp-ondevice-ai-limits">
          {String(activeEngineLabel)} · {formatEngineLimits(activeLimits)}
          {activeLimits.inputSource === 'measured' ? ' (real quota)' : ''}
        </div>
      ) : null}
      {/* THE PRIVACY MARKER — persistent, unmissable, host-named, and shown
          exactly when the remote engine is the one that would run. */}
      {remoteIsActive && remoteHost !== null ? (
        <div
          className="mono"
          role="note"
          title={remotePrivacyDetail(remoteHost)}
          data-testid="hp-ondevice-ai-remote-warning"
        >
          {remotePrivacyMarker(remoteHost)}
        </div>
      ) : null}
      {evalAvailable ? (
        <button
          type="button"
          className="sx-btn"
          style={{ marginLeft: 8 }}
          disabled={evalRunning}
          onClick={() => {
            void runTitleEval();
          }}
          data-testid="hp-ondevice-ai-eval"
        >
          {evalRunning
            ? 'Evaluating…'
            : `Run title-synthesis eval · ${String(activeEngineLabel)}`}
        </button>
      ) : null}
      {evalAvailable ? (
        <button
          type="button"
          className="sx-btn"
          style={{ marginLeft: 8 }}
          disabled={enrichRunning}
          onClick={() => {
            void runEnrichment();
          }}
          data-testid="hp-ondevice-ai-enrich"
        >
          {enrichRunning
            ? 'Enriching…'
            : `Enrich titles (${String(ENRICH_BUDGET)}) · ${String(activeEngineLabel)}`}
        </button>
      ) : null}
      {/* COMPARATIVE GENERATION. Same document, every available engine, scores
          side by side — because one engine's 0.43 groundedness means nothing on
          its own. Observe-only: no POST, nothing saved. */}
      {evalAvailable ? (
        <button
          type="button"
          className="sx-btn"
          style={{ marginLeft: 8 }}
          disabled={compareRunning}
          onClick={() => {
            void runCompare();
          }}
          data-testid="hp-ondevice-ai-compare"
        >
          {compareRunning ? 'Comparing…' : 'Compare engines'}
        </button>
      ) : null}
      {enrichNote !== null ? <div className="mono">{enrichNote}</div> : null}
      {enrichStats !== null ? (
        <div className="mono" data-testid="hp-ondevice-ai-enrich-stats" style={{ marginTop: 4 }}>
          {String(enrichStats.generated)} generated · {String(enrichStats.accepted)} accepted
          {enrichStats.skipped > 0 ? ` · ${String(enrichStats.skipped)} skipped` : ''}
        </div>
      ) : null}
      {evalNote !== null ? <div className="mono">{evalNote}</div> : null}
      {evalResults !== null ? (
        <div data-testid="hp-ondevice-ai-eval-results" style={{ marginTop: 6 }}>
          {evalResults.map((r) => (
            <div key={r.threadId} style={{ marginTop: 4 }}>
              <div className="mono">
                [{String(r.ms)}ms] “{r.before.length === 0 ? '(untitled)' : r.before}” → “{r.after}”
              </div>
              {r.scores !== null ? (
                <div className="mono" data-testid={`hp-ondevice-ai-eval-scores-${r.threadId}`}>
                  {formatScores(r.scores)}
                  {r.rejection === null ? ' · accepted' : ` · REJECTED: ${r.rejection}`}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {compareNote !== null ? (
        <div className="mono" data-testid="hp-ondevice-ai-compare-note">
          {compareNote}
        </div>
      ) : null}
      {compareOutcome !== null ? (
        <div data-testid="hp-ondevice-ai-compare-results" style={{ marginTop: 6 }}>
          <div className="mono" data-testid="hp-ondevice-ai-compare-headline">
            {compareOutcome.headline}
          </div>
          {/* THE CAVEAT. Rendered whenever the engines that ran are not the same
              parameter class — a 1B-vs-3.25B "winner" measures model size, not
              engine quality, and saying so is the point of the feature. */}
          {compareOutcome.sizeCaveat !== null ? (
            <div className="mono" data-testid="hp-ondevice-ai-compare-caveat">
              {compareOutcome.sizeCaveat}
            </div>
          ) : null}
          {compareOutcome.rows.map((row) => (
            <div
              key={row.kind}
              style={{ marginTop: 4 }}
              data-testid={`hp-ondevice-ai-compare-row-${row.kind}`}
            >
              <div className="mono">
                {compareOutcome.winnerKind === row.kind ? '★ ' : ''}
                {row.matchup} · {formatEngineLimits(row.limits)} · {String(row.ms)}ms
                {row.sendsTextOffDevice && remoteHost !== null
                  ? ` · ${remotePrivacyMarker(remoteHost)}`
                  : ''}
                {row.inputReduced
                  ? ` · ${formatReduction(row.processedChars, row.inputChars)}`
                  : ''}
              </div>
              <div className="mono" data-testid={`hp-ondevice-ai-compare-text-${row.kind}`}>
                {row.text ?? '(no output)'}
              </div>
              <div className="mono" data-testid={`hp-ondevice-ai-compare-verdict-${row.kind}`}>
                {compareStatusCopy(row)}
                {row.scores === null ? '' : ` · ${formatScores(row.scores)}`}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <RemoteEngineRow
        onChanged={() => {
          setRemoteNonce((n) => n + 1);
        }}
      />
    </div>
  );
}
