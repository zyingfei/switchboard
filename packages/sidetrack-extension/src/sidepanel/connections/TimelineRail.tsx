import type { ReactElement } from 'react';

import type { EntityDisplayCtx } from '../entityDisplay/format';
import type { TimelineRailData } from './timelineWindows';

// Per-replica observation-window header. One row per replica that has
// any observations for the snapshot's reference day; each row's lane
// shows time-of-day windows where the replica reported activity.
// Anchor + neighbor markers overlay the first row so the user can
// see WHEN the anchor was observed relative to other browsing.
export const TimelineRail = ({
  data,
  ctx,
}: {
  readonly data: TimelineRailData;
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  const pct = (h: number): number => (h / 24) * 100;
  return (
    <div className="cx-timeline" data-testid="connections-timeline">
      <div className="cx-timeline-head">
        <span className="cx-timeline-title">Observed activity</span>
        <span className="cx-timeline-sub">Plugin presence — not time tracking</span>
        <span className="cx-grow" />
        <span className="cx-mono cx-dim">{data.date}</span>
      </div>
      <div className="cx-timeline-axis">
        <span />
        <div className="ticks">
          {['12 AM', '3 AM', '6 AM', '9 AM', '12 PM', '3 PM', '6 PM', '9 PM'].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
      <div className="cx-timeline-rows">
        {data.rows.map((row, i) => (
          <div key={row.replicaId} className="cx-timeline-row">
            <div className="device" title={row.replicaId}>
              <span className="cx-replica-dot" />
              <span>{ctx.replicaAlias(row.replicaId)}</span>
            </div>
            <div className="lane">
              {row.windows.map(([a, b], j) => (
                <span
                  key={j}
                  className="obs"
                  style={{ left: `${String(pct(a))}%`, width: `${String(pct(b - a))}%` }}
                />
              ))}
              {/* Anchor marker — only on the first row to avoid noise */}
              {i === 0 && data.anchorTime !== null ? (
                <span
                  className="marker"
                  style={{ left: `${String(pct(data.anchorTime))}%` }}
                  title="Anchor"
                />
              ) : null}
              {i === 0
                ? data.neighborTimes.map((h, k) => (
                    <span
                      key={`n${String(k)}`}
                      className="marker ghost"
                      style={{ left: `${String(pct(h))}%` }}
                      title="Neighbor"
                    />
                  ))
                : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
