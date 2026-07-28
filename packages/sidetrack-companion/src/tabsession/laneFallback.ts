// Lane-fallback guess — a best guess on PARTIAL data, instead of "cannot guess".
//
// THE GAP (live, 2026-07-27). "AI Zero-Day Vulnerability Remediation and
// Security | JFrog" resolved with: the six STRUCTURAL lanes all typed-empty (no
// graph path, no engagement-gated similarity edges, no topic membership, no
// title/domain/recency vote), the CONTENT lane holding three ranked workstreams
// from real page-text retrieval, an AI gist generated and saved — and a card
// that said "In workstream: — / No confident pick", gate "held: no candidates
// reached fusion". The page-content evidence existed, was computed, was shown
// in the lane disclosure, and still the pick line rendered a dash. The standing
// directive: "returning cannot guess is absurd... should still return best
// guess on partial data" — with honest uncertainty labelling.
//
// WHY FUSION CANNOT DO THIS ITSELF. Guess lanes are DISCLOSURE-only by design:
// they never feed fusion (see guessLanes.ts / contentLane.ts). Lane 7/8 are
// query-time retrieval computed AFTER the resolver has already run and, on the
// batch route, after the resolver CACHE was written — folding them into fusion
// would mean re-scoring, re-gating, and staling the cache on every titleHint
// change. This module deliberately does none of that. It fills the *displayed
// pick* when fusion produced NOTHING, and nothing else.
//
// THE BOUNDARY, stated so it cannot drift:
//   - Trigger ONLY on a genuinely empty fusion: fusedCandidates.length === 0
//     AND decision.gate.reason === 'no-candidates'. Any candidate that DID
//     reach fusion (including one held by 'corroboration' / 'below-suggest' /
//     'margin-tie' / 'regret-budget') means fusion had an opinion — we never
//     override, reorder, or dilute real fusion output.
//   - decision.action, decision.workstreamId and decision.margin are returned
//     BYTE-IDENTICAL. Auto-apply is gated on decision.action === 'auto-apply'
//     (panel triggerUrlAutoApply + the companion's own POST resolve route), and
//     an untouched 'inbox' action means this can never file anything. The gate
//     REASON is preserved too — only `detail` gains a ' · lane-fallback shown'
//     suffix, which is free text rendered verbatim in the strip's verdict line
//     (no consumer parses it).
//   - Every synthesized candidate carries its provenance in reasons[0].summary,
//     prefixed with LANE_FALLBACK_WHY_PREFIX, so the panel can render the pick
//     as explicitly unconfirmed rather than as a confident suggestion.
//
// Applied to the SERVED copy only (server.ts calls it after appendAiLane, which
// is itself after the resolver-cache write), so nothing synthesized here is ever
// persisted or replayed as if the resolver had produced it.

import type { GuessLaneResult } from './guessLanes.js';
import type { AttributionAction, PolicyGate } from './policy.js';
import type { ResolverCandidate } from './resolver.js';

// ---- env flag ---------------------------------------------------------

export const LANE_FALLBACK_GUESS_ENV = 'SIDETRACK_LANE_FALLBACK_GUESS';

// Default ON. Only an explicit '0' / 'false' disables — same pattern as
// SIDETRACK_GUESS_LANES / SIDETRACK_CONTENT_LANE. Off ⇒ the result passes
// through untouched, i.e. exactly the pre-feature "No confident pick" card.
export const laneFallbackGuessEnabled = (): boolean => {
  const raw = process.env[LANE_FALLBACK_GUESS_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- provenance contract (read by the panel) ---------------------------

/** The stable prefix of a synthesized candidate's `reasons[0].summary`. The
 *  panel detects a lane-fallback pick by this prefix and renders it with
 *  explicitly uncertain copy ("Unconfirmed — from page content"), so it must
 *  not change without changing the extension's detector in the same commit. */
export const LANE_FALLBACK_WHY_PREFIX =
  'content-lane fallback — page-content evidence only, unconfirmed';

/** The suffix appended to the preserved gate detail. The gate REASON is
 *  untouched ('no-candidates' remains the truth about fusion); this only tells
 *  a reader of the verdict line that a fallback pick is being displayed. */
export const LANE_FALLBACK_GATE_SUFFIX = ' · lane-fallback shown';

// The two lanes this fallback may draw on. Both are query-time retrieval over
// the recall store: 'content' asks with gist + title + URL tokens, 'ai' asks
// with the gist ALONE. Deliberately NOT the six structural lanes — those are
// already inputs to the evidence fusion consumed, so promoting them here would
// be double-counting a signal fusion already judged insufficient. Content/AI
// evidence, by contrast, never reached fusion at all.
const FALLBACK_LANES: readonly GuessLaneResult['lane'][] = ['content', 'ai'];

// Cap — same MAX_LANE_CANDIDATES budget the lanes themselves use. The panel
// renders the top one as the pick and the rest as ranked possibilities.
const MAX_FALLBACK_CANDIDATES = 3;

// ---- the result shape this operates on ---------------------------------
//
// A structural subset of UrlResolutionResult / ResolutionResult, so this module
// does not import (and cannot be imported into a cycle with) resolver.ts's
// concrete result types. Both resolve wire shapes satisfy it.

export interface ResultWithFusion {
  readonly decision: {
    readonly action: AttributionAction;
    readonly workstreamId?: string;
    readonly margin: number;
    readonly gate?: PolicyGate;
  };
  readonly fusedCandidates: readonly ResolverCandidate[];
  readonly lanes?: readonly GuessLaneResult[];
}

// ---- ranking -----------------------------------------------------------

interface LaneAgreement {
  readonly workstreamId: string;
  // How many of the two fallback lanes named this workstream (1 or 2). The
  // PRIMARY sort key: a workstream both the content retrieval AND the gist-only
  // retrieval land on is corroborated by two independent queries over the same
  // corpus, which is the strongest thing this evidence can say.
  readonly laneCount: number;
  // Best lane-native score across the contributing lanes, clamped to [0,1].
  // Lane scores are already lane-native (cosine / RRF-normalized), NOT fusion
  // logits, so they are comparable within this set and nowhere else.
  readonly score: number;
  // Which lanes contributed, in FALLBACK_LANES order — rendered into the why.
  readonly lanes: readonly string[];
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

// Aggregate the content + ai lanes into per-workstream agreement rows, ranked
// both-lanes-first then by score then by id (deterministic ties — the same
// tie-break guessLanes.topN uses).
const rankLaneAgreement = (lanes: readonly GuessLaneResult[]): readonly LaneAgreement[] => {
  const byWorkstream = new Map<string, { score: number; lanes: string[] }>();
  for (const laneName of FALLBACK_LANES) {
    const lane = lanes.find((entry) => entry.lane === laneName);
    if (lane === undefined) continue;
    for (const candidate of lane.candidates) {
      if (candidate.workstreamId.length === 0) continue;
      const score = clamp01(Number.isFinite(candidate.score) ? candidate.score : 0);
      const existing = byWorkstream.get(candidate.workstreamId);
      if (existing === undefined) {
        byWorkstream.set(candidate.workstreamId, { score, lanes: [laneName] });
        continue;
      }
      // Same workstream seen in both lanes: keep the stronger lane-native score
      // and record the agreement.
      if (score > existing.score) existing.score = score;
      if (!existing.lanes.includes(laneName)) existing.lanes.push(laneName);
    }
  }
  return [...byWorkstream.entries()]
    .map(([workstreamId, entry]) => ({
      workstreamId,
      laneCount: entry.lanes.length,
      score: entry.score,
      lanes: entry.lanes,
    }))
    .sort((left, right) =>
      right.laneCount !== left.laneCount
        ? right.laneCount - left.laneCount
        : right.score !== left.score
          ? right.score - left.score
          : left.workstreamId < right.workstreamId
            ? -1
            : left.workstreamId > right.workstreamId
              ? 1
              : 0,
    )
    .slice(0, MAX_FALLBACK_CANDIDATES);
};

// The human provenance line. Leads with the frozen prefix (the panel's
// detector), then says which retrieval(s) produced it and how strongly — so a
// reader can tell a two-lane agreement at 0.71 from a lone content hit at 0.22.
const fallbackWhy = (row: LaneAgreement): string => {
  const lanes = row.lanes.join(' + ');
  const percent = String(Math.round(row.score * 100));
  return `${LANE_FALLBACK_WHY_PREFIX} · ${lanes} lane${row.lanes.length === 1 ? '' : 's'} ${percent}%`;
};

// A synthesized ResolverCandidate. Mirrors attribution-v1/serve.ts's
// voteCandidate: an arm with no PPR / similarity / cluster channel leaves those
// raw scores at 0 (so nothing downstream reads evidence that never existed) and
// encodes its own arm-native strength monotonically in `rawFusionLogit` for
// auditability + ordering.
//
// `rawFusionLogit` is the lane-native score in [0,1] — it is NOT a fusion
// log-odds and must never be dressed as calibrated confidence. The panel's
// headline for these candidates is provenance-driven ("Unconfirmed — from page
// content"), not sigmoid-driven, precisely because this number is not one.
//
// `dominantSource: 'none'` is the honest label: no fusion channel dominated,
// because no fusion ran. The panel renders that as "no clear signal".
// `corroborationCount` carries the LANE agreement count (1 or 2), the only
// corroboration this candidate can claim.
const fallbackCandidate = (row: LaneAgreement): ResolverCandidate => ({
  workstreamId: row.workstreamId,
  pprScore: 0,
  simTopScore: 0,
  simMeanScore: 0,
  simAgreement: 0,
  simMargin: 0,
  clusterPosterior: 0,
  corroborationCount: row.laneCount,
  rawFusionLogit: row.score,
  dominantSource: 'none',
  reasons: [
    {
      source: 'similarity',
      summary: fallbackWhy(row),
      anchors: [],
    },
  ],
});

// ---- the entry point ---------------------------------------------------

/**
 * Fill an EMPTY fusion's displayed pick from the content + ai guess lanes.
 *
 * Returns `result` unchanged — by identity, so a caller can assert on it —
 * whenever any of these hold:
 *   - the kill switch is off (SIDETRACK_LANE_FALLBACK_GUESS=0/false);
 *   - fusion produced ≥1 candidate (never override real fusion output);
 *   - the gate reason is anything other than 'no-candidates' (a held-but-real
 *     decision, or an old/absent gate we must not reinterpret);
 *   - lanes are absent (guess lanes off) or the content + ai lanes have no
 *     candidates (no gist / nothing indexed / empty corpus — there is genuinely
 *     nothing to guess from, and inventing one would be the dishonest case).
 *
 * Otherwise it returns a copy whose `fusedCandidates` are up to 3 synthesized,
 * provenance-marked candidates and whose `decision` differs ONLY by the gate
 * detail suffix.
 */
export const applyLaneFallbackGuess = <T extends ResultWithFusion>(result: T): T => {
  if (!laneFallbackGuessEnabled()) return result;
  // Fusion had an opinion (any candidate at all) ⇒ hands off, unconditionally.
  if (result.fusedCandidates.length > 0) return result;
  // Only the "nothing reached fusion" gate qualifies. 'corroboration' &c. mean
  // candidates existed and a policy gate held them — a different story that the
  // existing card already tells honestly. An ABSENT gate (old resolver path)
  // also declines: we will not infer emptiness from a missing field.
  if (result.decision.gate?.reason !== 'no-candidates') return result;
  const lanes = result.lanes;
  if (lanes === undefined || lanes.length === 0) return result;
  const ranked = rankLaneAgreement(lanes);
  if (ranked.length === 0) return result;
  const gate: PolicyGate = {
    reason: result.decision.gate.reason,
    detail: `${result.decision.gate.detail}${LANE_FALLBACK_GATE_SUFFIX}`,
  };
  return {
    ...result,
    // action / workstreamId / margin are copied through verbatim — this cannot
    // change what gets filed, only what gets shown.
    decision: { ...result.decision, gate },
    fusedCandidates: ranked.map(fallbackCandidate),
  };
};
