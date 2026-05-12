import type { ReactElement } from 'react';

import { formatNodeIdDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import {
  EDGE_KINDS,
  NODE_KIND_DISPLAY,
  NODE_KIND_GROUP_ORDER,
  contentDerivedHint,
  type EdgeFamily,
} from './edgeKinds';
import { KindIcons } from './icons';
import { NodeRow } from './NodeRow';
import type {
  ConnectionEdge,
  ConnectionNode,
  ConnectionNodeKind,
  ConnectionsScopedResult,
} from './types';

// Center panel for the Linked sub-mode: group neighbors by kind,
// then list every provenance edge with its from→to label, family
// line treatment, and content-derived hint.

const KIND_RANK = new Map<ConnectionNodeKind, number>(
  NODE_KIND_GROUP_ORDER.map((k, i) => [k, i] as const),
);

const groupByKind = (
  nodes: readonly ConnectionNode[],
): Map<ConnectionNodeKind, ConnectionNode[]> => {
  const groups = new Map<ConnectionNodeKind, ConnectionNode[]>();
  for (const n of nodes) {
    const list = groups.get(n.kind) ?? [];
    list.push(n);
    groups.set(n.kind, list);
  }
  return groups;
};

const sortGroupKeys = (kinds: readonly ConnectionNodeKind[]): ConnectionNodeKind[] => {
  return [...kinds].sort((a, b) => {
    const ra = KIND_RANK.get(a) ?? 99;
    const rb = KIND_RANK.get(b) ?? 99;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
};

const edgeConfidenceClass = (confidence: ConnectionEdge['confidence']): string =>
  confidence === 'inferred' ? 'confidence-inferred' : '';

const symmetricEdgeKinds = new Set(['closest_visit', 'visit_resembles_visit']);

const edgeKindLabel = (edge: ConnectionEdge): string =>
  EDGE_KINDS[edge.kind]?.label ?? edge.kind.replaceAll('_', ' ');

const edgeEndpointLabel = (
  edge: ConnectionEdge,
  nodeById: ReadonlyMap<string, ConnectionNode>,
  ctx: EntityDisplayCtx,
): string => {
  const from = formatNodeIdDisplay(edge.fromNodeId, nodeById, ctx).primary;
  const to = formatNodeIdDisplay(edge.toNodeId, nodeById, ctx).primary;
  return symmetricEdgeKinds.has(edge.kind) ? `${from} ↔ ${to}` : `${from} → ${to}`;
};

export const LinkedCenter = ({
  result,
  anchorId,
  selectedEdge,
  onSelectEdge,
  onUseNodeAsAnchor,
  onPromoteSnippet,
  onOpenUrl,
  ctx,
}: {
  readonly result: ConnectionsScopedResult;
  readonly anchorId: string;
  readonly selectedEdge: ConnectionEdge | null;
  readonly onSelectEdge: (edge: ConnectionEdge) => void;
  readonly onUseNodeAsAnchor: (nodeId: string) => void;
  readonly onPromoteSnippet: (input: {
    readonly snippetId: string;
    readonly sourceVisitId: string;
  }) => Promise<void>;
  readonly onOpenUrl?: (url: string) => void;
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  if (result.scope === 'plugin-active-only-companion-unreachable') {
    return (
      <div className="cx-empty" data-testid="connections-empty-companion-offline">
        <h4>Connections need companion</h4>
        <p>Connect to see what's related to this anchor.</p>
      </div>
    );
  }
  if (result.snapshot.nodeCount === 0) {
    return (
      <div className="cx-empty" data-testid="connections-empty">
        <h4>Nothing connected</h4>
        <p>The plugin sees activity as you work; come back later.</p>
      </div>
    );
  }
  const neighbors = result.snapshot.nodes.filter((n) => n.id !== anchorId);
  const groups = groupByKind(neighbors);
  const orderedKinds = sortGroupKeys([...groups.keys()]);
  const nodeById = new Map(result.snapshot.nodes.map((node) => [node.id, node] as const));
  const edgesByOtherEnd = new Map<string, ConnectionEdge>();
  for (const e of result.snapshot.edges) {
    if (e.fromNodeId === anchorId && !edgesByOtherEnd.has(e.toNodeId)) {
      edgesByOtherEnd.set(e.toNodeId, e);
    }
    if (e.toNodeId === anchorId && !edgesByOtherEnd.has(e.fromNodeId)) {
      edgesByOtherEnd.set(e.fromNodeId, e);
    }
  }
  return (
    <div data-testid="connections-groups">
      {result.note !== undefined ? (
        <div className="cx-mono cx-dim cx-note">{result.note}</div>
      ) : null}
      {orderedKinds.map((kind) => {
        const display = NODE_KIND_DISPLAY[kind];
        const nodes = groups.get(kind) ?? [];
        const plural = nodes.length === 1 ? display.label : `${display.label}s`;
        return (
          <section key={kind} data-testid={`group-${kind}`}>
            <header className="cx-group-head">
              <span className={`cx-node-icon ${display.tintClass}`} aria-hidden>
                {KindIcons[kind]}
              </span>
              <h3>{plural}</h3>
              <span className="cx-count">{nodes.length}</span>
            </header>
            <div className="cx-grouplist">
              {nodes.map((n) => {
                const edge = edgesByOtherEnd.get(n.id);
                return (
                  <NodeRow
                    key={n.id}
                    node={n}
                    edge={edge ?? null}
                    direction={edge?.fromNodeId === anchorId ? 'out' : 'in'}
                    selected={selectedEdge?.id === edge?.id && edge !== undefined}
                    onPromoteSnippet={onPromoteSnippet}
                    onUseAsAnchor={() => {
                      onUseNodeAsAnchor(n.id);
                    }}
                    onClick={() => {
                      if (edge !== undefined) onSelectEdge(edge);
                    }}
                    ctx={ctx}
                    {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
      <section className="cx-section cx-edge-section" data-testid="connections-edges">
        <h4>Provenance edges</h4>
        <p className="cx-edge-section-note">Click an edge to inspect why Sidetrack connected it.</p>
        <div className="cx-edge-list">
          {result.snapshot.edges.map((edge) => {
            const meta = EDGE_KINDS[edge.kind];
            const fam: EdgeFamily = meta?.family ?? 'urlmatch';
            const hint = contentDerivedHint(edge.kind);
            const isSelected = selectedEdge?.id === edge.id;
            return (
              <button
                key={edge.id}
                type="button"
                onClick={() => {
                  onSelectEdge(edge);
                }}
                data-testid={`edge-${edge.id}`}
                className={`cx-edgelabel cx-edge-summary ${isSelected ? 'is-selected' : ''}`}
                title={`${edgeEndpointLabel(edge, nodeById, ctx)} · ${edgeKindLabel(edge)}`}
              >
                <span
                  className={`cx-edge fam-${fam} ${edgeConfidenceClass(edge.confidence)}`.trim()}
                  aria-hidden
                >
                  <span className="cx-edge-line" />
                </span>
                <span className="cx-edge-summary-main">
                  {edgeEndpointLabel(edge, nodeById, ctx)}
                </span>
                <span className="bac-connections-edge-hint">{edgeKindLabel(edge)}</span>
                {hint !== null ? (
                  <span className="bac-connections-edge-hint" data-testid={`edge-hint-${edge.id}`}>
                    {hint}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
};
