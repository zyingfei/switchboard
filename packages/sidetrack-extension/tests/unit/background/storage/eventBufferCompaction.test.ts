import { describe, expect, it } from 'vitest';

import {
  COMPACTION_FAST_PATH_DROP_THRESHOLD,
  DEFAULT_KEEP_INTERVALS,
  planEventBufferCompaction,
  runEventBufferCompaction,
  type CompactionStagingArea,
  type EventBufferCompactionOps,
} from '../../../../src/background/storage/event-buffer-compaction';
import type { BufferedEvent } from '../../../../src/background/storage/in-memory-event-buffer';

const interval = (lamport: number, replicaId = 'r1'): BufferedEvent => ({
  streamName: 'engagement.interval.observed',
  lamport,
  replicaId,
  payload: { payloadVersion: 1, visitId: `v-${String(lamport)}` },
  observedAt: '2026-06-28T00:00:00.000Z',
});

const aggregate = (lamport: number): BufferedEvent => ({
  streamName: 'engagement.session.aggregated',
  lamport,
  replicaId: 'r1',
  payload: { payloadVersion: 1, visitId: `agg-${String(lamport)}` },
  observedAt: '2026-06-28T00:00:00.000Z',
});

const nav = (lamport: number): BufferedEvent => ({
  streamName: 'navigation.committed',
  lamport,
  replicaId: 'r1',
  payload: { payloadVersion: 1 },
  observedAt: '2026-06-28T00:00:00.000Z',
});

const keyOf = (e: BufferedEvent): string => `${e.streamName}|${e.lamport}|${e.replicaId}`;

describe('planEventBufferCompaction', () => {
  it('keeps every non-interval event and the newest N intervals', () => {
    const events: BufferedEvent[] = [
      aggregate(1),
      nav(2),
      interval(3),
      interval(4),
      interval(5),
      interval(6),
    ];
    const plan = planEventBufferCompaction(events, 2);
    expect(plan.nonIntervalTotal).toBe(2);
    expect(plan.intervalTotal).toBe(4);
    expect(plan.intervalDropCount).toBe(2);
    // Newest two intervals (lamport 5, 6) survive; the aggregate and nav
    // always survive.
    const survivorKeys = plan.survivors.map(keyOf).sort();
    expect(survivorKeys).toEqual(
      [aggregate(1), nav(2), interval(5), interval(6)].map(keyOf).sort(),
    );
  });

  it('drops nothing when intervals are at or under the keep count', () => {
    const events: BufferedEvent[] = [interval(1), interval(2), aggregate(3)];
    const plan = planEventBufferCompaction(events, 5);
    expect(plan.intervalDropCount).toBe(0);
    expect(plan.survivors).toHaveLength(3);
  });

  it('is order-independent and idempotent on an already-compacted set', () => {
    const unsorted: BufferedEvent[] = [interval(6), aggregate(1), interval(3), interval(5)];
    const first = planEventBufferCompaction(unsorted, 2);
    // Feed the survivors back through: nothing further should drop.
    const second = planEventBufferCompaction(first.survivors, 2);
    expect(second.intervalDropCount).toBe(0);
    expect(second.survivors.map(keyOf).sort()).toEqual(first.survivors.map(keyOf).sort());
  });

  it('newest-1k rule at the default keep count', () => {
    const events: BufferedEvent[] = [];
    for (let i = 0; i < DEFAULT_KEEP_INTERVALS + 250; i += 1) events.push(interval(i));
    events.push(aggregate(999_999));
    const plan = planEventBufferCompaction(events);
    expect(plan.intervalDropCount).toBe(250);
    // The 250 oldest (lamport 0..249) are dropped; the aggregate survives.
    expect(plan.survivors.some((e) => e.streamName === 'engagement.session.aggregated')).toBe(true);
    const keptIntervalLamports = plan.survivors
      .filter((e) => e.streamName === 'engagement.interval.observed')
      .map((e) => e.lamport);
    expect(Math.min(...keptIntervalLamports)).toBe(250);
    expect(keptIntervalLamports).toHaveLength(DEFAULT_KEEP_INTERVALS);
  });
});

// In-memory fake of the storage ops the coordinator drives. Models an
// IndexedDB keyed by `streamName|lamport|replicaId` so put() is idempotent.
// `calls` counts how many events each bounded read materialized, so a test
// can assert the large path never materializes the full backlog.
interface FakeOpsCalls {
  countIntervals: number;
  newestIntervalsRead: number; // events materialized via readNewestIntervals
  nonIntervalRead: number; // events materialized via readNonIntervalEvents
}

const createFakeOps = (
  initial: readonly BufferedEvent[],
  staging: CompactionStagingArea | null,
): EventBufferCompactionOps & {
  readonly store: Map<string, BufferedEvent>;
  readonly calls: FakeOpsCalls;
} => {
  const store = new Map<string, BufferedEvent>();
  for (const e of initial) store.set(keyOf(e), e);
  const calls: FakeOpsCalls = { countIntervals: 0, newestIntervalsRead: 0, nonIntervalRead: 0 };
  const intervals = (): BufferedEvent[] =>
    [...store.values()]
      .filter((e) => e.streamName === 'engagement.interval.observed')
      .sort((a, b) => a.lamport - b.lamport || a.replicaId.localeCompare(b.replicaId));
  return {
    store,
    calls,
    // Index count — materializes nothing (only returns the length).
    countIntervals: async () => {
      calls.countIntervals += 1;
      return intervals().length;
    },
    // Newest `keep` intervals only — bounded read.
    readNewestIntervals: async (keep) => {
      const all = intervals();
      const newest = keep >= all.length ? all : all.slice(all.length - keep);
      calls.newestIntervalsRead += newest.length;
      return newest;
    },
    // Non-interval survivors only — bounded by the non-interval count.
    readNonIntervalEvents: async () => {
      const nonInterval = [...store.values()].filter(
        (e) => e.streamName !== 'engagement.interval.observed',
      );
      calls.nonIntervalRead += nonInterval.length;
      return nonInterval;
    },
    put: async (event) => {
      store.set(keyOf(event), event);
    },
    cursorDropOldestIntervals: async (dropCount) => {
      const toDrop = intervals().slice(0, dropCount);
      for (const e of toDrop) store.delete(keyOf(e));
      return toDrop.length;
    },
    deleteDatabase: async () => {
      store.clear();
    },
    recreate: async () => {
      /* schema recreate is a no-op for the Map fake */
    },
    staging,
  };
};

const createFakeStaging = (): CompactionStagingArea & {
  peek: () => readonly BufferedEvent[] | null;
} => {
  let staged: readonly BufferedEvent[] | null = null;
  return {
    peek: () => staged,
    read: async () => staged,
    write: async (survivors) => {
      staged = survivors;
    },
    clear: async () => {
      staged = null;
    },
  };
};

const bigIntervalBacklog = (count: number): BufferedEvent[] => {
  const out: BufferedEvent[] = [];
  for (let i = 0; i < count; i += 1) out.push(interval(i));
  return out;
};

describe('runEventBufferCompaction', () => {
  it('slow path: cursor-drops the oldest surplus intervals, keeps survivors exactly', async () => {
    const events = [aggregate(100), nav(101), interval(1), interval(2), interval(3), interval(4)];
    const ops = createFakeOps(events, createFakeStaging());
    const result = await runEventBufferCompaction(ops, 2);
    expect(result.path).toBe('cursor');
    expect(result.droppedIntervals).toBe(2);
    const surviving = [...ops.store.values()].map(keyOf).sort();
    expect(surviving).toEqual([aggregate(100), nav(101), interval(3), interval(4)].map(keyOf).sort());
  });

  it('is a no-op when nothing needs dropping', async () => {
    const events = [aggregate(1), interval(2)];
    const ops = createFakeOps(events, createFakeStaging());
    const result = await runEventBufferCompaction(ops, 10);
    expect(result.path).toBe('noop');
    expect(result.droppedIntervals).toBe(0);
    expect(ops.store.size).toBe(2);
  });

  it('fast path: stages survivors, wipes, and re-appends when the drop count is huge', async () => {
    const backlog = bigIntervalBacklog(COMPACTION_FAST_PATH_DROP_THRESHOLD + 1_500);
    const events = [aggregate(9_000_000), ...backlog];
    const staging = createFakeStaging();
    const ops = createFakeOps(events, staging);
    const result = await runEventBufferCompaction(ops, 1_000);
    expect(result.path).toBe('recreate');
    expect(result.droppedIntervals).toBe(COMPACTION_FAST_PATH_DROP_THRESHOLD + 500);
    // The aggregate survived the wipe-and-restore.
    expect([...ops.store.values()].some((e) => e.streamName === 'engagement.session.aggregated')).toBe(
      true,
    );
    // Newest 1k intervals survived; oldest were dropped.
    const keptIntervals = [...ops.store.values()].filter(
      (e) => e.streamName === 'engagement.interval.observed',
    );
    expect(keptIntervals).toHaveLength(1_000);
    // Staging cleared on success.
    expect(staging.peek()).toBeNull();
  });

  it('falls back to the crash-safe cursor path when no staging area is available', async () => {
    const backlog = bigIntervalBacklog(COMPACTION_FAST_PATH_DROP_THRESHOLD + 100);
    const events = [aggregate(1), ...backlog];
    const ops = createFakeOps(events, null);
    const result = await runEventBufferCompaction(ops, 1_000);
    // No staging => never take the crash-unsafe deleteDatabase path.
    expect(result.path).toBe('cursor');
    expect([...ops.store.values()].some((e) => e.streamName === 'engagement.session.aggregated')).toBe(
      true,
    );
  });

  it('crash recovery: replays staged survivors left by an interrupted fast-path run', async () => {
    // Simulate the crash window: the prior run staged survivors and wiped
    // the DB, then the SW was evicted before re-appending / clearing. The
    // DB is empty but the staging area still holds the survivors (including
    // the aggregate).
    const staging = createFakeStaging();
    const survivors = [aggregate(5), nav(6), interval(9), interval(10)];
    await staging.write(survivors);
    const ops = createFakeOps([], staging); // empty DB after the wipe

    const result = await runEventBufferCompaction(ops, 1_000);

    // Survivors are back and the staging marker is cleared.
    const restored = [...ops.store.values()].map(keyOf).sort();
    expect(restored).toEqual(survivors.map(keyOf).sort());
    expect(staging.peek()).toBeNull();
    // Nothing left to drop after replay.
    expect(result.droppedIntervals).toBe(0);
  });

  it('re-running compaction converges (idempotent) with no further drops', async () => {
    const events = [aggregate(1), interval(2), interval(3), interval(4), interval(5)];
    const staging = createFakeStaging();
    const ops = createFakeOps(events, staging);
    const first = await runEventBufferCompaction(ops, 2);
    expect(first.droppedIntervals).toBe(2);
    const second = await runEventBufferCompaction(ops, 2);
    expect(second.droppedIntervals).toBe(0);
    expect(second.path).toBe('noop');
  });

  it('never materializes the full backlog to plan — heap stays O(survivors) on the fast path', async () => {
    // The reviewed MAJOR: the prior design did `readAll()` of the WHOLE buffer
    // (~1.2M events in production) before choosing a path — an OOM/crash-loop
    // risk on the exact backlog the fast path targets. The coordinator must
    // now plan from a cheap COUNT and read ONLY the survivors.
    const KEEP = 1_000;
    const NON_INTERVAL = 5; // a handful of aggregates/navs to preserve
    const backlog = bigIntervalBacklog(COMPACTION_FAST_PATH_DROP_THRESHOLD + 20_000);
    const nonInterval = Array.from({ length: NON_INTERVAL }, (_v, i) => aggregate(8_000_000 + i));
    const ops = createFakeOps([...nonInterval, ...backlog], createFakeStaging());

    const result = await runEventBufferCompaction(ops, KEEP);

    expect(result.path).toBe('recreate');
    // The drop decision came from a single index COUNT, not a full read.
    expect(ops.calls.countIntervals).toBe(1);
    // Only the survivors were materialized: the newest KEEP intervals plus the
    // NON_INTERVAL survivors — NEVER the (threshold + 20k) interval backlog.
    expect(ops.calls.newestIntervalsRead).toBe(KEEP);
    expect(ops.calls.nonIntervalRead).toBe(NON_INTERVAL);
    const totalMaterialized =
      ops.calls.newestIntervalsRead + ops.calls.nonIntervalRead;
    expect(totalMaterialized).toBe(KEEP + NON_INTERVAL);
    // Emphatically far below the backlog size.
    expect(totalMaterialized).toBeLessThan(backlog.length);
  });

  it('slow path materializes nothing to plan — count only, then cursor-delete', async () => {
    // Under the fast-path threshold: still no full read. The drop decision is
    // a count; the delete is a cursor. No survivor read happens at all.
    const events = [aggregate(1), interval(2), interval(3), interval(4), interval(5)];
    const ops = createFakeOps(events, createFakeStaging());
    const result = await runEventBufferCompaction(ops, 2);
    expect(result.path).toBe('cursor');
    expect(ops.calls.countIntervals).toBe(1);
    expect(ops.calls.newestIntervalsRead).toBe(0);
    expect(ops.calls.nonIntervalRead).toBe(0);
  });
});
