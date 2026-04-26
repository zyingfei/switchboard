import type { BridgeEvent } from '../shared/messages';

export interface QueuedCapture {
  readonly id: string;
  readonly queuedAt: string;
  readonly event: BridgeEvent;
}

export interface DrainResult {
  readonly sent: number;
  readonly remaining: number;
}

const QUEUE_KEY = 'bac.localBridge.queue';
const DROPPED_KEY = 'bac.localBridge.droppedCount';
export const QUEUE_LIMIT = 1_000;

const storageGet = async <TValue>(key: string, fallback: TValue): Promise<TValue> => {
  const result = await chrome.storage.local.get({ [key]: fallback });
  return result[key] as TValue;
};

const storageSet = async (values: Record<string, unknown>): Promise<void> => {
  await chrome.storage.local.set(values);
};

export const readQueue = async (): Promise<QueuedCapture[]> => await storageGet<QueuedCapture[]>(QUEUE_KEY, []);

export const readDroppedCount = async (): Promise<number> => await storageGet<number>(DROPPED_KEY, 0);

export const clearQueue = async (): Promise<void> => await storageSet({ [QUEUE_KEY]: [] });

export const enqueueCapture = async (
  event: BridgeEvent,
  limit = QUEUE_LIMIT,
): Promise<{ readonly queue: QueuedCapture[]; readonly evicted: number }> => {
  const current = await readQueue();
  const next = [
    ...current,
    {
      id: event.id,
      queuedAt: new Date().toISOString(),
      event,
    },
  ];
  const evicted = Math.max(0, next.length - limit);
  const kept = evicted > 0 ? next.slice(evicted) : next;
  if (evicted > 0) {
    await storageSet({ [DROPPED_KEY]: (await readDroppedCount()) + evicted });
  }
  await storageSet({ [QUEUE_KEY]: kept });
  return { queue: kept, evicted };
};

export const drainQueue = async (
  send: (event: BridgeEvent) => Promise<void>,
): Promise<DrainResult> => {
  const queue = await readQueue();
  let sent = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (!item) {
      continue;
    }
    try {
      await send(item.event);
      sent += 1;
    } catch {
      await storageSet({ [QUEUE_KEY]: queue.slice(index) });
      return { sent, remaining: queue.length - index };
    }
  }
  await clearQueue();
  return { sent, remaining: 0 };
};
