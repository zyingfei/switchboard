import { useEffect, useState, type ReactElement } from 'react';

import { fetchConnectionsEdge, fetchConnectionsNeighbors } from './client';
import type {
  ConnectionEdge,
  ConnectionNode,
  ConnectionNodeKind,
  ConnectionsScopedResult,
} from './types';

// Engineering scaffold for the Connections side-panel view.
//
// Per the PRD, the visual treatment is the UX designer's call. This
// component renders the minimum that satisfies the engineering
// acceptance bar:
//   1. Anchor selection (text input today; designer will replace
//      with a picker that shows recent threads / workstreams).
//   2. Connected nodes grouped by kind (linked panels).
//   3. Provenance drilldown when an edge is clicked.
//   4. Filters (initial: hops only — the designer will add provider
//      / workstream / device filters).
//   5. Honest "no data yet" / "companion offline" states via
//      ResultScope.
//
// When the designer ships their treatment, this scaffold gets
// either replaced or rewritten — the client + types remain the
// stable seam.

type Props = { readonly initialAnchor?: string };

const groupByKind = (nodes: readonly ConnectionNode[]): Map<ConnectionNodeKind, ConnectionNode[]> => {
  const groups = new Map<ConnectionNodeKind, ConnectionNode[]>();
  for (const n of nodes) {
    const list = groups.get(n.kind) ?? [];
    list.push(n);
    groups.set(n.kind, list);
  }
  return groups;
};

export const ConnectionsView = ({ initialAnchor = '' }: Props): ReactElement => {
  const [anchor, setAnchor] = useState<string>(initialAnchor);
  const [hops, setHops] = useState<number>(1);
  const [result, setResult] = useState<ConnectionsScopedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [selectedEdge, setSelectedEdge] = useState<ConnectionEdge | null>(null);
  const [edgeDetail, setEdgeDetail] = useState<ConnectionEdge | null>(null);

  // Fetch when the anchor + hops change (post-mount).
  useEffect(() => {
    if (anchor.trim().length === 0) {
      setResult(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchConnectionsNeighbors({ nodeId: anchor, hops }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok && r.data !== undefined) {
        setResult(r.data);
      } else {
        setError(r.error ?? 'unknown error');
        setResult(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [anchor, hops]);

  // Edge provenance drilldown.
  useEffect(() => {
    if (selectedEdge === null) {
      setEdgeDetail(null);
      return;
    }
    let cancelled = false;
    fetchConnectionsEdge(selectedEdge.id).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data !== undefined) setEdgeDetail(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedEdge]);

  return (
    <div className="bac-connections-view" data-testid="connections-view">
      <header className="bac-connections-header">
        <label>
          Anchor:&nbsp;
          <input
            type="text"
            placeholder="thread:bac_..., workstream:bac_..."
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
            data-testid="connections-anchor-input"
          />
        </label>
        <label>
          Hops:&nbsp;
          <select
            value={hops}
            onChange={(e) => setHops(Number.parseInt(e.target.value, 10) || 1)}
            data-testid="connections-hops-select"
          >
            {[1, 2, 3, 4].map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
      </header>
      {loading ? <div data-testid="connections-loading">Loading…</div> : null}
      {error !== null ? (
        <div data-testid="connections-error" role="alert">
          {error}
        </div>
      ) : null}
      {result !== null ? (
        <ConnectionsResultPanel
          result={result}
          onSelectEdge={(edge) => setSelectedEdge(edge)}
        />
      ) : null}
      {edgeDetail !== null ? <EdgeProvenancePanel edge={edgeDetail} /> : null}
    </div>
  );
};

const ConnectionsResultPanel = ({
  result,
  onSelectEdge,
}: {
  readonly result: ConnectionsScopedResult;
  readonly onSelectEdge: (edge: ConnectionEdge) => void;
}): ReactElement => {
  if (result.scope === 'plugin-active-only-companion-unreachable') {
    return (
      <div data-testid="connections-empty-companion-offline">
        Connections need companion. Connect to see what's related to this anchor.
      </div>
    );
  }
  if (result.snapshot.nodeCount === 0) {
    return (
      <div data-testid="connections-empty">
        Nothing connected. The plugin sees activity as you work; come back later.
      </div>
    );
  }
  const groups = groupByKind(result.snapshot.nodes);
  return (
    <>
      {result.note !== undefined ? (
        <div className="bac-connections-note">{result.note}</div>
      ) : null}
      <section className="bac-connections-groups" data-testid="connections-groups">
        {[...groups.entries()].map(([kind, nodes]) => (
          <div key={kind} className="bac-connections-group" data-testid={`group-${kind}`}>
            <h3>{kind}</h3>
            <ul>
              {nodes.map((n) => (
                <li key={n.id} data-testid={`node-${n.id}`}>
                  {n.label}
                  {n.originReplicaIds.length > 1 ? (
                    <span className="bac-connections-cross-device" title="seen on multiple devices">
                      &nbsp;· {String(n.originReplicaIds.length)}×
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      <section className="bac-connections-edges" data-testid="connections-edges">
        <h3>Edges (click for provenance)</h3>
        <ul>
          {result.snapshot.edges.map((edge) => (
            <li key={edge.id}>
              <button
                type="button"
                onClick={() => onSelectEdge(edge)}
                data-testid={`edge-${edge.id}`}
              >
                {edge.kind}: {edge.fromNodeId} → {edge.toNodeId}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
};

const EdgeProvenancePanel = ({ edge }: { readonly edge: ConnectionEdge }): ReactElement => (
  <aside className="bac-connections-provenance" data-testid="edge-provenance">
    <h4>Why are these connected?</h4>
    <dl>
      <dt>Edge kind</dt>
      <dd>{edge.kind}</dd>
      <dt>Source</dt>
      <dd>{edge.producedBy.source}</dd>
      {edge.producedBy.eventType !== undefined ? (
        <>
          <dt>Event type</dt>
          <dd>{edge.producedBy.eventType}</dd>
        </>
      ) : null}
      {edge.producedBy.dot !== undefined ? (
        <>
          <dt>Origin replica</dt>
          <dd>
            {edge.producedBy.dot.replicaId} · seq {String(edge.producedBy.dot.seq)}
          </dd>
        </>
      ) : null}
      <dt>Observed at</dt>
      <dd>{edge.observedAt}</dd>
      <dt>Confidence</dt>
      <dd>{edge.confidence}</dd>
    </dl>
  </aside>
);
