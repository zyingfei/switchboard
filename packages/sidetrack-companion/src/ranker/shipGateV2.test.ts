// Phase 6 of the recall+ranker v2 hard-replacement —
// ship-gate decision + impression-metric contract tests.
//
// Verifies (against synthetic groups so the framework is
// independently testable without the trainer wiring):
//   - PASS when active beats baseline on ndcg@10 or MRR + does not
//     regress explicit_reject_precision + Phase-1 invariants hold
//   - FAIL when Cartesian artifacts present (expandedNegativeCount > 0)
//   - FAIL when label drift without feedback (labelDriftWithoutFeedback > 0)
//   - FAIL when explicit_reject_precision regresses
//   - FAIL when no primary metric improves
//   - UNAVAILABLE when below cold-start threshold OR reserved test reused
//   - Impression metrics compute correctly on a 3-group fixture

import { describe, expect, it } from 'vitest';

import {
  computeImpressionMetrics,
  shipGateV2Decide,
  type ImpressionGroupForMetrics,
  type ImpressionMetrics,
  type ShipGateV2Input,
} from './shipGateV2.js';

const goodMetrics = (overrides?: Partial<ImpressionMetrics>): ImpressionMetrics => ({
  nDcgAt5: 0.8,
  nDcgAt10: 0.85,
  mrr: 0.7,
  recallAt5: 0.9,
  recallAt10: 0.95,
  explicitRejectPrecision: 0.85,
  falsePositiveRateOnRejectedContexts: 0.1,
  impressionCount: 100,
  impressionsWithPositiveCount: 80,
  ...overrides,
});

const baseline = (overrides?: Partial<ImpressionMetrics>): ImpressionMetrics => ({
  nDcgAt5: 0.7,
  nDcgAt10: 0.75,
  mrr: 0.6,
  recallAt5: 0.85,
  recallAt10: 0.9,
  explicitRejectPrecision: 0.8,
  falsePositiveRateOnRejectedContexts: 0.15,
  impressionCount: 100,
  impressionsWithPositiveCount: 80,
  ...overrides,
});

const baseInput = (overrides?: Partial<ShipGateV2Input>): ShipGateV2Input => ({
  activeMetrics: goodMetrics(),
  baselineMetrics: baseline(),
  expandedNegativeCount: 0,
  labelDriftWithoutFeedback: 0,
  reservedTestUsedExactlyOnce: true,
  ...overrides,
});

describe('shipGateV2Decide', () => {
  it('passes when both ndcg@10 and MRR improve and Phase-1 invariants hold', () => {
    const decision = shipGateV2Decide(baseInput());
    expect(decision.status).toBe('pass');
    expect(decision.reason).toBe('pass_both_improved');
    expect(decision.deltas.nDcgAt10).toBeCloseTo(0.1, 5);
    expect(decision.deltas.mrr).toBeCloseTo(0.1, 5);
  });

  it('passes with reason pass_ndcg_improved when only ndcg improves', () => {
    const decision = shipGateV2Decide(
      baseInput({
        activeMetrics: goodMetrics({ mrr: 0.6 }), // tied → no MRR improvement
      }),
    );
    expect(decision.status).toBe('pass');
    expect(decision.reason).toBe('pass_ndcg_improved');
  });

  it('passes with reason pass_mrr_improved when only MRR improves', () => {
    const decision = shipGateV2Decide(
      baseInput({
        activeMetrics: goodMetrics({ nDcgAt10: 0.75 }), // tied
      }),
    );
    expect(decision.status).toBe('pass');
    expect(decision.reason).toBe('pass_mrr_improved');
  });

  it('fails on any expanded-negative residue (Phase 1 invariant)', () => {
    const decision = shipGateV2Decide(baseInput({ expandedNegativeCount: 5 }));
    expect(decision.status).toBe('fail');
    expect(decision.reason).toBe('fail_expanded_negatives_present');
  });

  it('fails on label drift without feedback (Phase 1 invariant)', () => {
    const decision = shipGateV2Decide(baseInput({ labelDriftWithoutFeedback: 1 }));
    expect(decision.status).toBe('fail');
    expect(decision.reason).toBe('fail_label_drift_without_feedback');
  });

  it('fails when explicit_reject_precision regresses', () => {
    const decision = shipGateV2Decide(
      baseInput({
        activeMetrics: goodMetrics({ explicitRejectPrecision: 0.7 }), // baseline = 0.8
      }),
    );
    expect(decision.status).toBe('fail');
    expect(decision.reason).toBe('fail_regressed_explicit_reject_precision');
  });

  it('fails when no primary metric improves', () => {
    const decision = shipGateV2Decide(
      baseInput({
        activeMetrics: goodMetrics({ nDcgAt10: 0.75, mrr: 0.6 }), // both tied
      }),
    );
    expect(decision.status).toBe('fail');
    expect(decision.reason).toBe('fail_no_primary_metric_improvement');
  });

  it('returns unavailable when below cold-start threshold', () => {
    const decision = shipGateV2Decide(
      baseInput({ activeMetrics: goodMetrics({ impressionsWithPositiveCount: 10 }) }),
    );
    expect(decision.status).toBe('unavailable');
    expect(decision.reason).toBe('unavailable_insufficient_groups');
  });

  it('returns unavailable when reserved test was reused', () => {
    const decision = shipGateV2Decide(baseInput({ reservedTestUsedExactlyOnce: false }));
    expect(decision.status).toBe('unavailable');
    expect(decision.reason).toBe('unavailable_reserved_test_reused');
  });

  it('honours a custom cold-start threshold', () => {
    const decision = shipGateV2Decide(
      baseInput({
        activeMetrics: goodMetrics({ impressionsWithPositiveCount: 40 }),
        minImpressionsWithPositive: 30,
      }),
    );
    expect(decision.status).toBe('pass');
  });
});

describe('computeImpressionMetrics', () => {
  it('returns zeros for an empty group list', () => {
    const metrics = computeImpressionMetrics([]);
    expect(metrics.impressionCount).toBe(0);
    expect(metrics.impressionsWithPositiveCount).toBe(0);
    expect(metrics.nDcgAt10).toBe(0);
    expect(metrics.mrr).toBe(0);
  });

  it('computes per-group nDCG / MRR / recall correctly', () => {
    // Group 1: one positive at rank 0 → ndcg@5 = 1.0, RR = 1.0, recall@5 = 1.0
    // Group 2: one positive at rank 2 → ndcg@5 = 1 / log2(4) = 0.5, RR = 1/3, recall@5 = 1.0
    // Group 3: no positives → excluded from positive-only metrics
    const groups: ImpressionGroupForMetrics[] = [
      {
        groupId: 'g1',
        rankedEntityIds: ['a', 'b', 'c'],
        labels: new Map([['a', 'positive']]),
      },
      {
        groupId: 'g2',
        rankedEntityIds: ['x', 'y', 'z'],
        labels: new Map([['z', 'positive']]),
      },
      {
        groupId: 'g3',
        rankedEntityIds: ['p', 'q'],
        labels: new Map([['p', 'negative']]),
      },
    ];
    const m = computeImpressionMetrics(groups);
    expect(m.impressionCount).toBe(3);
    expect(m.impressionsWithPositiveCount).toBe(2);
    // ndcg@5 average = (1.0 + 0.5) / 2 = 0.75
    expect(m.nDcgAt5).toBeCloseTo(0.75, 4);
    // MRR average = (1.0 + 1/3) / 2 ≈ 0.6667
    expect(m.mrr).toBeCloseTo((1.0 + 1 / 3) / 2, 4);
    // recall@5 average = (1.0 + 1.0) / 2 = 1.0
    expect(m.recallAt5).toBeCloseTo(1.0, 4);
  });

  it('computes explicit_reject_precision as share of rejects ranked below all positives', () => {
    // Group has 1 positive at rank 0, 2 rejects at ranks 1 + 2.
    // Both rejects are ranked below the positive → precision = 2/2 = 1.0
    const groups: ImpressionGroupForMetrics[] = [
      {
        groupId: 'g',
        rankedEntityIds: ['p', 'n1', 'n2'],
        labels: new Map([
          ['p', 'positive'],
          ['n1', 'negative'],
          ['n2', 'negative'],
        ]),
      },
    ];
    const m = computeImpressionMetrics(groups);
    expect(m.explicitRejectPrecision).toBeCloseTo(1.0, 4);
    // No reject ranked at position 1 → false-positive rate = 0
    expect(m.falsePositiveRateOnRejectedContexts).toBe(0);
  });

  it('counts a reject at top-1 as a false positive', () => {
    const groups: ImpressionGroupForMetrics[] = [
      {
        groupId: 'g',
        rankedEntityIds: ['n', 'p'],
        labels: new Map([
          ['n', 'negative'],
          ['p', 'positive'],
        ]),
      },
    ];
    const m = computeImpressionMetrics(groups);
    expect(m.falsePositiveRateOnRejectedContexts).toBe(1);
    // The single reject is ranked at 0, the single positive at 1.
    // Reject is NOT below the positive → precision contribution = 0
    expect(m.explicitRejectPrecision).toBe(0);
  });
});
