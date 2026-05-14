import { useMemo, useState, type ReactElement } from 'react';

import { formatNodeIdDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import { fetchConnectionsPath, type ConnectionsPathResult } from './client';
import { NODE_KIND_DISPLAY } from './edgeKinds';
import { KindIcons } from './icons';
import { NodeSearchBox, type SearchableAnchor } from './NodeSearchBox';
import type { ConnectionNode } from './types';

// Stage 5 polish — Connections path-finding UI. The companion has
// supported `GET /v1/connections/path` since the early Connections
// roll-out, but no surface ever called it. This strip lets users
// ask "how do I get from anchor X to node Y?" — concrete answers
// to "are these two threads related" and "what's the chain from
// this dispatch to that visit?"
//
// Surfaces as a collapsible row below the mode tabs. When opened,
// shows a NodeSearchBox that picks the "to" node from the loaded
// snapshot + the search-pool extras, then fires the path fetch.
// The path renders as a horizontal chain of pills with → arrows
// between them; each pill is clickable (becomes the new anchor).

export interface PathFinderProps {
  readonly anchorId: string;
  readonly anchorLabel: string | null;
  readonly nodes: readonly ConnectionNode[];
  readonly extras: readonly SearchableAnchor[];
  readonly ctx: EntityDisplayCtx;
  readonly onNodeClick: (nodeId: string) => void;
}

type PathState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly toNodeId: string }
  | { readonly kind: 'found'; readonly toNodeId: string; readonly result: ConnectionsPathResult }
  | { readonly kind: 'not-found'; readonly toNodeId: string }
  | { readonly kind: 'error'; readonly toNodeId: string; readonly message: string };

export const PathFinder = ({
  anchorId,
  anchorLabel,
  nodes,
  extras,
  ctx,
  onNodeClick,
}: PathFinderProps): ReactElement => {
  const [open, setOpen] = useState<boolean>(false);
  const [pathState, setPathState] = useState<PathState>({ kind: 'idle' });

  const findPath = (toNodeId: string): void => {
    if (anchorId.length === 0 || toNodeId === anchorId) return;
    setPathState({ kind: 'loading', toNodeId });
    void fetchConnectionsPath({ fromNodeId: anchorId, toNodeId }).then((response) => {
      if (!response.ok || response.data === undefined) {
        setPathState({
          kind: 'error',
          toNodeId,
          message: response.error ?? 'Path lookup failed',
        });
        return;
      }
      if (!response.data.found) {
        setPathState({ kind: 'not-found', toNodeId });
        return;
      }
      setPathState({ kind: 'found', toNodeId, result: response.data });
    });
  };

  // Merge incoming snapshot nodes with the path's own nodes so the
  // pills can render with rich formatting when the path returns
  // nodes that weren't in the original neighbor scope.
  const nodeById = useMemo(() => {
    const m = new Map<string, ConnectionNode>();
    for (const n of nodes) m.set(n.id, n);
    if (pathState.kind === 'found') {
      for (const n of pathState.result.nodes ?? []) m.set(n.id, n);
    }
    return m;
  }, [nodes, pathState]);

  if (anchorId.length === 0) {
    // No anchor → nothing to path FROM. Don't render the strip at all
    // (avoids a useless control next to the mode tabs).
    return <></>;
  }

  return (
    <section className="cx-pathfinder" data-testid="connections-pathfinder">
      <button
        type="button"
        className="cx-pathfinder-toggle"
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        aria-expanded={open}
        data-testid="connections-pathfinder-toggle"
        title={
          open
            ? 'Hide path finder'
            : `Find a path from ${anchorLabel ?? 'anchor'} to another node`
        }
      >
        {open ? '▾' : '▸'} Path from{' '}
        <span className="cx-pathfinder-anchor">{anchorLabel ?? '(anchor)'}</span>
      </button>
      {open ? (
        <div className="cx-pathfinder-body">
          <div className="cx-pathfinder-search">
            <NodeSearchBox
              nodes={nodes.filter((n) => n.id !== anchorId)}
              extras={extras}
              ctx={ctx}
              onPick={(toNodeId) => {
                findPath(toNodeId);
              }}
              maxResults={6}
            />
          </div>
          {pathState.kind === 'loading' ? (
            <div className="cx-pathfinder-status mono cx-dim">
              Searching for a path…
            </div>
          ) : null}
          {pathState.kind === 'error' ? (
            <div className="cx-pathfinder-status warn" data-testid="connections-pathfinder-error">
              {pathState.message}
            </div>
          ) : null}
          {pathState.kind === 'not-found' ? (
            <div
              className="cx-pathfinder-status cx-dim"
              data-testid="connections-pathfinder-empty"
            >
              No path within {`${4} hops`}. Increase hop count or pick a closer node.
            </div>
          ) : null}
          {pathState.kind === 'found' && pathState.result.nodes !== undefined ? (
            <div className="cx-pathfinder-chain" data-testid="connections-pathfinder-chain">
              {pathState.result.nodes.map((node, idx) => {
                const display = formatNodeIdDisplay(node.id, nodeById, ctx);
                const tintClass = (NODE_KIND_DISPLAY as Record<string, { tintClass: string }>)[
                  node.kind
                ]?.tintClass;
                const Icon = (KindIcons as Record<string, ReactElement>)[node.kind];
                return (
                  <span className="cx-pathfinder-step" key={node.id}>
                    <button
                      type="button"
                      className={`cx-pathfinder-pill ${tintClass ?? ''}`}
                      onClick={() => {
                        onNodeClick(node.id);
                      }}
                      title={display.tooltip ?? display.primary}
                      data-testid={`connections-pathfinder-pill-${node.id}`}
                    >
                      {tintClass !== undefined ? (
                        <span className="cx-node-icon" aria-hidden>
                          {Icon}
                        </span>
                      ) : null}
                      <span className="cx-pathfinder-pill-label">{display.primary}</span>
                    </button>
                    {idx < (pathState.result.nodes?.length ?? 0) - 1 ? (
                      <span className="cx-pathfinder-arrow" aria-hidden>
                        →
                      </span>
                    ) : null}
                  </span>
                );
              })}
              {pathState.result.edges !== undefined ? (
                <span className="cx-pathfinder-edgecount mono cx-dim">
                  {pathState.result.edges.length} edge
                  {pathState.result.edges.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};
