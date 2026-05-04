import { useState } from 'react';

import { Icons } from './icons';

// Capture-health diagnostics — full-panel surface reachable from the
// header diagnostics icon. Renders the v2 design's 4-card health
// summary + per-provider 24h breakdown + recent errors.
//
// Wires to the companion's GET /v1/system/health endpoint when it
// lands on main (PR #78). Until then, falls back to fixture data so
// the visual surface ships and the user can iterate on the design
// in the test browser.

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
}

const formatBytes = (n: number | null): string => {
  if (n === null) return '?';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export function HealthPanel({ onClose }: HealthPanelProps) {
  const [copied, setCopied] = useState(false);
  const report = FIXTURE_REPORT;
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
        <span className="muted">snapshot · live</span>
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
            {(report.recall.entryCount / 1000).toFixed(1)}k
          </div>
          <div className="hc-foot">
            vectors · {formatBytes(report.recall.sizeBytes)} ·{' '}
            {report.recall.modelId?.split('/').pop() ?? 'no model'}
          </div>
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
        <button type="button">Re-index</button>
        <button type="button">Open log</button>
      </div>
    </div>
  );
}
