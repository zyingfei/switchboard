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
// THRESHOLD LADDER (the vote-count gate — the vote arm has no continuous score,
// so its natural gate is how many of the three signals agree). The vote-count
// sweep is a HARNESS PRODUCER now — eval/prequential.ts runVote3VoteCountCurve,
// emitted into the prequential artifact — so these are read-back numbers, not
// prose (doctrine rule 10). Measured on ~/.sidetrack-vault-test (514 labels,
// gated domain vote, 2026-07-26 read-only run):
//   >= 1 vote : coverage 99.8%  top1 45.9%  precision-when-suggesting 46.0%  -> SUGGEST
//   >= 2 votes: coverage 35.0%  top1 22.4%  precision 63.9%
//   >= 3 votes: coverage  7.8%  top1  6.4%  precision 82.5%                  -> AUTO-APPLY
// The user values not-being-wrong, so auto-apply takes the most conservative,
// near-certain tier (unanimous 3-signal agreement, 82.5% precision); suggest
// takes the coverage tier (46.0% precision at ~100% coverage) to light the §13
// demo that the incumbent leaves dark (it abstains 86% of the time). This maps
// the sweep's precision tiers onto the existing decideAttribution action ladder:
// auto needs the high-precision bar, suggest earns the coverage. The
// eval/prequential.test.ts "vote3 SERVED numbers" fixture asserts the curve is
// monotone (precision rises with votes) and the auto-apply tier clears the
// ~0.6 bar, backing this ladder with a passing CI test.

import { domainOfUrl } from './state.js';
import type { AttributionV1State } from './state.js';
import {
  gatedDomainWorkstream,
  tallyVote3,
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

// Default 'vote3': the servable arm reproduces the frozen-baseline win on the
// eval harness — 45.9% top1 on ~/.sidetrack-vault-test (514 asserted labels,
// gated domain vote, 2026-07-26 read-only run), clearing the >= 40% bar and
// beating both vote4 (43.6%) and the incumbent-shadow v1 (8.8%, abstains 86%).
// This default-flip guard is CI'd: eval/prequential.test.ts "vote3 SERVED
// numbers" runs runAttributionPrequential over a fixture vault and asserts
// vote3.top1 >= 0.40 AND >= vote4.top1 — so a regression below the bar (or a
// methodology drift) fails a test rather than silently shipping. The live-vault
// 45.9% is the flag-comment citation; the fixture floor is the doctrine-rule-10
// read-back. Set SIDETRACK_ATTRIBUTION_ARM=v1 to fall back to the incumbent
// instantly (env + restart, no data migration).
export const DEFAULT_ATTRIBUTION_ARM: AttributionArm = 'vote3';

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

// Vote-count -> action thresholds. Suggest at >= 1 (any signal agrees — the
// coverage tier that lights the demo); auto-apply at >= 3 (unanimous — the
// 82.5%-precision conservative tier the user's "don't be wrong" bar demands).
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
  const prediction = tallyVote3({ title: titleVote, domain: domainVote, recency: recencyVote });

  const base = inboxBase(prediction.votes, prediction.workstreamId);

  // Below the suggest floor (no signal voted) ⇒ inbox / abstain.
  if (prediction.workstreamId === null || prediction.votes < VOTE3_SUGGEST_MIN_VOTES) {
    return { ...base, decision: { action: 'inbox', margin: 0 }, fusedCandidates: [] };
  }

  const voters = [
    titleVote === prediction.workstreamId ? 'title' : null,
    domainVote === prediction.workstreamId ? 'domain' : null,
    recencyVote === prediction.workstreamId ? 'recency' : null,
  ].filter((v): v is string => v !== null);
  const candidate = voteCandidate(
    prediction.workstreamId,
    prediction.votes,
    `${String(prediction.votes)}-signal agreement (${voters.join(', ')})`,
  );

  const action = prediction.votes >= VOTE3_AUTO_APPLY_MIN_VOTES ? 'auto-apply' : 'suggest';
  return {
    ...base,
    decision: { action, workstreamId: prediction.workstreamId, margin: prediction.votes },
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
