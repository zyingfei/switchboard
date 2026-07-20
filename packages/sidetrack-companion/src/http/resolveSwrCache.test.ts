import { describe, expect, it } from 'vitest';

import { ResolveSwrCache, type ResolveResult } from './resolveSwrCache.js';

// A controllable clock so TTL windows are deterministic.
const makeClock = (): { now: () => number; advance: (ms: number) => void } => {
  let t = 1_000;
  return { now: () => t, advance: (ms) => (t += ms) };
};

// A deferred so we can hold a build() open and assert single-flight /
// concurrency behaviour precisely (no timers, no races).
const deferred = (): {
  promise: Promise<ResolveResult>;
  resolve: (v: ResolveResult) => void;
} => {
  let resolve!: (v: ResolveResult) => void;
  const promise = new Promise<ResolveResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const flush = async (): Promise<void> => {
  // Let queued microtasks (single-flight resolution, pump()) settle.
  await Promise.resolve();
  await Promise.resolve();
};

describe('ResolveSwrCache', () => {
  it('(a) sig change does NOT evict — serves stale instantly + background refresh updates the entry', async () => {
    const clock = makeClock();
    const cache = new ResolveSwrCache({
      ttlMs: 300_000,
      maxBackgroundRefresh: 2,
      maxEntries: 256,
      now: clock.now,
    });

    // Cold compute under sig-A.
    const cold = await cache.serve('visres:u', 'sig-A', async () => [200, { v: 'A' }]);
    expect(cold.freshness).toBe('fresh');
    expect(cold.result).toEqual([200, { v: 'A' }]);

    // Now the graph sig changes (a drain). A subsequent request must serve
    // the stale A value INSTANTLY (not recompute inline) and kick a refresh.
    let refreshBuilt = false;
    const stale = await cache.serve('visres:u', 'sig-B', async () => {
      refreshBuilt = true;
      return [200, { v: 'B' }];
    });
    expect(stale.freshness).toBe('stale-revalidating');
    expect(stale.result).toEqual([200, { v: 'A' }]); // stale served immediately
    expect(cache.queuedRefreshCount() + cache.activeBackgroundCount()).toBeGreaterThan(0);

    await flush();
    expect(refreshBuilt).toBe(true);

    // After the background refresh completes, the entry is updated to B and a
    // request under sig-B now serves fresh B.
    const afterRefresh = await cache.serve('visres:u', 'sig-B', async () => [200, { v: 'C' }]);
    expect(afterRefresh.freshness).toBe('fresh');
    expect(afterRefresh.result).toEqual([200, { v: 'B' }]);
  });

  it('(b) single-flight: N concurrent same-key cold requests share ONE computation', async () => {
    const clock = makeClock();
    const cache = new ResolveSwrCache({
      ttlMs: 300_000,
      maxBackgroundRefresh: 2,
      maxEntries: 256,
      now: clock.now,
    });

    let builds = 0;
    const gate = deferred();
    const build = async (): Promise<ResolveResult> => {
      builds += 1;
      return gate.promise;
    };

    const p1 = cache.serve('visres:u', 'sig-A', build);
    const p2 = cache.serve('visres:u', 'sig-A', build);
    const p3 = cache.serve('visres:u', 'sig-A', build);
    await flush();
    expect(builds).toBe(1); // one shared computation for the 3 concurrent calls

    gate.resolve([200, { v: 'shared' }]);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.result).toEqual([200, { v: 'shared' }]);
    expect(r2.result).toEqual([200, { v: 'shared' }]);
    expect(r3.result).toEqual([200, { v: 'shared' }]);
    expect(builds).toBe(1);
  });

  it('(c) background refresh concurrency bound honored under a burst of distinct keys', async () => {
    const clock = makeClock();
    const cache = new ResolveSwrCache({
      ttlMs: 300_000,
      maxBackgroundRefresh: 2,
      maxEntries: 256,
      now: clock.now,
    });

    const N = 8;
    const gates = Array.from({ length: N }, () => deferred());
    // Seed a cold entry per key under sig-A.
    for (let i = 0; i < N; i += 1) {
      await cache.serve(`visres:${String(i)}`, 'sig-A', async () => [200, { v: `A${String(i)}` }]);
    }

    // Now a drain flips the sig; hit every key so each enqueues a refresh.
    let peakActive = 0;
    let started = 0;
    for (let i = 0; i < N; i += 1) {
      const idx = i;
      const served = await cache.serve(`visres:${String(idx)}`, 'sig-B', async () => {
        started += 1;
        peakActive = Math.max(peakActive, cache.activeBackgroundCount());
        return gates[idx]!.promise;
      });
      // Every hit serves stale instantly.
      expect(served.freshness).toBe('stale-revalidating');
    }
    await flush();

    // At most maxBackgroundRefresh builds may be in flight concurrently.
    expect(started).toBeLessThanOrEqual(2);
    expect(cache.activeBackgroundCount()).toBeLessThanOrEqual(2);
    expect(peakActive).toBeLessThanOrEqual(2);

    // Resolve every gate (safe even for not-yet-started builds), then drain.
    // The bound must hold across the ENTIRE drain, never exceeding 2 active.
    for (let i = 0; i < N; i += 1) gates[i]!.resolve([200, { v: `B${String(i)}` }]);
    for (let k = 0; k < N + 4; k += 1) {
      await flush();
      expect(cache.activeBackgroundCount()).toBeLessThanOrEqual(2);
    }
    expect(cache.activeBackgroundCount()).toBe(0);
    expect(cache.queuedRefreshCount()).toBe(0);
    // Every distinct key was eventually refreshed exactly once.
    expect(started).toBe(N);
  });

  it('true-cold (no entry) computes inline and returns fresh', async () => {
    const clock = makeClock();
    const cache = new ResolveSwrCache({
      ttlMs: 300_000,
      maxBackgroundRefresh: 2,
      maxEntries: 256,
      now: clock.now,
    });
    let built = false;
    const served = await cache.serve('tabres:x', 'sig-A', async () => {
      built = true;
      return [200, { v: 'inline' }];
    });
    expect(built).toBe(true);
    expect(served.freshness).toBe('fresh');
    expect(served.result).toEqual([200, { v: 'inline' }]);
  });

  it('non-200 results are not cached', async () => {
    const clock = makeClock();
    const cache = new ResolveSwrCache({
      ttlMs: 300_000,
      maxBackgroundRefresh: 2,
      maxEntries: 256,
      now: clock.now,
    });
    await cache.serve('visres:e', 'sig-A', async () => [409, { error: 'x' }]);
    expect(cache.size()).toBe(0);
    // A follow-up still computes inline (no stale entry to serve).
    let built = 0;
    await cache.serve('visres:e', 'sig-A', async () => {
      built += 1;
      return [409, { error: 'x' }];
    });
    expect(built).toBe(1);
  });

  it('invalidate() drops matching entries + queued refreshes', async () => {
    const clock = makeClock();
    const cache = new ResolveSwrCache({
      ttlMs: 300_000,
      maxBackgroundRefresh: 1,
      maxEntries: 256,
      now: clock.now,
    });
    await cache.serve('visres:a', 'sig-A', async () => [200, { v: 'a' }]);
    await cache.serve('tabres:b', 'sig-A', async () => [200, { v: 'b' }]);
    expect(cache.size()).toBe(2);
    cache.invalidate((k) => k.startsWith('visres:') || k.startsWith('tabres:'));
    expect(cache.size()).toBe(0);
  });

  it('TTL expiry forces an inline recompute rather than serving stale', async () => {
    const clock = makeClock();
    const cache = new ResolveSwrCache({
      ttlMs: 1_000,
      maxBackgroundRefresh: 2,
      maxEntries: 256,
      now: clock.now,
    });
    await cache.serve('visres:t', 'sig-A', async () => [200, { v: 'A' }]);
    clock.advance(2_000); // past TTL
    let built = false;
    const served = await cache.serve('visres:t', 'sig-A', async () => {
      built = true;
      return [200, { v: 'A2' }];
    });
    expect(built).toBe(true);
    expect(served.freshness).toBe('fresh');
    expect(served.result).toEqual([200, { v: 'A2' }]);
  });

  it('maxEntries hard-caps resident entries', async () => {
    const clock = makeClock();
    const cache = new ResolveSwrCache({
      ttlMs: 300_000,
      maxBackgroundRefresh: 2,
      maxEntries: 3,
      now: clock.now,
    });
    for (let i = 0; i < 10; i += 1) {
      clock.advance(1);
      await cache.serve(`visres:${String(i)}`, 'sig-A', async () => [200, { v: i }]);
    }
    expect(cache.size()).toBeLessThanOrEqual(3);
  });
});
