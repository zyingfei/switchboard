import type { ReactElement } from 'react';

// Render an ISO timestamp in the user's locale. Falls back to the
// raw string when parsing fails so we never silently lose info.
const localTimestamp = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

// Human-friendly duration. `5_000` -> `5s`, `90_000` -> `1m 30s`,
// `3_900_000` -> `1h 5m`. Empty string when missing/zero so the
// caller doesn't render a blank chip.
const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0
      ? `${String(totalMinutes)}m`
      : `${String(totalMinutes)}m ${String(seconds)}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`;
};

export interface TimelineVisit {
  readonly id: string;
  readonly label: string;
  readonly commitTimestamp: string;
  readonly tabSessionIdHash: string;
  readonly engagementClass?: string;
  readonly host?: string;
  readonly url?: string;
  readonly focusedWindowMs?: number;
}

export interface NavigationEdge {
  readonly id: string;
  readonly fromVisitId: string;
  readonly toVisitId: string;
  readonly kind: 'previousVisitId' | 'openerVisitId';
}

export interface CrossReplicaEdge {
  readonly id: string;
  readonly fromVisitId: string;
  readonly replicaId: string;
}

export interface FlowPathViewProps {
  readonly visits: readonly TimelineVisit[];
  readonly navigationEdges: readonly NavigationEdge[];
  readonly crossReplicaEdges: readonly CrossReplicaEdge[];
  readonly onNodeClick: (visitId: string) => void;
  // Resolver for replica aliases ("This browser" / "Browser 2"). When
  // omitted, falls back to a placeholder; never displays the raw
  // replicaId as visible text.
  readonly replicaAlias?: (replicaId: string) => string;
}

const compareVisit = (left: TimelineVisit, right: TimelineVisit): number =>
  left.commitTimestamp.localeCompare(right.commitTimestamp) || left.id.localeCompare(right.id);

export const FlowPathView = ({
  visits,
  navigationEdges,
  crossReplicaEdges,
  onNodeClick,
  replicaAlias,
}: FlowPathViewProps): ReactElement => {
  const visitsByTab = new Map<string, TimelineVisit[]>();
  for (const visit of [...visits].sort(compareVisit)) {
    const list = visitsByTab.get(visit.tabSessionIdHash) ?? [];
    list.push(visit);
    visitsByTab.set(visit.tabSessionIdHash, list);
  }
  const visitById = new Map(visits.map((visit) => [visit.id, visit] as const));
  const tabLabelByHash = new Map(
    [...visitsByTab.keys()].map((tabSessionIdHash, index) => [
      tabSessionIdHash,
      `Tab ${String(index + 1)}`,
    ]),
  );
  // Visit label never falls back to the raw visit id — the upstream
  // derivation (`deriveFlowVisits` in ConnectionsView) already passes
  // a formatted label, so a missing entry means the edge points at a
  // node we couldn't resolve. Use a kind-aware placeholder instead.
  const visitLabel = (visitId: string): string => visitById.get(visitId)?.label ?? '(visit)';
  const replicaName = (replicaId: string): string =>
    replicaAlias !== undefined ? replicaAlias(replicaId) : 'Browser';

  // Map opener edges by destination tab so we can render the
  // "Opened from Tab N" badge next to the tab row that received the
  // navigation. previous_visit_in_tab_session edges stay implicit —
  // the → arrows between visits in the same tab already convey them.
  const openerByDestTab = new Map<string, string>(); // destTab -> sourceTab
  for (const edge of navigationEdges) {
    if (edge.kind !== 'openerVisitId') continue;
    const fromVisit = visitById.get(edge.fromVisitId);
    const toVisit = visitById.get(edge.toVisitId);
    if (fromVisit === undefined || toVisit === undefined) continue;
    if (fromVisit.tabSessionIdHash === toVisit.tabSessionIdHash) continue;
    openerByDestTab.set(toVisit.tabSessionIdHash, fromVisit.tabSessionIdHash);
  }

  return (
    <section className="cx-flow" data-testid="flow-path-view">
      {[...visitsByTab.entries()].map(([tabSessionIdHash, tabVisits]) => {
        const openedFrom = openerByDestTab.get(tabSessionIdHash);
        return (
          <div className="cx-flow-row" key={tabSessionIdHash}>
            <div className="cx-flow-tab" title={tabSessionIdHash}>
              <div className="cx-flow-tab-name">{tabLabelByHash.get(tabSessionIdHash)}</div>
              {openedFrom !== undefined ? (
                <div className="cx-flow-tab-opener">
                  ← opened from {tabLabelByHash.get(openedFrom)}
                </div>
              ) : null}
            </div>
            <div className="cx-flow-visits">
              {tabVisits.map((visit, idx) => {
                const duration = formatDuration(visit.focusedWindowMs);
                const canOpen = visit.url !== undefined && visit.url.length > 0;
                return (
                  <div key={visit.id} className="cx-flow-visit-cell">
                    {idx > 0 ? (
                      <span className="cx-flow-arrow" aria-hidden="true">
                        →
                      </span>
                    ) : null}
                    <div className="cx-flow-visit-wrap">
                      <button
                        type="button"
                        className="cx-flow-visit"
                        title={visit.id}
                        onClick={() => onNodeClick(visit.id)}
                        data-testid={`flow-visit-${visit.id}`}
                      >
                        <span className="cx-flow-visit-title">{visit.label}</span>
                        {visit.host === undefined || visit.host.length === 0 ? null : (
                          <span className="cx-flow-visit-host cx-dim">{visit.host}</span>
                        )}
                        <span className="cx-flow-visit-meta">
                          <span className="cx-mono cx-dim" title={visit.commitTimestamp}>
                            {localTimestamp(visit.commitTimestamp)}
                          </span>
                          {duration.length > 0 ? (
                            <span
                              className="cx-flow-visit-duration"
                              title={`Focused window — ${String(visit.focusedWindowMs ?? 0)}ms`}
                            >
                              {duration}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {canOpen ? (
                        <a
                          className="cx-flow-visit-open"
                          href={visit.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open ${visit.url ?? ''} in a new tab`}
                          aria-label={`Open ${visit.label} in a new tab`}
                          data-testid={`flow-visit-open-${visit.id}`}
                        >
                          ↗
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {crossReplicaEdges.length === 0 ? null : (
        <div className="cx-flow-edges" aria-label="Cross-replica observations">
          {crossReplicaEdges.map((edge) => (
            <span
              key={edge.id}
              className="cx-flow-edge cx-edge-cross-replica"
              data-testid={`flow-cross-replica-edge-${edge.id}`}
              title={edge.replicaId}
            >
              also seen on {replicaName(edge.replicaId)}: {visitLabel(edge.fromVisitId)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
};
