import { describe, expect, it } from 'vitest';

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
    expect(group?.rows).toHaveLength(2);
    const candidateIds = new Set(group?.rows.map((row) => row.candidate.toVisitId));
    expect(candidateIds).toEqual(
      new Set(['https://example.test/positive', 'https://example.test/negative']),
    );
    expect(group?.rows.map((row) => row.label).sort()).toEqual([0, 3]);
    expect(result.unjudgedCandidateCount).toBe(1);
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

  it('reconstructs historical feedback without treating unjudged candidates as negatives', async () => {
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
    expect(result.groups[0]?.rows).toHaveLength(1);
    expect(result.groups[0]?.rows[0]?.label).toBe(3);
    expect(result.groups[0]?.rows[0]?.candidate.toVisitId).toBe('https://example.test/target');
    expect(result.rawPositiveCount).toBe(1);
    expect(result.rawNegativeCount).toBe(0);
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
