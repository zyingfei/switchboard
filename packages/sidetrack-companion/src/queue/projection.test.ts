import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { QUEUE_CREATED, QUEUE_STATUS_SET } from './events.js';
import { projectQueueItem } from './projection.js';

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
  aggregateId: 'q-1',
  type: partial.type,
  payload: partial.payload,
  acceptedAtMs: 0,
});

describe('projectQueueItem', () => {
  it('captures the base record from the creation event', () => {
    const events = [
      event({
        type: QUEUE_CREATED,
        replicaId: 'A',
        seq: 1,
        payload: { bac_id: 'q-1', text: 'do thing', scope: 'thread', targetId: 't-1' },
      }),
    ];
    const projection = projectQueueItem('q-1', events);
    expect(projection.base).toMatchObject({ text: 'do thing', scope: 'thread', targetId: 't-1' });
    expect(projection.status).toEqual({ status: 'resolved' });
  });

  it('status set after creation resolves cleanly', () => {
    const events = [
      event({
        type: QUEUE_CREATED,
        replicaId: 'A',
        seq: 1,
        payload: { bac_id: 'q-1', text: 'do', scope: 'global' },
      }),
      event({
        type: QUEUE_STATUS_SET,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'q-1', status: 'done' },
      }),
    ];
    const projection = projectQueueItem('q-1', events);
    expect(projection.status).toMatchObject({ status: 'resolved', value: 'done' });
  });

  it('concurrent status edits surface as a conflict', () => {
    const events = [
      event({
        type: QUEUE_CREATED,
        replicaId: 'A',
        seq: 1,
        payload: { bac_id: 'q-1', text: 'do', scope: 'global' },
      }),
      event({
        type: QUEUE_STATUS_SET,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { bac_id: 'q-1', status: 'done' },
      }),
      event({
        type: QUEUE_STATUS_SET,
        replicaId: 'B',
        seq: 1,
        deps: { A: 1 },
        payload: { bac_id: 'q-1', status: 'dismissed' },
      }),
    ];
    const projection = projectQueueItem('q-1', events);
    expect(projection.status.status).toBe('conflict');
  });
});
