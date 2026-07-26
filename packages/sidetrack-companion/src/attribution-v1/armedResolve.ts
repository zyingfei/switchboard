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

import { recordArmShadow } from './armShadow.js';
import { loadAttributionV1State, titleForCanonicalUrl } from './emit.js';
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
}

// Resolve a URL under the configured serving arm. Async because the vote arm
// loads the memoized state (a cheap fs.stat once warm — see emit.ts). Falls back
// to the incumbent on any vote-arm unavailability (no vault root, no fresh
// artifact) so the serve path never hard-depends on the artifact being present.
export const resolveUrlAttributionArmed = async (
  input: ArmedResolveInput,
): Promise<UrlResolutionResult> => {
  const { vaultRoot, now, tombstones, skipReverseShadow, ...resolverInput } = input;

  if (attributionArm() === 'v1' || vaultRoot === undefined) {
    return resolveUrlAttribution(resolverInput);
  }

  const state = await loadAttributionV1State(vaultRoot, now ?? (() => new Date()));
  if (state === null) {
    // No fresh artifact — fail safe to the incumbent (same defensive posture as
    // the shadow lane's null-state skip).
    return resolveUrlAttribution(resolverInput);
  }

  const title =
    titleForCanonicalUrl(resolverInput.snapshot, resolverInput.canonicalUrl) ?? null;
  const voteResult = resolveUrlAttributionVote3({
    state,
    canonicalUrl: resolverInput.canonicalUrl,
    title,
    ...(resolverInput.policyMode === undefined ? {} : { policyMode: resolverInput.policyMode }),
    ...(tombstones === undefined ? {} : { tombstones }),
  });

  // Reverse shadow: compute the incumbent beside the served vote arm and record
  // agreement. Gated behind the v1-shadow flag so the incumbent PPR cost is
  // droppable. Best-effort — a shadow failure never surfaces on the served path.
  if (skipReverseShadow !== true && attributionV1ShadowEnabled()) {
    try {
      const incumbent = resolveUrlAttribution(resolverInput);
      recordArmShadow(workstreamOf(incumbent) === workstreamOf(voteResult));
    } catch {
      // observability only
    }
  }

  return voteResult;
};
