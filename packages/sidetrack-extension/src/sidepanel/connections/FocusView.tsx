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

export interface FocusViewProps {
  readonly topics: readonly TopicNode[];
  readonly visitsByTopic: Record<string, readonly TopicVisit[]>;
  readonly engagementClassesByVisit: Record<string, EngagementClass>;
  readonly onTopicClick: (topicId: string) => void;
  readonly onTopicRename?: (input: {
    readonly topicId: string;
    readonly previousName: string;
    readonly newName: string;
  }) => Promise<void> | void;
  readonly onEngagementRelabel?: (input: {
    readonly visitId: string;
    readonly fromClass: EngagementClass;
    readonly toClass: EngagementClass;
  }) => Promise<void> | void;
  readonly onVisitClick: (visitId: string) => void;
}

export const FocusView = ({
  topics,
  visitsByTopic,
  engagementClassesByVisit,
  onTopicClick,
  onTopicRename,
  onEngagementRelabel,
  onVisitClick,
}: FocusViewProps): ReactElement => {
  const [expandedTopicIds, setExpandedTopicIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>('');
  const [renamingTopicId, setRenamingTopicId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
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

  const toggle = (topicId: string): void => {
    setExpandedTopicIds((current) => {
      const next = new Set(current);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  };

  const startRename = (topic: TopicNode): void => {
    setEditingTopicId(topic.id);
    setRenameDraft(topic.label);
    setRenameError(null);
  };

  const submitRename = (topic: TopicNode): void => {
    if (onTopicRename === undefined) return;
    const nextName = renameDraft.trim();
    if (nextName.length === 0) {
      setRenameError('Name required');
      return;
    }
    if (nextName === topic.label) {
      setEditingTopicId(null);
      setRenameError(null);
      return;
    }
    setRenamingTopicId(topic.id);
    setRenameError(null);
    void Promise.resolve(
      onTopicRename({
        topicId: topic.id,
        previousName: topic.label,
        newName: nextName,
      }),
    )
      .then(() => {
        setEditingTopicId(null);
      })
      .catch((error: unknown) => {
        setRenameError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setRenamingTopicId(null);
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

  return (
    <section className="cx-focus" data-testid="focus-view">
      {topics.map((topic) => {
        const visits = [...(visitsByTopic[topic.id] ?? [])].sort(
          (left, right) =>
            right.focusedWindowMs - left.focusedWindowMs || left.id.localeCompare(right.id),
        );
        const expanded = expandedTopicIds.has(topic.id);
        const editing = editingTopicId === topic.id;
        return (
          <article className="cx-focus-card" key={topic.id} data-testid={`focus-topic-${topic.id}`}>
            {editing ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="text"
                  value={renameDraft}
                  onChange={(event) => {
                    setRenameDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitRename(topic);
                    if (event.key === 'Escape') setEditingTopicId(null);
                  }}
                  aria-label={`Rename ${topic.label}`}
                  data-testid={`focus-topic-rename-input-${topic.id}`}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: '1px solid var(--line)',
                    borderRadius: 6,
                    padding: '5px 7px',
                    font: 'inherit',
                  }}
                />
                <button
                  type="button"
                  className="cx-focus-expand"
                  disabled={renamingTopicId === topic.id}
                  onClick={() => {
                    submitRename(topic);
                  }}
                  data-testid={`focus-topic-rename-save-${topic.id}`}
                >
                  Save
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  className="cx-focus-title"
                  onClick={() => {
                    onTopicClick(topic.id);
                  }}
                >
                  {topic.label}
                </button>
                {onTopicRename === undefined ? null : (
                  <button
                    type="button"
                    className="cx-focus-expand"
                    onClick={() => {
                      startRename(topic);
                    }}
                    aria-label={`Rename ${topic.label}`}
                    data-testid={`focus-topic-rename-${topic.id}`}
                    title="Rename topic"
                  >
                    Rename
                  </button>
                )}
              </div>
            )}
            {renameError !== null && editing ? (
              <div className="cx-mono cx-dim" role="alert" data-testid="focus-topic-rename-error">
                {renameError}
              </div>
            ) : null}
            <div className="cx-focus-meta">
              <span>
                {String(topic.memberCount)} {topic.memberCount === 1 ? 'page' : 'pages'}
              </span>
              {topic.cohesion > 0 ? (
                <span
                  title="Average pairwise similarity of pages in this topic. Higher means tighter cluster."
                >
                  cohesion {topic.cohesion.toFixed(2)}
                </span>
              ) : null}
              {topic.dominantWorkstreamId === undefined ? null : (
                <span className="cx-focus-chip">Workstream</span>
              )}
            </div>
            {topic.cohesion > 0 ? (
              <div className="cx-focus-bar" aria-hidden>
                <span
                  style={{ width: `${String(Math.max(0, Math.min(1, topic.cohesion)) * 100)}%` }}
                />
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
