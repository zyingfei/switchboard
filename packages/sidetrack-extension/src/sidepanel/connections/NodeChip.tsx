import type { ReactElement } from 'react';

import { formatEntityDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import { nodeKindDisplayFor } from './edgeKinds';
import { KindIcons } from './icons';
import type { ConnectionNode } from './types';

// Badge-style node display: icon + kind label + primary title.
// Used in the anchor bar, orbital graph, provenance card, and
// anchor summary. The visible primary line ALWAYS goes through
// `formatEntityDisplay(node, ctx)` so raw internal ids never leak;
// the tooltip carries the canonical url / bac_id for power users.
export const NodeChip = ({
  node,
  state,
  size = 'md',
  ctx,
}: {
  readonly node: ConnectionNode;
  readonly state?: 'anchor' | 'selected';
  readonly size?: 'md' | 'lg';
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  const display = nodeKindDisplayFor(node.kind);
  const entity = formatEntityDisplay(node, ctx);
  const cls =
    `cx-node ${display.tintClass}` +
    (size === 'lg' ? ' lg' : '') +
    (state === 'anchor' ? ' is-anchor' : '') +
    (state === 'selected' ? ' is-selected' : '');
  return (
    <div className={cls} data-testid={`node-${node.id}`} title={entity.tooltip}>
      <span className="cx-node-icon" aria-hidden>
        {KindIcons[node.kind]}
      </span>
      <span className="cx-node-body">
        <span className="cx-node-kind">{display.label}</span>
        <span className="cx-node-title">{entity.primary}</span>
      </span>
    </div>
  );
};
