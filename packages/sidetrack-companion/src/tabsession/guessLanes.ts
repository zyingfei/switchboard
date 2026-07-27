// Guess lanes — every channel's own opinion on every resolve.
//
// THE PROBLEM. The resolver (resolver.ts) fuses three channels (PPR +
// similarity + cluster) and then filters to `corroborationCount > 0`. When the
// graph has nothing to say (a brand-new chat thread, an unseen URL), the fused
// list is EMPTY and the panel shows "No signal yet" — even though the cheap
// title/domain/recency vote signals (attribution-v1) DO have opinions, and the
// per-channel evidence maps (pprScore / simTopScore / clusterPosterior) exist
// PRE-FILTER. The user is told nothing when every lane individually had a view.
//
// THE FIX. Expose all six lanes' own views on every resolve response, in a
// FIXED order, ALWAYS all present. A lane that produced nothing says WHY
// (typed emptiness, doctrine) rather than being silently absent. Graph /
// similarity / topic read the resolver's already-computed pre-filter
// CandidateEvidence (no new traversal). Title / domain / recency reuse the
// attribution-v1 vote3 signal builders (titleNearestWorkstream /
// gatedDomainWorkstream / lastFiledWorkstreamId), the SAME code the shadow
// (default ON) already runs per-resolve — so this adds no new graph work and no
// new event-log scan; it re-reads the memoized AttributionV1State the vote arm
// and shadow already loaded on this resolve.
//
// COST. buildGuessLanes is pure and O(candidates + workstreams-for-the-title-
// overlap). The graph lanes iterate the (already-built, ≤ a few dozen)
// candidateEvidence array; the vote lanes call the three vote builders (title
// overlap is one pass over the folded per-workstream term index the shadow
// already touches). No I/O, no clock beyond the caller-supplied recency
// timestamp.

import type { CandidateEvidence } from './fusion.js';
import {
  gatedDomainWorkstream,
  titleNearestWorkstream,
} from '../attribution-v1/eval/prequential.js';
import {
  domainDiscriminativeness,
  domainOfUrl,
  isCoarseMultiTopicPriorDomain,
  NEUTRAL_DISCRIMINATIVENESS,
  plainTitleOverlapSuppressed,
  type AttributionV1State,
} from '../attribution-v1/state.js';

// ---- wire contract (FROZEN, additive) ---------------------------------

export type GuessLane =
  | 'graph'
  | 'similarity'
  | 'topic'
  | 'title'
  | 'domain'
  | 'recency'
  // Lane 7 (additive, FROZEN CONTRACT). Query-time full-vector + BM25
  // comparison per-workstream — computed OUTSIDE buildGuessLanes (async, needs
  // the recall store handle) and APPENDED to the lanes array after 'recency'.
  // It is intentionally NOT in GUESS_LANE_ORDER (that is the six synchronous,
  // I/O-free lanes); see tabsession/contentLane.ts.
  | 'content';

export interface GuessLaneCandidate {
  readonly workstreamId: string;
  // Lane-native strength normalized to 0..1 (see per-lane normalization below).
  readonly score: number;
  // One short human line, e.g. "3 similar pages (cloudtrail, iam)" /
  // "domain chatgpt.com filed here 12×" / "last active 2h ago".
  readonly why: string;
}

export interface GuessLaneResult {
  readonly lane: GuessLane;
  // Top 3 max, descending score. Never carries emptyReason.
  readonly candidates: readonly GuessLaneCandidate[];
  // REQUIRED iff candidates.length === 0 (typed emptiness — a lane that
  // produced nothing says WHY).
  readonly emptyReason?: string;
}

// The fixed lane order every response carries. All six ALWAYS present.
export const GUESS_LANE_ORDER: readonly GuessLane[] = [
  'graph',
  'similarity',
  'topic',
  'title',
  'domain',
  'recency',
];

// ---- env flag ---------------------------------------------------------

export const GUESS_LANES_ENV = 'SIDETRACK_GUESS_LANES';

// Default ON. Only an explicit '0' / 'false' disables — same pattern as
// attributionV1ShadowEnabled. When off, the caller omits the `lanes` field
// entirely (it is undefined on the wire, not an empty array).
export const guessLanesEnabled = (): boolean => {
  const raw = process.env[GUESS_LANES_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- normalization helpers --------------------------------------------

const MAX_LANE_CANDIDATES = 3;

// Clamp to [0,1]. Guards against float error and any channel that emits a
// value slightly outside the unit interval.
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

// Take the top N of a scored candidate list, descending by score then by
// workstream id (deterministic ties). Empty in ⇒ empty out.
const topN = (
  candidates: readonly GuessLaneCandidate[],
  n: number,
): readonly GuessLaneCandidate[] =>
  [...candidates]
    .sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.workstreamId < right.workstreamId
          ? -1
          : left.workstreamId > right.workstreamId
            ? 1
            : 0,
    )
    .slice(0, n);

// A populated lane (candidates present, never an emptyReason).
const populated = (lane: GuessLane, candidates: readonly GuessLaneCandidate[]): GuessLaneResult => ({
  lane,
  candidates: topN(candidates, MAX_LANE_CANDIDATES),
});

// An empty lane (typed emptiness — always carries a reason).
const empty = (lane: GuessLane, emptyReason: string): GuessLaneResult => ({
  lane,
  candidates: [],
  emptyReason,
});

// ---- graph / similarity / topic lanes (from resolver evidence) --------
//
// These read the resolver's PRE-FILTER CandidateEvidence array — the same
// per-workstream pprScore / simTopScore / clusterPosterior the fusion consumes,
// BEFORE the corroborationCount>0 filter drops workstreams. No new graph
// traversal: the array is already built by resolveTargetAttribution.

// PPR is a personalized-PageRank stationary distribution — already ∈ [0,1] per
// node (a probability mass). We clamp for safety and surface the raw mass.
const graphLane = (evidence: readonly CandidateEvidence[]): GuessLaneResult => {
  const candidates = evidence
    .filter((candidate) => candidate.pprScore > 0)
    .map((candidate) => ({
      workstreamId: candidate.workstreamId,
      score: clamp01(candidate.pprScore),
      why: `graph reach ${candidate.pprScore.toFixed(3)}`,
    }));
  return candidates.length === 0
    ? empty('graph', 'no graph path from this page to any workstream yet')
    : populated('graph', candidates);
};

// simTopScore is a cosine-family similarity already ∈ [0,1]. The `why` names the
// matched terms when the similarity channel carried them (simMatchedTerms).
const similarityLane = (evidence: readonly CandidateEvidence[]): GuessLaneResult => {
  const candidates = evidence
    .filter((candidate) => candidate.simTopScore > 0)
    .map((candidate) => {
      const terms =
        candidate.simMatchedTerms === undefined || candidate.simMatchedTerms.length === 0
          ? ''
          : ` (${candidate.simMatchedTerms.slice(0, 3).join(', ')})`;
      return {
        workstreamId: candidate.workstreamId,
        score: clamp01(candidate.simTopScore),
        why: `similar pages ${candidate.simTopScore.toFixed(2)}${terms}`,
      };
    });
  return candidates.length === 0
    ? empty('similarity', 'no similarity edges for this URL yet')
    : populated('similarity', candidates);
};

// clusterPosterior is a topic-cluster posterior probability already ∈ [0,1].
const topicLane = (evidence: readonly CandidateEvidence[]): GuessLaneResult => {
  const candidates = evidence
    .filter((candidate) => candidate.clusterPosterior > 0)
    .map((candidate) => ({
      workstreamId: candidate.workstreamId,
      score: clamp01(candidate.clusterPosterior),
      why: `topic match ${(candidate.clusterPosterior * 100).toFixed(0)}%`,
    }));
  return candidates.length === 0
    ? empty('topic', 'no topic cluster covers this page yet')
    : populated('topic', candidates);
};

// ---- title / domain / recency lanes (from the vote3 signals) ----------
//
// The three cheap vote signals attribution-v1 already computes per-resolve
// (shadow, default ON). Each is a SINGLE argmax workstream (the vote arm's
// signal is a plurality vote of these three), so each lane has at most ONE
// candidate. Score is a confidence in [0,1] derived from the signal's own
// strength (documented per lane); it is NOT the vote count.

// Vote-signal inputs the caller assembles once and hands to the three lanes.
// `state` is the memoized AttributionV1State (the shadow/vote-arm already loaded
// it this resolve); `title` is the best-effort page title; `domain` is derived
// from the canonical URL. When `state` is absent (no fresh artifact — the vote
// arm failed safe to the incumbent), the three vote lanes report typed
// emptiness rather than a guess.
export interface GuessLaneVoteSignals {
  readonly state: AttributionV1State | null;
  readonly title: string | null;
  readonly domain: string | null;
  // True when `title` came from the enrichment overlay (a SYNTHESIZED title),
  // not a real snapshot title/label. Drives the ' · synthesized title' suffix
  // on the title lane why so the provenance is explicit. Absent/false ⇒ the
  // title is a real one (or there is none). Optional so existing callers that
  // don't thread it keep the prior (real-title) rendering.
  readonly titleSynthesized?: boolean;
}

// A saturating confidence for a raw overlap/count: strength/(strength+k) maps
// (0,∞) → (0,1) smoothly, so a single weak match reads low and a strongly-
// evidenced match approaches 1 without ever exceeding it. k is the half-
// saturation point (strength=k ⇒ 0.5).
const saturate = (strength: number, k: number): number =>
  strength <= 0 ? 0 : clamp01(strength / (strength + k));

// Title lane: the venue-suppressed plain-overlap nearest workstream (the vote
// arm's title signal). Score = saturating confidence in the summed member
// document-frequency of the matched terms for the winning workstream. `why`
// names the matched terms. Empty when no title, or no term overlaps any
// workstream's folded titles.
const TITLE_SATURATION_K = 4;
const titleLane = (signals: GuessLaneVoteSignals): GuessLaneResult => {
  if (signals.state === null) {
    return empty('title', 'no attribution state loaded');
  }
  if (signals.title === null || signals.title.length === 0) {
    return empty('title', 'no page title to match');
  }
  const winner = titleNearestWorkstream(signals.state, signals.title, signals.domain);
  if (winner === null) {
    return empty('title', 'title words match no filed workstream');
  }
  const overlap = plainTitleOverlapSuppressed(signals.state, signals.title, signals.domain);
  const strength = overlap.scores.get(winner) ?? 0;
  const matched = overlap.matchedTerms.get(winner) ?? [];
  const terms = matched.length === 0 ? '' : ` (${matched.slice(0, 3).join(', ')})`;
  // Provenance: when the matched title was SYNTHESIZED (enrichment overlay, not
  // a real page title) the user must see that explicitly — the match rode on an
  // on-device-generated title, not the raw one.
  const synthesizedSuffix = signals.titleSynthesized === true ? ' · synthesized title' : '';
  return populated('title', [
    {
      workstreamId: winner,
      score: saturate(strength, TITLE_SATURATION_K),
      why: `title words match${terms}${synthesizedSuffix}`,
    },
  ]);
};

// Domain lane: the GATED domain vote (gatedDomainWorkstream) — the domain's
// learned-discriminativeness winner, WITHHELD when the domain is below neutral
// discriminativeness (a hub). Score = the domain's discriminativeness (already
// ∈ [0,1], its own native strength: 1 ⇒ the domain implies one workstream, 0.5
// ⇒ neutral). The hub gate is the vote builder's, reproduced here for the
// `why`: a generic hub (news.ycombinator.com, github.com, …) yields
// emptyReason "domain too generic", never a garbage guess.
const domainLane = (signals: GuessLaneVoteSignals): GuessLaneResult => {
  if (signals.state === null) {
    return empty('domain', 'no attribution state loaded');
  }
  if (signals.domain === null) {
    return empty('domain', 'no domain for this URL');
  }
  const winner = gatedDomainWorkstream(signals.state, signals.domain);
  if (winner === null) {
    // Distinguish "hub domain, vote withheld" from "domain never filed". A
    // listed coarse-multi-topic domain, or one whose measured dispersion sits
    // below neutral, is too generic to guess from (hub-gating preserved).
    const discrim = domainDiscriminativeness(signals.state, signals.domain);
    if (
      isCoarseMultiTopicPriorDomain(signals.domain) ||
      discrim.discriminativeness < NEUTRAL_DISCRIMINATIVENESS
    ) {
      return empty('domain', `domain ${signals.domain} too generic`);
    }
    return empty('domain', `domain ${signals.domain} not filed anywhere yet`);
  }
  const discrim = domainDiscriminativeness(signals.state, signals.domain);
  const times = discrim.assertedForWinner;
  const timesText = times > 0 ? ` filed here ${String(Math.round(times))}×` : '';
  return populated('domain', [
    {
      workstreamId: winner,
      score: clamp01(discrim.discriminativeness),
      why: `domain ${signals.domain}${timesText}`,
    },
  ]);
};

// Recency lane: the last-filed workstream (the vote arm's recency signal). A
// near-global prior, not page evidence — but it IS a real opinion, so we
// surface it (the panel/consumer weights it). Score is a fixed modest
// confidence (0.5): recency has no per-page strength to normalize, so a
// constant neutral prior is the honest normalization (it never out-shouts a
// real title/similarity match). `why` renders the age when a timestamp is
// available. Empty when nothing has ever been filed.
const RECENCY_PRIOR_SCORE = 0.5;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const recencyAge = (ageMs: number): string => {
  if (ageMs < HOUR_MS) {
    const mins = Math.max(1, Math.round(ageMs / (60 * 1000)));
    return `last active ${String(mins)}m ago`;
  }
  if (ageMs < DAY_MS) {
    return `last active ${String(Math.round(ageMs / HOUR_MS))}h ago`;
  }
  return `last active ${String(Math.round(ageMs / DAY_MS))}d ago`;
};
const recencyLane = (
  signals: GuessLaneVoteSignals,
  nowMs: number,
): GuessLaneResult => {
  if (signals.state === null) {
    return empty('recency', 'no attribution state loaded');
  }
  const winner = signals.state.lastFiledWorkstreamId;
  if (winner === null) {
    return empty('recency', 'nothing filed anywhere yet');
  }
  const lastMs = signals.state.lastFiledAtMs;
  const why =
    lastMs === null ? 'most recently filed workstream' : recencyAge(Math.max(0, nowMs - lastMs));
  return populated('recency', [{ workstreamId: winner, score: RECENCY_PRIOR_SCORE, why }]);
};

// ---- assembly ---------------------------------------------------------

export interface BuildGuessLanesInput {
  // The resolver's PRE-FILTER candidate evidence (graph / similarity / topic).
  // Empty array ⇒ all three graph lanes report typed emptiness.
  readonly candidateEvidence: readonly CandidateEvidence[];
  // The cheap vote signals (title / domain / recency). Absent ⇒ all three vote
  // lanes report "no attribution state loaded" (the incumbent-only path with no
  // artifact).
  readonly voteSignals?: GuessLaneVoteSignals;
  // Clock for the recency lane's age rendering. Defaults to Date.now().
  readonly nowMs?: number;
}

// Build all six lanes in the fixed GUESS_LANE_ORDER. Pure: no I/O, no graph
// traversal — reads the already-computed evidence + vote signals. Every lane is
// present; empty lanes carry an emptyReason, populated lanes never do.
export const buildGuessLanes = (input: BuildGuessLanesInput): readonly GuessLaneResult[] => {
  const votes: GuessLaneVoteSignals =
    input.voteSignals ?? { state: null, title: null, domain: null };
  const nowMs = input.nowMs ?? Date.now();
  return [
    graphLane(input.candidateEvidence),
    similarityLane(input.candidateEvidence),
    topicLane(input.candidateEvidence),
    titleLane(votes),
    domainLane(votes),
    recencyLane(votes, nowMs),
  ];
};

// Convenience: derive the vote-signal domain from a canonical URL (mirrors the
// vote arm — domainOfUrl). Callers pass the loaded state + best-effort title;
// this fills the domain so the wiring is one call.
export const voteSignalsFor = (
  state: AttributionV1State | null,
  canonicalUrl: string,
  title: string | null,
  // True when `title` was the synthesized (enrichment overlay) fallback. Absent
  // ⇒ false (a real title, or none). See GuessLaneVoteSignals.titleSynthesized.
  titleSynthesized = false,
): GuessLaneVoteSignals => ({
  state,
  title,
  domain: domainOfUrl(canonicalUrl),
  titleSynthesized,
});
