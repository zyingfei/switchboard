import { describe, expect, it } from 'vitest';

import type { CaptureEvent } from '../../src/companion/model';
import {
  drainQueue,
  enqueueCapture,
  readDroppedCount,
  readQueue,
  type StoragePort,
} from '../../src/companion/queue';

const event = (threadUrl: string): CaptureEvent => ({
  provider: 'unknown',
  threadUrl,
  title: threadUrl,
  capturedAt: '2026-04-26T21:30:00.000Z',
  turns: [],
});

const createMemoryStorage = (): StoragePort & {
  readonly snapshot: () => Record<string, unknown>;
} => {
  const values = new Map<string, unknown>();
  return {
    get(key, fallback) {
      return Promise.resolve((values.has(key) ? values.get(key) : fallback) as typeof fallback);
    },
    set(nextValues) {
      Object.entries(nextValues).forEach(([key, value]) => {
        values.set(key, value);
      });
      return Promise.resolve();
    },
    snapshot() {
      return Object.fromEntries(values.entries());
    },
  };
};

describe('capture queue', () => {
  it('evicts oldest captures when the queue reaches its cap', async () => {
    const storage = createMemoryStorage();

    await enqueueCapture(event('https://example.test/1'), storage, 2);
    await enqueueCapture(event('https://example.test/2'), storage, 2);
    const result = await enqueueCapture(event('https://example.test/3'), storage, 2);

    expect(result.evicted).toBe(1);
    expect((await readQueue(storage)).map((item) => item.event.threadUrl)).toEqual([
      'https://example.test/2',
      'https://example.test/3',
    ]);
    expect(await readDroppedCount(storage)).toBe(1);
  });

  it('drains chronologically and preserves remaining captures after failure', async () => {
    const storage = createMemoryStorage();
    await enqueueCapture(event('https://example.test/1'), storage);
    await enqueueCapture(event('https://example.test/2'), storage);
    await enqueueCapture(event('https://example.test/3'), storage);
    const sent: string[] = [];

    const result = await drainQueue((capture) => {
      sent.push(capture.threadUrl);
      if (capture.threadUrl.endsWith('/2')) {
        return Promise.reject(new Error('companion offline'));
      }
      return Promise.resolve();
    }, storage);

    expect(result).toEqual({ sent: 1, remaining: 2 });
    expect(sent).toEqual(['https://example.test/1', 'https://example.test/2']);
    expect((await readQueue(storage)).map((item) => item.event.threadUrl)).toEqual([
      'https://example.test/2',
      'https://example.test/3',
    ]);
  });
});
