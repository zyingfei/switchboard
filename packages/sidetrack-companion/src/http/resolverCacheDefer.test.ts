import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetInflightRegistry } from '../runtime/inflightRegistry.js';
import {
  RESOLVER_CACHE_DEFER_ENV,
  __resetResolverCacheDeferQueue,
  flushResolverCacheWrites,
  pendingResolverCacheWriteCount,
  queueResolverCacheWrite,
  resolverCacheDeferEnabled,
  resolverCacheDeferStats,
  scheduleResolverCacheFlush,
} from './resolverCacheDefer.js';

// The queue is module-level (process-global) state; reset between tests.
beforeEach(() => {
  __resetResolverCacheDeferQueue();
  __resetInflightRegistry();
});
afterEach(() => {
  __resetResolverCacheDeferQueue();
  __resetInflightRegistry();
});

/** One macrotask turn — enough for a `setImmediate`-scheduled flush to start. */
const tick = async (): Promise<void> =>
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe('resolverCacheDeferEnabled (kill switch)', () => {
  const previous = process.env[RESOLVER_CACHE_DEFER_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[RESOLVER_CACHE_DEFER_ENV];
    else process.env[RESOLVER_CACHE_DEFER_ENV] = previous;
  });

  it('defaults ON and is disabled only by an explicit 0 / false', () => {
    delete process.env[RESOLVER_CACHE_DEFER_ENV];
    expect(resolverCacheDeferEnabled()).toBe(true);
    process.env[RESOLVER_CACHE_DEFER_ENV] = '1';
    expect(resolverCacheDeferEnabled()).toBe(true);
    process.env[RESOLVER_CACHE_DEFER_ENV] = '';
    expect(resolverCacheDeferEnabled()).toBe(true);
    process.env[RESOLVER_CACHE_DEFER_ENV] = '0';
    expect(resolverCacheDeferEnabled()).toBe(false);
    process.env[RESOLVER_CACHE_DEFER_ENV] = 'false';
    expect(resolverCacheDeferEnabled()).toBe(false);
  });
});

describe('queueResolverCacheWrite', () => {
  it('writes NOTHING until a flush is asked for — this is the whole point', async () => {
    const writer = vi.fn(async () => undefined);
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-1', { action: 'inbox' });
    queueResolverCacheWrite(writer, 'https://a.test/2', 'rev-1', { action: 'inbox' });
    // Several macrotask turns pass — the batch loop's own between-URL yields
    // are setImmediate, so a self-scheduling queue would have fired by now and
    // put the sqlite write back inside the request it was moved out of.
    await tick();
    await tick();
    await tick();
    expect(writer).not.toHaveBeenCalled();
    expect(pendingResolverCacheWriteCount()).toBe(2);
  });

  it('drains everything queued once flushed, preserving the arguments', async () => {
    const writer = vi.fn(async () => undefined);
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-1', { n: 1 });
    queueResolverCacheWrite(writer, 'https://a.test/2', 'rev-1', { n: 2 });
    await flushResolverCacheWrites();
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer).toHaveBeenCalledWith('https://a.test/1', 'rev-1', { n: 1 });
    expect(writer).toHaveBeenCalledWith('https://a.test/2', 'rev-1', { n: 2 });
    expect(pendingResolverCacheWriteCount()).toBe(0);
  });

  it('is last-wins per (visit, revision) — one write, the newest value', async () => {
    const writer = vi.fn(async () => undefined);
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-1', { generation: 'stale' });
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-1', { generation: 'fresh' });
    expect(pendingResolverCacheWriteCount()).toBe(1);
    await flushResolverCacheWrites();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith('https://a.test/1', 'rev-1', { generation: 'fresh' });
  });

  it('treats a different snapshot revision as a different entry', async () => {
    const writer = vi.fn(async () => undefined);
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-1', { n: 1 });
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-2', { n: 2 });
    expect(pendingResolverCacheWriteCount()).toBe(2);
    await flushResolverCacheWrites();
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it('yields between writes so N upserts are not one uninterruptible tick', async () => {
    const writer = vi.fn(async () => undefined);
    for (let index = 0; index < 5; index += 1) {
      queueResolverCacheWrite(writer, `https://a.test/${String(index)}`, 'rev-1', { index });
    }
    // A setImmediate chain running alongside the drain gets turns only if the
    // drain actually hands the loop back between writes.
    let interleaved = 0;
    let running = true;
    const beat = (): void => {
      if (!running) return;
      interleaved += 1;
      setImmediate(beat);
    };
    setImmediate(beat);
    await flushResolverCacheWrites();
    running = false;
    expect(writer).toHaveBeenCalledTimes(5);
    // 5 writes ⇒ 4 inter-write yields.
    expect(interleaved).toBeGreaterThanOrEqual(4);
  });
});

describe('flush failure handling', () => {
  it('swallows + logs a failing write and keeps draining the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const writer = vi.fn(async (visitId: string) => {
      if (visitId === 'https://a.test/2') throw new Error('database is locked');
    });
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-1', { n: 1 });
    queueResolverCacheWrite(writer, 'https://a.test/2', 'rev-1', { n: 2 });
    queueResolverCacheWrite(writer, 'https://a.test/3', 'rev-1', { n: 3 });
    // Must not reject: this runs detached from any request, so a throw would
    // surface as an unhandled rejection.
    await expect(flushResolverCacheWrites()).resolves.toBeUndefined();
    expect(writer).toHaveBeenCalledTimes(3);
    expect(resolverCacheDeferStats().writeFailures).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[resolver-cache] deferred write failed'),
    );
    expect(pendingResolverCacheWriteCount()).toBe(0);
    warn.mockRestore();
  });

  it('a synchronously-throwing writer is contained too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const writer = ((): Promise<void> => {
      throw new Error('boom');
    }) as unknown as (visitId: string, snapshotRevision: string, result: unknown) => Promise<void>;
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-1', { n: 1 });
    await expect(flushResolverCacheWrites()).resolves.toBeUndefined();
    expect(resolverCacheDeferStats().writeFailures).toBe(1);
    warn.mockRestore();
  });
});

describe('scheduleResolverCacheFlush (the dispatch-finally trigger)', () => {
  it('drains on the next macrotask after being asked', async () => {
    const writer = vi.fn(async () => undefined);
    queueResolverCacheWrite(writer, 'https://a.test/1', 'rev-1', { n: 1 });
    scheduleResolverCacheFlush();
    expect(writer).not.toHaveBeenCalled();
    await tick();
    await tick();
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it('is a cheap no-op with an empty queue (every non-batch request)', () => {
    expect(pendingResolverCacheWriteCount()).toBe(0);
    expect(() => {
      scheduleResolverCacheFlush();
    }).not.toThrow();
  });

  it('is single-flight — a second flush joins the running drain, never doubles it', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const writer = vi.fn(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      concurrent -= 1;
    });
    for (let index = 0; index < 4; index += 1) {
      queueResolverCacheWrite(writer, `https://a.test/${String(index)}`, 'rev-1', { index });
    }
    await Promise.all([
      flushResolverCacheWrites(),
      flushResolverCacheWrites(),
      flushResolverCacheWrites(),
    ]);
    // Each entry is deleted before its write starts, so a joined flush can
    // never re-issue it.
    expect(writer).toHaveBeenCalledTimes(4);
    expect(maxConcurrent).toBe(1);
    expect(pendingResolverCacheWriteCount()).toBe(0);
  });
});

describe('overflow', () => {
  it('drops new writes past the cap instead of growing without bound', () => {
    const writer = vi.fn(async () => undefined);
    for (let index = 0; index < 1100; index += 1) {
      queueResolverCacheWrite(writer, `https://a.test/${String(index)}`, 'rev-1', { index });
    }
    expect(pendingResolverCacheWriteCount()).toBe(1024);
    expect(resolverCacheDeferStats().droppedOverflow).toBe(76);
    // An UPDATE to an already-queued key still lands at the cap — it costs no
    // new memory and it is the fresher value.
    queueResolverCacheWrite(writer, 'https://a.test/0', 'rev-1', { updated: true });
    expect(pendingResolverCacheWriteCount()).toBe(1024);
    expect(resolverCacheDeferStats().droppedOverflow).toBe(76);
  });
});
