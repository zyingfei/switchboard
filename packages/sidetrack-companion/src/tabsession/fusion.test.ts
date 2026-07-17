import { describe, expect, it } from 'vitest';

import { fuseCandidates, type CandidateEvidence } from './fusion.js';

// The hand-set weights, mirrored here so the test can compute the expected
// fused logit independently of the implementation (proving the served
// score is untouched by the dominant-source label change).
const W = {
  intercept: -1.2,
  pprScore: 5.0,
  simTopScore: 1.6,
  simMeanScore: 1.0,
  simAgreement: 0.75,
  simMargin: 0.8,
  clusterPosterior: 1.2,
  corroborationCount: 0.35,
} as const;

const expectedLogit = (c: CandidateEvidence): number =>
  W.intercept +
  c.pprScore * W.pprScore +
  c.simTopScore * W.simTopScore +
  c.simMeanScore * W.simMeanScore +
  c.simAgreement * W.simAgreement +
  c.simMargin * W.simMargin +
  c.clusterPosterior * W.clusterPosterior +
  c.corroborationCount * W.corroborationCount;

const base = (over: Partial<CandidateEvidence> & { workstreamId: string }): CandidateEvidence => ({
  pprScore: 0,
  simTopScore: 0,
  simMeanScore: 0,
  simAgreement: 0,
  simMargin: 0,
  clusterPosterior: 0,
  corroborationCount: 0,
  ...over,
});

describe('fuseCandidates — served score & ordering are byte-identical', () => {
  it('rawFusionLogit equals the weighted-sum formula for every candidate', () => {
    const candidates = [
      base({ workstreamId: 'a', pprScore: 0.12, simTopScore: 0.4, clusterPosterior: 0.3, corroborationCount: 2 }),
      base({ workstreamId: 'b', pprScore: 0.5, simMeanScore: 0.2, simMargin: 0.1, corroborationCount: 1 }),
      base({ workstreamId: 'c', clusterPosterior: 0.9, simAgreement: 0.6, corroborationCount: 3 }),
    ];
    for (const fused of fuseCandidates(candidates)) {
      const original = candidates.find((c) => c.workstreamId === fused.workstreamId)!;
      expect(fused.rawFusionLogit).toBe(expectedLogit(original));
    }
  });

  it('sorts by descending logit, tie-broken by workstreamId — unchanged', () => {
    // Two candidates with an identical logit must order by workstreamId.
    const tie = [
      base({ workstreamId: 'z', pprScore: 0.2 }),
      base({ workstreamId: 'a', pprScore: 0.2 }),
      base({ workstreamId: 'm', pprScore: 0.9 }),
    ];
    expect(fuseCandidates(tie).map((c) => c.workstreamId)).toEqual(['m', 'a', 'z']);
  });
});

describe('fuseCandidates — dominantSource is argmax of WEIGHTED contribution', () => {
  it('labels PPR dominant even when a raw compare would pick similarity', () => {
    // Raw argmax: simTopScore (0.3) > pprScore (0.12) > clusterPosterior (0)
    //   → the OLD code labelled this 'similarity'.
    // Weighted: ppr 0.12×5.0 = 0.60 vs similarity 0.3×1.6 = 0.48
    //   → ppr actually dominates the fused logit.
    const [fused] = fuseCandidates([
      base({ workstreamId: 'a', pprScore: 0.12, simTopScore: 0.3, corroborationCount: 1 }),
    ]);
    expect(fused!.dominantSource).toBe('ppr');
  });

  it('sums the similarity FAMILY (top+mean+agreement+margin) for its contribution', () => {
    // ppr 0.15×5.0 = 0.75.
    // similarity family: top 0.1×1.6 + mean 0.2×1.0 + agreement 0.4×0.75 + margin 0.3×0.8
    //   = 0.16 + 0.20 + 0.30 + 0.24 = 0.90 > 0.75 → similarity dominates.
    // (Raw simTopScore alone, 0.1, would have lost to ppr 0.15.)
    const [fused] = fuseCandidates([
      base({
        workstreamId: 'a',
        pprScore: 0.15,
        simTopScore: 0.1,
        simMeanScore: 0.2,
        simAgreement: 0.4,
        simMargin: 0.3,
        corroborationCount: 1,
      }),
    ]);
    expect(fused!.dominantSource).toBe('similarity');
  });

  it('labels cluster dominant when its weighted contribution wins', () => {
    // cluster 0.9×1.2 = 1.08 vs ppr 0.1×5.0 = 0.5 vs sim 0.2×1.6 = 0.32.
    const [fused] = fuseCandidates([
      base({ workstreamId: 'a', pprScore: 0.1, simTopScore: 0.2, clusterPosterior: 0.9, corroborationCount: 1 }),
    ]);
    expect(fused!.dominantSource).toBe('cluster');
  });
});

describe('fuseCandidates — the "none" emit gate is preserved for real evidence', () => {
  it('never returns "none" for non-negative scores (emit gate preserved)', () => {
    // The resolver DROPS a candidate whose dominantSource === 'none'
    // (resolver.ts). The invariant that must stay byte-identical is the
    // EMIT gate: for any ≥0 evidence, both the raw and the weighted
    // formulation return a non-'none' label, so the same candidates emit.
    // (The degenerate all-zero label itself is a meaningless tie-break and
    // is allowed to differ — the honesty fix is precisely about the label.)
    const scans: readonly CandidateEvidence[] = [
      base({ workstreamId: 'a', corroborationCount: 1 }),
      base({ workstreamId: 'b', pprScore: 0.4, corroborationCount: 1 }),
      base({ workstreamId: 'c', simTopScore: 0.5, clusterPosterior: 0.3, corroborationCount: 1 }),
      base({ workstreamId: 'd', clusterPosterior: 0.7, corroborationCount: 1 }),
    ];
    for (const fused of fuseCandidates(scans)) {
      expect(fused!.dominantSource).not.toBe('none');
    }
  });
});
