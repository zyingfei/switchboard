import { useMemo, type ReactElement } from 'react';

import { formatEntityDisplay, formatNodeIdDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import { EDGE_KINDS, contentDerivedHint, type EdgeFamily } from './edgeKinds';
import { NodeChip } from './NodeChip';
import { computeOrbitalLayout, type OrbitalLayoutResult } from './orbitalLayout';
import type { ConnectionEdge, ConnectionNode, ConnectionsScopedResult } from './types';

// Center panel for the Orbital sub-mode: SVG-rendered force-directed
// layout of the anchor + its 1-hop / 2-hop neighbors, with edges
// drawn as colored line families. Below the SVG, a horizontal strip
// lists every anchor-touching edge for clickable inspection.

const ORBIT_W = 720;
const ORBIT_H = 480;

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

export const OrbitalCenter = ({
  result,
  anchorId,
  hops,
  selectedEdge,
  onSelectEdge,
  onUseNodeAsAnchor,
  ctx,
}: {
  readonly result: ConnectionsScopedResult;
  readonly anchorId: string;
  readonly hops: number;
  readonly selectedEdge: ConnectionEdge | null;
  readonly onSelectEdge: (edge: ConnectionEdge) => void;
  readonly onUseNodeAsAnchor: (nodeId: string) => void;
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  // Hooks must run on every render — keep the layout call before
  // any early returns.
  const layout: OrbitalLayoutResult = useMemo(
    () =>
      computeOrbitalLayout({
        snapshot: result.snapshot,
        anchorId,
        width: ORBIT_W,
        height: ORBIT_H,
        hops,
      }),
    [result.snapshot, anchorId, hops],
  );
  if (result.snapshot.nodeCount === 0) {
    return (
      <div className="cx-empty" data-testid="connections-empty">
        <h4>Nothing to graph</h4>
        <p>Pick an anchor with at least one neighbor.</p>
      </div>
    );
  }
  const nodeById = new Map<string, ConnectionNode>();
  for (const n of result.snapshot.nodes) nodeById.set(n.id, n);
  const anchorEdges = layout.edges.filter(
    (edge) => edge.fromNodeId === anchorId || edge.toNodeId === anchorId,
  );
  const stripEdges =
    selectedEdge === null
      ? anchorEdges
      : layout.edges.filter(
          (edge) =>
            edge.id === selectedEdge.id ||
            edge.fromNodeId === selectedEdge.fromNodeId ||
            edge.toNodeId === selectedEdge.toNodeId ||
            edge.fromNodeId === selectedEdge.toNodeId ||
            edge.toNodeId === selectedEdge.fromNodeId,
        );

  return (
    <div className="cx-orbit-host" data-testid="connections-orbital">
      <div className="cx-orbit" style={{ minHeight: ORBIT_H }}>
        <div className="cx-orbit-ring" style={{ width: layout.r1 * 2, height: layout.r1 * 2 }} />
        {hops >= 2 ? (
          <div
            className="cx-orbit-ring"
            style={{ width: layout.r2 * 2, height: layout.r2 * 2 }}
          />
        ) : null}
        <div className="cx-orbit-sector-label cx-orbit-sector-top">↑ Containment</div>
        <div className="cx-orbit-sector-label cx-orbit-sector-right">Flow →</div>
        <div className="cx-orbit-sector-label cx-orbit-sector-bottom">↓ Queue · Reminder</div>
        <div className="cx-orbit-sector-label cx-orbit-sector-left">← URL match</div>
        <svg
          className="cx-orbit-svg"
          viewBox={`0 0 ${String(ORBIT_W)} ${String(ORBIT_H)}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          {layout.edges.map((edge) => {
            const meta = EDGE_KINDS[edge.kind];
            const fam: EdgeFamily = meta?.family ?? 'urlmatch';
            const ps = layout.positions.get(edge.fromNodeId)!;
            const pt = layout.positions.get(edge.toNodeId)!;
            const isSel = selectedEdge?.id === edge.id;
            const isDim = selectedEdge !== null && !isSel;
            const cls = [
              'edge',
              `fam-${fam}`,
              edgeConfidenceClass(edge.confidence),
              isSel && 'is-selected',
              isDim && 'is-dim',
            ]
              .filter(Boolean)
              .join(' ');
            return <line key={edge.id} className={cls} x1={ps.x} y1={ps.y} x2={pt.x} y2={pt.y} />;
          })}
        </svg>
        {[...layout.positions.values()].map((p) => {
          const node = nodeById.get(p.id);
          if (node === undefined) return null;
          const isAnchor = p.ring === 0;
          const isDim =
            selectedEdge !== null &&
            !isAnchor &&
            !(selectedEdge.fromNodeId === p.id || selectedEdge.toNodeId === p.id);
          const orbitDisplay = formatEntityDisplay(node, ctx);
          return (
            <button
              type="button"
              key={p.id}
              className="cx-orbit-node"
              onClick={() => {
                onUseNodeAsAnchor(p.id);
              }}
              title={`Use ${orbitDisplay.primary} as anchor`}
              style={{
                left: `${String((p.x / ORBIT_W) * 100)}%`,
                top: `${String((p.y / ORBIT_H) * 100)}%`,
              }}
              data-testid={`orbit-node-${p.id}`}
            >
              <NodeChip
                node={node}
                size={isAnchor ? 'lg' : 'md'}
                state={isAnchor ? 'anchor' : isDim ? undefined : undefined}
                ctx={ctx}
              />
            </button>
          );
        })}
      </div>
      <div className="cx-orbit-edges-strip" data-testid="connections-edges">
        <span className="label">Anchor edges</span>
        {stripEdges.length === 0 ? <span className="cx-mono cx-dim">none</span> : null}
        {stripEdges.map((edge) => {
          const meta = EDGE_KINDS[edge.kind];
          const fam: EdgeFamily = meta?.family ?? 'urlmatch';
          const isSelected = selectedEdge?.id === edge.id;
          const hint = contentDerivedHint(edge.kind);
          return (
            <button
              key={edge.id}
              type="button"
              className={`cx-edgelabel cx-edge-summary ${isSelected ? 'is-selected' : ''}`}
              onClick={() => {
                onSelectEdge(edge);
              }}
              data-testid={`edge-${edge.id}`}
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
              <span className="bac-connections-edge-hint">{meta?.label ?? edge.kind}</span>
              {hint !== null ? (
                <span className="bac-connections-edge-hint" data-testid={`edge-hint-${edge.id}`}>
                  {hint}
                </span>
              ) : null}
            </button>
          );
        })}
        {layout.edges.length > stripEdges.length ? (
          <span className="cx-mono cx-dim">
            {layout.edges.length - stripEdges.length} more in Linked
          </span>
        ) : null}
      </div>
    </div>
  );
};
