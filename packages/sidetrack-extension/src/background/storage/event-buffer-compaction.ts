import type { BufferedEvent } from './in-memory-event-buffer';

// Boot-time backlog compaction policy (PURE — no IndexedDB).
//
// In production the extension's IndexedDB buffer reached 1,218,857 events,
// 99.8% of them `engagement.interval.observed` 30s beacons from ~38 open
// tabs — most carrying zero attention deltas. They buried the ONE starved
// signal (`engagement.session.aggregated`) FIFO, so aggregates never
// delivered and companion visit-similarity starved vault-wide.
//
// This decides what survives a one-shot compaction at SW boot:
//   - keep EVERY non-interval event (aggregates, navs, selections,
//     fingerprints — never dropped); and
//   - keep only the NEWEST `keepIntervals` `engagement.interval.observed`
//     events by lamport (a fresh tab's live intervals are still useful);
//   - drop the rest.
// The glue in the IndexedDB driver deletes only the events this policy
// marks droppable and never touches survivors — so the aggregate signal
// cannot be lost even if the compaction is interrupted and re-run.

export const INTERVAL_STREAM_NAME: BufferedEvent['streamName'] = 'engagement.interval.observed';

// Newest interval events to retain. ~1,000 covers the live tabs' recent
// beacons without letting the abandoned-tab backlog rebuild.
export const DEFAULT_KEEP_INTERVALS = 1_000;

// Fast-path threshold: when this many interval events would be dropped,
// cursor-deleting them one transaction at a time is too slow; the driver
// switches to the extract + deleteDatabase + re-append fast path (staging
// survivors to chrome.storage.local first for crash-safety).
export const COMPACTION_FAST_PATH_DROP_THRESHOLD = 50_000;

export interface EventBufferCompactionPlan {
  /** Non-interval events + newest `keepIntervals` intervals, to retain. */
  readonly survivors: readonly BufferedEvent[];
  /** Total interval events that will be dropped. */
  readonly intervalDropCount: number;
  /** Total interval events currently buffered (survivors + dropped). */
  readonly intervalTotal: number;
  /** Non-interval events currently buffered (all retained). */
  readonly nonIntervalTotal: number;
}

// Ascending order by (lamport, replicaId) — matches the buffer's peek
// order so "newest by lamport" is unambiguous.
const ascendingByLamport = (a: BufferedEvent, b: BufferedEvent): number =>
  a.lamport === b.lamport ? a.replicaId.localeCompare(b.replicaId) : a.lamport - b.lamport;

/**
 * Compute the compaction survivor set from every buffered event.
 *
 * Pure and order-independent: keeps all non-interval events and the newest
 * `keepIntervals` interval events by lamport. Safe to run repeatedly — a
 * second pass over the already-compacted set returns the same survivors
 * (idempotent), so an interrupted compaction converges on the next boot.
 */
export const planEventBufferCompaction = (
  events: readonly BufferedEvent[],
  keepIntervals: number = DEFAULT_KEEP_INTERVALS,
): EventBufferCompactionPlan => {
  const keep = Math.max(0, Math.floor(keepIntervals));
  const nonInterval: BufferedEvent[] = [];
  const intervals: BufferedEvent[] = [];
  for (const event of events) {
    if (event.streamName === INTERVAL_STREAM_NAME) intervals.push(event);
    else nonInterval.push(event);
  }
  const sortedIntervals = [...intervals].sort(ascendingByLamport);
  const keptIntervals =
    keep >= sortedIntervals.length ? sortedIntervals : sortedIntervals.slice(-keep);
  const intervalDropCount = sortedIntervals.length - keptIntervals.length;
  return {
    survivors: [...nonInterval, ...keptIntervals],
    intervalDropCount,
    intervalTotal: sortedIntervals.length,
    nonIntervalTotal: nonInterval.length,
  };
};

export interface EventBufferCompactionResult {
  readonly droppedIntervals: number;
  readonly survivors: number;
  readonly path: 'noop' | 'cursor' | 'recreate';
}

// Durable staging area for the fast-path survivor set (write-ahead log).
export interface CompactionStagingArea {
  readonly read: () => Promise<readonly BufferedEvent[] | null>;
  readonly write: (survivors: readonly BufferedEvent[]) => Promise<void>;
  readonly clear: () => Promise<void>;
}

// The storage primitives the coordinator drives. The IndexedDB driver
// supplies real implementations; tests supply in-memory fakes. Keeping the
// orchestration (crash-safe path selection + staging replay) here — off the
// live IDB connection — makes it directly unit-testable without a fake
// IndexedDB.
//
// IMPORTANT (heap): the coordinator NEVER materializes the whole buffer to
// plan. On the pathological input this feature targets (production peaked at
// ~1.2M interval events) a full readAll would hold ~600MB-1GB of live objects
// in a constrained MV3 SW heap and could OOM the worker mid-read — and since
// `compact()` re-runs on every SW wake, that would be a crash loop that never
// clears the very backlog the fast path exists for. Instead the plan is driven
// from cheap primitives: an index COUNT of intervals (O(index), materializes
// nothing) plus bounded reads of only the survivors (non-interval events +
// the newest `keepIntervals`). Peak heap stays O(survivors) — a few thousand.
export interface EventBufferCompactionOps {
  /** Count interval events via an index count — must NOT materialize rows. */
  readonly countIntervals: () => Promise<number>;
  /**
   * Read only the NEWEST `keep` interval events (descending lamport), i.e.
   * the interval survivors. Bounded by `keep`, never the full backlog.
   */
  readonly readNewestIntervals: (keep: number) => Promise<readonly BufferedEvent[]>;
  /**
   * Read every NON-interval event (the always-kept survivors: aggregates,
   * navs, selections, fingerprints). Bounded by the non-interval count,
   * which is tiny next to the interval backlog.
   */
  readonly readNonIntervalEvents: () => Promise<readonly BufferedEvent[]>;
  readonly put: (event: BufferedEvent) => Promise<void>;
  /** Drop the OLDEST `dropCount` interval events; returns how many were dropped. */
  readonly cursorDropOldestIntervals: (dropCount: number) => Promise<number>;
  /** Delete the whole database (fast path). */
  readonly deleteDatabase: () => Promise<void>;
  /** Reopen/recreate the (now-empty) database schema. */
  readonly recreate: () => Promise<void>;
  readonly staging: CompactionStagingArea | null;
}

/**
 * Compute the survivor set with bounded reads only — non-interval events
 * plus the newest `keep` intervals. Peak working set is O(survivors),
 * independent of the interval backlog size. This is the streaming twin of
 * `planEventBufferCompaction`'s survivor computation (the pure function stays
 * the tested policy; this avoids ever building the full-buffer array).
 */
const readSurvivors = async (
  ops: EventBufferCompactionOps,
  keep: number,
): Promise<readonly BufferedEvent[]> => {
  const [nonInterval, newestIntervals] = await Promise.all([
    ops.readNonIntervalEvents(),
    ops.readNewestIntervals(keep),
  ]);
  return [...nonInterval, ...newestIntervals];
};

/**
 * Run a boot-time compaction using injected storage ops.
 *
 * Crash-safety contract (why aggregates can't be lost):
 *  - Every run first replays a staged survivor set left by an interrupted
 *    prior fast-path run — `put` is idempotent (keyed by streamName|lamport|
 *    replicaId), so replay converges. This closes the fast-path crash window
 *    (evicted after deleteDatabase, before re-append): the survivors are
 *    already durable in the staging area and get put back next boot.
 *  - Fast path (drop > threshold, staging available): read only the
 *    survivors → stage them → deleteDatabase → recreate → re-append → clear
 *    staging. deleteDatabase only happens AFTER survivors are durably staged.
 *  - Slow path (drop <= threshold, or no staging area): cursor-delete only
 *    the OLDEST surplus interval events. It never touches a non-interval
 *    survivor, so it is crash-safe with no staging and re-runs converge. It
 *    reads NOTHING into heap beyond the delete cursor.
 *
 * Heap: the drop decision comes from `countIntervals()` (an index count),
 * never a full-buffer read. Only the fast path reads, and only the survivors.
 */
export const runEventBufferCompaction = async (
  ops: EventBufferCompactionOps,
  keepIntervals: number = DEFAULT_KEEP_INTERVALS,
): Promise<EventBufferCompactionResult> => {
  // Reconcile any interrupted prior fast-path run before doing anything.
  if (ops.staging !== null) {
    const staged = await ops.staging.read().catch(() => null);
    if (staged !== null) {
      for (const event of staged) await ops.put(event);
      await ops.staging.clear().catch(() => undefined);
    }
  }

  const keep = Math.max(0, Math.floor(keepIntervals));
  const intervalTotal = await ops.countIntervals();
  const intervalDropCount = Math.max(0, intervalTotal - keep);
  if (intervalDropCount === 0) {
    // Nothing to drop; survivors == everything, but we never counted the
    // non-interval events (no need — the buffer stays as-is).
    return { droppedIntervals: 0, survivors: 0, path: 'noop' };
  }

  if (intervalDropCount > COMPACTION_FAST_PATH_DROP_THRESHOLD && ops.staging !== null) {
    // Read ONLY the survivors (bounded), never the interval backlog.
    const survivors = await readSurvivors(ops, keep);
    await ops.staging.write(survivors);
    await ops.deleteDatabase();
    await ops.recreate();
    for (const event of survivors) await ops.put(event);
    await ops.staging.clear().catch(() => undefined);
    return {
      droppedIntervals: intervalDropCount,
      survivors: survivors.length,
      path: 'recreate',
    };
  }

  const dropped = await ops.cursorDropOldestIntervals(intervalDropCount);
  return { droppedIntervals: dropped, survivors: 0, path: 'cursor' };
};
