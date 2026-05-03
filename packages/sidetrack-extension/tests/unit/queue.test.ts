import { describe, expect, it } from 'vitest';

import type { CaptureEvent } from '../../src/companion/model';
import {
  computeNextAttempt,
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

  it('computes deterministic exponential backoff with bounded jitter', () => {
    const now = new Date('2026-04-26T21:30:00.000Z');

    expect(computeNextAttempt(1, now, () => 0.5)).toBe('2026-04-26T21:30:02.000Z');
    expect(computeNextAttempt(2, now, () => 0.5)).toBe('2026-04-26T21:30:04.000Z');
    expect(computeNextAttempt(99, now, () => 0.5)).toBe('2026-04-26T21:35:00.000Z');
    expect(computeNextAttempt(1, now, () => 0)).toBe('2026-04-26T21:30:01.500Z');
    expect(computeNextAttempt(1, now, () => 1)).toBe('2026-04-26T21:30:02.500Z');
  });

  it('migrates legacy captures with retry state defaults', async () => {
    const storage = createMemoryStorage();
    await storage.set({
      'sidetrack.captureQueue': [
        {
          id: 'legacy',
          queuedAt: '2026-04-26T21:30:00.000Z',
          event: event('https://example.test/legacy'),
        },
      ],
    });

    expect(await readQueue(storage)).toMatchObject([
      {
        id: 'legacy',
        attempts: 0,
        nextAttemptAt: '2026-04-26T21:30:00.000Z',
      },
    ]);
  });

  it('drains due captures and backs off failed captures without retrying skipped captures', async () => {
    const storage = createMemoryStorage();
    await enqueueCapture(event('https://example.test/1'), storage);
    await enqueueCapture(event('https://example.test/2'), storage);
    await enqueueCapture(event('https://example.test/3'), storage);
    const queued = await readQueue(storage);
    await storage.set({
      'sidetrack.captureQueue': [
        {
          ...queued[0],
          nextAttemptAt: '2026-04-26T21:30:00.000Z',
        },
        {
          ...queued[1],
          nextAttemptAt: '2026-04-26T21:30:00.000Z',
        },
        {
          ...queued[2],
          nextAttemptAt: '2026-04-26T21:35:00.000Z',
        },
      ],
    });
    const sent: string[] = [];

    const result = await drainQueue(
      (capture) => {
        sent.push(capture.threadUrl);
        if (capture.threadUrl.endsWith('/2')) {
          return Promise.reject(new Error('companion offline'));
        }
        return Promise.resolve();
      },
      storage,
      new Date('2026-04-26T21:30:00.000Z'),
      () => 0.5,
    );

    expect(result).toEqual({ sent: 1, remaining: 2 });
    expect(sent).toEqual(['https://example.test/1', 'https://example.test/2']);
    expect(await readQueue(storage)).toMatchObject([
      {
        attempts: 1,
        nextAttemptAt: '2026-04-26T21:30:02.000Z',
        event: { threadUrl: 'https://example.test/2' },
      },
      {
        attempts: 0,
        nextAttemptAt: '2026-04-26T21:35:00.000Z',
        event: { threadUrl: 'https://example.test/3' },
      },
    ]);
  });

  it('drops captures after twelve failed attempts', async () => {
    const storage = createMemoryStorage();
    await enqueueCapture(event('https://example.test/drop'), storage);
    const [queued] = await readQueue(storage);
    await storage.set({
      'sidetrack.captureQueue': [
        { ...queued, attempts: 12, nextAttemptAt: '2026-04-26T21:30:00.000Z' },
      ],
    });

    const result = await drainQueue(
      () => Promise.reject(new Error('still offline')),
      storage,
      new Date('2026-04-26T21:30:00.000Z'),
      () => 0.5,
    );

    expect(result).toEqual({ sent: 0, remaining: 0 });
    expect(await readQueue(storage)).toEqual([]);
    expect(await readDroppedCount(storage)).toBe(1);
  });
});
