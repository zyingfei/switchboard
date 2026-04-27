import { useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from 'react';

import {
  companionStatusLabel,
  createEmptyWorkboardState,
  initialWorkboardSections,
  maskTitleForPrivacy,
  type TrackedThread,
  type WorkboardState,
  type WorkstreamNode,
} from '../../src/workboard';
import { isRuntimeResponse, messageTypes, type WorkboardRequest } from '../../src/messages';
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

const WorkstreamLine = ({
  node,
  all,
  depth = 0,
}: {
  readonly node: WorkstreamNode;
  readonly all: readonly WorkstreamNode[];
  readonly depth?: number;
}) => (
  <>
    <li className="tree-line" style={{ '--depth': String(depth) } as CSSProperties}>
      <span>{node.title}</span>
      <span className="muted">{node.privacy}</span>
    </li>
    {node.children
      .map((childId) => all.find((candidate) => candidate.bac_id === childId))
      .filter((child): child is WorkstreamNode => child !== undefined)
      .map((child) => (
        <WorkstreamLine all={all} depth={depth + 1} key={child.bac_id} node={child} />
      ))}
  </>
);

const App = () => {
  const [state, setState] = useState<WorkboardState>(() => createEmptyWorkboardState());
  const [bridgeKey, setBridgeKey] = useState('');
  const [port, setPort] = useState('17373');
  const [workstreamTitle, setWorkstreamTitle] = useState('');
  const [queueText, setQueueText] = useState('');
  const [selectedWorkstream, setSelectedWorkstream] = useState('');
  const [selectedThread, setSelectedThread] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rootWorkstreams = useMemo(
    () => state.workstreams.filter((workstream) => workstream.parentId === undefined),
    [state.workstreams],
  );

  const refresh = async () => {
    const next = await sendRequest({ type: messageTypes.getWorkboardState });
    setState(next);
    setBridgeKey(next.settings.companion.bridgeKey);
    setPort(String(next.settings.companion.port));
    setError(next.lastError ?? null);
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

  const moveThread = (threadId: string, workstreamId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.moveThread,
        threadId,
        workstreamId,
      }),
    );
  };

  const restoreThread = (threadId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.restoreThreadTab,
        threadId,
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

  const updatePrivacy = (workstream: WorkstreamNode) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateWorkstream,
        workstreamId: workstream.bac_id,
        update: {
          revision: workstream.revision,
          privacy: workstream.privacy === 'private' ? 'shared' : 'private',
        },
      }),
    );
  };

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
        <span className={`status-pill ${state.companionStatus}`}>
          {companionStatusLabel(state.companionStatus)}
        </span>
      </header>

      {error ? <div className="banner danger">{error}</div> : null}
      {state.queuedCaptureCount > 0 ? (
        <div className="banner warning">
          Companion disconnected / {state.queuedCaptureCount} queued
        </div>
      ) : null}
      {state.selectorHealth.some((entry) => entry.latestStatus !== 'ok') ? (
        <div className="banner warning">
          Provider selector warning / clipboard fallback available
        </div>
      ) : null}

      <section className="toolbar">
        <button
          disabled={busy}
          onClick={() => {
            void runAction(() => sendRequest({ type: messageTypes.captureCurrentTab }));
          }}
        >
          Track current tab
        </button>
        <button
          disabled={busy}
          onClick={() => {
            void refresh();
          }}
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
        {initialWorkboardSections.map((section) => (
          <article className="section-row" key={section.id}>
            <h2>{section.label}</h2>
            {section.id === 'current-tab' ? (
              <p>{state.currentTab ? state.currentTab.title : section.emptyText}</p>
            ) : null}
            {section.id === 'active-work' ? (
              <div className="item-list">
                {state.threads.length === 0 ? <p>{section.emptyText}</p> : null}
                {state.threads.map((thread) => (
                  <div className="thread-row" key={thread.bac_id}>
                    <div>
                      <strong>{maskTitleForPrivacy(thread, state.workstreams)}</strong>
                      <p>
                        {providerLabel(thread.provider)} / {thread.trackingMode} / {thread.status}
                      </p>
                    </div>
                    <select
                      onChange={(event) => {
                        moveThread(thread.bac_id, event.target.value);
                      }}
                      value={thread.primaryWorkstreamId ?? ''}
                    >
                      <option value="">Needs organize</option>
                      {state.workstreams.map((workstream) => (
                        <option key={workstream.bac_id} value={workstream.bac_id}>
                          {workstream.title}
                        </option>
                      ))}
                    </select>
                    {thread.status === 'restorable' ? (
                      <button
                        onClick={() => {
                          restoreThread(thread.bac_id);
                        }}
                      >
                        Reopen
                      </button>
                    ) : null}
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
                {state.reminders.map((reminder) => (
                  <div className="compact-row" key={reminder.bac_id}>
                    <span>{providerLabel(reminder.provider)} replied</span>
                    <span className="pulse">{reminder.status}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {section.id === 'needs-organize' ? (
              <p>
                {state.threads.filter((thread) => !thread.primaryWorkstreamId).length} unplaced
                tracked items
              </p>
            ) : null}
            {section.id === 'recent-search' ? (
              <p>
                {state.threads
                  .slice(0, 3)
                  .map((thread) => thread.title)
                  .join(' / ') || section.emptyText}
              </p>
            ) : null}
          </article>
        ))}
      </section>

      <section className="detail-panel">
        <div>
          <h2>Workstreams</h2>
          <ul className="tree">
            {rootWorkstreams.map((node) => (
              <WorkstreamLine all={state.workstreams} key={node.bac_id} node={node} />
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
              {state.workstreams.map((workstream) => (
                <option key={workstream.bac_id} value={workstream.bac_id}>
                  {workstream.title}
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
        {state.workstreams.map((workstream) => (
          <button
            className="link-button"
            key={workstream.bac_id}
            onClick={() => {
              updatePrivacy(workstream);
            }}
          >
            {workstream.title}: {workstream.privacy}
          </button>
        ))}
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
          {state.threads.map((thread) => (
            <option key={thread.bac_id} value={thread.bac_id}>
              {thread.title}
            </option>
          ))}
        </select>
        <button disabled={busy} type="submit">
          Queue
        </button>
      </form>
    </main>
  );
};

export default App;
