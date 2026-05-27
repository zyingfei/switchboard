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
    expect(tiering?.suggestedStrongCount).toBe(5);
    expect(tiering?.suggestedCollapsedCount).toBe(0);
  });

  it('caps the strong band at maxStrong when many strong results have no gaps', () => {
    const tiering = tieringFor([0.8, 0.78, 0.76, 0.74, 0.72, 0.7, 0.68, 0.66]);

    expect(tiering?.suggestedStrongCount).toBe(5);
    expect(tiering?.suggestedCollapsedCount).toBe(3);
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
