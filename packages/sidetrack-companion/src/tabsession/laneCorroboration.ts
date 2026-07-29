// Lane corroboration — let the lanes' agreement count, once it has earned it.
//
// THE GAP (review §G1, enhancement E1 — "the keystone"). The live Kimi case:
// six structural lanes typed-empty, the CONTENT lane and the AI lane BOTH
// naming the right workstream, and the decision `held: corroboration 1 < 2
// (similarity-dominant)`. The right answer was present, computed, displayed —
// and the gate could not see it, because lane agreement is not a corroborating
// source. "The system knows more than it uses, and shows more than it acts on."
//
// WHAT THIS DOES. When (and only when) the content + ai lanes agree on the
// workstream that fusion ALREADY ranks first, and that pick is failing ONLY the
// corroboration gate, count the lane agreement as ONE additional corroborating
// source and re-run the SAME policy. Nothing else changes: the same
// decideAttribution, the same logit floor, the same margin bar, the same
// candidate list.
//
// WHY THE AGREEMENT IS WORTH A CORROBORATION AT ALL. 'content' asks the recall
// store with gist + title + URL tokens; 'ai' asks it with the gist ALONE. They
// are two different queries over the same corpus, and the second deliberately
// discards everything the first leans on. A workstream that survives both is
// corroborated by two independent framings of the page — which is precisely
// what the corroboration gate is asking for (a second source, not a louder
// first one). One lane alone is NOT enough and never promotes here.
//
// WHY IT SELF-GATES ON MEASURED PRECISION. The repo's failure mode with new
// signals is not that they are absent, it is that they are trusted before they
// are measured (the trained ranker still loses to title-lexical and would have
// served if the gate were enforced). So this promotion refuses to fire until
// lanePrequential.ts can show that BOTH agreeing lanes have been right at least
// MIN_PRECISION of the time over at least MIN_SAMPLES scored predictions. On a
// fresh vault the numbers do not exist, the gate does not fire, and the system
// behaves exactly as it does today — the flag can be turned on the day it is
// written and it will simply wait.
//
// WHY IT CANNOT AUTO-FILE. Capped at 'suggest' (LANE_CORROBORATION_MAX_ACTION),
// deliberately and NOT because the policy says so. A lane admitted at p≥0.6 is,
// by construction, wrong up to 40% of the time; that is suggest-grade evidence.
// Letting a 0.6-precision signal be the term that tips a pick into auto-apply
// would file the user's pages on a coin-flip-plus. If the measured precision
// ever justifies auto, raise MIN_PRECISION first and lift this cap second, with
// the numbers in hand. (Deviation from the commissioning brief, stated here so
// it is a decision and not an accident.)
//
// WHY IT LIVES HERE AND NOT IN policy.ts. Same structural reason laneFallback.ts
// gives: lanes 7/8 are query-time retrieval computed AFTER the resolver has run
// and after the resolver CACHE was written. decideAttribution runs inside the
// resolver with no lane in scope. Folding lanes into fusion proper would mean
// re-scoring and re-gating on every titleHint change and staling the cache with
// them. So the promotion is a transform on the SERVED copy, applied at the same
// seam the lanes themselves are appended — but it re-decides through
// decideAttribution and reads the corroboration bar from policy.ts's own
// exported rule, so it cannot invent a decision the policy would not make.

import type { DeclineLookup } from './declineMemory.js';
import { isUrlDeclined } from './declineMemory.js';
import type { FusedCandidate } from './fusion.js';
import type { GuessLane, GuessLaneResult } from './guessLanes.js';
import {
  decideAttribution,
  requiredCorroborationFor,
  type AttributionAction,
  type AttributionPolicyMode,
  type PolicyGate,
} from './policy.js';
import type { LanePrequentialSummary } from './lanePrequential.js';
import { lanePrecisionFrom } from './lanePrequential.js';
import type { ResolverCandidate } from './resolver.js';

// ---- env flag ---------------------------------------------------------

export const LANE_CORROBORATION_ENV = 'SIDETRACK_LANE_CORROBORATION';

/**
 * Default OFF — only '1' / 'true' enables.
 *
 * This is the repo's observe-first rule applied strictly: unlike the lanes,
 * the fallback and the decline memory (all of which only ever change what is
 * SHOWN or withhold a guess), this changes what the system DECIDES. It can move
 * a pick from inbox to suggest. Off by default until the prequential numbers
 * it depends on have accumulated on a real vault and been looked at.
 */
export const laneCorroborationEnabled = (): boolean => {
  const raw = process.env[LANE_CORROBORATION_ENV];
  return raw === '1' || raw === 'true';
};

// ---- the self-gating thresholds ---------------------------------------

/**
 * The measured precision@1 BOTH agreeing lanes must clear.
 *
 * 0.60 is chosen against the yardstick this repo already has: the frozen
 * 4-signal heuristic baseline scores 46.2% top-1 on the prequential harness and
 * the served vote arm ~45.9%. A lane admitted as a corroborating source should
 * be materially better than the thing already serving, not merely comparable —
 * 0.6 is ~1.3× the incumbent and leaves the promotion clearly accretive rather
 * than a wash. It is NOT a statistical threshold and is not dressed as one.
 */
export const LANE_CORROBORATION_MIN_PRECISION = 0.6;

/**
 * The minimum scored predictions behind that precision, per lane.
 *
 * 20 is the same order as HEAD_WORKSTREAM_LABEL_THRESHOLD (the head/tail split
 * the attribution study uses), and it is the point below which a precision
 * estimate is mostly noise: at n=20 the 95% interval around 0.6 is roughly
 * ±0.21, so a lane clearing the bar at n=20 is plausibly a ~0.4 lane. That is
 * why the promotion is capped at 'suggest' as well as gated here — the two
 * guards cover different failure modes (too little data vs. genuinely mediocre
 * data) and neither is sufficient alone.
 */
export const LANE_CORROBORATION_MIN_SAMPLES = 20;

/**
 * The two lanes whose agreement counts.
 *
 * Deliberately NOT the six structural lanes: those are built from the SAME
 * candidateEvidence fusion already consumed (guessLanes.ts reads the resolver's
 * pre-filter evidence), so promoting them would double-count a signal fusion
 * has already weighed and found insufficient. Content and AI evidence never
 * reached fusion at all — that is the whole reason they are worth adding.
 */
export const LANE_CORROBORATION_LANES: readonly GuessLane[] = ['content', 'ai'];

/**
 * The strongest action this promotion may produce. See the header.
 * A promoted pick surfaces as a suggestion the user accepts or ignores; it
 * never files anything on its own.
 */
export const LANE_CORROBORATION_MAX_ACTION: AttributionAction = 'suggest';

/**
 * Frozen marker appended to the promoted gate detail. A reader (or a test, or a
 * future operator grepping the strip) can identify a lane-corroborated decision
 * by this substring without parsing the numbers.
 */
export const LANE_CORROBORATION_GATE_MARK = ' · lane-corroborated';

// ---- the shape this operates on ---------------------------------------
//
// A structural subset of UrlResolutionResult (same discipline as
// laneFallback.ts's ResultWithFusion) plus policyMode, which this module needs
// because it re-runs the policy.

export interface ResultForCorroboration {
  readonly policyMode: AttributionPolicyMode;
  readonly decision: {
    readonly action: AttributionAction;
    readonly workstreamId?: string;
    readonly margin: number;
    readonly gate?: PolicyGate;
  };
  readonly fusedCandidates: readonly ResolverCandidate[];
  readonly lanes?: readonly GuessLaneResult[];
}

export interface LaneCorroborationContext {
  readonly canonicalUrl: string;
  /**
   * The measured per-lane precision (lanePrequential.ts). Null/absent ⇒ no
   * measurement ⇒ NO promotion. "Unmeasured" must fail closed: the entire
   * argument for this feature is that the evidence is measured.
   */
  readonly calibration?: LanePrequentialSummary | null;
  /** Folded decline memory. A declined URL vetoes the promotion outright. */
  readonly declines?: DeclineLookup | null;
}

// ---- why-line formatting ----------------------------------------------

const num = (value: number): string => Number(value.toFixed(2)).toString();

// ---- the entry point ---------------------------------------------------

/**
 * Count content+ai lane agreement as one corroborating source for a pick held
 * ONLY by the corroboration gate.
 *
 * Returns `result` unchanged — by identity, so callers and tests can assert on
 * it — whenever any of these hold:
 *   - the flag is off (SIDETRACK_LANE_CORROBORATION unset / not '1'|'true');
 *   - the user declined this URL ("Not in any stream");
 *   - the gate reason is not 'corroboration' (nothing to lift, or a different
 *     gate is the binding one and lifting corroboration would change nothing);
 *   - fusion produced no candidates (there is no pick to corroborate — that
 *     case belongs to laneFallback.ts, which shows an unconfirmed guess);
 *   - the content and ai lanes do not BOTH name a workstream, or name
 *     different ones;
 *   - that agreed workstream is not fusion's own top candidate (the lanes may
 *     corroborate fusion; they may never re-rank it);
 *   - either lane's measured precision is below MIN_PRECISION, or its sample
 *     count is below MIN_SAMPLES, or there is no measurement at all;
 *   - re-running the policy with +1 corroboration STILL yields 'inbox' (the
 *     pick was failing the logit floor or the margin too — the corroboration
 *     gate was merely reported first).
 *
 * Otherwise it returns a copy whose `decision` carries the promoted action and
 * a gate detail naming the lift and the evidence behind it. `fusedCandidates`
 * are passed through VERBATIM: `corroborationCount` on a candidate means "how
 * many of the three fusion evidence channels fired", and lane agreement is not
 * one of them. The promotion lives in the decision and says so out loud.
 */
export const applyLaneCorroboration = <T extends ResultForCorroboration>(
  result: T,
  context: LaneCorroborationContext,
): T => {
  if (!laneCorroborationEnabled()) return result;
  // A refusal outranks every signal below. Checked first for the same reason
  // the fallback checks it first: it is an ANSWER, not missing evidence.
  if (isUrlDeclined(context.declines, context.canonicalUrl)) return result;
  if (result.decision.gate?.reason !== 'corroboration') return result;
  const top = result.fusedCandidates[0];
  if (top === undefined) return result;

  const agreed = agreedLaneWorkstream(result.lanes);
  if (agreed === null) return result;
  // The lanes corroborate fusion's pick or they do nothing. Re-ranking on lane
  // evidence is a different (much larger) change and is explicitly not this.
  if (agreed !== top.workstreamId) return result;

  const evidence = laneEvidence(context.calibration);
  if (evidence === null) return result;

  // Re-decide through the SAME policy with one extra corroborating source.
  // Deliberately a fresh decideAttribution rather than a hand-written promotion:
  // the logit floor, the margin bar and the tier ordering must still apply, and
  // re-implementing them here is how they would drift.
  const bumped: FusedCandidate[] = result.fusedCandidates.map((candidate, index) =>
    index === 0 ? { ...candidate, corroborationCount: candidate.corroborationCount + 1 } : candidate,
  );
  const promoted = decideAttribution(bumped, result.policyMode);
  // Still held ⇒ hands off entirely. The pick was failing more than the
  // corroboration gate; 'corroboration' was just the first reason reported.
  if (promoted.action === 'inbox') return result;

  // Cap. See LANE_CORROBORATION_MAX_ACTION — a p≥0.6 signal may argue for
  // showing a suggestion, never for filing a page.
  const action: AttributionAction =
    promoted.action === 'auto-apply' ? LANE_CORROBORATION_MAX_ACTION : promoted.action;
  const capped = action !== promoted.action;

  const required = requiredCorroborationFor(top, result.policyMode);
  const gate: PolicyGate = {
    // The reason comes from the re-decision (cleared-suggest / regret-budget),
    // so the enum keeps meaning exactly what it means everywhere else.
    reason: capped ? 'cleared-suggest' : promoted.gate.reason,
    detail:
      `corroboration ${num(top.corroborationCount)}+1 ` +
      `(lanes ${LANE_CORROBORATION_LANES.join('+')} p=${num(evidence.precision)},n=${String(evidence.n)}) ` +
      `≥ ${num(required)} · ${promoted.gate.detail}` +
      `${capped ? ' · capped at suggest' : ''}${LANE_CORROBORATION_GATE_MARK}`,
  };

  return {
    ...result,
    decision: {
      action,
      ...(promoted.workstreamId === undefined ? {} : { workstreamId: promoted.workstreamId }),
      margin: promoted.margin,
      gate,
    },
    // fusedCandidates untouched — see the doc comment.
  };
};

// The workstream BOTH corroborating lanes put first, or null. Requires a real
// top candidate in every lane in LANE_CORROBORATION_LANES: a typed-empty lane
// is an abstention, and an abstention is not agreement.
const agreedLaneWorkstream = (lanes: readonly GuessLaneResult[] | undefined): string | null => {
  if (lanes === undefined) return null;
  let agreed: string | null = null;
  for (const laneId of LANE_CORROBORATION_LANES) {
    const lane = lanes.find((entry) => entry.lane === laneId);
    const top = lane?.candidates[0];
    if (top === undefined || top.workstreamId.length === 0) return null;
    if (agreed === null) agreed = top.workstreamId;
    else if (agreed !== top.workstreamId) return null;
  }
  return agreed;
};

// The BINDING measured evidence: the weaker of the two lanes on each axis.
// Reported (and gated) on the weaker lane because that is what the agreement is
// actually worth — a 0.9-precision content lane agreeing with a 0.3-precision
// ai lane is a 0.3-precision corroboration, not a 0.6 one.
const laneEvidence = (
  calibration: LanePrequentialSummary | null | undefined,
): { readonly precision: number; readonly n: number } | null => {
  if (calibration === null || calibration === undefined) return null;
  if (calibration.status !== 'ok') return null;
  let minPrecision = Number.POSITIVE_INFINITY;
  let minSamples = Number.POSITIVE_INFINITY;
  for (const laneId of LANE_CORROBORATION_LANES) {
    const measured = lanePrecisionFrom(calibration, laneId);
    if (measured === null || measured.precision === null) return null;
    if (measured.n < LANE_CORROBORATION_MIN_SAMPLES) return null;
    if (measured.precision < LANE_CORROBORATION_MIN_PRECISION) return null;
    if (measured.precision < minPrecision) minPrecision = measured.precision;
    if (measured.n < minSamples) minSamples = measured.n;
  }
  if (!Number.isFinite(minPrecision) || !Number.isFinite(minSamples)) return null;
  return { precision: minPrecision, n: minSamples };
};
