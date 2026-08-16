// Attribution arm switch — the served URL-resolve entry point (M6).
//
// `resolveUrlAttributionArmed` is a drop-in for the incumbent
// resolveUrlAttribution at the serve call sites. Behind SIDETRACK_ATTRIBUTION_ARM
// it selects which model's decision serves:
//   - 'v1' (a.k.a. 'incumbent'): the graph-resolver (PPR + similarity + cluster
//     + fusion + policy) — the pre-M6 behavior, unchanged byte-for-byte.
//   - 'vote3'/'vote4' (DEFAULT): the servable vote arm (serve.ts), which
//     reproduces the frozen-baseline win the incumbent leaves on the table
//     (45.9% top1 vs the incumbent-shadow v1's 8.8% / 86% abstain on the eval
//     harness — see serve.ts + eval/prequential.test.ts).
//
// The vote arm's output is the SAME UrlResolutionResult shape, so it flows
// through the round-guard stack (urls/autoApply.ts grace-window / ignored /
// existing-attribution / idempotency / skipped-policy) and the inferred-payload
// builder unchanged — verified by the route tests, not assumed.
//
// REVERSE SHADOW. When the vote arm serves, we also compute the incumbent's
// answer and record agreement into the armShadow counter (the M1-mirror safety
// net). That re-adds the PPR cost the vote arm avoids, so it is gated behind the
// existing SIDETRACK_ATTRIBUTION_V1_SHADOW flag (default ON) — droppable if it
// shows up in the resolve p95. The comparison never affects the served result.
//
// COST TRADEOFF (default ON): with the shadow ON, every cache-miss resolve pays
// the incumbent's full graph cost (PPR + similarity + cluster) purely for the
// agreement tally, forfeiting the cheap-vote-arm CPU win in steady state. This
// is the RIGHT default during the post-flip watch window — the reverse shadow
// is the primary safety net that surfaces vote-vs-incumbent divergence while the
// flip is fresh. Once the flip is trusted, set SIDETRACK_ATTRIBUTION_V1_SHADOW=0
// to realize the vote arm's cheap-resolve savings (the resolve-flood the
// vault-downtime work flagged). The latency canary already passes
// skipReverseShadow:true so the health gauge reflects the shadow-free served
// cost regardless of this flag.

import {
  loadAttributionV1State,
  titleForCanonicalUrlWithSource,
  type TitleWithSource,
} from './emit.js';
import { queueReverseShadow } from './reverseShadowDefer.js';
import { attributionV1ShadowEnabled } from './shadow.js';
import {
  attributionArm,
  resolveUrlAttributionVote3,
  workstreamOf,
  type Vote3TombstoneGate,
} from './serve.js';
import {
  resolveUrlAttribution,
  type ResolveUrlAttributionInput,
  type UrlResolutionResult,
} from '../tabsession/resolver.js';
import {
  buildGuessLanes,
  guessLanesEnabled,
  voteSignalsFor,
  type GuessLaneVoteSignals,
} from '../tabsession/guessLanes.js';

export interface ArmedResolveInput extends ResolveUrlAttributionInput {
  // The vault root — needed to load the drain-time AttributionV1State the vote
  // arm reads. When absent (or the artifact is stale/missing) the arm switch
  // fails safe to the incumbent for that resolve.
  readonly vaultRoot?: string;
  readonly now?: () => Date;
  // The domain-tombstone privacy gate (F1). Threaded in by the serve route from
  // its cached tombstone set so the vote arm — a new serve boundary — honors the
  // same HIDE gate the incumbent gets for free (purged nodes scrubbed from the
  // snapshot by scope recompute). Absent ⇒ no tombstones applied.
  readonly tombstones?: Vote3TombstoneGate;
  // When true, skip the reverse incumbent shadow even if the shadow flag is on.
  // Used by the latency canary so the probe times the SERVED arm's cost, not
  // the served arm PLUS the shadow incumbent (which would inflate the gauge and
  // mis-attribute the shape). The served result is identical either way.
  readonly skipReverseShadow?: boolean;
  // The live page title supplied by the panel (batch-resolve `titleHints`).
  // FIRST in the title fallback order (titleHint → visit-record latestTitle /
  // snapshot lookup) so the title lane matches on the CURRENT page title even
  // before the snapshot has recorded it. Absent ⇒ snapshot lookup as before.
  readonly titleHint?: string;
  // Title-enrichment overlay (url kind): the panel's on-device synthesized
  // title for a junk-titled visit. LAST in the title fallback order — used
  // only when neither a live titleHint nor a real snapshot title/label exists
  // (titleForCanonicalUrl applies it before returning undefined). The caller
  // resolves it once per batch from the folded enrichment lookup; absent ⇒
  // exact prior behavior. Never overwrites a real title.
  readonly synthesizedTitle?: string;
}

// Resolve a URL under the configured serving arm. Async because the vote arm
// loads the memoized state (a cheap fs.stat once warm — see emit.ts). Falls back
// to the incumbent on any vote-arm unavailability (no vault root, no fresh
// artifact) so the serve path never hard-depends on the artifact being present.
export const resolveUrlAttributionArmed = async (
  input: ArmedResolveInput,
): Promise<UrlResolutionResult> => {
  const { vaultRoot, now, tombstones, skipReverseShadow, titleHint, synthesizedTitle, ...resolverInput } =
    input;

  // Guess lanes (SIDETRACK_GUESS_LANES, default ON) need the cheap vote signals
  // (title/domain/recency) which read the memoized AttributionV1State. Load it
  // once here — the SAME memoized load the vote arm + shadow already pay — so
  // BOTH the incumbent and vote paths surface the vote lanes without a second
  // state read. When lanes are off (or there's no vault root) we skip the load
  // entirely on the pure-incumbent fast path.
  const wantLanes = guessLanesEnabled();

  if (attributionArm() === 'v1' || vaultRoot === undefined) {
    // Incumbent serves. When lanes are on and we have a vault root, load the
    // state and hand the vote signals to the resolver so it builds all six
    // lanes (graph/similarity/topic from its own evidence + title/domain/recency
    // from these signals). No vault root ⇒ no state ⇒ the three vote lanes
    // report typed emptiness (the resolver still emits the graph lanes).
    const voteSignals =
      wantLanes && vaultRoot !== undefined
        ? await voteSignalsForResolve(
            vaultRoot,
            now,
            resolverInput.snapshot,
            resolverInput.canonicalUrl,
            titleHint,
            synthesizedTitle,
          )
        : undefined;
    return resolveUrlAttribution({
      ...resolverInput,
      ...(voteSignals === undefined ? {} : { guessLaneVoteSignals: voteSignals }),
    });
  }

  const state = await loadAttributionV1State(vaultRoot, now ?? (() => new Date()));
  if (state === null) {
    // No fresh artifact — fail safe to the incumbent (same defensive posture as
    // the shadow lane's null-state skip). Lanes still emit (graph lanes from the
    // incumbent; the vote lanes report "no attribution state loaded").
    return resolveUrlAttribution(resolverInput);
  }

  // Resolve the title AND its provenance. A live titleHint (always a real page
  // title) wins first; else the snapshot lookup reports whether the value was
  // the synthesized (enrichment) fallback so the title lane can mark it.
  const resolved = resolveTitleWithSource(
    titleHint,
    resolverInput.snapshot,
    resolverInput.canonicalUrl,
    synthesizedTitle,
  );
  const title = resolved?.title ?? null;
  const titleSynthesized = resolved?.source === 'synthesized';
  const voteResult = resolveUrlAttributionVote3({
    state,
    canonicalUrl: resolverInput.canonicalUrl,
    title,
    ...(resolverInput.policyMode === undefined ? {} : { policyMode: resolverInput.policyMode }),
    ...(tombstones === undefined ? {} : { tombstones }),
  });

  // Reverse shadow: compare the incumbent's answer against the served vote
  // arm's and record agreement. Gated behind the v1-shadow flag so the
  // incumbent PPR cost is droppable.
  //
  // PERF (2026-08-16) — DEFERRED off the serve path, not computed inline.
  // Measured ~223ms/URL on the batch-resolve route (the incumbent pays the
  // full PPR + similarity + cluster cost purely for the agreement tally).
  // `resolverInput` is plain in-memory data (no live sqlite handle), safe to
  // hold until the deferred job runs; `workstreamOf(voteResult)` is cheap
  // (already-computed data, no PPR) so it is captured HERE rather than
  // recomputed later. Every sample still counts exactly once — see
  // reverseShadowDefer.ts for the full safety argument. The latency canary
  // passes skipReverseShadow: true and never reaches this branch, so its
  // measured cost is unaffected.
  if (skipReverseShadow !== true && attributionV1ShadowEnabled()) {
    queueReverseShadow(resolverInput, workstreamOf(voteResult));
  }

  // Attach the six guess lanes to the served vote result. The vote arm has no
  // graph/similarity/topic channel (those lanes report typed emptiness on this
  // path), but it DOES have the title/domain/recency vote signals — the same
  // state + title just used to decide the vote — so those three lanes are
  // populated from evidence already in hand. Gated on the flag; omitted when off.
  if (!wantLanes) return voteResult;
  const lanes = buildGuessLanes({
    candidateEvidence: [],
    voteSignals: voteSignalsFor(state, resolverInput.canonicalUrl, title, titleSynthesized),
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
  return { ...voteResult, lanes };
};

// Resolve the best-effort title AND its provenance for a resolve. A live
// titleHint (always a real page title) wins first; else the snapshot lookup —
// which reports 'synthesized' when the value is the enrichment overlay fallback.
// Returns undefined when there is no title at all (typed-empty title lane).
const resolveTitleWithSource = (
  titleHint: string | undefined,
  snapshot: ResolveUrlAttributionInput['snapshot'],
  canonicalUrl: string,
  synthesizedTitle: string | undefined,
): TitleWithSource | undefined => {
  const hint = normalizeTitleHint(titleHint);
  if (hint !== null) return { title: hint, source: 'real' };
  return titleForCanonicalUrlWithSource(snapshot, canonicalUrl, synthesizedTitle);
};

// Load the memoized AttributionV1State and assemble the vote-lane signals for a
// resolve (title looked up from the snapshot exactly as the vote arm + shadow
// do). Returns undefined when there is no fresh state — the caller then omits
// the vote signals and the three vote lanes report typed emptiness. Cheap: a
// warm memo is a single fs.stat plus the O(nodes) title scan the shadow already
// pays.
const voteSignalsForResolve = async (
  vaultRoot: string,
  now: (() => Date) | undefined,
  snapshot: ResolveUrlAttributionInput['snapshot'],
  canonicalUrl: string,
  titleHint: string | undefined,
  synthesizedTitle: string | undefined,
): Promise<GuessLaneVoteSignals | undefined> => {
  const state = await loadAttributionV1State(vaultRoot, now ?? (() => new Date()));
  if (state === null) return undefined;
  const resolved = resolveTitleWithSource(titleHint, snapshot, canonicalUrl, synthesizedTitle);
  const title = resolved?.title ?? null;
  const titleSynthesized = resolved?.source === 'synthesized';
  return voteSignalsFor(state, canonicalUrl, title, titleSynthesized);
};

// Trim + reject an empty title hint so the title fallback order (hint → snapshot
// lookup) treats "" the same as absent. URL-shaped hints are rejected too —
// a page whose "title" is its own URL gives the matcher only scheme/TLD
// tokens (same rule titleForCanonicalUrl applies to label fallbacks).
const normalizeTitleHint = (titleHint: string | undefined): string | null => {
  if (titleHint === undefined) return null;
  const trimmed = titleHint.trim();
  if (trimmed.length === 0 || /^https?:\/\//iu.test(trimmed)) return null;
  return trimmed;
};
