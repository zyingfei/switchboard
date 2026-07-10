import type { FusedCandidate } from './fusion.js';

export type AttributionPolicyMode = 'conservative' | 'balanced' | 'aggressive';
export type AttributionAction = 'auto-apply' | 'suggest' | 'inbox';

export interface PolicyDecision {
  readonly action: AttributionAction;
  readonly workstreamId?: string;
  readonly margin: number;
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

export const decideAttribution = (
  candidates: readonly FusedCandidate[],
  mode: AttributionPolicyMode = 'balanced',
  telemetry: AttributionPolicyTelemetry = {},
): PolicyDecision => {
  const [top, second] = candidates;
  if (top === undefined) return { action: 'inbox', margin: 0 };
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
  const requiredCorroboration =
    top.dominantSource === 'similarity' && top.simAgreement <= SIMILARITY_LONE_AGREEMENT_MAX
      ? Math.max(policy.corroboration, 2)
      : policy.corroboration;
  if (
    top.rawFusionLogit >= policy.auto &&
    margin >= policy.margin &&
    top.corroborationCount >= requiredCorroboration &&
    regretRate <= regretBudget
  ) {
    return { action: 'auto-apply', workstreamId: top.workstreamId, margin };
  }
  if (
    top.rawFusionLogit >= policy.suggest &&
    margin >= policy.margin &&
    top.corroborationCount >= requiredCorroboration
  ) {
    return { action: 'suggest', workstreamId: top.workstreamId, margin };
  }
  return { action: 'inbox', margin };
};
