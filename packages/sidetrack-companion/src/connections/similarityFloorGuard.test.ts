import { describe, expect, it } from 'vitest';

import {
  SIMILARITY_FLOOR_MIN_RETAINED_FRACTION,
  carryForwardRevision,
  decideSimilarityFloorGuard,
  type SimilarityFloorResetReason,
} from './similarityFloorGuard.js';
import type { VisitSimilarityEdge, VisitSimilarityRevision } from './types.js';

const edge = (from: string, to: string, cosine = 0.9): VisitSimilarityEdge => ({
  fromVisitKey: from,
  toVisitKey: to,
  cosine,
});

const revision = (
  edges: readonly VisitSimilarityEdge[],
  revisionId = 'rev-new',
): VisitSimilarityRevision => ({
  revisionId,
  modelId: 'Xenova/multilingual-e5-small',
  modelRevision: 'r1',
  featureSchemaVersion: 1,
  threshold: 0.8,
  edges,
  producedAt: 1_700_000_000_000,
  producer: 'embedding',
});

const manyEdges = (count: number): readonly VisitSimilarityEdge[] =>
  Array.from({ length: count }, (_, i) => edge(`a${String(i)}`, `b${String(i)}`));

describe('decideSimilarityFloorGuard', () => {
  it('publishes when there is no previously served signal (cold boot)', () => {
    const outcome = decideSimilarityFloorGuard({
      candidate: revision([]),
      previousServedEdgeCount: null,
      resetReasons: [],
    });
    expect(outcome.action).toBe('publish');
  });

  it('publishes when previous served edge count is zero', () => {
    const outcome = decideSimilarityFloorGuard({
      candidate: revision(manyEdges(100)),
      previousServedEdgeCount: 0,
      resetReasons: [],
    });
    expect(outcome.action).toBe('publish');
  });

  it('publishes when the edge count is stable (no collapse)', () => {
    const outcome = decideSimilarityFloorGuard({
      candidate: revision(manyEdges(50_000)),
      previousServedEdgeCount: 51_000,
      resetReasons: [],
    });
    expect(outcome.action).toBe('publish');
    if (outcome.action === 'publish') expect(outcome.allowedResetReason).toBeNull();
  });

  it('publishes when the count GROWS', () => {
    const outcome = decideSimilarityFloorGuard({
      candidate: revision(manyEdges(60_000)),
      previousServedEdgeCount: 51_000,
      resetReasons: [],
    });
    expect(outcome.action).toBe('publish');
  });

  it('carries forward a 51k -> 0 collapse with no reset reason', () => {
    const outcome = decideSimilarityFloorGuard({
      candidate: revision([], 'f19d51808d263e43'),
      previousServedEdgeCount: 51_941,
      resetReasons: [],
    });
    expect(outcome.action).toBe('carry-forward');
    if (outcome.action === 'carry-forward') {
      expect(outcome.previousServedEdgeCount).toBe(51_941);
      expect(outcome.candidateEdgeCount).toBe(0);
      expect(outcome.requiredEdgeFloor).toBe(
        Math.ceil(51_941 * SIMILARITY_FLOOR_MIN_RETAINED_FRACTION),
      );
    }
  });

  it('carries forward a >90% collapse that is not fully empty', () => {
    // 51000 -> 1000 is a ~98% collapse (below the 10% retained floor).
    const outcome = decideSimilarityFloorGuard({
      candidate: revision(manyEdges(1_000)),
      previousServedEdgeCount: 51_000,
      resetReasons: [],
    });
    expect(outcome.action).toBe('carry-forward');
  });

  it('does NOT carry forward a collapse that stays above the 10% floor', () => {
    // 51000 -> 6000 retains ~11.7% — above the floor, so publish.
    const outcome = decideSimilarityFloorGuard({
      candidate: revision(manyEdges(6_000)),
      previousServedEdgeCount: 51_000,
      resetReasons: [],
    });
    expect(outcome.action).toBe('publish');
  });

  const resetReasons: readonly SimilarityFloorResetReason[] = [
    'embedding-model-change',
    'materializer-version-bump',
    'store-corruption-recovery',
    'privacy-purge',
    'operator-rebuild',
    // A corpus-config flip (clean-corpus / content-corpus) legitimately
    // recomputes every edge, so the intentional collapse MUST publish rather
    // than carry the stale dirty revision forward (findings B4/B5). This asserts
    // the guard honours the new reason.
    'corpus-config-change',
  ];

  for (const reason of resetReasons) {
    it(`ALLOWS a 51k -> 0 collapse under reset reason "${reason}"`, () => {
      const outcome = decideSimilarityFloorGuard({
        candidate: revision([]),
        previousServedEdgeCount: 51_941,
        resetReasons: [reason],
      });
      expect(outcome.action).toBe('publish');
      if (outcome.action === 'publish') expect(outcome.allowedResetReason).toBe(reason);
    });
  }

  it('treats "no-previous-signal" as NOT a permitting reason (still carries forward)', () => {
    const outcome = decideSimilarityFloorGuard({
      candidate: revision([]),
      previousServedEdgeCount: 51_941,
      resetReasons: ['no-previous-signal'],
    });
    expect(outcome.action).toBe('carry-forward');
  });

  it('carries forward a sustained collapse while the escape is NOT yet reached', () => {
    const outcome = decideSimilarityFloorGuard({
      candidate: revision([]),
      previousServedEdgeCount: 51_941,
      resetReasons: [],
      sustainedCollapseReached: false,
    });
    expect(outcome.action).toBe('carry-forward');
  });

  it('PUBLISHES a sustained collapse once the bounded-recovery escape is reached', () => {
    // A real deletion: the same low count has been rebuilt for N drains.
    // The escape accepts the new lower revision as the truth instead of
    // pinning the old high revision forever.
    const outcome = decideSimilarityFloorGuard({
      candidate: revision([]),
      previousServedEdgeCount: 51_941,
      resetReasons: [],
      sustainedCollapseReached: true,
    });
    expect(outcome.action).toBe('publish');
    if (outcome.action === 'publish') {
      expect(outcome.allowedResetReason).toBe('sustained-collapse-accepted');
    }
  });
});

describe('carryForwardRevision', () => {
  it('rebuilds a revision from the previous id + previous edges', () => {
    const previousEdges = manyEdges(51_941);
    const carried = carryForwardRevision(
      {
        revisionId: 'bc086557d39de8b5',
        modelId: 'Xenova/multilingual-e5-small',
        modelRevision: 'r1',
        featureSchemaVersion: 1,
        threshold: 0.8,
        producer: 'embedding',
      },
      previousEdges,
      1_700_000_000_500,
    );
    expect(carried.revisionId).toBe('bc086557d39de8b5');
    expect(carried.edges).toHaveLength(51_941);
    expect(carried.producer).toBe('embedding');
    expect(carried.producedAt).toBe(1_700_000_000_500);
  });

  it('omits producer when the previous revision had none', () => {
    const carried = carryForwardRevision(
      {
        revisionId: 'rev',
        modelId: 'Xenova/multilingual-e5-small',
        modelRevision: 'r1',
        featureSchemaVersion: 1,
        threshold: 0.8,
      },
      [],
      1,
    );
    expect('producer' in carried).toBe(false);
  });
});
