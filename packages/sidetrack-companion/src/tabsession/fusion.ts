export interface CandidateEvidence {
  readonly workstreamId: string;
  readonly pprScore: number;
  readonly simTopScore: number;
  readonly simMeanScore: number;
  readonly simAgreement: number;
  readonly simMargin: number;
  readonly simMatchedTerms?: readonly string[];
  readonly clusterPosterior: number;
  readonly corroborationCount: number;
}

export interface FusedCandidate extends CandidateEvidence {
  readonly rawFusionLogit: number;
  readonly dominantSource: 'ppr' | 'similarity' | 'cluster' | 'none';
}

// Hand-set log-likelihood ratios. These are priors, not learned
// calibration values: PPR carries causal graph structure, similarity
// carries content neighborhood, and cluster carries topic posterior.
const WEIGHTS = {
  intercept: -1.2,
  pprScore: 5.0,
  simTopScore: 1.6,
  simMeanScore: 1.0,
  simAgreement: 0.75,
  simMargin: 0.8,
  clusterPosterior: 1.2,
  corroborationCount: 0.35,
} as const;

export const fuseCandidates = (
  candidates: readonly CandidateEvidence[],
): readonly FusedCandidate[] =>
  candidates
    .map((candidate) => {
      const rawFusionLogit =
        WEIGHTS.intercept +
        candidate.pprScore * WEIGHTS.pprScore +
        candidate.simTopScore * WEIGHTS.simTopScore +
        candidate.simMeanScore * WEIGHTS.simMeanScore +
        candidate.simAgreement * WEIGHTS.simAgreement +
        candidate.simMargin * WEIGHTS.simMargin +
        candidate.clusterPosterior * WEIGHTS.clusterPosterior +
        candidate.corroborationCount * WEIGHTS.corroborationCount;
      // Dominant-source LABEL. Does NOT feed the fused score or the
      // ordering (both are `rawFusionLogit`, computed above). It DOES feed
      // policy.ts: it selects the per-source regret budget/rate telemetry
      // gate. It does NOT drive the aggregator false-friend guard — that
      // guard is deliberately keyed off the raw simTopScore dominance, not
      // this label, so a label flip cannot bypass it (see policy.ts).
      //
      // Pick the channel that actually contributes the most to
      // `rawFusionLogit`, i.e. argmax of WEIGHTED contribution
      // (weight × value), not argmax of the raw channel values. The raw
      // comparison was misleading: PPR carries a 5× weight, so a small
      // pprScore can dominate the logit while losing a raw compare to a
      // larger-but-lightly-weighted simTopScore. Similarity is a FAMILY
      // (top + mean + agreement + margin), so its contribution is the sum
      // of the family's weighted terms.
      const pprContribution = candidate.pprScore * WEIGHTS.pprScore;
      const similarityContribution =
        candidate.simTopScore * WEIGHTS.simTopScore +
        candidate.simMeanScore * WEIGHTS.simMeanScore +
        candidate.simAgreement * WEIGHTS.simAgreement +
        candidate.simMargin * WEIGHTS.simMargin;
      const clusterContribution = candidate.clusterPosterior * WEIGHTS.clusterPosterior;
      // Preserve the exact `'none'` gate from the raw formulation so the
      // set of candidates that emit (resolver gates on dominantSource ===
      // 'none') is byte-identical: 'none' only when the cluster channel is
      // non-positive AND neither ppr nor similarity out-ranks it on the
      // (non-negative) raw scores — unreachable for real ≥0 evidence,
      // exactly as before.
      const dominantSource: FusedCandidate['dominantSource'] =
        candidate.clusterPosterior <= 0 &&
        candidate.simTopScore < candidate.clusterPosterior &&
        !(
          candidate.pprScore >= candidate.simTopScore &&
          candidate.pprScore >= candidate.clusterPosterior
        )
          ? 'none'
          : pprContribution >= similarityContribution &&
              pprContribution >= clusterContribution
            ? 'ppr'
            : similarityContribution >= clusterContribution
              ? 'similarity'
              : 'cluster';
      return { ...candidate, rawFusionLogit, dominantSource };
    })
    .sort((left, right) => {
      if (left.rawFusionLogit !== right.rawFusionLogit) {
        return right.rawFusionLogit - left.rawFusionLogit;
      }
      return left.workstreamId < right.workstreamId
        ? -1
        : left.workstreamId > right.workstreamId
          ? 1
          : 0;
    });
