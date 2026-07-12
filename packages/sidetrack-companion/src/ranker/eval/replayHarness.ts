// Wave 0 — freeze-safe eval spine (report-only).
//
// Served-feature replay harness. Reads the logged recall.served impressions
// that carry the POINT-IN-TIME feature vectors from PR #242
// (RecallServedCandidateSnapshot.features aligned to
// CANDIDATE_PAIR_FEATURE_KEYS + featureSchemaVersion + queryCosine, plus
// servedPosition and the joined recall.action labels), re-scores each
// impression group under several arms, and computes ranking metrics per arm
// so they can be printed side by side.
//
// This is what lets the P1 freeze lift on EVIDENCE: if the trained model
// cannot out-rank the deterministic graph baseline AND the honest external
// floors (grep-over-vault BM25, recency-only full-context), it has not
// earned its complexity.
//
// CRITICAL — this module REUSES buildRecallImpressionTrainingGroups from
// retrain-impressions.ts for the served × action join. It does NOT
// re-implement the impression reader: the join (latest-action-per-entity,
// point-in-time-feature-preference-over-reconstruction, weak-negative
// grading) is exactly the trainer's, so replay evaluates the same rows the
// trainer learns from. Nothing here influences serving.

import type { ConnectionsSnapshot } from '../../connections/types.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import { deterministicBaselineScore, type RankerRevision } from '../train.js';
import { loadRankerModel, predictRanker } from '../predict.js';
import {
  buildRecallImpressionTrainingGroups,
  type RecallImpressionScoringGroup,
  type RecallImpressionScoringRow,
} from '../retrain-impressions.js';
import {
  computeImpressionMetrics,
  type ImpressionGroupForMetrics,
  type ImpressionMetrics,
} from '../shipGateV2.js';
import {
  bm25Scores,
  readCandidateDocuments,
  recencyScores,
  tokenize,
  type CandidateRef,
} from './lexicalBaseline.js';
import { RECALL_SERVED, isRecallServedPayload } from '../../recall/events.js';

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Canonical arm identifiers reported side by side. */
export type ReplayArmId =
  | 'served_order'
  | 'trained_model'
  | 'graph_baseline'
  | 'grep_bm25'
  | 'recency';

export interface ReplayArm {
  readonly id: ReplayArmId;
  readonly label: string;
  readonly metrics: ImpressionMetrics;
  /** True when the arm could actually run (e.g. trained_model is skipped
   *  when no model is present). A skipped arm reports zeroed metrics. */
  readonly available: boolean;
  /** Per-impression nDCG@10, keyed by groupId, for the paired-bootstrap
   *  significance test. Only impressions with ≥1 positive are present. */
  readonly perGroupNdcgAt10: ReadonlyMap<string, number>;
}

export interface ReplayReport {
  readonly impressionCount: number;
  readonly impressionsWithPositiveCount: number;
  readonly arms: readonly ReplayArm[];
  /** Query text keyed by groupId, echoed for the report table. */
  readonly queryByGroupId: ReadonlyMap<string, string>;
}

const labelMapForRows = (
  rows: readonly RecallImpressionScoringRow[],
): ReadonlyMap<string, 'positive' | 'negative'> => {
  const labels = new Map<string, 'positive' | 'negative'>();
  for (const row of rows) {
    if (row.label !== undefined) labels.set(row.candidate.toVisitId, row.label);
  }
  return labels;
};

/** Rank one scoring group by a per-row score (descending), tie-broken on
 *  entity id so the ranking is deterministic. Mirrors the trainer's
 *  rankedMetricGroup so replay + ship-gate agree on ordering semantics. */
const rankedGroupBy = (
  group: RecallImpressionScoringGroup,
  scoreFor: (row: RecallImpressionScoringRow) => number,
): ImpressionGroupForMetrics => ({
  groupId: group.groupId,
  rankedEntityIds: [...group.rows]
    .sort((left, right) => {
      const delta = scoreFor(right) - scoreFor(left);
      return delta !== 0 ? delta : compareText(left.candidate.toVisitId, right.candidate.toVisitId);
    })
    .map((row) => row.candidate.toVisitId),
  labels: labelMapForRows(group.rows),
});

/** nDCG@10 per group (positive-bearing only) — the paired-bootstrap unit. */
const perGroupNdcgAt10 = (
  metricGroups: readonly ImpressionGroupForMetrics[],
): ReadonlyMap<string, number> => {
  const out = new Map<string, number>();
  for (const group of metricGroups) {
    const single = computeImpressionMetrics([group]);
    if (single.impressionsWithPositiveCount > 0) out.set(group.groupId, single.nDcgAt10);
  }
  return out;
};

const armFromMetricGroups = (
  id: ReplayArmId,
  label: string,
  available: boolean,
  metricGroups: readonly ImpressionGroupForMetrics[],
): ReplayArm => ({
  id,
  label,
  available,
  metrics: computeImpressionMetrics(metricGroups),
  perGroupNdcgAt10: perGroupNdcgAt10(metricGroups),
});

/**
 * The served-order arm ranks by the order the candidates were SHOWN
 * (servedPosition asc → score desc). This is the "what production already
 * did" arm; every other arm is measured against it and the floors.
 */
const servedOrderScoreFor = (row: RecallImpressionScoringRow): number =>
  // served_position is stored 1-based in the feature vector; lower = shown
  // earlier = better, so negate. Missing → 0 (all tie, entity-id order).
  -(row.features.served_position ?? 0);

export interface ReplayHarnessInput {
  readonly vaultRoot: string;
  readonly merged: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
  /** The active trained ranker revision, or null when none is on disk. */
  readonly trainedRevision: RankerRevision | null;
}

/**
 * Build the replay report: join impressions, re-score under every arm, and
 * compute metrics side by side. REPORT-ONLY.
 */
export const runReplayHarness = async (input: ReplayHarnessInput): Promise<ReplayReport> => {
  const build = await buildRecallImpressionTrainingGroups({
    merged: input.merged,
    snapshot: input.snapshot,
  });
  const groups = build.scoringGroups;

  // Query text per group for the printed table (served payload → query).
  const queryByGroupId = new Map<string, string>();
  for (const event of input.merged) {
    if (event.type !== RECALL_SERVED || !isRecallServedPayload(event.payload)) continue;
    queryByGroupId.set(event.payload.servedContextId, event.payload.query);
  }

  // Arm: served order (production ordering).
  const servedGroups = groups.map((group) => rankedGroupBy(group, servedOrderScoreFor));

  // Arm: deterministic graph/heuristic baseline.
  const baselineGroups = groups.map((group) =>
    rankedGroupBy(group, (row) => deterministicBaselineScore(row.features)),
  );

  // Arm: trained model (if present). Score with the SAME predictRanker the
  // serve path uses; dispose the booster afterward.
  let trainedGroups: readonly ImpressionGroupForMetrics[] = [];
  const trainedAvailable = input.trainedRevision !== null;
  if (input.trainedRevision !== null) {
    const model = await loadRankerModel(input.trainedRevision);
    try {
      trainedGroups = groups.map((group) =>
        rankedGroupBy(group, (row) => predictRanker(row.features, model).score),
      );
    } finally {
      model.dispose();
    }
  }

  // Arms: external floors. Read the vault documents ONCE for every distinct
  // candidate across all impressions, then score per impression.
  const candidateRefs: CandidateRef[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group.rows) {
      if (seen.has(row.candidate.toVisitId)) continue;
      seen.add(row.candidate.toVisitId);
      candidateRefs.push({
        entityId: row.candidate.toVisitId,
        // toVisitId is canonicalUrl ?? entityId (see the trainer), so it is
        // the best canonical-URL key we have for the vault lookup.
        canonicalUrl: row.candidate.toVisitId,
      });
    }
  }
  const documents = await readCandidateDocuments(input.vaultRoot, candidateRefs);

  const bm25Groups = groups.map((group) => {
    const query = queryByGroupId.get(group.groupId) ?? '';
    const queryTokens = tokenize(query);
    const entityIds = group.rows.map((row) => row.candidate.toVisitId);
    const scores = bm25Scores(queryTokens, entityIds, documents);
    return rankedGroupBy(group, (row) => scores.get(row.candidate.toVisitId) ?? 0);
  });

  const recencyGroups = groups.map((group) => {
    const entityIds = group.rows.map((row) => row.candidate.toVisitId);
    const scores = recencyScores(entityIds, documents);
    return rankedGroupBy(
      group,
      (row) => scores.get(row.candidate.toVisitId) ?? Number.NEGATIVE_INFINITY,
    );
  });

  const arms: ReplayArm[] = [
    armFromMetricGroups('served_order', 'Served order (production)', true, servedGroups),
    armFromMetricGroups('trained_model', 'Trained model', trainedAvailable, trainedGroups),
    armFromMetricGroups('graph_baseline', 'Graph/heuristic baseline', true, baselineGroups),
    armFromMetricGroups('grep_bm25', 'Grep-over-vault (BM25)', true, bm25Groups),
    armFromMetricGroups('recency', 'Recency (newest-first)', true, recencyGroups),
  ];

  const baseMetrics = computeImpressionMetrics(baselineGroups);
  return {
    impressionCount: baseMetrics.impressionCount,
    impressionsWithPositiveCount: baseMetrics.impressionsWithPositiveCount,
    arms,
    queryByGroupId,
  };
};

/** Format the side-by-side arm table for CLI output. */
export const formatReplayReport = (report: ReplayReport): string => {
  const header =
    `impressions=${String(report.impressionCount)} ` +
    `withPositive=${String(report.impressionsWithPositiveCount)}`;
  const rows = report.arms.map((arm) => {
    const m = arm.metrics;
    const tag = arm.available ? ' ' : '·';
    return (
      `${tag} ${arm.label.padEnd(28)} ` +
      `nDCG@10=${m.nDcgAt10.toFixed(4)} ` +
      `MRR=${m.mrr.toFixed(4)} ` +
      `R@5=${m.recallAt5.toFixed(4)} ` +
      `R@10=${m.recallAt10.toFixed(4)} ` +
      `rejectFPR=${m.falsePositiveRateOnRejectedContexts.toFixed(4)}`
    );
  });
  return [header, ...rows].join('\n');
};
