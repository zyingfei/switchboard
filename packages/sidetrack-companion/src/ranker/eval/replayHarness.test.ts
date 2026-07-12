import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../../connections/types.js';
import {
  RECALL_ACTION,
  RECALL_SERVED,
  type RecallActionKind,
  type RecallActionPayload,
  type RecallServedCandidateSnapshot,
  type RecallServedPayload,
} from '../../recall/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import { CANDIDATE_PAIR_FEATURE_KEYS, FEATURE_SCHEMA_VERSION } from '../feature-schema.js';
import { runReplayHarness } from './replayHarness.js';
import { buildReplayEvalVerdict } from './verdictArtifact.js';

const BASE_TIME = Date.parse('2026-06-01T12:00:00.000Z');

const EMPTY_SNAPSHOT: ConnectionsSnapshot = {
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: new Date(BASE_TIME).toISOString(),
  nodeCount: 0,
  edgeCount: 0,
};

/** Build a point-in-time feature vector aligned to CANDIDATE_PAIR_FEATURE_KEYS
 *  with a chosen served_position + cosine_similarity so both the served-order
 *  arm and the graph-baseline arm produce deterministic, hand-checkable
 *  orderings. All other features are 0. */
const featureVector = (input: {
  readonly servedPositionOneBased: number;
  readonly cosine: number;
}): number[] => {
  const map: Record<string, number> = {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    served_position: input.servedPositionOneBased,
    cosine_similarity: input.cosine,
  };
  return CANDIDATE_PAIR_FEATURE_KEYS.map((key) => map[key] ?? 0);
};

const servedCandidate = (input: {
  readonly entityId: string;
  readonly servedPosition: number; // 0-based
  readonly cosine: number;
}): RecallServedCandidateSnapshot => ({
  entityId: input.entityId,
  sourceKind: 'timeline_visit',
  canonicalUrl: `https://vault.test/${input.entityId}`,
  fusedScore: 1 / (input.servedPosition + 1),
  servedPosition: input.servedPosition,
  features: featureVector({
    servedPositionOneBased: input.servedPosition + 1,
    cosine: input.cosine,
  }),
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
});

let seq = 0;
const nextSeq = (): number => {
  seq += 1;
  return seq;
};

const servedEvent = (
  servedContextId: string,
  candidates: readonly RecallServedCandidateSnapshot[],
): AcceptedEvent => {
  const s = nextSeq();
  const payload: RecallServedPayload = {
    payloadVersion: 1,
    servedContextId,
    query: 'postgres merge concurrency',
    intent: 'search',
    sessionContext: { currentUrl: `https://vault.test/anchor/${servedContextId}` },
    results: candidates,
    rerankApplied: false,
    sequenceNumber: s,
    servedAt: new Date(BASE_TIME + s * 1000).toISOString(),
  };
  return {
    clientEventId: `served-${servedContextId}-${String(s)}`,
    dot: { replicaId: 'r', seq: s },
    deps: {},
    aggregateId: servedContextId,
    type: RECALL_SERVED,
    payload,
    acceptedAtMs: BASE_TIME + s * 1000,
  };
};

const actionEvent = (
  servedContextId: string,
  entityId: string,
  actionKind: RecallActionKind,
): AcceptedEvent => {
  const s = nextSeq();
  const payload: RecallActionPayload = {
    payloadVersion: 1,
    servedContextId,
    entityId,
    actionKind,
    actionAt: new Date(BASE_TIME + s * 1000).toISOString(),
  };
  return {
    clientEventId: `action-${servedContextId}-${entityId}-${String(s)}`,
    dot: { replicaId: 'r', seq: s },
    deps: {},
    aggregateId: servedContextId,
    type: RECALL_ACTION,
    payload,
    acceptedAtMs: BASE_TIME + s * 1000,
  };
};

const log2 = (value: number): number => Math.log(value) / Math.log(2);

let vaultRoot: string;
afterEach(async () => {
  if (vaultRoot !== undefined) await rm(vaultRoot, { recursive: true, force: true });
});

describe('runReplayHarness', () => {
  it('computes graph-baseline nDCG@10 from the point-in-time cosine, hand-checkable', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'replay-eval-'));
    seq = 0;
    // One impression, 3 candidates. The graph baseline scores mostly on
    // cosine_similarity (weight 2.8). Set cosines so the POSITIVE candidate
    // is NOT first by cosine — the baseline ranks it 2nd (0-based index 1).
    //   c_hi  cosine 0.9 (served pos 0) — UNLABELED (unjudged)
    //   c_pos cosine 0.5 (served pos 1) — POSITIVE (flow_confirm)
    //   c_lo  cosine 0.1 (served pos 2) — NEGATIVE (reject)
    // Graph-baseline order by score desc: [c_hi, c_pos, c_lo].
    //   positive at index 1 → nDCG@10 = (1/log2(1+2)) / (1/log2(0+2))
    //                                  = (1/log2(3)) / 1 = 1/log2(3).
    const candidates = [
      servedCandidate({ entityId: 'c_hi', servedPosition: 0, cosine: 0.9 }),
      servedCandidate({ entityId: 'c_pos', servedPosition: 1, cosine: 0.5 }),
      servedCandidate({ entityId: 'c_lo', servedPosition: 2, cosine: 0.1 }),
    ];
    const merged: AcceptedEvent[] = [
      servedEvent('imp1', candidates),
      actionEvent('imp1', 'c_pos', 'flow_confirm'),
      actionEvent('imp1', 'c_lo', 'reject'),
    ];

    const report = await runReplayHarness({
      vaultRoot,
      merged,
      snapshot: EMPTY_SNAPSHOT,
      trainedRevision: null,
    });

    expect(report.impressionCount).toBe(1);
    expect(report.impressionsWithPositiveCount).toBe(1);

    const baseline = report.arms.find((arm) => arm.id === 'graph_baseline')!;
    expect(baseline.metrics.nDcgAt10).toBeCloseTo(1 / log2(3), 12);
    // Positive is at rank 2 (1-based) → MRR = 1/2.
    expect(baseline.metrics.mrr).toBeCloseTo(0.5, 12);
    // c_lo (reject) is at rank 3 (index 2), NOT rank 1 → reject-FPR = 0.
    expect(baseline.metrics.falsePositiveRateOnRejectedContexts).toBe(0);

    // Served-order arm ranks by served position: [c_hi(0), c_pos(1), c_lo(2)].
    // Same positive index (1) → same nDCG@10 as the baseline here.
    const served = report.arms.find((arm) => arm.id === 'served_order')!;
    expect(served.metrics.nDcgAt10).toBeCloseTo(1 / log2(3), 12);

    // No trained model on disk → that arm is unavailable + zeroed.
    const trained = report.arms.find((arm) => arm.id === 'trained_model')!;
    expect(trained.available).toBe(false);
    expect(trained.metrics.nDcgAt10).toBe(0);

    // recency arm ran (available) even without vault docs — every candidate
    // is undated → all tie at -Infinity → entity-id order deterministic.
    const recency = report.arms.find((arm) => arm.id === 'recency')!;
    expect(recency.available).toBe(true);
  });

  it('scores reject-FPR=1 when the graph baseline ranks a rejected candidate first', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'replay-eval-'));
    seq = 0;
    // Rejected candidate has the HIGHEST cosine → baseline puts it at rank 1.
    //   c_rej cosine 0.99 (pos 0) — NEGATIVE (reject)
    //   c_pos cosine 0.20 (pos 1) — POSITIVE (move)
    const candidates = [
      servedCandidate({ entityId: 'c_rej', servedPosition: 0, cosine: 0.99 }),
      servedCandidate({ entityId: 'c_pos', servedPosition: 1, cosine: 0.2 }),
    ];
    const merged: AcceptedEvent[] = [
      servedEvent('imp1', candidates),
      actionEvent('imp1', 'c_rej', 'reject'),
      actionEvent('imp1', 'c_pos', 'move'),
    ];
    const report = await runReplayHarness({
      vaultRoot,
      merged,
      snapshot: EMPTY_SNAPSHOT,
      trainedRevision: null,
    });
    const baseline = report.arms.find((arm) => arm.id === 'graph_baseline')!;
    // reject ranked at index 0 → top-1 is a reject → FPR = 1.
    expect(baseline.metrics.falsePositiveRateOnRejectedContexts).toBe(1);
    // positive at index 1 → nDCG@10 = 1/log2(3), MRR = 1/2.
    expect(baseline.metrics.nDcgAt10).toBeCloseTo(1 / log2(3), 12);
    expect(baseline.metrics.mrr).toBeCloseTo(0.5, 12);
  });

  it('averages per-impression nDCG over impressions with a positive and feeds the verdict', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'replay-eval-'));
    seq = 0;
    // Two impressions:
    //   imp1: positive c_pos at baseline rank 1 (index 0) → nDCG@10 = 1.
    //   imp2: positive c_pos at baseline rank 2 (index 1) → nDCG@10 = 1/log2(3).
    // Mean nDCG@10 = (1 + 1/log2(3)) / 2.
    const imp1 = [
      servedCandidate({ entityId: 'a_pos', servedPosition: 0, cosine: 0.9 }),
      servedCandidate({ entityId: 'a_lo', servedPosition: 1, cosine: 0.1 }),
    ];
    const imp2 = [
      servedCandidate({ entityId: 'b_hi', servedPosition: 0, cosine: 0.9 }),
      servedCandidate({ entityId: 'b_pos', servedPosition: 1, cosine: 0.5 }),
    ];
    const merged: AcceptedEvent[] = [
      servedEvent('imp1', imp1),
      actionEvent('imp1', 'a_pos', 'flow_confirm'),
      servedEvent('imp2', imp2),
      actionEvent('imp2', 'b_pos', 'flow_confirm'),
    ];
    const report = await runReplayHarness({
      vaultRoot,
      merged,
      snapshot: EMPTY_SNAPSHOT,
      trainedRevision: null,
    });
    expect(report.impressionsWithPositiveCount).toBe(2);
    const baseline = report.arms.find((arm) => arm.id === 'graph_baseline')!;
    expect(baseline.metrics.nDcgAt10).toBeCloseTo((1 + 1 / log2(3)) / 2, 12);
    // Per-group nDCG map carries both impressions for the bootstrap.
    expect(baseline.perGroupNdcgAt10.get('imp1')).toBeCloseTo(1, 12);
    expect(baseline.perGroupNdcgAt10.get('imp2')).toBeCloseTo(1 / log2(3), 12);

    // No trained model → the verdict has no comparisons but still records
    // the floor arm metrics and is report-only.
    const verdict = buildReplayEvalVerdict(report, { generatedAt: BASE_TIME });
    expect(verdict.reportOnly).toBe(true);
    expect(verdict.comparisons).toHaveLength(0);
    expect(verdict.arms.some((arm) => arm.id === 'grep_bm25')).toBe(true);
  });
});
