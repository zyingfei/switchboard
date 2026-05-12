import { describe, expect, it, vi } from 'vitest';

import type { EventLog } from '../sync/eventLog.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { getCachedUrlProjection, invalidateCachedUrlProjection } from './cachedProjection.js';

const buildEvent = (canonicalUrl: string, seq: number): AcceptedEvent => ({
  clientEventId: `evt-${String(seq)}`,
  dot: { replicaId: 'r', seq },
  deps: {},
  aggregateId: '2026-05-11',
  type: BROWSER_TIMELINE_OBSERVED,
  payload: {
    eventId: `evt-${String(seq)}`,
    observedAt: `2026-05-11T00:00:0${String(seq)}.000Z`,
    url: canonicalUrl,
    canonicalUrl,
    transition: 'activated',
  },
  acceptedAtMs: 1_700_000_000_000 + seq * 1000,
});

const fakeEventLog = (events: AcceptedEvent[]): EventLog & { readCount: number } => {
  const wrapper = {
    readCount: 0,
    readMerged: vi.fn(async () => {
      wrapper.readCount += 1;
      return [...events];
    }),
  };
  return wrapper as unknown as EventLog & { readCount: number };
};

describe('getCachedUrlProjection', () => {
  it('serves a fresh projection on first call', async () => {
    const log = fakeEventLog([buildEvent('https://x/a', 1)]);
    const projection = await getCachedUrlProjection(log);
    expect(projection.byCanonicalUrl.has('https://x/a')).toBe(true);
    expect(log.readCount).toBe(1);
  });

  it('serves cached projection for repeat calls within TTL', async () => {
    const log = fakeEventLog([buildEvent('https://x/a', 1)]);
    await getCachedUrlProjection(log);
    await getCachedUrlProjection(log);
    await getCachedUrlProjection(log);
    // Three calls in quick succession; only one underlying read.
    expect(log.readCount).toBe(1);
  });

  it('coalesces concurrent rebuilds via single-flight', async () => {
    // Slow readMerged so the second caller arrives while the first is in
    // flight.
    let resolveRead: ((events: AcceptedEvent[]) => void) | null = null;
    const slowLog = {
      readMerged: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      ),
    } as unknown as EventLog;

    const firstPromise = getCachedUrlProjection(slowLog);
    const secondPromise = getCachedUrlProjection(slowLog);
    expect(slowLog.readMerged).toHaveBeenCalledTimes(1);
    (resolveRead as unknown as (e: AcceptedEvent[]) => void)([
      buildEvent('https://x/a', 1),
    ]);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toBe(second);
  });

  it('rebuilds after explicit invalidation', async () => {
    const log = fakeEventLog([buildEvent('https://x/a', 1)]);
    await getCachedUrlProjection(log);
    expect(log.readCount).toBe(1);
    invalidateCachedUrlProjection(log);
    await getCachedUrlProjection(log);
    expect(log.readCount).toBe(2);
  });

  it('isolates caches per EventLog instance (WeakMap-keyed)', async () => {
    const logA = fakeEventLog([buildEvent('https://x/a', 1)]);
    const logB = fakeEventLog([buildEvent('https://y/b', 2)]);
    const projA = await getCachedUrlProjection(logA);
    const projB = await getCachedUrlProjection(logB);
    expect(projA.byCanonicalUrl.has('https://x/a')).toBe(true);
    expect(projA.byCanonicalUrl.has('https://y/b')).toBe(false);
    expect(projB.byCanonicalUrl.has('https://y/b')).toBe(true);
    expect(projB.byCanonicalUrl.has('https://x/a')).toBe(false);
    expect(logA.readCount).toBe(1);
    expect(logB.readCount).toBe(1);
  });

  it('rebuilds after TTL elapses', async () => {
    const log = fakeEventLog([buildEvent('https://x/a', 1)]);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_700_000_000_000));
      await getCachedUrlProjection(log);
      // Advance past the 500 ms TTL.
      vi.setSystemTime(new Date(1_700_000_000_000 + 600));
      await getCachedUrlProjection(log);
      expect(log.readCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
