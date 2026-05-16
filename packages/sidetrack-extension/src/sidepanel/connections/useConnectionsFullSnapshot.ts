import { useEffect, useRef, useState } from 'react';

import { fetchConnectionsSnapshot, type ConnectionsTopicVariant } from './client';
import type { ConnectionEdge, ConnectionNode, ConnectionsSnapshot } from './types';

// Stage 5 polish — Connections backend search. The anchor-scoped
// neighbor route (`/v1/connections/nodes/{id}/neighbors?hops=N`)
// returns only nodes within N hops of the anchor. The
// find-by-title search was operating on that scope, which made it
// useless for "find any thread/visit/topic in my vault".
//
// This hook pulls the FULL snapshot (`/v1/connections`, no
// anchor) once on first call and caches the result for the rest
// of the side-panel session. The snapshot is bigger (~2 MB in
// the recorder vault) but downloading it once is cheaper than
// every individual neighbor fetch combined.
//
// State machine:
//   idle    — not yet requested
//   loading — fetch in flight
//   ready   — nodes available; cached for the session
//   error   — fetch failed; usable fallback is empty pool
//
// `prime()` triggers the fetch if it hasn't run; returns
// immediately if already loading/ready. UI invokes it when the
// search box gains focus so the cost is paid on demand.

interface FullSnapshotState {
  readonly kind: 'idle' | 'loading' | 'ready' | 'error';
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
  readonly error?: string;
}

export interface UseFullSnapshotResult {
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly prime: () => void;
}

const EMPTY_NODES: readonly ConnectionNode[] = [];
const EMPTY_EDGES: readonly ConnectionEdge[] = [];

export const useConnectionsFullSnapshot = (input: {
  readonly topicVariant?: ConnectionsTopicVariant;
} = {}): UseFullSnapshotResult => {
  const topicVariant = input.topicVariant;
  const [state, setState] = useState<FullSnapshotState>({
    kind: 'idle',
    nodes: EMPTY_NODES,
    edges: EMPTY_EDGES,
  });
  const inFlight = useRef<boolean>(false);

  const prime = (): void => {
    if (inFlight.current || state.kind === 'ready') return;
    inFlight.current = true;
    setState({ kind: 'loading', nodes: state.nodes, edges: state.edges });
    void fetchConnectionsSnapshot(topicVariant === undefined ? {} : { topicVariant })
      .then((response) => {
        inFlight.current = false;
        if (!response.ok || response.data === undefined) {
          setState({
            kind: 'error',
            nodes: EMPTY_NODES,
            edges: EMPTY_EDGES,
            error: response.error ?? 'unknown error',
          });
          return;
        }
        const snapshot: ConnectionsSnapshot = response.data.snapshot;
        setState({ kind: 'ready', nodes: snapshot.nodes, edges: snapshot.edges });
      })
      .catch((error: unknown) => {
        inFlight.current = false;
        setState({
          kind: 'error',
          nodes: EMPTY_NODES,
          edges: EMPTY_EDGES,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  // Optional: keep the snapshot warm by re-priming on a schedule
  // (e.g. invalidate every 60s) — left out for v1 to keep the
  // round-trip count down. The user can hit the Refresh button
  // on the anchor bar to force a re-fetch via the cache drop.
  useEffect(() => {
    // No-op. Reserved for future cache-staleness logic.
  }, []);

  return {
    nodes: state.nodes,
    edges: state.edges,
    loading: state.kind === 'loading',
    error: state.kind === 'error' ? state.error ?? null : null,
    prime,
  };
};
