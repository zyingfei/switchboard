import { describe, expect, it } from 'vitest';

import {
  createEdgeEventDrainSingleFlight,
  partitionEdgeEventDrainBatch,
  PRIORITY_STREAMS,
  selectEdgeEventDrainPriorityBatch,
  selectEdgeEventDrainScanBatch,
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
  it('keeps a navigation-triggered scan focused on navigation backlog', () => {
    const priority = [event('navigation.committed', 50)];
    const scanned = [event('engagement.interval.observed', 1), event('selection.copied', 2)];

    expect(selectEdgeEventDrainScanBatch(priority, scanned)).toEqual(priority);
    expect(selectEdgeEventDrainScanBatch([], scanned)).toEqual(scanned);
  });

  it('caps the upload batch at the route batch size; companion is the sole type gatekeeper', () => {
    // The drain used to filter event types locally with a hand-
    // maintained whitelist, which is the bug that hid
    // `navigation.committed` for weeks (it captured but never
    // uploaded). The new contract: send every buffered event to the
    // companion, let the companion validate, and act on its
    // `'invalid-event-type'` skip response on the next pass. This
    // test pins that contract — the partition function never rejects
    // locally, only chunks by batch size, and re-sorts priority streams
    // (aggregates, then navs) ahead of the interval backlog.
    const batch = [
      event('navigation.committed', 1),
      event('engagement.interval.observed', 2),
      event('engagement.session.aggregated', 3),
      event('navigation.committed', 4),
    ];

    const partition = partitionEdgeEventDrainBatch(batch, 3);

    // aggregate (3) leads, then navs (1, 4); the interval (2) is dropped by
    // the batch-size cap of 3.
    expect(partition.routeBatch.map((e) => e.lamport)).toEqual([3, 1, 4]);
    expect(partition.locallyRejectedBatch).toEqual([]);
    expect(partition.evictedByType).toEqual({});
    expect(partition.skippedByReason).toEqual({});
  });

  it('prioritizes navigation lineage over older engagement backlog', () => {
    const batch = [
      event('engagement.interval.observed', 1),
      event('engagement.interval.observed', 2),
      event('engagement.interval.observed', 3),
      event('navigation.committed', 50),
    ];

    const partition = partitionEdgeEventDrainBatch(batch, 2);

    expect(partition.routeBatch.map((e) => e.streamName)).toEqual([
      'navigation.committed',
      'engagement.interval.observed',
    ]);
    expect(partition.routeBatch.map((e) => e.lamport)).toEqual([50, 1]);
  });

  it('leads with the starved aggregate stream, then navs, then interval backlog', () => {
    // Even though the aggregate has a HIGHER lamport (arrived later) than
    // the interval backlog, it must ship first — it is the scarce signal
    // the companion similarity gate feeds on. Nav lineage comes next.
    const batch = [
      event('engagement.interval.observed', 1),
      event('engagement.interval.observed', 2),
      event('navigation.committed', 40),
      event('engagement.session.aggregated', 90),
    ];

    const partition = partitionEdgeEventDrainBatch(batch, 3);

    expect(partition.routeBatch.map((e) => e.streamName)).toEqual([
      'engagement.session.aggregated',
      'navigation.committed',
      'engagement.interval.observed',
    ]);
    expect(partition.routeBatch.map((e) => e.lamport)).toEqual([90, 40, 1]);
  });
});

describe('selectEdgeEventDrainPriorityBatch', () => {
  it('combines the per-stream priority peeks in PRIORITY_STREAMS order, aggregates first', () => {
    // Simulates the drain peeking each priority stream by index: aggregates
    // and navs each come back lamport-ordered within their own stream.
    const aggregates = [event('engagement.session.aggregated', 7)];
    const navs = [event('navigation.committed', 2), event('navigation.committed', 5)];
    const peeksByStream = PRIORITY_STREAMS.map((streamName) =>
      streamName === 'engagement.session.aggregated' ? aggregates : navs,
    );

    const combined = selectEdgeEventDrainPriorityBatch(peeksByStream, 10);

    expect(combined.map((e) => e.streamName)).toEqual([
      'engagement.session.aggregated',
      'navigation.committed',
      'navigation.committed',
    ]);
    expect(combined.map((e) => e.lamport)).toEqual([7, 2, 5]);
  });

  it('caps the combined batch at the route size, preserving priority order', () => {
    const aggregates = [
      event('engagement.session.aggregated', 1),
      event('engagement.session.aggregated', 2),
    ];
    const navs = [event('navigation.committed', 3)];
    const peeksByStream = PRIORITY_STREAMS.map((streamName) =>
      streamName === 'engagement.session.aggregated' ? aggregates : navs,
    );

    const combined = selectEdgeEventDrainPriorityBatch(peeksByStream, 2);

    // Both aggregates fill the cap; the nav is left for the next drain.
    expect(combined.map((e) => e.streamName)).toEqual([
      'engagement.session.aggregated',
      'engagement.session.aggregated',
    ]);
  });

  it('returns empty when both priority streams are empty (falls back to the scan)', () => {
    const combined = selectEdgeEventDrainPriorityBatch([[], []], 10);
    expect(combined).toEqual([]);
    // selectEdgeEventDrainScanBatch then chooses the FIFO scan.
    const scanned = [event('engagement.interval.observed', 1)];
    expect(selectEdgeEventDrainScanBatch(combined, scanned)).toEqual(scanned);
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
