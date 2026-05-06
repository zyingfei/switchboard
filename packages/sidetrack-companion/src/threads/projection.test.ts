import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from './events.js';
import { projectThread } from './projection.js';

const event = (
  partial: {
    readonly type: string;
    readonly replicaId: string;
    readonly seq: number;
    readonly payload: Record<string, unknown>;
    readonly deps?: Record<string, number>;
    readonly acceptedAtMs?: number;
  },
): AcceptedEvent => ({
  clientEventId: `${partial.replicaId}.${String(partial.seq)}`,
  dot: { replicaId: partial.replicaId, seq: partial.seq },
  deps: partial.deps ?? {},
  aggregateId: 'thread-1',
  type: partial.type,
  payload: partial.payload,
  acceptedAtMs: partial.acceptedAtMs ?? 0,
});

const upsert = (
  replicaId: string,
  seq: number,
  overrides: Record<string, unknown> = {},
  deps: Record<string, number> = {},
): AcceptedEvent =>
  event({
    type: THREAD_UPSERTED,
    replicaId,
    seq,
    deps,
    payload: {
      bac_id: 'thread-1',
      provider: 'chatgpt',
      threadUrl: 'https://example.test/1',
      title: 'Initial title',
      lastSeenAt: '2026-05-05T12:00:00.000Z',
      ...overrides,
    },
  });

describe('projectThread', () => {
  it('resolves to the most recent causally-newer upsert', () => {
    const events = [
      upsert('A', 1, { title: 'old' }),
      upsert('A', 2, { title: 'new' }, { A: 1 }),
    ];
    const projection = projectThread('thread-1', events);
    expect(projection.record).toMatchObject({ status: 'resolved' });
    if (projection.record.status === 'resolved') {
      expect(projection.record.value?.title).toBe('new');
    }
  });

  it('concurrent upserts surface as a record-level conflict', () => {
    const events = [
      upsert('A', 1, { title: 'A version' }),
      upsert('B', 1, { title: 'B version' }),
    ];
    const projection = projectThread('thread-1', events);
    expect(projection.record.status).toBe('conflict');
  });

  it('archive event sets the status register without disturbing the record', () => {
    const events = [
      upsert('A', 1, { title: 'a' }),
      event({
        type: THREAD_ARCHIVED,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'thread-1' },
      }),
    ];
    const projection = projectThread('thread-1', events);
    expect(projection.status).toMatchObject({ status: 'resolved', value: 'archived' });
    expect(projection.record).toMatchObject({ status: 'resolved' });
    if (projection.record.status === 'resolved') {
      expect(projection.record.value?.title).toBe('a');
    }
  });

  it('unarchive after archive flips status back', () => {
    const events = [
      upsert('A', 1),
      event({
        type: THREAD_ARCHIVED,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'thread-1' },
      }),
      event({
        type: THREAD_UNARCHIVED,
        replicaId: 'A',
        seq: 3,
        deps: { A: 2 },
        payload: { bac_id: 'thread-1' },
      }),
    ];
    const projection = projectThread('thread-1', events);
    expect(projection.status).toMatchObject({ status: 'resolved', value: 'tracked' });
  });

  it('concurrent archive vs unarchive surfaces a status conflict', () => {
    const events = [
      upsert('A', 1),
      event({
        type: THREAD_ARCHIVED,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'thread-1' },
      }),
      event({
        type: THREAD_UNARCHIVED,
        replicaId: 'B',
        seq: 1,
        deps: { A: 1 },
        payload: { bac_id: 'thread-1' },
      }),
    ];
    const projection = projectThread('thread-1', events);
    expect(projection.status.status).toBe('conflict');
  });

  it('delete short-circuits the projection, but a concurrent upsert revives it', () => {
    const concurrent = [
      upsert('A', 1, { title: 'before' }),
      event({
        type: THREAD_DELETED,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'thread-1' },
      }),
      upsert('B', 1, { title: 'concurrent revive' }),
    ];
    const projection = projectThread('thread-1', concurrent);
    expect(projection.deleted).toBe(false);
    expect(projection.record).toMatchObject({ status: 'resolved' });
    if (projection.record.status === 'resolved') {
      expect(projection.record.value?.title).toBe('concurrent revive');
    }
  });

  it('filters events by aggregate bac_id', () => {
    const events = [upsert('A', 1, { title: 'mine' }), upsert('A', 2, { bac_id: 'other' })];
    const projection = projectThread('thread-1', events);
    expect(projection.vector).toEqual({ A: 1 });
  });
});
