import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import {
  GIST_PROMPT_PREFIX,
  MAX_GIST_CHARS,
  MIN_CONTENT_CHARS,
  contentHashOf,
  sliceForSynthesis,
} from './titleSynthesis';
import { resolveEngineForLanguage } from './engine';
import {
  detectContentLanguage,
  routeEnrichmentEngine,
  type ContentLanguage,
  type EngineAvailability,
  type EnrichmentBlockReason,
  type EnrichmentRoute,
} from './language';

// On-demand page-content enrichment — the on-device AI row on the Now card,
// sitting with the suggestion pipeline (PipelineStrip / guess lanes) because
// enrichment is part of the same "how this guess was formed" story. Given a
// READY engine (Nano or an explicitly-loaded WebGPU model) it:
//   1. fetches the focused surface's text (page text for a URL, thread markdown
//      for a chat thread),
//   2. generates a factual gist on-device,
//   3. POSTs it to the companion's content-enrichment endpoint
//      (/v1/enrichment/content, authenticated with the bridge key),
//   4. shows the saved gist and asks the host to force-refresh the focused
//      URL's resolution so the lanes/categories pick up the new signal.
//
// THE STATE IS ALWAYS RENDERED. The old version was a bare button that went
// grey whenever no engine was ready, with no way to find out why — on a browser
// without built-in Nano that is EVERY page until the user happens to open
// Health and load the local model. A disabled control with no reason is the
// bug. So the row always states, in plain language: which engine is ready, or
// why none is, plus the action that fixes it; and while a run is in flight it
// shows the live phase (fetching → generating → saving → done) with the engine
// that is doing the work.
//
// The engine is NEVER loaded here. Routing (language.ts) is pure and passive;
// resolveEngineForLanguage() only ever returns something already loaded. The
// ~800MB WebGPU fetch stays reachable from exactly one place — the explicit
// Health → Experiments button — and this row LINKS there, never triggers it.

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

/** Typed failure reasons — every one renders as its own honest sentence. */
export type EnrichmentFailure =
  | { readonly kind: 'blocked'; readonly reason: EnrichmentBlockReason }
  | { readonly kind: 'no-text' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'engine'; readonly detail: string }
  | { readonly kind: 'save'; readonly status: number };

export interface ContentEnrichmentActionProps {
  readonly target: EnrichmentTarget;
  readonly port: number;
  readonly bridgeKey: string;
  /**
   * Passive snapshot of what is loaded right now (engineAvailabilitySnapshot).
   * Preferred input: it carries enough to state the reason when nothing is
   * ready. When omitted the legacy engineReady/activeEngineLabel pair is used.
   */
  readonly availability?: EngineAvailability;
  /** Detected language of the surface (from its title/text), when the host
   *  knows it. Absent → 'en'. Re-detected from the real text at run time. */
  readonly contentLanguage?: ContentLanguage;
  /** Legacy: true when Nano is available OR WebGPU was explicitly loaded. */
  readonly engineReady?: boolean;
  /** Legacy: 'Nano' | 'WebGPU' for the button label; null when none is ready. */
  readonly activeEngineLabel?: 'Nano' | 'WebGPU' | null;
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
  /** Opens the Health panel on its Experiments drill — the ONE place the local
   *  model is loaded. Rendered as the row's action when the route is blocked on
   *  a loadable model. Absent → the row states the reason without an action. */
  readonly onOpenHealth?: () => void;
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

/** The row's headline state, one line, always rendered. */
export const engineStateLine = (
  route: EnrichmentRoute,
  availability: EngineAvailability | undefined,
): string => {
  if (route.engine === 'nano') return 'AI: Nano ready';
  if (route.engine === 'webgpu') return 'AI: local model ready (WebGPU)';
  switch (route.reason) {
    case 'model-loading': {
      const pct = availability?.webGpuPercent;
      return typeof pct === 'number'
        ? `AI: downloading ${String(Math.round(pct))}%`
        : 'AI: downloading the local model…';
    }
    case 'model-not-loaded':
      return 'AI: model not loaded — Load in Health';
    case 'language-needs-local-model':
      return 'AI: Chinese needs the local model';
    case 'no-engine':
      return 'AI: unavailable in this browser';
  }
};

/** The disabled button's title/description — the SAME reason, said longer. */
export const blockedHint = (reason: EnrichmentBlockReason): string => {
  switch (reason) {
    case 'model-loading':
      return 'The local model is still downloading — enrichment works once it finishes.';
    case 'model-not-loaded':
      return 'No on-device model is loaded. Open Health → Experiments and load the local model.';
    case 'language-needs-local-model':
      return "This page is Chinese, and Chrome's built-in AI does not support Chinese. Open Health → Experiments and load the local model.";
    case 'no-engine':
      return "No on-device model here: this browser has no built-in AI and no WebGPU adapter, so there is nothing to run the summary on.";
  }
};

/** Short failure line for a run that ended badly — one typed reason each.
 *  Takes the TARGET kind: a chat thread has no "page" to index, so its
 *  no-text reason must not tell the user to index a page (live report,
 *  2026-07-27 — a chat card said "index this page first"). */
const failureCopy = (failure: EnrichmentFailure, kind: EnrichmentTarget['kind']): string => {
  switch (failure.kind) {
    case 'blocked':
      return failure.reason === 'language-needs-local-model'
        ? 'Chinese content needs the local model — load it in Health'
        : failure.reason === 'model-loading'
          ? 'the local model is still downloading'
          : failure.reason === 'no-engine'
            ? 'no on-device model in this browser'
            : 'no model loaded — load it in Health';
    case 'no-text':
      return kind === 'thread'
        ? 'no captured conversation in this thread yet'
        : 'no page text — index this page first';
    case 'cancelled':
      return 'cancelled — the page changed';
    case 'engine':
      return `model error — ${failure.detail.slice(0, 120)}`;
    case 'save':
      return `save failed (${String(failure.status)})`;
  }
};

/** A blocked route the user can actually fix from Health. */
const isLoadableInHealth = (reason: EnrichmentBlockReason): boolean =>
  reason === 'model-not-loaded' || reason === 'language-needs-local-model';

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

const targetKeyOf = (target: EnrichmentTarget): string =>
  target.kind === 'url' ? `url:${target.canonicalUrl}` : `thread:${target.bacId}`;

// How long the full "done — gist saved · WebGPU · 1.2s" line stays before it
// settles into the persistent, subtle "gist saved · WebGPU" marker.
const RESULT_SETTLE_MS = 8000;

export function ContentEnrichmentAction({
  target,
  port,
  bridgeKey,
  availability,
  contentLanguage,
  engineReady,
  activeEngineLabel,
  fetchText,
  onEnriched,
  onOpenHealth,
  testIdPrefix = 'now',
}: ContentEnrichmentActionProps): ReactElement {
  const [phase, setPhase] = useState<EnrichmentPhase>('idle');
  const [gist, setGist] = useState<string | null>(null);
  const [failure, setFailure] = useState<EnrichmentFailure | null>(null);
  // Which engine actually ran, and how long it took — the result line names
  // both so "gist saved" is attributable, not anonymous.
  const [ranOn, setRanOn] = useState<'Nano' | 'WebGPU' | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);

  // Pre-run routing: what the row can say BEFORE anything is clicked. Uses the
  // host's language hint (page title) — the run re-detects on the real text.
  // Neither input yet = the host's passive probe hasn't resolved. Say THAT
  // rather than flash "model not loaded" and correct itself a frame later.
  const probing = availability === undefined && engineReady === undefined;
  const language: ContentLanguage = contentLanguage ?? 'en';
  const route: EnrichmentRoute =
    availability !== undefined
      ? routeEnrichmentEngine(language, availability)
      : engineReady === true
        ? activeEngineLabel === 'WebGPU'
          ? { engine: 'webgpu' }
          : { engine: 'nano' }
        : { engine: null, reason: 'model-not-loaded' };
  const engineLabel: 'Nano' | 'WebGPU' | null =
    availability === undefined && activeEngineLabel !== undefined
      ? activeEngineLabel
      : route.engine === 'nano'
        ? 'Nano'
        : route.engine === 'webgpu'
          ? 'WebGPU'
          : null;

  const targetKey = targetKeyOf(target);
  const targetKeyRef = useRef(targetKey);
  const busy = phase === 'fetching' || phase === 'generating' || phase === 'saving';
  // A new surface must not keep the previous one's result. An in-flight run
  // notices the key change after its next await and reports 'cancelled'.
  useEffect(() => {
    if (targetKeyRef.current === targetKey) return;
    targetKeyRef.current = targetKey;
    setGist(null);
    setFailure(null);
    setRanOn(null);
    setElapsedMs(null);
    setSettled(false);
    setPhase((prev) =>
      prev === 'fetching' || prev === 'generating' || prev === 'saving' ? prev : 'idle',
    );
  }, [targetKey]);

  // The success line fades to a compact persistent marker rather than
  // disappearing — the user keeps the evidence that this page was enriched.
  useEffect(() => {
    if (phase !== 'done') return undefined;
    setSettled(false);
    const timer = setTimeout(() => {
      setSettled(true);
    }, RESULT_SETTLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [phase]);

  const run = useCallback(async (): Promise<void> => {
    const myKey = targetKeyRef.current;
    const startedAt = Date.now();
    setPhase('fetching');
    setGist(null);
    setFailure(null);
    setRanOn(null);
    setElapsedMs(null);
    const stale = (): boolean => targetKeyRef.current !== myKey;
    const cancel = (): void => {
      setPhase('error');
      setFailure({ kind: 'cancelled' });
    };
    try {
      const text = await fetchText(target);
      if (stale()) {
        cancel();
        return;
      }
      if (text === null || text.trim().length === 0) {
        setPhase('error');
        setFailure({ kind: 'no-text' });
        return;
      }
      // Route on the REAL text, not the title hint: Chinese content never
      // reaches Nano, whatever the title looked like. Never loads anything —
      // a blocked route returns its typed reason.
      const { engine, route: runRoute } = await resolveEngineForLanguage(
        detectContentLanguage(text),
      );
      if (stale()) {
        cancel();
        return;
      }
      if (engine === null) {
        setPhase('error');
        setFailure({
          kind: 'blocked',
          reason: runRoute.engine === null ? runRoute.reason : 'no-engine',
        });
        return;
      }
      setRanOn(engine.kind === 'nano' ? 'Nano' : 'WebGPU');
      setPhase('generating');
      let generated: string | null;
      try {
        generated = await generateGist(engine, text);
      } catch (err) {
        if (stale()) {
          cancel();
          return;
        }
        setPhase('error');
        setFailure({ kind: 'engine', detail: String(err) });
        return;
      }
      if (stale()) {
        cancel();
        return;
      }
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
      if (stale()) {
        cancel();
        return;
      }
      if (!res.ok) {
        setPhase('error');
        setFailure({ kind: 'save', status: res.status });
        return;
      }
      setGist(generated);
      setElapsedMs(Date.now() - startedAt);
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
      setFailure({ kind: 'engine', detail: String(err) });
    }
  }, [target, port, bridgeKey, fetchText, onEnriched]);

  const blocked = probing || route.engine === null;
  const blockReason: EnrichmentBlockReason | null =
    probing || route.engine !== null ? null : route.reason;
  const stateId = `${testIdPrefix}-enrich-engine-state`;
  const stateLine = probing
    ? 'AI: checking the on-device model…'
    : engineStateLine(route, availability);
  const buttonTitle = probing
    ? 'Checking which on-device model is available…'
    : blockReason !== null
      ? blockedHint(blockReason)
      : 'Summarize this page on-device and save the gist to the companion';
  const buttonLabel = busy
    ? PHASE_COPY[phase]
    : `Enrich content${engineLabel !== null ? ` · ${engineLabel}` : ''}`;
  // The status line, one element for every non-idle state so a run always ends
  // somewhere legible: the live phase, the typed failure, or the result.
  const statusText = busy
    ? `${PHASE_COPY[phase]}${ranOn !== null ? ` · ${ranOn}` : ''}`
    : phase === 'error'
      ? (failure === null ? 'enrichment failed' : failureCopy(failure, target.kind))
      : phase === 'done'
        ? settled
          ? `gist saved${ranOn !== null ? ` · ${ranOn}` : ''}`
          : `${PHASE_COPY.done}${ranOn !== null ? ` · ${ranOn}` : ''}${
              elapsedMs === null ? '' : ` · ${(elapsedMs / 1000).toFixed(1)}s`
            }`
        : PHASE_COPY[phase];

  return (
    <div className="enrich-row" data-testid={`${testIdPrefix}-enrich-content`}>
      <div className="enrich-row-head">
        <span className="enrich-row-state mono" id={stateId} data-testid={stateId}>
          {stateLine}
        </span>
        {blockReason !== null && isLoadableInHealth(blockReason) && onOpenHealth !== undefined ? (
          <button
            type="button"
            className="enrich-row-link"
            onClick={onOpenHealth}
            title="Open Health → Experiments, where the local model is loaded"
            data-testid={`${testIdPrefix}-enrich-open-health`}
          >
            Load in Health
          </button>
        ) : null}
        <button
          type="button"
          className="cx-mini-btn"
          onClick={() => {
            void run();
          }}
          disabled={blocked || busy}
          title={buttonTitle}
          aria-describedby={stateId}
          data-testid={`${testIdPrefix}-enrich-content-btn`}
        >
          {buttonLabel}
        </button>
      </div>
      {busy ? (
        <div
          className="enrich-row-bar"
          role="progressbar"
          aria-busy="true"
          aria-label={PHASE_COPY[phase]}
          data-testid={`${testIdPrefix}-enrich-progress`}
        >
          <span className="enrich-row-bar-fill" />
        </div>
      ) : null}
      {phase !== 'idle' ? (
        <span
          className={`enrich-row-status mono${settled && phase === 'done' ? ' is-settled' : ''}`}
          data-testid={`${testIdPrefix}-enrich-content-status`}
        >
          {statusText}
        </span>
      ) : null}
      {phase === 'done' && gist !== null && !settled ? (
        <div className="enrich-row-gist mono" data-testid={`${testIdPrefix}-enrich-content-gist`}>
          {gist}
        </div>
      ) : null}
    </div>
  );
}
