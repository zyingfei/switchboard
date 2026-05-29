import type { AcceptedEvent } from './causal.js';
import { getCaughtUpSharedEventStore } from './eventStore.js';
import type { EventLog } from './eventLog.js';
import type { ProjectionChangeFeed } from './projectionChanges.js';
import { runImportProjectors } from './projectors.js';

// Periodic anti-entropy. Scans the merged event log every N minutes,
// picks the latest event per aggregate, and re-runs the projector.
// `runImportProjectors` is idempotent — if the on-disk projection
// already matches, the rewrite is a no-op overwrite of identical
// JSON. If a projection file went missing (manual delete, disk
// corruption, partial-write recovery) or fell stale (peer event
// dropped between transports), this round repairs it.
//
// This is the Cassandra "Merkle-tree-free poor-man's read repair"
// pattern: trade some periodic disk I/O for a guarantee that
// projection files converge to the merged log's truth even when
// individual event-time pushes get lost.
//
// Cost: one read of the merged log + one read-by-aggregate per
// unique aggregate + one writeFile per aggregate. For a vault with
// thousands of aggregates this is O(seconds) of disk I/O every
// `intervalMs`. Default cadence is 30 min — frequent enough to
// catch drift before it confuses users, cheap enough to ignore.

export interface StartAntiEntropyDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly projectionChanges?: ProjectionChangeFeed;
  // Cadence in milliseconds. Defaults to 30 minutes.
  readonly intervalMs?: number;
  // Test override — fires the first scan immediately instead of
  // waiting for `intervalMs`.
  readonly fireImmediately?: boolean;
  // Test hook — called after each scan completes, with the number
  // of aggregates re-projected.
  readonly onScanComplete?: (count: number) => void;
}

export interface AntiEntropyHandle {
  readonly stop: () => void;
  // Force a scan now (used by tests + potentially a manual /v1/admin
  // "repair now" endpoint). Resolves after the scan finishes.
  readonly scanNow: () => Promise<number>;
}

const latestPerAggregate = (events: readonly AcceptedEvent[]): readonly AcceptedEvent[] => {
  const byId = new Map<string, AcceptedEvent>();
  for (const event of events) {
    const prior = byId.get(event.aggregateId);
    if (prior === undefined || event.acceptedAtMs >= prior.acceptedAtMs) {
      byId.set(event.aggregateId, event);
    }
  }
  return [...byId.values()];
};

const latestPerAggregateFromLog = async (
  vaultRoot: string,
  eventLog: EventLog,
): Promise<readonly AcceptedEvent[]> => {
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) return latestPerAggregate(await eventLog.readMerged());
  const byId = new Map<string, AcceptedEvent>();
  await store.forEachChunk((chunk) => {
    for (const event of chunk) {
      const prior = byId.get(event.aggregateId);
      if (prior === undefined || event.acceptedAtMs >= prior.acceptedAtMs) {
        byId.set(event.aggregateId, event);
      }
    }
  }, 2000);
  return [...byId.values()];
};

export const startAntiEntropyTask = (deps: StartAntiEntropyDeps): AntiEntropyHandle => {
  const intervalMs = deps.intervalMs ?? 30 * 60 * 1000;
  let stopped = false;

  const scanOnce = async (): Promise<number> => {
    if (stopped) return 0;
    try {
      const latest = await latestPerAggregateFromLog(deps.vaultRoot, deps.eventLog);
      for (const event of latest) {
        if (stopped) break;
        await runImportProjectors(
          {
            vaultRoot: deps.vaultRoot,
            eventLog: deps.eventLog,
            ...(deps.projectionChanges === undefined
              ? {}
              : { projectionChanges: deps.projectionChanges }),
          },
          event,
        ).catch(() => undefined);
      }
      deps.onScanComplete?.(latest.length);
      return latest.length;
    } catch {
      return 0;
    }
  };

  const timer = setInterval(() => {
    void scanOnce();
  }, intervalMs);
  // setInterval keeps the event loop alive on Node; release it so a
  // companion process can shut down cleanly when the loop is otherwise
  // idle. The HTTP server keeps the loop alive while it's listening.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  if (deps.fireImmediately === true) {
    void scanOnce();
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    scanNow: scanOnce,
  };
};
