import type { ReactElement } from 'react';

import type { EntityDisplayCtx } from '../entityDisplay/format';

// Compact "seen on N devices" badge. Renders up to three dots + a
// count multiplier when there are >1 origin replicas. The tooltip
// resolves each replicaId through `ctx.replicaAlias` so users see
// human aliases ("This browser, Browser 2") instead of raw ULIDs.
export const ReplicaDots = ({
  replicaIds,
  ctx,
}: {
  readonly replicaIds: readonly string[];
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  const count = replicaIds.length;
  const aliases = replicaIds.map((id) => ctx.replicaAlias(id)).join(', ');
  const tooltip =
    count === 1 ? `Seen on ${aliases}` : `Seen on ${String(count)} devices · ${aliases}`;
  return (
    <span className="cx-replicas" title={tooltip}>
      {Array.from({ length: Math.min(count, 3) }).map((_, i) => (
        <span key={i} className="cx-replica-dot" />
      ))}
      {count > 1 ? <span className="cx-dim">{`${String(count)}×`}</span> : null}
    </span>
  );
};
