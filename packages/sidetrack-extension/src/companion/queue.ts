import type { CaptureEvent } from './model';

export interface QueuedCapture {
  readonly id: string;
  readonly queuedAt: string;
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

export const chromeStoragePort: StoragePort = {
  async get(key, fallback) {
    const result = await chrome.storage.local.get({ [key]: fallback });
    return result[key] as typeof fallback;
  },
  async set(values) {
    await chrome.storage.local.set(values);
  },
};

export const readQueue = async (
  storage: StoragePort = chromeStoragePort,
): Promise<readonly QueuedCapture[]> => await storage.get<readonly QueuedCapture[]>(QUEUE_KEY, []);

export const readDroppedCount = async (storage: StoragePort = chromeStoragePort): Promise<number> =>
  await storage.get<number>(DROPPED_KEY, 0);

export const clearQueue = async (storage: StoragePort = chromeStoragePort): Promise<void> => {
  await storage.set({ [QUEUE_KEY]: [] });
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

export const drainQueue = async (
  send: (event: CaptureEvent) => Promise<void>,
  storage: StoragePort = chromeStoragePort,
): Promise<DrainResult> => {
  const queue = await readQueue(storage);
  let sent = 0;

  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];

    try {
      await send(item.event);
      sent += 1;
    } catch {
      await storage.set({ [QUEUE_KEY]: queue.slice(index) });
      return { sent, remaining: queue.length - index };
    }
  }

  await clearQueue(storage);
  return { sent, remaining: 0 };
};
