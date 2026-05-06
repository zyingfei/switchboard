import {
  baseOutboxItemShape,
  chromeStoragePort,
  createOutbox,
  type DrainOptions,
  type DrainResult,
  type OutboxItem,
  type OutboxStorage,
} from './outbox';

import type { CaptureEvent } from './model';

// Capture queue retains its original storage keys so a chrome.storage
// payload that was written by a previous extension build still loads
// after the upgrade.

const QUEUE_KEY = 'sidetrack.captureQueue';
const DROPPED_KEY = 'sidetrack.captureQueue.droppedCount';
export const QUEUE_LIMIT = 1_000;

export type StoragePort = OutboxStorage;
export { chromeStoragePort };
export type { DrainOptions, DrainResult };

export interface QueuedCapture {
  readonly id: string;
  readonly queuedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly event: CaptureEvent;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const migrateQueuedCapture = (raw: unknown): OutboxItem<CaptureEvent> | null => {
  const base = baseOutboxItemShape(raw);
  if (base === null) return null;
  if (!isRecord(base.payload)) return null;
  return {
    id: base.id,
    queuedAt: base.queuedAt,
    attempts: base.attempts,
    nextAttemptAt: base.nextAttemptAt,
    payload: base.payload as unknown as CaptureEvent,
  };
};

const captureOutbox = createOutbox<CaptureEvent>({
  storageKey: QUEUE_KEY,
  droppedKey: DROPPED_KEY,
  defaultLimit: QUEUE_LIMIT,
  migrate: migrateQueuedCapture,
});

const toQueuedCapture = (item: OutboxItem<CaptureEvent>): QueuedCapture => ({
  id: item.id,
  queuedAt: item.queuedAt,
  attempts: item.attempts,
  nextAttemptAt: item.nextAttemptAt,
  event: item.payload,
});

export const readQueue = async (
  storage: StoragePort = chromeStoragePort,
): Promise<readonly QueuedCapture[]> => {
  const items = await captureOutbox.read(storage);
  return items.map(toQueuedCapture);
};

export const readDroppedCount = async (
  storage: StoragePort = chromeStoragePort,
): Promise<number> => await captureOutbox.readDropped(storage);

export const clearQueue = async (storage: StoragePort = chromeStoragePort): Promise<void> => {
  await captureOutbox.clear(storage);
};

export const computeNextAttempt = (
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): string => captureOutbox.computeNextAttempt(attempts, now, random);

export const enqueueCapture = async (
  event: CaptureEvent,
  storage: StoragePort = chromeStoragePort,
  limit = QUEUE_LIMIT,
): Promise<{ readonly queue: readonly QueuedCapture[]; readonly evicted: number }> => {
  const result = await captureOutbox.enqueue(event, storage, limit);
  return { queue: result.queue.map(toQueuedCapture), evicted: result.evicted };
};

export const drainQueue = async (
  send: (event: CaptureEvent) => Promise<void>,
  storage: StoragePort = chromeStoragePort,
  now: Date = new Date(),
  random: () => number = Math.random,
  opts: DrainOptions = {},
): Promise<DrainResult> =>
  await captureOutbox.drain(
    async (item) => {
      await send(item.payload);
    },
    storage,
    now,
    random,
    opts,
  );
