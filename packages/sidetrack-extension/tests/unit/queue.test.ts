import { describe, expect, it } from 'vitest';

import type { CaptureEvent } from '../../src/companion/model';
import {
  clearFailedCaptures,
  computeNextAttempt,
  drainQueue,
  enqueueCapture,
  readDroppedCount,
  readFailedCaptures,
  readQueue,
  retryFailedCaptures,
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

  describe('intent-tagged overflow', () => {
    it('passive captures keep drop-oldest semantics (back-compat)', async () => {
      const storage = createMemoryStorage();
      await enqueueCapture(event('https://e.test/1'), storage, 2, 'passive');
      await enqueueCapture(event('https://e.test/2'), storage, 2, 'passive');
      const r = await enqueueCapture(event('https://e.test/3'), storage, 2, 'passive');
      expect(r.accepted).toBe(true);
      expect(r.evicted).toBe(1);
      const queue = await readQueue(storage);
      expect(queue.every((q) => q.intent === 'passive')).toBe(true);
    });

    it('explicit capture evicts the oldest passive item when the queue is full of passives', async () => {
      const storage = createMemoryStorage();
      await enqueueCapture(event('https://e.test/p1'), storage, 2, 'passive');
      await enqueueCapture(event('https://e.test/p2'), storage, 2, 'passive');
      const r = await enqueueCapture(event('https://e.test/explicit'), storage, 2, 'explicit');
      expect(r.accepted).toBe(true);
      expect(r.evicted).toBe(1);
      const queue = await readQueue(storage);
      // The newest item is explicit; one passive remains.
      const explicitCount = queue.filter((q) => q.intent === 'explicit').length;
      const passiveCount = queue.filter((q) => q.intent === 'passive').length;
      expect(explicitCount).toBe(1);
      expect(passiveCount).toBe(1);
      // The oldest passive (p1) should have been evicted.
      expect(queue.map((q) => q.event.threadUrl)).not.toContain('https://e.test/p1');
    });

    it('rejects an explicit capture when the queue is fully explicit', async () => {
      const storage = createMemoryStorage();
      await enqueueCapture(event('https://e.test/x1'), storage, 2, 'explicit');
      await enqueueCapture(event('https://e.test/x2'), storage, 2, 'explicit');
      const r = await enqueueCapture(event('https://e.test/x3'), storage, 2, 'explicit');
      expect(r.accepted).toBe(false);
      expect(r.reason).toBe('queue-full-explicit');
      const queue = await readQueue(storage);
      // Original two explicit captures stay intact; the rejected
      // payload is NOT on the queue.
      expect(queue.map((q) => q.event.threadUrl)).toEqual([
        'https://e.test/x1',
        'https://e.test/x2',
      ]);
    });

    it('drainQueue still sends the wire CaptureEvent shape for both intents', async () => {
      const storage = createMemoryStorage();
      await enqueueCapture(event('https://e.test/p'), storage, 5, 'passive');
      await enqueueCapture(event('https://e.test/x'), storage, 5, 'explicit');
      const sent: string[] = [];
      const result = await drainQueue(
        async (e: CaptureEvent) => {
          sent.push(e.threadUrl);
        },
        storage,
        new Date('2030-01-01T00:00:00.000Z'),
        () => 0.5,
        { ignoreBackoff: true },
      );
      expect(result.sent).toBe(2);
      expect(sent.sort()).toEqual(['https://e.test/p', 'https://e.test/x']);
    });
  });

  describe('failed-queue persistence', () => {
    it('moves explicit captures into the failed queue after retry exhaustion', async () => {
      const storage = createMemoryStorage();
      await enqueueCapture(event('https://e.test/explicit-fail'), storage, 5, 'explicit');
      // Drive 13 drains so the same item exhausts its retry budget.
      // ignoreBackoff:true makes every drain attempt the item.
      for (let i = 0; i < 13; i += 1) {
        const baseTime = Date.parse('2026-04-26T21:30:00.000Z');
        await drainQueue(
          async () => {
            throw new Error('still offline');
          },
          storage,
          new Date(baseTime + i * 1000),
          () => 0.5,
          { ignoreBackoff: true },
        );
      }
      const queueAfter = await readQueue(storage);
      expect(queueAfter).toEqual([]);
      const failed = await readFailedCaptures(storage);
      expect(failed.length).toBe(1);
      expect(failed[0]?.event.threadUrl).toBe('https://e.test/explicit-fail');
      expect(failed[0]?.lastErrorMessage).toContain('still offline');
    });

    it('passive captures still drop silently — they do NOT land in the failed queue', async () => {
      const storage = createMemoryStorage();
      await enqueueCapture(event('https://e.test/passive-fail'), storage, 5, 'passive');
      for (let i = 0; i < 13; i += 1) {
        const baseTime = Date.parse('2026-04-26T21:30:00.000Z');
        await drainQueue(
          async () => {
            throw new Error('still offline');
          },
          storage,
          new Date(baseTime + i * 1000),
          () => 0.5,
          { ignoreBackoff: true },
        );
      }
      expect(await readQueue(storage)).toEqual([]);
      expect(await readFailedCaptures(storage)).toEqual([]);
      expect(await readDroppedCount(storage)).toBe(1);
    });

    it('retryFailedCaptures re-enqueues failed items as fresh explicit captures and clears the failed queue', async () => {
      const storage = createMemoryStorage();
      await enqueueCapture(event('https://e.test/retry'), storage, 5, 'explicit');
      for (let i = 0; i < 13; i += 1) {
        await drainQueue(
          async () => {
            throw new Error('offline');
          },
          storage,
          new Date(Date.parse('2026-04-26T21:30:00.000Z') + i * 1000),
          () => 0.5,
          { ignoreBackoff: true },
        );
      }
      expect((await readFailedCaptures(storage)).length).toBe(1);
      const result = await retryFailedCaptures(storage);
      expect(result.requeued).toBe(1);
      expect(await readFailedCaptures(storage)).toEqual([]);
      const queue = await readQueue(storage);
      expect(queue.length).toBe(1);
      expect(queue[0]?.intent).toBe('explicit');
    });

    it('clearFailedCaptures wipes the persisted list', async () => {
      const storage = createMemoryStorage();
      await enqueueCapture(event('https://e.test/clear'), storage, 5, 'explicit');
      for (let i = 0; i < 13; i += 1) {
        await drainQueue(
          async () => {
            throw new Error('offline');
          },
          storage,
          new Date(Date.parse('2026-04-26T21:30:00.000Z') + i * 1000),
          () => 0.5,
          { ignoreBackoff: true },
        );
      }
      expect((await readFailedCaptures(storage)).length).toBe(1);
      await clearFailedCaptures(storage);
      expect(await readFailedCaptures(storage)).toEqual([]);
    });
  });
});
