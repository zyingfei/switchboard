import type { CaptureEvent } from './model';

export interface QueuedCapture {
  readonly id: string;
  readonly queuedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly event: CaptureEvent;
}

export interface DrainResult {
  readonly sent: number;
  readonly remaining: number;
}

export interface StoragePort {
  readonly get: <TValue>(key: string, fallback: TValue) => Promise<TValue>;
  readonly set: (values: Record<string, unknown>) => Promise<void>;
}

const QUEUE_KEY = 'sidetrack.captureQueue';
const DROPPED_KEY = 'sidetrack.captureQueue.droppedCount';
export const QUEUE_LIMIT = 1_000;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;
const JITTER_RATIO = 0.25;
const MAX_ATTEMPTS = 12;

export const chromeStoragePort: StoragePort = {
  async get(key, fallback) {
    const result = await chrome.storage.local.get({ [key]: fallback });
    return result[key] as typeof fallback;
  },
  async set(values) {
    await chrome.storage.local.set(values);
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const migrateQueuedCapture = (value: unknown): QueuedCapture | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.queuedAt !== 'string') {
    return null;
  }
  const eventValue = value.event;
  if (!isRecord(eventValue)) {
    return null;
  }
  const attempts = typeof value.attempts === 'number' && Number.isFinite(value.attempts)
    ? Math.max(0, Math.floor(value.attempts))
    : 0;
  const nextAttemptAt =
    typeof value.nextAttemptAt === 'string' && value.nextAttemptAt.length > 0
      ? value.nextAttemptAt
      : value.queuedAt;
  return {
    id: value.id,
    queuedAt: value.queuedAt,
    attempts,
    nextAttemptAt,
    event: eventValue as unknown as CaptureEvent,
  };
};

export const readQueue = async (
  storage: StoragePort = chromeStoragePort,
): Promise<readonly QueuedCapture[]> => {
  const raw = await storage.get<readonly unknown[]>(QUEUE_KEY, []);
  return raw.map(migrateQueuedCapture).filter((item): item is QueuedCapture => item !== null);
};

export const readDroppedCount = async (storage: StoragePort = chromeStoragePort): Promise<number> =>
  await storage.get<number>(DROPPED_KEY, 0);

export const clearQueue = async (storage: StoragePort = chromeStoragePort): Promise<void> => {
  await storage.set({ [QUEUE_KEY]: [] });
};

export const computeNextAttempt = (
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): string => {
  const clampedAttempts = Math.max(0, Math.floor(attempts));
  const exponential = BASE_BACKOFF_MS * 2 ** Math.max(0, clampedAttempts - 1);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  const jitter = 1 + (random() * 2 - 1) * JITTER_RATIO;
  return new Date(now.getTime() + Math.round(capped * jitter)).toISOString();
};

export const enqueueCapture = async (
  event: CaptureEvent,
  storage: StoragePort = chromeStoragePort,
  limit = QUEUE_LIMIT,
): Promise<{ readonly queue: readonly QueuedCapture[]; readonly evicted: number }> => {
  const current = await readQueue(storage);
  const next = [
    ...current,
    {
      id: crypto.randomUUID(),
      queuedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
      event,
    },
  ];
  const evicted = Math.max(0, next.length - limit);
  const kept = evicted > 0 ? next.slice(evicted) : next;
  if (evicted > 0) {
    await storage.set({ [DROPPED_KEY]: (await readDroppedCount(storage)) + evicted });
  }
  await storage.set({ [QUEUE_KEY]: kept });
  return { queue: kept, evicted };
};

export interface DrainOptions {
  // When true, treat every queued item as eligible regardless of its
  // backoff state. Use this on user-initiated reconnect paths where the
  // backoff is moot (we have a fresh, positive signal that companion is
  // up). Automatic / scheduled drains should leave this false so the
  // backoff respects the prior failure history.
  readonly ignoreBackoff?: boolean;
}

export const drainQueue = async (
  send: (event: CaptureEvent) => Promise<void>,
  storage: StoragePort = chromeStoragePort,
  now: Date = new Date(),
  random: () => number = Math.random,
  opts: DrainOptions = {},
): Promise<DrainResult> => {
  const queue = await readQueue(storage);
  let sent = 0;
  let dropped = 0;
  let changed = false;
  const nextQueue: QueuedCapture[] = [];

  for (const item of queue) {
    if (opts.ignoreBackoff !== true && Date.parse(item.nextAttemptAt) > now.getTime()) {
      nextQueue.push(item);
      continue;
    }

    try {
      await send(item.event);
      sent += 1;
      changed = true;
    } catch {
      const attempts = item.attempts + 1;
      changed = true;
      if (attempts > MAX_ATTEMPTS) {
        dropped += 1;
      } else {
        nextQueue.push({
          ...item,
          attempts,
          nextAttemptAt: computeNextAttempt(attempts, now, random),
        });
      }
    }
  }

  if (dropped > 0) {
    await storage.set({ [DROPPED_KEY]: (await readDroppedCount(storage)) + dropped });
  }
  if (changed) {
    await storage.set({ [QUEUE_KEY]: nextQueue });
  }
  return { sent, remaining: nextQueue.length };
};
