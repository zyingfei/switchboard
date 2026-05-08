import { describe, expect, it } from 'vitest';

import type {
  ConnectionEdge,
  ConnectionEdgeKind,
  ConnectionEdgeProducedBy,
} from '../connections/types.js';
import { nodeIdFor } from '../connections/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { randomUnrelated, recentlySkipped } from './negatives.js';

const BASE_TIME = Date.parse('2026-05-07T10:00:00.000Z');
const EDGE_OBSERVED_AT = '2026-05-07T10:00:03.000Z';
const EDGE_OBSERVED_AT_MS = Date.parse(EDGE_OBSERVED_AT);
const DAY_MS = 24 * 60 * 60 * 1_000;

const edge = (input: {
  readonly kind?: ConnectionEdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly observedAt?: string;
  readonly producedBy?: ConnectionEdgeProducedBy;
}): ConnectionEdge => ({
  id: `edge:${input.kind ?? 'visit_resembles_visit'}:${input.fromNodeId}:${input.toNodeId}`,
  kind: input.kind ?? 'visit_resembles_visit',
  fromNodeId: input.fromNodeId,
  toNodeId: input.toNodeId,
  observedAt: input.observedAt ?? EDGE_OBSERVED_AT,
  producedBy: input.producedBy ?? { source: 'visit-similarity', revisionId: 'rev-1' },
  confidence: 'inferred',
});

const event = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? BASE_TIME + input.seq * 1_000,
});

const rejectedPayload = (input: {
  readonly fromId: string;
  readonly toId: string;
  readonly relationKind?: 'closest_visit' | 'visit_resembles_visit' | 'visit_continues_visit';
}): unknown => ({
  payloadVersion: 1,
  relationKind: input.relationKind ?? 'visit_resembles_visit',
  fromId: input.fromId,
  toId: input.toId,
});

describe('negative candidate producers', () => {
  it('samples random unrelated candidates deterministically from the seed', () => {
    const visits = [
      { id: 'visit-e' },
      { id: 'visit-b' },
      { id: 'visit-d' },
      { id: 'visit-a' },
      { id: 'visit-c' },
    ];

    const first = randomUnrelated('visit-a', visits, 3, 'seed-1', {
      generatedAt: BASE_TIME,
    });
    const second = randomUnrelated('visit-a', [...visits].reverse(), 3, 'seed-1', {
      generatedAt: BASE_TIME,
    });

    expect(second).toEqual(first);
    expect(first).toHaveLength(3);
    expect(first.every((candidate) => candidate.fromVisitId === 'visit-a')).toBe(true);
    expect(first.every((candidate) => candidate.sources[0] === 'random_unrelated')).toBe(true);
    expect(first.every((candidate) => candidate.generatedAt === BASE_TIME)).toBe(true);
  });

  it('excludes visits connected to the source by any snapshot edge direction', () => {
    const edges = [
      edge({
        fromNodeId: nodeIdFor('timeline-visit', 'visit-a'),
        toNodeId: nodeIdFor('timeline-visit', 'visit-b'),
      }),
      edge({
        fromNodeId: 'visit-c',
        toNodeId: 'visit-a',
      }),
    ];

    expect(
      randomUnrelated('visit-a', ['visit-a', 'visit-b', 'visit-c', 'visit-d'], 10, 'seed-1', edges),
    ).toEqual([
      {
        fromVisitId: 'visit-a',
        toVisitId: 'visit-d',
        sources: ['random_unrelated'],
        generatedAt: EDGE_OBSERVED_AT_MS,
      },
    ]);
  });

  it('pulls recently skipped candidates from user.flow.rejected events only', () => {
    const referenceAtMs = BASE_TIME + 10 * DAY_MS;
    const actions = [
      event({
        seq: 1,
        type: 'user.flow.rejected',
        payload: rejectedPayload({ fromId: 'visit-a', toId: 'visit-b' }),
        acceptedAtMs: referenceAtMs - DAY_MS,
      }),
      event({
        seq: 2,
        type: 'user.flow.confirmed',
        payload: rejectedPayload({ fromId: 'visit-a', toId: 'visit-c' }),
        acceptedAtMs: referenceAtMs - DAY_MS,
      }),
      event({
        seq: 3,
        type: 'ranker.random_unrelated',
        payload: { fromId: 'visit-a', toId: 'visit-d' },
        acceptedAtMs: referenceAtMs - DAY_MS,
      }),
      event({
        seq: 4,
        type: 'user.flow.rejected',
        payload: rejectedPayload({ fromId: 'visit-x', toId: 'visit-e' }),
        acceptedAtMs: referenceAtMs - DAY_MS,
      }),
      event({
        seq: 5,
        type: 'user.flow.rejected',
        payload: rejectedPayload({ fromId: 'visit-a', toId: 'visit-old' }),
        acceptedAtMs: referenceAtMs - 8 * DAY_MS,
      }),
    ];

    expect(recentlySkipped('visit-a', actions, 7, { referenceAtMs })).toEqual([
      {
        fromVisitId: 'visit-a',
        toVisitId: 'visit-b',
        sources: ['recently_skipped'],
        generatedAt: referenceAtMs,
      },
    ]);
  });
});
