import { useEffect, useState } from 'react';

import { formatRelative } from '../../../src/util/time';
import { Icons } from './icons';

interface CaptureProviderHealth {
  readonly provider: string;
  readonly lastCaptureAt: string | null;
  readonly lastStatus: 'ok' | 'warning' | 'failed' | null;
  readonly ok24h: number;
  readonly warn24h: number;
  readonly fail24h: number;
  readonly warning?: string;
}

interface CaptureWarningHealth {
  readonly provider: string;
  readonly capturedAt: string;
  readonly code: string;
  readonly message: string;
  readonly severity: 'info' | 'warning';
}

interface RecallActivityEvent {
  readonly kind:
    | 'incremental-index'
    | 'rebuild-started'
    | 'rebuild-finished'
    | 'rebuild-failed'
    | 'query'
    | 'suggestion';
  readonly at: string;
  readonly count?: number;
  readonly threadIds?: readonly string[];
  readonly queryLength?: number;
  readonly resultCount?: number;
  readonly threadId?: string;
  readonly reason?: 'startup' | 'manual' | 'reconnect';
  readonly error?: string;
}

interface RecallActivityReport {
  readonly lastIndexedAt: string | null;
  readonly lastIndexedCount: number | null;
  readonly lastIndexedThreadIds: readonly string[];
  readonly lastRecallQueryAt: string | null;
  readonly lastRecallQueryResultCount: number | null;
  readonly lastSuggestionAt: string | null;
  readonly lastSuggestionThreadId: string | null;
  readonly recent: readonly RecallActivityEvent[];
}

interface HealthReport {
  readonly uptimeSec: number;
  readonly vault: {
    readonly root: string;
    readonly writable: boolean;
    readonly sizeBytes: number | null;
  };
  readonly capture: {
    readonly lastByProvider: Record<string, string | null>;
    readonly queueDepthHint: number | null;
    readonly droppedHint: number | null;
    readonly providers?: readonly CaptureProviderHealth[];
    readonly recentWarnings?: readonly CaptureWarningHealth[];
  };
  readonly recall: {
    readonly indexExists: boolean;
    readonly entryCount: number | null;
    readonly modelId: string | null;
    readonly sizeBytes: number | null;
    readonly status?: 'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready';
    readonly eventTurnCount?: number;
    readonly currentModelId?: string | null;
    readonly companionVersion?: string;
    readonly lastRebuildAt?: string | null;
    readonly lastRebuildIndexed?: number | null;
    readonly lastError?: string | null;
    readonly rebuildEmbedded?: number;
    readonly rebuildTotal?: number;
    readonly embedderDevice?: 'cpu' | 'wasm' | 'webgpu' | 'unknown';
    readonly embedderAccelerator?: 'accelerate' | 'mkl' | 'cpu' | 'unknown';
    readonly activity?: RecallActivityReport;
  };
  readonly service: { readonly installed: boolean; readonly running: boolean };
}

interface HealthPanelProps {
  readonly onClose: () => void;
  readonly companionPort?: number | null;
  readonly bridgeKey?: string | null;
  readonly queuedCaptureCount?: number;
  readonly droppedCaptureCount?: number;
}

const isHealthReport = (value: unknown): value is HealthReport => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<HealthReport>;
  return (
    typeof v.uptimeSec === 'number' &&
    typeof v.vault === 'object' &&
    typeof v.capture === 'object' &&
    typeof v.recall === 'object' &&
    typeof v.service === 'object'
  );
};

const providerLabel = (provider: string): string => {
  if (provider === 'chatgpt' || provider === 'gpt') return 'ChatGPT';
  if (provider === 'claude') return 'Claude';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'codex') return 'Codex';
  return provider;
};

const providerClass = (provider: string): string =>
  provider === 'chatgpt' ? 'gpt' : provider.toLowerCase().replace(/[^a-z0-9_-]/gu, '-');

const formatBytes = (n: number | null): string => {
  if (n === null) return '?';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const formatCount = (value: number | null): string => {
  if (value === null) return '?';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
};

const formatWhen = (iso: string | null | undefined): string => {
  if (iso === null || iso === undefined || iso.length === 0) return '-';
  return formatRelative(iso);
};

const statusState = (status: CaptureProviderHealth['lastStatus']): 'ok' | 'warn' =>
  status === 'ok' || status === null ? 'ok' : 'warn';

const fallbackProviderRows = (
  lastByProvider: Record<string, string | null>,
): readonly CaptureProviderHealth[] =>
  Object.entries(lastByProvider)
    .map(([provider, lastCaptureAt]) => ({
      provider,
      lastCaptureAt,
      lastStatus: null,
      ok24h: 0,
      warn24h: 0,
      fail24h: 0,
    }))
    .sort((left, right) => (right.lastCaptureAt ?? '').localeCompare(left.lastCaptureAt ?? ''));

const formatEmbedderLabel = (
  device: 'cpu' | 'wasm' | 'webgpu' | 'unknown',
  accelerator: 'accelerate' | 'mkl' | 'cpu' | 'unknown' | undefined,
): string => {
  if (device === 'wasm') return 'wasm (slow)';
  if (device === 'webgpu') return 'webgpu';
  if (device === 'cpu') {
    if (accelerator === 'accelerate') return 'cpu (Accelerate)';
    if (accelerator === 'mkl') return 'cpu (MKL)';
    return 'cpu';
  }
  return device;
};

const activityText = (event: RecallActivityEvent): string => {
  if (event.kind === 'incremental-index') {
    const ids =
      event.threadIds !== undefined && event.threadIds.length > 0
        ? ` · ${event.threadIds.join(', ')}`
        : '';
    return `Indexed ${String(event.count ?? 0)} turn${event.count === 1 ? '' : 's'}${ids}`;
  }
  if (event.kind === 'rebuild-started') {
    return `Rebuild started${event.reason === undefined ? '' : ` · ${event.reason}`}`;
  }
  if (event.kind === 'rebuild-finished') {
    return `Rebuild finished · ${String(event.count ?? 0)} turn${event.count === 1 ? '' : 's'}`;
  }
  if (event.kind === 'rebuild-failed') {
    return `Rebuild failed${event.error === undefined ? '' : ` · ${event.error}`}`;
  }
  if (event.kind === 'query') {
    return `Thread search · ${String(event.resultCount ?? 0)} result${event.resultCount === 1 ? '' : 's'} · ${String(event.queryLength ?? 0)} chars`;
  }
  return `Group recommendation · ${event.threadId ?? 'thread'} · ${String(event.resultCount ?? 0)} result${event.resultCount === 1 ? '' : 's'}`;
};

export function HealthPanel({
  onClose,
  companionPort,
  bridgeKey,
  queuedCaptureCount,
  droppedCaptureCount,
}: HealthPanelProps) {
  const [copied, setCopied] = useState(false);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'live' | 'unavailable' | 'not-configured'>(
    companionPort === undefined || companionPort === null || !bridgeKey
      ? 'not-configured'
      : 'loading',
  );
  type RebuildState = { kind: 'idle' } | { kind: 'accepted' } | { kind: 'error'; message: string };
  const [rebuildState, setRebuildState] = useState<RebuildState>({ kind: 'idle' });

  const fetchReport = async (): Promise<void> => {
    if (companionPort === undefined || companionPort === null || !bridgeKey) {
      setReport(null);
      setLoadState('not-configured');
      return;
    }
    try {
      const url = `http://127.0.0.1:${String(companionPort)}/v1/system/health`;
      const response = await fetch(url, { headers: { 'x-bac-bridge-key': bridgeKey } });
      if (!response.ok) {
        setLoadState('unavailable');
        return;
      }
      const body = (await response.json()) as { readonly data?: unknown };
      if (!isHealthReport(body.data)) {
        setLoadState('unavailable');
        return;
      }
      setReport(body.data);
      setLoadState('live');
    } catch {
      setLoadState('unavailable');
    }
  };

  const triggerRebuild = async (): Promise<void> => {
    if (companionPort === undefined || companionPort === null || !bridgeKey) {
      setRebuildState({ kind: 'error', message: 'Companion not configured.' });
      return;
    }
    setRebuildState({ kind: 'accepted' });
    try {
      const url = `http://127.0.0.1:${String(companionPort)}/v1/recall/rebuild`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'x-bac-bridge-key': bridgeKey },
      });
      if (!response.ok) {
        setRebuildState({ kind: 'error', message: `HTTP ${String(response.status)}` });
        return;
      }
      const body = (await response.json()) as {
        readonly data?: { readonly lastError?: string | null };
      };
      if (typeof body.data?.lastError === 'string' && body.data.lastError.length > 0) {
        setRebuildState({ kind: 'error', message: body.data.lastError });
        return;
      }
      await fetchReport();
    } catch (error) {
      setRebuildState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Rebuild failed.',
      });
    }
  };

  useEffect(() => {
    if (companionPort === undefined || companionPort === null || !bridgeKey) {
      setReport(null);
      setLoadState('not-configured');
      return undefined;
    }
    let cancelled = false;
    const run = async (): Promise<void> => {
      if (report === null) setLoadState('loading');
      await fetchReport();
      if (cancelled) return;
    };
    void run();
    const intervalMs = report?.recall.status === 'rebuilding' ? 5_000 : 30_000;
    const id = window.setInterval(() => {
      void run();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [companionPort, bridgeKey, report?.recall.status]);

  const queueDepth = queuedCaptureCount ?? report?.capture.queueDepthHint ?? null;
  const dropped = droppedCaptureCount ?? report?.capture.droppedHint ?? null;
  const queueWarn = queueDepth !== null && queueDepth > 10;
  const providerRows =
    report === null
      ? []
      : (report.capture.providers ?? fallbackProviderRows(report.capture.lastByProvider));
  const lastProvider = providerRows.find((row) => row.lastCaptureAt !== null);
  const activity = report?.recall.activity;

  const copyDiagnostics = () => {
    if (report === null) return;
    const dump = JSON.stringify(
      {
        ...report,
        localExtension: { queuedCaptureCount, droppedCaptureCount },
      },
      null,
      2,
    );
    void navigator.clipboard.writeText(dump);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  return (
    <div className="health-view" role="dialog" aria-label="Capture health">
      <div className="health-head">
        <button
          type="button"
          className="hp-foot-back icon-btn"
          onClick={onClose}
          aria-label="Close"
        >
          <span style={{ display: 'inline-flex', width: 14, height: 14 }}>{Icons.back}</span>
        </button>
        <span className="title">Capture health</span>
        <span className="muted">snapshot · {loadState === 'live' ? 'live' : loadState}</span>
      </div>

      {report === null ? (
        <div className="hp-empty">
          <div className="hp-empty-title">
            {loadState === 'not-configured' ? 'Companion not configured' : 'Health unavailable'}
          </div>
          <div className="hp-empty-copy">
            {loadState === 'loading'
              ? 'Loading companion diagnostics...'
              : 'Connect the Sidetrack companion to show live capture, recall, and service diagnostics.'}
          </div>
        </div>
      ) : (
        <>
          <div className="health-grid">
            <div className={'hc' + (queueWarn ? ' warn' : '')}>
              <div className="hc-lbl">queued captures</div>
              <div className="hc-num">{queueDepth ?? '?'}</div>
              <div className="hc-bar">
                <span
                  style={{
                    width: `${String(Math.min(100, ((queueDepth ?? 0) / 20) * 100))}%`,
                  }}
                />
              </div>
              <div className="hc-foot">
                cap 20 · dropped {dropped ?? 0} · {queueWarn ? 'warn' : 'ok'}
              </div>
            </div>
            <div className="hc">
              <div className="hc-lbl">last capture</div>
              <div className="hc-num small">
                {lastProvider === undefined ? '-' : formatWhen(lastProvider.lastCaptureAt)}
              </div>
              <div className="hc-foot">
                {lastProvider === undefined
                  ? 'no provider events'
                  : `${providerLabel(lastProvider.provider)} · ${lastProvider.lastStatus ?? 'no canary'}`}
              </div>
            </div>
            <div className="hc">
              <div className="hc-lbl">recall index</div>
              <div className="hc-num small">{formatCount(report.recall.entryCount)}</div>
              <div className="hc-foot">
                vectors · {formatBytes(report.recall.sizeBytes)} ·{' '}
                {report.recall.modelId?.split('/').pop() ?? 'no model'}
              </div>
              {report.recall.status !== undefined ? (
                <div className="hc-foot">
                  status: <span className="mono">{report.recall.status}</span>
                  {report.recall.eventTurnCount !== undefined ? (
                    <>
                      {' · '}
                      {String(report.recall.entryCount ?? 0)}/{String(report.recall.eventTurnCount)}{' '}
                      turns
                    </>
                  ) : null}
                </div>
              ) : null}
              {activity?.lastIndexedAt !== null && activity?.lastIndexedAt !== undefined ? (
                <div className="hc-foot">
                  last indexed: {formatWhen(activity.lastIndexedAt)}
                  {activity.lastIndexedCount === null
                    ? ''
                    : ` · ${String(activity.lastIndexedCount)} turns`}
                </div>
              ) : null}
              {report.recall.embedderDevice !== undefined &&
              report.recall.embedderDevice !== 'unknown' ? (
                <div className="hc-foot">
                  embedder:{' '}
                  <span className="mono">
                    {formatEmbedderLabel(
                      report.recall.embedderDevice,
                      report.recall.embedderAccelerator,
                    )}
                  </span>
                </div>
              ) : null}
              {report.recall.lastError !== undefined && report.recall.lastError !== null ? (
                <div className="hc-foot warn">last error: {report.recall.lastError}</div>
              ) : null}
            </div>
            <div className="hc">
              <div className="hc-lbl">vault writable</div>
              <div className={'hc-num small' + (report.vault.writable ? ' ok' : '')}>
                {report.vault.writable ? 'yes' : 'no'}
              </div>
              <div className="hc-foot">{report.vault.root}</div>
            </div>
          </div>

          <div className="hp-sec">
            <div className="hp-sec-head">By provider · last 24h</div>
            {providerRows.length === 0 ? (
              <div className="hp-muted-row">No capture events found.</div>
            ) : (
              providerRows.map((row) => (
                <div key={row.provider} className="hp-row">
                  <span className={`prov-pill ${providerClass(row.provider)}`}>
                    {providerLabel(row.provider)}
                  </span>
                  <span className="hp-num">
                    {row.ok24h}
                    <span className="muted"> ok</span>
                  </span>
                  <span className={'hp-num' + (row.warn24h > 0 ? ' warn' : '')}>
                    {row.warn24h}
                    <span className="muted"> warn</span>
                  </span>
                  <span className={'hp-num' + (row.fail24h > 0 ? ' err' : '')}>
                    {row.fail24h}
                    <span className="muted"> fail</span>
                  </span>
                  <span className="hp-last muted">{formatWhen(row.lastCaptureAt)}</span>
                  <span className={`hp-state ${statusState(row.lastStatus)}`}>
                    {row.lastStatus ?? 'seen'}
                  </span>
                  {row.warning !== undefined ? (
                    <span className="hp-row-note">{row.warning}</span>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="hp-sec">
            <div className="hp-sec-head">Recall activity</div>
            {activity === undefined || activity.recent.length === 0 ? (
              <div className="hp-muted-row">No recall activity recorded this run.</div>
            ) : (
              <div className="hp-activity-list">
                {activity.recent.slice(0, 8).map((event, index) => (
                  <div className="hp-activity" key={`${event.kind}-${event.at}-${String(index)}`}>
                    <span className="hp-dot signal" />
                    <span>{activityText(event)}</span>
                    <span className="muted">{formatWhen(event.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="hp-sec">
            <div className="hp-sec-head">Recent warnings</div>
            {report.capture.recentWarnings === undefined ||
            report.capture.recentWarnings.length === 0 ? (
              <div className="hp-muted-row">No recent capture warnings.</div>
            ) : (
              report.capture.recentWarnings.slice(0, 6).map((warning) => (
                <div
                  className="hp-err"
                  key={`${warning.provider}-${warning.capturedAt}-${warning.code}`}
                >
                  <div className="r1">
                    <span className="hp-dot amber" />
                    <code>
                      {warning.provider}.{warning.code}
                    </code>
                    <span className="muted">{formatWhen(warning.capturedAt)}</span>
                  </div>
                  <div className="r2">{warning.message}</div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      <div className="hp-foot">
        <button type="button" onClick={copyDiagnostics} disabled={report === null}>
          {copied ? (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ display: 'inline-flex', width: 12, height: 12 }}>{Icons.check}</span>
              Copied
            </span>
          ) : (
            'Copy diagnostics'
          )}
        </button>
        <button
          type="button"
          disabled={rebuildState.kind === 'accepted' || report?.recall.status === 'rebuilding'}
          onClick={() => {
            void triggerRebuild();
          }}
        >
          {report?.recall.status === 'rebuilding'
            ? `Re-indexing... (${String(
                report.recall.rebuildEmbedded ?? report.recall.entryCount ?? 0,
              )}${
                report.recall.rebuildTotal !== undefined && report.recall.rebuildTotal > 0
                  ? `/${String(report.recall.rebuildTotal)}`
                  : report.recall.eventTurnCount !== undefined
                    ? `/${String(report.recall.eventTurnCount)}`
                    : ''
              })`
            : rebuildState.kind === 'accepted'
              ? 'Started - watching...'
              : 'Re-index'}
        </button>
        {rebuildState.kind === 'error' ? (
          <span className="muted" style={{ alignSelf: 'center', marginLeft: 6 }}>
            {rebuildState.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
