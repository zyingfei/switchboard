import {
  baseOutboxItemShape,
  chromeStoragePort,
  createOutbox,
  type DrainOptions,
  type DrainResult,
  type OutboxItem,
  type OutboxStorage,
} from './outbox';
import { singleFlight, withQueueLock } from './captureQueueMutex';

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
// Scratch key for crash-safe eviction: survivors + the new explicit
// item are staged here, then swapped into QUEUE_KEY, then this is
// cleared. A crash between phases never leaves QUEUE_KEY empty (see
// evictAndEnqueueExplicit).
const EVICTION_SCRATCH_KEY = 'sidetrack.captureQueue.evicting';
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
  const event = isRecord(raw['event'])
    ? (raw['event'] as unknown as CaptureEvent)
    : (raw as unknown as CaptureEvent);
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
  // The capture queue accepts enqueues while a drain awaits the
  // network (nav captures fire independent of the workboard-poll
  // drain). Merge drain outcomes against a fresh read so a concurrent
  // enqueue is never clobbered by the end-of-drain rewrite.
  atomicDrainMerge: true,
});

const toQueuedCapture = (item: OutboxItem<CapturePayload>): QueuedCapture => ({
  id: item.id,
  queuedAt: item.queuedAt,
  attempts: item.attempts,
  nextAttemptAt: item.nextAttemptAt,
  event: item.payload.event,
  intent: item.payload.intent,
});

// Clear a leftover eviction scratch record. A non-empty scratch means
// a prior evictAndEnqueueExplicit crashed after staging but the primary
// QUEUE_KEY still holds a valid queue (either the original full queue,
// if the crash preceded the swap, or the correct post-eviction queue,
// if it followed). Either way the primary is authoritative, so we just
// drop the stale scratch. Best-effort — never throws into the caller.
const reconcileEvictionScratch = async (storage: StoragePort): Promise<void> => {
  try {
    const scratch = await storage.get<readonly unknown[]>(EVICTION_SCRATCH_KEY, []);
    if (Array.isArray(scratch) && scratch.length > 0) {
      await storage.set({ [EVICTION_SCRATCH_KEY]: [] });
    }
  } catch {
    // A failed reconcile must never block a read; the scratch is inert.
  }
};

export const readQueue = async (
  storage: StoragePort = chromeStoragePort,
): Promise<readonly QueuedCapture[]> => {
  await reconcileEvictionScratch(storage);
  const items = await captureOutbox.read(storage);
  return items.map(toQueuedCapture);
};

export const readDroppedCount = async (storage: StoragePort = chromeStoragePort): Promise<number> =>
  await captureOutbox.readDropped(storage);

export const clearQueue = async (storage: StoragePort = chromeStoragePort): Promise<void> => {
  await withQueueLock(storage, async () => {
    await captureOutbox.clear(storage);
    await storage.set({ [EVICTION_SCRATCH_KEY]: [] });
  });
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

const mintItem = (payload: CapturePayload): OutboxItem<CapturePayload> => {
  const queuedAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    queuedAt,
    attempts: 0,
    nextAttemptAt: queuedAt,
    payload,
  };
};

// Test-only seam: injected between the "stage to scratch" and "commit
// to primary" phases of eviction so a test can simulate an SW death in
// the exact gap that used to lose up to 999 captures. Production leaves
// it undefined (a no-op).
type EvictionFaultHook = (() => Promise<void>) | undefined;

// Crash-safe replacement for the old clear()+re-enqueue loop. Instead
// of ever writing QUEUE_KEY empty, we compute the full desired next
// array (survivors with the oldest passive dropped, plus the new
// explicit item) and land it via a scratch-key stage → primary-key
// commit → scratch clear. At no point is QUEUE_KEY left empty: a crash
// before the commit leaves the ORIGINAL full queue intact; a crash
// after it leaves the CORRECT post-eviction queue. Either way the only
// item that can be lost is the not-yet-committed new explicit capture
// (the caller's storeCaptureEvent still wrote it to the local mirror),
// never a survivor.
const evictAndEnqueueExplicit = async (
  storage: StoragePort,
  survivors: readonly OutboxItem<CapturePayload>[],
  newItem: OutboxItem<CapturePayload>,
  faultHook: EvictionFaultHook,
): Promise<readonly OutboxItem<CapturePayload>[]> => {
  const nextArray = [...survivors, newItem];
  // Phase 1: stage the full next state under the scratch key.
  await storage.set({ [EVICTION_SCRATCH_KEY]: nextArray });
  if (faultHook !== undefined) {
    await faultHook();
  }
  // Phase 2: commit to the primary key. captureOutbox.write is a single
  // atomic set of QUEUE_KEY — the key is never empty in between (it
  // still holds the original full queue right up to this write).
  await captureOutbox.write(nextArray, storage);
  // Phase 3: drop the now-redundant scratch.
  await storage.set({ [EVICTION_SCRATCH_KEY]: [] });
  return nextArray;
};

export const enqueueCapture = async (
  event: CaptureEvent,
  storage: StoragePort = chromeStoragePort,
  limit = QUEUE_LIMIT,
  intent: CaptureIntent = 'passive',
): Promise<EnqueueResult> => enqueueCaptureInternal(event, storage, limit, intent, undefined);

// Internal entry point with the eviction fault hook exposed for tests.
export const enqueueCaptureInternal = async (
  event: CaptureEvent,
  storage: StoragePort,
  limit: number,
  intent: CaptureIntent,
  evictionFaultHook: EvictionFaultHook,
): Promise<EnqueueResult> =>
  await withQueueLock(storage, async () => {
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
    const oldestPassiveIndex = current.findIndex((item) => item.payload.intent === 'passive');
    if (oldestPassiveIndex === -1) {
      return {
        accepted: false,
        reason: 'queue-full-explicit',
        queue: current.map(toQueuedCapture),
        evicted: 0,
      };
    }
    // Drop the oldest passive item and add the new explicit item in a
    // single crash-safe swap (no intermediate empty queue).
    const survivors = [
      ...current.slice(0, oldestPassiveIndex),
      ...current.slice(oldestPassiveIndex + 1),
    ];
    const newItem = mintItem({ intent, event });
    const nextArray = await evictAndEnqueueExplicit(
      storage,
      survivors,
      newItem,
      evictionFaultHook,
    );
    return {
      accepted: true,
      queue: nextArray.map(toQueuedCapture),
      evicted: 1,
    };
  });

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
): Promise<DrainResult> =>
  // Coalesce concurrent replayQueuedCaptures calls onto one in-flight
  // drain so two overlapping workboard polls don't each read the same
  // queue and double-send items. The drain then runs under the queue
  // mutex so its persist can't interleave with an enqueue/eviction
  // read-modify-write on the same key.
  await singleFlight(storage, () =>
    withQueueLock(storage, () => drainQueueInner(send, storage, now, random, opts)),
  );

const drainQueueInner = async (
  send: (event: CaptureEvent) => Promise<void>,
  storage: StoragePort,
  now: Date,
  random: () => number,
  opts: DrainOptions,
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
