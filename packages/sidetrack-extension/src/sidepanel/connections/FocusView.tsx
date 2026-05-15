import { useState, type ReactElement } from 'react';

import { CheckIcon, ClockIcon, EditIcon, RejectIcon, SaveIcon } from './icons';

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
  parked_background: 'Background',
  glanced: 'Quick look',
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
  readonly totalMemberCount?: number;
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
  readonly onTopicRename?: (input: {
    readonly topicId: string;
    readonly previousName: string;
    readonly newName: string;
  }) => Promise<void> | void;
  readonly onVisitMarkNotRelated?: (input: {
    readonly topicId: string;
    readonly visitId: string;
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

const pageCountLabel = (count: number): string =>
  `${String(count)} ${count === 1 ? 'page' : 'pages'}`;

const topicMemberLabel = (topic: TopicNode): string => {
  if (topic.totalMemberCount !== undefined && topic.totalMemberCount > topic.memberCount) {
    return `${String(topic.memberCount)} of ${pageCountLabel(topic.totalMemberCount)} in this scope`;
  }
  return pageCountLabel(topic.memberCount);
};

const focusedDurationLabel = (focusedWindowMs: number): string => {
  const seconds = Math.max(1, Math.round(focusedWindowMs / 1000));
  if (seconds < 60) return `${String(seconds)} sec`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${String(hours)} hr`
    : `${String(hours)} hr ${String(remainingMinutes)} min`;
};

const iconSlot = (icon: ReactElement): ReactElement => (
  <span className="cx-focus-action-icon" aria-hidden>
    {icon}
  </span>
);

export const isCollapsedSuggestionSet = (
  topics: readonly TopicNode[],
  eligibleVisitCount: number | undefined,
  previousTopicCount: number | undefined,
): boolean => {
  const largest = largestTopic(topics);
  if (largest === undefined) return false;
  const eligible = Math.max(eligibleVisitCount ?? summedTopicMembers(topics), largest.memberCount);
  const maxTopicShare = eligible === 0 ? 0 : largest.memberCount / eligible;
  return Boolean(
    (topics.length <= 1 && largest.memberCount >= COLLAPSE_TOPIC_MIN_MEMBERS) ||
    (eligible >= COLLAPSE_SHARE_MIN_MEMBERS && maxTopicShare >= COLLAPSE_MAX_TOPIC_SHARE) ||
    (topics.length <= 2 &&
      previousTopicCount !== undefined &&
      previousTopicCount >= COLLAPSE_PREVIOUS_TOPIC_COUNT),
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
  onTopicRename,
  onVisitMarkNotRelated,
  onEngagementRelabel,
  onVisitClick,
}: FocusViewProps): ReactElement => {
  const [expandedTopicIds, setExpandedTopicIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [relabelingVisitId, setRelabelingVisitId] = useState<string | null>(null);
  const [relabelError, setRelabelError] = useState<string | null>(null);
  const [promotingTopicId, setPromotingTopicId] = useState<string | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promoteErrorTopicId, setPromoteErrorTopicId] = useState<string | null>(null);
  const [topicLabelsById, setTopicLabelsById] = useState<Record<string, string>>({});
  const [renameDraftsByTopic, setRenameDraftsByTopic] = useState<Record<string, string>>({});
  const [renamingTopicId, setRenamingTopicId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameErrorTopicId, setRenameErrorTopicId] = useState<string | null>(null);
  const [rejectedVisitIdsByTopic, setRejectedVisitIdsByTopic] = useState<
    Record<string, ReadonlySet<string>>
  >({});
  const [visitActionInFlight, setVisitActionInFlight] = useState<string | null>(null);
  const [visitActionError, setVisitActionError] = useState<string | null>(null);
  // Visits without a saved engagement class don't show a dropdown by
  // default — for typical users the labeling UI is noise (every row
  // would show an attention bucket, which the user reads as wrong data). Power
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

  const displayLabelFor = (topic: TopicNode): string => topicLabelsById[topic.id] ?? topic.label;

  const renameDraftFor = (topic: TopicNode): string =>
    renameDraftsByTopic[topic.id] ?? displayLabelFor(topic);

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
    const targetWorkstreamId = fallbackTarget;
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

  const submitTopicRename = (topic: TopicNode): void => {
    if (onTopicRename === undefined) return;
    const previousName = displayLabelFor(topic);
    const newName = renameDraftFor(topic).trim();
    if (newName.length === 0 || newName === previousName) return;
    setRenamingTopicId(topic.id);
    setRenameError(null);
    setRenameErrorTopicId(null);
    setTopicLabelsById((current) => ({ ...current, [topic.id]: newName }));
    void Promise.resolve(onTopicRename({ topicId: topic.id, previousName, newName }))
      .catch((error: unknown) => {
        setTopicLabelsById((current) => ({ ...current, [topic.id]: previousName }));
        setRenameError(error instanceof Error ? error.message : String(error));
        setRenameErrorTopicId(topic.id);
      })
      .finally(() => {
        setRenamingTopicId(null);
      });
  };

  const submitVisitNotRelated = (
    topic: TopicNode,
    visitId: string,
    memberVisitIds: readonly string[],
  ): void => {
    if (onVisitMarkNotRelated === undefined) return;
    const actionKey = `not-related:${topic.id}:${visitId}`;
    setVisitActionInFlight(actionKey);
    setVisitActionError(null);
    setRejectedVisitIdsByTopic((current) => {
      const next = new Set(current[topic.id] ?? []);
      next.add(visitId);
      return { ...current, [topic.id]: next };
    });
    void Promise.resolve(onVisitMarkNotRelated({ topicId: topic.id, visitId, memberVisitIds }))
      .catch((error: unknown) => {
        setRejectedVisitIdsByTopic((current) => {
          const next = new Set(current[topic.id] ?? []);
          next.delete(visitId);
          return { ...current, [topic.id]: next };
        });
        setVisitActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setVisitActionInFlight(null);
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

  if (topics.length === 0) {
    return (
      <section className="cx-focus" data-testid="focus-view">
        <article className="cx-focus-triage" data-testid="focus-empty">
          <div className="cx-focus-triage-head">
            <span className="cx-focus-chip cx-focus-chip-suggestion">No suggestion</span>
            <span className="cx-mono cx-dim">computed focus</span>
          </div>
          <div className="cx-focus-triage-title">No scoped focus group</div>
          <p>This page is not in the current candidate topic output.</p>
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
        const rejectedVisitIds = rejectedVisitIdsByTopic[topic.id] ?? new Set<string>();
        const visibleVisits = visits.filter((visit) => !rejectedVisitIds.has(visit.id));
        const expanded = expandedTopicIds.has(topic.id);
        const oversized = topic.memberCount > SUGGESTION_MEMBER_LIMIT;
        const displayLabel = displayLabelFor(topic);
        const renameDraft = renameDraftFor(topic);
        const visibleVisitIds = visibleVisits.map((visit) => visit.id);
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
                  toggle(topic.id);
                }}
                aria-expanded={expanded}
              >
                {displayLabel}
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
              <span>{topicMemberLabel(topic)}</span>
              {topic.cohesion > 0 ? (
                <span title="Average pairwise similarity of pages in this topic. Higher means tighter cluster.">
                  {iconSlot(CheckIcon)}
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
            {expanded ? (
              <div className="cx-focus-detail" data-testid={`focus-detail-${topic.id}`}>
                <div className="cx-focus-rename">
                  <label className="cx-focus-rename-label" htmlFor={`focus-rename-${topic.id}`}>
                    Rename
                  </label>
                  <input
                    id={`focus-rename-${topic.id}`}
                    className="cx-focus-rename-input"
                    value={renameDraft}
                    disabled={renamingTopicId === topic.id}
                    onChange={(event) => {
                      setRenameDraftsByTopic((current) => ({
                        ...current,
                        [topic.id]: event.target.value,
                      }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitTopicRename(topic);
                    }}
                    data-testid={`focus-rename-input-${topic.id}`}
                  />
                  <button
                    type="button"
                    className="cx-focus-expand cx-focus-inline-action"
                    disabled={
                      onTopicRename === undefined ||
                      renamingTopicId === topic.id ||
                      renameDraft.trim().length === 0 ||
                      renameDraft.trim() === displayLabel
                    }
                    onClick={() => {
                      submitTopicRename(topic);
                    }}
                    data-testid={`focus-rename-${topic.id}`}
                  >
                    {iconSlot(EditIcon)}
                    {renamingTopicId === topic.id ? 'Renaming' : 'Rename'}
                  </button>
                </div>
                {renameError !== null && renameErrorTopicId === topic.id ? (
                  <div className="cx-mono cx-dim" role="alert" data-testid="focus-rename-error">
                    {renameError}
                  </div>
                ) : null}
                {onTopicPromote !== undefined && workstreamOptions.length > 0 ? (
                  <div className="cx-focus-promote">
                    <button
                      type="button"
                      className="cx-focus-expand cx-focus-inline-action"
                      disabled={promotingTopicId === topic.id || visibleVisits.length === 0}
                      onClick={() => {
                        submitTopicPromote(topic, visibleVisitIds);
                      }}
                      data-testid={`focus-promote-${topic.id}`}
                    >
                      {iconSlot(SaveIcon)}
                      {promotingTopicId === topic.id ? 'Saving' : 'Save suggestion'}
                    </button>
                  </div>
                ) : null}
                {promoteError !== null && promoteErrorTopicId === topic.id ? (
                  <div className="cx-mono cx-dim" role="alert" data-testid="focus-promote-error">
                    {promoteError}
                  </div>
                ) : null}
                <div className="cx-focus-detail-head">
                  <span>Pages</span>
                  <span className="cx-mono cx-dim">{pageCountLabel(visibleVisits.length)}</span>
                </div>
                <div className="cx-focus-visits">
                  {visibleVisits.map((visit) => {
                    const definedClass = engagementClassesByVisit[visit.id];
                    const showLabeler =
                      onEngagementRelabel !== undefined && labelingVisitIds.has(visit.id);
                    const currentClass = definedClass ?? 'parked_background';
                    const hasFocusedTime = visit.focusedWindowMs > 0;
                    const focusedDuration = focusedDurationLabel(visit.focusedWindowMs);
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
                            title={
                              definedClass === undefined
                                ? 'No attention label'
                                : ENGAGEMENT_CLASS_LABELS[definedClass]
                            }
                          />
                          <span className="cx-focus-visit-title">{visit.label}</span>
                          {hasFocusedTime ? (
                            <span
                              className="cx-focus-visit-ms"
                              title={`Focused ${focusedDuration}`}
                            >
                              {iconSlot(ClockIcon)}
                              {focusedDuration}
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
                        {onVisitMarkNotRelated === undefined ? null : (
                          <button
                            type="button"
                            className="cx-focus-visit-labelbtn cx-focus-visit-reject"
                            disabled={visitActionInFlight === `not-related:${topic.id}:${visit.id}`}
                            onClick={() => {
                              submitVisitNotRelated(topic, visit.id, visibleVisitIds);
                            }}
                            data-testid={`focus-visit-not-related-${topic.id}-${visit.id}`}
                            title="This page does not belong in this suggestion"
                          >
                            {iconSlot(RejectIcon)}
                            Doesn't belong
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {visitActionError === null ? null : (
                    <div
                      className="cx-mono cx-dim"
                      role="alert"
                      data-testid="focus-visit-action-error"
                    >
                      {visitActionError}
                    </div>
                  )}
                  {relabelError === null ? null : (
                    <div className="cx-mono cx-dim" role="alert" data-testid="focus-relabel-error">
                      {relabelError}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
};
