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
      const dominantSource: FusedCandidate['dominantSource'] =
        candidate.pprScore >= candidate.simTopScore &&
        candidate.pprScore >= candidate.clusterPosterior
          ? 'ppr'
          : candidate.simTopScore >= candidate.clusterPosterior
            ? 'similarity'
            : candidate.clusterPosterior > 0
              ? 'cluster'
              : 'none';
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
