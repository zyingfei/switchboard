import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from './events.js';
import { collectLogBacIds, projectRecallFromLog } from './projection.js';

const event = (
  partial: {
    readonly type: string;
    readonly replicaId: string;
    readonly seq: number;
    readonly payload: Record<string, unknown>;
    readonly aggregateId?: string;
  },
): AcceptedEvent => ({
  clientEventId: `${partial.replicaId}.${String(partial.seq)}`,
  dot: { replicaId: partial.replicaId, seq: partial.seq },
  deps: {},
  aggregateId: partial.aggregateId ?? 'agg',
  type: partial.type,
  payload: partial.payload,
  acceptedAtMs: 0,
});

describe('projectRecallFromLog', () => {
  it('emits one input per non-empty turn, stamped with the event dot', () => {
    const events: AcceptedEvent[] = [
      event({
        type: CAPTURE_RECORDED,
        replicaId: 'A',
        seq: 1,
        payload: {
          bac_id: 'thread-1',
          capturedAt: '2026-05-05T12:00:00.000Z',
          turns: [
            { ordinal: 0, role: 'user', text: 'hi there' },
            { ordinal: 1, role: 'assistant', text: 'hello' },
            { ordinal: 2, role: 'user', text: '' /* skipped */ },
          ],
        },
      }),
    ];
    const items = projectRecallFromLog(events);
    expect(items.map((item) => item.id)).toEqual(['thread-1:0', 'thread-1:1']);
    expect(items.every((item) => item.replicaId === 'A')).toBe(true);
    expect(items.every((item) => item.lamport === 1)).toBe(true);
    expect(items.every((item) => !item.tombstoned)).toBe(true);
  });

  it('two replicas capturing the same (threadId, ordinal) coexist as distinct inputs', () => {
    const events: AcceptedEvent[] = [
      event({
        type: CAPTURE_RECORDED,
        replicaId: 'A',
        seq: 5,
        payload: {
          bac_id: 'thread-1',
          capturedAt: '2026-05-05T12:00:00.000Z',
          turns: [{ ordinal: 0, text: 'A snapshot' }],
        },
      }),
      event({
        type: CAPTURE_RECORDED,
        replicaId: 'B',
        seq: 3,
        payload: {
          bac_id: 'thread-1',
          capturedAt: '2026-05-05T12:00:30.000Z',
          turns: [{ ordinal: 0, text: 'B regenerated snapshot' }],
        },
      }),
    ];
    const items = projectRecallFromLog(events);
    expect(items).toHaveLength(2);
    expect(items.map((item) => `${item.replicaId}.${String(item.lamport)}`).sort()).toEqual([
      'A.5',
      'B.3',
    ]);
    // The id collides — by design. Identity is `(id, replicaId)`,
    // not `id` alone, so peer captures coexist.
    expect(new Set(items.map((item) => item.id)).size).toBe(1);
  });

  it('tombstone events flag every input matching their threadId', () => {
    const events: AcceptedEvent[] = [
      event({
        type: CAPTURE_RECORDED,
        replicaId: 'A',
        seq: 1,
        payload: {
          bac_id: 'thread-1',
          capturedAt: '2026-05-05T12:00:00.000Z',
          turns: [{ ordinal: 0, text: 'first' }],
        },
      }),
      event({
        type: CAPTURE_RECORDED,
        replicaId: 'A',
        seq: 2,
        payload: {
          bac_id: 'thread-2',
          capturedAt: '2026-05-05T12:00:00.000Z',
          turns: [{ ordinal: 0, text: 'second' }],
        },
      }),
      event({
        type: RECALL_TOMBSTONE_TARGET,
        replicaId: 'B',
        seq: 1,
        payload: { threadId: 'thread-1' },
      }),
    ];
    const items = projectRecallFromLog(events);
    expect(items.find((item) => item.threadId === 'thread-1')?.tombstoned).toBe(true);
    expect(items.find((item) => item.threadId === 'thread-2')?.tombstoned).toBe(false);
  });

  it('skips malformed events without crashing', () => {
    const events: AcceptedEvent[] = [
      event({
        type: CAPTURE_RECORDED,
        replicaId: 'A',
        seq: 1,
        payload: { not: 'a capture' },
      }),
      event({
        type: RECALL_TOMBSTONE_TARGET,
        replicaId: 'A',
        seq: 2,
        payload: { not: 'a tombstone' },
      }),
    ];
    expect(projectRecallFromLog(events)).toEqual([]);
  });

  it('collectLogBacIds gathers bac_ids from capture.recorded events only', () => {
    const events: AcceptedEvent[] = [
      event({
        type: CAPTURE_RECORDED,
        replicaId: 'A',
        seq: 1,
        payload: {
          bac_id: 'bac-1',
          capturedAt: '2026-05-05T12:00:00.000Z',
          turns: [{ ordinal: 0, text: 'hi' }],
        },
      }),
      event({
        type: RECALL_TOMBSTONE_TARGET,
        replicaId: 'A',
        seq: 2,
        payload: { threadId: 'bac-1' },
      }),
    ];
    expect(collectLogBacIds(events)).toEqual(new Set(['bac-1']));
  });
});
