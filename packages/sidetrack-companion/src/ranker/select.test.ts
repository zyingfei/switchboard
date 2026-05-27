import { describe, expect, it } from 'vitest';

import { FEATURE_SCHEMA_VERSION } from './feature-schema.js';
import { isServeable, selectActiveRanker } from './select.js';
import {
  COMBINER_FEATURE_KINDS,
  composeCombinerVector,
  RANKER_FEATURE_KEYS,
  RANKER_MODEL_VERSION,
  scoreCombiner,
  type RankerArtifactKind,
  type RankerArtifactQuality,
  type RankerRevision,
} from './train.js';

// Step 4 of the incremental-ranker plan. The selector is a pure
// function over `RankerRevision`; tests don't need a temp vault.

const baseRevision = (overrides: Partial<RankerRevision> = {}): RankerRevision => ({
  revisionId: 'rev-test',
  modelVersion: RANKER_MODEL_VERSION,
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
  trainingDatasetHash: 'a'.repeat(64),
  trainedAt: 1779000000000,
  trainedFromImpressions: true,
  modelBytes: new ArrayBuffer(64), // non-zero so isServeable(lightgbm) holds
  ...overrides,
});

const artifact = (
  kind: RankerArtifactKind,
  status: 'pass' | 'fail' | 'unavailable',
  reservedTestNdcg: number | undefined,
  reasonOverride?: string,
): RankerArtifactQuality => ({
  kind,
  candidate: `version-${kind}`,
  shipGate: {
    status,
    reason:
      reasonOverride ??
      (status === 'pass'
        ? 'artifact-cleared-baseline-and-floor'
        : status === 'fail'
          ? 'artifact-does-not-beat-baseline'
          : 'reserved-test-metric-unavailable'),
  },
  ...(reservedTestNdcg === undefined
    ? {}
    : { reservedTestMetric: { kind: 'reserved-test ndcg@5', value: reservedTestNdcg } }),
});

describe('selectActiveRanker', () => {
  it('picks the passing artifact with the highest reservedTestNdcg', () => {
    const revision = baseRevision({
      logisticBatchWeights: Array.from({ length: RANKER_FEATURE_KEYS.length + 1 }, () => 0),
      logisticBatchFeatureStatsVersion: 'no-normalization-v1',
      artifactQuality: [
        artifact('graph_baseline', 'pass', 0.55),
        artifact('logistic_batch', 'pass', 0.62),
        artifact('lightgbm_lambdamart', 'pass', 0.68),
      ],
    });

    const selection = selectActiveRanker(revision);

    expect(selection).toMatchObject({
      selectedKind: 'lightgbm_lambdamart',
      selectedRevisionId: 'rev-test',
      reservedTestNdcgAt5: 0.68,
      reason: 'best_passing',
    });
  });

  it('falls back to graph_baseline when nothing passes', () => {
    const revision = baseRevision({
      artifactQuality: [
        artifact('graph_baseline', 'unavailable', undefined),
        artifact('logistic_batch', 'fail', 0.45),
        artifact('lightgbm_lambdamart', 'fail', 0.48),
      ],
    });

    const selection = selectActiveRanker(revision);

    expect(selection).toMatchObject({
      selectedKind: 'graph_baseline',
      reason: 'fallback_graph_baseline',
      reservedTestNdcgAt5: null,
    });
  });

  it('routes around a failing LightGBM when LR passes its own gate', () => {
    // The exact dogfood scenario this plan exists to solve: LightGBM's
    // ship-gate fails (`active-model-does-not-beat-comparison-baseline`)
    // but LR clears its own gate. Selector picks LR; serving keeps
    // working without waiting on a LightGBM retrain.
    const revision = baseRevision({
      logisticBatchWeights: Array.from({ length: RANKER_FEATURE_KEYS.length + 1 }, () => 0.1),
      logisticBatchFeatureStatsVersion: 'no-normalization-v1',
      artifactQuality: [
        artifact('graph_baseline', 'pass', 0.55),
        artifact('logistic_batch', 'pass', 0.6),
        artifact('lightgbm_lambdamart', 'fail', 0.52),
      ],
    });

    expect(selectActiveRanker(revision).selectedKind).toBe('logistic_batch');
  });

  it('does not prioritize v2 LightGBM over a higher-metric passing artifact', () => {
    const revision = baseRevision({
      logisticBatchWeights: Array.from({ length: RANKER_FEATURE_KEYS.length + 1 }, () => 0.1),
      logisticBatchFeatureStatsVersion: 'no-normalization-v1',
      artifactQuality: [
        artifact('logistic_batch', 'pass', 0.72),
        artifact('lightgbm_lambdamart', 'pass', 0.61, 'ship_gate_v2:active-cleared'),
      ],
    });

    const selection = selectActiveRanker(revision);

    expect(selection).toMatchObject({
      selectedKind: 'logistic_batch',
      reservedTestNdcgAt5: 0.72,
      shipGateReason: 'artifact-cleared-baseline-and-floor',
    });
  });

  it('refuses to pick logistic_batch when the persisted weights are absent', () => {
    // A revision where the gate passed but the writer didn't persist
    // weights (e.g. an older Step-2-only revision before Step-3
    // landed). Selector must NOT select an artifact it can't serve.
    // No `logisticBatchWeights` key at all (exactOptionalPropertyTypes
    // forbids explicit `undefined` so we just omit the key).
    const revision = baseRevision({
      artifactQuality: [
        artifact('graph_baseline', 'pass', 0.55),
        artifact('logistic_batch', 'pass', 0.7),
        artifact('lightgbm_lambdamart', 'fail', 0.52),
      ],
    });

    expect(selectActiveRanker(revision).selectedKind).toBe('graph_baseline');
  });

  it('allows v6 LightGBM trained from legacy ("sparse") to serve — softened on 2026-05-26', () => {
    // Round 1 #5 originally blocked v6-from-legacy entirely. Softened
    // per dogfood: the model still carries ~27 real features from
    // explicit feedback; only the 5 retrieval features are zero-fills.
    // Let it compete via the ship-gate; trainingOrigin remains
    // surfaced in health for auditability.
    const revision = baseRevision({
      trainedFromImpressions: false,
      artifactQuality: [artifact('lightgbm_lambdamart', 'pass', 0.8)],
    });

    expect(isServeable('lightgbm_lambdamart', revision)).toBe(true);
    expect(selectActiveRanker(revision)).toMatchObject({
      selectedKind: 'lightgbm_lambdamart',
      reason: 'best_passing',
    });
  });

  it('falls back when artifactQuality is missing (legacy revision)', () => {
    // Legacy = revision predates the artifactQuality field. Don't
    // explicitly set the key; selector must handle absent metadata
    // without crashing.
    const revision = baseRevision();
    expect(selectActiveRanker(revision)).toMatchObject({
      selectedKind: 'graph_baseline',
      reason: 'fallback_graph_baseline',
    });
  });

  it('uses kind priority as a deterministic tie-breaker when reservedTestNdcg ties', () => {
    const revision = baseRevision({
      logisticBatchWeights: Array.from({ length: RANKER_FEATURE_KEYS.length + 1 }, () => 0),
      logisticBatchFeatureStatsVersion: 'no-normalization-v1',
      artifactQuality: [
        artifact('logistic_batch', 'pass', 0.65),
        artifact('lightgbm_lambdamart', 'pass', 0.65),
      ],
    });
    // Kind order ranks lightgbm above logistic_batch, so the tie
    // breaks to LightGBM.
    expect(selectActiveRanker(revision).selectedKind).toBe('lightgbm_lambdamart');
  });

  it('picks the combiner (lightgbm_plus_online_lr) when it passes + beats other artifacts (Step 8)', () => {
    const revision = baseRevision({
      logisticBatchWeights: Array.from({ length: RANKER_FEATURE_KEYS.length + 1 }, () => 0),
      logisticBatchFeatureStatsVersion: 'no-normalization-v1',
      combinerWeights: [0.1, 0.5, 0.3, 0.2], // bias + 3 per-kind
      artifactQuality: [
        artifact('graph_baseline', 'pass', 0.55),
        artifact('logistic_batch', 'pass', 0.6),
        artifact('lightgbm_lambdamart', 'pass', 0.7),
        artifact('lightgbm_plus_online_lr', 'pass', 0.78), // best
      ],
    });
    expect(selectActiveRanker(revision).selectedKind).toBe('lightgbm_plus_online_lr');
  });

  it('refuses to pick the combiner when combinerWeights are absent', () => {
    // Defensive: a pass-gate artifact without persisted state can't
    // serve. Same shape as the LR-without-weights test, applied to
    // the combiner.
    const revision = baseRevision({
      logisticBatchWeights: Array.from({ length: RANKER_FEATURE_KEYS.length + 1 }, () => 0),
      logisticBatchFeatureStatsVersion: 'no-normalization-v1',
      // no combinerWeights
      artifactQuality: [
        artifact('lightgbm_lambdamart', 'pass', 0.7),
        artifact('lightgbm_plus_online_lr', 'pass', 0.78),
      ],
    });
    expect(selectActiveRanker(revision).selectedKind).toBe('lightgbm_lambdamart');
  });

  it('refuses to pick the combiner when LR weights are absent (combiner needs lgb + lr + weights)', () => {
    const revision = baseRevision({
      // no logisticBatchWeights → combiner can't compose its input scores
      combinerWeights: [0.1, 0.5, 0.3, 0.2],
      artifactQuality: [
        artifact('lightgbm_lambdamart', 'pass', 0.7),
        artifact('lightgbm_plus_online_lr', 'pass', 0.78),
      ],
    });
    expect(selectActiveRanker(revision).selectedKind).toBe('lightgbm_lambdamart');
  });

  it('composeCombinerVector + scoreCombiner share the COMBINER_FEATURE_KINDS ordering (Codex review of #237)', () => {
    // The combiner trains its weights against per-artifact scores
    // in `COMBINER_FEATURE_KINDS` order; the serving dispatch must
    // assemble its input vector in the SAME order or weights
    // silently mis-apply. Both paths go through
    // `composeCombinerVector(scoresByKind)`. This contract test
    // walks the layout via per-position one-hot weights so any
    // reorder of `COMBINER_FEATURE_KINDS` without updating both
    // call sites lights it up.
    const sentinelByKind: Readonly<Record<(typeof COMBINER_FEATURE_KINDS)[number], number>> = {
      lightgbm_lambdamart: 0.42,
      logistic_batch: 0.13,
      graph_baseline: 0.07,
    };
    const vector = composeCombinerVector(sentinelByKind);
    expect(vector.length).toBe(COMBINER_FEATURE_KINDS.length);
    for (let index = 0; index < COMBINER_FEATURE_KINDS.length; index += 1) {
      const kind = COMBINER_FEATURE_KINDS[index];
      if (kind === undefined) throw new Error('COMBINER_FEATURE_KINDS unexpectedly sparse');
      expect(vector[index]).toBe(sentinelByKind[kind]);
    }
    // Per-position round-trip: bias=0 + a one-hot weight isolates
    // each kind's contribution. The resulting score equals
    // sigmoid(vector[isolated]) iff the dispatch's vector layout
    // matches the trainer's. Tests every position so even an
    // adjacent swap fails.
    for (let isolated = 0; isolated < COMBINER_FEATURE_KINDS.length; isolated += 1) {
      const oneHot = new Array(COMBINER_FEATURE_KINDS.length + 1).fill(0) as number[];
      oneHot[isolated + 1] = 1;
      const score = scoreCombiner(vector, oneHot);
      const expected = 1 / (1 + Math.exp(-(vector[isolated] ?? 0)));
      expect(score).toBeCloseTo(expected, 6);
    }
  });

  it('never picks hierarchical_per_container_lr — algorithm is plan-deferred (Step 9)', () => {
    // Step 9 lands the framework (the kind in the union, the
    // manifest field, the selector awareness). The
    // bias-computation training step is plan-deferred until
    // replay-eval evidence justifies it. Until then the selector
    // refuses the kind even if a future revision claims it passes.
    const revision = baseRevision({
      logisticBatchWeights: Array.from({ length: RANKER_FEATURE_KEYS.length + 1 }, () => 0),
      logisticBatchFeatureStatsVersion: 'no-normalization-v1',
      perContainerBiases: {
        perWorkstream: { 'workstream:test-1': 0.05 },
        perTopic: {},
      },
      artifactQuality: [
        artifact('lightgbm_lambdamart', 'pass', 0.7),
        artifact('hierarchical_per_container_lr', 'pass', 0.85),
      ],
    });
    // Kind ranks first in KIND_ORDER but isServeable returns false
    // for the hierarchical kind. Selector falls through to the
    // next-best serveable artifact.
    expect(selectActiveRanker(revision).selectedKind).toBe('lightgbm_lambdamart');
  });
});
