// Guess lane 9 — 'prototype': pure vector KNN against OFFLINE, per-workstream
// generated prototype texts (docs/plans/2026-08-16-category-flexibility-hyde.md
// §3). See workstreams/prototypeGeneration.ts for how the prototype texts are
// produced (offline, on a background cadence, Apple FM or evidence
// selection) — this module is ONLY the serve-time read side: embed the
// incoming page's own title+gist once, KNN it against prototype_vec, group by
// workstream, done. NO LLM call ever happens on this path — the design doc's
// "serve-time = pure vector match" contract, verbatim.
//
// DISCLOSURE ONLY, exactly like lanes 7/8 (see contentLane.ts's header for
// the shared idiom this mirrors: idempotent replace-by-lane-id, typed
// emptiness, no I/O beyond one bounded embed + one KNN). laneCorroboration.ts
// and laneFallback.ts both hardcode their lane set to ['content','ai'], so
// this lane's opinion is structurally unable to influence a resolve decision
// in this PR — see goldenResolveCases.test.ts's "prototype-disclosure-never-
// decides" case for a frozen regression guard on exactly that property.

import type { GuessLaneCandidate, GuessLaneResult } from './guessLanes.js';

// ---- env flag ---------------------------------------------------------

export const PROTOTYPE_LANE_ENV = 'SIDETRACK_PROTOTYPE_LANE';

/**
 * Default ON. This departs from the design doc's literal §3 text ("default
 * OFF — observe-first, the same rule declineMemory.ts states... and PR #288
 * established for lanes generally") on EXPLICIT instruction (2026-08-16
 * follow-up directive) — recorded here so it is a decision, not a silent
 * drift from the doc.
 *
 * The instruction is consistent with, not a departure from, how every OTHER
 * guess-lane flag in this codebase actually defaults: SIDETRACK_GUESS_LANES,
 * SIDETRACK_CONTENT_LANE, SIDETRACK_LANE_PREQUENTIAL and
 * SIDETRACK_LANE_CORROBORATION are ALL default-ON kill switches, not opt-ins
 * — "observe-first" in this codebase means "compute and disclose by
 * default, promote only once measured", not "off by default". This lane
 * carries the identical safety property lane 7/8's corroboration promotion
 * does: laneCorroboration.ts/laneFallback.ts hardcode their lane set and
 * cannot read 'prototype' opinions, so enabling computation+disclosure here
 * changes zero served decisions — only what the panel's lane-disclosure
 * strip shows. Kept independently kill-switchable in case a live vault's
 * generated prototypes turn out surprising enough to want an instant
 * rollback that does not also touch content/ai.
 */
export const prototypeLaneEnabled = (): boolean => {
  const raw = process.env[PROTOTYPE_LANE_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- promotion-gate PREP (design doc §3's 4-part laneCorroboration.ts
// extension contract) -----------------------------------------------------
//
// Part (1) — prequential identity + outcome join — needs NO new code: adding
// 'prototype' to the GuessLane union (guessLanes.ts) is sufficient, because
// lanePrequential.ts's LanePredictionRecord/scoreLanePredictions/
// lanePrecisionFrom are already generic over the lane id string. As soon as
// server.ts appends this lane's result into `result.lanes`, the SAME
// recordLanePredictions/stampLanePredictionOpportunities call sites that
// already run for every lane start accruing 'prototype' precision — no
// prototype-specific wiring needed.
//
// Part (2) — an explicit precision/sample threshold, measured FRESH (design
// doc: "not inherited from LANE_CORROBORATION_MIN_PRECISION/MIN_SAMPLES —
// those numbers are for content/ai"). Declared here so the numbers exist and
// are nameable, but — matching the task scope — NOT wired into
// applyLaneCorroboration's LANE_CORROBORATION_LANES tuple. That wiring is the
// actual promotion and is explicitly Phase 3 ("promotion itself is a later
// decision, not this PR" — design doc §3/§7). Until then these constants are
// read by nothing except this lane's own tests and (once Phase 3 lands) the
// eventual prototype-specific corroboration check.
export const PROTOTYPE_LANE_MIN_PRECISION = 0.6;
export const PROTOTYPE_LANE_MIN_SAMPLES = 20;

// Part (4) — declared max action. A lane that has never been measured must
// never auto-file; capped the same way LANE_CORROBORATION_MAX_ACTION is.
export const PROTOTYPE_LANE_MAX_ACTION = 'suggest' as const;

// Part (3) — a golden failure case — lives in
// src/eval/goldenResolveCases.test.ts ("golden case 5 — prototype-disclosure-
// never-decides"), not here (that file is the frozen regression net; see its
// own header for why cases live there and not beside the lane they cover).

// ---- injectable store dep ----------------------------------------------

/** Structural subset of the recall-v2 sqlite store's prototype read path
 *  (see recall-v2/store/sqlite.ts's queryPrototypeVector). Mirrors
 *  ContentLaneStore's precedent: consumer declares the narrow shape it
 *  needs, production casts the concrete store to it. */
export interface PrototypeLaneStore {
  readonly vectorBackendAvailable: boolean;
  queryPrototypeVector(opts: { readonly vec: Float32Array; readonly limit: number }): readonly {
    readonly prototypeId: string;
    readonly workstreamId: string;
    readonly cosineDistance: number;
  }[];
}

export type PrototypeLaneEmbed = (text: string) => Promise<Float32Array | undefined>;

const KNN_LIMIT = 24;
const MAX_LANE_CANDIDATES = 3;

const typedEmpty = (emptyReason: string): GuessLaneResult => ({
  lane: 'prototype',
  candidates: [],
  emptyReason,
});

/**
 * L2 distance → cosine similarity, valid because recall-v2's embeddings are
 * L2-normalized (recall/embedder.ts: "e5 outputs are normalized") and
 * prototype_vec/docs_vec both use sqlite-vec's default (L2) distance metric
 * — for unit vectors, ||a-b||² = 2 − 2·cos_sim, so cos_sim = 1 − ||a-b||²/2.
 * Clamped for float-error safety.
 */
const cosineSimilarityFromL2 = (l2Distance: number): number => {
  const sim = 1 - (l2Distance * l2Distance) / 2;
  return sim < 0 ? 0 : sim > 1 ? 1 : sim;
};

export interface BuildPrototypeLaneInput {
  readonly title: string | null;
  readonly gist?: string | null;
  readonly store: PrototypeLaneStore | undefined;
  readonly embed?: PrototypeLaneEmbed | undefined;
  readonly embedderUsable: boolean;
}

/**
 * Pure vector KNN — no LLM call, no ranking beyond similarity. Query text is
 * the same gist-leads-title composition the content lane uses (gist carries
 * more topical signal when present); a page with neither yields typed
 * emptiness rather than an embed of nothing.
 */
export const buildPrototypeLane = async (
  input: BuildPrototypeLaneInput,
): Promise<GuessLaneResult> => {
  if (input.store === undefined) return typedEmpty('recall store unavailable');
  if (!input.store.vectorBackendAvailable) return typedEmpty('vector backend unavailable');

  const gist = input.gist ?? null;
  const queryText = `${gist ?? ''} ${input.title ?? ''}`.trim();
  if (queryText.length === 0) return typedEmpty('no title or gist to compare');
  if (!input.embedderUsable || input.embed === undefined) {
    return typedEmpty('embedder cold — cannot compare');
  }

  let vec: Float32Array | undefined;
  try {
    vec = await input.embed(queryText);
  } catch {
    vec = undefined;
  }
  if (vec === undefined) return typedEmpty('embedder cold — cannot compare');

  let hits: readonly {
    readonly prototypeId: string;
    readonly workstreamId: string;
    readonly cosineDistance: number;
  }[];
  try {
    hits = input.store.queryPrototypeVector({ vec, limit: KNN_LIMIT });
  } catch {
    hits = [];
  }
  if (hits.length === 0) {
    return typedEmpty('no prototypes generated for any workstream yet');
  }

  const perWorkstream = new Map<string, { best: number; count: number }>();
  for (const hit of hits) {
    const sim = cosineSimilarityFromL2(hit.cosineDistance);
    const agg = perWorkstream.get(hit.workstreamId);
    if (agg === undefined) {
      perWorkstream.set(hit.workstreamId, { best: sim, count: 1 });
    } else {
      agg.count += 1;
      if (sim > agg.best) agg.best = sim;
    }
  }

  const candidates: GuessLaneCandidate[] = [...perWorkstream.entries()]
    .map(([workstreamId, agg]) => ({
      workstreamId,
      score: agg.best < 0 ? 0 : agg.best > 1 ? 1 : agg.best,
      why: `closest of ${String(agg.count)} matching generated prototype${agg.count === 1 ? '' : 's'}, similarity ${agg.best.toFixed(2)}`,
    }))
    .sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.workstreamId < right.workstreamId
          ? -1
          : left.workstreamId > right.workstreamId
            ? 1
            : 0,
    )
    .slice(0, MAX_LANE_CANDIDATES);

  return { lane: 'prototype', candidates };
};

// ---- serve-side orchestration -------------------------------------------

export interface ResultWithLanes {
  readonly lanes?: readonly GuessLaneResult[];
}

export interface AppendPrototypeLaneDeps {
  readonly store: PrototypeLaneStore | undefined;
  readonly embed?: PrototypeLaneEmbed | undefined;
  readonly embedderUsable: boolean;
  readonly guessLanesEnabled: boolean;
}

/**
 * Append the prototype lane to a resolve result. Idempotent (replaces any
 * prior 'prototype' entry rather than duplicating — same rule
 * appendContentLane/appendAiLane follow). No-op, leaving `lanes` untouched,
 * when the parent SIDETRACK_GUESS_LANES flag or SIDETRACK_PROTOTYPE_LANE is
 * off, or the result carried no `lanes` array at all.
 */
export const appendPrototypeLane = async <T extends ResultWithLanes>(
  result: T,
  input: { readonly title: string | null; readonly gist?: string | null },
  deps: AppendPrototypeLaneDeps,
): Promise<T> => {
  if (!deps.guessLanesEnabled || !prototypeLaneEnabled() || result.lanes === undefined) {
    return result;
  }
  let lane: GuessLaneResult;
  try {
    lane = await buildPrototypeLane({
      title: input.title,
      ...(input.gist === undefined ? {} : { gist: input.gist }),
      store: deps.store,
      ...(deps.embed === undefined ? {} : { embed: deps.embed }),
      embedderUsable: deps.embedderUsable,
    });
  } catch {
    lane = typedEmpty('recall store unavailable');
  }
  const withoutPrototype = result.lanes.filter((existing) => existing.lane !== 'prototype');
  return { ...result, lanes: [...withoutPrototype, lane] };
};
