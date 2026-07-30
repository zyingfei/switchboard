import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { contentHashOf } from './titleSynthesis';
import { engineIdentityOf, engineLimitsOf, resolveEngineForLanguage } from './engine';
import {
  formatEngineLimits,
  formatReduction,
  limitsFor,
  type EngineLimits,
} from './engineLimits';
import {
  normalizeEnrichmentText,
  sourceNoteOf,
  type EnrichmentInputSource,
  type EnrichmentText,
} from './enrichmentInput';
import { synthesizeGist, type GistMeta } from './gistSynthesis';
import { readStoredGist, writeStoredGist } from './gistStore';
import {
  gistInfluenceFrom,
  gistProvenanceLine,
  GIST_LANE_MARKER_TITLE,
} from '../tabsession/gistProvenance';
import type { GuessLaneResult, TabSessionWorkstreamOption } from '../tabsession/types';
import { appleFailureCopy, appleFailureKindOf, type AppleFailureKind } from './appleEngine';
import type { EngineKind } from './modelRegistry';
import { remotePrivacyDetail, remotePrivacyMarker } from './remoteConfig';
import { remoteFailureCopy, remoteFailureKindOf, type RemoteFailureKind } from './remoteEngine';
import { rejectionCopy, type GenerationRejectionReason } from './validateGeneration';
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
// THE GIST STAYS ON SCREEN. It used to collapse into a subtle "gist saved"
// marker 8 seconds after the run and the text vanished — a deliberate choice,
// and the wrong one ("the gist just shows for a few seconds? why?", 2026-07-27).
// The generated text is what the user asked for, so it persists for the focused
// surface across re-renders and resolve refreshes, comes BACK when the user
// returns to a page that already has one (gistStore.ts), and is clamped to two
// lines with a more/less affordance rather than auto-hidden.
//
// AND IT SAYS WHAT IT IS DOING. Under the gist sits its provenance line: which
// workstream guess(es) the gist is currently feeding, or that it is feeding
// none yet — always with the honest framing that the gist is part of the
// Content lane's QUERY TEXT, never a claim that it produced the ranking
// (gistProvenance.ts, which the Content lane row shares so both directions of
// the connection tell one story).
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
  /** The optional remote provider failed, with its typed reason. */
  | { readonly kind: 'remote'; readonly reason: RemoteFailureKind }
  /** The local Apple service failed, with its typed reason. */
  | { readonly kind: 'apple'; readonly reason: AppleFailureKind }
  /** The model produced text and the text was unusable — nothing was saved. */
  | { readonly kind: 'rejected'; readonly reason: GenerationRejectionReason }
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
   * Fetch the target's raw text. Injected so the host wires the SAME sources the
   * page-text indexer uses — the already-indexed text, then the already-
   * extracted page features, then a live extract (enrichmentInput.ts) — and so
   * tests can stub it. Returns the typed {text, source} so the row can LABEL a
   * thin input honestly; a bare `string | null` is still accepted and read as
   * full text. Null/'none' means nothing exists, and only then does the row ask
   * the user to index.
   */
  readonly fetchText: (
    target: EnrichmentTarget,
  ) => Promise<string | null | EnrichmentText>;
  /** Called after a gist is saved so the host force-re-resolves the focused
   *  URL (the lanes/categories update). Best-effort; failures don't block. */
  readonly onEnriched?: () => void;
  /** Opens the Health panel on its Experiments drill — the ONE place the local
   *  model is loaded. Rendered as the row's action when the route is blocked on
   *  a loadable model. Absent → the row states the reason without an action. */
  readonly onOpenHealth?: () => void;
  /**
   * Index this page's text — the SAME action the page-text panel's "Index page"
   * button runs. Offered INLINE, and only when the input chain came back with
   * nothing at all: a page that was already extracted must never be asked to
   * index again (the 2026-07-27 "features only" report).
   */
  readonly onIndexPage?: () => void;
  /**
   * The focused resolve's guess lanes + workstream options, for the gist's
   * provenance line ("which guess is this gist feeding?"). Absent → the line
   * states there is no Content lane to report on, which is the honest reading
   * of an old companion or a disabled lane.
   */
  readonly lanes?: readonly GuessLaneResult[];
  readonly workstreams?: readonly TabSessionWorkstreamOption[];
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
  // Named as Apple's own on-device model, and marked on-device, because the
  // whole reason it outranks WebGPU is that it is already resident in macOS —
  // the user should be able to tell it apart from the remote lane at a glance.
  if (route.engine === 'apple') return 'AI: Apple on-device model ready';
  if (route.engine === 'webgpu') return 'AI: local model ready (WebGPU)';
  if (route.engine === 'remote') {
    const host = availability?.remoteHost;
    return `AI: remote model (${
      typeof host === 'string' && host.length > 0 ? host : 'user-configured provider'
    })`;
  }
  switch (route.reason) {
    case 'model-loading': {
      const pct = availability?.webGpuPercent;
      return typeof pct === 'number'
        ? `AI: downloading ${String(Math.round(pct))}%`
        : 'AI: downloading the local model…';
    }
    case 'engine-service-failing':
      // Do NOT say 'load it in Health' — nothing there fixes a service whose
      // model is refusing to generate (live 2026-07-30: the machine was out
      // of memory). Name the real thing so the reader can act on it.
      return 'AI: on-device model failing — system may be low on memory';
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
    case 'engine-service-failing':
      return 'The on-device AI service is running but its model refuses to generate — usually memory pressure on the machine. Loading a model in Health will not help; free memory (or restart the companion) and it recovers on its own.';
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
    case 'remote':
      // The provider's typed failure, in the same shape every other reason
      // uses. The API key is never part of this string.
      return `remote engine — ${remoteFailureCopy(failure.reason)} · nothing saved`;
    case 'apple':
      // 'unsupported-language' is the one worth spelling out: Apple ADVERTISES
      // Chinese and then refuses it, so a user watching a Chinese page fail
      // deserves the actual reason and the actual fix rather than a shrug.
      return failure.reason === 'unsupported-language'
        ? 'Apple’s on-device model refused this language — load the local model in Health for Chinese'
        : `Apple on-device — ${appleFailureCopy(failure.reason)} · nothing saved`;
    case 'rejected':
      // The 2026-07-27 lesson said out loud: unusable output is a REPORTED
      // outcome, not a silent save.
      return `unusable summary — ${rejectionCopy(failure.reason)} · nothing saved`;
    case 'save':
      return `save failed (${String(failure.status)})`;
  }
};

/**
 * "6/14 sections · 10.8k/42k chars" — every reduction the run applied, stated.
 * The chunk cap and the engine's INPUT cap are two different reductions and both
 * are reported in the same vocabulary; a summary shorter than the page deserves
 * an explanation, not a shrug.
 */
export const coverageCopy = (meta: GistMeta | null): string => {
  if (meta === null) return '';
  const parts: string[] = [];
  if (meta.passes !== 1 && meta.totalChunks > 1) {
    parts.push(`${String(meta.usedChunks)}/${String(meta.totalChunks)} sections`);
  }
  if (meta.inputReduced) parts.push(formatReduction(meta.processedChars, meta.inputChars));
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
};

/** The short engine name the row shows on the button and in the result line. */
export type EngineRunLabel = 'Nano' | 'Apple' | 'WebGPU' | 'Remote';

// Keyed by EngineKind (not a hand-listed subset) so adding an engine is a type
// error here until the surface can NAME it. A run the user cannot attribute to
// an engine is exactly the anonymity this row exists to prevent.
const RUN_LABEL: Record<EngineKind, EngineRunLabel> = {
  nano: 'Nano',
  apple: 'Apple',
  webgpu: 'WebGPU',
  remote: 'Remote',
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

const targetKeyOf = (target: EnrichmentTarget): string =>
  target.kind === 'url' ? `url:${target.canonicalUrl}` : `thread:${target.bacId}`;

// How long the full "done — gist saved · WebGPU · 1.2s" STATUS line stays
// before it settles into the quieter "gist saved · WebGPU" marker. This governs
// the one-line run report ONLY. The gist body itself never settles away — see
// the header note; hiding the generated text on a timer was the bug.
const RESULT_SETTLE_MS = 8000;

/** Lines of gist shown collapsed, before "more". Matches the CSS line clamp. */
const GIST_COLLAPSED_LINES = 2;

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
  onIndexPage,
  lanes,
  workstreams,
  testIdPrefix = 'now',
}: ContentEnrichmentActionProps): ReactElement {
  const [phase, setPhase] = useState<EnrichmentPhase>('idle');
  const [gist, setGist] = useState<string | null>(null);
  // Which link of the input chain fed the model — drives the honest "gist from
  // page features" caveat. Null when unknown (a legacy string fetcher).
  const [gistSource, setGistSource] = useState<EnrichmentInputSource | null>(null);
  // True when the displayed gist came back from device storage rather than from
  // a run in this session — the row says "saved earlier" rather than implying
  // it was just generated.
  const [gistFromStore, setGistFromStore] = useState(false);
  const [gistEngine, setGistEngine] = useState<string | null>(null);
  const [gistExpanded, setGistExpanded] = useState(false);
  const [failure, setFailure] = useState<EnrichmentFailure | null>(null);
  // Which engine actually ran, and how long it took — the result line names
  // both so "gist saved" is attributable, not anonymous.
  const [ranOn, setRanOn] = useState<EngineRunLabel | null>(null);
  // Set for the duration of a REMOTE run so the privacy marker keeps naming the
  // host even after the run ends. Content that left the device stays disclosed.
  const [ranRemoteHost, setRanRemoteHost] = useState<string | null>(null);
  // The limits of the engine that actually ran, so the row states real numbers
  // rather than the pre-run guess.
  const [ranLimits, setRanLimits] = useState<EngineLimits | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  // How much of the document the run actually covered — stated, not implied.
  const [meta, setMeta] = useState<GistMeta | null>(null);

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
  const engineLabel: EngineRunLabel | null =
    availability === undefined && activeEngineLabel !== undefined
      ? activeEngineLabel
      : route.engine === null
        ? null
        : RUN_LABEL[route.engine];
  // The limits shown BEFORE a run: the routed engine's, from the same table the
  // run will use. After a run, the engine that actually ran wins.
  const routedLimits: EngineLimits | null =
    ranLimits ?? (route.engine === null ? null : limitsFor(route.engine));
  // The host the row must name whenever text would leave — or has left — the
  // device. Pre-run it comes from the availability snapshot; post-run from the
  // run itself, so the disclosure outlives the routing state.
  const remoteHost: string | null =
    ranRemoteHost ??
    (route.engine === 'remote' && typeof availability?.remoteHost === 'string'
      ? availability.remoteHost
      : route.engine === 'remote'
        ? 'the configured provider'
        : null);

  const targetKey = targetKeyOf(target);
  const targetKeyRef = useRef(targetKey);
  // The key whose gist THIS session generated. The device-store read is async,
  // so a slow read that lands after a fast run must not overwrite the fresher
  // text with the older remembered one.
  const freshRunKeyRef = useRef<string | null>(null);
  /**
   * Mirror of what the row is CURRENTLY showing, so an optimistic display can
   * be rolled back. A run callback outlives the render that built it, so
   * reading `gist` from the closure would restore whatever was on screen when
   * the callback was created — not what is there when the save fails.
   */
  const shownGistRef = useRef<{
    gist: string | null;
    source: EnrichmentInputSource | null;
    fromStore: boolean;
    engine: string | null;
  } | null>(null);
  // Kept in sync on every render — cheap, and it cannot go stale the way a
  // closure capture would.
  shownGistRef.current = { gist, source: gistSource, fromStore: gistFromStore, engine: gistEngine };
  const busy = phase === 'fetching' || phase === 'generating' || phase === 'saving';
  // A new surface must not keep the previous one's result, and must pick up
  // whatever gist that surface already has. An in-flight run notices the key
  // change after its next await and reports 'cancelled'.
  //
  // The remembered gist is read on MOUNT too — returning to an enriched page
  // shows its gist without generating anything, which is half of "make the gist
  // persist" (the other half is that it never auto-hides).
  useEffect(() => {
    if (targetKeyRef.current !== targetKey) {
      targetKeyRef.current = targetKey;
      freshRunKeyRef.current = null;
      setGist(null);
      setGistSource(null);
      setGistFromStore(false);
      setGistEngine(null);
      setGistExpanded(false);
      setFailure(null);
      setRanOn(null);
      setRanRemoteHost(null);
      setRanLimits(null);
      setElapsedMs(null);
      setSettled(false);
      setMeta(null);
      setPhase((prev) =>
        prev === 'fetching' || prev === 'generating' || prev === 'saving' ? prev : 'idle',
      );
    }
    let active = true;
    void readStoredGist(targetKey)
      .then((stored) => {
        if (!active || targetKeyRef.current !== targetKey) return;
        // A run in this session already answered for this surface — keep it.
        if (freshRunKeyRef.current === targetKey) return;
        if (stored === null || stored.gist.trim().length === 0) return;
        setGist(stored.gist);
        setGistSource(stored.source ?? null);
        setGistEngine(stored.engine ?? null);
        setGistFromStore(true);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
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
    // The gist on screen is NOT cleared here. It is the page's current saved
    // gist until a new one replaces it — a regenerate that fails must not also
    // take away the text the user already had.
    setFailure(null);
    setRanOn(null);
    setRanRemoteHost(null);
    setRanLimits(null);
    setElapsedMs(null);
    setMeta(null);
    const stale = (): boolean => targetKeyRef.current !== myKey;
    const cancel = (): void => {
      setPhase('error');
      setFailure({ kind: 'cancelled' });
    };
    try {
      // The chain (indexed text → already-extracted page features → live
      // extract) lives in the host's fetcher; what comes back tells us WHICH
      // link answered, so a thin input can be labelled instead of passed off as
      // a read of the page.
      const input = normalizeEnrichmentText(await fetchText(target));
      const text = input.text;
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
      const engineLimits = engineLimitsOf(engine);
      setRanOn(RUN_LABEL[engine.kind]);
      setRanLimits(engineLimits);
      // A remote run is DISCLOSED from the moment it starts, not after it ends:
      // the marker must be on screen while the text is in flight.
      if (engine.kind === 'remote') {
        setRanRemoteHost(
          typeof availability?.remoteHost === 'string' && availability.remoteHost.length > 0
            ? availability.remoteHost
            : 'the configured provider',
        );
      }
      setPhase('generating');
      // Chunk-then-synthesize + output validation. NOTHING generated here
      // reaches the companion unvalidated (gistSynthesis.ts / validateGeneration.ts).
      // The engine's own input/output caps are enforced by the synthesis path.
      let outcome: Awaited<ReturnType<typeof synthesizeGist>>;
      try {
        outcome = await synthesizeGist(engine, text, engineLimits);
      } catch (err) {
        if (stale()) {
          cancel();
          return;
        }
        setPhase('error');
        const remoteKind = remoteFailureKindOf(err);
        const appleKind = appleFailureKindOf(err);
        setFailure(
          remoteKind !== null
            ? { kind: 'remote', reason: remoteKind }
            : appleKind !== null
              ? { kind: 'apple', reason: appleKind }
              : { kind: 'engine', detail: String(err) },
        );
        return;
      }
      if (stale()) {
        cancel();
        return;
      }
      setMeta(outcome.meta);
      if (!outcome.ok) {
        if (outcome.kind === 'rejected') {
          setPhase('error');
          setFailure({ kind: 'rejected', reason: outcome.reason });
          return;
        }
        setPhase('skipped');
        return;
      }
      const generated = outcome.gist;
      // What is on screen right now, so a FAILED save can put it back. Captured
      // through refs rather than closure state because this callback outlives
      // the render that created it.
      const displacedGist = shownGistRef.current;
      // SHOW THE GIST BEFORE SAVING IT, not after.
      //
      // The text is fully known the instant generation returns; the save is a
      // round-trip to the companion that the reader has no stake in. Holding
      // the answer back until the POST resolved meant staring at "saving…"
      // while the thing you asked for already existed in memory.
      //
      // The engine label goes up with it so the line is attributable from the
      // first frame rather than becoming attributable a moment later. What is
      // deliberately NOT set yet is the SAVED state (gistFromStore /
      // freshRunKeyRef / stored copy): those say "this is durably filed", which
      // is not true until the POST returns. Showing early must not claim early.
      setGist(generated);
      setGistSource(input.source);
      setGistFromStore(false);
      setGistEngine(RUN_LABEL[engine.kind]);
      setPhase('saving');
      const item: ContentEnrichmentPayloadItem = {
        kind: target.kind,
        id: target.kind === 'url' ? target.canonicalUrl : target.bacId,
        gist: generated,
        sourceContentHash: contentHashOf(text),
        // Provenance from the engine's DECLARED identity — the local model is
        // selectable now, so a hardcoded 'gemma-3-1b-it' would mislabel a 4B run.
        model: engineIdentityOf(engine).modelName,
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
        // A FAILURE TAKES NOTHING AWAY. The new gist was shown optimistically
        // while the save was in flight; the save did not land, so it is not
        // durable and must not be left standing in place of a gist that IS.
        // Put the previous one back rather than leaving the user looking at
        // text that silently will not survive a reload.
        setGist(displacedGist?.gist ?? null);
        setGistSource(displacedGist?.source ?? null);
        setGistFromStore(displacedGist?.fromStore ?? false);
        setGistEngine(displacedGist?.engine ?? null);
        setPhase('error');
        setFailure({ kind: 'save', status: res.status });
        return;
      }
      // The gist is already on screen (set before the POST). What becomes true
      // only NOW is that it is durably saved.
      freshRunKeyRef.current = myKey;
      setElapsedMs(Date.now() - startedAt);
      setPhase('done');
      // Remember it on THIS device so returning to the page shows the gist
      // again. The companion owns the gist (it feeds the content lane) but
      // exposes no read-back route, so the panel keeps its own copy rather than
      // showing the user nothing on the next visit. Best-effort, never blocks.
      void writeStoredGist(myKey, {
        gist: generated,
        engine: RUN_LABEL[engine.kind],
        model: item.model,
        source: input.source,
        savedAt: item.generatedAt,
      });
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
  }, [target, port, bridgeKey, fetchText, onEnriched, availability?.remoteHost]);

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
  // The button's own words. The ACTION is the label; the engine is a
  // subordinate, dimmer suffix inside the same control (it is context, not the
  // verb). Busy states replace the whole thing with the live phase.
  const buttonAction = busy ? PHASE_COPY[phase] : gist === null ? 'Enrich content' : 'Regenerate gist';
  // Origin of the gist on screen: when it was made, on what, and — the honest
  // part — whether the model only ever saw the page's features.
  const gistOriginNote = sourceNoteOf(gistSource);
  const gistOrigin = [
    gistFromStore ? 'saved earlier' : 'just generated',
    gistFromStore ? gistEngine : (ranOn ?? gistEngine),
    gistOriginNote,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' · ');
  // The gist ↔ guess connection, from the gist's side. Reads the SAME '· gist'
  // marker the Content lane row reads, so the two directions cannot disagree.
  const influence = gistInfluenceFrom(lanes, workstreams ?? []);
  const provenanceLine = gistProvenanceLine(influence);
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
            }${coverageCopy(meta)}`
        : PHASE_COPY[phase];

  return (
    <div className="enrich-row" data-testid={`${testIdPrefix}-enrich-content`}>
      <div className="enrich-row-head">
        <span className="enrich-row-state mono" id={stateId} data-testid={stateId}>
          {stateLine}
        </span>
        {/* The active engine's caps, stated up front. "limits: 2k in / 140 tok
            out" — so a two-sentence summary of a 40k-char page is explicable
            before the user wonders whether the model read the whole thing. */}
        {routedLimits !== null ? (
          <span
            className="enrich-row-limits mono"
            title={routedLimits.note}
            data-testid={`${testIdPrefix}-enrich-limits`}
          >
            {formatEngineLimits(routedLimits)}
          </span>
        ) : null}
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
        {/* The run control. Secondary weight — a pill in the panel's own idiom
            (the pipeline strip / guess-lane family), not a plain bordered box —
            with the engine name as a smaller, dimmer suffix INSIDE the button
            so "which model would run this" stays attached to the action without
            competing with it. Narrow-panel safe: the head row wraps, the pill
            never sets a width. Disabled still carries the reason (title) and is
            still described by the state line (aria-describedby). */}
        <button
          type="button"
          className="enrich-run-btn"
          onClick={() => {
            void run();
          }}
          disabled={blocked || busy}
          title={buttonTitle}
          aria-describedby={stateId}
          data-testid={`${testIdPrefix}-enrich-content-btn`}
        >
          <span className="enrich-run-btn-label">{buttonAction}</span>
          {!busy && engineLabel !== null ? (
            <span className="enrich-run-btn-engine mono">
              {' · '}
              {engineLabel}
            </span>
          ) : null}
        </button>
      </div>
      {/* THE PRIVACY MARKER. Rendered whenever the remote engine is the routed
          engine (text is about to leave) or actually ran (text has left). It
          names the host, never disappears while that is true, and is not a
          tooltip — an off-device transfer must be readable without hovering. */}
      {remoteHost !== null ? (
        <div
          className="enrich-row-remote-warning mono"
          role="note"
          title={remotePrivacyDetail(remoteHost)}
          data-testid={`${testIdPrefix}-enrich-remote-warning`}
        >
          {remotePrivacyMarker(remoteHost)}
        </div>
      ) : null}
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
        <div className="enrich-row-statusline">
          <span
            className={`enrich-row-status mono${settled && phase === 'done' ? ' is-settled' : ''}`}
            data-testid={`${testIdPrefix}-enrich-content-status`}
          >
            {statusText}
          </span>
          {/* The ONLY place the user is asked to index — after the chain found
              no stored text AND no extracted features. The action is offered
              right here rather than described, so the fix is one click from the
              reason. */}
          {phase === 'error' &&
          failure?.kind === 'no-text' &&
          target.kind === 'url' &&
          onIndexPage !== undefined ? (
            <button
              type="button"
              className="enrich-row-link"
              onClick={onIndexPage}
              title="Extract and index this page's text, then enrichment can read it"
              data-testid={`${testIdPrefix}-enrich-index-page`}
            >
              Index this page
            </button>
          ) : null}
        </div>
      ) : null}
      {/* THE GIST. Rendered whenever there is one — from this run or from the
          last one on this page — and it does NOT go away on a timer. Clamped to
          two lines with a more/less toggle so a long gist stays compact in a
          340px panel without hiding itself. */}
      {gist !== null ? (
        <div className="enrich-gist" data-testid={`${testIdPrefix}-enrich-gist-block`}>
          <div
            className={`enrich-row-gist mono${gistExpanded ? ' is-expanded' : ''}`}
            style={{ WebkitLineClamp: gistExpanded ? 'unset' : GIST_COLLAPSED_LINES }}
            data-testid={`${testIdPrefix}-enrich-content-gist`}
          >
            {gist}
          </div>
          <div className="enrich-gist-foot">
            <button
              type="button"
              className="enrich-row-link"
              onClick={() => {
                setGistExpanded((prev) => !prev);
              }}
              aria-expanded={gistExpanded}
              title={gistExpanded ? 'Collapse the gist' : 'Show the whole gist'}
              data-testid={`${testIdPrefix}-enrich-gist-toggle`}
            >
              {gistExpanded ? 'less' : 'more'}
            </button>
            <span
              className="enrich-gist-origin mono"
              data-testid={`${testIdPrefix}-enrich-gist-origin`}
            >
              {gistOrigin}
            </span>
          </div>
          {/* Provenance, gist → guess. States which guess(es) this gist is
              feeding (or that it feeds none yet) and refuses the causal
              upgrade: the gist is part of the lane's QUERY TEXT. */}
          <div
            className="enrich-gist-provenance"
            title={GIST_LANE_MARKER_TITLE}
            data-testid={`${testIdPrefix}-enrich-gist-provenance`}
          >
            {provenanceLine}
          </div>
        </div>
      ) : null}
    </div>
  );
}
