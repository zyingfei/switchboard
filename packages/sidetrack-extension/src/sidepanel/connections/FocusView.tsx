import { useState, type ReactElement } from 'react';

export const ENGAGEMENT_CLASSES = [
  'parked_background',
  'glanced',
  'skimmed',
  'engaged_read',
  'worked_on_reference',
  'source_extracted',
  'execution_source',
] as const;

export type EngagementClass = (typeof ENGAGEMENT_CLASSES)[number];

const ENGAGEMENT_CLASS_LABELS: Record<EngagementClass, string> = {
  parked_background: 'Parked',
  glanced: 'Glanced',
  skimmed: 'Skimmed',
  engaged_read: 'Read',
  worked_on_reference: 'Worked',
  source_extracted: 'Source',
  execution_source: 'Execution',
};

const isEngagementClass = (value: string): value is EngagementClass =>
  (ENGAGEMENT_CLASSES as readonly string[]).includes(value);

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

export interface FocusWorkstreamOption {
  readonly id: string;
  readonly label: string;
}

export interface FocusViewProps {
  readonly topics: readonly TopicNode[];
  readonly visitsByTopic: Record<string, readonly TopicVisit[]>;
  readonly engagementClassesByVisit: Record<string, EngagementClass>;
  readonly eligibleVisitCount?: number;
  readonly previousTopicCount?: number;
  readonly workstreamOptions?: readonly FocusWorkstreamOption[];
  readonly onTopicClick: (topicId: string) => void;
  readonly onTopicPromote?: (input: {
    readonly topicId: string;
    readonly targetWorkstreamId: string;
    readonly memberVisitIds: readonly string[];
  }) => Promise<void> | void;
  readonly onEngagementRelabel?: (input: {
    readonly visitId: string;
    readonly fromClass: EngagementClass;
    readonly toClass: EngagementClass;
  }) => Promise<void> | void;
  readonly onVisitClick: (visitId: string) => void;
}

const COLLAPSE_TOPIC_MIN_MEMBERS = 50;
const COLLAPSE_SHARE_MIN_MEMBERS = 20;
const COLLAPSE_MAX_TOPIC_SHARE = 0.5;
const COLLAPSE_PREVIOUS_TOPIC_COUNT = 5;
const SUGGESTION_MEMBER_LIMIT = 40;

const largestTopic = (topics: readonly TopicNode[]): TopicNode | undefined =>
  [...topics].sort((left, right) => right.memberCount - left.memberCount)[0];

const summedTopicMembers = (topics: readonly TopicNode[]): number =>
  topics.reduce((sum, topic) => sum + topic.memberCount, 0);

export const isCollapsedSuggestionSet = (
  topics: readonly TopicNode[],
  eligibleVisitCount: number | undefined,
  previousTopicCount: number | undefined,
): boolean => {
  const largest = largestTopic(topics);
  if (largest === undefined) return false;
  const eligible = Math.max(eligibleVisitCount ?? summedTopicMembers(topics), largest.memberCount);
  const maxTopicShare = eligible === 0 ? 0 : largest.memberCount / eligible;
  return (
    (topics.length <= 1 && largest.memberCount >= COLLAPSE_TOPIC_MIN_MEMBERS) ||
    (eligible >= COLLAPSE_SHARE_MIN_MEMBERS && maxTopicShare >= COLLAPSE_MAX_TOPIC_SHARE) ||
    (topics.length <= 2 &&
      previousTopicCount !== undefined &&
      previousTopicCount >= COLLAPSE_PREVIOUS_TOPIC_COUNT)
  );
};

export const FocusView = ({
  topics,
  visitsByTopic,
  engagementClassesByVisit,
  eligibleVisitCount,
  previousTopicCount,
  workstreamOptions = [],
  onTopicClick,
  onTopicPromote,
  onEngagementRelabel,
  onVisitClick,
}: FocusViewProps): ReactElement => {
  const [expandedTopicIds, setExpandedTopicIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [relabelingVisitId, setRelabelingVisitId] = useState<string | null>(null);
  const [relabelError, setRelabelError] = useState<string | null>(null);
  // Visits without a saved engagement class don't show a dropdown by
  // default — for typical users the labeling UI is noise (every row
  // would say "Parked", which the user reads as wrong data). Power
  // users click "Label" to expose the picker for that row.
  const [labelingVisitIds, setLabelingVisitIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const openLabeler = (visitId: string): void => {
    setLabelingVisitIds((current) => {
      const next = new Set(current);
      next.add(visitId);
      return next;
    });
  };
  const [promotingTopicId, setPromotingTopicId] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promoteErrorTopicId, setPromoteErrorTopicId] = useState<string | null>(null);
  const [promoteTargetsByTopic, setPromoteTargetsByTopic] = useState<Record<string, string>>({});

  const toggle = (topicId: string): void => {
    setExpandedTopicIds((current) => {
      const next = new Set(current);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  };

  const submitEngagementRelabel = (
    visitId: string,
    fromClass: EngagementClass,
    toClass: EngagementClass,
  ): void => {
    if (onEngagementRelabel === undefined || fromClass === toClass) return;
    setRelabelingVisitId(visitId);
    setRelabelError(null);
    void Promise.resolve(onEngagementRelabel({ visitId, fromClass, toClass }))
      .catch((error: unknown) => {
        setRelabelError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setRelabelingVisitId(null);
      });
  };

  const submitTopicPromote = (topic: TopicNode, memberVisitIds: readonly string[]): void => {
    if (onTopicPromote === undefined) return;
    const fallbackTarget = workstreamOptions[0]?.id ?? '';
    const targetWorkstreamId = promoteTargetsByTopic[topic.id] ?? fallbackTarget;
    if (targetWorkstreamId.length === 0) return;
    setPromotingTopicId(topic.id);
    setPromoteError(null);
    setPromoteErrorTopicId(null);
    void Promise.resolve(onTopicPromote({ topicId: topic.id, targetWorkstreamId, memberVisitIds }))
      .catch((error: unknown) => {
        setPromoteError(error instanceof Error ? error.message : String(error));
        setPromoteErrorTopicId(topic.id);
      })
      .finally(() => {
        setPromotingTopicId(null);
      });
  };

  const collapsedTopic = isCollapsedSuggestionSet(topics, eligibleVisitCount, previousTopicCount)
    ? largestTopic(topics)
    : undefined;
  if (collapsedTopic !== undefined) {
    return (
      <section className="cx-focus cx-focus-triage-mode" data-testid="focus-view">
        <article className="cx-focus-triage" data-testid="focus-collapse-guard">
          <div className="cx-focus-triage-head">
            <span className="cx-focus-chip cx-focus-chip-warning">Needs triage</span>
            <span className="cx-mono cx-dim">computed suggestion</span>
          </div>
          <div className="cx-focus-triage-title">{collapsedTopic.label}</div>
          <p>
            One computed group spans {String(collapsedTopic.memberCount)} pages, so it is not shown
            as a focus suggestion.
          </p>
          <button
            type="button"
            className="cx-focus-expand"
            onClick={() => {
              onTopicClick(collapsedTopic.id);
            }}
            data-testid={`focus-triage-inspect-${collapsedTopic.id}`}
          >
            Inspect graph
          </button>
        </article>
      </section>
    );
  }

  return (
    <section className="cx-focus" data-testid="focus-view">
      {topics.map((topic) => {
        const visits = [...(visitsByTopic[topic.id] ?? [])].sort(
          (left, right) =>
            right.focusedWindowMs - left.focusedWindowMs || left.id.localeCompare(right.id),
        );
        const expanded = expandedTopicIds.has(topic.id);
        const oversized = topic.memberCount > SUGGESTION_MEMBER_LIMIT;
        const promoteTarget = promoteTargetsByTopic[topic.id] ?? workstreamOptions[0]?.id ?? '';
        return (
          <article
            className={`cx-focus-card${oversized ? ' is-triage' : ''}`}
            key={topic.id}
            data-testid={`focus-topic-${topic.id}`}
          >
            <div className="cx-focus-card-head">
              <button
                type="button"
                className="cx-focus-title"
                onClick={() => {
                  onTopicClick(topic.id);
                }}
              >
                {topic.label}
              </button>
              <span
                className={`cx-focus-chip ${
                  oversized ? 'cx-focus-chip-warning' : 'cx-focus-chip-suggestion'
                }`}
              >
                {oversized ? 'Needs triage' : 'Suggestion'}
              </span>
            </div>
            <div className="cx-focus-meta">
              <span>
                {String(topic.memberCount)} {topic.memberCount === 1 ? 'page' : 'pages'}
              </span>
              {topic.cohesion > 0 ? (
                <span title="Average pairwise similarity of pages in this topic. Higher means tighter cluster.">
                  cohesion {topic.cohesion.toFixed(2)}
                </span>
              ) : null}
              {topic.dominantWorkstreamId === undefined ? null : (
                <span className="cx-focus-chip cx-focus-chip-workstream">Workstream signal</span>
              )}
            </div>
            {topic.cohesion > 0 ? (
              <div className="cx-focus-bar" aria-hidden>
                <span
                  style={{ width: `${String(Math.max(0, Math.min(1, topic.cohesion)) * 100)}%` }}
                />
              </div>
            ) : null}
            {onTopicPromote !== undefined && workstreamOptions.length > 0 ? (
              <div className="cx-focus-promote">
                <select
                  className="cx-focus-visit-select"
                  aria-label={`Promote ${topic.label} to workstream`}
                  value={promoteTarget}
                  disabled={promotingTopicId === topic.id}
                  onChange={(event) => {
                    setPromoteTargetsByTopic((current) => ({
                      ...current,
                      [topic.id]: event.target.value,
                    }));
                  }}
                  data-testid={`focus-promote-target-${topic.id}`}
                >
                  {workstreamOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="cx-focus-expand"
                  disabled={promotingTopicId === topic.id || promoteTarget.length === 0}
                  onClick={() => {
                    submitTopicPromote(
                      topic,
                      visits.map((visit) => visit.id),
                    );
                  }}
                  data-testid={`focus-promote-${topic.id}`}
                >
                  {promotingTopicId === topic.id ? 'Promoting' : 'Promote'}
                </button>
              </div>
            ) : null}
            {promoteError !== null && promoteErrorTopicId === topic.id ? (
              <div className="cx-mono cx-dim" role="alert" data-testid="focus-promote-error">
                {promoteError}
              </div>
            ) : null}
            <button
              type="button"
              className="cx-focus-expand"
              onClick={() => {
                toggle(topic.id);
              }}
              data-testid={`focus-expand-${topic.id}`}
            >
              {expanded ? 'Hide visits' : 'Show visits'}
            </button>
            {expanded ? (
              <div className="cx-focus-visits">
                {visits.map((visit) => {
                  const definedClass = engagementClassesByVisit[visit.id];
                  const showLabeler =
                    onEngagementRelabel !== undefined &&
                    (definedClass !== undefined || labelingVisitIds.has(visit.id));
                  const currentClass = definedClass ?? 'parked_background';
                  const hasFocusedTime = visit.focusedWindowMs > 0;
                  return (
                    <div className="cx-focus-visit" key={visit.id}>
                      <button
                        type="button"
                        className="cx-focus-visit-main"
                        onClick={() => {
                          onVisitClick(visit.id);
                        }}
                        data-testid={`focus-visit-${visit.id}`}
                        title={visit.id}
                      >
                        <span
                          className={`cx-engagement-dot ${
                            definedClass === undefined
                              ? 'cx-engagement-unset'
                              : `cx-engagement-${definedClass}`
                          }`}
                          data-testid={`engagement-dot-${visit.id}`}
                        />
                        <span className="cx-focus-visit-title">{visit.label}</span>
                        {hasFocusedTime ? (
                          <span
                            className="cx-mono cx-dim cx-focus-visit-ms"
                            title="Time the visit was focused (ms)"
                          >
                            {String(visit.focusedWindowMs)} ms
                          </span>
                        ) : null}
                      </button>
                      {onEngagementRelabel === undefined ? null : showLabeler ? (
                        <select
                          className="cx-focus-visit-select"
                          aria-label={`Relabel engagement for ${visit.label}`}
                          value={currentClass}
                          disabled={relabelingVisitId === visit.id}
                          data-testid={`focus-visit-engagement-${visit.id}`}
                          onChange={(event) => {
                            const toClass = event.currentTarget.value;
                            if (isEngagementClass(toClass)) {
                              submitEngagementRelabel(visit.id, currentClass, toClass);
                            }
                          }}
                        >
                          {ENGAGEMENT_CLASSES.map((engagementClass) => (
                            <option key={engagementClass} value={engagementClass}>
                              {ENGAGEMENT_CLASS_LABELS[engagementClass]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <button
                          type="button"
                          className="cx-focus-visit-labelbtn"
                          onClick={() => {
                            openLabeler(visit.id);
                          }}
                          data-testid={`focus-visit-label-${visit.id}`}
                          title="Label engagement (researcher feature)"
                        >
                          Label
                        </button>
                      )}
                    </div>
                  );
                })}
                {relabelError === null ? null : (
                  <div className="cx-mono cx-dim" role="alert" data-testid="focus-relabel-error">
                    {relabelError}
                  </div>
                )}
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
};
