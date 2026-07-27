import { useCallback, useState, type ReactElement } from 'react';

import {
  GIST_PROMPT_PREFIX,
  MAX_GIST_CHARS,
  MIN_CONTENT_CHARS,
  contentHashOf,
  sliceForSynthesis,
} from './titleSynthesis';
import { resolveReadyEngine } from './engine';

// On-demand page-content enrichment — a single "Enrich content" action placed
// next to the Now card's ▸ Page-text disclosure. Given a READY engine (Nano or
// an explicitly-loaded WebGPU model) it:
//   1. fetches the focused surface's text (page text for a URL, thread markdown
//      for a chat thread),
//   2. generates a factual gist on-device,
//   3. POSTs it to the companion's content-enrichment endpoint
//      (/v1/enrichment/content, authenticated with the bridge key),
//   4. shows the saved gist and asks the host to force-refresh the focused
//      URL's resolution so the lanes/categories pick up the new signal.
// Every phase renders inline so the wait is legible (fetching → generating →
// saving → done), matching the taste bar: state and controls co-located.
//
// The engine is NEVER loaded here — resolveReadyEngine() only returns an engine
// that is already ready. When none is (Nano unavailable AND WebGPU not loaded)
// the button is disabled with a hint pointing at Health, so the ~800MB model is
// only ever fetched from the explicit Health-row button.

export type EnrichmentPhase =
  | 'idle'
  | 'fetching'
  | 'generating'
  | 'saving'
  | 'done'
  | 'skipped'
  | 'error';

// The target surface. 'url' pages POST as kind 'url' keyed by canonicalUrl;
// chat threads POST as kind 'thread' keyed by the bac id.
export type EnrichmentTarget =
  | { readonly kind: 'url'; readonly canonicalUrl: string }
  | { readonly kind: 'thread'; readonly bacId: string };

export interface ContentEnrichmentActionProps {
  readonly target: EnrichmentTarget;
  readonly port: number;
  readonly bridgeKey: string;
  /** True when Nano is available OR the WebGPU engine was explicitly loaded. */
  readonly engineReady: boolean;
  /** 'Nano' | 'WebGPU' — for the button label; null when no engine is ready. */
  readonly activeEngineLabel: 'Nano' | 'WebGPU' | null;
  /**
   * Fetch the target's raw text. Injected so the host wires the SAME source the
   * page-text indexer uses (a page-content extract message) for URLs and the
   * /v1/threads/{id}/markdown route for threads — and so tests can stub it.
   * Returns null when no text is obtainable (button then reads disabled).
   */
  readonly fetchText: (target: EnrichmentTarget) => Promise<string | null>;
  /** Called after a gist is saved so the host force-re-resolves the focused
   *  URL (the lanes/categories update). Best-effort; failures don't block. */
  readonly onEnriched?: () => void;
  readonly testIdPrefix?: string;
}

const PHASE_COPY: Record<EnrichmentPhase, string> = {
  idle: '',
  fetching: 'fetching text…',
  generating: 'generating gist…',
  saving: 'saving gist…',
  done: 'done — gist saved',
  skipped: 'content too thin — nothing saved',
  error: '',
};

interface ContentEnrichmentPayloadItem {
  readonly kind: 'thread' | 'url';
  readonly id: string;
  readonly gist: string;
  readonly sourceContentHash: string;
  readonly model: string;
  readonly generatedAt: string;
}

/**
 * Generate a gist from raw content through a ready engine, mirroring the title
 * synthesis discipline: thin-content gate, slice, SKIP/empty → null, cap to the
 * contract's ≤2000 chars.
 */
const generateGist = async (
  engine: { generate: (p: string, o: { maxNewTokens: number }) => Promise<string> },
  content: string,
): Promise<string | null> => {
  if (content.trim().length < MIN_CONTENT_CHARS) return null;
  const sample = sliceForSynthesis(content);
  const raw = (await engine.generate(`${GIST_PROMPT_PREFIX}\n${sample}`, { maxNewTokens: 220 })).trim();
  if (raw.length === 0 || raw === 'SKIP') return null;
  return raw.slice(0, MAX_GIST_CHARS);
};

export function ContentEnrichmentAction({
  target,
  port,
  bridgeKey,
  engineReady,
  activeEngineLabel,
  fetchText,
  onEnriched,
  testIdPrefix = 'now',
}: ContentEnrichmentActionProps): ReactElement {
  const [phase, setPhase] = useState<EnrichmentPhase>('idle');
  const [gist, setGist] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<void> => {
    setPhase('fetching');
    setGist(null);
    setError(null);
    try {
      // The engine must already be ready — never loaded here.
      const engine = await resolveReadyEngine();
      if (engine === null) {
        setPhase('error');
        setError('no engine ready — load the local model in Health first');
        return;
      }
      const text = await fetchText(target);
      if (text === null || text.trim().length === 0) {
        setPhase('error');
        setError('no obtainable text for this page');
        return;
      }
      setPhase('generating');
      const generated = await generateGist(engine, text);
      if (generated === null) {
        setPhase('skipped');
        return;
      }
      setPhase('saving');
      const item: ContentEnrichmentPayloadItem = {
        kind: target.kind,
        id: target.kind === 'url' ? target.canonicalUrl : target.bacId,
        gist: generated,
        sourceContentHash: contentHashOf(text),
        model: engine.kind === 'nano' ? 'gemini-nano' : 'gemma-3-1b-it',
        generatedAt: new Date().toISOString(),
      };
      const res = await fetch(`http://127.0.0.1:${String(port)}/v1/enrichment/content`, {
        method: 'POST',
        headers: { 'x-bac-bridge-key': bridgeKey, 'content-type': 'application/json' },
        body: JSON.stringify({ items: [item] }),
      });
      if (!res.ok) {
        setPhase('error');
        setError(`save failed (${String(res.status)})`);
        return;
      }
      setGist(generated);
      setPhase('done');
      // Nudge the host to re-resolve the focused URL so lanes/categories
      // reflect the new gist. Best-effort — a throw here must not surface.
      try {
        onEnriched?.();
      } catch {
        // ignore — the gist is already saved.
      }
    } catch (err) {
      setPhase('error');
      setError(String(err));
    }
  }, [target, port, bridgeKey, fetchText, onEnriched]);

  const busy = phase === 'fetching' || phase === 'generating' || phase === 'saving';
  // Disabled unless an engine is ready. The hint distinguishes "no engine" from
  // "no text" so the dead-end click is explained (per the taste bar).
  const disabledHint = !engineReady
    ? 'load the local model in Health first'
    : undefined;
  const label = busy
    ? PHASE_COPY[phase]
    : `Enrich content${activeEngineLabel !== null ? ` · ${activeEngineLabel}` : ''}`;

  return (
    <div className="cx-enrich-content" data-testid={`${testIdPrefix}-enrich-content`}>
      <button
        type="button"
        className="cx-mini-btn"
        onClick={() => {
          void run();
        }}
        disabled={!engineReady || busy}
        title={disabledHint ?? 'Summarize this page on-device and save the gist to the companion'}
        data-testid={`${testIdPrefix}-enrich-content-btn`}
      >
        {label}
      </button>
      {phase !== 'idle' && !busy ? (
        <span
          className="cx-enrich-content-status mono"
          data-testid={`${testIdPrefix}-enrich-content-status`}
        >
          {phase === 'error' ? (error ?? 'enrichment failed') : PHASE_COPY[phase]}
        </span>
      ) : null}
      {busy ? (
        <span
          className="cx-enrich-content-status mono"
          data-testid={`${testIdPrefix}-enrich-content-status`}
        >
          {PHASE_COPY[phase]}
        </span>
      ) : null}
      {phase === 'done' && gist !== null ? (
        <div
          className="cx-enrich-content-gist mono"
          data-testid={`${testIdPrefix}-enrich-content-gist`}
          style={{ marginTop: 4, fontSize: '0.85em' }}
        >
          {gist}
        </div>
      ) : null}
    </div>
  );
}
