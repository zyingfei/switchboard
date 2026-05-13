import { useState, type ReactElement } from 'react';

import { formatEntityDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import { EDGE_KINDS, nodeKindDisplayFor } from './edgeKinds';
import { KindIcons } from './icons';
import { ReplicaDots } from './ReplicaDots';
import type { ConnectionEdge, ConnectionNode } from './types';

// List-row variant of a node — used inside the Linked center panel
// to render every neighbor of the anchor. Carries the row click
// (selects the edge), a "Use as anchor" quick action, an optional
// "Go to tab" affordance for URL-bearing nodes, and a "Promote"
// affordance for snippets that have a source visit attached.

const metadataString = (
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const snippetSourceVisitId = (node: ConnectionNode, edge: ConnectionEdge | null): string | null => {
  if (node.kind !== 'snippet' || edge === null) return null;
  if (edge.kind === 'snippet_copied_from_visit' && edge.fromNodeId === node.id) {
    return edge.toNodeId;
  }
  return null;
};

export const NodeRow = ({
  node,
  edge,
  direction,
  selected,
  onPromoteSnippet,
  onUseAsAnchor,
  onClick,
  onOpenUrl,
  ctx,
}: {
  readonly node: ConnectionNode;
  readonly edge: ConnectionEdge | null;
  readonly direction: 'in' | 'out';
  readonly selected: boolean;
  readonly onPromoteSnippet?: (input: {
    readonly snippetId: string;
    readonly sourceVisitId: string;
  }) => Promise<void>;
  readonly onUseAsAnchor: () => void;
  readonly onClick: () => void;
  readonly onOpenUrl?: (url: string) => void;
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  const openUrl = metadataString(node.metadata, ['url', 'canonicalUrl']);
  const canOpenTab = onOpenUrl !== undefined && openUrl !== undefined && openUrl.length > 0;
  const [promoting, setPromoting] = useState<boolean>(false);
  const [promoteStatus, setPromoteStatus] = useState<'saved' | 'error' | null>(null);
  const display = nodeKindDisplayFor(node.kind);
  const entity = formatEntityDisplay(node, ctx);
  const meta = edge !== null ? EDGE_KINDS[edge.kind] : null;
  const cls = `cx-row ${display.tintClass} ${selected ? 'is-selected' : ''}`;
  const sourceVisitId = snippetSourceVisitId(node, edge);
  const canPromote =
    onPromoteSnippet !== undefined && node.kind === 'snippet' && sourceVisitId !== null;
  const promote = (): void => {
    if (!canPromote || sourceVisitId === null) return;
    setPromoting(true);
    setPromoteStatus(null);
    void onPromoteSnippet({ snippetId: node.id, sourceVisitId })
      .then(() => {
        setPromoteStatus('saved');
      })
      .catch(() => {
        setPromoteStatus('error');
      })
      .finally(() => {
        setPromoting(false);
      });
  };
  return (
    <div className={cls} data-testid={`node-${node.id}`}>
      <button type="button" onClick={onClick} className="cx-row-click">
        <span className={`cx-node-icon ${display.tintClass}`} aria-hidden>
          {KindIcons[node.kind]}
        </span>
        <span className="cx-row-body">
          <span className="cx-row-title" title={entity.tooltip}>
            {entity.primary}
          </span>
          <span className="cx-row-meta">
            <span>{display.label}</span>
            {entity.secondary !== undefined ? (
              <>
                <span>·</span>
                <span>{entity.secondary}</span>
              </>
            ) : node.lastSeenAt !== undefined ? (
              <>
                <span>·</span>
                <span>{node.lastSeenAt.slice(0, 10)}</span>
              </>
            ) : null}
            {node.originReplicaIds.length > 0 ? (
              <>
                <span>·</span>
                <ReplicaDots replicaIds={node.originReplicaIds} ctx={ctx} />
              </>
            ) : null}
          </span>
        </span>
        {meta !== null ? (
          <span className="cx-row-edge">
            {direction === 'out' ? `→ ${meta.label}` : meta.label}
          </span>
        ) : null}
      </button>
      {canPromote ? (
        <button
          type="button"
          className="cx-focus-expand"
          disabled={promoting}
          onClick={promote}
          data-testid={`snippet-promote-${node.id}`}
        >
          {promoteStatus === 'saved' ? 'Promoted' : promoteStatus === 'error' ? 'Retry' : 'Promote'}
        </button>
      ) : null}
      {canOpenTab ? (
        <button
          type="button"
          className="cx-focus-expand cx-row-open-tab"
          onClick={() => {
            onOpenUrl(openUrl);
          }}
          data-testid={`node-open-${node.id}`}
          title={`Open ${openUrl} in a tab`}
        >
          Go to tab
        </button>
      ) : null}
      <button
        type="button"
        className="cx-focus-expand cx-row-anchor-action"
        onClick={onUseAsAnchor}
        data-testid={`node-anchor-${node.id}`}
        title={`Use ${entity.primary} as anchor`}
      >
        Open
      </button>
    </div>
  );
};
