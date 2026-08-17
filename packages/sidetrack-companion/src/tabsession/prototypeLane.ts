// Guess lane 9 — 'prototype': vector KNN + keyword-profile blend against
// OFFLINE, per-workstream medoid/generated prototype texts
// (docs/plans/2026-08-16-category-flexibility-hyde.md §3 + §11 "prototype
// lane v2"). See workstreams/prototypeGeneration.ts for how the prototype
// texts are produced (offline, on a background cadence: medoid selection —
// the always-on default tier — plus, for English-dominant evidence with
// Apple FM available, a small synthetic-sibling generation/expansion tier)
// — this module is ONLY the serve-time read side: embed the incoming page's
// own title+gist once, KNN it against prototype_vec, blend in the keyword-
// profile signal, apply a contrast-margin honest-empty gate, group by
// workstream, done. NO LLM call ever happens on this path — the design
// doc's "serve-time = pure vector match" contract, verbatim.
//
// v2 CHANGES FROM v1 (§11):
//   - Per-source (medoid | generated | keyword) sub-scores are tracked
//     alongside the blended candidate score, and emitted as their OWN
//     prequential predictions (tabsession/lanePrequential.ts's generic,
//     GuessLane-independent raw-record writer) — the measurement that lets
//     a future promotion decide the blend by measured precision, not
//     judgment, per source AND per workstream population regime (sparse vs
//     mature — see prototypeGeneration.ts's sparse-workstream boost).
//   - CONTRAST-MARGIN GATE (prototypeContrastMargin.ts): the day-one bug —
//     three unrelated workstreams tying at ~0.82 because generic prototype
//     prose is close to every tech page — is fixed by ranking on MARGIN
//     over the page's own cross-workstream mean score, not raw score alone.
//     A near-tie is an honest empty ("no clearly closer workstream"), never
//     three confident-looking guesses.
//   - KEYWORD-PROFILE BLEND (prototypeKeywordProfile.ts): a discrete,
//     self-explaining signal (idf-weighted concept overlap with the
//     workstream's own keyword vocabulary) blended into the score,
//     env-weighted the same idiom as SIDETRACK_KEYWORD_CLUSTER_WEIGHT.
//
// DISCLOSURE ONLY, exactly like lanes 7/8 (see contentLane.ts's header for
// the shared idiom this mirrors: idempotent replace-by-lane-id, typed
// emptiness, no I/O beyond one bounded embed + one KNN + one cheap indexed
// keyword-profile read). laneCorroboration.ts and laneFallback.ts both
// hardcode their lane set to ['content','ai'], so this lane's opinion is
// structurally unable to influence a resolve decision in this PR — see
// goldenResolveCases.test.ts's "prototype-disclosure-never-decides" case for
// a frozen regression guard on exactly that property.

import type { GuessLaneCandidate, GuessLaneResult } from './guessLanes.js';
import type { LanePredictionRecord } from './lanePrequential.js';
import { recordRawLanePredictions } from './lanePrequential.js';
import {
  applyContrastMargin,
  contrastMarginEmptyReason,
  type ContrastCandidate,
} from '../workstreams/prototypeContrastMargin.js';
import {
  blendVectorAndKeywordScore,
  keywordMatchWhy,
  resolvePrototypeKeywordWeight,
  scorePageAgainstProfile,
  type PrototypeKeywordProfile,
} from '../workstreams/prototypeKeywordProfile.js';

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
// prototype-specific wiring needed. v2 ADDITIONALLY records three
// composite-id sub-predictions ('prototype:medoid' / 'prototype:generated'
// / 'prototype:keyword') via lanePrequential.ts's recordRawLanePredictions
// (generic over any string lane id, bypassing the GuessLane wire-contract
// union entirely — see that function's own doc comment) — see
// recordPerSourcePredictions below.
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

/** Structural subset of the recall-v2 sqlite store's prototype + keyword-
 *  profile read path (see recall-v2/store/sqlite.ts's queryPrototypeVector /
 *  getPrototypeKeywordIdf / getPrototypeKeywordProfile). Mirrors
 *  ContentLaneStore's precedent: consumer declares the narrow shape it
 *  needs, production casts the concrete store to it. The keyword-profile
 *  reads are OPTIONAL on the interface — a store/fixture that predates v2
 *  still satisfies it, and the lane degrades to pure vector scoring. */
export interface PrototypeLaneStore {
  readonly vectorBackendAvailable: boolean;
  queryPrototypeVector(opts: { readonly vec: Float32Array; readonly limit: number }): readonly {
    readonly prototypeId: string;
    readonly workstreamId: string;
    readonly cosineDistance: number;
    readonly angle?: 'medoid' | 'synthetic-sibling';
  }[];
  getPrototypeKeywordIdf?(): ReadonlyMap<string, number>;
  getPrototypeKeywordProfile?(workstreamId: string): PrototypeKeywordProfile | undefined;
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

// ---- per-workstream aggregation (v2: split by source) --------------------

interface WorkstreamAggregate {
  readonly workstreamId: string;
  count: number;
  vectorBest: number;
  medoidBest: number;
  generatedBest: number;
}

const newAggregate = (workstreamId: string): WorkstreamAggregate => ({
  workstreamId,
  count: 0,
  vectorBest: 0,
  medoidBest: 0,
  generatedBest: 0,
});

export interface BuildPrototypeLaneInput {
  readonly title: string | null;
  readonly gist?: string | null;
  readonly store: PrototypeLaneStore | undefined;
  readonly embed?: PrototypeLaneEmbed | undefined;
  readonly embedderUsable: boolean;
  /** v2 (§11) — this page's own concept ids, already resolved via the
   *  keyword-concept layer (enrichment/keywordConceptStore.ts). Optional:
   *  undefined means "not resolved for this request" — the keyword blend
   *  degrades to pure vector scoring for every candidate, the same
   *  "vectors only" fallback contract splitSuggestionEngine.ts's
   *  hybridSimilarity documents. READY-TO-SPLICE: the live server.ts call
   *  site does not thread this yet — see this file's landing note in the
   *  design doc for the exact follow-up. */
  readonly pageConceptIds?: readonly string[];
  /** v2 (§11) — for per-source prequential recording (recordRawLanePredictions).
   *  Both optional and BOTH required together for recording to fire — same
   *  ready-to-splice status as pageConceptIds. */
  readonly canonicalUrl?: string;
  readonly vaultRoot?: string;
}

/**
 * Pure vector KNN + keyword-profile blend + contrast-margin gate — no LLM
 * call, no ranking beyond these three signals. Query text is the same
 * gist-leads-title composition the content lane uses (gist carries more
 * topical signal when present); a page with neither yields typed emptiness
 * rather than an embed of nothing.
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
    readonly angle?: 'medoid' | 'synthetic-sibling';
  }[];
  try {
    hits = input.store.queryPrototypeVector({ vec, limit: KNN_LIMIT });
  } catch {
    hits = [];
  }
  if (hits.length === 0) {
    return typedEmpty('no prototypes generated for any workstream yet');
  }

  const perWorkstream = new Map<string, WorkstreamAggregate>();
  for (const hit of hits) {
    const sim = cosineSimilarityFromL2(hit.cosineDistance);
    const agg = perWorkstream.get(hit.workstreamId) ?? newAggregate(hit.workstreamId);
    agg.count += 1;
    if (sim > agg.vectorBest) agg.vectorBest = sim;
    if (hit.angle === 'medoid' && sim > agg.medoidBest) agg.medoidBest = sim;
    if (hit.angle === 'synthetic-sibling' && sim > agg.generatedBest) agg.generatedBest = sim;
    perWorkstream.set(hit.workstreamId, agg);
  }

  // ---- keyword-profile blend (v2 §11) -----------------------------------
  const idf = input.pageConceptIds !== undefined ? input.store.getPrototypeKeywordIdf?.() : undefined;
  const keywordWeight = resolvePrototypeKeywordWeight();
  const keywordScoreByWorkstream = new Map<
    string,
    { readonly score: number; readonly matchedConceptIds: readonly string[]; readonly displayKeyword: ReadonlyMap<string, string> }
  >();
  if (input.pageConceptIds !== undefined && idf !== undefined) {
    for (const workstreamId of perWorkstream.keys()) {
      const profile = input.store.getPrototypeKeywordProfile?.(workstreamId);
      if (profile === undefined) continue;
      const result = scorePageAgainstProfile(input.pageConceptIds, idf, profile);
      if (result.score > 0) {
        keywordScoreByWorkstream.set(workstreamId, { ...result, displayKeyword: profile.displayKeyword });
      }
    }
  }

  const blendedByWorkstream = new Map<string, number>();
  for (const [workstreamId, agg] of perWorkstream) {
    const keywordResult = keywordScoreByWorkstream.get(workstreamId);
    blendedByWorkstream.set(
      workstreamId,
      blendVectorAndKeywordScore(agg.vectorBest, keywordResult?.score ?? 0, keywordWeight),
    );
  }

  // ---- per-source prequential (v2 §11) — measurement, not disclosure ----
  // Fires regardless of the contrast-margin outcome below: an honest-empty
  // disclosure to the user does not mean each SOURCE has nothing to say —
  // the whole point of measuring per-source precision is to find out
  // whether medoid/generated/keyword alone would have been right, even on
  // pages where the BLEND was too close to call. AWAITED (not fire-and-
  // forget like server.ts's batch-level recordLanePredictions): this write
  // is one small local JSONL append (a few dozen bytes, one syscall), not a
  // network call or another KNN query — cheap enough that correctness
  // (never losing a measurement row to a process-exit race) outweighs the
  // sub-millisecond latency add. Never throws (recordPerSourcePredictions
  // catches internally).
  await recordPerSourcePredictions(input, perWorkstream, keywordScoreByWorkstream);

  // ---- contrast-margin gate (v2 §11) ------------------------------------
  const contrastCandidates: ContrastCandidate[] = [...blendedByWorkstream.entries()].map(
    ([workstreamId, score]) => ({ workstreamId, score }),
  );
  const contrastResult = applyContrastMargin(contrastCandidates);
  if (contrastResult.kept.length === 0) {
    return typedEmpty(contrastMarginEmptyReason(contrastResult));
  }

  const candidates: GuessLaneCandidate[] = contrastResult.kept.slice(0, MAX_LANE_CANDIDATES).map((c) => {
    const agg = perWorkstream.get(c.workstreamId)!;
    const keywordResult = keywordScoreByWorkstream.get(c.workstreamId);
    // UI-visibility phase (docs/plans/2026-08-16-category-flexibility-
    // hyde.md) — plain-language `why`, not the ML term "prototype": the
    // client already shows the matched workstream's NAME beside this
    // string (guess-lane-name), so this doesn't repeat it.
    const vectorWhy = `close to ${String(agg.count)} example${agg.count === 1 ? '' : 's'} generated for this workstream (${agg.vectorBest.toFixed(2)})`;
    const keywordWhy =
      keywordResult === undefined
        ? null
        : keywordMatchWhy(keywordResult.matchedConceptIds, keywordResult.displayKeyword);
    return {
      workstreamId: c.workstreamId,
      score: c.score,
      why: keywordWhy === null ? vectorWhy : `${vectorWhy}; ${keywordWhy}`,
    };
  });

  return { lane: 'prototype', candidates };
};

/**
 * Best-effort per-source predictions — the measurement that lets a future
 * promotion decide the medoid/generated/keyword blend by PRECISION, not
 * judgment (the brief's explicit requirement, §11 item 4). Reuses
 * lanePrequential.ts's generic raw-record writer (bypasses the GuessLane
 * wire-contract union entirely — these three composite ids are never
 * disclosed in `result.lanes`, only measured). No-op when
 * canonicalUrl/vaultRoot are absent (ready-to-splice — see this module's
 * header). Never throws (recordRawLanePredictions itself never rejects).
 */
const recordPerSourcePredictions = async (
  input: BuildPrototypeLaneInput,
  perWorkstream: ReadonlyMap<string, WorkstreamAggregate>,
  keywordScoreByWorkstream: ReadonlyMap<string, { readonly score: number }>,
): Promise<void> => {
  if (input.canonicalUrl === undefined || input.vaultRoot === undefined) return;
  const nowMs = Date.now();
  const records: LanePredictionRecord[] = [];

  // Union of both maps — a workstream can win the KEYWORD sub-prediction
  // with zero vector hits at all (it never entered `perWorkstream`), and
  // the three sources must be measured independently of each other.
  const candidateIds = new Set<string>([...perWorkstream.keys(), ...keywordScoreByWorkstream.keys()]);

  const pushWinner = (lane: string, scoreFor: (workstreamId: string) => number): void => {
    let bestId: string | null = null;
    let bestScore = 0;
    for (const workstreamId of candidateIds) {
      const score = scoreFor(workstreamId);
      if (score > bestScore) {
        bestScore = score;
        bestId = workstreamId;
      }
    }
    if (bestId !== null) {
      records.push({ u: input.canonicalUrl!, l: lane, w: bestId, t: nowMs });
    }
  };

  pushWinner('prototype:medoid', (id) => perWorkstream.get(id)?.medoidBest ?? 0);
  pushWinner('prototype:generated', (id) => perWorkstream.get(id)?.generatedBest ?? 0);
  pushWinner('prototype:keyword', (id) => keywordScoreByWorkstream.get(id)?.score ?? 0);

  if (records.length === 0) return;
  await recordRawLanePredictions(input.vaultRoot, records).catch(() => undefined);
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
  /** v2 (§11) — see BuildPrototypeLaneInput's matching fields. Threaded
   *  through deps (not input) since these are request-scoped context the
   *  caller assembles once per resolve, same shape as `store`/`embed`. */
  readonly vaultRoot?: string;
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
  input: {
    readonly title: string | null;
    readonly gist?: string | null;
    readonly canonicalUrl?: string;
    readonly pageConceptIds?: readonly string[];
  },
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
      ...(input.pageConceptIds === undefined ? {} : { pageConceptIds: input.pageConceptIds }),
      ...(input.canonicalUrl === undefined ? {} : { canonicalUrl: input.canonicalUrl }),
      ...(deps.vaultRoot === undefined ? {} : { vaultRoot: deps.vaultRoot }),
    });
  } catch {
    lane = typedEmpty('recall store unavailable');
  }
  const withoutPrototype = result.lanes.filter((existing) => existing.lane !== 'prototype');
  return { ...result, lanes: [...withoutPrototype, lane] };
};
