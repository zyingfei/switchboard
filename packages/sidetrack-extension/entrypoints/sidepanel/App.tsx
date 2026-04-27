import { useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from 'react';

import {
  companionStatusLabel,
  createEmptyWorkboardState,
  initialWorkboardSections,
  maskTitleForPrivacy,
  type InboundReminder,
  type PrivacyMode,
  type TrackedThread,
  type WorkboardState,
  type WorkstreamNode,
} from '../../src/workboard';
import type { ChecklistItem, WorkstreamUpdate } from '../../src/companion/model';
import { isRuntimeResponse, messageTypes, type WorkboardRequest } from '../../src/messages';
import {
  InboundCard,
  MoveToPicker,
  SystemBannersStack,
  TabRecovery,
  Wizard,
  type InboundReminder as InboundCardReminder,
  type RestoreStrategy,
  type WorkstreamOption,
} from './components';
import './style.css';

const sendRequest = async (request: WorkboardRequest): Promise<WorkboardState> => {
  const response = (await chrome.runtime.sendMessage(request)) as unknown;
  if (!isRuntimeResponse(response)) {
    throw new Error('Sidetrack background returned an invalid response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.state;
};

const providerLabel = (provider: TrackedThread['provider']): string => {
  if (provider === 'chatgpt') {
    return 'ChatGPT';
  }
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'gemini') {
    return 'Gemini';
  }
  return 'Generic';
};

const privacyLabel = (privacy: PrivacyMode): string => {
  if (privacy === 'private') {
    return 'Private';
  }
  if (privacy === 'public') {
    return 'Public';
  }
  return 'Shared';
};

const formatRelative = (isoDate: string): string => {
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) {
    return 'recently';
  }
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) {
    return `${String(seconds)} sec ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${String(hours)} hr ago`;
  }
  return `${String(Math.round(hours / 24))} days ago`;
};

const checklistId = (): string => `check_${crypto.randomUUID().replaceAll('-', '_')}`;

const workstreamPath = (
  workstreamId: string | undefined,
  workstreams: readonly WorkstreamNode[],
): string => {
  if (workstreamId === undefined) {
    return 'Needs organize';
  }

  const byId = new Map(workstreams.map((workstream) => [workstream.bac_id, workstream]));
  const visited = new Set<string>();
  const titles: string[] = [];
  let cursor = byId.get(workstreamId);

  while (cursor !== undefined && !visited.has(cursor.bac_id)) {
    visited.add(cursor.bac_id);
    titles.unshift(cursor.title);
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
  }

  return titles.length > 0 ? titles.join(' / ') : 'Needs organize';
};

const buildWorkstreamOptions = (
  workstreams: readonly WorkstreamNode[],
): readonly WorkstreamOption[] =>
  workstreams.map((workstream) => ({
    bac_id: workstream.bac_id,
    path: workstreamPath(workstream.bac_id, workstreams),
  }));

const isThreadPrivate = (thread: TrackedThread, workstreams: readonly WorkstreamNode[]): boolean =>
  workstreams.some(
    (workstream) =>
      workstream.bac_id === thread.primaryWorkstreamId && workstream.privacy === 'private',
  );

const visibleThreads = (threads: readonly TrackedThread[]): readonly TrackedThread[] =>
  threads.filter((thread) => thread.status !== 'removed' && thread.trackingMode !== 'removed');

const reminderCardStatus = (status: InboundReminder['status']): InboundCardReminder['status'] => {
  if (status === 'dismissed') {
    return 'dismissed';
  }
  if (status === 'seen' || status === 'relevant') {
    return 'seen';
  }
  return 'unseen';
};

const restoreStrategyForThread = (thread: TrackedThread): RestoreStrategy =>
  thread.tabSnapshot?.tabId === undefined ? 'reopen_url' : 'focus_open';

const WorkstreamLine = ({
  node,
  all,
  selectedId,
  onSelect,
  depth = 0,
}: {
  readonly node: WorkstreamNode;
  readonly all: readonly WorkstreamNode[];
  readonly selectedId: string;
  readonly onSelect: (workstreamId: string) => void;
  readonly depth?: number;
}) => (
  <>
    <li className="tree-line" style={{ '--depth': String(depth) } as CSSProperties}>
      <button
        className={'tree-button' + (selectedId === node.bac_id ? ' selected' : '')}
        onClick={() => {
          onSelect(node.bac_id);
        }}
        type="button"
      >
        <span>{node.title}</span>
        <span className="muted">{privacyLabel(node.privacy)}</span>
      </button>
    </li>
    {node.children
      .map((childId) => all.find((candidate) => candidate.bac_id === childId))
      .filter((child): child is WorkstreamNode => child !== undefined)
      .map((child) => (
        <WorkstreamLine
          all={all}
          depth={depth + 1}
          key={child.bac_id}
          node={child}
          onSelect={onSelect}
          selectedId={selectedId}
        />
      ))}
  </>
);

const App = () => {
  const [state, setState] = useState<WorkboardState>(() => createEmptyWorkboardState());
  const [bridgeKey, setBridgeKey] = useState('');
  const [port, setPort] = useState('17373');
  const [workstreamTitle, setWorkstreamTitle] = useState('');
  const [queueText, setQueueText] = useState('');
  const [checklistText, setChecklistText] = useState('');
  const [tagText, setTagText] = useState('');
  const [selectedWorkstream, setSelectedWorkstream] = useState('');
  const [selectedThread, setSelectedThread] = useState('');
  const [moveThreadId, setMoveThreadId] = useState<string | null>(null);
  const [recoveryThreadId, setRecoveryThreadId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const threads = useMemo(() => visibleThreads(state.threads), [state.threads]);
  const rootWorkstreams = useMemo(
    () => state.workstreams.filter((workstream) => workstream.parentId === undefined),
    [state.workstreams],
  );
  const workstreamOptions = useMemo(
    () => buildWorkstreamOptions(state.workstreams),
    [state.workstreams],
  );
  const activeWorkstream = useMemo(
    () => state.workstreams.find((workstream) => workstream.bac_id === selectedWorkstream),
    [selectedWorkstream, state.workstreams],
  );
  const moveThread = useMemo(
    () => threads.find((thread) => thread.bac_id === moveThreadId),
    [moveThreadId, threads],
  );
  const recoveryThread = useMemo(
    () => threads.find((thread) => thread.bac_id === recoveryThreadId),
    [recoveryThreadId, threads],
  );

  const refresh = async () => {
    const next = await sendRequest({ type: messageTypes.getWorkboardState });
    setState(next);
    setBridgeKey(next.settings.companion.bridgeKey);
    setPort(String(next.settings.companion.port));
    setError(next.lastError ?? null);
    if (selectedWorkstream === '' && next.workstreams.length > 0) {
      setSelectedWorkstream(next.workstreams[0]?.bac_id ?? '');
    }
  };

  useEffect(() => {
    void refresh().catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : 'Could not load Sidetrack state.');
    });
  }, []);

  const runAction = async (action: () => Promise<WorkboardState>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      setError(next.lastError ?? null);
      setBridgeKey(next.settings.companion.bridgeKey);
      setPort(String(next.settings.companion.port));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Sidetrack action failed.');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runAction(() =>
      sendRequest({
        type: messageTypes.saveCompanionSettings,
        settings: { bridgeKey, port: Number(port) },
      }),
    );
  };

  const createWorkstream = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workstreamTitle.trim()) {
      return;
    }
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.createWorkstream,
        workstream: {
          title: workstreamTitle.trim(),
          ...(selectedWorkstream ? { parentId: selectedWorkstream } : {}),
          privacy: 'private',
        },
      });
      setWorkstreamTitle('');
      return next;
    });
  };

  const handleMoveTarget = (target: WorkstreamOption | { readonly create: string }) => {
    if (moveThreadId === null) {
      return;
    }

    void runAction(async () => {
      if ('create' in target) {
        const afterCreate = await sendRequest({
          type: messageTypes.createWorkstream,
          workstream: { title: target.create, privacy: 'private' },
        });
        const created = afterCreate.workstreams.find(
          (workstream) => workstream.title === target.create && workstream.parentId === undefined,
        );
        if (created === undefined) {
          setMoveThreadId(null);
          return afterCreate;
        }
        const afterMove = await sendRequest({
          type: messageTypes.moveThread,
          threadId: moveThreadId,
          workstreamId: created.bac_id,
        });
        setMoveThreadId(null);
        return afterMove;
      }

      const next = await sendRequest({
        type: messageTypes.moveThread,
        threadId: moveThreadId,
        workstreamId: target.bac_id,
      });
      setMoveThreadId(null);
      return next;
    });
  };

  const restoreThread = (threadId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.restoreThreadTab,
        threadId,
      }),
    );
  };

  const updateTracking = (threadId: string, trackingMode: TrackedThread['trackingMode']) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateThreadTracking,
        threadId,
        trackingMode,
      }),
    );
  };

  const queueFollowUp = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!queueText.trim()) {
      return;
    }
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.queueFollowUp,
        item: {
          text: queueText.trim(),
          scope: selectedThread ? 'thread' : selectedWorkstream ? 'workstream' : 'global',
          ...(selectedThread
            ? { targetId: selectedThread }
            : selectedWorkstream
              ? { targetId: selectedWorkstream }
              : {}),
        },
      });
      setQueueText('');
      return next;
    });
  };

  const updateWorkstream = (
    workstream: WorkstreamNode,
    update: Omit<WorkstreamUpdate, 'revision'>,
  ) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: workstream.bac_id,
        update: {
          revision: workstream.revision,
          ...update,
        },
      }),
    );
  };

  const togglePrivacy = (workstream: WorkstreamNode) => {
    const nextPrivacy: PrivacyMode = workstream.privacy === 'private' ? 'shared' : 'private';
    updateWorkstream(workstream, { privacy: nextPrivacy });
  };

  const addChecklistItem = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeWorkstream === undefined || !checklistText.trim()) {
      return;
    }
    const timestamp = new Date().toISOString();
    const item: ChecklistItem = {
      id: checklistId(),
      text: checklistText.trim(),
      checked: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: activeWorkstream.bac_id,
        update: {
          revision: activeWorkstream.revision,
          checklist: [...activeWorkstream.checklist, item],
        },
      });
      setChecklistText('');
      return next;
    });
  };

  const toggleChecklistItem = (workstream: WorkstreamNode, itemId: string) => {
    const timestamp = new Date().toISOString();
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: workstream.bac_id,
        update: {
          revision: workstream.revision,
          checklist: workstream.checklist.map((item) =>
            item.id === itemId ? { ...item, checked: !item.checked, updatedAt: timestamp } : item,
          ),
        },
      }),
    );
  };

  const addTag = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeWorkstream === undefined || !tagText.trim()) {
      return;
    }
    const tag = tagText.trim();
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: activeWorkstream.bac_id,
        update: {
          revision: activeWorkstream.revision,
          tags: [...new Set([...activeWorkstream.tags, tag])],
        },
      });
      setTagText('');
      return next;
    });
  };

  const updateReminderStatus = (reminderId: string, status: InboundReminder['status']) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateReminder,
        reminderId,
        update: { status },
      }),
    );
  };

  const toggleSection = (sectionId: (typeof initialWorkboardSections)[number]['id']) => {
    const collapsed = state.collapsedSections.includes(sectionId)
      ? state.collapsedSections.filter((id) => id !== sectionId)
      : [...state.collapsedSections, sectionId];
    void runAction(() =>
      sendRequest({
        type: messageTypes.setCollapsedSections,
        collapsedSections: collapsed,
      }),
    );
  };

  const providerHealth = state.selectorHealth.find((entry) => entry.latestStatus !== 'ok');
  const selectedWorkstreamQueue = activeWorkstream
    ? state.queueItems.filter((item) => item.targetId === activeWorkstream.bac_id)
    : [];

  return (
    <main className="workboard" aria-label="Sidetrack workboard">
      <header className="workboard-header">
        <div>
          <p className="eyebrow">Sidetrack</p>
          <h1>Current Work</h1>
          <p className="subtle">
            vault: {state.companionStatus === 'vault-error' ? 'error' : 'connected'}
          </p>
        </div>
        <div className="header-actions">
          <span className={`status-pill ${state.companionStatus}`}>
            {companionStatusLabel(state.companionStatus)}
          </span>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setWizardOpen(true);
            }}
            type="button"
          >
            Setup
          </button>
        </div>
      </header>

      <div className="banner-stack">
        <SystemBannersStack
          companionStatus={state.companionStatus === 'connected' ? 'running' : 'down'}
          vaultStatus={state.companionStatus === 'vault-error' ? 'unreachable' : 'connected'}
          providerHealth={providerHealth ? 'degraded' : 'ok'}
          providerHealthDetail={providerHealth?.warning}
          queuedCount={state.queuedCaptureCount}
          onRetryCompanion={() => {
            void refresh();
          }}
          onQueueDiagnostic={() => {
            void refresh();
          }}
        />
      </div>

      {error ? <div className="banner danger">{error}</div> : null}

      <section className="toolbar">
        <button
          disabled={busy}
          onClick={() => {
            void runAction(() => sendRequest({ type: messageTypes.captureCurrentTab }));
          }}
          type="button"
        >
          Track current tab
        </button>
        <button
          disabled={busy}
          onClick={() => {
            void refresh();
          }}
          type="button"
        >
          Refresh
        </button>
      </section>

      <form className="settings-row" onSubmit={saveSettings}>
        <label>
          Port
          <input
            inputMode="numeric"
            onChange={(event) => {
              setPort(event.target.value);
            }}
            value={port}
          />
        </label>
        <label>
          Bridge key
          <input
            onChange={(event) => {
              setBridgeKey(event.target.value);
            }}
            type="password"
            value={bridgeKey}
          />
        </label>
        <button disabled={busy} type="submit">
          Connect
        </button>
      </form>

      <section className="section-list" aria-label="Workboard sections">
        {initialWorkboardSections.map((section) => {
          const collapsed = state.collapsedSections.includes(section.id);
          return (
            <article className="section-row" key={section.id}>
              <button
                className="section-heading"
                onClick={() => {
                  toggleSection(section.id);
                }}
                type="button"
              >
                <h2>{section.label}</h2>
                <span className="mono">{collapsed ? 'show' : 'hide'}</span>
              </button>
              {collapsed ? null : (
                <>
                  {section.id === 'current-tab' ? (
                    <p>{state.currentTab ? state.currentTab.title : section.emptyText}</p>
                  ) : null}
                  {section.id === 'active-work' ? (
                    <div className="item-list">
                      {threads.length === 0 ? <p>{section.emptyText}</p> : null}
                      {threads.map((thread) => (
                        <div className="thread-row" key={thread.bac_id}>
                          <div>
                            <strong>{maskTitleForPrivacy(thread, state.workstreams)}</strong>
                            <p>
                              {providerLabel(thread.provider)} / {thread.trackingMode} /{' '}
                              {thread.status}
                            </p>
                            <p className="mono">
                              {workstreamPath(thread.primaryWorkstreamId, state.workstreams)}
                            </p>
                          </div>
                          <div className="thread-actions">
                            <button
                              className="btn-link"
                              onClick={() => {
                                setMoveThreadId(thread.bac_id);
                              }}
                              type="button"
                            >
                              Move to…
                            </button>
                            {thread.trackingMode === 'stopped' ? (
                              <button
                                className="btn-link"
                                onClick={() => {
                                  updateTracking(
                                    thread.bac_id,
                                    thread.provider === 'unknown' ? 'manual' : 'auto',
                                  );
                                }}
                                type="button"
                              >
                                Resume
                              </button>
                            ) : (
                              <button
                                className="btn-link"
                                onClick={() => {
                                  updateTracking(thread.bac_id, 'stopped');
                                }}
                                type="button"
                              >
                                Stop
                              </button>
                            )}
                            <button
                              className="btn-link btn-muted"
                              onClick={() => {
                                updateTracking(thread.bac_id, 'removed');
                              }}
                              type="button"
                            >
                              Remove
                            </button>
                            {thread.status === 'restorable' ? (
                              <button
                                className="btn-link"
                                onClick={() => {
                                  setRecoveryThreadId(thread.bac_id);
                                }}
                                type="button"
                              >
                                Reopen
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {section.id === 'queued' ? (
                    <div className="item-list">
                      {state.queueItems.length === 0 ? <p>{section.emptyText}</p> : null}
                      {state.queueItems.map((item) => (
                        <div className="compact-row" key={item.bac_id}>
                          <span>{item.text}</span>
                          <span className="status-chip">{item.status}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {section.id === 'inbound' ? (
                    <div className="item-list">
                      {state.reminders.length === 0 ? <p>{section.emptyText}</p> : null}
                      {state.reminders.map((reminder) => {
                        const thread = threads.find(
                          (candidate) => candidate.bac_id === reminder.threadId,
                        );
                        return (
                          <InboundCard
                            key={reminder.bac_id}
                            masked={thread ? isThreadPrivate(thread, state.workstreams) : false}
                            reminder={{
                              bac_id: reminder.bac_id,
                              threadTitle: thread?.title ?? reminder.threadId,
                              provider: reminder.provider,
                              providerLabel: providerLabel(reminder.provider),
                              inboundTurnAt: formatRelative(reminder.detectedAt),
                              status: reminderCardStatus(reminder.status),
                              aiAuthored: true,
                            }}
                            onOpen={() => {
                              restoreThread(reminder.threadId);
                            }}
                            onMarkRelevant={() => {
                              updateReminderStatus(reminder.bac_id, 'relevant');
                            }}
                            onDismiss={() => {
                              updateReminderStatus(reminder.bac_id, 'dismissed');
                            }}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                  {section.id === 'needs-organize' ? (
                    <p>
                      {threads.filter((thread) => !thread.primaryWorkstreamId).length} unplaced
                      tracked items
                    </p>
                  ) : null}
                  {section.id === 'recent-search' ? (
                    <p>
                      {threads
                        .slice(0, 3)
                        .map((thread) => thread.title)
                        .join(' / ') || section.emptyText}
                    </p>
                  ) : null}
                </>
              )}
            </article>
          );
        })}
      </section>

      <section className="detail-panel">
        <div>
          <h2>Workstreams</h2>
          <ul className="tree">
            {rootWorkstreams.map((node) => (
              <WorkstreamLine
                all={state.workstreams}
                key={node.bac_id}
                node={node}
                onSelect={setSelectedWorkstream}
                selectedId={selectedWorkstream}
              />
            ))}
          </ul>
        </div>
        <form onSubmit={createWorkstream}>
          <label>
            Parent
            <select
              onChange={(event) => {
                setSelectedWorkstream(event.target.value);
              }}
              value={selectedWorkstream}
            >
              <option value="">Root</option>
              {workstreamOptions.map((workstream) => (
                <option key={workstream.bac_id} value={workstream.bac_id}>
                  {workstream.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            New subcluster
            <input
              onChange={(event) => {
                setWorkstreamTitle(event.target.value);
              }}
              value={workstreamTitle}
            />
          </label>
          <button disabled={busy} type="submit">
            Create
          </button>
        </form>

        {activeWorkstream ? (
          <div className="workstream-detail">
            <div className="detail-head">
              <div>
                <h2>{workstreamPath(activeWorkstream.bac_id, state.workstreams)}</h2>
                <p className="subtle">
                  {privacyLabel(activeWorkstream.privacy)} /{' '}
                  {activeWorkstream.tags.join(', ') || 'no tags'}
                </p>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  togglePrivacy(activeWorkstream);
                }}
                type="button"
              >
                Toggle privacy
              </button>
            </div>

            <div className="checklist">
              {activeWorkstream.checklist.length === 0 ? (
                <p className="subtle">No checklist items yet.</p>
              ) : null}
              {activeWorkstream.checklist.map((item) => (
                <label className="check-row detail-check" key={item.id}>
                  <input
                    checked={item.checked}
                    onChange={() => {
                      toggleChecklistItem(activeWorkstream, item.id);
                    }}
                    type="checkbox"
                  />
                  <span>{item.text}</span>
                </label>
              ))}
            </div>

            <form className="inline-form" onSubmit={addChecklistItem}>
              <label>
                Checklist item
                <input
                  onChange={(event) => {
                    setChecklistText(event.target.value);
                  }}
                  value={checklistText}
                />
              </label>
              <button disabled={busy} type="submit">
                Add item
              </button>
            </form>

            <form className="inline-form" onSubmit={addTag}>
              <label>
                Tag
                <input
                  onChange={(event) => {
                    setTagText(event.target.value);
                  }}
                  value={tagText}
                />
              </label>
              <button disabled={busy} type="submit">
                Add tag
              </button>
            </form>

            <div className="item-list">
              <h2>Queued asks</h2>
              {selectedWorkstreamQueue.length === 0 ? (
                <p className="subtle">No queued asks for this workstream.</p>
              ) : null}
              {selectedWorkstreamQueue.map((item) => (
                <div className="compact-row" key={item.bac_id}>
                  <span>{item.text}</span>
                  <span className="status-chip">{item.status}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <form className="queue-form" onSubmit={queueFollowUp}>
        <label>
          Queue follow-up
          <input
            onChange={(event) => {
              setQueueText(event.target.value);
            }}
            value={queueText}
          />
        </label>
        <select
          onChange={(event) => {
            setSelectedThread(event.target.value);
          }}
          value={selectedThread}
        >
          <option value="">No thread target</option>
          {threads.map((thread) => (
            <option key={thread.bac_id} value={thread.bac_id}>
              {thread.title}
            </option>
          ))}
        </select>
        <button disabled={busy} type="submit">
          Queue
        </button>
      </form>

      {moveThread ? (
        <MoveToPicker
          currentPath={workstreamPath(moveThread.primaryWorkstreamId, state.workstreams)}
          itemTitle={moveThread.title}
          onClose={() => {
            setMoveThreadId(null);
          }}
          onMove={handleMoveTarget}
          workstreams={workstreamOptions}
        />
      ) : null}

      {recoveryThread ? (
        <TabRecovery
          onClose={() => {
            setRecoveryThreadId(null);
          }}
          onFocusOpen={() => {
            restoreThread(recoveryThread.bac_id);
            setRecoveryThreadId(null);
          }}
          onReopenUrl={() => {
            restoreThread(recoveryThread.bac_id);
            setRecoveryThreadId(null);
          }}
          snapshot={{
            title: recoveryThread.title,
            url: recoveryThread.threadUrl,
            provider: providerLabel(recoveryThread.provider),
            favIconUrl: recoveryThread.tabSnapshot?.favIconUrl,
            capturedAt: recoveryThread.tabSnapshot?.capturedAt ?? recoveryThread.lastSeenAt,
            lastActiveAt: formatRelative(recoveryThread.lastSeenAt),
            restoreStrategy: restoreStrategyForThread(recoveryThread),
          }}
        />
      ) : null}

      {wizardOpen ? (
        <Wizard
          companionReachable={state.companionStatus === 'connected'}
          onClose={() => {
            setWizardOpen(false);
          }}
          onFinish={() => {
            setWizardOpen(false);
          }}
          onPickVault={() => {
            void refresh();
          }}
        />
      ) : null}
    </main>
  );
};

export default App;
