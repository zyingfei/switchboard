import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PatchMode } from '../../src/patch/markdownPatch';
import type { ForkProvider } from '../../src/adapters/providers';
import { sendRuntimeMessage, type PocResponse, type WorkflowState } from '../../src/shared/messages';

const EMPTY_STATE: WorkflowState = {
  note: null,
  runs: [],
  responses: [],
  adoptedSources: [],
  threadRegistry: [],
  preflights: [],
  patchPreview: null,
  vaultProjection: null,
  contextPack: null,
  dejaVuHits: [],
  mcpSmoke: null,
  eventCount: 0,
};

const DEFAULT_NOTE = '# Brainstorm\nPlease review this product idea.\n';

const isStateResponse = (
  response: PocResponse,
): response is Extract<PocResponse, { status: 'ok'; state: WorkflowState }> =>
  response.status === 'ok' && 'state' in response;

const statusLabel = (status: string): string => status.charAt(0).toUpperCase() + status.slice(1);

export default function App() {
  const [state, setState] = useState<WorkflowState>(EMPTY_STATE);
  const [noteContent, setNoteContent] = useState(DEFAULT_NOTE);
  const [recallProbe, setRecallProbe] = useState('local-first AI workstream switchboard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const response = await sendRuntimeMessage({ type: 'POC_GET_STATE' });
    if (isStateResponse(response)) {
      setState(response.state);
      if (response.state.note?.content !== undefined) {
        setNoteContent(response.state.note.content);
      }
    }
  }, []);

  useEffect(() => {
    void refresh().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not load workflow state');
    });
    const interval = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 500);
    return () => clearInterval(interval);
  }, [refresh]);

  const runAction = useCallback(
    async (action: () => Promise<PocResponse>) => {
      setBusy(true);
      setError('');
      try {
        const response = await action();
        if (response.status === 'error') {
          setError(response.reason);
          return;
        }
        if (isStateResponse(response)) {
          setState(response.state);
          if (response.state.note?.content !== undefined) {
            setNoteContent(response.state.note.content);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const saveNote = () =>
    runAction(() =>
      sendRuntimeMessage({
        type: 'POC_SAVE_NOTE',
        content: noteContent,
      }),
    );

  const fork = (providers: ForkProvider[]) =>
    runAction(() =>
      sendRuntimeMessage(
        {
          type: 'POC_FORK',
          providers,
          noteContent,
          autoSend: true,
        },
        15_000,
      ),
    );

  const buildPatch = (mode: PatchMode) =>
    runAction(() =>
      sendRuntimeMessage({
        type: 'POC_BUILD_PATCH',
        mode,
      }),
    );

  const simpleAction = (type:
    | 'POC_OPEN_THREAD_FIXTURES'
    | 'POC_REFRESH_THREAD_REGISTRY'
    | 'POC_ADOPT_ACTIVE_TAB'
    | 'POC_BUILD_VAULT_PROJECTION'
    | 'POC_BUILD_CONTEXT_PACK'
    | 'POC_MCP_SMOKE') =>
    runAction(() => sendRuntimeMessage({ type }, 15_000));

  const checkDejaVu = () =>
    runAction(() =>
      sendRuntimeMessage({
        type: 'POC_CHECK_DEJA_VU',
        probeText: recallProbe,
      }),
    );

  const doneResponses = useMemo(
    () => state.runs.filter((run) => run.status === 'done' && run.response),
    [state.runs],
  );

  return (
    <main className="shell">
      <header className="topBar">
        <div>
          <p className="eyebrow">Local-first POC</p>
          <h1>Browser AI Companion</h1>
        </div>
        <span className="eventPill" aria-label="Event count">
          {state.eventCount} events
        </span>
      </header>

      {error ? (
        <section className="section errorPanel" role="alert">
          {error}
        </section>
      ) : null}

      <section className="section">
        <div className="sectionHeader">
          <h2>Current note</h2>
          <button className="button secondary" disabled={busy} onClick={saveNote}>
            Save
          </button>
        </div>
        <textarea
          aria-label="Markdown note"
          className="noteEditor"
          value={noteContent}
          onChange={(event) => setNoteContent(event.target.value)}
        />
      </section>

      <section className="section">
        <h2>Fork controls</h2>
        <div className="buttonRow">
          <button className="button" disabled={busy} onClick={() => fork(['mock-chat-a'])}>
            Fork to mock Chat A
          </button>
          <button className="button" disabled={busy} onClick={() => fork(['mock-chat-b'])}>
            Fork to mock Chat B
          </button>
          <button className="button secondary" disabled={busy} onClick={() => fork(['google-search'])}>
            Fork to Google Search
          </button>
          <button className="button secondary" disabled={busy} onClick={() => fork(['duckduckgo-search'])}>
            Fork to DuckDuckGo
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => fork(['mock-chat-a', 'mock-chat-b'])}
          >
            Fork to both chats
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => fork(['google-search', 'duckduckgo-search'])}
          >
            Fork to search engines
          </button>
        </div>
        {state.preflights.length > 0 ? (
          <div className="preflightList" aria-label="Dispatch preflight warnings">
            {state.preflights.map((preflight) => (
              <div className="preflight" key={`${preflight.targetProvider}-${preflight.targetUrl}`}>
                <strong>{preflight.targetProvider}</strong>
                <span>{preflight.promptLength} chars</span>
                <span>{preflight.autoSend ? 'auto-send' : 'paste-only'}</span>
                {preflight.warnings.length > 0 ? (
                  <span className="warning">{preflight.warnings.join(', ')}</span>
                ) : (
                  <span>No warnings</span>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="section">
        <div className="sectionHeader">
          <h2>Thread registry</h2>
          <span className="muted">{state.threadRegistry.length} threads</span>
        </div>
        <div className="buttonRow">
          <button className="button primary" disabled={busy} onClick={() => simpleAction('POC_ADOPT_ACTIVE_TAB')}>
            Add active tab to discussion
          </button>
          <button className="button secondary" disabled={busy} onClick={() => simpleAction('POC_OPEN_THREAD_FIXTURES')}>
            Open fixture threads
          </button>
          <button className="button secondary" disabled={busy} onClick={() => simpleAction('POC_REFRESH_THREAD_REGISTRY')}>
            Refresh registry
          </button>
        </div>
        {state.adoptedSources.length > 0 ? (
          <div className="runList">
            {state.adoptedSources.map((source) => (
              <article className="runRow" data-testid={`source-${source.id}`} key={source.id}>
                <div>
                  <strong>{source.title}</strong>
                  <span className="status status-done">source</span>
                  <p className="muted">{source.url}</p>
                </div>
              </article>
            ))}
          </div>
        ) : null}
        <div className="runList">
          {state.threadRegistry.length === 0 ? <p className="muted">No observed threads yet.</p> : null}
          {state.threadRegistry.map((thread) => (
            <article className="runRow" data-testid={`thread-${thread.provider}`} key={thread.id}>
              <div>
                <strong>{thread.title}</strong>
                <span className={`status status-${thread.status}`}>{thread.provider}</span>
                <p className="muted">
                  {thread.status}; last speaker: {thread.lastSpeaker}; canary: {thread.selectorCanary}
                </p>
              </div>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  runAction(() =>
                    sendRuntimeMessage({
                      type: 'POC_FOCUS_TAB',
                      tabId: thread.tabId,
                    }),
                  )
                }
              >
                Open tab
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Run status</h2>
        <div className="runList">
          {state.runs.length === 0 ? <p className="muted">No runs yet.</p> : null}
          {state.runs.map((run) => (
            <article className="runRow" data-testid={`run-${run.provider}`} key={run.id}>
              <div>
                <strong>{run.title}</strong>
                <span className={`status status-${run.status}`}>{statusLabel(run.status)}</span>
                {run.failureReason ? <p className="warning">{run.failureReason}</p> : null}
              </div>
              {run.tabId ? (
                <button
                  className="button secondary"
                  onClick={() =>
                    runAction(() =>
                      sendRuntimeMessage({
                        type: 'POC_FOCUS_TAB',
                        tabId: run.tabId as number,
                      }),
                    )
                  }
                >
                  Open tab
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="sectionHeader">
          <h2>Converge view</h2>
          <span className="muted">{doneResponses.length} ready</span>
        </div>
        <div className="responseGrid">
          {state.runs.map((run) => (
            <article className="responsePane" data-testid={`response-${run.provider}`} key={run.id}>
              <h3>{run.title}</h3>
              <pre>{run.response?.content ?? 'Waiting for response...'}</pre>
            </article>
          ))}
        </div>
        <div className="buttonRow">
          <button className="button secondary" disabled={doneResponses.length === 0 || busy} onClick={() => buildPatch('useA')}>
            Use A
          </button>
          <button className="button secondary" disabled={doneResponses.length === 0 || busy} onClick={() => buildPatch('useB')}>
            Use B
          </button>
          <button className="button primary" disabled={doneResponses.length === 0 || busy} onClick={() => buildPatch('appendBoth')}>
            Append both
          </button>
        </div>
      </section>

      <section className="section">
        <h2>Patch preview</h2>
        {state.patchPreview ? (
          <>
            <div className="patchGrid">
              <label>
                Original
                <textarea readOnly value={state.patchPreview.original} />
              </label>
              <label>
                Proposed updated markdown
                <textarea data-testid="patch-proposed" readOnly value={state.patchPreview.proposed} />
              </label>
            </div>
            <div className="buttonRow">
              <button
                className="button primary"
                disabled={busy}
                onClick={() => runAction(() => sendRuntimeMessage({ type: 'POC_ACCEPT_PATCH' }))}
              >
                Accept patch
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => runAction(() => sendRuntimeMessage({ type: 'POC_REJECT_PATCH' }))}
              >
                Reject patch
              </button>
            </div>
          </>
        ) : (
          <p className="muted">No patch preview yet.</p>
        )}
      </section>

      <section className="section">
        <h2>Vault, Context Pack, MCP</h2>
        <div className="buttonRow">
          <button className="button secondary" disabled={busy} onClick={() => simpleAction('POC_BUILD_VAULT_PROJECTION')}>
            Build vault projection
          </button>
          <button className="button secondary" disabled={busy} onClick={() => simpleAction('POC_BUILD_CONTEXT_PACK')}>
            Build Context Pack
          </button>
          <button className="button secondary" disabled={busy} onClick={() => simpleAction('POC_MCP_SMOKE')}>
            MCP smoke
          </button>
        </div>
        {state.vaultProjection ? (
          <article className="responsePane" data-testid="vault-projection">
            <h3>Vault projection files</h3>
            <pre>{state.vaultProjection.files.map((file) => file.path).join('\n')}</pre>
          </article>
        ) : null}
        {state.contextPack ? (
          <article className="responsePane" data-testid="context-pack">
            <h3>Context Pack</h3>
            <pre>{state.contextPack.markdown.slice(0, 1200)}</pre>
          </article>
        ) : null}
        {state.mcpSmoke ? (
          <article className="responsePane" data-testid="mcp-smoke">
            <h3>MCP smoke result</h3>
            <pre>{JSON.stringify(state.mcpSmoke.result ?? state.mcpSmoke.error, null, 2)}</pre>
          </article>
        ) : null}
      </section>

      <section className="section">
        <h2>Déjà-vu recall</h2>
        <textarea
          aria-label="Recall probe"
          className="compactEditor"
          value={recallProbe}
          onChange={(event) => setRecallProbe(event.target.value)}
        />
        <div className="buttonRow">
          <button className="button secondary" disabled={busy} onClick={checkDejaVu}>
            Check déjà-vu
          </button>
        </div>
        <div className="runList" data-testid="deja-vu-hits">
          {state.dejaVuHits.length === 0 ? <p className="muted">No recall hits yet.</p> : null}
          {state.dejaVuHits.map((hit) => (
            <article className="runRow" key={hit.nodeId}>
              <div>
                <strong>{hit.title}</strong>
                <span className="status status-done">score {hit.score}</span>
                <p className="muted">
                  {hit.ageDays} days old {hit.provider ? `from ${hit.provider}` : ''}
                </p>
                <pre>{hit.excerpt}</pre>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
