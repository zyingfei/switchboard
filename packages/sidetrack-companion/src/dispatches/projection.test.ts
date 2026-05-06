import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from './events.js';
import { projectDispatches } from './projection.js';

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
  aggregateId: 'd',
  type: partial.type,
  payload: partial.payload,
  acceptedAtMs: partial.acceptedAtMs ?? 0,
});

describe('projectDispatches', () => {
  it('returns dispatches stably sorted by createdAt then dot', () => {
    const events = [
      event({
        type: DISPATCH_RECORDED,
        replicaId: 'B',
        seq: 1,
        payload: {
          bac_id: 'd-2',
          target: { provider: 'claude' },
          createdAt: '2026-05-05T12:00:01.000Z',
          body: 'second',
        },
      }),
      event({
        type: DISPATCH_RECORDED,
        replicaId: 'A',
        seq: 1,
        payload: {
          bac_id: 'd-1',
          target: { provider: 'chatgpt' },
          createdAt: '2026-05-05T12:00:00.000Z',
          body: 'first',
        },
      }),
    ];
    const projection = projectDispatches(events);
    expect(projection.entries.map((entry) => entry.bac_id)).toEqual(['d-1', 'd-2']);
  });

  it('LWW link: a later link with deps observing the earlier wins', () => {
    const events = [
      event({
        type: DISPATCH_LINKED,
        replicaId: 'A',
        seq: 1,
        payload: { dispatchId: 'd-1', threadId: 't-1' },
      }),
      event({
        type: DISPATCH_LINKED,
        replicaId: 'A',
        seq: 2,
        deps: { A: 1 },
        payload: { dispatchId: 'd-1', threadId: 't-2' },
      }),
    ];
    const projection = projectDispatches(events);
    const link = projection.links.find((entry) => entry.dispatchId === 'd-1');
    expect(link?.threadId).toBe('t-2');
    expect(link?.conflict).toBeUndefined();
  });

  it('concurrent links to different threads surface as a conflict', () => {
    const events = [
      event({
        type: DISPATCH_LINKED,
        replicaId: 'A',
        seq: 1,
        payload: { dispatchId: 'd-1', threadId: 't-1' },
      }),
      event({
        type: DISPATCH_LINKED,
        replicaId: 'B',
        seq: 1,
        payload: { dispatchId: 'd-1', threadId: 't-2' },
      }),
    ];
    const projection = projectDispatches(events);
    const link = projection.links.find((entry) => entry.dispatchId === 'd-1');
    expect(link?.threadId).toBeUndefined();
    expect(link?.conflict?.map((candidate) => candidate.threadId).sort()).toEqual(['t-1', 't-2']);
  });
});
