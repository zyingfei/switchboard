import { useEffect, useState } from 'react';

import {
  intelligenceSummaryFromHealth,
  type IntelligenceMetric,
  type IntelligenceSummary,
} from '../../../src/settings/intelligenceSummary';
import { reliabilitySummaryFromReport } from '../../../src/settings/reliabilitySummary';

// Freeze-safe observability: a compact, LIVING readout of the ML /
// recommendation connection matrix, embedded in Settings → Diagnostics.
// It reuses the exact /v1/system/health GET the HealthPanel consumes (no
// new endpoint, no new scans) and folds the four load-bearing numbers —
// doc-vector coverage, sim-edge count, last drain, impressions collected
// — into one glanceable strip so "is the built intelligence actually
// wired and moving?" has a one-look answer. Parsing lives in the pure
// intelligenceSummaryFromHealth (unit-tested); this component is just the
// fetch + render shell.

export interface IntelligenceRowProps {
  readonly companionPort?: number | null;
  readonly bridgeKey?: string | null;
}

type LoadState = 'not-configured' | 'loading' | 'live' | 'unavailable';

const STATE_GLYPH: Record<'live' | 'idle' | 'unknown', string> = {
  live: '●',
  idle: '○',
  unknown: '—',
};

export function IntelligenceRow({ companionPort, bridgeKey }: IntelligenceRowProps) {
  const configured =
    companionPort !== undefined && companionPort !== null && Boolean(bridgeKey);
  const [summary, setSummary] = useState<IntelligenceSummary | null>(null);
  const [loadState, setLoadState] = useState<LoadState>(
    configured ? 'loading' : 'not-configured',
  );

  useEffect(() => {
    let cancelled = false;
    if (!configured) {
      setLoadState('not-configured');
      setSummary(null);
      return;
    }
    const base = `http://127.0.0.1:${String(companionPort)}`;
    const authHeaders = { 'x-bac-bridge-key': bridgeKey as string };
    void (async () => {
      try {
        const response = await fetch(`${base}/v1/system/health`, { headers: authHeaders });
        if (!response.ok) {
          if (!cancelled) setLoadState('unavailable');
          return;
        }
        const body = (await response.json()) as unknown;
        const parsed = intelligenceSummaryFromHealth(body);
        // Reliability is a SEPARATE, best-effort endpoint (S1). Its failure
        // must never blank the (working) health readout — an older companion
        // has no /v1/system/reliability, so a failed fetch just omits the
        // Calibration metric. It is fetched after health so the primary
        // readout renders even if reliability is slow/absent.
        let calibrationMetric: IntelligenceMetric | undefined;
        try {
          const reliabilityResponse = await fetch(`${base}/v1/system/reliability`, {
            headers: authHeaders,
          });
          if (reliabilityResponse.ok) {
            calibrationMetric = reliabilitySummaryFromReport(
              (await reliabilityResponse.json()) as unknown,
            );
          }
        } catch {
          // Reliability unavailable — leave the metric out; health stands.
        }
        if (cancelled) return;
        setSummary(
          calibrationMetric === undefined
            ? parsed
            : { ...parsed, metrics: [...parsed.metrics, calibrationMetric] },
        );
        setLoadState(parsed.available ? 'live' : 'unavailable');
      } catch {
        if (!cancelled) setLoadState('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configured, companionPort, bridgeKey]);

  if (loadState === 'not-configured') {
    return (
      <div className="intelligence-row is-empty mono" data-testid="intelligence-row">
        Connect a companion to see the intelligence readout.
      </div>
    );
  }
  if (loadState === 'loading') {
    return (
      <div className="intelligence-row is-loading mono" data-testid="intelligence-row">
        Reading intelligence health…
      </div>
    );
  }
  if (loadState === 'unavailable' || summary === null) {
    return (
      <div className="intelligence-row is-unavailable mono" data-testid="intelligence-row">
        Intelligence health unavailable (older companion or offline).
      </div>
    );
  }
  return (
    <div className="intelligence-row" data-testid="intelligence-row">
      {summary.metrics.map((metric) => (
        <div
          key={metric.key}
          className={`intelligence-metric is-${metric.state}`}
          title={metric.title}
          data-metric={metric.key}
        >
          <span className="intelligence-metric-head">
            <span className="intelligence-metric-dot" aria-hidden>
              {STATE_GLYPH[metric.state]}
            </span>
            <span className="intelligence-metric-label">{metric.label}</span>
          </span>
          <span className="intelligence-metric-value mono">{metric.value}</span>
          {metric.detail !== undefined ? (
            <span className="intelligence-metric-detail mono">{metric.detail}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
