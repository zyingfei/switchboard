import type { ReactElement } from 'react';

export interface TimelineVisit {
  readonly id: string;
  readonly label: string;
  readonly commitTimestamp: string;
  readonly tabSessionIdHash: string;
  readonly engagementClass?: string;
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
}

const compareVisit = (left: TimelineVisit, right: TimelineVisit): number =>
  left.commitTimestamp.localeCompare(right.commitTimestamp) || left.id.localeCompare(right.id);

export const FlowPathView = ({
  visits,
  navigationEdges,
  crossReplicaEdges,
  onNodeClick,
}: FlowPathViewProps): ReactElement => {
  const visitsByTab = new Map<string, TimelineVisit[]>();
  for (const visit of [...visits].sort(compareVisit)) {
    const list = visitsByTab.get(visit.tabSessionIdHash) ?? [];
    list.push(visit);
    visitsByTab.set(visit.tabSessionIdHash, list);
  }

  return (
    <section className="cx-flow" data-testid="flow-path-view">
      {[...visitsByTab.entries()].map(([tabSessionIdHash, tabVisits]) => (
        <div className="cx-flow-row" key={tabSessionIdHash}>
          <div className="cx-flow-tab" title={tabSessionIdHash}>
            {tabSessionIdHash}
          </div>
          <div className="cx-flow-visits">
            {tabVisits.map((visit) => (
              <button
                key={visit.id}
                type="button"
                className="cx-flow-visit"
                title={visit.engagementClass}
                onClick={() => onNodeClick(visit.id)}
                data-testid={`flow-visit-${visit.id}`}
              >
                <span className="cx-flow-visit-title">{visit.label}</span>
                <span className="cx-mono cx-dim">{visit.commitTimestamp}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="cx-flow-edges" aria-label="Navigation edges">
        {navigationEdges.map((edge) => (
          <span key={edge.id} className="cx-flow-edge" data-testid={`flow-nav-edge-${edge.id}`}>
            {edge.kind}: {edge.fromVisitId}
            {' -> '}
            {edge.toVisitId}
          </span>
        ))}
        {crossReplicaEdges.map((edge) => (
          <span
            key={edge.id}
            className="cx-flow-edge cx-edge-cross-replica"
            data-testid={`flow-cross-replica-edge-${edge.id}`}
          >
            replica: {edge.fromVisitId}
            {' -> '}
            {edge.replicaId}
          </span>
        ))}
      </div>
    </section>
  );
};
