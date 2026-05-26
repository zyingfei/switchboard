import type { ReactElement } from 'react';

import type { EntityDisplayCtx } from '../entityDisplay/format';
import type { TimelineRailData } from './timelineWindows';

// Per-replica observation-window header. One row per replica that has
// observations inside the selected Window; each row's lane shows when
// the plugin reported activity. Anchor + neighbor markers overlay the
// first row so the user can see WHEN the anchor was observed relative
// to other browsing.
export const TimelineRail = ({
  data,
  ctx,
  highlightedNodeId,
  onHoverNode,
}: {
  readonly data: TimelineRailData;
  readonly ctx: EntityDisplayCtx;
  readonly highlightedNodeId?: string | null;
  readonly onHoverNode?: (nodeId: string | null) => void;
}): ReactElement => {
  const pct = (ms: number): number =>
    ((ms - data.startMs) / Math.max(1, data.endMs - data.startMs)) * 100;
  // Replica labels are alias-only — never expose the raw replica id
  // (or a truncated form of it) in visible text. "This browser" /
  // "Browser 2" etc. come from `ctx.replicaAlias`, with a generic
  // placeholder while the alias map is still hydrating.
  const replicaLabel = (replicaId: string): string => {
    const alias = ctx.replicaAlias(replicaId);
    if (alias === 'This browser') return 'This browser (current)';
    return alias;
  };
  const markerTitle = (marker: TimelineRailData['markers'][number]): string => {
    const kind = marker.kind === 'anchor' ? 'Anchor' : 'Related';
    const when = new Date(marker.timeMs).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${kind}: ${marker.label} · ${when}`;
  };
  const markers = data.markers;
  return (
    <div className="cx-timeline" data-testid="connections-timeline">
      <div className="cx-timeline-head">
        <span className="cx-timeline-title">Observed activity</span>
        <span className="cx-timeline-sub">
          Plugin presence, not time tracking · {data.rangeLabel} · scale: {data.scaleLabel}
        </span>
        <div className="cx-timeline-legend" aria-label="Timeline legend">
          <span>
            <span className="cx-timeline-icon is-presence" aria-hidden />
            Presence
          </span>
          <span>
            <span className="cx-timeline-icon is-anchor" aria-hidden>
              A
            </span>
            Anchor
          </span>
          <span>
            <span className="cx-timeline-icon is-related" aria-hidden>
              R
            </span>
            Related
          </span>
        </div>
        <span className="cx-grow" />
        <span className="cx-mono cx-dim">{data.date}</span>
      </div>
      <div className="cx-timeline-axis">
        <span />
        <div className="ticks">
          {data.ticks.map((tick) => (
            <span key={`${tick.label}-${String(tick.ms)}`}>{tick.label}</span>
          ))}
        </div>
      </div>
      <div className="cx-timeline-rows">
        {data.rows.map((row, i) => (
          <div key={row.replicaId} className="cx-timeline-row">
            <div className="device">
              <span className="cx-replica-dot" />
              <span>{replicaLabel(row.replicaId)}</span>
            </div>
            <div className="lane">
              {row.windows.map(([a, b], j) => (
                <span
                  key={j}
                  className="obs"
                  style={{ left: `${String(pct(a))}%`, width: `${String(pct(b) - pct(a))}%` }}
                  aria-label="Plugin presence window"
                />
              ))}
              {i === 0
                ? markers.map((marker) => (
                    <span
                      key={marker.id}
                      className={[
                        'marker',
                        marker.kind,
                        highlightedNodeId === marker.nodeId ? 'is-hovered' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ left: `${String(pct(marker.timeMs))}%` }}
                      title={markerTitle(marker)}
                      aria-label={`${marker.kind === 'anchor' ? 'Anchor' : 'Related'} observation for ${marker.label}`}
                      data-testid={
                        marker.kind === 'anchor'
                          ? 'timeline-marker-anchor'
                          : `timeline-marker-related-${marker.nodeId}`
                      }
                      data-node-id={marker.nodeId}
                      onMouseEnter={() => {
                        onHoverNode?.(marker.nodeId);
                      }}
                      onMouseLeave={() => {
                        onHoverNode?.(null);
                      }}
                      onFocus={() => {
                        onHoverNode?.(marker.nodeId);
                      }}
                      onBlur={() => {
                        onHoverNode?.(null);
                      }}
                      tabIndex={0}
                    >
                      <span className="marker-icon" aria-hidden>
                        {marker.kind === 'anchor' ? 'A' : 'R'}
                      </span>
                    </span>
                  ))
                : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
