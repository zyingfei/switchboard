import { useEffect, useState } from 'react';

import { Icons } from './icons';

// Capture-health diagnostics — full-panel surface reachable from the
// header diagnostics icon. Renders the v2 design's 4-card health
// summary + per-provider 24h breakdown + recent errors.
//
// Fetches GET /v1/system/health (PR #78) when companion port + bridge
// key are provided; falls back to fixture data otherwise so the
// surface stays visible without a configured companion.

interface HealthReport {
  readonly uptimeSec: number;
  readonly vault: { readonly root: string; readonly writable: boolean; readonly sizeBytes: number };
  readonly capture: {
    readonly lastByProvider: Record<string, string | null>;
    readonly queueDepthHint: number | null;
    readonly droppedHint: number | null;
  };
  readonly recall: {
    readonly indexExists: boolean;
    readonly entryCount: number;
    readonly modelId: string | null;
    readonly sizeBytes: number | null;
    // Optional lifecycle fields (companion ≥ this version) — drive
    // the rebuild affordance + status copy. Older companions omit
    // them and the UI falls back to the legacy "Re-index" button.
    readonly status?: 'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready';
    readonly eventTurnCount?: number;
    readonly currentModelId?: string | null;
    readonly companionVersion?: string;
    readonly lastRebuildAt?: string | null;
    readonly lastRebuildIndexed?: number | null;
    readonly lastError?: string | null;
    readonly rebuildEmbedded?: number;
    readonly rebuildTotal?: number;
  };
  readonly service: { readonly installed: boolean; readonly running: boolean };
}

const FIXTURE_REPORT: HealthReport = {
  uptimeSec: 7240,
  vault: {
    root: '~/Documents/Sidetrack-vault',
    writable: true,
    sizeBytes: 12_400_000,
  },
  capture: {
    lastByProvider: {
      claude: '8m ago',
      chatgpt: '12m ago',
      gemini: '2h ago',
      codex: 'yesterday',
    },
    queueDepthHint: 3,
    droppedHint: 0,
  },
  recall: {
    indexExists: true,
    entryCount: 12_400,
    modelId: 'Xenova/all-MiniLM-L6-v2',
    sizeBytes: 28_000_000,
  },
  service: { installed: false, running: true },
};

interface ProviderRow {
  readonly key: string;
  readonly label: string;
  readonly ok: number;
  readonly err: number;
  readonly state: 'ok' | 'warn';
}

const PROVIDER_ROWS: readonly ProviderRow[] = [
  { key: 'claude', label: 'Claude', ok: 18, err: 0, state: 'ok' },
  { key: 'gpt', label: 'ChatGPT', ok: 24, err: 1, state: 'ok' },
  { key: 'gemini', label: 'Gemini', ok: 4, err: 0, state: 'ok' },
  { key: 'codex', label: 'Codex', ok: 2, err: 2, state: 'warn' },
];

interface HealthPanelProps {
  readonly onClose: () => void;
  readonly companionPort?: number | null;
  readonly bridgeKey?: string | null;
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

const formatBytes = (n: number | null): string => {
  if (n === null) return '?';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export function HealthPanel({ onClose, companionPort, bridgeKey }: HealthPanelProps) {
  const [copied, setCopied] = useState(false);
  const [report, setReport] = useState<HealthReport>(FIXTURE_REPORT);
  const [isLive, setIsLive] = useState(false);
  type RebuildState =
    | { kind: 'idle' }
    | { kind: 'accepted' }
    | { kind: 'error'; message: string };
  const [rebuildState, setRebuildState] = useState<RebuildState>({ kind: 'idle' });

  // Fire-and-monitor: POST /v1/recall/rebuild returns 202 immediately
  // (the rebuild itself runs in the background — model download +
  // embedding can take minutes). The recall index card already
  // polls /v1/system/health every 5s while status === 'rebuilding',
  // so the user sees the entry count tick up live without us
  // holding the fetch open.
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
      // Pull a fresh health snapshot so the card flips to "rebuilding"
      // without waiting for the 30s poll cadence.
      const healthUrl = `http://127.0.0.1:${String(companionPort)}/v1/system/health`;
      const healthResponse = await fetch(healthUrl, {
        headers: { 'x-bac-bridge-key': bridgeKey },
      });
      if (healthResponse.ok) {
        const healthBody = (await healthResponse.json()) as { readonly data?: unknown };
        if (isHealthReport(healthBody.data)) {
          setReport(healthBody.data);
        }
      }
    } catch (error) {
      setRebuildState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Rebuild failed.',
      });
    }
  };

  // Fetch the live report when companion is configured. Silent on failure
  // — the fixture stays in place so the visual surface never blanks.
  useEffect(() => {
    if (companionPort === undefined || companionPort === null || !bridgeKey) {
      return undefined;
    }
    let cancelled = false;
    const fetchReport = async () => {
      try {
        const url = `http://127.0.0.1:${String(companionPort)}/v1/system/health`;
        const response = await fetch(url, { headers: { 'x-bac-bridge-key': bridgeKey } });
        if (!response.ok) return;
        const body = (await response.json()) as { readonly data?: unknown };
        if (cancelled || !isHealthReport(body.data)) return;
        setReport(body.data);
        setIsLive(true);
      } catch {
        // Keep fixture; surface stays usable offline.
      }
    };
    void fetchReport();
    // Poll faster while a rebuild is in flight so the entry count
    // ticks up live; fall back to 30s once it's settled.
    const intervalMs = report.recall.status === 'rebuilding' ? 5_000 : 30_000;
    const id = window.setInterval(() => {
      void fetchReport();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [companionPort, bridgeKey, report.recall.status]);

  const queueWarn =
    report.capture.queueDepthHint !== null && report.capture.queueDepthHint > 10;

  const copyDiagnostics = () => {
    const dump = JSON.stringify(report, null, 2);
    void navigator.clipboard.writeText(dump);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  return (
    <div className="health-view" role="dialog" aria-label="Capture health">
      <div className="health-head">
        <button type="button" className="hp-foot-back icon-btn" onClick={onClose} aria-label="Close">
          <span style={{ display: 'inline-flex', width: 14, height: 14 }}>{Icons.back}</span>
        </button>
        <span className="title">Capture health</span>
        <span className="muted">snapshot · {isLive ? 'live' : 'preview'}</span>
      </div>

      <div className="health-grid">
        <div className={'hc' + (queueWarn ? ' warn' : '')}>
          <div className="hc-lbl">queue depth</div>
          <div className="hc-num">{report.capture.queueDepthHint ?? '?'}</div>
          <div className="hc-bar">
            <span
              style={{
                width: `${String(Math.min(100, ((report.capture.queueDepthHint ?? 0) / 20) * 100))}%`,
              }}
            />
          </div>
          <div className="hc-foot">cap 20 · {queueWarn ? 'warn' : 'ok'}</div>
        </div>
        <div className="hc">
          <div className="hc-lbl">last capture</div>
          <div className="hc-num small">{report.capture.lastByProvider.claude ?? '—'}</div>
          <div className="hc-foot">
            claude.ai · dropped {report.capture.droppedHint ?? 0}
          </div>
        </div>
        <div className="hc">
          <div className="hc-lbl">recall index</div>
          <div className="hc-num small">
            {report.recall.entryCount >= 1000
              ? `${(report.recall.entryCount / 1000).toFixed(1)}k`
              : String(report.recall.entryCount)}
          </div>
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
                  {String(report.recall.entryCount)}/
                  {String(report.recall.eventTurnCount)} turns
                </>
              ) : null}
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
        {PROVIDER_ROWS.map((row) => (
          <div key={row.key} className="hp-row">
            <span className={`prov-pill ${row.key}`}>{row.label}</span>
            <span className="hp-num">
              {row.ok}
              <span className="muted"> ok</span>
            </span>
            <span className={'hp-num' + (row.err > 0 ? ' err' : '')}>
              {row.err}
              <span className="muted"> err</span>
            </span>
            <span className="hp-last muted">
              {report.capture.lastByProvider[row.key === 'gpt' ? 'chatgpt' : row.key] ?? '—'}
            </span>
            <span className={`hp-state ${row.state}`}>{row.state}</span>
          </div>
        ))}
      </div>

      <div className="hp-sec">
        <div className="hp-sec-head">Recent errors</div>
        <div className="hp-err">
          <div className="r1">
            <span className="hp-dot amber" />
            <code>codex.capture · timeout</code>
            <span className="muted">2 occurrences · last yesterday 22:14</span>
          </div>
          <div className="r2">net::ERR_TIMED_OUT on chatgpt.com/codex/c/…</div>
        </div>
      </div>

      <div className="hp-foot">
        <button type="button" onClick={copyDiagnostics}>
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
          disabled={rebuildState.kind === 'accepted' || report.recall.status === 'rebuilding'}
          onClick={() => {
            void triggerRebuild();
          }}
        >
          {report.recall.status === 'rebuilding'
            ? `Re-indexing… (${String(
                // Prefer the live embedded counter (updates between
                // batches) over the on-disk entry count, which only
                // moves on the final write.
                report.recall.rebuildEmbedded ?? report.recall.entryCount,
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
        <button type="button">Open log</button>
      </div>
    </div>
  );
}
