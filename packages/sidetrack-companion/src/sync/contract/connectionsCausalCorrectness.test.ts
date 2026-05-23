import { describe, expect, it } from 'vitest';

import { buildConnectionsSnapshot, type ConnectionsInput } from '../../connections/snapshot.js';
import { nodeIdFor } from '../../connections/types.js';
import { createEmptyTabSessionProjection } from '../../tabsession/projection.js';
import { THREAD_DELETED, THREAD_UPSERTED } from '../../threads/events.js';
import { WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import {
  mergeRegister,
  type AcceptedEvent,
  type Dot,
  type VersionVector,
} from '../causal.js';
import { addDotsToIntervals, intervalsContainDot } from './materializerProgress.js';

const emptyInput = (events: readonly AcceptedEvent[]): ConnectionsInput => ({
  events,
  threads: [],
  workstreams: [],
  dispatches: [],
  queueItems: [],
  reminders: [],
  codingSessions: [],
  timelineDays: [],
  tabSessionProjection: createEmptyTabSessionProjection(),
});

const event = (input: {
  readonly type: string;
  readonly replicaId: string;
  readonly seq: number;
  readonly deps?: VersionVector;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.${input.type}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: input.aggregateId,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? input.seq,
});

const workstreamUpserted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly title: string;
  readonly deps?: VersionVector;
  readonly acceptedAtMs?: number;
}): AcceptedEvent =>
  event({
    type: WORKSTREAM_UPSERTED,
    replicaId: input.replicaId,
    seq: input.seq,
    deps: input.deps,
    aggregateId: input.bacId,
    acceptedAtMs: input.acceptedAtMs,
    payload: { bac_id: input.bacId, title: input.title },
  });

const threadUpserted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly title: string;
  readonly deps?: VersionVector;
  readonly acceptedAtMs?: number;
}): AcceptedEvent =>
  event({
    type: THREAD_UPSERTED,
    replicaId: input.replicaId,
    seq: input.seq,
    deps: input.deps,
    aggregateId: input.bacId,
    acceptedAtMs: input.acceptedAtMs,
    payload: {
      bac_id: input.bacId,
      provider: 'chatgpt',
      threadUrl: `https://chat.example.test/${input.bacId}`,
      title: input.title,
      lastSeenAt: '2026-05-22T00:00:00.000Z',
    },
  });

const threadDeleted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly deps?: VersionVector;
  readonly acceptedAtMs?: number;
}): AcceptedEvent =>
  event({
    type: THREAD_DELETED,
    replicaId: input.replicaId,
    seq: input.seq,
    deps: input.deps,
    aggregateId: input.bacId,
    acceptedAtMs: input.acceptedAtMs,
    payload: { bac_id: input.bacId },
  });

const normalizeReplicaIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeReplicaIds);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'replicaId') {
      out[key] = '<replica>';
    } else if (key === 'originReplicaIds') {
      out[key] = ['<replica>'];
    } else {
      out[key] = normalizeReplicaIds(child);
    }
  }
  return out;
};

describe('connections causal correctness', () => {
  it('local-vs-peer symmetry differs only by replica ids in dots', () => {
    const local = buildConnectionsSnapshot(
      emptyInput([
        workstreamUpserted({ replicaId: 'A', seq: 1, bacId: 'W', title: 'Planning' }),
        threadUpserted({
          replicaId: 'A',
          seq: 2,
          bacId: 'T',
          title: 'Thread',
          deps: { A: 1 },
        }),
      ]),
    );
    const peer = buildConnectionsSnapshot(
      emptyInput([
        workstreamUpserted({ replicaId: 'B', seq: 1, bacId: 'W', title: 'Planning' }),
        threadUpserted({
          replicaId: 'B',
          seq: 2,
          bacId: 'T',
          title: 'Thread',
          deps: { B: 1 },
        }),
      ]),
    );

    expect(normalizeReplicaIds(peer)).toEqual(normalizeReplicaIds(local));
  });

  it('concurrent workstream update preserves mergeRegister conflict', () => {
    const original = workstreamUpserted({
      replicaId: 'A',
      seq: 1,
      bacId: 'W',
      title: 'Original',
      acceptedAtMs: 100,
    });
    const peer = workstreamUpserted({
      replicaId: 'B',
      seq: 1,
      bacId: 'W',
      title: 'B-version',
      deps: { A: 1 },
      acceptedAtMs: 200,
    });
    const local = workstreamUpserted({
      replicaId: 'A',
      seq: 2,
      bacId: 'W',
      title: 'A-version',
      deps: { A: 1 },
      acceptedAtMs: 300,
    });
    const expected = mergeRegister([
      { value: 'Original', event: original },
      { value: 'B-version', event: peer },
      { value: 'A-version', event: local },
    ]);
    expect(expected).toEqual({
      status: 'conflict',
      candidates: [
        { value: 'B-version', event: { replicaId: 'B', seq: 1 }, replicaId: 'B', acceptedAtMs: 200 },
        { value: 'A-version', event: { replicaId: 'A', seq: 2 }, replicaId: 'A', acceptedAtMs: 300 },
      ],
    });

    const snapshot = buildConnectionsSnapshot(emptyInput([original, peer, local]));
    const node = snapshot.nodes.find((candidate) => candidate.id === nodeIdFor('workstream', 'W'));
    expect(node?.label).toBe('B-version');
    expect(node?.metadata['causalRegister']).toMatchObject({
      status: 'conflict',
      candidates: [
        {
          value: expect.objectContaining({ title: 'B-version' }),
          event: { replicaId: 'B', seq: 1 },
        },
        {
          value: expect.objectContaining({ title: 'A-version' }),
          event: { replicaId: 'A', seq: 2 },
        },
      ],
    });
  });

  it('observed tombstone only deletes what it causally observed', () => {
    const t1 = threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', title: 'T1' });
    const t2 = threadUpserted({ replicaId: 'B', seq: 1, bacId: 'T2', title: 'T2' });
    const deletedT1 = threadDeleted({
      replicaId: 'A',
      seq: 2,
      bacId: 'T1',
      deps: { A: 1 },
    });

    const snapshot = buildConnectionsSnapshot(emptyInput([t1, t2, deletedT1]));

    expect(snapshot.nodes.find((node) => node.id === nodeIdFor('thread', 'T1'))).toBeUndefined();
    expect(snapshot.nodes.find((node) => node.id === nodeIdFor('thread', 'T2'))).toMatchObject({
      id: nodeIdFor('thread', 'T2'),
      label: 'T2',
    });
  });

  it('stale baseVector empty object is concurrent, not dominant', () => {
    const peer = workstreamUpserted({
      replicaId: 'B',
      seq: 5,
      bacId: 'W',
      title: 'peer-version',
      deps: { B: 4 },
      acceptedAtMs: 500,
    });
    const stale = workstreamUpserted({
      replicaId: 'A',
      seq: 1,
      bacId: 'W',
      title: 'stale-browser',
      deps: {},
      acceptedAtMs: 100,
    });

    const expected = mergeRegister([
      { value: 'peer-version', event: peer },
      { value: 'stale-browser', event: stale },
    ]);

    expect(expected).toEqual({
      status: 'conflict',
      candidates: [
        {
          value: 'stale-browser',
          event: { replicaId: 'A', seq: 1 },
          replicaId: 'A',
          acceptedAtMs: 100,
        },
        {
          value: 'peer-version',
          event: { replicaId: 'B', seq: 5 },
          replicaId: 'B',
          acceptedAtMs: 500,
        },
      ],
    });
  });

  it('out-of-order gapped peer dots are applied without filling the gap', () => {
    const dots: readonly Dot[] = [
      { replicaId: 'B', seq: 5 },
      { replicaId: 'B', seq: 3 },
      { replicaId: 'B', seq: 4 },
      { replicaId: 'B', seq: 1 },
    ];

    const intervals = addDotsToIntervals({}, dots);

    expect(intervals).toEqual({ B: [[1, 1], [3, 5]] });
    expect(intervalsContainDot(intervals, { replicaId: 'B', seq: 1 })).toBe(true);
    expect(intervalsContainDot(intervals, { replicaId: 'B', seq: 2 })).toBe(false);
    expect(intervalsContainDot(intervals, { replicaId: 'B', seq: 3 })).toBe(true);
    expect(intervalsContainDot(intervals, { replicaId: 'B', seq: 4 })).toBe(true);
    expect(intervalsContainDot(intervals, { replicaId: 'B', seq: 5 })).toBe(true);
  });
});
