import { useEffect, useMemo, useState } from 'react';
import {
  buildArtifactDownloadName,
  buildCaptureDownloadName,
  renderArtifactMarkdown,
  renderCaptureMarkdown,
} from '../../src/capture/export';
import type { CapturedArtifact, CaptureState, ProviderCapture, ProviderSelectorHealth } from '../../src/capture/model';
import { normalizeCaptureState, providerLabels, supportedProviderIds } from '../../src/capture/model';
import { providerMessages, type ProviderRequest, type ProviderResponse } from '../../src/shared/messages';

const initialState: CaptureState = {
  captures: [],
  lastActiveTab: null,
  selectorHealth: [],
  lastError: null,
  updatedAt: new Date(0).toISOString(),
};

const sendProviderMessage = async (request: ProviderRequest): Promise<ProviderResponse> =>
  (await chrome.runtime.sendMessage(request)) as ProviderResponse;

const turnLabel = (capture: ProviderCapture): string => {
  const turnCount = capture.turns?.length ?? 0;
  const artifactCount = capture.artifacts?.length ?? 0;
  return `${providerLabels[capture.provider]} - ${turnCount} turn${turnCount === 1 ? '' : 's'}${
    artifactCount > 0 ? ` + ${artifactCount} artifact${artifactCount === 1 ? '' : 's'}` : ''
  }`;
};

const saveCaptureMarkdown = (capture: ProviderCapture) => {
  const blob = new Blob([renderCaptureMarkdown(capture)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = buildCaptureDownloadName(capture);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const saveArtifactMarkdown = (capture: ProviderCapture, artifact: CapturedArtifact) => {
  const blob = new Blob([renderArtifactMarkdown(capture, artifact)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = buildArtifactDownloadName(capture, artifact);
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const openDownloadLink = (url: string) => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noreferrer';
  anchor.download = '';
  anchor.click();
};

const selectorHealthLabel = (health: ProviderSelectorHealth): string =>
  health.recentLoads === 0 ? 'No local canary loads yet.' : `${health.cleanLoads}/${health.recentLoads} recent loads clean`;

const latestSelectorHealthLabel = (health: ProviderSelectorHealth): string =>
  health.latestStatus ? `Latest: ${health.latestStatus}` : 'Latest: none yet';

const trackedStatusLabel = (value: string | undefined): string => {
  if (!value) {
    return 'Checking';
  }
  return value.replace(/_/g, ' ');
};

export default function App() {
  const [state, setState] = useState<CaptureState>(initialState);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready');

  const selectedCapture = useMemo(
    () => state.captures.find((capture) => capture.id === selectedCaptureId) ?? state.captures[0] ?? null,
    [selectedCaptureId, state.captures],
  );
  const fallbackRecommended =
    state.lastActiveTab?.trackedThreadStatus === 'fallback' || state.lastActiveTab?.trackedThreadStatus === 'stale';
  const selectorHealth = useMemo(
    () =>
      supportedProviderIds.map(
        (provider) => state.selectorHealth.find((entry) => entry.provider === provider) ?? { provider, cleanLoads: 0, recentLoads: 0, fallbackLoads: 0, failedLoads: 0 },
      ),
    [state.selectorHealth],
  );

  const applyResponse = (response: ProviderResponse) => {
    if (!response.ok) {
      setState(response.state ? normalizeCaptureState(response.state) : state);
      throw new Error(response.error);
    }
    if ('state' in response) {
      setState(normalizeCaptureState(response.state));
    }
    if ('capture' in response && response.capture) {
      setSelectedCaptureId(response.capture.id);
    }
  };

  const runAction = async (label: string, request: ProviderRequest) => {
    setBusy(true);
    setStatus(label);
    try {
      const response = await sendProviderMessage(request);
      applyResponse(response);
      setStatus('Done');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveFormatted = () => {
    if (!selectedCapture) {
      return;
    }

    saveCaptureMarkdown(selectedCapture);
    setStatus('Saved formatted capture');
  };

  const handleSaveArtifact = (artifact: CapturedArtifact) => {
    if (!selectedCapture) {
      return;
    }

    saveArtifactMarkdown(selectedCapture, artifact);
    setStatus(`Saved artifact: ${artifact.title}`);
  };

  const handleCaptureClipboardFallback = async () => {
    setBusy(true);
    setStatus('Capturing clipboard fallback');
    try {
      const response = await sendProviderMessage({ type: providerMessages.captureActiveTab });
      applyResponse(response);
      if (!response.ok || !('capture' in response) || !response.capture) {
        throw new Error(response.ok ? 'Capture did not return visible text.' : response.error);
      }
      await navigator.clipboard.writeText(renderCaptureMarkdown(response.capture));
      setStatus('Copied fallback capture to clipboard');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Clipboard fallback failed');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void runAction('Loading state', { type: providerMessages.getState });
    const timer = window.setInterval(() => {
      void sendProviderMessage({ type: providerMessages.getState }).then((response) => {
        if (response.ok && 'state' in response) {
          setState(normalizeCaptureState(response.state));
        }
      });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">POC 2</p>
          <h1>Provider Capture POC</h1>
        </div>
        <button
          className="button"
          disabled={busy}
          onClick={() => runAction('Refreshing active tab', { type: providerMessages.getState })}
        >
          Refresh
        </button>
      </header>

      <section className="panel" aria-labelledby="active-tab-heading">
        <div className="section-heading">
          <h2 id="active-tab-heading">Active Tab</h2>
          <span className="status" data-testid="capture-status">
            {status}
          </span>
        </div>
        <p className="hint" data-testid="local-storage-note">
          Captures stay on this machine in <code>chrome.storage.local</code>. No backend, sync, screenshots, cookies,
          or hidden-field reads.
        </p>
        <dl className="tab-summary">
          <div>
            <dt>Provider</dt>
            <dd data-testid="active-provider">
              {state.lastActiveTab ? providerLabels[state.lastActiveTab.provider] : 'No tab'}
            </dd>
          </div>
          <div>
            <dt>Title</dt>
            <dd data-testid="active-title">{state.lastActiveTab?.title ?? 'No capture-ready tab'}</dd>
          </div>
          <div>
            <dt>URL</dt>
            <dd className="url">{state.lastActiveTab?.url ?? 'Open a provider tab, then capture.'}</dd>
          </div>
          <div>
            <dt>Extractor</dt>
            <dd data-testid="active-extractor-status">
              {state.lastActiveTab?.supported ? trackedStatusLabel(state.lastActiveTab.trackedThreadStatus) : 'n/a'}
            </dd>
          </div>
        </dl>
        {state.lastActiveTab?.reason ? <p className="hint">{state.lastActiveTab.reason}</p> : null}
        {state.lastActiveTab?.warning ? (
          <p className="warning-panel" data-testid="active-warning">
            {state.lastActiveTab.warning}
          </p>
        ) : null}
        <div className="actions">
          <button
            className="button primary"
            data-testid="capture-active-tab"
            disabled={busy || !state.lastActiveTab}
            onClick={() => runAction('Capturing active tab', { type: providerMessages.captureActiveTab })}
          >
            Capture active tab
          </button>
          {fallbackRecommended ? (
            <button
              className="button quiet"
              data-testid="copy-capture-fallback"
              disabled={busy || !state.lastActiveTab}
              onClick={handleCaptureClipboardFallback}
            >
              Capture + copy fallback
            </button>
          ) : null}
        </div>
      </section>

      <section className="panel" aria-labelledby="health-heading">
        <div className="section-heading">
          <h2 id="health-heading">Extractor Health</h2>
          <button
            className="button quiet"
            disabled={busy || selectorHealth.every((health) => health.recentLoads === 0)}
            onClick={() => runAction('Clearing selector health', { type: providerMessages.clearSelectorHealth })}
          >
            Reset health
          </button>
        </div>
        <p className="hint">Local-only selector canary counts from recent provider tab loads. No telemetry or network calls.</p>
        <div className="health-list" data-testid="selector-health">
          {selectorHealth.map((health) => (
            <article className="health-card" key={health.provider}>
              <strong>{providerLabels[health.provider]}</strong>
              <span>{selectorHealthLabel(health)}</span>
              <small>{latestSelectorHealthLabel(health)}</small>
              <small>
                fallback {health.fallbackLoads} · failed {health.failedLoads}
              </small>
            </article>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="captures-heading">
        <div className="section-heading">
          <h2 id="captures-heading">Captures</h2>
          <button
            className="button quiet"
            disabled={busy || state.captures.length === 0}
            onClick={() => runAction('Clearing captures', { type: providerMessages.clearCaptures })}
          >
            Clear
          </button>
        </div>
        {state.captures.length === 0 ? <p className="hint">No captures yet.</p> : null}
        <div className="capture-list">
          {state.captures.map((capture) => (
            <button
              className="capture-card"
              data-testid={`capture-card-${capture.provider}`}
              key={capture.id}
              onClick={() => setSelectedCaptureId(capture.id)}
              aria-pressed={selectedCapture?.id === capture.id}
            >
              <strong>{turnLabel(capture)}</strong>
              <span>{capture.title}</span>
              <small>{capture.selectorCanary}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="preview-heading">
        <div className="section-heading">
          <h2 id="preview-heading">Capture Preview</h2>
          <div className="actions">
            <button
              className="button quiet"
              data-testid="save-formatted-capture"
              disabled={!selectedCapture}
              onClick={handleSaveFormatted}
            >
              Save formatted
            </button>
          </div>
        </div>
        {!selectedCapture ? <p className="hint">Select or create a capture.</p> : null}
        {selectedCapture ? (
          <div data-testid="capture-preview">
            <div className="preview-meta">
              <span>{providerLabels[selectedCapture.provider]}</span>
              <span>{selectedCapture.selectorCanary}</span>
              <span>{selectedCapture.visibleTextCharCount} chars</span>
              {selectedCapture.extractionConfigVersion ? <span>{selectedCapture.extractionConfigVersion}</span> : null}
            </div>
            <p className="url">{selectedCapture.url}</p>
            {(selectedCapture.warnings?.length ?? 0) > 0 ? (
              <ul className="warnings" data-testid="capture-warnings">
                {selectedCapture.warnings.map((warning) => (
                  <li key={warning.code}>{warning.message}</li>
                ))}
              </ul>
            ) : null}
            {(selectedCapture.artifacts?.length ?? 0) > 0 ? (
              <section className="artifact-list" data-testid="capture-artifacts">
                <h3>Artifacts</h3>
                {selectedCapture.artifacts.map((artifact) => (
                  <article className="artifact" key={artifact.id} data-testid={`artifact-${artifact.kind}`}>
                    <div className="artifact-header">
                      <div className="stacked artifact-title">
                        <strong>{artifact.title}</strong>
                        <small>{artifact.kind}</small>
                      </div>
                      <button
                        className="button quiet"
                        data-testid={`save-artifact-${artifact.id}`}
                        onClick={() => handleSaveArtifact(artifact)}
                      >
                        Save artifact
                      </button>
                    </div>
                    {artifact.sourceUrl ? <p className="url">{artifact.sourceUrl}</p> : null}
                    {(artifact.links?.length ?? 0) > 0 ? (
                      <div className="artifact-links">
                        {artifact.links.map((link) => (
                          <button
                            className="button quiet"
                            data-testid={`artifact-link-${artifact.id}-${link.id}`}
                            key={link.id}
                            onClick={() => openDownloadLink(link.url)}
                            title={link.url}
                          >
                            {link.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <pre>{artifact.formattedText}</pre>
                  </article>
                ))}
              </section>
            ) : null}
            <div className="turns">
              {selectedCapture.turns.map((turn) => (
                <article className="turn" key={turn.id} data-testid={`turn-${turn.role}`}>
                  <header>
                    <strong>{turn.role}</strong>
                    <small>{turn.sourceSelector}</small>
                  </header>
                  <pre>{turn.formattedText ?? turn.text}</pre>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
