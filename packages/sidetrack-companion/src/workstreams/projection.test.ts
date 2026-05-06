import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from './events.js';
import { projectWorkstream } from './projection.js';

const event = (
  partial: {
    readonly type: string;
    readonly replicaId: string;
    readonly seq: number;
    readonly payload: Record<string, unknown>;
    readonly deps?: Record<string, number>;
  },
): AcceptedEvent => ({
  clientEventId: `${partial.replicaId}.${String(partial.seq)}`,
  dot: { replicaId: partial.replicaId, seq: partial.seq },
  deps: partial.deps ?? {},
  aggregateId: 'ws-1',
  type: partial.type,
  payload: partial.payload,
  acceptedAtMs: 0,
});

const upsert = (
  replicaId: string,
  seq: number,
  overrides: Record<string, unknown> = {},
  deps: Record<string, number> = {},
): AcceptedEvent =>
  event({
    type: WORKSTREAM_UPSERTED,
    replicaId,
    seq,
    deps,
    payload: { bac_id: 'ws-1', title: 'Plan', ...overrides },
  });

describe('projectWorkstream', () => {
  it('resolves to the most recent causally-newer upsert', () => {
    const events = [
      upsert('A', 1, { title: 'old' }),
      upsert('A', 2, { title: 'new', tags: ['x'] }, { A: 1 }),
    ];
    const projection = projectWorkstream('ws-1', events);
    expect(projection.record).toMatchObject({ status: 'resolved' });
    if (projection.record.status === 'resolved') {
      expect(projection.record.value?.title).toBe('new');
      expect(projection.record.value?.tags).toEqual(['x']);
    }
  });

  it('concurrent upserts surface as a record-level conflict', () => {
    const events = [upsert('A', 1, { title: 'A version' }), upsert('B', 1, { title: 'B version' })];
    const projection = projectWorkstream('ws-1', events);
    expect(projection.record.status).toBe('conflict');
  });

  it('delete tombstones the record but a concurrent later upsert revives it', () => {
    const events = [
      upsert('A', 1),
      event({
        type: WORKSTREAM_DELETED,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'ws-1' },
      }),
      upsert('B', 1, { title: 'concurrent revive' }),
    ];
    const projection = projectWorkstream('ws-1', events);
    expect(projection.deleted).toBe(false);
    expect(projection.record).toMatchObject({ status: 'resolved' });
    if (projection.record.status === 'resolved') {
      expect(projection.record.value?.title).toBe('concurrent revive');
    }
  });

  it('filters events by aggregate bac_id', () => {
    const events = [upsert('A', 1, { title: 'mine' }), upsert('A', 2, { bac_id: 'other' })];
    const projection = projectWorkstream('ws-1', events);
    expect(projection.vector).toEqual({ A: 1 });
  });
});
