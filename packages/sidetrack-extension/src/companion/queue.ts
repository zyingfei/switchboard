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
//
// V3 no-data-loss policy: each queued capture carries an `intent`
// flag. `passive` items (auto-track captures fired by the visibility-
// change watcher) tolerate drop-oldest on overflow. `explicit` items
// (user-clicked + Capture, + Comment chip submit) are protected: if
// the queue is full of passive items they evict the oldest passive
// to make room; if the queue is fully explicit, the new item is
// rejected and the side panel surfaces a banner. Older payloads
// without an intent flag default to `passive` so existing chrome.
// storage data keeps draining.

const QUEUE_KEY = 'sidetrack.captureQueue';
const DROPPED_KEY = 'sidetrack.captureQueue.droppedCount';
// Retry-exhausted explicit captures land here instead of being
// silently dropped. The side panel surfaces them in the
// QueueRejectionBanner with a Retry action that re-enqueues them
// as fresh explicit captures. Passive captures continue dropping
// silently into droppedCount.
const FAILED_KEY = 'sidetrack.captureQueue.failed';
const FAILED_LIMIT = 200;
export const QUEUE_LIMIT = 1_000;
const MAX_ATTEMPTS = 12;

export type CaptureIntent = 'explicit' | 'passive';

interface CapturePayload {
  readonly intent: CaptureIntent;
  readonly event: CaptureEvent;
}

export type StoragePort = OutboxStorage;
export { chromeStoragePort };
export type { DrainOptions, DrainResult };

export interface QueuedCapture {
  readonly id: string;
  readonly queuedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly event: CaptureEvent;
  readonly intent: CaptureIntent;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isCaptureIntent = (value: unknown): value is CaptureIntent =>
  value === 'explicit' || value === 'passive';

// Read the payload's intent flag; pre-V3 payloads have a CaptureEvent
// directly (no wrapper), so we infer 'passive' for safety. New
// writes always wrap with { intent, event }.
const unwrap = (raw: Record<string, unknown>): { intent: CaptureIntent; event: CaptureEvent } => {
  const intent = isCaptureIntent(raw['intent']) ? raw['intent'] : 'passive';
  const event = isRecord(raw['event']) ? (raw['event'] as unknown as CaptureEvent) : (raw as unknown as CaptureEvent);
  return { intent, event };
};

const migrateQueuedCapture = (raw: unknown): OutboxItem<CapturePayload> | null => {
  const base = baseOutboxItemShape(raw);
  if (base === null) return null;
  if (!isRecord(base.payload)) return null;
  const { intent, event } = unwrap(base.payload);
  return {
    id: base.id,
    queuedAt: base.queuedAt,
    attempts: base.attempts,
    nextAttemptAt: base.nextAttemptAt,
    payload: { intent, event },
  };
};

const captureOutbox = createOutbox<CapturePayload>({
  storageKey: QUEUE_KEY,
  droppedKey: DROPPED_KEY,
  defaultLimit: QUEUE_LIMIT,
  migrate: migrateQueuedCapture,
});

const toQueuedCapture = (item: OutboxItem<CapturePayload>): QueuedCapture => ({
  id: item.id,
  queuedAt: item.queuedAt,
  attempts: item.attempts,
  nextAttemptAt: item.nextAttemptAt,
  event: item.payload.event,
  intent: item.payload.intent,
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

export interface EnqueueResult {
  readonly accepted: boolean;
  readonly reason?: 'queue-full-explicit';
  readonly queue: readonly QueuedCapture[];
  readonly evicted: number;
}

export const enqueueCapture = async (
  event: CaptureEvent,
  storage: StoragePort = chromeStoragePort,
  limit = QUEUE_LIMIT,
  intent: CaptureIntent = 'passive',
): Promise<EnqueueResult> => {
  // For passive captures the original drop-oldest semantics still
  // hold — an auto-track session that's been offline for weeks can
  // safely lose its oldest snapshots. createOutbox.enqueue caps at
  // `limit` and evicts the head.
  if (intent === 'passive') {
    const result = await captureOutbox.enqueue({ intent, event }, storage, limit);
    return { accepted: true, queue: result.queue.map(toQueuedCapture), evicted: result.evicted };
  }

  // Explicit captures get protective handling. Read first, then
  // decide.
  const current = await captureOutbox.read(storage);
  if (current.length < limit) {
    const result = await captureOutbox.enqueue({ intent, event }, storage, limit);
    return { accepted: true, queue: result.queue.map(toQueuedCapture), evicted: result.evicted };
  }
  // Queue is at capacity. Try to evict the oldest passive item to
  // make room. If everyone is explicit, reject the new arrival so
  // the side panel can surface a banner.
  const oldestPassiveIndex = current.findIndex(
    (item) => item.payload.intent === 'passive',
  );
  if (oldestPassiveIndex === -1) {
    return {
      accepted: false,
      reason: 'queue-full-explicit',
      queue: current.map(toQueuedCapture),
      evicted: 0,
    };
  }
  // Drop the oldest passive item, then enqueue. createOutbox doesn't
  // expose a "drop at index" primitive; use clear+rewrite to keep
  // the implementation small.
  const survivors = [
    ...current.slice(0, oldestPassiveIndex),
    ...current.slice(oldestPassiveIndex + 1),
  ];
  // Re-seed the storage with the survivors then enqueue the new
  // explicit item. The enqueue path bumps droppedCount internally
  // when it evicts, but here we're hand-evicting one passive item
  // ourselves, so we do not bump.
  await captureOutbox.clear(storage);
  for (const item of survivors) {
    // Direct re-add via enqueue. Limit doesn't matter (we're under
    // it after the clear) but we pass it for safety.
    await captureOutbox.enqueue(item.payload, storage, limit);
  }
  const result = await captureOutbox.enqueue({ intent, event }, storage, limit);
  return {
    accepted: true,
    queue: result.queue.map(toQueuedCapture),
    evicted: 1,
  };
};

// Failed-capture storage record. We keep enough context for the
// side panel to render a meaningful "n unsynced after 12 retries"
// pill and for a Retry action to re-enqueue the original event.
export interface FailedCapture {
  readonly id: string;
  readonly queuedAt: string;
  readonly failedAt: string;
  readonly event: CaptureEvent;
  readonly lastErrorMessage?: string;
}

const isFailedRecord = (raw: unknown): raw is FailedCapture => {
  if (!isRecord(raw)) return false;
  return (
    typeof raw['id'] === 'string' &&
    typeof raw['queuedAt'] === 'string' &&
    typeof raw['failedAt'] === 'string' &&
    isRecord(raw['event'])
  );
};

export const readFailedCaptures = async (
  storage: StoragePort = chromeStoragePort,
): Promise<readonly FailedCapture[]> => {
  const raw = await storage.get<unknown>(FAILED_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isFailedRecord);
};

const writeFailedCaptures = async (
  storage: StoragePort,
  list: readonly FailedCapture[],
): Promise<void> => {
  // Keep the last FAILED_LIMIT entries so a long-running outage
  // doesn't blow up chrome.storage; the explicit-capture invariant
  // is "no silent drop", and the user-visible banner records the
  // earliest dropped timestamp when we trim.
  const trimmed = list.length > FAILED_LIMIT ? list.slice(list.length - FAILED_LIMIT) : list;
  await storage.set({ [FAILED_KEY]: trimmed });
};

export const clearFailedCaptures = async (
  storage: StoragePort = chromeStoragePort,
): Promise<void> => {
  await storage.set({ [FAILED_KEY]: [] });
};

export const retryFailedCaptures = async (
  storage: StoragePort = chromeStoragePort,
): Promise<{ readonly requeued: number }> => {
  const failed = await readFailedCaptures(storage);
  if (failed.length === 0) return { requeued: 0 };
  await clearFailedCaptures(storage);
  let requeued = 0;
  for (const record of failed) {
    const result = await enqueueCapture(record.event, storage, QUEUE_LIMIT, 'explicit');
    if (result.accepted) requeued += 1;
    else {
      // The queue is full of explicit items again — keep the rest
      // in the failed list rather than losing them.
      const stillFailed = failed.slice(failed.indexOf(record));
      const now = new Date().toISOString();
      await writeFailedCaptures(
        storage,
        stillFailed.map((r) => ({ ...r, failedAt: now })),
      );
      break;
    }
  }
  return { requeued };
};

export const drainQueue = async (
  send: (event: CaptureEvent) => Promise<void>,
  storage: StoragePort = chromeStoragePort,
  now: Date = new Date(),
  random: () => number = Math.random,
  opts: DrainOptions = {},
): Promise<DrainResult> => {
  // Accumulate explicit captures that exhaust their retry budget
  // during this drain pass. They get persisted to the failed-queue
  // AFTER drain so a kill-9 mid-flight doesn't leave duplicate
  // entries (the failed-queue write is idempotent on item id).
  const newlyFailed: FailedCapture[] = [];
  const result = await captureOutbox.drain(
    async (item) => {
      try {
        await send(item.payload.event);
      } catch (error) {
        // The outbox bumps attempts AFTER our throw, so attempts
        // here is the count of PRIOR failures. The next bump turns
        // attempts into MAX_ATTEMPTS+1 and the outbox drops the
        // item. Snapshot it now so the failed-queue records it
        // before the drop.
        if (item.attempts >= MAX_ATTEMPTS && item.payload.intent === 'explicit') {
          newlyFailed.push({
            id: item.id,
            queuedAt: item.queuedAt,
            failedAt: now.toISOString(),
            event: item.payload.event,
            ...(error instanceof Error ? { lastErrorMessage: error.message.slice(0, 200) } : {}),
          });
        }
        throw error;
      }
    },
    storage,
    now,
    random,
    opts,
  );
  if (newlyFailed.length > 0) {
    const existing = await readFailedCaptures(storage);
    const existingIds = new Set(existing.map((e) => e.id));
    const merged = [...existing, ...newlyFailed.filter((f) => !existingIds.has(f.id))];
    await writeFailedCaptures(storage, merged);
  }
  return result;
};
