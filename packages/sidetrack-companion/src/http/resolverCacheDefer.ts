// Deferred resolver-cache writes — get the sqlite INSERT off the request path.
//
// THE EVIDENCE. Native `sample` of the live companion during ONE
// POST /v1/visits/batch-resolve put ~90% of main-thread samples inside sqlite3.
// Alongside the expected read frames (sqlite3VdbeExec, BtreeTableMoveto, FTS)
// the profile contained sqlite3BtreeInsert — a WRITE, during a READ request.
// That write is `SqliteConnectionsStore.cacheResolverResult`, called once per
// resolved URL inside the batch loop (http/server.ts, the `misses` loop).
// bun:sqlite has no async API, so each of those INSERTs runs to completion on
// the thread that serves every other request: a 25-URL batch pays 25 upserts
// (JSON.stringify of the full result + an INSERT ... ON CONFLICT into a WAL db)
// inline, and /v1/status queues behind them.
//
// WHY DEFERRAL IS SAFE — this is the whole argument, so it is written out:
//   1. The in-flight request never reads back what it writes. The batch route
//      reads the cache for ALL urls first (building `misses`), then computes,
//      then writes. It serves from its own in-memory `results` map.
//   2. The entry is idempotent and keyed on (visit, resolver-cache revision),
//      where the revision already folds the serving arm + the AttributionV1State
//      mtime (see resolverCacheRevision in server.ts). So a user decision does
//      not need this write to be purged — it rolls the KEY, and a write landing
//      late under the OLD key is inert, never served.
//   3. The cache is best-effort by contract: `cacheResolverResult` already
//      swallows SQLITE_BUSY, because a lost write only costs the next request a
//      recompute. Dropping a queued write on overflow is the same trade.
// A deferred write therefore cannot change any response — only when the next
// request gets a cheap answer.
//
// WHEN IT DRAINS. NOT on a self-scheduled setImmediate: the batch loop itself
// yields via setImmediate between URLs, so a self-scheduled flush would
// interleave with the very request it is trying to get out of, and the sqlite
// write would still land inside that request's wall clock. Instead the HTTP
// dispatch calls `scheduleResolverCacheFlush()` in its `finally`, i.e. AFTER
// the response has been written. The fallback timer below exists only for the
// "companion went idle with a queued write" case, and it re-arms while any
// request is in flight so it can never reintroduce the thing we just removed.
//
// KILL SWITCH: SIDETRACK_RESOLVER_CACHE_DEFER=0 restores the synchronous
// in-request write (default ON, same '0'/'false' convention as every other
// switch in this package).

import { yieldToEventLoop } from '../runtime/eventLoopYield.js';
import { inflightCount } from '../runtime/inflightRegistry.js';

export const RESOLVER_CACHE_DEFER_ENV = 'SIDETRACK_RESOLVER_CACHE_DEFER';

/** Default ON. Only an explicit '0' / 'false' restores the in-request write. */
export const resolverCacheDeferEnabled = (): boolean => {
  const raw = process.env[RESOLVER_CACHE_DEFER_ENV];
  return raw !== '0' && raw !== 'false';
};

/** The store method this queue calls — `SqliteConnectionsStore.cacheResolverResult`. */
export type ResolverCacheWriter = (
  visitId: string,
  snapshotRevision: string,
  result: unknown,
) => Promise<void>;

interface PendingWrite {
  readonly writer: ResolverCacheWriter;
  readonly visitId: string;
  readonly snapshotRevision: string;
  readonly result: unknown;
}

/**
 * Cap on queued writes. A batch is ~25 urls and drains on the next response, so
 * this is never approached in practice; it is here so that a pathological
 * producer (or a drain that never gets a turn) costs bounded memory instead of
 * growing until the companion is OOM-killed. Overflow drops the NEW write —
 * the entries already queued are older, so they are the ones a subsequent
 * request is more likely to ask for.
 */
const MAX_PENDING = 1024;

/**
 * Safety-net delay. The primary drain is the dispatch `finally`; this only
 * catches "one last batch, then no traffic at all". Long enough that a normally
 * busy companion always drains via the response path first.
 */
const FALLBACK_FLUSH_MS = 2_000;

// Keyed on (visitId, snapshotRevision) — the cache's own primary key — so a URL
// resolved twice before the drain writes ONCE, with the newer value. Map keeps
// insertion order, which the drain relies on for FIFO.
const pending = new Map<string, PendingWrite>();
let flushInFlight: Promise<void> | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let droppedOverflow = 0;
let writeFailures = 0;

const pendingKey = (visitId: string, snapshotRevision: string): string =>
  `${visitId}\u0000${snapshotRevision}`;

/**
 * Queue one resolver-cache upsert for after-the-response. Never throws, never
 * awaits, never touches sqlite on the caller's tick.
 */
export const queueResolverCacheWrite = (
  writer: ResolverCacheWriter,
  visitId: string,
  snapshotRevision: string,
  result: unknown,
): void => {
  const key = pendingKey(visitId, snapshotRevision);
  if (!pending.has(key) && pending.size >= MAX_PENDING) {
    droppedOverflow += 1;
    return;
  }
  pending.set(key, { writer, visitId, snapshotRevision, result });
  armFallbackFlush();
};

const armFallbackFlush = (): void => {
  if (fallbackTimer !== null) return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    if (pending.size === 0) return;
    // A request is running: re-arm rather than drain. The entire point of this
    // module is that the write is not on a request's tick, and a fallback that
    // ignored that would quietly undo it.
    if (inflightCount() > 0) {
      armFallbackFlush();
      return;
    }
    void flushResolverCacheWrites();
  }, FALLBACK_FLUSH_MS);
  // Never hold the process open for a best-effort cache write.
  fallbackTimer.unref?.();
};

/**
 * Ask for a drain. Call AFTER the response has been sent. Cheap no-op when the
 * queue is empty (the common case), so the dispatch path can call it
 * unconditionally.
 */
export const scheduleResolverCacheFlush = (): void => {
  if (pending.size === 0 || flushInFlight !== null) return;
  setImmediate(() => {
    void flushResolverCacheWrites();
  });
};

const drainPendingWrites = async (): Promise<void> => {
  while (pending.size > 0) {
    const next = pending.entries().next();
    if (next.done === true) return;
    const [key, entry] = next.value;
    pending.delete(key);
    try {
      await entry.writer(entry.visitId, entry.snapshotRevision, entry.result);
    } catch (error) {
      // A failed cache write is a recompute next time, nothing more. It must
      // NEVER propagate: this runs detached from any request, so a throw here
      // would surface as an unhandled rejection and (under some Bun versions)
      // take the process with it.
      writeFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[resolver-cache] deferred write failed: ${message}`);
    }
    // Between writes, not just between batches: N queued upserts must not
    // reassemble into the single long tick this module exists to break up.
    if (pending.size > 0) await yieldToEventLoop();
  }
};

/**
 * Drain the queue now. Single-flight — a second caller joins the running drain
 * instead of starting a competing one (two drains would interleave `delete`s
 * and could double-write). Awaited by tests and by shutdown; production calls
 * `scheduleResolverCacheFlush` instead.
 */
export const flushResolverCacheWrites = async (): Promise<void> => {
  while (flushInFlight !== null) {
    await flushInFlight;
  }
  if (pending.size === 0) return;
  const run = drainPendingWrites();
  flushInFlight = run;
  try {
    await run;
  } finally {
    flushInFlight = null;
  }
};

/** Queue depth — for tests and for a future /v1/status field. */
export const pendingResolverCacheWriteCount = (): number => pending.size;

/** Diagnostics: writes dropped on overflow, and writes that threw. */
export const resolverCacheDeferStats = (): {
  readonly pending: number;
  readonly droppedOverflow: number;
  readonly writeFailures: number;
} => ({ pending: pending.size, droppedOverflow, writeFailures });

/** Test seam: module-level state is process-global, so tests must reset it. */
export const __resetResolverCacheDeferQueue = (): void => {
  pending.clear();
  flushInFlight = null;
  droppedOverflow = 0;
  writeFailures = 0;
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
};
