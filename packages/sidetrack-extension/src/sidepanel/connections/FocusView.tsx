import { useState, type ReactElement } from 'react';

import { CheckIcon, ClockIcon, EditIcon, KindIcons, RejectIcon, SaveIcon } from './icons';

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
  readonly url?: string;
  readonly lastSeenAt?: string;
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
  readonly onTopicAnchor?: (input: { readonly topicId: string; readonly label: string }) => void;
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
  readonly onVisitRestoreToTopic?: (input: {
    readonly topicId: string;
    readonly visitId: string;
  }) => Promise<void> | void;
  readonly onEngagementRelabel?: (input: {
    readonly visitId: string;
    readonly fromClass: EngagementClass;
    readonly toClass: EngagementClass;
  }) => Promise<void> | void;
  readonly onVisitClick: (visitId: string) => void;
  readonly onVisitOpen?: (url: string) => void;
  readonly allowTriageTopicCards?: boolean;
}

const COLLAPSE_TOPIC_MIN_MEMBERS = 50;
const COLLAPSE_SHARE_MIN_MEMBERS = 20;
const COLLAPSE_MAX_TOPIC_SHARE = 0.5;
const COLLAPSE_PREVIOUS_TOPIC_COUNT = 5;
const SUGGESTION_MEMBER_LIMIT = 40;

const ATTENTION_SORT_WEIGHT: Record<EngagementClass, number> = {
  execution_source: 70,
  source_extracted: 60,
  worked_on_reference: 50,
  engaged_read: 40,
  skimmed: 30,
  glanced: 20,
  parked_background: 10,
};

const largestTopic = (topics: readonly TopicNode[]): TopicNode | undefined =>
  [...topics].sort((left, right) => right.memberCount - left.memberCount)[0];

const summedTopicMembers = (topics: readonly TopicNode[]): number =>
  topics.reduce((sum, topic) => sum + topic.memberCount, 0);

const pageCountLabel = (count: number): string =>
  `${String(count)} ${count === 1 ? 'page' : 'pages'}`;

const topicMemberLabel = (topic: TopicNode): string => {
  if (topic.totalMemberCount !== undefined && topic.totalMemberCount > topic.memberCount) {
    return `${pageCountLabel(topic.memberCount)} shown here, ${pageCountLabel(
      topic.totalMemberCount,
    )} total`;
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

const sortScoreForVisit = (
  visit: TopicVisit,
  engagementClassesByVisit: Record<string, EngagementClass>,
): number => {
  const engagementClass = engagementClassesByVisit[visit.id];
  const attentionWeight =
    engagementClass === undefined ? 0 : ATTENTION_SORT_WEIGHT[engagementClass];
  const recencySeconds =
    visit.lastSeenAt === undefined ? 0 : Math.max(0, Date.parse(visit.lastSeenAt) / 1000);
  return attentionWeight * 1_000_000_000_000 + recencySeconds + visit.focusedWindowMs / 1000;
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
  onTopicAnchor,
  onTopicPromote,
  onTopicRename,
  onVisitMarkNotRelated,
  onVisitRestoreToTopic,
  onEngagementRelabel,
  onVisitClick,
  onVisitOpen,
  allowTriageTopicCards = false,
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
  const [lastRemovedVisitByTopic, setLastRemovedVisitByTopic] = useState<
    Record<string, TopicVisit | undefined>
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
    visit: TopicVisit,
    memberVisitIds: readonly string[],
  ): void => {
    if (onVisitMarkNotRelated === undefined) return;
    const visitId = visit.id;
    const actionKey = `not-related:${topic.id}:${visitId}`;
    setVisitActionInFlight(actionKey);
    setVisitActionError(null);
    setLastRemovedVisitByTopic((current) => ({ ...current, [topic.id]: visit }));
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
        setLastRemovedVisitByTopic((current) => ({ ...current, [topic.id]: undefined }));
        setVisitActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setVisitActionInFlight(null);
      });
  };

  const submitVisitRestore = (topic: TopicNode, visit: TopicVisit): void => {
    const actionKey = `restore:${topic.id}:${visit.id}`;
    setVisitActionInFlight(actionKey);
    setVisitActionError(null);
    setRejectedVisitIdsByTopic((current) => {
      const next = new Set(current[topic.id] ?? []);
      next.delete(visit.id);
      return { ...current, [topic.id]: next };
    });
    setLastRemovedVisitByTopic((current) => ({ ...current, [topic.id]: undefined }));
    if (onVisitRestoreToTopic === undefined) {
      setVisitActionInFlight(null);
      return;
    }
    void Promise.resolve(onVisitRestoreToTopic({ topicId: topic.id, visitId: visit.id }))
      .catch((error: unknown) => {
        setRejectedVisitIdsByTopic((current) => {
          const next = new Set(current[topic.id] ?? []);
          next.add(visit.id);
          return { ...current, [topic.id]: next };
        });
        setLastRemovedVisitByTopic((current) => ({ ...current, [topic.id]: visit }));
        setVisitActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setVisitActionInFlight(null);
      });
  };

  const collapsedTopic =
    !allowTriageTopicCards &&
    isCollapsedSuggestionSet(topics, eligibleVisitCount, previousTopicCount)
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
            sortScoreForVisit(right, engagementClassesByVisit) -
              sortScoreForVisit(left, engagementClassesByVisit) ||
            left.id.localeCompare(right.id),
        );
        const rejectedVisitIds = rejectedVisitIdsByTopic[topic.id] ?? new Set<string>();
        const visibleVisits = visits.filter((visit) => !rejectedVisitIds.has(visit.id));
        const lastRemovedVisit = lastRemovedVisitByTopic[topic.id];
        const expanded = expandedTopicIds.has(topic.id);
        const needsTriage =
          topic.memberCount > SUGGESTION_MEMBER_LIMIT ||
          (allowTriageTopicCards &&
            topics.length <= 1 &&
            topic.memberCount >= COLLAPSE_SHARE_MIN_MEMBERS);
        const displayLabel = displayLabelFor(topic);
        const renameDraft = renameDraftFor(topic);
        const visibleVisitIds = visibleVisits.map((visit) => visit.id);
        const canPromote = onTopicPromote !== undefined && workstreamOptions.length > 0;
        return (
          <article
            className={`cx-focus-card${needsTriage ? ' is-triage' : ''}`}
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
              <div className="cx-focus-head-actions">
                <span
                  className={`cx-focus-chip ${
                    needsTriage ? 'cx-focus-chip-warning' : 'cx-focus-chip-suggestion'
                  }`}
                >
                  {needsTriage ? 'Needs triage' : 'Suggestion'}
                </span>
                {canPromote ? (
                  <button
                    type="button"
                    className="cx-focus-head-action"
                    disabled={promotingTopicId === topic.id || visibleVisits.length === 0}
                    onClick={() => {
                      submitTopicPromote(topic, visibleVisitIds);
                    }}
                    data-testid={`focus-promote-${topic.id}`}
                    title="Save this suggestion"
                    aria-label={`Save ${displayLabel} suggestion`}
                  >
                    {iconSlot(SaveIcon)}
                  </button>
                ) : null}
                {onTopicAnchor === undefined ? null : (
                  <button
                    type="button"
                    className="cx-focus-head-action cx-focus-head-action-text"
                    onClick={() => {
                      onTopicAnchor({ topicId: topic.id, label: displayLabel });
                    }}
                    data-testid={`focus-topic-anchor-${topic.id}`}
                    title="Set this suggestion as the graph anchor"
                  >
                    {iconSlot(KindIcons.topic)}
                    Anchor
                  </button>
                )}
              </div>
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
                    {renamingTopicId === topic.id ? 'Saving' : 'Save name'}
                  </button>
                </div>
                {renameError !== null && renameErrorTopicId === topic.id ? (
                  <div className="cx-mono cx-dim" role="alert" data-testid="focus-rename-error">
                    {renameError}
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
                {lastRemovedVisit === undefined ? null : (
                  <div className="cx-focus-undo" data-testid={`focus-undo-${topic.id}`}>
                    <span>Removed {lastRemovedVisit.label}</span>
                    <button
                      type="button"
                      className="cx-focus-undo-action"
                      disabled={
                        visitActionInFlight === `restore:${topic.id}:${lastRemovedVisit.id}`
                      }
                      onClick={() => {
                        submitVisitRestore(topic, lastRemovedVisit);
                      }}
                    >
                      Undo
                    </button>
                  </div>
                )}
                <div className="cx-focus-visits">
                  {visibleVisits.map((visit) => {
                    const definedClass = engagementClassesByVisit[visit.id];
                    const showLabeler =
                      onEngagementRelabel !== undefined && labelingVisitIds.has(visit.id);
                    const currentClass = definedClass ?? 'parked_background';
                    const attentionLabel =
                      definedClass === undefined
                        ? 'Attention'
                        : ENGAGEMENT_CLASS_LABELS[definedClass];
                    const hasFocusedTime = visit.focusedWindowMs > 0;
                    const focusedDuration = focusedDurationLabel(visit.focusedWindowMs);
                    const visitUrl = visit.url;
                    const canOpenVisit = visitUrl !== undefined && visitUrl.length > 0;
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
                        {canOpenVisit ? (
                          <a
                            className="cx-focus-visit-labelbtn cx-focus-visit-open"
                            href={visitUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={
                              onVisitOpen === undefined
                                ? undefined
                                : (event) => {
                                    event.preventDefault();
                                    onVisitOpen(visitUrl);
                                  }
                            }
                            data-testid={`focus-visit-open-${visit.id}`}
                            title={`Open ${visitUrl}`}
                          >
                            ↗ Open
                          </a>
                        ) : null}
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
                            title={
                              definedClass === undefined
                                ? 'Set attention label'
                                : `Current attention label: ${attentionLabel}`
                            }
                          >
                            {iconSlot(EditIcon)}
                            {attentionLabel}
                          </button>
                        )}
                        {onVisitMarkNotRelated === undefined ? null : (
                          <button
                            type="button"
                            className="cx-focus-visit-labelbtn cx-focus-visit-reject"
                            disabled={visitActionInFlight === `not-related:${topic.id}:${visit.id}`}
                            onClick={() => {
                              submitVisitNotRelated(topic, visit, visibleVisitIds);
                            }}
                            data-testid={`focus-visit-not-related-${topic.id}-${visit.id}`}
                            title="Remove this page from this suggestion"
                          >
                            {iconSlot(RejectIcon)}
                            Remove
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
