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

interface MaterializerHealth {
  readonly status: 'healthy' | 'degraded' | 'failed';
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly pending: boolean;
}

interface SyncRelayHealth {
  readonly mode: 'local' | 'remote';
  readonly url: string;
  readonly connected?: boolean;
  readonly lastConnectedAtMs?: number;
  readonly lastDisconnectedAtMs?: number;
  readonly consecutiveFailures?: number;
  readonly pendingPublishes?: number;
}

interface SyncSummary {
  readonly replicaId: string;
  readonly seq: number;
  readonly relay?: SyncRelayHealth;
  readonly materializers?: Record<string, MaterializerHealth>;
}

interface WorkGraphRankerHealth {
  readonly activeRevisionId: string | null;
  readonly loadStatus: 'missing' | 'ready' | 'invalid-model';
  // Epoch ms when the active ranker snapshot was trained. Drives the
  // "ranker · snapshot Xh ago" detail line in the pipeline strip.
  readonly trainedAt: number | null;
  readonly retrainSkipReason: string | null;
  readonly retrainNewLabelCount: number;
}

interface WorkGraphHealth {
  readonly ranker: WorkGraphRankerHealth;
}

interface HealthReport {
  readonly uptimeSec: number;
  readonly vault: {
    readonly root: string;
    readonly writable: boolean;
    readonly sizeBytes: number | null;
  };
  readonly workGraph?: WorkGraphHealth;
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
  readonly sync?: SyncSummary;
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

  // Stage 5 polish — pipeline-stage rollup. Each entry describes one
  // logical stage in the capture → … → resolver flow, with a glance-
  // able status dot + a short detail line that surfaces the most
  // load-bearing fact for that stage (count, age, status). Drawn as a
  // left-to-right strip at the top of the panel so the user sees
  // where data is moving before diving into the per-lane sections.
  type PipelineStatus = 'ok' | 'warn' | 'err' | 'idle';
  interface PipelineStage {
    readonly id: string;
    readonly name: string;
    readonly status: PipelineStatus;
    readonly detail: string;
  }
  const pipelineStages: readonly PipelineStage[] = (() => {
    if (report === null) return [];
    const captureStatus: PipelineStatus = queueWarn
      ? 'warn'
      : lastProvider === undefined
        ? 'idle'
        : 'ok';
    const captureDetail =
      lastProvider === undefined
        ? 'no events yet'
        : `${String(providerRows.length)} provider${providerRows.length === 1 ? '' : 's'} · ${formatWhen(lastProvider.lastCaptureAt)}`;
    const vaultStatus: PipelineStatus = report.vault.writable ? 'ok' : 'err';
    const vaultDetail = report.vault.writable
      ? `writable · ${formatBytes(report.vault.sizeBytes)}`
      : 'not writable';
    const materializers = report.sync?.materializers ?? {};
    const matEntries = Object.entries(materializers);
    const matFailed = matEntries.filter(([, m]) => m.status === 'failed').length;
    const matDegraded = matEntries.filter(([, m]) => m.status === 'degraded').length;
    const matStatus: PipelineStatus =
      matFailed > 0 ? 'err' : matDegraded > 0 ? 'warn' : matEntries.length === 0 ? 'idle' : 'ok';
    const matDetail =
      matEntries.length === 0
        ? 'not configured'
        : `${String(matEntries.length - matFailed - matDegraded)}/${String(matEntries.length)} healthy`;
    const recallStatus = report.recall.status;
    const recallStatusFor: PipelineStatus =
      recallStatus === 'rebuilding'
        ? 'warn'
        : recallStatus === 'missing' || recallStatus === 'stale'
          ? 'err'
          : recallStatus === 'empty'
            ? 'warn'
            : recallStatus === 'ready'
              ? 'ok'
              : 'idle';
    const recallDetail =
      recallStatus === 'rebuilding' &&
      report.recall.rebuildTotal !== undefined &&
      report.recall.rebuildTotal > 0
        ? `rebuilding ${String(report.recall.rebuildEmbedded ?? 0)}/${String(report.recall.rebuildTotal)}`
        : recallStatus === undefined
          ? `${formatCount(report.recall.entryCount)} vectors`
          : `${recallStatus} · ${formatCount(report.recall.entryCount)} vectors`;
    // Ranker stage — driven by the workGraph health block exposed at
    // /v1/system/health. `loadStatus = 'ready'` means an active
    // snapshot is loaded; `trainedAt` is the epoch-ms timestamp of
    // the last train. We show the snapshot age + the most recent
    // skip reason so the user can tell whether the planner has been
    // running but choosing not to retrain.
    const rankerHealth = report.workGraph?.ranker;
    const rankerStatus: PipelineStatus =
      rankerHealth === undefined
        ? 'idle'
        : rankerHealth.loadStatus === 'ready'
          ? 'ok'
          : rankerHealth.loadStatus === 'invalid-model'
            ? 'err'
            : 'warn';
    const rankerDetail =
      rankerHealth === undefined
        ? 'workGraph not reported'
        : rankerHealth.loadStatus === 'ready' && rankerHealth.trainedAt !== null
          ? `snapshot ${formatRelative(new Date(rankerHealth.trainedAt).toISOString())}`
          : rankerHealth.loadStatus === 'missing'
            ? rankerHealth.retrainSkipReason === null
              ? 'no snapshot yet'
              : `pending · ${rankerHealth.retrainSkipReason}`
            : rankerHealth.loadStatus === 'invalid-model'
              ? 'snapshot invalid'
              : 'ready';
    const relay = report.sync?.relay;
    const syncStatus: PipelineStatus =
      relay === undefined
        ? 'idle'
        : relay.connected === false
          ? 'warn'
          : relay.connected === true
            ? 'ok'
            : 'idle';
    const syncDetail =
      relay === undefined
        ? 'single-replica'
        : relay.connected === true
          ? `connected · ${relay.mode}`
          : relay.connected === false
            ? `disconnected${relay.consecutiveFailures !== undefined && relay.consecutiveFailures > 0 ? ` · ${String(relay.consecutiveFailures)} fails` : ''}`
            : 'unknown';
    return [
      { id: 'capture', name: 'Capture', status: captureStatus, detail: captureDetail },
      { id: 'vault', name: 'Vault', status: vaultStatus, detail: vaultDetail },
      { id: 'materializers', name: 'Materializers', status: matStatus, detail: matDetail },
      { id: 'recall', name: 'Embedding', status: recallStatusFor, detail: recallDetail },
      { id: 'ranker', name: 'Ranker', status: rankerStatus, detail: rankerDetail },
      { id: 'sync', name: 'Sync', status: syncStatus, detail: syncDetail },
    ];
  })();

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
              ? 'Loading companion diagnostics…'
              : 'Connect the Sidetrack companion to show live capture, recall, and service diagnostics.'}
          </div>
        </div>
      ) : (
        <>
          {/* Pipeline strip — glance-able status of every stage in the
              capture-to-resolver flow. Stages are intentionally
              ordered so the leftmost column is where data enters and
              the rightmost is where decisions go out; arrows make the
              direction explicit. Click a stage to scroll to its
              underlying lane (TODO follow-up: anchor links). */}
          {pipelineStages.length > 0 ? (
            <div className="hp-pipeline" data-testid="hp-pipeline">
              <div className="hp-pipeline-head">
                Pipeline · capture → vault → materializers → embedding → ranker → sync
              </div>
              <div className="hp-pipeline-flow">
                {pipelineStages.map((stage, index) => (
                  <span className="hp-pipeline-stage-wrap" key={stage.id}>
                    <span
                      className={`hp-pipeline-stage is-${stage.status}`}
                      title={`${stage.name}: ${stage.detail}`}
                      data-testid={`hp-pipeline-stage-${stage.id}`}
                    >
                      <span className={`hp-pipeline-dot ${stage.status}`} aria-hidden />
                      <span className="hp-pipeline-name">{stage.name}</span>
                      <span className="hp-pipeline-detail mono">{stage.detail}</span>
                    </span>
                    {index < pipelineStages.length - 1 ? (
                      <span className="hp-pipeline-arrow" aria-hidden>
                        →
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {/* Stage 5 polish — three-lane locality grouping.
              🖥 LOCAL = lives in this browser tab (extension SW).
              ⚙ COMPANION = lives in the local companion Node process.
              🔄 SYNC = flows across replicas via the relay. */}
          <div className="hp-lane hp-lane-local">
            <div className="hp-lane-head">
              <span className="hp-lane-icon" aria-hidden>🖥</span>
              <span className="hp-lane-label">LOCAL · in this browser</span>
            </div>
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
            {/* Stage 5 polish — companion-reachability chip sits in the
                LOCAL lane because the in-browser SW owns the reach
                check. Mirrors the pipeline strip's intent: tell the
                user where data is going next from this side. */}
            <div className={'hc' + (loadState === 'live' ? '' : ' warn')}>
              <div className="hc-lbl">companion reach</div>
              <div className="hc-num small">
                {loadState === 'live'
                  ? 'reachable'
                  : loadState === 'loading'
                    ? 'checking…'
                    : loadState === 'not-configured'
                      ? 'not configured'
                      : 'unreachable'}
              </div>
              <div className="hc-foot">
                {companionPort === null || companionPort === undefined
                  ? 'no port set'
                  : `localhost:${String(companionPort)}`}
              </div>
            </div>
          </div>
          </div>

          <div className="hp-lane hp-lane-companion">
            <div className="hp-lane-head">
              <span className="hp-lane-icon" aria-hidden>⚙</span>
              <span className="hp-lane-label">
                COMPANION · on this machine
                {companionPort !== null && companionPort !== undefined
                  ? ` (localhost:${String(companionPort)})`
                  : ''}
              </span>
            </div>
          <div className="health-grid">
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
          </div>

          {/* Sync lane: replica + relay state + per-materializer health.
              Peer-event in/out counts + lastInbound/Outbound timestamps
              are tracked as a follow-up — the relay transport exposes
              connection state today but not event throughput. When
              report.sync is undefined the relay isn't configured. */}
          <div className="hp-lane hp-lane-sync">
            <div className="hp-lane-head">
              <span className="hp-lane-icon" aria-hidden>🔄</span>
              <span className="hp-lane-label">
                SYNC · across replicas
                {report.sync?.relay?.mode !== undefined
                  ? ` · ${report.sync.relay.mode}`
                  : ''}
              </span>
            </div>
            {report.sync === undefined ? (
              <div className="hp-muted-row">Sync relay is not configured (single-replica mode).</div>
            ) : (
              <>
                <div className="health-grid">
                  <div className="hc">
                    <div className="hc-lbl">this replica</div>
                    <div className="hc-num small mono">
                      {report.sync.replicaId.slice(0, 8)}…
                    </div>
                    <div className="hc-foot">seq · {String(report.sync.seq)}</div>
                  </div>
                  {report.sync.relay !== undefined ? (
                    <div
                      className={
                        'hc' + (report.sync.relay.connected === false ? ' warn' : '')
                      }
                    >
                      <div className="hc-lbl">relay</div>
                      <div className="hc-num small">
                        {report.sync.relay.connected === true
                          ? 'connected'
                          : report.sync.relay.connected === false
                            ? 'disconnected'
                            : 'unknown'}
                      </div>
                      <div className="hc-foot">{report.sync.relay.url}</div>
                      {report.sync.relay.lastConnectedAtMs !== undefined ? (
                        <div className="hc-foot">
                          last connected:{' '}
                          {formatWhen(
                            new Date(report.sync.relay.lastConnectedAtMs).toISOString(),
                          )}
                        </div>
                      ) : null}
                      {report.sync.relay.lastDisconnectedAtMs !== undefined ? (
                        <div className="hc-foot">
                          last disconnected:{' '}
                          {formatWhen(
                            new Date(report.sync.relay.lastDisconnectedAtMs).toISOString(),
                          )}
                        </div>
                      ) : null}
                      {report.sync.relay.pendingPublishes !== undefined &&
                      report.sync.relay.pendingPublishes > 0 ? (
                        <div className="hc-foot warn">
                          pending publish: {String(report.sync.relay.pendingPublishes)}
                        </div>
                      ) : null}
                      {report.sync.relay.consecutiveFailures !== undefined &&
                      report.sync.relay.consecutiveFailures > 0 ? (
                        <div className="hc-foot warn">
                          consecutive failures: {String(report.sync.relay.consecutiveFailures)}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {report.sync.materializers !== undefined &&
                Object.keys(report.sync.materializers).length > 0 ? (
                  <div className="hp-sec">
                    <div className="hp-sec-head">Materializers · per-replica health</div>
                    {Object.entries(report.sync.materializers).map(([name, mat]) => (
                      <div
                        className="hp-row"
                        key={name}
                        title={
                          mat.lastError !== null ? `Last error: ${mat.lastError}` : undefined
                        }
                      >
                        <span className="prov-pill mono">{name}</span>
                        <span className={`hp-state ${mat.status}`}>{mat.status}</span>
                        <span className="hp-last muted">
                          {mat.lastSuccessAt === null
                            ? 'never'
                            : formatWhen(mat.lastSuccessAt)}
                        </span>
                        {mat.pending ? (
                          <span className="hp-num muted">pending</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="hp-muted-row" style={{ fontSize: 10, opacity: 0.7 }}>
                  Peer-event throughput + per-replica drill-down are coming —
                  follow-up companion task tracked.
                </div>
              </>
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
            ? `Re-indexing… (${String(
                report.recall.rebuildEmbedded ?? report.recall.entryCount ?? 0,
              )}${
                report.recall.rebuildTotal !== undefined && report.recall.rebuildTotal > 0
                  ? `/${String(report.recall.rebuildTotal)}`
                  : report.recall.eventTurnCount !== undefined
                    ? `/${String(report.recall.eventTurnCount)}`
                    : ''
              })`
            : rebuildState.kind === 'accepted'
              ? 'Started — watching…'
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
