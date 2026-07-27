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
  loadWebGpuEngine,
  resolveReadyEngine,
  webGpuSupported,
  type WebGpuLoadProgress,
} from '../../../src/sidepanel/nano/engine';

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
// The budgeted enrichment run titles up to this many junk-titled threads per
// click and PERSISTS them (unlike the observe-only eval above).
const ENRICH_BUDGET = 10;

export interface TitleEvalResult {
  readonly threadId: string;
  readonly before: string;
  readonly after: string;
  readonly ms: number;
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
  const mountedRef = useRef(true);

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

  // EXPLICIT WebGPU load — the ONLY path that fetches the ~800MB model, and
  // only reachable via the button below (rendered when Nano is unavailable).
  const loadWebGpu = useCallback(async (): Promise<void> => {
    if (companionPort === null || companionPort === undefined) return;
    if (!webGpuSupported()) {
      setWebGpuState('error');
      setWebGpuError('WebGPU not available in this browser');
      return;
    }
    setWebGpuState('loading');
    setWebGpuError(null);
    setWebGpuProgress(null);
    try {
      await loadWebGpuEngine({
        port: companionPort,
        onProgress: (p) => {
          if (mountedRef.current) setWebGpuProgress(p);
        },
      });
      if (mountedRef.current) setWebGpuState('ready');
    } catch (err) {
      if (mountedRef.current) {
        setWebGpuState('error');
        setWebGpuError(String(err));
      }
    }
  }, [companionPort]);

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
          });
          continue;
        }
        const started = Date.now();
        let after: string;
        try {
          after = await engine.generate(`${TITLE_PROMPT_PREFIX}\n${markdown}`, { maxNewTokens: 32 });
        } catch (err) {
          after = `(error: ${String(err)})`;
        }
        results.push({ threadId: t.bac_id, before: t.title ?? '', after, ms: Date.now() - started });
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
  const activeEngineLabel: 'Nano' | 'WebGPU' | null = nanoReady
    ? 'Nano'
    : webGpuReady
      ? 'WebGPU'
      : null;
  const engineReady = activeEngineLabel !== null;
  const evalAvailable = engineReady && companionConnected;
  // Offer the WebGPU load ONLY when Nano is not available (Nano is cheaper —
  // already resident, no download) AND the companion is connected (the model
  // host lives there). If the browser has no WebGPU adapter, we show an honest
  // "not available" line instead of a button that would only ever error.
  const showWebGpuLoad = !nanoReady && companionConnected && webGpuState !== 'ready';
  const webGpuSupportedHere = webGpuSupported();

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
      {/* WebGPU fallback — shown when Nano isn't available and the companion
          (the model host) is connected. The load is EXPLICIT (this button is
          the only trigger for the ~800MB fetch). No adapter → honest line. */}
      {showWebGpuLoad ? (
        webGpuSupportedHere ? (
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
              : 'Load local model (WebGPU · ~800MB, from companion)'}
          </button>
        ) : (
          <span className="mono" style={{ marginLeft: 8 }} data-testid="hp-ondevice-ai-webgpu-unsupported">
            WebGPU not available in this browser
          </span>
        )
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
            <div key={r.threadId} className="mono" style={{ marginTop: 4 }}>
              [{String(r.ms)}ms] “{r.before.length === 0 ? '(untitled)' : r.before}” → “{r.after}”
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
