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

  describe('in-memory sweep aging', () => {
    it('finalizes a stale in-memory session once, seals it, and clears the durable mirror', async () => {
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      let clock = 10_000;
      const cache = createEngagementCache({ sessionId: 'session:edge', store, now: () => clock });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 4_200 }));
      await cache.persist(10);
      // The tab is still LIVE in the in-memory cache, but its periodic
      // beacons were suppressed (zero-delta) so mergeInterval stopped
      // firing. 6 minutes pass past the 5-minute threshold.
      clock = 10_000 + 6 * 60_000;
      const swept = await cache.sweepDurable(5 * 60_000, clock);
      expect(swept).toHaveLength(1);
      expect(swept[0]?.aggregate.visitId).toBe('visit:one');
      expect(swept[0]?.aggregate.dimensions.engagement.focusedWindowMs).toBe(4_200);
      // The session is SEALED (kept in the cache under the same sessionId) so
      // a resumed tab can emit deltas — NOT deleted (deleting would let a
      // cumulative resume re-emit the full totals and double-count).
      expect(cache.currentVisitId(10)).toBe('visit:one');
      // The durable mirror is cleared so the durable pass can't re-emit it.
      expect(await store.get(10)).toBeUndefined();
      // A follow-up sweep produces nothing — the sealed session has no new
      // engagement (no double-emit).
      expect(await cache.sweepDurable(5 * 60_000, clock + 60_000)).toHaveLength(0);
    });

    it('does NOT double-count when a swept-then-suppressed tab is resumed and later finalized', async () => {
      // The reviewed BLOCKER: a live tab is swept (change 4), then the user
      // returns. Because the content aggregator is cumulative-since-page-load
      // and the companion SUMS aggregates per visitId across distinct
      // sessionIds with no dedup, deleting on sweep would re-emit the full
      // cumulative totals -> ~doubled focusedWindowMs -> spurious 5s gate.
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      let clock = 10_000;
      const cache = createEngagementCache({ sessionId: 'session:edge', store, now: () => clock });

      // The SW cache sums each incoming snapshot's dimensions, so we drive it
      // with per-beacon deltas (as the existing tests do). Model a 3s session
      // so far: one beacon carrying 3s of focused time.
      cache.mergeInterval(10, message({ start: 1_000, end: 4_000, activeMs: 3_000 }));
      await cache.persist(10);

      // Idle 6 min -> swept. One aggregate for the 3s so far.
      clock = 10_000 + 6 * 60_000;
      const firstSweep = await cache.sweepDurable(5 * 60_000, clock);
      expect(firstSweep).toHaveLength(1);
      expect(firstSweep[0]?.aggregate.dimensions.engagement.focusedWindowMs).toBe(3_000);

      // User returns: 4s more of engagement (session continues, same tab).
      // These are NON-final periodic beacons — the caller (background.ts)
      // only ships the aggregate on final/attention-gate, so the running
      // aggregate returned here is NOT on the wire. It correctly reports only
      // the increment since the seal, but is not counted below.
      const resumed = cache.mergeInterval(10, message({ start: 4_000, end: 8_000, activeMs: 4_000 }));
      expect(resumed.aggregate.dimensions.engagement.focusedWindowMs).toBe(4_000);
      // Same sessionId is preserved across the seal so the session is one
      // continuous session.
      expect(resumed.aggregate.sessionId).toBe(firstSweep[0]?.aggregate.sessionId);

      // Tab closes -> finalizeTab emits the increment since the seal (the 4s
      // added after the sweep), NOT the full 7s cumulative. This IS on the
      // wire.
      const finalized = cache.finalizeTab(10, 12_000);
      const finalFocused = finalized?.aggregate.dimensions.engagement.focusedWindowMs ?? 0;
      expect(finalFocused).toBe(4_000);

      // TOTAL focusedWindowMs the companion would SUM across the two EMITTED
      // aggregates (sweep + finalize) for this visit must equal the true 7s,
      // not ~10-14s. (Before the fix, the resumed session rebuilt from zero
      // and the finalize re-emitted the full 7s -> 3 + 7 = 10s, a double.)
      const total = 3_000 + finalFocused;
      expect(total).toBe(7_000);
    });

    it('a sealed tab navigating to a new visit starts fresh after the nav-away finalize', async () => {
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      let clock = 10_000;
      const cache = createEngagementCache({ sessionId: 'session:edge', store, now: () => clock });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 3_000, visitId: 'visit:a' }));
      clock = 10_000 + 6 * 60_000;
      await cache.sweepDurable(5 * 60_000, clock); // seals visit:a in place
      // Production nav-away path: finalizeEngagementOnNavAway detects the new
      // visitId and finalizes the prior (sealed) session, deleting the byTab
      // entry. The sealed session had no new engagement since its seal, so
      // finalizeTab emits nothing but still clears the entry.
      expect(cache.finalizeTab(10, 400_000)).toBeNull();
      expect(cache.currentVisitId(10)).toBeUndefined();
      // The new visit now starts a brand-new session with no inherited totals
      // or sessionId and no seal applied.
      const next = cache.mergeInterval(
        10,
        message({ start: 500_000, end: 502_000, activeMs: 2_000, visitId: 'visit:b' }),
      );
      expect(next.aggregate.visitId).toBe('visit:b');
      expect(next.aggregate.dimensions.engagement.focusedWindowMs).toBe(2_000);
      expect(next.aggregate.sessionId).toBe('session:edge:tab:10:start:500000');
    });

    it('does not double-emit when both in-memory and durable mirrors exist for the same tab', async () => {
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      let clock = 10_000;
      const cache = createEngagementCache({ sessionId: 'session:edge', store, now: () => clock });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 900 }));
      await cache.persist(10); // durable mirror now exists alongside the in-memory session
      clock = 10_000 + 6 * 60_000;
      const swept = await cache.sweepDurable(5 * 60_000, clock);
      // Exactly ONE aggregate for the tab, from the in-memory path.
      expect(swept).toHaveLength(1);
      expect(swept.filter((f) => f.aggregate.sessionId === 'session:edge:tab:10:start:1000')).toHaveLength(
        1,
      );
    });

    it('leaves a fresh in-memory session untouched', async () => {
      const raw = createMemoryChromeStorage();
      const store = createChromeEngagementSessionStore(raw);
      let clock = 10_000;
      const cache = createEngagementCache({ sessionId: 'session:edge', store, now: () => clock });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 900 }));
      await cache.persist(10);
      // Only 1 minute passes — under the 5-minute threshold.
      clock = 10_000 + 60_000;
      const swept = await cache.sweepDurable(5 * 60_000, clock);
      expect(swept).toHaveLength(0);
      expect(cache.currentVisitId(10)).toBe('visit:one');
      expect(await store.get(10)).toBeDefined();
    });

    it('a continuing merge refreshes lastMergedAtMs so the session stays live', async () => {
      let clock = 10_000;
      const cache = createEngagementCache({ sessionId: 'session:edge', now: () => clock });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 900 }));
      clock = 10_000 + 4 * 60_000; // 4 min later — still under threshold
      cache.mergeInterval(10, message({ start: 2_000, end: 3_000, activeMs: 100 }));
      clock = 10_000 + 8 * 60_000; // 8 min from the FIRST merge, but only 4 min from the SECOND
      const swept = await cache.sweepDurable(5 * 60_000, clock);
      expect(swept).toHaveLength(0);
      expect(cache.currentVisitId(10)).toBe('visit:one');
    });

    it('ages in-memory sessions even with no durable store available', async () => {
      let clock = 10_000;
      const cache = createEngagementCache({ sessionId: 'session:edge', now: () => clock });
      cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 4_200 }));
      clock = 10_000 + 6 * 60_000;
      const swept = await cache.sweepDurable(5 * 60_000, clock);
      expect(swept).toHaveLength(1);
      expect(swept[0]?.aggregate.dimensions.engagement.focusedWindowMs).toBe(4_200);
      // Sealed in place (retained under the same session) so a resume emits
      // deltas rather than a double-counting full re-emit.
      expect(cache.currentVisitId(10)).toBe('visit:one');
      // A second sweep of the sealed-idle session emits nothing.
      expect(await cache.sweepDurable(5 * 60_000, clock + 60_000)).toHaveLength(0);
    });
  });
});
