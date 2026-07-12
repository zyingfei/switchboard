import type { AcceptedEvent } from './causal.js';
import { getCaughtUpSharedEventStore } from './eventStore.js';
import type { EventLog } from './eventLog.js';

// Shared "latest event per aggregate" fold.
//
// `runImportProjectors` reads the merged log per aggregate, so feeding
// it the LATEST event for each aggregateId is sufficient to re-emit the
// canonical projection file. Earlier events for the same aggregate would
// re-do the same work redundantly. This function collapses the three
// near-identical copies that previously lived in reproject.ts,
// antiEntropy.ts, and contract/projectionMaterializer.ts.
//
// BEHAVIOR-PRESERVING COLLAPSE. The three call sites differed only in
// ONE dimension — whether they read the WHOLE log or a TYPE-FILTERED
// subset:
//   - reproject / antiEntropy: read EVERY event type (readMerged /
//     forEachChunk over all rows), then fold latest-per-aggregate.
//   - projectionMaterializer.catchUp: reads ONLY the projection
//     materializer's handled (structural, low-volume) types via
//     streamFiltered / a per-chunk `handles.has(type)` skip, to avoid
//     materialising the ~700MB / ~92%-engagement.interval bulk.
// The `handles` parameter preserves that difference exactly: pass the
// handled type set (projection materializer) or omit it (reproject /
// antiEntropy read all types). streamFiltered returns the same sorted
// order as readMerged().filter(handles), and the fold is order-
// insensitive except for the `>=` acceptedAtMs tie-break which both
// paths already applied identically, so the collapse is byte-identical
// per call site.

// Fold the latest event per aggregateId. `>=` on acceptedAtMs preserves
// the prior behavior where a later-seen event at an equal timestamp wins.
const foldLatestPerAggregate = (
  byId: Map<string, AcceptedEvent>,
  event: AcceptedEvent,
): void => {
  const prior = byId.get(event.aggregateId);
  if (prior === undefined || event.acceptedAtMs >= prior.acceptedAtMs) {
    byId.set(event.aggregateId, event);
  }
};

/**
 * Pick the most recent event per aggregateId from an in-memory list.
 * Kept exported so callers holding an already-materialised array (e.g. a
 * test fixture or a legacy readMerged result) can reuse the identical
 * fold without going through the store/log branch.
 */
export const latestPerAggregate = (
  events: readonly AcceptedEvent[],
): readonly AcceptedEvent[] => {
  const byId = new Map<string, AcceptedEvent>();
  for (const event of events) foldLatestPerAggregate(byId, event);
  return [...byId.values()];
};

/**
 * Read the latest event per aggregateId directly from the durable log
 * (or the shared event store when enabled), without materialising the
 * full merged array in the store path.
 *
 * @param handles Optional type filter. When provided, only events of
 *   these types are folded — matching the projection materializer's
 *   handled-types-only read. When omitted, ALL event types are folded —
 *   matching reproject / antiEntropy's whole-log read. This is the ONLY
 *   behavioral difference between the three collapsed call sites.
 */
export const latestPerAggregateFromLog = async (
  vaultRoot: string,
  eventLog: EventLog,
  handles?: ReadonlySet<string>,
): Promise<readonly AcceptedEvent[]> => {
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    if (handles === undefined) {
      // Whole-log path (reproject / antiEntropy): fold every type.
      return latestPerAggregate(await eventLog.readMerged());
    }
    // Type-filtered path (projection materializer): stream only the
    // handled types so the engagement.interval bulk is never parsed.
    // streamFiltered returns the same sorted order as
    // readMerged().filter(handles), so the fold is byte-identical.
    const byId = new Map<string, AcceptedEvent>();
    for (const event of await eventLog.streamFiltered((e) => handles.has(e.type), handles)) {
      foldLatestPerAggregate(byId, event);
    }
    return [...byId.values()];
  }
  const byId = new Map<string, AcceptedEvent>();
  await store.forEachChunk((chunk) => {
    for (const event of chunk) {
      if (handles !== undefined && !handles.has(event.type)) continue;
      foldLatestPerAggregate(byId, event);
    }
  }, 2000);
  return [...byId.values()];
};
