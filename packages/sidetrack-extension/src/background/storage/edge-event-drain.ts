import type { BufferedEvent } from './in-memory-event-buffer';

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

const ackKeyOf = (event: EdgeEventImportAck): string =>
  `${event.replicaId}:${String(event.seq)}`;

const PERMANENT_SKIP_REASONS = new Set([
  'already-imported',
  'invalid-event-type',
  'invalid-payload',
]);

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
