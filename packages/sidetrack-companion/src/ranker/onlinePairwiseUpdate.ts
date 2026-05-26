// Step 6 of the incremental-ranker plan — online pairwise RankNet
// updates that mutate `OnlineRankerState.weights` in response to new
// labels from the OnlineLabelLedger (Step 5).
//
// Loss: logistic surrogate of the pairwise ranking margin.
//   δ      = features(positive) − features(negative)
//   margin = w · δ                       (bias cancels — same `from`)
//   loss   = log(1 + exp(−margin))
//   grad   = −σ(−margin) · δ + λ · w     // L2 on non-bias slots
//   w     -= η · grad
//
// This is the same target the LightGBM LambdaMART path optimizes,
// applied per-pair in the online stream rather than across a sorted
// query-group batch. Replay determinism: applying the same labels
// in any (replay-sorted) order from the same starting weights
// produces bytewise-identical end weights.
//
// Step 6 lands the pure math + state mutation. Two pieces stay for
// the follow-up integration step:
//   1. Feature lookup at apply-time. Today's `FeatureModel` is
//      reconstructed from a snapshot inside training; the online
//      path needs a similar accessor that knows what snapshot the
//      user observed when they emitted the label.
//   2. Hard-negative sampling against `from`'s candidate set. The
//      pure update accepts the positive/negative feature pair
//      directly so the sampler is pluggable.
//
// The online updates are SHADOW-ONLY in Step 6: the selector
// (`ranker/select.ts`) does not yet include `logistic_online` in
// its serveable set. A later step adds the ship-gate evaluation
// and selector inclusion.

import type { CandidatePairFeatures } from './feature-schema.js';
import { logisticFeatureVector, RANKER_FEATURE_KEYS, sigmoid } from './train.js';

const DEFAULT_LEARNING_RATE = 0.05;
const DEFAULT_L2 = 0.001;

export interface OnlineUpdateConfig {
  readonly learningRate: number;
  readonly l2: number;
}

export const DEFAULT_ONLINE_UPDATE_CONFIG: OnlineUpdateConfig = {
  learningRate: DEFAULT_LEARNING_RATE,
  l2: DEFAULT_L2,
};

// The expected weight-vector length: bias slot + one weight per
// `RANKER_FEATURE_KEYS`. Both online and batch paths share this
// invariant; mismatched length triggers `applyPairwiseUpdate` to
// no-op rather than scribble into the wrong slots.
export const ONLINE_RANKER_WEIGHTS_LENGTH = RANKER_FEATURE_KEYS.length + 1;

// Pure pairwise gradient. Returns a length-(featureCount+1) array:
// index 0 is the bias slot (always 0 because bias cancels in the
// pairwise margin), indices 1..N are per-feature gradients.
// Visible for tests + reusable by any pair-shaped consumer.
export const rankNetPairwiseGradient = (
  positiveFeatures: readonly number[],
  negativeFeatures: readonly number[],
  weights: readonly number[],
): readonly number[] => {
  if (
    positiveFeatures.length !== negativeFeatures.length ||
    weights.length !== positiveFeatures.length + 1
  ) {
    // Mismatched dimensions — emit a zero gradient so the caller
    // doesn't corrupt the weights. The condition is structural
    // (feature schema drift) and should be impossible in practice.
    return new Array(weights.length).fill(0) as number[];
  }
  // δ = positive − negative; margin = w · δ (excluding bias).
  let margin = 0;
  const deltas: number[] = [];
  for (let index = 0; index < positiveFeatures.length; index += 1) {
    const delta = (positiveFeatures[index] ?? 0) - (negativeFeatures[index] ?? 0);
    deltas.push(delta);
    margin += (weights[index + 1] ?? 0) * delta;
  }
  // grad_feature_i = −σ(−margin) · δ_i (the L2 term is added by the
  // applier so the gradient stays a pure data-driven term).
  const negSigma = sigmoid(-margin);
  const grad: number[] = [0]; // bias slot
  for (const delta of deltas) {
    grad.push(-negSigma * delta);
  }
  return grad;
};

// Apply one pairwise update to a weight vector. Pure. Returns a new
// vector; never mutates the input.
//
// `weights[0]` is the bias slot. The pairwise margin cancels bias
// (same `from`), so bias receives no learning signal here. L2 is
// applied to non-bias slots only — biasing the bias is bad practice
// because it shrinks the marginal class prior toward zero.
export const applyPairwiseUpdate = (
  weights: readonly number[],
  positiveFeatures: readonly number[],
  negativeFeatures: readonly number[],
  config: OnlineUpdateConfig = DEFAULT_ONLINE_UPDATE_CONFIG,
): readonly number[] => {
  const gradient = rankNetPairwiseGradient(positiveFeatures, negativeFeatures, weights);
  if (gradient.length !== weights.length) return weights;
  const next: number[] = new Array(weights.length).fill(0) as number[];
  for (let index = 0; index < weights.length; index += 1) {
    const w = weights[index] ?? 0;
    const dataGrad = gradient[index] ?? 0;
    const l2Term = index === 0 ? 0 : config.l2 * w;
    next[index] = w - config.learningRate * (dataGrad + l2Term);
  }
  return next;
};

// Convenience overload for callers that have `CandidatePairFeatures`
// records (the FeatureModel's output shape) rather than raw feature
// arrays. Mirrors `scoreLogisticBatch` in `train.ts` so online +
// batch paths share vectorization.
export const applyPairwiseUpdateFromFeatures = (
  weights: readonly number[],
  positive: CandidatePairFeatures,
  negative: CandidatePairFeatures,
  config: OnlineUpdateConfig = DEFAULT_ONLINE_UPDATE_CONFIG,
): readonly number[] =>
  applyPairwiseUpdate(
    weights,
    logisticFeatureVector(positive),
    logisticFeatureVector(negative),
    config,
  );
