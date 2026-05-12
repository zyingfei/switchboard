import type { EventLog } from '../sync/eventLog.js';
import { projectUrls, type UrlProjection } from './projection.js';

// `/v1/visits/projection` and `/v1/visits/inbox` were rebuilding the
// URL projection from scratch on every call by walking the entire
// event log. Under burst load — engagement events landing every 30s
// per active tab, side-panel polling on 4s — the companion's single-
// threaded Node loop pegged at ~170% CPU and HTTP probes timed out
// past 5 s. The side panel then read the timeout as `companion
// disconnected` and flashed the red pill.
//
// The fix is a per-EventLog cache that:
//   1. Coalesces concurrent rebuilds (single-flight). N concurrent
//      callers share one rebuild instead of starting N of them.
//   2. Serves cached results for a brief TTL (500 ms) so a side-panel
//      burst of 4 polls in 200 ms only rebuilds once.
//   3. Invalidates on append so a mutation route's read sees its own
//      writes.
//
// Scoped to the EventLog instance via a WeakMap so test fixtures
// that spin up multiple companions in the same process get isolated
// caches and GC when the event log is dropped.

interface CacheEntry {
  projection: UrlProjection | null;
  cachedAtMs: number;
  inFlight: Promise<UrlProjection> | null;
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

export const getCachedUrlProjection = async (eventLog: EventLog): Promise<UrlProjection> => {
  const entry = getOrCreateEntry(eventLog);
  const now = Date.now();
  if (entry.projection !== null && now - entry.cachedAtMs < CACHE_TTL_MS) {
    return entry.projection;
  }
  if (entry.inFlight !== null) return entry.inFlight;
  const promise = (async () => {
    const projection = projectUrls(await eventLog.readMerged());
    entry.projection = projection;
    entry.cachedAtMs = Date.now();
    return projection;
  })().finally(() => {
    entry.inFlight = null;
  });
  entry.inFlight = promise;
  return promise;
};

export const invalidateCachedUrlProjection = (eventLog: EventLog): void => {
  const entry = caches.get(eventLog);
  if (entry === undefined) return;
  entry.projection = null;
  entry.cachedAtMs = 0;
};
