import { describe, expect, it } from 'vitest';

import { partitionResultsByConfidence } from './pipeline.js';
import type { RecallCandidate } from './types.js';

const candidate = (score: number, index: number): RecallCandidate => ({
  candidateId: `candidate-${String(index)}`,
  entityId: `entity-${String(index)}`,
  sourceKind: 'page_content',
  fusedScore: score,
  evidence: [
    {
      retriever: 'fts5',
      sourceKind: 'page_content',
      rank: index + 1,
      rawScore: score,
    },
  ],
});

const tieringFor = (scores: readonly number[]) =>
  partitionResultsByConfidence(scores.map((score, index) => candidate(score, index)));

describe('partitionResultsByConfidence', () => {
  it('shows all three results when scores are above weakFloor and have no eligible gaps', () => {
    const tiering = tieringFor([0.72, 0.68, 0.63]);

    expect(tiering?.suggestedStrongCount).toBe(3);
    expect(tiering?.suggestedCollapsedCount).toBe(0);
    expect(tiering?.scores).toEqual([0.72, 0.68, 0.63]);
  });

  it('does not cut on a large gap before minStrong', () => {
    const tiering = tieringFor([0.9, 0.86, 0.56, 0.55, 0.54]);

    expect(tiering?.scoreGaps[2]).toBeCloseTo(0.3);
    expect(tiering?.confidenceStats.largestGap.index).toBe(2);
    expect(tiering?.confidenceStats.largestGap.delta).toBeCloseTo(0.3);
    // maxStrong=10 (bumped from 5 on 2026-05-26); 5 results, no
    // weakFloor cut, gap-cut would land at i=2 but we only cut
    // AFTER minStrong=3 → so strong covers all 5.
    expect(tiering?.suggestedStrongCount).toBe(5);
    expect(tiering?.suggestedCollapsedCount).toBe(0);
  });

  it('caps the strong band at maxStrong when many strong results have no gaps', () => {
    // 8 results, all above weakFloor, no gaps → all 8 stay strong
    // under the bumped maxStrong=10.
    const tiering = tieringFor([0.8, 0.78, 0.76, 0.74, 0.72, 0.7, 0.68, 0.66]);

    expect(tiering?.suggestedStrongCount).toBe(8);
    expect(tiering?.suggestedCollapsedCount).toBe(0);
  });

  it('caps strict at maxStrong (10) when more than 10 strong results exist', () => {
    // 14 results, all strong, no gaps → cap at maxStrong=10 strong + 4 collapsed.
    const scores = [
      0.95, 0.92, 0.9, 0.88, 0.86, 0.84, 0.82, 0.8, 0.78, 0.76, 0.74, 0.72, 0.7, 0.68,
    ];
    const tiering = tieringFor(scores);

    expect(tiering?.suggestedStrongCount).toBe(10);
    expect(tiering?.suggestedCollapsedCount).toBe(4);
  });

  it('uses all results when fewer than minStrong exist', () => {
    const tiering = tieringFor([0.7, 0.62]);

    expect(tiering?.suggestedStrongCount).toBe(2);
    expect(tiering?.suggestedCollapsedCount).toBe(0);
  });

  it('lets the weakFloor cut fire before a later large gap', () => {
    const tiering = tieringFor([0.35, 0.34, 0.31, 0.29, 0.04]);

    expect(tiering?.suggestedStrongCount).toBe(3);
    expect(tiering?.suggestedCollapsedCount).toBe(2);
    expect(tiering?.confidenceStats.largestGap.index).toBe(4);
    expect(tiering?.confidenceStats.largestGap.delta).toBeCloseTo(0.25);
  });
});
