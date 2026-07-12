import { describe, expect, it } from 'vitest';

import type { CaptureEvent } from '../../src/companion/model';
import {
  drainQueue,
  enqueueCapture,
  enqueueCaptureInternal,
  readFailedCaptures,
  readQueue,
  retryFailedCaptures,
  type StoragePort,
} from '../../src/companion/queue';
import { singleFlight, withQueueLock } from '../../src/companion/captureQueueMutex';

const event = (threadUrl: string): CaptureEvent => ({
  provider: 'unknown',
  threadUrl,
  title: threadUrl,
  capturedAt: '2026-04-26T21:30:00.000Z',
  turns: [],
});

// Memory storage with an optional per-key set() gate so a test can
// suspend a write mid-flight and force an interleaving. `snapshot`
// exposes the raw stored values for assertions.
interface ControllableStorage extends StoragePort {
  readonly snapshot: () => Record<string, unknown>;
  readonly raw: (key: string) => unknown;
}

const createMemoryStorage = (): ControllableStorage => {
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
    raw(key) {
      return values.get(key);
    },
  };
};

const deferred = <T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const QUEUE_KEY = 'sidetrack.captureQueue';
const SCRATCH_KEY = 'sidetrack.captureQueue.evicting';

describe('capture queue atomicity (F12)', () => {
  it('a write that lands in the queue key while a drain awaits the network is not clobbered by the end-of-drain persist', async () => {
    // Requirement (b): the end-of-drain persist merges per-item against
    // a FRESH read, so an item that appeared in the queue key after the
    // drain's pre-send snapshot survives. This is the belt-and-suspenders
    // guard for any writer that reaches the key concurrently (a second
    // SW context, or a mutex-bypassing path); the mutex alone would
    // serialize an in-process enqueue, but the merge is what makes the
    // persist itself safe against a concurrent write.
    const storage = createMemoryStorage();
    await enqueueCapture(event('https://e.test/to-send'), storage, 10, 'passive');

    let injected = false;
    const drainResult = await drainQueue(
      async () => {
        // Simulate a concurrent writer landing a fresh item into the
        // queue key DURING the send await — after the drain read its
        // pre-send snapshot.
        if (!injected) {
          injected = true;
          const current = (await storage.get<unknown[]>(QUEUE_KEY, [])) as unknown[];
          await storage.set({
            [QUEUE_KEY]: [
              ...current,
              {
                id: crypto.randomUUID(),
                queuedAt: '2030-01-01T00:00:00.000Z',
                attempts: 0,
                nextAttemptAt: '2030-01-01T00:00:00.000Z',
                payload: { intent: 'passive', event: event('https://e.test/raced-in') },
              },
            ],
          });
        }
      },
      storage,
      new Date('2030-01-01T00:00:00.000Z'),
      () => 0.5,
      { ignoreBackoff: true },
    );

    expect(drainResult.sent).toBe(1);
    const remaining = (await readQueue(storage)).map((q) => q.event.threadUrl);
    // The sent item is gone; the concurrently-written item survived the
    // persist instead of being overwritten by the pre-drain snapshot.
    expect(remaining).toContain('https://e.test/raced-in');
    expect(remaining).not.toContain('https://e.test/to-send');
  });

  it('eviction interrupted between staging and commit loses no survivor', async () => {
    const storage = createMemoryStorage();
    // Fill a cap-2 queue with two passive items.
    await enqueueCapture(event('https://e.test/p1'), storage, 2, 'passive');
    await enqueueCapture(event('https://e.test/p2'), storage, 2, 'passive');

    // Explicit capture at capacity triggers eviction. Throw in the gap
    // between "stage to scratch" and "commit to primary" — the window
    // that used to leave the primary key empty.
    await expect(
      enqueueCaptureInternal(event('https://e.test/explicit'), storage, 2, 'explicit', () => {
        throw new Error('service worker terminated mid-eviction');
      }),
    ).rejects.toThrow('service worker terminated mid-eviction');

    // The primary key was never emptied: both original passives remain.
    const rawQueue = storage.raw(QUEUE_KEY) as { payload: { event: CaptureEvent } }[];
    const urls = rawQueue.map((i) => i.payload.event.threadUrl);
    expect(urls).toContain('https://e.test/p1');
    expect(urls).toContain('https://e.test/p2');
    expect(urls).toHaveLength(2);

    // A pure read never mutates storage, so the (inert) leftover scratch
    // is still present after readQueue — but the two survivors read back
    // verbatim regardless (the scratch is never consulted for recovery).
    const readBack = (await readQueue(storage)).map((q) => q.event.threadUrl);
    expect(readBack.sort()).toEqual(['https://e.test/p1', 'https://e.test/p2']);
    expect(storage.raw(SCRATCH_KEY)).toEqual([
      // survivor p2 + the not-yet-committed explicit item (staged then
      // abandoned by the crash; p1 was the intended evictee).
      expect.objectContaining({ payload: expect.objectContaining({ intent: 'passive' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ intent: 'explicit' }) }),
    ]);

    // The leftover scratch is reconciled on the next LOCK-HELD write, not
    // on a read: a subsequent enqueue clears it while it holds the queue
    // lock, so eviction-scratch cleanup can never race an in-flight
    // eviction's staging write.
    await enqueueCapture(event('https://e.test/next'), storage, 5, 'passive');
    expect(storage.raw(SCRATCH_KEY)).toEqual([]);
  });

  it('concurrent drain calls coalesce into a single drain (each item sent once)', async () => {
    const storage = createMemoryStorage();
    await enqueueCapture(event('https://e.test/a'), storage, 10, 'passive');
    await enqueueCapture(event('https://e.test/b'), storage, 10, 'passive');

    const sent: string[] = [];
    // Each send yields to the microtask queue so the second drain call
    // (fired in the same tick, before the first resolves) has a live
    // in-flight drain to coalesce onto.
    const send = async (e: CaptureEvent): Promise<void> => {
      sent.push(e.threadUrl);
      await Promise.resolve();
    };

    const drainA = drainQueue(send, storage, new Date('2030-01-01T00:00:00.000Z'), () => 0.5, {
      ignoreBackoff: true,
    });
    // Fire the second drain synchronously (same tick) so it coalesces
    // onto the in-flight drainA promise rather than starting its own.
    const drainB = drainQueue(send, storage, new Date('2030-01-01T00:00:00.000Z'), () => 0.5, {
      ignoreBackoff: true,
    });

    const [resultA, resultB] = await Promise.all([drainA, drainB]);

    // Both callers observe the same coalesced drain result.
    expect(resultA).toEqual(resultB);
    // Each queued item was sent exactly once despite two drain calls.
    expect(sent.sort()).toEqual(['https://e.test/a', 'https://e.test/b']);
    expect(await readQueue(storage)).toEqual([]);
  });

  it('full-queue explicit capture preserves the newest explicit item (evicting one passive)', async () => {
    const storage = createMemoryStorage();
    await enqueueCapture(event('https://e.test/p1'), storage, 2, 'passive');
    await enqueueCapture(event('https://e.test/p2'), storage, 2, 'passive');

    const result = await enqueueCapture(event('https://e.test/newest'), storage, 2, 'explicit');
    expect(result.accepted).toBe(true);
    expect(result.evicted).toBe(1);

    const queue = await readQueue(storage);
    expect(queue).toHaveLength(2);
    // The newest explicit item is present and is the tail.
    expect(queue[queue.length - 1]?.event.threadUrl).toBe('https://e.test/newest');
    expect(queue[queue.length - 1]?.intent).toBe('explicit');
    // The oldest passive was the one evicted.
    expect(queue.map((q) => q.event.threadUrl)).not.toContain('https://e.test/p1');
    expect(queue.map((q) => q.event.threadUrl)).toContain('https://e.test/p2');
    expect(storage.raw(SCRATCH_KEY)).toEqual([]);
  });

  it('an explicit capture is never lost across an eviction crash on the newest item', async () => {
    // Companion of the "loses at most the intended evictees" invariant:
    // with a fully-passive queue at cap, an interrupted eviction leaves
    // every passive survivor in place (zero unintended loss).
    const storage = createMemoryStorage();
    for (let i = 0; i < 5; i += 1) {
      await enqueueCapture(event(`https://e.test/fill-${String(i)}`), storage, 5, 'passive');
    }
    await expect(
      enqueueCaptureInternal(event('https://e.test/x'), storage, 5, 'explicit', () => {
        throw new Error('crash');
      }),
    ).rejects.toThrow('crash');
    const readBack = (await readQueue(storage)).map((q) => q.event.threadUrl).sort();
    expect(readBack).toEqual([
      'https://e.test/fill-0',
      'https://e.test/fill-1',
      'https://e.test/fill-2',
      'https://e.test/fill-3',
      'https://e.test/fill-4',
    ]);
  });
});

describe('drain-lock starvation (F12 regression)', () => {
  it('an enqueue issued while a slow multi-item drain is in flight is persisted without waiting for the whole drain', async () => {
    // The drain must NOT hold the queue lock across its network sends.
    // We park the drain on a gate mid-flight and fire a concurrent
    // enqueue; the enqueue must resolve AND land in storage BEFORE the
    // drain is allowed to finish. Under the old whole-drain lock the
    // enqueue could not even begin until the entire multi-item backlog
    // drained.
    const storage = createMemoryStorage();
    // Two passive items to drain; the first send parks on a gate.
    await enqueueCapture(event('https://e.test/drain-1'), storage, 100, 'passive');
    await enqueueCapture(event('https://e.test/drain-2'), storage, 100, 'passive');

    const firstSendReached = deferred();
    const releaseFirstSend = deferred();
    let sends = 0;
    const drainPromise = drainQueue(
      async () => {
        sends += 1;
        if (sends === 1) {
          firstSendReached.resolve();
          // Park the drain here, holding no queue lock, simulating a
          // slow network send. Enqueues fired now must not block on us.
          await releaseFirstSend.promise;
        }
      },
      storage,
      new Date('2030-01-01T00:00:00.000Z'),
      () => 0.5,
      { ignoreBackoff: true },
    );

    // Wait until the drain is parked in its first send.
    await firstSendReached.promise;

    // Fire an explicit enqueue WHILE the drain is parked. This must
    // resolve without waiting for releaseFirstSend — bounded latency.
    const enqueueResult = await enqueueCapture(
      event('https://e.test/enqueued-mid-drain'),
      storage,
      100,
      'explicit',
    );
    expect(enqueueResult.accepted).toBe(true);

    // The enqueued item is durably in storage BEFORE the drain finishes.
    const midDrain = (await readQueue(storage)).map((q) => q.event.threadUrl);
    expect(midDrain).toContain('https://e.test/enqueued-mid-drain');

    // Now let the drain complete and confirm the enqueued item survived
    // the end-of-drain persist (atomic merge, not a stale rewrite).
    releaseFirstSend.resolve();
    const drainResult = await drainPromise;
    expect(drainResult.sent).toBe(2);
    const after = (await readQueue(storage)).map((q) => q.event.threadUrl);
    expect(after).toContain('https://e.test/enqueued-mid-drain');
    expect(after).not.toContain('https://e.test/drain-1');
    expect(after).not.toContain('https://e.test/drain-2');
  });

  it('an SW death (abandoned send) mid-drain does not lose a concurrently enqueued explicit capture', async () => {
    // Model the MV3 idle-kill: the drain awaits a send that never
    // resolves (the SW is torn down). A user + Capture fired during that
    // window must be persisted to the queue regardless — under the old
    // whole-drain lock the enqueue would be stuck behind the dead drain
    // and the explicit capture would be silently lost.
    const storage = createMemoryStorage();
    await enqueueCapture(event('https://e.test/drain-a'), storage, 100, 'passive');

    const sendReached = deferred();
    const neverResolves = deferred();
    // Fire the drain but never await it — its send hangs forever,
    // standing in for the killed service worker.
    void drainQueue(
      async () => {
        sendReached.resolve();
        await neverResolves.promise;
      },
      storage,
      new Date('2030-01-01T00:00:00.000Z'),
      () => 0.5,
      { ignoreBackoff: true },
    );

    await sendReached.promise;

    // The concurrent explicit enqueue must complete (not deadlock behind
    // the hung drain) and persist the capture.
    const result = await Promise.race([
      enqueueCapture(event('https://e.test/explicit-during-death'), storage, 100, 'explicit'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('enqueue blocked behind hung drain')), 1_000),
      ),
    ]);
    expect(result.accepted).toBe(true);

    const persisted = (await readQueue(storage)).map((q) => q.event.threadUrl);
    expect(persisted).toContain('https://e.test/explicit-during-death');
    // The un-sent drain item is still queued too (its send never
    // completed, so the persist for that item never ran).
    expect(persisted).toContain('https://e.test/drain-a');
  });

  it('concurrent drains still coalesce to a single drain despite the lock-free sends', async () => {
    // Re-assert the single-flight property under the new model: the queue
    // lock no longer wraps the whole drain, but singleFlight still
    // coalesces two overlapping drain calls onto one in-flight run so no
    // item is double-sent.
    const storage = createMemoryStorage();
    await enqueueCapture(event('https://e.test/c1'), storage, 100, 'passive');
    await enqueueCapture(event('https://e.test/c2'), storage, 100, 'passive');

    const sent: string[] = [];
    const send = async (e: CaptureEvent): Promise<void> => {
      sent.push(e.threadUrl);
      await Promise.resolve();
    };

    const drainA = drainQueue(send, storage, new Date('2030-01-01T00:00:00.000Z'), () => 0.5, {
      ignoreBackoff: true,
    });
    const drainB = drainQueue(send, storage, new Date('2030-01-01T00:00:00.000Z'), () => 0.5, {
      ignoreBackoff: true,
    });

    const [resultA, resultB] = await Promise.all([drainA, drainB]);
    expect(resultA).toEqual(resultB);
    // Each item sent exactly once despite two concurrent drain calls.
    expect(sent.sort()).toEqual(['https://e.test/c1', 'https://e.test/c2']);
    expect(await readQueue(storage)).toEqual([]);
  });

  it('an eviction cannot interleave into the drain persist (both serialize on the queue lock)', async () => {
    // The lock-free sends must NOT weaken the invariant that the drain's
    // terminal persist and an eviction's crash-safe swap are mutually
    // exclusive. We park a drain's send, fire an at-capacity explicit
    // enqueue that must evict a passive, and confirm the final state is
    // consistent (the evicting explicit item and the drain's merge both
    // land; no survivor is lost).
    const storage = createMemoryStorage();
    // Cap-3 queue full of passives; one will be drained, the others stay.
    await enqueueCapture(event('https://e.test/e1'), storage, 3, 'passive');
    await enqueueCapture(event('https://e.test/e2'), storage, 3, 'passive');
    await enqueueCapture(event('https://e.test/e3'), storage, 3, 'passive');

    const sendReached = deferred();
    const releaseSend = deferred();
    let sends = 0;
    const drainPromise = drainQueue(
      async () => {
        sends += 1;
        if (sends === 1) {
          sendReached.resolve();
          await releaseSend.promise;
        }
      },
      storage,
      new Date('2030-01-01T00:00:00.000Z'),
      () => 0.5,
      { ignoreBackoff: true },
    );
    await sendReached.promise;

    // At capacity → explicit enqueue evicts the oldest passive. This runs
    // under withQueueLock while the drain is parked (lock-free) in send.
    const evictResult = await enqueueCapture(event('https://e.test/explicit'), storage, 3, 'explicit');
    expect(evictResult.accepted).toBe(true);
    expect(evictResult.evicted).toBe(1);

    releaseSend.resolve();
    await drainPromise;

    const final = (await readQueue(storage)).map((q) => q.event.threadUrl).sort();
    // The explicit item persisted; the drained items are gone; the scratch
    // is clean (no leftover from a torn eviction).
    expect(final).toContain('https://e.test/explicit');
    expect(storage.raw(SCRATCH_KEY)).toEqual([]);
    // No duplicate of the explicit item; queue length is bounded.
    expect(final.filter((u) => u === 'https://e.test/explicit')).toHaveLength(1);
  });
});

// Seed a FailedCapture directly into FAILED_KEY so tests don't need 13
// drain loops just to get an item into the failed list.
const FAILED_KEY = 'sidetrack.captureQueue.failed';
const seedFailedCapture = async (
  storage: StoragePort,
  threadUrl: string,
): Promise<void> => {
  const current = (await storage.get<unknown[]>(FAILED_KEY, [])) as unknown[];
  await storage.set({
    [FAILED_KEY]: [
      ...current,
      {
        id: crypto.randomUUID(),
        queuedAt: '2026-01-01T00:00:00.000Z',
        failedAt: '2026-01-01T00:00:00.000Z',
        event: event(threadUrl),
        lastErrorMessage: 'offline',
      },
    ],
  });
};

// Seed a capture item in the CORRECT internal storage format so that
// intent: 'explicit' survives the queue.ts migration round-trip.
const QUEUE_KEY_INTERNAL = 'sidetrack.captureQueue';
const seedQueueItem = async (
  storage: StoragePort,
  threadUrl: string,
  attempts: number,
  intent: 'explicit' | 'passive' = 'explicit',
): Promise<void> => {
  const current = (await storage.get<unknown[]>(QUEUE_KEY_INTERNAL, [])) as unknown[];
  await storage.set({
    [QUEUE_KEY_INTERNAL]: [
      ...current,
      {
        id: crypto.randomUUID(),
        queuedAt: '2026-01-01T00:00:00.000Z',
        attempts,
        nextAttemptAt: '2026-01-01T00:00:00.000Z',
        payload: { intent, event: event(threadUrl) },
      },
    ],
  });
};

describe('FAILED_KEY concurrent safety (F12-residual)', () => {
  it('concurrent retryFailedCaptures and drainQueue do not lose failed entries', async () => {
    // Scenario: retryFailedCaptures reads, clears, and re-enqueues while a
    // concurrent drain that produces newly-failed items tries to append to
    // FAILED_KEY. Without withFailedLock the two operations race on a
    // read-modify-write of the same key and one side's update is lost.
    //
    // The test verifies that: after both settle, each operation's intended
    // FAILED_KEY outcome is preserved — re-enqueued items are gone from
    // the failed list (they moved back into the main queue), and any item
    // that fails during the concurrent drain lands in FAILED_KEY.
    const storage = createMemoryStorage();

    // Seed FAILED_KEY directly: one pre-existing failed capture.
    await seedFailedCapture(storage, 'https://e.test/pre-existing');
    // Seed the main queue with an at-budget explicit item so the
    // concurrent drain produces a newly-failed entry to merge.
    await seedQueueItem(storage, 'https://e.test/drain-fail', 12, 'explicit');

    // Run retry and a failing drain concurrently (same tick so they
    // interleave at every await boundary).
    const retryPromise = retryFailedCaptures(storage);
    const drainPromise = drainQueue(
      async () => {
        throw new Error('still-offline');
      },
      storage,
      new Date('2030-01-01T00:00:00.000Z'),
      () => 0.5,
      { ignoreBackoff: true },
    );

    const [retryResult] = await Promise.all([retryPromise, drainPromise]);

    // The pre-existing failed item was re-enqueued.
    expect(retryResult.requeued).toBe(1);

    // The item that the drain failed (after exhausting its budget) must
    // appear in FAILED_KEY — it must not have been clobbered by retry's
    // clear, and retry's re-enqueue must not have been clobbered by the
    // drain's failed-write.
    const failed = await readFailedCaptures(storage);
    const failedUrls = failed.map((f) => f.event.threadUrl);
    expect(failedUrls).toContain('https://e.test/drain-fail');
    // The pre-existing item was re-enqueued, not left in failed list.
    expect(failedUrls).not.toContain('https://e.test/pre-existing');
  });

  it('retryFailedCaptures then drain-that-fails correctly populates FAILED_KEY', async () => {
    // Verifies sequential (non-concurrent) correctness: retry clears the
    // failed list, subsequent drain exhausts an item, withFailedLock
    // ensures the write lands without being lost.
    const storage = createMemoryStorage();

    // Seed a failed capture and an at-budget queue item.
    await seedFailedCapture(storage, 'https://e.test/retry-then-fail');
    await seedQueueItem(storage, 'https://e.test/queue-item', 12, 'explicit');

    const retryResult = await retryFailedCaptures(storage);
    expect(retryResult.requeued).toBe(1);
    // Failed list cleared by retry.
    expect(await readFailedCaptures(storage)).toEqual([]);

    // Now drain — the at-budget item exhausts and must land in FAILED_KEY.
    await drainQueue(
      async () => {
        throw new Error('offline');
      },
      storage,
      new Date('2030-01-01T00:00:00.000Z'),
      () => 0.5,
      { ignoreBackoff: true },
    );

    const failed = await readFailedCaptures(storage);
    // At-budget drain-fail item must be in FAILED_KEY (not silently dropped).
    expect(failed.length).toBeGreaterThanOrEqual(1);
    const failedUrls = failed.map((f) => f.event.threadUrl);
    expect(failedUrls).toContain('https://e.test/queue-item');
  });

  it('sequential retry then drain leaves failed queue in a consistent state', async () => {
    const storage = createMemoryStorage();
    // No failed items: retry is a no-op, drain should not corrupt state.
    const retryResult = await retryFailedCaptures(storage);
    expect(retryResult.requeued).toBe(0);

    await enqueueCapture(event('https://e.test/seq'), storage, 5, 'passive');
    const drainResult = await drainQueue(
      async () => {
        /* success */
      },
      storage,
      new Date('2030-01-01T00:00:00.000Z'),
      () => 0.5,
      { ignoreBackoff: true },
    );
    expect(drainResult.sent).toBe(1);
    expect(await readFailedCaptures(storage)).toEqual([]);
  });
});

describe('capture queue mutex primitives', () => {
  it('withQueueLock serializes tasks in call order on the same key', async () => {
    const key = {};
    const order: number[] = [];
    const gate = deferred();

    const first = withQueueLock(key, async () => {
      await gate.promise;
      order.push(1);
    });
    const second = withQueueLock(key, async () => {
      order.push(2);
    });

    // `second` must not run until `first` completes even though `first`
    // is blocked on the gate.
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it('withQueueLock does not wedge the chain when a task rejects', async () => {
    const key = {};
    await expect(
      withQueueLock(key, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    // The next task on the same key still runs.
    const ran = await withQueueLock(key, () => Promise.resolve('ok'));
    expect(ran).toBe('ok');
  });

  it('withQueueLock keys independently — different keys run concurrently', async () => {
    const keyA = {};
    const keyB = {};
    const gate = deferred();
    const order: string[] = [];

    const a = withQueueLock(keyA, async () => {
      await gate.promise;
      order.push('a');
    });
    const b = withQueueLock(keyB, async () => {
      order.push('b');
    });

    // keyB is not blocked by keyA's gate.
    await b;
    expect(order).toEqual(['b']);
    gate.resolve();
    await a;
    expect(order).toEqual(['b', 'a']);
  });

  it('singleFlight coalesces concurrent calls and re-runs after settle', async () => {
    const key = {};
    let calls = 0;
    const gate = deferred();

    const task = async () => {
      calls += 1;
      await gate.promise;
      return calls;
    };

    const p1 = singleFlight(key, task);
    const p2 = singleFlight(key, task);
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(1);
    expect(calls).toBe(1);

    // After the in-flight run settles a fresh call starts a new run.
    const p3 = await singleFlight(key, () => Promise.resolve(calls + 1));
    expect(p3).toBe(2);
  });
});
