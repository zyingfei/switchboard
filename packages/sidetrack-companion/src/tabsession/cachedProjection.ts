import type { EventLog } from '../sync/eventLog.js';
import { projectTabSessions, type TabSessionProjection } from './projection.js';

// Per-EventLog cache for `projectTabSessions` results, parallel to
// `urls/cachedProjection.ts`. The /v1/tabsessions/projection and
// /v1/tabsessions/inbox routes recomputed the projection on every
// call by walking the entire event log; under burst load this
// stacked 60+ s of CPU work into the single-threaded loop. Same
// design as the URL projection cache:
//
//   - WeakMap keyed by EventLog so multiple companions in one
//     process get isolated caches (test fixtures, multi-replica
//     simulations).
//   - Single-flight: concurrent callers within one rebuild window
//     share the same in-flight Promise.
//   - 500 ms TTL: side-panel polls every 4 s, so a 500 ms window
//     is enough to coalesce burst fan-out without serving
//     materially stale data.
//   - Explicit invalidation on writes that change tab-session
//     state (POST /v1/tabsessions/{id}/attribute, /resolve, ingest).

interface CacheEntry {
  projection: TabSessionProjection | null;
  cachedAtMs: number;
  inFlight: Promise<TabSessionProjection> | null;
}

const CACHE_TTL_MS = 500;

const caches = new WeakMap<EventLog, CacheEntry>();

const getOrCreateEntry = (eventLog: EventLog): CacheEntry => {
  const existing = caches.get(eventLog);
  if (existing !== undefined) return existing;
  const fresh: CacheEntry = { projection: null, cachedAtMs: 0, inFlight: null };
  caches.set(eventLog, fresh);
  return fresh;
};

export const getCachedTabSessionProjection = async (
  eventLog: EventLog,
): Promise<TabSessionProjection> => {
  const entry = getOrCreateEntry(eventLog);
  const now = Date.now();
  if (entry.projection !== null && now - entry.cachedAtMs < CACHE_TTL_MS) {
    return entry.projection;
  }
  if (entry.inFlight !== null) return entry.inFlight;
  const promise = (async () => {
    const projection = projectTabSessions(await eventLog.readMerged());
    entry.projection = projection;
    entry.cachedAtMs = Date.now();
    return projection;
  })().finally(() => {
    entry.inFlight = null;
  });
  entry.inFlight = promise;
  return promise;
};

export const invalidateCachedTabSessionProjection = (eventLog: EventLog): void => {
  const entry = caches.get(eventLog);
  if (entry === undefined) return;
  entry.projection = null;
  entry.cachedAtMs = 0;
};
