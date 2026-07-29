import type { FusedCandidate } from './fusion.js';

export type AttributionPolicyMode = 'conservative' | 'balanced' | 'aggressive';
export type AttributionAction = 'auto-apply' | 'suggest' | 'inbox';

// The pipeline-gate reason (frozen wire contract). Which policy gate stopped
// promotion — or, for a cleared decision, which tier the pick earned. The
// `decision.margin` alone told the panel "close call" without saying WHICH gate
// decided; `gate` closes that opacity so the strip can explain every outcome.
// The enum is small and STABLE (the extension pattern-matches on it); the
// specificity — the actual numbers and the tie-break — lives in `detail`. See
// `gateFor` for the reason each value carries.
export type PolicyGateReason =
  | 'no-candidates'
  | 'corroboration'
  | 'below-suggest'
  | 'margin-tie'
  | 'regret-budget'
  | 'cleared-suggest'
  | 'cleared-auto';

export interface PolicyGate {
  readonly reason: PolicyGateReason;
  // One short human line WITH the numbers, e.g. "top 0.82 < 1.2 suggest bar" /
  // "margin 0.10 < 0.35" / "corroboration 1 < 2 (similarity-dominant)" /
  // "cleared: 1.4 ≥ 1.2, margin 0.9". The enum is for machines; this is for the
  // human reading the strip.
  readonly detail: string;
}

export interface PolicyDecision {
  readonly action: AttributionAction;
  readonly workstreamId?: string;
  readonly margin: number;
  // WHICH gate decided this outcome (pipeline-gate feature). Emitted on EVERY
  // decision — cleared outcomes carry 'cleared-suggest'/'cleared-auto' so the
  // provenance is symmetric with the inbox reasons. Additive on the wire; all
  // resolve routes already pass `decision` through verbatim, so it rides for
  // free.
  readonly gate: PolicyGate;
}

export interface AttributionPolicyTelemetry {
  readonly regretRateBySource?: Partial<
    Record<Exclude<FusedCandidate['dominantSource'], 'none'>, number>
  >;
}

const POLICY = {
  conservative: { suggest: 2.2, auto: Number.POSITIVE_INFINITY, margin: 0.75, corroboration: 2 },
  balanced: { suggest: 1.2, auto: 2.8, margin: 0.35, corroboration: 1 },
  aggressive: { suggest: 0.6, auto: 2.0, margin: 0.2, corroboration: 1 },
} as const;

// simAgreement = min(1, supportingScores / 10). At or below this, the pick is
// backed by only 1–2 similar neighbors — too thin to trust on its own.
const SIMILARITY_LONE_AGREEMENT_MAX = 0.2;

// Two-decimal formatter for the gate detail line. The logits/margins are hand-
// weighted priors (fusion.ts), so more precision would be noise in a human-
// facing line — 0.82 not 0.8231. Trailing-zero trim keeps "1.2" not "1.20".
const num = (value: number): string => Number(value.toFixed(2)).toString();

/**
 * How many corroborating evidence channels this pick must show.
 *
 * EXPORTED so the lane-corroboration promotion (tabsession/laneCorroboration.ts)
 * can report the bar it is clearing without re-deriving the lift rule. Two
 * copies of this rule would drift the moment the guard is tuned, and the
 * drifted copy would be the one printing the number a human reads.
 *
 * The rule itself (unchanged): a similarity-dominant pick with weak agreement
 * and no corroborating signal (no graph path, no topic cluster) is frequently a
 * lexical/site-skeleton false-friend — e.g. two unrelated items sharing an
 * aggregator platform's URL skeleton. Demand a second corroborating source
 * before surfacing such a pick, regardless of raw score.
 *
 * Keyed off whether similarity is the top RAW evidence channel, NOT off
 * `dominantSource`. The diagnostic label is the argmax of the WEIGHTED
 * contribution, where a small nonzero pprScore (×5.0 weight) can out-rank a
 * genuinely-thin similarity family and flip the label to 'ppr' — which is
 * exactly the aggregator false-friend shape this guard exists to catch (a
 * shared-platform link graph yields a tiny PPR alongside the skeleton-match
 * similarity). Re-keying off the raw simTopScore dominance keeps the guard
 * firing on that flip case while never firing on a genuinely PPR- or
 * cluster-dominant pick.
 */
export const requiredCorroborationFor = (
  top: FusedCandidate,
  mode: AttributionPolicyMode = 'balanced',
): number => {
  const policy = POLICY[mode];
  const similarityIsTopRawChannel =
    top.simTopScore >= top.pprScore && top.simTopScore >= top.clusterPosterior;
  return similarityIsTopRawChannel && top.simAgreement <= SIMILARITY_LONE_AGREEMENT_MAX
    ? Math.max(policy.corroboration, 2)
    : policy.corroboration;
};

export const decideAttribution = (
  candidates: readonly FusedCandidate[],
  mode: AttributionPolicyMode = 'balanced',
  telemetry: AttributionPolicyTelemetry = {},
): PolicyDecision => {
  const [top, second] = candidates;
  // No candidate reached fusion at all — the strip has nothing to explain, so
  // the earliest gate ('no-candidates') stands. Margin is 0 (nothing to beat).
  if (top === undefined) {
    return {
      action: 'inbox',
      margin: 0,
      gate: { reason: 'no-candidates', detail: 'no candidates reached fusion' },
    };
  }
  const margin = top.rawFusionLogit - (second?.rawFusionLogit ?? 0);
  const policy = POLICY[mode];
  const dominantSource = top.dominantSource === 'none' ? undefined : top.dominantSource;
  const regretRate =
    dominantSource === undefined
      ? Number.POSITIVE_INFINITY
      : (telemetry.regretRateBySource?.[dominantSource] ?? 0);
  const regretBudget =
    dominantSource === 'ppr' ? 0.08 : dominantSource === 'similarity' ? 0.05 : 0.12;
  // Defense-in-depth: a similarity-dominant pick with weak agreement and no
  // corroborating signal (no graph path, no topic cluster) is frequently a
  // lexical/site-skeleton false-friend — e.g. two unrelated items sharing an
  // aggregator platform's URL skeleton. Demand a second corroborating source
  // before surfacing such a pick, regardless of raw score.
  //
  // Key this off whether similarity is the top RAW evidence channel, NOT off
  // `dominantSource`. The diagnostic label is the argmax of the WEIGHTED
  // contribution, where a small nonzero pprScore (×5.0 weight) can out-rank a
  // genuinely-thin similarity family and flip the label to 'ppr' — which is
  // exactly the aggregator false-friend shape this guard exists to catch (a
  // shared-platform link graph yields a tiny PPR alongside the skeleton-match
  // similarity). Re-keying off the raw simTopScore dominance keeps the guard
  // firing on that flip case while never firing on a genuinely PPR- or
  // cluster-dominant pick.
  const requiredCorroboration = requiredCorroborationFor(top, mode);
  if (
    top.rawFusionLogit >= policy.auto &&
    margin >= policy.margin &&
    top.corroborationCount >= requiredCorroboration &&
    regretRate <= regretBudget
  ) {
    return {
      action: 'auto-apply',
      workstreamId: top.workstreamId,
      margin,
      gate: {
        reason: 'cleared-auto',
        detail: `cleared: ${num(top.rawFusionLogit)} ≥ ${num(policy.auto)} auto bar, margin ${num(margin)} ≥ ${num(policy.margin)}`,
      },
    };
  }
  if (
    top.rawFusionLogit >= policy.suggest &&
    margin >= policy.margin &&
    top.corroborationCount >= requiredCorroboration
  ) {
    // This pick surfaces as a SUGGEST. If it also cleared the (higher) auto
    // logit bar — with margin + corroboration already satisfied here — then the
    // ONLY thing that held it back from auto-apply is the regret budget (the
    // sole remaining auto-gate term). The gate that actually decided the
    // suggest-not-auto outcome is therefore 'regret-budget', and the strip
    // should say so rather than the generic 'cleared-suggest'. Otherwise the
    // pick genuinely sits in the suggest band and 'cleared-suggest' stands.
    const autoBlockedByRegret =
      top.rawFusionLogit >= policy.auto && regretRate > regretBudget;
    return {
      action: 'suggest',
      workstreamId: top.workstreamId,
      margin,
      gate: autoBlockedByRegret
        ? {
            reason: 'regret-budget',
            detail: `regret ${num(regretRate)} > ${num(regretBudget)} budget (auto→suggest)`,
          }
        : {
            reason: 'cleared-suggest',
            detail: `cleared: ${num(top.rawFusionLogit)} ≥ ${num(policy.suggest)} suggest bar, margin ${num(margin)} ≥ ${num(policy.margin)}`,
          },
    };
  }
  // INBOX — report the FIRST failing gate in evaluation order (the contract's
  // ordering: corroboration → suggest-logit → margin). The suggest tier is the
  // promotion frontier, so its bars decide the reason: a pick that fails
  // corroboration would still fail even if the logit cleared, so corroboration
  // is reported first; then the suggest logit floor; then the margin tie. (The
  // regret budget is NOT an inbox reason — a pick that reaches the regret term
  // has already cleared logit+margin+corroboration and so surfaces at least as
  // a suggest above; its regret demotion is reported on the SUGGEST decision.)
  return { action: 'inbox', margin, gate: inboxGate(top, margin, policy, requiredCorroboration) };
};

// The first-failing-gate classifier for an inbox outcome. Evaluated in the
// contract's order so a pick failing multiple gates (e.g. both below the
// suggest logit AND under the margin) reports the EARLIEST one ('below-suggest'),
// matching how a human would triage it: fix the logit before worrying about the
// margin.
const inboxGate = (
  top: FusedCandidate,
  margin: number,
  policy: (typeof POLICY)[AttributionPolicyMode],
  requiredCorroboration: number,
): PolicyGate => {
  // 1. Corroboration — the defense-in-depth guard (a lone thin-similarity pick
  //    demands a second source). Report it first: no logit clears a
  //    single-source false-friend, so this is the actionable reason.
  if (top.corroborationCount < requiredCorroboration) {
    const lifted = requiredCorroboration > policy.corroboration;
    return {
      reason: 'corroboration',
      detail: `corroboration ${num(top.corroborationCount)} < ${num(requiredCorroboration)}${lifted ? ' (similarity-dominant)' : ''}`,
    };
  }
  // 2. Suggest logit floor — the pick simply is not strong enough to surface.
  if (top.rawFusionLogit < policy.suggest) {
    return {
      reason: 'below-suggest',
      detail: `top ${num(top.rawFusionLogit)} < ${num(policy.suggest)} suggest bar`,
    };
  }
  // 3. Margin tie — the pick clears the logit floor + corroboration but the
  //    runner-up is too close to trust the ordering.
  return {
    reason: 'margin-tie',
    detail: `margin ${num(margin)} < ${num(policy.margin)}`,
  };
};
