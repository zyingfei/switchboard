import { useState } from 'react';
import type { RecallBuildReport, RecallQueryReport, RuntimeDevice, RecencyWindow } from '../../src/recall/model';
import { sendRecallMessage } from '../../src/shared/messages';

const defaultBaseUrl = 'http://127.0.0.1:27123';

const timings = (value: number): string => `${value.toFixed(0)} ms`;

export const App = () => {
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const [device, setDevice] = useState<RuntimeDevice>('wasm');
  const [query, setQuery] = useState('calibrated-freshness recall');
  const [window, setWindow] = useState<RecencyWindow>('3w');
  const [maskSnippets, setMaskSnippets] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'build' | 'query'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [buildReport, setBuildReport] = useState<RecallBuildReport | null>(null);
  const [queryReport, setQueryReport] = useState<RecallQueryReport | null>(null);

  const connection = {
    baseUrl,
    apiKey,
  };

  const onBuild = async () => {
    setBusy('build');
    setError(null);
    const response = await sendRecallMessage({
      type: 'bac.recall.build',
      connection,
      device,
    });
    if (!response.ok) {
      setError(response.error);
      setBusy('idle');
      return;
    }
    if (response.kind !== 'build') {
      setError('Background returned an unexpected response for build.');
      setBusy('idle');
      return;
    }
    setBuildReport(response.report);
    setBusy('idle');
  };

  const onQuery = async () => {
    setBusy('query');
    setError(null);
    const response = await sendRecallMessage({
      type: 'bac.recall.query',
      connection,
      device,
      query,
      window,
      topK: 5,
      maskSnippets,
    });
    if (!response.ok) {
      setError(response.error);
      setBusy('idle');
      return;
    }
    if (response.kind !== 'query') {
      setError('Background returned an unexpected response for query.');
      setBusy('idle');
      return;
    }
    setQueryReport(response.report);
    setBusy('idle');
  };

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Vault substrate, rebuildable cache</p>
        <h1>BAC Recall Vector POC</h1>
        <p className="lede">
          Rebuild a local vector index from Obsidian vault files, then rank recall hits with the
          3d / 3w / 3m / 3y freshness tiers.
        </p>
      </section>

      <section className="panel">
        <label>
          <span>Obsidian REST endpoint</span>
          <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
        </label>
        <label>
          <span>API key</span>
          <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" />
        </label>
        <label>
          <span>Embedding device</span>
          <select value={device} onChange={(event) => setDevice(event.target.value as RuntimeDevice)}>
            <option value="wasm">WASM</option>
            <option value="webgpu">WebGPU (fallbacks to WASM)</option>
          </select>
        </label>
        <div className="buttonRow">
          <button onClick={onBuild} disabled={busy !== 'idle'}>
            {busy === 'build' ? 'Building index...' : 'Build vault index'}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="queryHeader">
          <h2>Recall query</h2>
          <label className="toggle">
            <input
              checked={maskSnippets}
              onChange={(event) => setMaskSnippets(event.target.checked)}
              type="checkbox"
            />
            <span>Screen-share-safe mode</span>
          </label>
        </div>
        <label>
          <span>Query</span>
          <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={4} />
        </label>
        <label>
          <span>Freshness tier</span>
          <select value={window} onChange={(event) => setWindow(event.target.value as RecencyWindow)}>
            <option value="3d">3 days</option>
            <option value="3w">3 weeks</option>
            <option value="3m">3 months</option>
            <option value="3y">3 years</option>
          </select>
        </label>
        <div className="buttonRow">
          <button onClick={onQuery} disabled={busy !== 'idle' || query.trim().length === 0}>
            {busy === 'query' ? 'Running recall...' : 'Run recall'}
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel danger" data-testid="recall-error">
          <h2>Request failed</h2>
          <p>{error}</p>
        </section>
      ) : null}

      {buildReport ? (
        <section className="panel" data-testid="build-report">
          <h2>Build report</h2>
          <dl className="metrics">
            <div>
              <dt>Storage</dt>
              <dd>{buildReport.storage}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{buildReport.modelId}</dd>
            </div>
            <div>
              <dt>Device</dt>
              <dd>
                {buildReport.resolvedDevice}
                {buildReport.resolvedDevice !== buildReport.requestedDevice ? ' (fallback)' : ''}
              </dd>
            </div>
            <div>
              <dt>Documents</dt>
              <dd>{buildReport.documents}</dd>
            </div>
            <div>
              <dt>Chunks</dt>
              <dd>{buildReport.chunks}</dd>
            </div>
            <div>
              <dt>Unique embeddings</dt>
              <dd>{buildReport.uniqueDigests}</dd>
            </div>
            <div>
              <dt>Embedded now</dt>
              <dd>{buildReport.embeddedDigests}</dd>
            </div>
            <div>
              <dt>Cached</dt>
              <dd>{buildReport.cachedDigests}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{timings(buildReport.timings.totalMs)}</dd>
            </div>
          </dl>
          <p className="timingLine">
            Load {timings(buildReport.timings.loadMs)} · chunk {timings(buildReport.timings.chunkMs)} ·
            cache {timings(buildReport.timings.cacheMs)} · embed {timings(buildReport.timings.embedMs)} ·
            hydrate {timings(buildReport.timings.hydrateMs)}
          </p>
        </section>
      ) : null}

      {queryReport ? (
        <section className="panel" data-testid="query-report">
          <h2>Top hits</h2>
          <p className="timingLine">
            Query embed {timings(queryReport.queryEmbeddingMs)} · search {timings(queryReport.searchMs)} ·
            total {timings(queryReport.latencyMs)}
          </p>
          <ul className="hitList">
            {queryReport.hits.map((hit) => (
              <li key={hit.chunkId}>
                <div className="hitHeader">
                  <strong>{hit.title}</strong>
                  <span>
                    {hit.score.toFixed(3)} score · {hit.recencyBucket}
                  </span>
                </div>
                <p className="muted">
                  {hit.sourcePath} · {hit.ageDays}d old · sim {hit.similarity.toFixed(3)} × boost{' '}
                  {hit.freshnessBoost.toFixed(3)}
                </p>
                <p>{hit.snippet}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
};
