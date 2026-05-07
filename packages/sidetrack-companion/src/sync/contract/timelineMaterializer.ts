import type { AcceptedEvent } from '../causal.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import { eventTypesForMaterializer } from './registry.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  isBrowserTimelineObservedPayload,
} from '../../timeline/events.js';
import {
  buildDayProjection,
  collectTimelinePayloads,
  dayBucketFor,
  groupByDay,
  type TimelineStore,
} from '../../timeline/projection.js';

// Sync Contract v1 / Class B — timeline projection materializer.
//
// Reduces `browser.timeline.observed` events into daily-bucketed
// projection files at `_BAC/timeline/projections/<YYYY-MM-DD>.json`.
//
// Trigger model:
//   - onAccepted marks the event's UTC day dirty + sets the
//     pending bit. A single in-flight drainer rebuilds every dirty
//     day from the merged log. Bursts coalesce naturally.
//   - catchUp scans the entire merged log, groups by day, and
//     rebuilds every touched day. Used at startup and on relay
//     reconnect so projections converge with whatever events
//     arrived while the materializer was down.
//
// Determinism:
//   The reducer in `timeline/projection.ts` is order-independent +
//   pure; same input events always produce the same projection.
//   No notification dependence — all the materializer needs is the
//   merged event log.

export interface CreateTimelineMaterializerDeps {
  readonly store: TimelineStore;
  readonly eventLog: EventLog;
}

export const createTimelineMaterializer = (
  deps: CreateTimelineMaterializerDeps,
): Materializer => {
  const handles = eventTypesForMaterializer('timeline');
  let pending = false;
  let running = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  // Days touched since the last drain. Set semantics — rebuild
  // each one once. catchUp clears this and rebuilds everything
  // observed in the merged log.
  let dirtyDays = new Set<string>();

  const rebuildDay = async (date: string): Promise<void> => {
    const merged = await deps.eventLog.readMerged();
    const payloads = collectTimelinePayloads(
      merged.filter(
        (e: AcceptedEvent) =>
          e.type === BROWSER_TIMELINE_OBSERVED &&
          isBrowserTimelineObservedPayload(e.payload) &&
          dayBucketFor(e.payload.observedAt) === date,
      ),
    );
    const projection = buildDayProjection(date, payloads);
    await deps.store.putDay(projection);
  };

  const drain = async (): Promise<void> => {
    while (dirtyDays.size > 0) {
      // Snapshot + clear so events arriving during the drain
      // re-mark their day. The next loop iteration picks them up.
      const snapshot = [...dirtyDays];
      dirtyDays = new Set();
      try {
        await Promise.all(snapshot.map((day) => rebuildDay(day)));
        lastSuccessAt = new Date().toISOString();
        lastError = null;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // Drop straight out of the loop — leave dirtyDays as the
        // events that arrived since we cleared it. Next event or
        // next catchUp retries.
        return;
      }
    }
  };

  const requestDrain = (date: string): void => {
    dirtyDays.add(date);
    pending = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        await drain();
      } finally {
        running = false;
        pending = dirtyDays.size > 0;
      }
    })();
  };

  const onAccepted: Materializer['onAccepted'] = (event, _ctx) => {
    if (event.type !== BROWSER_TIMELINE_OBSERVED) return;
    if (!isBrowserTimelineObservedPayload(event.payload)) return;
    const day = dayBucketFor(event.payload.observedAt);
    requestDrain(day);
  };

  const catchUp: Materializer['catchUp'] = async (eventLog) => {
    pending = true;
    try {
      const merged = await eventLog.readMerged();
      const payloads = collectTimelinePayloads(merged);
      const grouped = groupByDay(payloads);
      // Rebuild every day that has at least one event in the merged
      // log. Idempotent; no notification dependence (gate L2-G10
      // analogue for timeline). Days that no longer have events
      // (e.g. all events tombstoned in a future iteration) keep
      // their projection file; if that ever needs cleanup, add a
      // sweep here.
      for (const [date, dayPayloads] of grouped) {
        const projection = buildDayProjection(date, dayPayloads);
        await deps.store.putDay(projection);
      }
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      dirtyDays = new Set();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      pending = dirtyDays.size > 0 || running;
    }
  };

  const awaitIdle: Materializer['awaitIdle'] = async () => {
    while (running || dirtyDays.size > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const health: Materializer['health'] = (): MaterializerHealth => ({
    status: lastError !== null ? 'failed' : pending ? 'degraded' : 'healthy',
    lastSuccessAt,
    lastError,
    pending,
  });

  return {
    name: 'timeline',
    handles,
    onAccepted,
    catchUp,
    awaitIdle,
    health,
  };
};
