import { useEffect, useRef, useState } from 'react';

import { fetchConnectionsEdge, fetchConnectionsNeighbors } from './client';
import type { ConnectionEdge, ConnectionsScopedResult } from './types';

// Stage 5 polish — Connections refactor (Phase C). Wraps the
// neighbor + edge fetches in dedicated hooks so the root view
// doesn't carry the cancellation tokens, debounce timers, or the
// in-memory cache.
//
// `useConnectionsSnapshot`:
//   - Cache keyed on `(anchor, hops)` so flipping back/forward in
//     anchor history feels instant.
//   - Cache invalidates when the companion's snapshotRevision
//     changes (already on the wire as snapshot.snapshotRevision per
//     Stage 5.2 R4) so users never see stale neighbors.
//   - Cancellation token guards against late-resolve race when the
//     anchor changes while a fetch is in flight.

export interface UseConnectionsSnapshotState {
  readonly snapshot: ConnectionsScopedResult | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

interface CacheEntry {
  readonly result: ConnectionsScopedResult;
  // Snapshot revision at the time the entry was cached. When the
  // companion ships a new revision the entry is dropped on next
  // hit and re-fetched.
  readonly revision: string | undefined;
}

const cacheKey = (anchor: string, hops: number): string => `${anchor}::${String(hops)}`;

export const useConnectionsSnapshot = (
  anchor: string,
  hops: number,
): UseConnectionsSnapshotState => {
  const [snapshot, setSnapshot] = useState<ConnectionsScopedResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState<number>(0);
  // Cache holds previously-fetched results keyed on `(anchor, hops)`.
  // Lives across renders via useRef so the cache survives commit-
  // phase re-renders. Capped at 16 entries to avoid unbounded growth.
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  useEffect(() => {
    if (anchor.trim().length === 0) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return;
    }
    const key = cacheKey(anchor, hops);
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      // Serve the cached result immediately. We still kick off a
      // background re-fetch to revalidate the snapshot revision —
      // if it changed we'll swap the in-memory result.
      setSnapshot(cached.result);
      setError(null);
      setLoading(false);
    } else {
      setLoading(true);
      setError(null);
    }
    let cancelled = false;
    fetchConnectionsNeighbors({ nodeId: anchor, hops }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (!r.ok || r.data === undefined) {
        setError(r.error ?? 'unknown error');
        // Only clear the displayed snapshot if we didn't have a
        // cached fallback. Otherwise keep the cached view visible.
        if (cached === undefined) setSnapshot(null);
        return;
      }
      const next = r.data;
      const revision = next.snapshot.snapshotRevision;
      // Cache eviction: when the cache exceeds 16 entries, drop the
      // oldest one (Map preserves insertion order).
      if (cacheRef.current.size >= 16 && !cacheRef.current.has(key)) {
        const oldest = cacheRef.current.keys().next().value;
        if (oldest !== undefined) cacheRef.current.delete(oldest);
      }
      cacheRef.current.set(key, { result: next, revision });
      // Only update displayed state when the new result differs from
      // the cached one we already showed (revision changed). Avoids
      // a flicker when the revalidation returns byte-identical data.
      if (cached === undefined || cached.revision !== revision) {
        setSnapshot(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [anchor, hops, refreshTick]);

  return {
    snapshot,
    loading,
    error,
    refresh: () => {
      // Drop the cache so the next render fetches fresh data.
      cacheRef.current.clear();
      setRefreshTick((tick) => tick + 1);
    },
  };
};

// useConnectionsEdge — companion enriches selected edges with
// metadata that's stripped from the neighbor scope response
// (e.g. ranker contribution weights). Same cancellation pattern
// as the snapshot hook; no cache needed because the user only
// inspects one edge at a time.
export const useConnectionsEdge = (
  selectedEdge: ConnectionEdge | null,
): ConnectionEdge | null => {
  const [edgeDetail, setEdgeDetail] = useState<ConnectionEdge | null>(null);
  useEffect(() => {
    if (selectedEdge === null) {
      setEdgeDetail(null);
      return;
    }
    setEdgeDetail(null);
    let cancelled = false;
    fetchConnectionsEdge(selectedEdge.id).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data !== undefined) setEdgeDetail(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedEdge]);
  return edgeDetail;
};
