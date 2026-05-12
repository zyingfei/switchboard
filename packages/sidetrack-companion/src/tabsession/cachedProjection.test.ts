import { describe, expect, it, vi } from 'vitest';

import type { EventLog } from '../sync/eventLog.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  getCachedTabSessionProjection,
  invalidateCachedTabSessionProjection,
} from './cachedProjection.js';

const buildTimelineEvent = (tabSessionId: string, seq: number): AcceptedEvent => ({
  clientEventId: `evt-${String(seq)}`,
  dot: { replicaId: 'r', seq },
  deps: {},
  aggregateId: '2026-05-12',
  type: BROWSER_TIMELINE_OBSERVED,
  payload: {
    eventId: `evt-${String(seq)}`,
    observedAt: `2026-05-12T00:00:0${String(seq)}.000Z`,
    url: `https://example.com/${tabSessionId}`,
    canonicalUrl: `https://example.com/${tabSessionId}`,
    transition: 'activated',
    tabSessionId,
    tabIdHash: `tabhash-${tabSessionId}`,
    windowIdHash: 'winhash',
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

describe('getCachedTabSessionProjection', () => {
  it('serves a fresh projection on first call', async () => {
    const log = fakeEventLog([buildTimelineEvent('tses_a', 1)]);
    const projection = await getCachedTabSessionProjection(log);
    expect(projection.bySessionId.has('tses_a')).toBe(true);
    expect(log.readCount).toBe(1);
  });

  it('coalesces concurrent rebuilds via single-flight', async () => {
    let resolveRead: ((events: AcceptedEvent[]) => void) | null = null;
    const slowLog = {
      readMerged: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRead = resolve;
          }),
      ),
    } as unknown as EventLog;

    const firstPromise = getCachedTabSessionProjection(slowLog);
    const secondPromise = getCachedTabSessionProjection(slowLog);
    expect(slowLog.readMerged).toHaveBeenCalledTimes(1);
    (resolveRead as unknown as (e: AcceptedEvent[]) => void)([
      buildTimelineEvent('tses_a', 1),
    ]);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toBe(second);
  });

  it('rebuilds after explicit invalidation', async () => {
    const log = fakeEventLog([buildTimelineEvent('tses_a', 1)]);
    await getCachedTabSessionProjection(log);
    expect(log.readCount).toBe(1);
    invalidateCachedTabSessionProjection(log);
    await getCachedTabSessionProjection(log);
    expect(log.readCount).toBe(2);
  });

  it('isolates caches per EventLog instance (WeakMap-keyed)', async () => {
    const logA = fakeEventLog([buildTimelineEvent('tses_a', 1)]);
    const logB = fakeEventLog([buildTimelineEvent('tses_b', 2)]);
    const projA = await getCachedTabSessionProjection(logA);
    const projB = await getCachedTabSessionProjection(logB);
    expect(projA.bySessionId.has('tses_a')).toBe(true);
    expect(projA.bySessionId.has('tses_b')).toBe(false);
    expect(projB.bySessionId.has('tses_b')).toBe(true);
    expect(projB.bySessionId.has('tses_a')).toBe(false);
  });

  it('rebuilds after TTL elapses', async () => {
    const log = fakeEventLog([buildTimelineEvent('tses_a', 1)]);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_700_000_000_000));
      await getCachedTabSessionProjection(log);
      vi.setSystemTime(new Date(1_700_000_000_000 + 600));
      await getCachedTabSessionProjection(log);
      expect(log.readCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
