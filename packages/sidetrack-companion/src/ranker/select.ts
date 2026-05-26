// Step 4 of the incremental-ranker plan. The selector reads the
// per-artifact ship-gates (Step 2) + persisted LR weights (Step 3) off
// a `RankerRevision` and decides which artifact to serve. Today the
// candidates are `lightgbm_lambdamart`, `logistic_batch`, and
// `graph_baseline`; Steps 6 + 8 will add `logistic_online` and
// `lightgbm_plus_online_lr` to the registry.
//
// Selection rule:
// 1. Among artifacts that pass their own ship-gate AND have an
//    artifact we can serve with (LightGBM bytes for the LightGBM kind,
//    persisted LR weights for `logistic_batch`, no state for the
//    graph baseline), pick the one with the highest
//    `reservedTestMetric.value`. Tie-break by the `RankerArtifactKind`
//    declaration order to keep selection deterministic.
// 2. If nothing passes (or the manifest has no artifactQuality at
//    all), fall back to `graph_baseline`. The graph baseline is the
//    deterministic-feature scorer that has no model state to persist;
//    it's always serveable.
//
// Reasons returned to the panel:
//   - 'best_passing'             — a learned artifact cleared its gate
//   - 'fallback_graph_baseline'  — no learned artifact passed
//
// The selector does NOT itself score; it just picks the kind. The
// dispatch wrapper (predict.ts:loadActiveRanker / predictActive)
// loads the right model state and routes scoring through the kind.

import type { RankerArtifactKind, RankerArtifactQuality, RankerRevision } from './train.js';

export interface ActiveRankerSelection {
  readonly selectedKind: RankerArtifactKind;
  readonly selectedRevisionId: string;
  readonly reservedTestNdcgAt5: number | null;
  readonly reason: 'best_passing' | 'fallback_graph_baseline';
}

// Kind priority for tie-breaking. Earlier wins. `graph_baseline` is
// last so it's only picked when nothing else clears.
const KIND_ORDER: readonly RankerArtifactKind[] = [
  'lightgbm_plus_online_lr',
  'lightgbm_lambdamart',
  'logistic_online',
  'logistic_batch',
  'graph_baseline',
];

const kindRank = (kind: RankerArtifactKind): number => {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
};

// Whether the revision actually carries the state we'd need to score
// with this artifact. A ship-gate `pass` is necessary but not
// sufficient — if the LR weights weren't persisted (older revision)
// the selector can't pick `logistic_batch` even if its gate passed.
const isServeable = (kind: RankerArtifactKind, revision: RankerRevision): boolean => {
  if (kind === 'graph_baseline') return true;
  if (kind === 'lightgbm_lambdamart') return revision.modelBytes.byteLength > 0;
  if (kind === 'logistic_batch') {
    return (
      revision.logisticBatchWeights !== undefined &&
      revision.logisticBatchFeatureStatsVersion !== undefined
    );
  }
  if (kind === 'lightgbm_plus_online_lr') {
    // Combiner (Step 8) needs ALL its inputs serveable: scoring
    // applies the combiner weights to per-artifact scores it
    // computes from the same training-time inputs.
    return (
      revision.modelBytes.byteLength > 0 &&
      revision.logisticBatchWeights !== undefined &&
      revision.logisticBatchFeatureStatsVersion !== undefined &&
      revision.combinerWeights !== undefined
    );
  }
  // `logistic_online`: not yet served by the selector. Step 6 lands
  // the math; materializer-drain integration + ship-gate evaluation
  // are the follow-up.
  return false;
};

const passingArtifacts = (
  revision: RankerRevision,
): readonly RankerArtifactQuality[] => {
  const quality = revision.artifactQuality ?? [];
  return quality.filter(
    (artifact) =>
      artifact.shipGate.status === 'pass' && isServeable(artifact.kind, revision),
  );
};

const compareArtifacts = (
  left: RankerArtifactQuality,
  right: RankerArtifactQuality,
): number => {
  const leftNdcg = left.reservedTestMetric?.value ?? -Infinity;
  const rightNdcg = right.reservedTestMetric?.value ?? -Infinity;
  if (leftNdcg !== rightNdcg) return rightNdcg - leftNdcg; // desc
  return kindRank(left.kind) - kindRank(right.kind);
};

export const selectActiveRanker = (revision: RankerRevision): ActiveRankerSelection => {
  const passing = [...passingArtifacts(revision)].sort(compareArtifacts);
  const winner = passing[0];
  if (winner === undefined) {
    // Nothing passed. The deterministic baseline is always serveable
    // and never claims a learned-quality NDCG it doesn't have.
    return {
      selectedKind: 'graph_baseline',
      selectedRevisionId: revision.revisionId,
      reservedTestNdcgAt5: null,
      reason: 'fallback_graph_baseline',
    };
  }
  return {
    selectedKind: winner.kind,
    selectedRevisionId: revision.revisionId,
    reservedTestNdcgAt5: winner.reservedTestMetric?.value ?? null,
    reason: 'best_passing',
  };
};
