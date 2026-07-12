import { afterEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import { USER_FLOW_CONFIRMED, type UserFlowConfirmedPayload } from '../feedback/events.js';
import {
  RECALL_ACTION,
  RECALL_SERVED,
  type RecallActionKind,
  type RecallActionPayload,
  type RecallServedCandidateSnapshot,
  type RecallServedPayload,
} from '../recall/events.js';
import type { RecallCandidate, RecallResponse } from '../recall-v2/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  CANDIDATE_PAIR_FEATURE_KEYS,
  FEATURE_SCHEMA_VERSION,
  type CandidatePairFeatures,
} from './feature-schema.js';
import type { extractFeatures } from './features.js';
import {
  EXPLICIT_REJECT_INSTANCE_WEIGHT,
  WEAK_NEGATIVE_INSTANCE_WEIGHT,
  buildRecallImpressionTrainingGroups,
  maybeRetrainRecallImpressionRanker,
} from './retrain-impressions.js';

const BASE_TIME = Date.parse('2026-05-26T18:00:00.000Z');

const snapshot: ConnectionsSnapshot = {
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: new Date(BASE_TIME).toISOString(),
  nodeCount: 0,
  edgeCount: 0,
};

const event = <TPayload>(input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: TPayload;
  readonly acceptedAtMs?: number;
}): AcceptedEvent<TPayload> => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId:
    typeof input.payload === 'object' &&
    input.payload !== null &&
    'servedContextId' in input.payload &&
    typeof input.payload.servedContextId === 'string'
      ? input.payload.servedContextId
      : `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? BASE_TIME + input.seq,
});

const servedCandidate = (
  entityId: string,
  sourceKind: string,
  servedPosition: number,
): RecallServedCandidateSnapshot => ({
  entityId,
  sourceKind,
  canonicalUrl: `https://example.test/${entityId}`,
  fusedScore: 1 / (servedPosition + 1),
  servedPosition,
  perLaneRanks: { [sourceKind]: servedPosition + 1 },
  perLaneScores: { [sourceKind]: 1 / (servedPosition + 1) },
});

const served = (
  seq: number,
  servedContextId: string,
  candidates: readonly RecallServedCandidateSnapshot[],
): AcceptedEvent<RecallServedPayload> =>
  event({
    seq,
    type: RECALL_SERVED,
    payload: {
      payloadVersion: 1,
      servedContextId,
      query: 'ranker training',
      intent: 'search',
      sessionContext: { currentUrl: 'https://example.test/anchor' },
      results: candidates,
      rerankApplied: false,
      sequenceNumber: seq,
      servedAt: new Date(BASE_TIME + seq * 1_000).toISOString(),
    },
    acceptedAtMs: BASE_TIME + seq * 1_000,
  });

const action = (
  seq: number,
  servedContextId: string,
  entityId: string,
  actionKind: RecallActionKind,
): AcceptedEvent<RecallActionPayload> =>
  event({
    seq,
    type: RECALL_ACTION,
    payload: {
      payloadVersion: 1,
      servedContextId,
      entityId,
      actionKind,
      actionAt: new Date(BASE_TIME + seq * 1_000).toISOString(),
    },
    acceptedAtMs: BASE_TIME + seq * 1_000,
  });

const flowConfirmed = (
  seq: number,
  fromId: string,
  toId: string,
): AcceptedEvent<UserFlowConfirmedPayload> =>
  event({
    seq,
    type: USER_FLOW_CONFIRMED,
    payload: {
      payloadVersion: 1,
      relationKind: 'closest_visit',
      fromId,
      toId,
    },
    acceptedAtMs: BASE_TIME + seq * 1_000,
  });

const recallCandidate = (
  entityId: string,
  canonicalUrl: string,
  sourceKind: RecallCandidate['sourceKind'],
  fusedScore: number,
): RecallCandidate => ({
  candidateId: `candidate-${entityId}`,
  entityId,
  canonicalUrl,
  sourceKind,
  title: entityId,
  fusedScore,
  evidence: [
    {
      retriever: sourceKind === 'semantic_query' ? 'dense' : 'bm25',
      sourceKind,
      rawScore: fusedScore,
      rank: Math.max(1, Math.round(1 / fusedScore)),
    },
  ],
});

const recallResponse = (results: readonly RecallCandidate[]): RecallResponse => ({
  query: { text: 'https://example.test/anchor' },
  results,
  meta: {
    intent: 'focus',
    fusion: {
      strategy: 'rrf',
      perSourceCounts: {
        page_content: results.filter((row) => row.sourceKind === 'page_content').length,
        timeline_visit: results.filter((row) => row.sourceKind === 'timeline_visit').length,
        chat_turn: results.filter((row) => row.sourceKind === 'chat_turn').length,
        semantic_query: results.filter((row) => row.sourceKind === 'semantic_query').length,
        graph_neighbor: results.filter((row) => row.sourceKind === 'graph_neighbor').length,
        current_session: 0,
        focus: results.filter((row) => row.sourceKind === 'focus').length,
      },
    },
    timingsMs: {},
    flags: {},
  },
});

// A logged feature vector aligned to CANDIDATE_PAIR_FEATURE_KEYS with a
// recognizable sentinel per column so the decoded row is distinguishable
// from any reconstruction the trainer would produce against the (empty)
// snapshot fixture. Sentinel = column index + 100.
const loggedFeatureVector = (): number[] =>
  CANDIDATE_PAIR_FEATURE_KEYS.map((_key, index) => index + 100);

// A spy standing in for `extractFeatures`. Records every call so a test
// can assert the reconstruction path was (or was not) taken, and returns a
// distinct constant so we can tell reconstructed rows from logged ones.
const RECONSTRUCTED_SENTINEL = -777;
const makeExtractFeaturesSpy = (): {
  fn: typeof extractFeatures;
  calls: number;
} => {
  const state = { calls: 0 };
  const fn: typeof extractFeatures = () => {
    state.calls += 1;
    const out = {} as Record<keyof CandidatePairFeatures, number>;
    for (const key of CANDIDATE_PAIR_FEATURE_KEYS) out[key] = RECONSTRUCTED_SENTINEL;
    out.schemaVersion = FEATURE_SCHEMA_VERSION;
    return out as CandidatePairFeatures;
  };
  return {
    fn,
    get calls(): number {
      return state.calls;
    },
  };
};

const servedCandidateWithFeatures = (
  entityId: string,
  sourceKind: string,
  servedPosition: number,
  featureOverrides: Partial<RecallServedCandidateSnapshot>,
): RecallServedCandidateSnapshot => ({
  ...servedCandidate(entityId, sourceKind, servedPosition),
  ...featureOverrides,
});

describe('recall impression training — logged point-in-time features (Move 1)', () => {
  it('uses the logged feature vector when the schema version matches (no reconstruction)', async () => {
    const spy = makeExtractFeaturesSpy();
    const vector = loggedFeatureVector();
    const merged = [
      served(1, 'ctx-1', [
        servedCandidateWithFeatures('positive', 'page_content', 0, {
          features: vector,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        }),
        servedCandidateWithFeatures('negative', 'semantic_query', 1, {
          features: vector,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        }),
      ]),
      action(2, 'ctx-1', 'positive', 'flow_confirm'),
      action(3, 'ctx-1', 'negative', 'reject'),
    ];

    const result = await buildRecallImpressionTrainingGroups({
      merged,
      snapshot,
      extractFeaturesFn: spy.fn,
    });

    // Reconstruction MUST NOT run for schema-matching logged rows.
    expect(spy.calls).toBe(0);
    const group = result.groups[0];
    expect(group?.rows).toHaveLength(2);
    // Decoded features carry the logged sentinels, not the reconstruction
    // sentinel — proving the point-in-time vector was consumed verbatim.
    const bm25Col = CANDIDATE_PAIR_FEATURE_KEYS.indexOf('bm25_score');
    for (const row of group?.rows ?? []) {
      expect(row.features.bm25_score).toBe(vector[bm25Col]);
      expect(row.features.bm25_score).not.toBe(RECONSTRUCTED_SENTINEL);
      // schemaVersion is stamped from the current constant on decode.
      expect(row.features.schemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    }
  });

  it('falls back to reconstruction for legacy rows with no logged features', async () => {
    const spy = makeExtractFeaturesSpy();
    const merged = [
      served(1, 'ctx-1', [
        // Plain servedCandidate() carries NO features field (legacy).
        servedCandidate('positive', 'page_content', 0),
        servedCandidate('negative', 'semantic_query', 1),
      ]),
      action(2, 'ctx-1', 'positive', 'flow_confirm'),
      action(3, 'ctx-1', 'negative', 'reject'),
    ];

    const result = await buildRecallImpressionTrainingGroups({
      merged,
      snapshot,
      extractFeaturesFn: spy.fn,
    });

    // One reconstruction per served candidate (2).
    expect(spy.calls).toBe(2);
    const group = result.groups[0];
    for (const row of group?.rows ?? []) {
      expect(row.features.bm25_score).toBe(RECONSTRUCTED_SENTINEL);
    }
  });

  it('falls back to reconstruction on a schema-version mismatch rather than mixing schemas', async () => {
    const spy = makeExtractFeaturesSpy();
    const vector = loggedFeatureVector();
    const merged = [
      served(1, 'ctx-1', [
        servedCandidateWithFeatures('positive', 'page_content', 0, {
          features: vector,
          // Stale schema — must NOT be trusted.
          featureSchemaVersion: FEATURE_SCHEMA_VERSION - 1,
        }),
        servedCandidateWithFeatures('negative', 'semantic_query', 1, {
          features: vector,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION - 1,
        }),
      ]),
      action(2, 'ctx-1', 'positive', 'flow_confirm'),
      action(3, 'ctx-1', 'negative', 'reject'),
    ];

    const result = await buildRecallImpressionTrainingGroups({
      merged,
      snapshot,
      extractFeaturesFn: spy.fn,
    });

    expect(spy.calls).toBe(2);
    const group = result.groups[0];
    for (const row of group?.rows ?? []) {
      expect(row.features.bm25_score).toBe(RECONSTRUCTED_SENTINEL);
    }
  });
});

describe('recall impression training groups', () => {
  it('keeps every label inside its impression group', async () => {
    const merged = [
      served(1, 'ctx-1', [
        servedCandidate('positive', 'page_content', 0),
        servedCandidate('negative', 'semantic_query', 1),
        servedCandidate('unjudged', 'graph_neighbor', 2),
      ]),
      action(2, 'ctx-1', 'positive', 'flow_confirm'),
      action(3, 'ctx-1', 'negative', 'ignore'),
    ];

    const result = await buildRecallImpressionTrainingGroups({ merged, snapshot });

    expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    // Move 2a default-ON: the unjudged candidate is now a weak-negative row,
    // so the group carries all THREE shown candidates (was two pre-Move-2).
    expect(group?.rows).toHaveLength(3);
    const candidateIds = new Set(group?.rows.map((row) => row.candidate.toVisitId));
    expect(candidateIds).toEqual(
      new Set([
        'https://example.test/positive',
        'https://example.test/negative',
        'https://example.test/unjudged',
      ]),
    );
    expect(group?.rows.map((row) => row.label).sort()).toEqual([0, 0, 3]);
    expect(result.unjudgedCandidateCount).toBe(1);
    expect(result.weakNegativeCount).toBe(1);
  });

  it('does not generate a training group from engagement-only clicks', async () => {
    const merged = [
      served(1, 'ctx-1', [
        servedCandidate('clicked', 'page_content', 0),
        servedCandidate('unjudged', 'semantic_query', 1),
      ]),
      action(2, 'ctx-1', 'clicked', 'click'),
    ];

    const result = await buildRecallImpressionTrainingGroups({ merged, snapshot });

    expect(result.groups).toHaveLength(0);
    expect(result.scoringGroups).toHaveLength(1);
    expect(result.scoringGroups[0]?.rows).toHaveLength(2);
    expect(result.scoringGroups[0]?.rows[0]?.label).toBeUndefined();
    expect(result.rawPositiveCount).toBe(0);
    expect(result.rawNegativeCount).toBe(0);
    expect(result.unjudgedCandidateCount).toBe(2);
  });

  it('reconstructs historical feedback, treating unjudged candidates as weak negatives (Move 2a)', async () => {
    const legacyFeedback = flowConfirmed(
      1,
      'https://example.test/anchor',
      'https://example.test/target',
    );
    const result = await buildRecallImpressionTrainingGroups({
      merged: [legacyFeedback],
      snapshot,
      reconstructFeedback: async (request) => {
        expect(request.actionKind).toBe('flow_confirm');
        expect(request.recallRequest.session?.currentUrl).toBe('https://example.test/anchor');
        return recallResponse([
          recallCandidate('url:target', 'https://example.test/target', 'semantic_query', 0.9),
          recallCandidate('url:unjudged', 'https://example.test/unjudged', 'page_content', 0.4),
        ]);
      },
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.groupId).toBe('reconstructed:evt-1');
    // Default-ON: the non-target reconstruction candidate is a weak negative,
    // so the group now has the positive PLUS one weak-negative row.
    expect(result.groups[0]?.rows).toHaveLength(2);
    const rows = result.groups[0]?.rows ?? [];
    const target = rows.find((row) => row.candidate.toVisitId === 'https://example.test/target');
    const unjudged = rows.find(
      (row) => row.candidate.toVisitId === 'https://example.test/unjudged',
    );
    expect(target?.label).toBe(3);
    expect(target?.weight).toBeUndefined();
    expect(unjudged?.label).toBe(0);
    expect(unjudged?.weight).toBe(WEAK_NEGATIVE_INSTANCE_WEIGHT);
    // Positive/explicit-negative counts are unchanged — a weak negative is NOT
    // an explicit reject, so rawNegativeCount stays 0.
    expect(result.rawPositiveCount).toBe(1);
    expect(result.rawNegativeCount).toBe(0);
    expect(result.weakNegativeCount).toBe(1);
    expect(result.unjudgedCandidateCount).toBe(1);
  });

  it('skips cold start when there are no positive impression groups', async () => {
    const result = await maybeRetrainRecallImpressionRanker({ merged: [], snapshot });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'insufficient_groups',
      stats: { groupCount: 0 },
    });
  });

  it('marks reserved test as used exactly once after group-level training', async () => {
    const merged: AcceptedEvent[] = [];
    let seq = 1;
    for (let index = 0; index < 60; index += 1) {
      const contextId = `ctx-${String(index)}`;
      merged.push(
        served(seq, contextId, [
          servedCandidate(`positive-${String(index)}`, 'page_content', 0),
          servedCandidate(`negative-${String(index)}`, 'semantic_query', 1),
        ]),
      );
      seq += 1;
      merged.push(action(seq, contextId, `positive-${String(index)}`, 'flow_confirm'));
      seq += 1;
      merged.push(action(seq, contextId, `negative-${String(index)}`, 'reject'));
      seq += 1;
    }

    const result = await maybeRetrainRecallImpressionRanker({
      merged,
      snapshot,
      trainOptions: { seed: 7, numRound: 2, trainedAt: BASE_TIME },
    });

    expect(result.status).toBe('trained');
    if (result.status !== 'trained') throw new Error('expected trained result');
    expect(result.revision.trainedFromImpressions).toBe(true);
    expect(result.revision.trainQuality?.methodologySpine?.shipGate).toMatchObject({
      reservedTestUsedExactlyOnce: true,
    });
    expect(result.revision.trainQuality?.methodologySpine?.split).toMatchObject({
      status: 'available',
      trainGroupCount: 39,
      validationGroupCount: 9,
      testGroupCount: 12,
    });
  });
});

describe('recall impression training — weak negatives (Move 2a)', () => {
  const ENV = 'SIDETRACK_RANKER_WEAK_NEGATIVES';
  afterEach(() => {
    delete process.env[ENV];
  });

  // A group shown with 1 positive + 2 unjudged + 1 explicit reject. Default
  // (env unset) should densify to FOUR training rows; disabling restores the
  // legacy one-positive-plus-explicit-rejects grouping (two rows).
  const groupMerged = (): readonly AcceptedEvent[] => [
    served(1, 'ctx-1', [
      servedCandidate('positive', 'page_content', 0),
      servedCandidate('unjudged-a', 'semantic_query', 1),
      servedCandidate('unjudged-b', 'timeline_visit', 2),
      servedCandidate('reject', 'graph_neighbor', 3),
    ]),
    action(2, 'ctx-1', 'positive', 'flow_confirm'),
    action(3, 'ctx-1', 'reject', 'reject'),
  ];

  it('emits weak-negative rows for shown-but-unjudged candidates (default ON)', async () => {
    delete process.env[ENV];
    const result = await buildRecallImpressionTrainingGroups({
      merged: groupMerged(),
      snapshot,
    });
    const group = result.groups[0];
    expect(group).toBeDefined();
    // All four shown candidates become training rows.
    expect(group?.rows).toHaveLength(4);
    const byTarget = new Map(
      (group?.rows ?? []).map((row) => [row.candidate.toVisitId, row] as const),
    );
    const rowFor = (entityId: string) => byTarget.get(`https://example.test/${entityId}`);

    // Positive: label 3, no explicit weight (positives keep the default 1.0).
    expect(rowFor('positive')?.label).toBe(3);
    expect(rowFor('positive')?.weight).toBeUndefined();

    // Explicit reject: label 0 at FULL weight so it outranks weak negatives.
    expect(rowFor('reject')?.label).toBe(0);
    expect(rowFor('reject')?.weight).toBe(EXPLICIT_REJECT_INSTANCE_WEIGHT);

    // Unjudged: label 0 at the LOWER weak-negative weight.
    for (const id of ['unjudged-a', 'unjudged-b']) {
      expect(rowFor(id)?.label).toBe(0);
      expect(rowFor(id)?.weight).toBe(WEAK_NEGATIVE_INSTANCE_WEIGHT);
    }
    // Weak negatives are strictly below explicit rejects.
    expect(WEAK_NEGATIVE_INSTANCE_WEIGHT).toBeLessThan(EXPLICIT_REJECT_INSTANCE_WEIGHT);

    expect(result.weakNegativeCount).toBe(2);
    // Unjudged count is unchanged — a weak negative is still user-unjudged.
    expect(result.unjudgedCandidateCount).toBe(2);
  });

  it('restores legacy grouping when the disable env is set', async () => {
    process.env[ENV] = '0';
    const result = await buildRecallImpressionTrainingGroups({
      merged: groupMerged(),
      snapshot,
    });
    const group = result.groups[0];
    // Legacy behaviour: only the explicitly-judged rows (positive + reject).
    expect(group?.rows).toHaveLength(2);
    for (const row of group?.rows ?? []) {
      // No weights are stamped, so training is byte-identical to pre-Move-2.
      expect(row.weight).toBeUndefined();
    }
    expect(result.weakNegativeCount).toBe(0);
    // Unjudged still counted; they are just not promoted to training rows.
    expect(result.unjudgedCandidateCount).toBe(2);
  });

  it('trains a real LightGBM model through the weighted-row path', async () => {
    // Each impression carries an unjudged candidate → weak-negative rows, so
    // the LightGBM `weight` field is actually set on the dataset. This proves
    // the WASM weight plumbing runs end-to-end without crashing.
    delete process.env[ENV];
    const merged: AcceptedEvent[] = [];
    let seq = 1;
    for (let index = 0; index < 60; index += 1) {
      const contextId = `ctx-${String(index)}`;
      merged.push(
        served(seq, contextId, [
          servedCandidate(`positive-${String(index)}`, 'page_content', 0),
          servedCandidate(`negative-${String(index)}`, 'semantic_query', 1),
          servedCandidate(`unjudged-${String(index)}`, 'timeline_visit', 2),
        ]),
      );
      seq += 1;
      merged.push(action(seq, contextId, `positive-${String(index)}`, 'flow_confirm'));
      seq += 1;
      merged.push(action(seq, contextId, `negative-${String(index)}`, 'reject'));
      seq += 1;
    }

    const result = await maybeRetrainRecallImpressionRanker({
      merged,
      snapshot,
      trainOptions: { seed: 7, numRound: 2, trainedAt: BASE_TIME },
    });

    expect(result.status).toBe('trained');
    if (result.status !== 'trained') throw new Error('expected trained result');
    // 60 impressions × 1 unjudged each = 60 weak-negative rows fed to LightGBM.
    expect(result.stats.rawPositiveCount).toBe(60);
    expect(result.stats.rawNegativeCount).toBe(60);
  });
});
