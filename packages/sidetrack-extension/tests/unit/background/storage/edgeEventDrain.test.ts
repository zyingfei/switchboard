import { describe, expect, it } from 'vitest';

import {
  createEdgeEventDrainSingleFlight,
  partitionEdgeEventDrainBatch,
  summarizeEdgeEventDrain,
  type EdgeEventImportAck,
  type EdgeEventImportSkip,
} from '../../../../src/background/storage/edge-event-drain';
import type { BufferedEvent } from '../../../../src/background/storage/in-memory-event-buffer';

const event = (
  streamName: BufferedEvent['streamName'],
  lamport: number,
  replicaId = 'edge-a',
): BufferedEvent => ({
  streamName,
  lamport,
  replicaId,
  payload: { payloadVersion: 1 },
  observedAt: '2026-05-11T00:00:00.000Z',
});

describe('summarizeEdgeEventDrain', () => {
  it('caps the upload batch at the route batch size; companion is the sole type gatekeeper', () => {
    // The drain used to filter event types locally with a hand-
    // maintained whitelist, which is the bug that hid
    // `navigation.committed` for weeks (it captured but never
    // uploaded). The new contract: send every buffered event to the
    // companion, let the companion validate, and act on its
    // `'invalid-event-type'` skip response on the next pass. This
    // test pins that contract — the partition function now ONLY
    // chunks by batch size; it never rejects locally.
    const batch = [
      event('navigation.committed', 1),
      event('engagement.interval.observed', 2),
      event('engagement.session.aggregated', 3),
      event('navigation.committed', 4),
    ];

    const partition = partitionEdgeEventDrainBatch(batch, 3);

    expect(partition.routeBatch.map((e) => e.lamport)).toEqual([1, 2, 3]);
    expect(partition.locallyRejectedBatch).toEqual([]);
    expect(partition.evictedByType).toEqual({});
    expect(partition.skippedByReason).toEqual({});
  });

  it('keeps uploaded accounting separate from permanent skip eviction', () => {
    const batch = [
      event('engagement.interval.observed', 1),
      event('navigation.committed', 2),
      event('selection.copied', 3),
      event('engagement.session.aggregated', 4),
    ];
    const imported: EdgeEventImportAck[] = [{ replicaId: 'edge-a', seq: 1 }];
    const skipped: EdgeEventImportSkip[] = [
      { replicaId: 'edge-a', seq: 2, reason: 'invalid-event-type' },
      { replicaId: 'edge-a', seq: 3, reason: 'invalid-payload' },
      { replicaId: 'edge-a', seq: 4, reason: 'already-imported' },
    ];

    const summary = summarizeEdgeEventDrain(batch, imported, skipped);

    expect(summary.acceptedEvents.map((e) => e.lamport)).toEqual([1, 4]);
    expect(summary.permanentlyRejectedEvents.map((e) => e.lamport)).toEqual([2, 3]);
    expect(summary.uploadedByType).toEqual({
      'engagement.interval.observed': 1,
      'engagement.session.aggregated': 1,
    });
    expect(summary.evictedByType).toEqual({
      'navigation.committed': 1,
      'selection.copied': 1,
    });
    expect(summary.skippedByReason).toEqual({
      'already-imported': 1,
      'invalid-event-type': 1,
      'invalid-payload': 1,
    });
  });

  it('leaves transient import errors buffered for retry', () => {
    const batch = [event('engagement.interval.observed', 1)];
    const skipped: EdgeEventImportSkip[] = [
      { replicaId: 'edge-a', seq: 1, reason: 'event log temporarily unavailable' },
    ];

    const summary = summarizeEdgeEventDrain(batch, [], skipped);

    expect(summary.acceptedEvents).toHaveLength(0);
    expect(summary.permanentlyRejectedEvents).toHaveLength(0);
    expect(summary.skippedByReason).toEqual({ 'event log temporarily unavailable': 1 });
  });

  it('coalesces concurrent drains and allows a later drain after settle', async () => {
    let calls = 0;
    let resolveFirst: ((value: string) => void) | null = null;
    const singleFlight = createEdgeEventDrainSingleFlight(async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return `run-${String(calls)}`;
    });

    const first = singleFlight();
    const second = singleFlight();
    expect(second).toBe(first);
    expect(calls).toBe(1);
    // TypeScript narrows `resolveFirst` to `never` after the inner
    // closure assignment because the outer let is initialized to null
    // and the assignment is inside a callback. The runtime value is
    // the resolver; assert via cast.
    (resolveFirst as unknown as (value: string) => void)('run-1');
    await expect(first).resolves.toBe('run-1');

    await expect(singleFlight()).resolves.toBe('run-2');
    expect(calls).toBe(2);
  });
});
