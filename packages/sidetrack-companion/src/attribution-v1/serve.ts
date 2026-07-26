// Attribution v1 — the SERVABLE vote arm (M6).
//
// The prequential eval (eval/prequential.ts) scores a `vote3` arm — title +
// domain + recency plurality vote — that reproduces (and on the live vault
// BEATS) the frozen `vote4` baseline while reading ONLY signals the drain-time
// AttributionV1State artifact carries. This module is the SERVING side of that
// arm: given the memoized state + a canonical url + its title, it returns a
// `UrlResolutionResult`-shaped decision so every downstream consumer (the
// resolve route, urls/autoApply.ts, the inferred-attribution payload builder,
// the round-guard stack) is untouched — the arm slots in where the incumbent
// graph-resolver's result used to be, behind SIDETRACK_ATTRIBUTION_ARM.
//
// WHY vote3 (not vote4) SERVES. vote4's fourth signal, session-majority, reads a
// per-visit tab-session-to-URL binding reconstructed from the eval's replayed
// timeline history. At serve time the resolver has a canonicalUrl, not a live
// session join, and the artifact does NOT persist sessionWorkstreamCounts, so
// that vote is not servable per-request. Dropping it and GATING the domain vote
// on learned discriminativeness (>= neutral — so aggregator hubs withhold their
// vote, where B1/B4 fire) measured 45.9% top1 on ~/.sidetrack-vault-test
// (514 asserted labels, 2026-07-26 read-back), vs vote4's 43.6% and the
// incumbent-shadow v1's 8.8%. See eval/prequential.test.ts for the in-test proof.
//
// THE CORRELATED-PRIOR GUARD (fix/vote-arm-precision, 2026-07-26). The
// unguarded vote arm degenerated to MONOTONE suggestions on live diverse
// browsing: three unrelated pages (a design essay, an economics article, a
// GitHub security blog) resolved to the SAME workstream, one at AUTO-APPLY. Root
// cause: on a lightly-filed vault the domain + recency votes are near-GLOBAL
// PRIORS, not page evidence — `recency` is ONE global lastFiledWorkstreamId and
// `domain` collapses to a handful of argmaxes — so when the per-page title vote
// abstained, the two correlated priors plurality-won and swept fresh browsing
// onto the recent/dominant workstream. The prequential's 45.9% top1 MASKED this
// because historical labels cluster in temporal bursts where recency IS
// predictive. The fix threads decideVoteArm (eval/prequential.ts): SUGGEST now
// requires the TITLE vote to participate in the winning plurality — two priors
// agreeing is not page evidence. Re-scored on the same harness
// (~/.sidetrack-vault-test, 514 labels, 2026-07-26 read-only, github domain vote
// now hub-gated):
//   unguarded          top1 45.9%  abstain  0.2%  precision-when-suggesting 46.0%
//   title-participates  top1 37.4%  abstain 23.2%  precision 48.6%   <- served guard (2a)
//   title + >= 2 votes  top1 20.6%  abstain 67.9%  precision 64.2%
// Abstain rises substantially — that is CORRECT (the user's bar: never-wrong >
// always-present). But the guarded arm's precision-when-suggesting (48.6%) does
// NOT clear the 0.55 default-flip bar, and the stricter title+>=2 variant clears
// precision only by abstaining 67.9% (> the 0.6 abstain cap). So the SERVE
// DEFAULT reverts to 'v1' (DEFAULT_ATTRIBUTION_ARM below) — the vote arm stays a
// scored, servable, opt-in arm, not the default, until it earns the precision
// bar on live reverse-shadow agreement data.
//
// AUTO-APPLY (rule 2b) is DISABLED by default: the eval's 82.5%-precision
// 3-vote tier was HISTORICAL (temporal-burst leakage), and the live monotony
// failure landed one collapse at auto-apply. The vote arm caps at SUGGEST unless
// SIDETRACK_VOTE_ARM_AUTO_APPLY=1 (see voteArmAutoApplyEnabled). The vote-count
// sweep (eval/prequential.ts runVote3VoteCountCurve, emitted into the
// prequential artifact) remains the read-back for the >= 3-vote tier's precision.

import { domainOfUrl } from './state.js';
import type { AttributionV1State } from './state.js';
import {
  decideVoteArm,
  gatedDomainWorkstream,
  titleNearestWorkstream,
} from './eval/prequential.js';
// Type-only import: serve.ts must not pull the resolver's PPR/similarity/cluster
// runtime graph onto its (light) import path — it only needs the result shapes.
import type {
  ResolverCandidate,
  UrlResolutionResult,
} from '../tabsession/resolver.js';

export const ATTRIBUTION_ARM_ENV = 'SIDETRACK_ATTRIBUTION_ARM';

// The serving arm selector. 'v1' keeps the incumbent graph-resolver (PPR +
// similarity + cluster + fusion + policy) serving — the pre-M6 behavior.
// 'vote3' has the URL resolver return this vote arm's decision instead.
export type AttributionArm = 'v1' | 'vote3';

// Default 'v1' (REVERTED 2026-07-26, fix/vote-arm-precision). M6 shipped 'vote3'
// as the default on the strength of its 45.9% prequential top1, but the arm
// degenerated to monotone suggestions on live diverse browsing (see the header's
// correlated-prior-guard note). The correlated-prior guard (rule 2a) fixes the
// monotony, but the GUARDED arm's precision-when-suggesting (48.6% on
// ~/.sidetrack-vault-test, 514 labels, 2026-07-26 read-only) does NOT clear the
// 0.55 default-flip bar, and the stricter title+>=2 variant clears precision
// (64.2%) only by abstaining 67.9% (> the 0.6 abstain cap). Under the rule-2c
// decision (precision >= 0.55 AND abstain <= 0.6 to stay on vote3), the default
// reverts to the incumbent graph-resolver. The vote arm remains fully servable
// and CI-scored — set SIDETRACK_ATTRIBUTION_ARM=vote3 to opt in (it now serves
// the GUARDED, auto-apply-capped decision). The re-flip criterion is the vote
// arm clearing the precision bar on live reverse-shadow agreement data.
export const DEFAULT_ATTRIBUTION_ARM: AttributionArm = 'v1';

// SIDETRACK_VOTE_ARM_AUTO_APPLY (default OFF) — rule 2b. The vote arm's
// auto-apply tier (unanimous 3-signal agreement) measured 82.5% precision on the
// eval, but that number is HISTORICAL: the prequential's temporal-burst leakage
// inflates the recency signal, and the live monotony failure landed one wrongful
// collapse AT the auto-apply tier. So the vote arm caps at SUGGEST — it never
// auto-applies — until this flag is explicitly set.
//
// RE-ENABLE CRITERION (do not flip on a hunch): turn this ON only after the
// reverse-shadow (armShadow.ts) shows the vote arm's auto-apply tier AGREES with
// the incumbent at >= 0.9 agree-rate over >= 50 live auto-apply-eligible
// resolves AND a spot-audit of those live confirms >= 20 correct auto-applies
// with zero wrongful landings. Until both hold, historical eval precision does
// not license live auto-apply.
export const VOTE_ARM_AUTO_APPLY_ENV = 'SIDETRACK_VOTE_ARM_AUTO_APPLY';

export const voteArmAutoApplyEnabled = (): boolean =>
  process.env[VOTE_ARM_AUTO_APPLY_ENV] === '1' ||
  process.env[VOTE_ARM_AUTO_APPLY_ENV] === 'true';

// The task's flag values are 'v1' | 'vote4'; 'vote4' selects the servable vote
// arm (vote3, its serving equivalent — see the module header for why the
// session vote is dropped). Both spellings map to the vote arm so operators can
// use either the design's 'vote4' name or the precise 'vote3'.
export const attributionArm = (): AttributionArm => {
  const raw = process.env[ATTRIBUTION_ARM_ENV];
  if (raw === undefined || raw === '') return DEFAULT_ATTRIBUTION_ARM;
  if (raw === 'v1' || raw === 'incumbent') return 'v1';
  if (raw === 'vote3' || raw === 'vote4' || raw === 'vote') return 'vote3';
  return DEFAULT_ATTRIBUTION_ARM;
};

// Vote-count -> action thresholds. The suggest/auto tier decision now lives in
// decideVoteArm (eval/prequential.ts) so the served rule and the eval arm are one
// function — the guard (title must participate) and the auto-apply cap are
// applied there. These constants document the vote-count floors decideVoteArm
// keys on: a winner needs >= VOTE3_SUGGEST_MIN_VOTES votes at all (the
// coverage-tier floor the vote-count curve reports); auto-apply additionally
// requires unanimous 3-signal agreement AND the auto-apply flag; and — the guard
// on top of the vote count — suggest requires the title vote in the winning
// plurality.
export const VOTE3_SUGGEST_MIN_VOTES = 1;
export const VOTE3_AUTO_APPLY_MIN_VOTES = 3;

const WORKSTREAM_PREFIX = 'workstream:';
const MODEL_REVISION = 'attribution-vote3-v1';

// A synthetic ResolverCandidate for the vote winner. The vote arm has no PPR /
// similarity / cluster channel, so those raw scores are 0 and the aggregator
// false-friend guard (policy.ts, keyed off simTopScore dominance) is a no-op on
// this path — which is correct: the vote arm never rode the resemblance-edge
// similarity channel the false-friend used, and its domain vote is hub-gated, so
// the hub case cannot produce a candidate at all. `corroborationCount` carries
// the vote count so inferredUrlAttributionPayloadFromResolution surfaces it, and
// `dominantSource:'vote'` (F6 — the HONEST provenance, distinct from 'cluster')
// keeps that payload's non-'none' gate satisfied so a >= 3-vote auto-apply
// produces a valid inferred event AND the panel labels it "recent/same-domain
// filing" rather than falsely "via topic cluster". `rawFusionLogit` encodes the
// vote count monotonically for auditability.
const voteCandidate = (
  workstreamId: string,
  votes: number,
  reasonSummary: string,
): ResolverCandidate => ({
  workstreamId,
  pprScore: 0,
  simTopScore: 0,
  simMeanScore: 0,
  simAgreement: 0,
  simMargin: 0,
  clusterPosterior: 0,
  corroborationCount: votes,
  rawFusionLogit: votes,
  dominantSource: 'vote',
  reasons: [
    {
      source: 'vote',
      summary: reasonSummary,
      anchors: [],
    },
  ],
});

// The domain-tombstone privacy gate the arm switch threads in from the served
// tombstone set. The vote arm is a NEW serve boundary that — unlike the
// incumbent, whose purged nodes are already scrubbed from the connections
// snapshot by scope recompute — reads the raw-event-folded AttributionV1State,
// which carries no tombstone filtering. So the gate must be applied HERE: a
// tombstoned URL must never be resolved/voted (the incumbent returns nothing
// for it), and a tombstoned DOMAIN must not cast its domain vote (so a purged
// domain's learned argmax cannot mis-file a sibling page). Structurally typed
// so serve.ts does not import the privacy module.
export interface Vote3TombstoneGate {
  readonly matchesPage: (page: { url?: string; title?: string }) => boolean;
  readonly matchesDomain: (domain: string) => boolean;
}

export interface ResolveUrlAttributionVote3Input {
  readonly state: AttributionV1State;
  readonly canonicalUrl: string;
  // Best-effort title for the url (looked up from the connections snapshot by
  // the caller, exactly as the shadow lane does). Absent title ⇒ the title vote
  // is null; the domain + recency votes still stand.
  readonly title: string | null;
  readonly policyMode?: UrlResolutionResult['policyMode'];
  // Optional privacy gate — when the resolved URL matches an active domain
  // tombstone the arm abstains (inbox), and a tombstoned domain never casts its
  // domain vote. Absent ⇒ no tombstones (the empty-set fast path).
  readonly tombstones?: Vote3TombstoneGate;
  // rule 2b override: when set, forces the auto-apply gate on/off instead of
  // reading SIDETRACK_VOTE_ARM_AUTO_APPLY. Absent ⇒ read the env flag (default
  // OFF). Tests inject this so they do not depend on process env.
  readonly autoApplyEnabled?: boolean;
}

// Resolve a URL's attribution under the servable vote3 arm. Pure over the state
// + visit triple (no I/O, no clock) — the caller supplies the loaded state and
// the title. Returns a UrlResolutionResult so the arm switch is a drop-in for
// resolveUrlAttribution at the resolve call site.
export const resolveUrlAttributionVote3 = (
  input: ResolveUrlAttributionVote3Input,
): UrlResolutionResult => {
  const domain = domainOfUrl(input.canonicalUrl);

  const policyMode = input.policyMode ?? 'balanced';
  const inboxBase = (votes: number, winner: string | null) => ({
    canonicalUrl: input.canonicalUrl,
    dryRun: true as const,
    policyMode,
    reasons: {
      dependencyKey: `vote3:${input.canonicalUrl}`,
      modelRevision: MODEL_REVISION,
      graphRevision: 'vote3',
      evidenceHash: `vote3:${input.canonicalUrl}:${String(winner)}:${String(votes)}`,
      targetAnchors: [] as readonly string[],
      topContributingAnchors: [] as readonly string[],
    },
  });

  // PRIVACY GATE (F1). A tombstoned URL must never be resolved or voted on —
  // the incumbent returns nothing for it because scope recompute already
  // scrubbed its node from the connections snapshot; the vote arm reads the raw
  // AttributionV1State, so the gate is applied here. Abstain to inbox with a
  // zero-vote result so no purged page ever produces a suggestion.
  if (
    input.tombstones?.matchesPage({
      url: input.canonicalUrl,
      ...(input.title === null ? {} : { title: input.title }),
    })
  ) {
    return { ...inboxBase(0, null), decision: { action: 'inbox', margin: 0 }, fusedCandidates: [] };
  }

  const titleVote = titleNearestWorkstream(input.state, input.title, domain);
  // Withhold the domain vote when the URL's own domain is tombstoned — a purged
  // domain's learned argmax must not cast a vote (mirroring the graph purge the
  // incumbent gets for free). The title/recency votes are workstream ids, not
  // per-domain data, so they still stand for a non-tombstoned URL.
  const domainVote =
    domain !== null && input.tombstones?.matchesDomain(domain)
      ? null
      : gatedDomainWorkstream(input.state, domain);
  const recencyVote = input.state.lastFiledWorkstreamId;

  // The GUARDED tier decision — the single rule the eval harness also scores.
  // rule 2a: suggest requires the title vote in the winning plurality (recency +
  // domain alone are near-global priors, not page evidence). rule 2b: auto-apply
  // only when SIDETRACK_VOTE_ARM_AUTO_APPLY is on AND the vote is unanimous.
  const decision = decideVoteArm(
    { title: titleVote, domain: domainVote, recency: recencyVote },
    { autoApplyEnabled: input.autoApplyEnabled ?? voteArmAutoApplyEnabled() },
  );

  const base = inboxBase(decision.votes, decision.workstreamId);

  // Guard fired (no winner, or the correlated-prior guard abstained) ⇒ inbox.
  if (decision.tier === 'inbox' || decision.workstreamId === null) {
    return { ...base, decision: { action: 'inbox', margin: 0 }, fusedCandidates: [] };
  }

  const candidate = voteCandidate(
    decision.workstreamId,
    decision.votes,
    `${String(decision.votes)}-signal agreement (${decision.voters.join(', ')})`,
  );

  return {
    ...base,
    decision: { action: decision.tier, workstreamId: decision.workstreamId, margin: decision.votes },
    fusedCandidates: [candidate],
  };
};

// The incumbent-agreement definition for the reverse shadow: both name the same
// non-null workstream OR both abstain (inbox ⇒ null). Mirrors shadow.ts's honest
// agree semantics. Kept here so the arm switch owns its own comparison.
export const workstreamOf = (result: {
  readonly decision: { readonly action: string; readonly workstreamId?: string };
}): string | null => {
  const { action, workstreamId } = result.decision;
  if (workstreamId === undefined || workstreamId.length === 0 || action === 'inbox') return null;
  return workstreamId;
};

// exported for the arm switch's node-id needs (kept in sync with resolver.ts).
export const workstreamNodeId = (workstreamId: string): string =>
  `${WORKSTREAM_PREFIX}${workstreamId}`;
