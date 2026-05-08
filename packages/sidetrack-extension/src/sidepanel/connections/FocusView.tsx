import { useState, type ReactElement } from 'react';

export type EngagementClass =
  | 'parked_background'
  | 'glanced'
  | 'skimmed'
  | 'engaged_read'
  | 'worked_on_reference'
  | 'source_extracted'
  | 'execution_source';

export interface TopicNode {
  readonly id: string;
  readonly label: string;
  readonly memberCount: number;
  readonly cohesion: number;
  readonly dominantWorkstreamId?: string;
}

export interface TopicVisit {
  readonly id: string;
  readonly label: string;
  readonly focusedWindowMs: number;
}

export interface FocusViewProps {
  readonly topics: readonly TopicNode[];
  readonly visitsByTopic: Record<string, readonly TopicVisit[]>;
  readonly engagementClassesByVisit: Record<string, EngagementClass>;
  readonly onTopicClick: (topicId: string) => void;
  readonly onVisitClick: (visitId: string) => void;
}

export const FocusView = ({
  topics,
  visitsByTopic,
  engagementClassesByVisit,
  onTopicClick,
  onVisitClick,
}: FocusViewProps): ReactElement => {
  const [expandedTopicIds, setExpandedTopicIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const toggle = (topicId: string): void => {
    setExpandedTopicIds((current) => {
      const next = new Set(current);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  };

  return (
    <section className="cx-focus" data-testid="focus-view">
      {topics.map((topic) => {
        const visits = [...(visitsByTopic[topic.id] ?? [])].sort(
          (left, right) =>
            right.focusedWindowMs - left.focusedWindowMs || left.id.localeCompare(right.id),
        );
        const expanded = expandedTopicIds.has(topic.id);
        return (
          <article className="cx-focus-card" key={topic.id} data-testid={`focus-topic-${topic.id}`}>
            <button type="button" className="cx-focus-title" onClick={() => onTopicClick(topic.id)}>
              {topic.label}
            </button>
            <div className="cx-focus-meta">
              <span>{topic.memberCount} members</span>
              <span>cohesion {topic.cohesion.toFixed(2)}</span>
              {topic.dominantWorkstreamId === undefined ? null : (
                <span className="cx-focus-chip">Workstream</span>
              )}
            </div>
            <div className="cx-focus-bar" aria-hidden>
              <span
                style={{ width: `${String(Math.max(0, Math.min(1, topic.cohesion)) * 100)}%` }}
              />
            </div>
            <button
              type="button"
              className="cx-focus-expand"
              onClick={() => toggle(topic.id)}
              data-testid={`focus-expand-${topic.id}`}
            >
              {expanded ? 'Hide visits' : 'Show visits'}
            </button>
            {expanded ? (
              <div className="cx-focus-visits">
                {visits.map((visit) => (
                  <button
                    type="button"
                    key={visit.id}
                    className="cx-focus-visit"
                    onClick={() => onVisitClick(visit.id)}
                    data-testid={`focus-visit-${visit.id}`}
                  >
                    <span
                      className={`cx-engagement-dot cx-engagement-${
                        engagementClassesByVisit[visit.id] ?? 'parked_background'
                      }`}
                      data-testid={`engagement-dot-${visit.id}`}
                    />
                    <span>{visit.label}</span>
                    <span className="cx-mono cx-dim">{visit.focusedWindowMs} ms</span>
                  </button>
                ))}
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
};
