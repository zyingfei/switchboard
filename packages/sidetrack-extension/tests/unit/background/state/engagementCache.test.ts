import { describe, expect, it, vi } from 'vitest';

import { createEngagementCache } from '../../../../src/background/state/engagementCache';
import { createChromeEngagementSessionStore } from '../../../../src/background/state/engagementSessionStore';
import { emptyEngagementTotals } from '../../../../src/content/engagement/aggregator';

const message = (input: {
  readonly start: number;
  readonly end: number;
  readonly activeMs: number;
  readonly final?: boolean;
  readonly visitId?: string;
}) => ({
  type: 'sidetrack.engagement.interval' as const,
  version: 1 as const,
  visitId: input.visitId ?? 'visit:one',
  intervalStart: input.start,
  intervalEnd: input.end,
  final: input.final ?? false,
  dimensions: {
    engagement: {
      ...emptyEngagementTotals(),
      activeMs: input.activeMs,
      visibleMs: input.activeMs,
      focusedWindowMs: input.activeMs,
    },
  },
});

const createMemoryChromeStorage = () => {
  const store: Record<string, unknown> = {};
  return {
    store,
    get: vi.fn(async (key: string) => ({ [key]: store[key] })),
    set: vi.fn(async (entries: Record<string, unknown>) => {
      Object.assign(store, entries);
    }),
  };
};

describe('engagement cache', () => {
  it('merges per-tab intervals into a session aggregate', () => {
    const cache = createEngagementCache({ sessionId: 'session:edge' });
    cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 1_000 }));
    const merged = cache.mergeInterval(
      10,
      message({ start: 2_000, end: 3_000, activeMs: 500, final: true }),
    );
    expect(merged.interval.dimensions.engagement.activeMs).toBe(500);
    expect(merged.aggregate.sessionId).toBe('session:edge:tab:10:start:1000');
    expect(merged.aggregate.dimensions.engagement.activeMs).toBe(1_500);
  });

  it('starts a new aggregate session when the same tab visits the same page later', () => {
    const cache = createEngagementCache({ sessionId: 'session:edge' });
    const first = cache.mergeInterval(
      10,
      message({ start: 1_000, end: 2_000, activeMs: 900, final: true }),
    );
    const second = cache.mergeInterval(
      10,
      message({ start: 5_000, end: 6_000, activeMs: 300, final: true }),
    );
    expect(first.aggregate.sessionId).toBe('session:edge:tab:10:start:1000');
    expect(second.aggregate.sessionId).toBe('session:edge:tab:10:start:5000');
    expect(second.aggregate.dimensions.engagement.activeMs).toBe(300);
  });

  it('survives a content-script crash by finalizing cached totals on tab removal', () => {
    const cache = createEngagementCache({ sessionId: 'session:edge' });
    cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 900 }));
    const finalized = cache.finalizeTab(10, 4_000);
    expect(finalized?.interval.intervalEnd).toBe(4_000);
    expect(finalized?.aggregate.sessionId).toBe('session:edge:tab:10:start:1000');
    expect(finalized?.aggregate.dimensions.engagement.activeMs).toBe(900);
    expect(cache.finalizeTab(10, 5_000)).toBeNull();
  });

  it('exposes the current visitId for a live tab and clears it on finalize', () => {
    const cache = createEngagementCache({ sessionId: 'session:edge' });
    expect(cache.currentVisitId(10)).toBeUndefined();
    cache.mergeInterval(
      10,
      message({ start: 1_000, end: 2_000, activeMs: 900, visitId: 'visit:a' }),
    );
    expect(cache.currentVisitId(10)).toBe('visit:a');
    cache.finalizeTab(10, 3_000);
    expect(cache.currentVisitId(10)).toBeUndefined();
  });

  describe('durable mirror + idle sweep', () => {
    it('persist() mirrors the running session to the durable store', async () => {
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      const cache = createEngagementCache({ sessionId: 'session:edge', store, now: () => 10_000 });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 900 }));
      await cache.persist(10);
      const mirrored = await store.get(10);
      expect(mirrored?.visitId).toBe('visit:one');
      expect(mirrored?.sessionId).toBe('session:edge:tab:10:start:1000');
      expect(mirrored?.totals.focusedWindowMs).toBe(900);
      expect(mirrored?.updatedAt).toBe(10_000);
    });

    it('clearDurable() removes the mirror after a final aggregate is emitted', async () => {
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      const cache = createEngagementCache({ sessionId: 'session:edge', store, now: () => 10_000 });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 900 }));
      await cache.persist(10);
      expect(await store.get(10)).toBeDefined();
      // A final interval deletes the in-memory entry; persist() on a
      // finalized tab clears the durable mirror.
      cache.mergeInterval(10, message({ start: 2_000, end: 3_000, activeMs: 100, final: true }));
      await cache.clearDurable(10);
      expect(await store.get(10)).toBeUndefined();
    });

    it('sweepDurable() finalizes a session idle past the threshold (abandoned session)', async () => {
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      let clock = 10_000;
      const cache = createEngagementCache({
        sessionId: 'session:edge',
        store,
        now: () => clock,
      });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 4_200 }));
      await cache.persist(10);
      // Simulate the service worker being evicted: the in-memory cache is
      // gone but the durable mirror survives. A fresh cache over the same
      // store must still recover and finalize the orphan.
      const revived = createEngagementCache({
        sessionId: 'session:edge',
        store,
        now: () => clock,
      });
      clock = 10_000 + 6 * 60_000; // 6 minutes later, past the 5-min sweep window
      const swept = await revived.sweepDurable(5 * 60_000, clock);
      expect(swept).toHaveLength(1);
      expect(swept[0]?.aggregate.visitId).toBe('visit:one');
      expect(swept[0]?.aggregate.sessionId).toBe('session:edge:tab:10:start:1000');
      expect(swept[0]?.aggregate.dimensions.engagement.focusedWindowMs).toBe(4_200);
      // The swept entry is removed so it is not re-emitted.
      expect(await store.get(10)).toBeUndefined();
      expect(await revived.sweepDurable(5 * 60_000, clock + 60_000)).toHaveLength(0);
    });

    it('sweepDurable() leaves fresh sessions and live in-memory tabs alone', async () => {
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      let clock = 10_000;
      const cache = createEngagementCache({
        sessionId: 'session:edge',
        store,
        now: () => clock,
      });
      // Tab 10: live + fresh (in the in-memory cache).
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 900 }));
      await cache.persist(10);
      // Only 1 minute passes — under the 5-minute threshold.
      clock = 10_000 + 60_000;
      const swept = await cache.sweepDurable(5 * 60_000, clock);
      expect(swept).toHaveLength(0);
      expect(await store.get(10)).toBeDefined();
    });

    it('degrades to a no-op sweep when no durable store is available', async () => {
      // No store passed and no chrome global — durable resolution fails
      // closed, so sweep/persist become harmless no-ops (the in-memory
      // and teardown-beacon paths still work).
      const cache = createEngagementCache({ sessionId: 'session:edge' });
      await expect(cache.sweepDurable(1_000, Date.now())).resolves.toEqual([]);
      await expect(cache.persist(10)).resolves.toBeUndefined();
    });
  });
});
