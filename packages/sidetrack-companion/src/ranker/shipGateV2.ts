// Phase 6 of the recall+ranker v2 hard-replacement.
//
// The Phase 6 ship-gate decides whether a freshly-trained v6 model
// (group-level LambdaMART trained on impression events) is allowed
// to replace the served model. The decision compares the active
// candidate against the production /v2 retrieval baseline at the
// raw-event / served-context level — never on Cartesian-expanded
// rows. Per Deliverable 8 of the alignment doc.
//
// Production baseline (per design doc) = current /v2/recall stack
// WITHOUT the learned LightGBM ranker: FTS5 + sqlite-vec + graph +
// RRF + dedupe + suppression + cross-encoder rerank + the existing
// `graph_baseline` deterministic-feature scorer. Whoever calls the
// gate computes the baseline metrics by scoring the same impression
// set through the deterministic baseline path.
//
// Gate logic:
//   PASS iff
//     - expandedNegativeCount == 0 (no Cartesian artifacts)
//     - labelDriftWithoutFeedback == 0 (no silent re-labeling)
//     - explicit_reject_precision NOT regressed vs baseline
//     - nDCG@10 OR MRR improves vs baseline
//     - at least one impression with a positive (sufficient signal)
//   UNAVAILABLE iff
//     - too few impressions with positives (cold start)
//   FAIL otherwise — with `reason` set so health can render the cause.
//
// This module is intentionally self-contained: it takes
// already-computed metrics + counts as input, so it can be unit-tested
// without standing up the impression-log + trainer end-to-end. The
// wiring (build groups from the impression log, score with active
// and baseline models, call shipGateV2Decide) happens in the trainer.

export interface ImpressionMetrics {
  readonly nDcgAt5: number;
  readonly nDcgAt10: number;
  readonly mrr: number;
  readonly recallAt5: number;
  readonly recallAt10: number;
  /** Of all explicit rejects across impressions, the share ranked
   *  below every positive within their own impression. Higher = better
   *  separation of rejected candidates. */
  readonly explicitRejectPrecision: number;
  /** Of impressions that contain at least one explicit reject, the
   *  share where ANY reject was ranked at position 1. Lower = better. */
  readonly falsePositiveRateOnRejectedContexts: number;
  readonly impressionCount: number;
  readonly impressionsWithPositiveCount: number;
}

export interface ShipGateV2Input {
  readonly activeMetrics: ImpressionMetrics;
  readonly baselineMetrics: ImpressionMetrics;
  /** Asserted 0 by Phase 1; any non-zero means an expansion path
   *  re-emerged and the gate fails defensively. */
  readonly expandedNegativeCount: number;
  /** Asserted 0 by Phase 1; any non-zero means a snapshot-driven
   *  re-labeling has leaked back in. */
  readonly labelDriftWithoutFeedback: number;
  /** Whether the reserved-test split was touched only at this single
   *  gate evaluation. Surfaced through to the report; gate is hard
   *  about not re-using the reserved set. */
  readonly reservedTestUsedExactlyOnce: boolean;
  /** Cold-start threshold — gate returns `unavailable` below this. */
  readonly minImpressionsWithPositive?: number;
}

export type ShipGateV2Status = 'pass' | 'fail' | 'unavailable';

export type ShipGateV2Reason =
  | 'pass_ndcg_improved'
  | 'pass_mrr_improved'
  | 'pass_both_improved'
  | 'fail_expanded_negatives_present'
  | 'fail_label_drift_without_feedback'
  | 'fail_regressed_explicit_reject_precision'
  | 'fail_no_primary_metric_improvement'
  | 'unavailable_insufficient_groups'
  | 'unavailable_reserved_test_reused';

export interface ShipGateV2Decision {
  readonly status: ShipGateV2Status;
  readonly reason: ShipGateV2Reason;
  readonly active: ImpressionMetrics;
  readonly baseline: ImpressionMetrics;
  readonly deltas: {
    readonly nDcgAt10: number;
    readonly mrr: number;
    readonly explicitRejectPrecision: number;
  };
  readonly reservedTestUsedExactlyOnce: boolean;
}

const DEFAULT_MIN_IMPRESSIONS_WITH_POSITIVE = 50;

export const shipGateV2Decide = (input: ShipGateV2Input): ShipGateV2Decision => {
  const deltas = {
    nDcgAt10: input.activeMetrics.nDcgAt10 - input.baselineMetrics.nDcgAt10,
    mrr: input.activeMetrics.mrr - input.baselineMetrics.mrr,
    explicitRejectPrecision:
      input.activeMetrics.explicitRejectPrecision -
      input.baselineMetrics.explicitRejectPrecision,
  };
  const base = {
    active: input.activeMetrics,
    baseline: input.baselineMetrics,
    deltas,
    reservedTestUsedExactlyOnce: input.reservedTestUsedExactlyOnce,
  } as const;
  if (input.expandedNegativeCount > 0) {
    return { status: 'fail', reason: 'fail_expanded_negatives_present', ...base };
  }
  if (input.labelDriftWithoutFeedback > 0) {
    return { status: 'fail', reason: 'fail_label_drift_without_feedback', ...base };
  }
  if (!input.reservedTestUsedExactlyOnce) {
    return { status: 'unavailable', reason: 'unavailable_reserved_test_reused', ...base };
  }
  const minImpressions =
    input.minImpressionsWithPositive ?? DEFAULT_MIN_IMPRESSIONS_WITH_POSITIVE;
  if (input.activeMetrics.impressionsWithPositiveCount < minImpressions) {
    return { status: 'unavailable', reason: 'unavailable_insufficient_groups', ...base };
  }
  if (deltas.explicitRejectPrecision < 0) {
    return {
      status: 'fail',
      reason: 'fail_regressed_explicit_reject_precision',
      ...base,
    };
  }
  const ndcgImproves = deltas.nDcgAt10 > 0;
  const mrrImproves = deltas.mrr > 0;
  if (!ndcgImproves && !mrrImproves) {
    return { status: 'fail', reason: 'fail_no_primary_metric_improvement', ...base };
  }
  const reason: ShipGateV2Reason =
    ndcgImproves && mrrImproves
      ? 'pass_both_improved'
      : ndcgImproves
        ? 'pass_ndcg_improved'
        : 'pass_mrr_improved';
  return { status: 'pass', reason, ...base };
};

// ============================================================
// Impression-level metric computation.
// ============================================================
// The trainer builds groups (one per served impression). For each
// group, the model produces a ranked entityId list; we compare it to
// the labels derived from recall.action events. Labels are explicit
// only (positive | negative | unlabeled). Unlabeled = excluded from
// relevance scoring per Deliverable 3.

export interface ImpressionGroupForMetrics {
  readonly groupId: string;
  /** Model-produced ranking, position 0 = first. Length should equal
   *  the served impression's candidate count. */
  readonly rankedEntityIds: readonly string[];
  /** Per-entity label. Missing entries = unlabeled (excluded). */
  readonly labels: ReadonlyMap<string, 'positive' | 'negative'>;
}

const log2 = (value: number): number => Math.log(value) / Math.log(2);

const dcgAtK = (ranked: readonly string[], labels: ReadonlyMap<string, 'positive' | 'negative'>, k: number): number => {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    const id = ranked[i];
    if (id === undefined) continue;
    const rel = labels.get(id) === 'positive' ? 1 : 0;
    if (rel > 0) dcg += rel / log2(i + 2);
  }
  return dcg;
};

const idealDcgAtK = (
  labels: ReadonlyMap<string, 'positive' | 'negative'>,
  k: number,
): number => {
  let positives = 0;
  for (const v of labels.values()) if (v === 'positive') positives += 1;
  const capped = Math.min(positives, k);
  let idcg = 0;
  for (let i = 0; i < capped; i += 1) idcg += 1 / log2(i + 2);
  return idcg;
};

const groupNdcg = (group: ImpressionGroupForMetrics, k: number): number => {
  const idcg = idealDcgAtK(group.labels, k);
  if (idcg === 0) return 0;
  return dcgAtK(group.rankedEntityIds, group.labels, k) / idcg;
};

const groupReciprocalRank = (group: ImpressionGroupForMetrics): number => {
  for (let i = 0; i < group.rankedEntityIds.length; i += 1) {
    const id = group.rankedEntityIds[i];
    if (id !== undefined && group.labels.get(id) === 'positive') {
      return 1 / (i + 1);
    }
  }
  return 0;
};

const groupRecallAtK = (group: ImpressionGroupForMetrics, k: number): number => {
  let positives = 0;
  for (const v of group.labels.values()) if (v === 'positive') positives += 1;
  if (positives === 0) return 0;
  let hits = 0;
  for (let i = 0; i < Math.min(k, group.rankedEntityIds.length); i += 1) {
    const id = group.rankedEntityIds[i];
    if (id !== undefined && group.labels.get(id) === 'positive') hits += 1;
  }
  return hits / positives;
};

export const computeImpressionMetrics = (
  groups: readonly ImpressionGroupForMetrics[],
): ImpressionMetrics => {
  if (groups.length === 0) {
    return {
      nDcgAt5: 0,
      nDcgAt10: 0,
      mrr: 0,
      recallAt5: 0,
      recallAt10: 0,
      explicitRejectPrecision: 0,
      falsePositiveRateOnRejectedContexts: 0,
      impressionCount: 0,
      impressionsWithPositiveCount: 0,
    };
  }
  let ndcg5 = 0;
  let ndcg10 = 0;
  let rr = 0;
  let recall5 = 0;
  let recall10 = 0;
  let withPositive = 0;
  // Reject metrics — only count impressions that have at least one
  // explicit reject. Aggregated across impressions.
  let rejectImpressionCount = 0;
  let rejectInTop1Count = 0;
  let totalRejects = 0;
  let rejectsRankedBelowAllPositives = 0;
  for (const group of groups) {
    let positives = 0;
    let rejects = 0;
    let positiveMaxRank = -1;
    let rejectMinRank = Number.POSITIVE_INFINITY;
    for (const [id, label] of group.labels) {
      if (label === 'positive') {
        positives += 1;
        const rank = group.rankedEntityIds.indexOf(id);
        if (rank >= 0) positiveMaxRank = Math.max(positiveMaxRank, rank);
      } else if (label === 'negative') {
        rejects += 1;
        const rank = group.rankedEntityIds.indexOf(id);
        if (rank >= 0) rejectMinRank = Math.min(rejectMinRank, rank);
      }
    }
    if (positives > 0) {
      withPositive += 1;
      ndcg5 += groupNdcg(group, 5);
      ndcg10 += groupNdcg(group, 10);
      rr += groupReciprocalRank(group);
      recall5 += groupRecallAtK(group, 5);
      recall10 += groupRecallAtK(group, 10);
    }
    if (rejects > 0) {
      rejectImpressionCount += 1;
      totalRejects += rejects;
      // Top-1 false positive count
      const top1 = group.rankedEntityIds[0];
      if (top1 !== undefined && group.labels.get(top1) === 'negative') {
        rejectInTop1Count += 1;
      }
      // Each reject ranked below every positive in its impression?
      // Only meaningful when there's at least one positive in the
      // group AND the rejects appear in the ranked list.
      if (positives > 0 && positiveMaxRank >= 0) {
        for (const [id, label] of group.labels) {
          if (label !== 'negative') continue;
          const r = group.rankedEntityIds.indexOf(id);
          if (r > positiveMaxRank) rejectsRankedBelowAllPositives += 1;
        }
      }
    }
  }
  const denom = withPositive === 0 ? 1 : withPositive;
  return {
    nDcgAt5: ndcg5 / denom,
    nDcgAt10: ndcg10 / denom,
    mrr: rr / denom,
    recallAt5: recall5 / denom,
    recallAt10: recall10 / denom,
    explicitRejectPrecision:
      totalRejects === 0 ? 0 : rejectsRankedBelowAllPositives / totalRejects,
    falsePositiveRateOnRejectedContexts:
      rejectImpressionCount === 0 ? 0 : rejectInTop1Count / rejectImpressionCount,
    impressionCount: groups.length,
    impressionsWithPositiveCount: withPositive,
  };
};
