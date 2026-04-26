import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_STATE,
  sendRuntimeMessage,
  type ObsidianPocResponse,
  type ObsidianPocState,
} from '../../src/shared/messages';

const DEFAULT_BASE_URL = 'http://127.0.0.1:27124';
const DEFAULT_API_KEY = 'test-key';

const isStateResponse = (
  response: ObsidianPocResponse,
): response is Extract<ObsidianPocResponse, { status: 'ok'; state: ObsidianPocState }> =>
  response.status === 'ok' && 'state' in response;

export default function App() {
  const [state, setState] = useState<ObsidianPocState>(EMPTY_STATE);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const response = await sendRuntimeMessage({ type: 'OBSIDIAN_GET_STATE' });
    if (isStateResponse(response)) {
      setState(response.state);
      if (response.state.connection) {
        setBaseUrl(response.state.connection.baseUrl);
        setApiKey(response.state.connection.apiKey);
      }
    }
  }, []);

  useEffect(() => {
    void refresh().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not load state');
    });
  }, [refresh]);

  const runAction = useCallback(
    async (type: 'OBSIDIAN_CONNECT' | 'OBSIDIAN_RUN_THIN_SLICE') => {
      setBusy(true);
      setError('');
      try {
        const response = await sendRuntimeMessage(
          {
            type,
            connection: {
              baseUrl,
              apiKey,
            },
          },
          20_000,
        );
        if (response.status === 'error') {
          setError(response.reason);
          return;
        }
        if (isStateResponse(response)) {
          setState(response.state);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [apiKey, baseUrl],
  );

  const reset = async () => {
    setBusy(true);
    try {
      const response = await sendRuntimeMessage({ type: 'OBSIDIAN_RESET' });
      if (isStateResponse(response)) {
        setState(response.state);
      }
    } finally {
      setBusy(false);
    }
  };

  const passedCount = useMemo(
    () => state.result?.evidence.filter((item) => item.status === 'passed').length ?? 0,
    [state.result],
  );
  const failedCount = useMemo(
    () => state.result?.evidence.filter((item) => item.status === 'failed').length ?? 0,
    [state.result],
  );

  return (
    <main className="shell">
      <header className="topBar">
        <div>
          <p className="eyebrow">Obsidian Local REST API</p>
          <h1>BAC Obsidian POC</h1>
        </div>
        <span className={`scorePill ${failedCount > 0 ? 'bad' : 'good'}`}>
          {passedCount} passed
        </span>
      </header>

      {error ? (
        <section className="section errorPanel" role="alert">
          {error}
        </section>
      ) : null}

      <section className="section">
        <h2>Connection</h2>
        <label className="field">
          REST endpoint
          <input
            aria-label="REST endpoint"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="field">
          API key
          <input
            aria-label="API key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <div className="buttonRow">
          <button className="button secondary" disabled={busy} onClick={() => runAction('OBSIDIAN_CONNECT')}>
            Connect
          </button>
          <button className="button primary" disabled={busy} onClick={() => runAction('OBSIDIAN_RUN_THIN_SLICE')}>
            Run thin slice
          </button>
          <button className="button secondary" disabled={busy} onClick={reset}>
            Reset
          </button>
        </div>
      </section>

      <section className="section">
        <div className="sectionHeader">
          <h2>Evidence</h2>
          <span className="muted">{state.result ? `${state.result.latencyMs} ms` : 'not run'}</span>
        </div>
        {state.result ? (
          <div className="evidenceList" data-testid="evidence-list">
            {state.result.evidence.map((item) => (
              <article className="evidenceRow" data-testid={`evidence-${item.id}`} key={item.id}>
                <span className={`status status-${item.status}`}>{item.status}</span>
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.detail}</p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">Connect or run the thin slice against Obsidian Local REST API.</p>
        )}
      </section>

      <section className="section">
        <h2>Vault artifacts</h2>
        {state.result ? (
          <dl className="artifactGrid">
            <dt>Thread</dt>
            <dd data-testid="moved-path">{state.result.movedPath}</dd>
            <dt>Dashboard</dt>
            <dd>{state.result.dashboardPath}</dd>
            <dt>Canvas</dt>
            <dd data-testid="canvas-path">{state.result.canvasPath}</dd>
            <dt>Bases</dt>
            <dd data-testid="base-path">{state.result.basePath}</dd>
            <dt>Topic</dt>
            <dd data-testid="found-topic">{state.result.foundRecord?.topic ?? 'missing'}</dd>
          </dl>
        ) : (
          <p className="muted">No artifacts yet.</p>
        )}
      </section>

      <section className="section">
        <div className="sectionHeader">
          <h2>Observed files</h2>
          <span className="muted">{state.files.length} files</span>
        </div>
        <div className="fileList" data-testid="file-list">
          {state.files.length === 0 ? <p className="muted">No files listed.</p> : null}
          {state.files.map((file) => (
            <code key={file.path}>{file.path}</code>
          ))}
        </div>
      </section>
    </main>
  );
}
