import type { BufferedEvent } from './in-memory-event-buffer';

// 2026-05 cleanup: the extension previously maintained
// `ACCEPTED_EDGE_EVENT_STREAM_NAMES` as a parallel whitelist that had
// to mirror the companion's `ACCEPTED_EDGE_EVENT_TYPES`. The two
// drifted (navigation.committed got captured but never uploaded for
// weeks because the extension whitelist forgot it). The fix is to
// stop maintaining two lists at all: the COMPANION is the sole
// gatekeeper for what its `/v1/edge/events` route accepts. Any event
// in the extension's IndexedDB buffer is now routed to the companion;
// if the companion rejects the type with `'invalid-event-type'`, the
// drain summary marks it permanently rejected and the local buffer
// evicts it. Same end-state, one source of truth.

export interface EdgeEventDrainResult {
  readonly acceptedEvents: readonly BufferedEvent[];
  readonly permanentlyRejectedEvents: readonly BufferedEvent[];
  readonly uploadedByType: Record<string, number>;
  readonly evictedByType: Record<string, number>;
  readonly skippedByReason: Record<string, number>;
}

export interface EdgeEventImportAck {
  readonly replicaId: string;
  readonly seq: number;
}

export interface EdgeEventImportSkip extends EdgeEventImportAck {
  readonly reason: string;
}

export interface EdgeEventDrainBatchPartition {
  readonly routeBatch: readonly BufferedEvent[];
  readonly locallyRejectedBatch: readonly BufferedEvent[];
  readonly evictedByType: Record<string, number>;
  readonly skippedByReason: Record<string, number>;
}

export const createEdgeEventDrainSingleFlight = <T>(
  drainOnce: () => Promise<T>,
): (() => Promise<T>) => {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight !== null) return inFlight;
    const run = drainOnce().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };
};

const keyOf = (event: Pick<BufferedEvent, 'replicaId' | 'lamport'>): string =>
  `${event.replicaId}:${String(event.lamport)}`;

const ackKeyOf = (event: EdgeEventImportAck): string => `${event.replicaId}:${String(event.seq)}`;

const PERMANENT_SKIP_REASONS = new Set([
  'already-imported',
  'invalid-event-type',
  'invalid-payload',
]);

// Priority streams are peeked directly (by stream index) ahead of the
// FIFO scan so a scarce, latency-sensitive signal can't be starved behind
// a large low-value backlog. `engagement.session.aggregated` is the ONE
// event the companion's visit-similarity gate feeds on; in production it
// sat trapped FIFO behind ~1.2M `engagement.interval.observed` beacons for
// weeks. It leads the list so it drains first, then navigation lineage.
// Order matters: `PRIORITY_STREAMS` is the drain peek order, and
// `partitionEdgeEventDrainBatch` re-sorts a mixed batch so priority
// streams keep their lead within a single route batch.
export const PRIORITY_STREAMS: readonly BufferedEvent['streamName'][] = [
  'engagement.session.aggregated',
  'navigation.committed',
];

const PRIORITY_STREAM_SET = new Set<BufferedEvent['streamName']>(PRIORITY_STREAMS);

export const selectEdgeEventDrainScanBatch = (
  priorityBatch: readonly BufferedEvent[],
  scannedBatch: readonly BufferedEvent[],
): readonly BufferedEvent[] => (priorityBatch.length > 0 ? priorityBatch : scannedBatch);

// Combine the per-stream priority peeks into one route-sized batch, in
// `PRIORITY_STREAMS` order (aggregates first, then navs), capped at the
// route batch size. Each input is already lamport-ordered within its
// stream (peekByStream). Returns [] when both streams are empty so the
// caller falls back to the FIFO scan.
export const selectEdgeEventDrainPriorityBatch = (
  peeksByStream: readonly (readonly BufferedEvent[])[],
  maxRouteBatchSize: number,
): readonly BufferedEvent[] => {
  const routeLimit = Math.max(0, Math.floor(maxRouteBatchSize));
  const combined: BufferedEvent[] = [];
  for (const peek of peeksByStream) {
    for (const event of peek) {
      if (combined.length >= routeLimit) return combined;
      combined.push(event);
    }
  }
  return combined;
};

export const partitionEdgeEventDrainBatch = (
  batch: readonly BufferedEvent[],
  maxRouteBatchSize: number,
): EdgeEventDrainBatchPartition => {
  // No local whitelist filtering — the companion's
  // `/v1/edge/events` route is the sole authority. Events with
  // unknown types come back as `'invalid-event-type'` skips and
  // `summarizeEdgeEventDrain` evicts them on the next pass.
  const routeLimit = Math.max(0, Math.floor(maxRouteBatchSize));
  // Group priority events by their stream so the mixed-batch order matches
  // `PRIORITY_STREAMS` (aggregates lead navs); non-priority events keep
  // their incoming (lamport-scan) order behind them.
  const priorityByStream = new Map<BufferedEvent['streamName'], BufferedEvent[]>();
  const normal: BufferedEvent[] = [];
  for (const event of batch) {
    if (PRIORITY_STREAM_SET.has(event.streamName)) {
      const bucket = priorityByStream.get(event.streamName);
      if (bucket === undefined) priorityByStream.set(event.streamName, [event]);
      else bucket.push(event);
    } else normal.push(event);
  }
  const priority: BufferedEvent[] = [];
  for (const streamName of PRIORITY_STREAMS) {
    priority.push(...(priorityByStream.get(streamName) ?? []));
  }
  const routeBatch = [...priority, ...normal].slice(0, routeLimit);
  return {
    routeBatch,
    locallyRejectedBatch: [],
    evictedByType: {},
    skippedByReason: {},
  };
};

export const summarizeEdgeEventDrain = (
  batch: readonly BufferedEvent[],
  imported: readonly EdgeEventImportAck[],
  skipped: readonly EdgeEventImportSkip[],
): EdgeEventDrainResult => {
  const importedKeys = new Set(imported.map(ackKeyOf));
  const permanentlyRejectedKeys = new Set(
    skipped.filter((event) => PERMANENT_SKIP_REASONS.has(event.reason)).map(ackKeyOf),
  );
  const acceptedKeys = new Set([
    ...importedKeys,
    ...skipped.filter((event) => event.reason === 'already-imported').map(ackKeyOf),
  ]);
  const skippedByReason: Record<string, number> = {};
  for (const event of skipped) {
    skippedByReason[event.reason] = (skippedByReason[event.reason] ?? 0) + 1;
  }

  const acceptedEvents = batch.filter((event) => acceptedKeys.has(keyOf(event)));
  const permanentlyRejectedEvents = batch.filter((event) => {
    const key = keyOf(event);
    return permanentlyRejectedKeys.has(key) && !acceptedKeys.has(key);
  });

  const uploadedByType: Record<string, number> = {};
  for (const event of acceptedEvents) {
    uploadedByType[event.streamName] = (uploadedByType[event.streamName] ?? 0) + 1;
  }
  const evictedByType: Record<string, number> = {};
  for (const event of permanentlyRejectedEvents) {
    evictedByType[event.streamName] = (evictedByType[event.streamName] ?? 0) + 1;
  }

  return {
    acceptedEvents,
    permanentlyRejectedEvents,
    uploadedByType,
    evictedByType,
    skippedByReason,
  };
};
