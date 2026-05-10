import type { FusedCandidate } from './fusion.js';

export type AttributionPolicyMode = 'conservative' | 'balanced' | 'aggressive';
export type AttributionAction = 'auto-apply' | 'suggest' | 'inbox';

export interface PolicyDecision {
  readonly action: AttributionAction;
  readonly workstreamId?: string;
  readonly margin: number;
}

const POLICY = {
  conservative: { suggest: 2.2, auto: Number.POSITIVE_INFINITY, margin: 0.75, corroboration: 2 },
  balanced: { suggest: 1.2, auto: 2.8, margin: 0.35, corroboration: 1 },
  aggressive: { suggest: 0.6, auto: 2.0, margin: 0.2, corroboration: 1 },
} as const;

export const decideAttribution = (
  candidates: readonly FusedCandidate[],
  mode: AttributionPolicyMode = 'balanced',
): PolicyDecision => {
  const [top, second] = candidates;
  if (top === undefined) return { action: 'inbox', margin: 0 };
  const margin = top.rawFusionLogit - (second?.rawFusionLogit ?? 0);
  const policy = POLICY[mode];
  if (
    top.rawFusionLogit >= policy.auto &&
    margin >= policy.margin &&
    top.corroborationCount >= policy.corroboration
  ) {
    return { action: 'auto-apply', workstreamId: top.workstreamId, margin };
  }
  if (
    top.rawFusionLogit >= policy.suggest &&
    margin >= policy.margin &&
    top.corroborationCount >= policy.corroboration
  ) {
    return { action: 'suggest', workstreamId: top.workstreamId, margin };
  }
  return { action: 'inbox', margin };
};
