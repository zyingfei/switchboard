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
  // Content hint for the most recent capture — turns a bare
  // heartbeat ("captured something 4m ago") into "captured the
  // right thing" ("ChatGPT · 'Fixing Focus collapse' · 4m ago").
  // Optional: an older companion omits these.
  readonly lastCaptureTitle?: string;
  readonly lastCaptureThreadId?: string;
}

// Server-derived honest reachability/freshness. Lets the panel render
// one authoritative light without re-deriving worst-of client-side,
// and — crucially — distinguish "metrics didn't load" (unavailable)
// from a real empty (no events yet). Optional: an older companion
// omits the whole block, in which case the client rollup still works.
type SectionAvailability = 'ok' | 'stale' | 'unavailable';
type ObservabilityStatus = 'ok' | 'degraded' | 'failed';
interface HealthObservability {
  readonly asOf: string;
  readonly status: ObservabilityStatus;
  readonly sections: Readonly<Record<string, SectionAvailability>>;
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

interface SyncRelayPeerReplicaHealth {
  readonly replicaId: string;
  readonly eventsIn: number;
  readonly eventsOut: number;
  readonly lastInboundAtMs?: number;
  readonly lastOutboundAtMs?: number;
}

interface SyncRelayHealth {
  readonly mode: 'local' | 'remote';
  readonly url: string;
  readonly connected?: boolean;
  readonly lastConnectedAtMs?: number;
  readonly lastDisconnectedAtMs?: number;
  readonly consecutiveFailures?: number;
  readonly pendingPublishes?: number;
  // Stage 5 polish — peer-event throughput counters. `eventsIn` and
  // `eventsOut` are total since companion process start. `byReplica`
  // carries per-replica drill for the "who am I talking to?" panel.
  readonly eventsIn?: number;
  readonly eventsOut?: number;
  readonly lastInboundAtMs?: number;
  readonly lastOutboundAtMs?: number;
  readonly byReplica?: readonly SyncRelayPeerReplicaHealth[];
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
  // Honest training mix. Never show the negative count alone — the
  // labeled triple prevents reading "0 user negatives" as "trained on
  // no negatives". `trainingNegatives === null` renders as "unknown"
  // (manifest predates capture), never as 0. Optional: an older
  // companion omits the whole block.
  readonly trainingMix?: {
    readonly positivesAtTrain: number;
    readonly userFeedbackNegativesAtTrain: number;
    readonly trainingNegatives: number | null;
  } | null;
  // True when the feedback fingerprint differs from what the active
  // model trained on — "data changed, model is behind". Optional on
  // an older companion (treated as false / not surfaced).
  readonly datasetChangedSinceTrain?: boolean;
}

interface WorkGraphTopicProducerHealth {
  readonly activeRevisionId: string | null;
  readonly algorithmVersion: string | null;
  readonly topicCount: number;
  readonly lineageCount: number;
}

type DiagnosticCandidateMetric = string | number | boolean | null;

interface DiagnosticCandidate {
  readonly id: string;
  readonly family: 'topic' | 'similarity' | 'ranker' | 'content-lane' | 'reconcile' | 'quality';
  readonly lane: 'active' | 'standby' | 'shadow' | 'diagnostic';
  readonly servingImpact: 'serving' | 'not-serving' | 'observe-only';
  readonly status: 'ok' | 'off' | 'pending' | 'warning' | 'alarm' | 'unavailable';
  readonly reason: string | null;
  readonly revisionId: string | null;
  readonly asOf: string | null;
  readonly metrics: Readonly<Record<string, DiagnosticCandidateMetric>>;
}

interface WorkGraphHealth {
  readonly ranker: WorkGraphRankerHealth;
  readonly topicProducer?: WorkGraphTopicProducerHealth;
  readonly candidates?: readonly DiagnosticCandidate[];
}

interface HealthReport {
  readonly uptimeSec: number;
  readonly vault: {
    readonly root: string;
    readonly writable: boolean;
    readonly sizeBytes: number | null;
  };
  readonly workGraph?: WorkGraphHealth;
  readonly observability?: HealthObservability;
  readonly capture: {
    readonly lastByProvider: Record<string, string | null>;
    readonly queueDepthHint: number | null;
    readonly droppedHint: number | null;
    readonly providers?: readonly CaptureProviderHealth[];
    readonly recentWarnings?: readonly CaptureWarningHealth[];
    // Rolling 1h capture counts. Turns "last capture 4m ago" into
    // "is it still flowing?". Optional on an older companion.
    readonly window1h?: {
      readonly captures: number;
      readonly warnings: number;
      readonly fails: number;
    };
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
    readonly rebuildPhase?: string | null;
    readonly embedderDevice?: 'cpu' | 'wasm' | 'webgpu' | 'unknown';
    readonly embedderAccelerator?: 'accelerate' | 'mkl' | 'cpu' | 'unknown';
    readonly activity?: RecallActivityReport;
  };
  readonly service: { readonly installed: boolean; readonly running: boolean };
  readonly sync?: SyncSummary;
}

// ── Focus-health endpoint (GET /v1/system/focus-health?history=20) ──
// The active topic algorithm + counts come from /v1/system/health
// (workGraph.topicProducer). The shadow comparison + drain trend live
// in the connections diagnostics digest, served here. Every field is
// guarded — a missing/old digest renders the honest unavailable state,
// never a fabricated zero.
interface FocusHealthShadowVsBaseline {
  readonly shadowTopicCount?: number;
  readonly shadowMaxTopicShare?: number;
  readonly noiseShare?: number;
  readonly candidate?: string;
}
interface FocusHealthShadowObservation {
  readonly adjacentPerVisitChurn?: number;
  readonly shadowRevisionId?: string;
}
interface FocusHealthHistorySample {
  readonly at: string;
  readonly adjacentPerVisitChurn: number | null;
  readonly shadowMaxTopicShare: number | null;
  readonly noiseShare: number | null;
  readonly shadowTopicCount: number | null;
}
interface FocusHealthResponse {
  readonly availability: 'ok' | 'unavailable';
  readonly asOf: string | null;
  readonly digest: {
    readonly shadowVsBaseline?: FocusHealthShadowVsBaseline;
    readonly shadowObservation?: FocusHealthShadowObservation;
  } | null;
  readonly history: readonly FocusHealthHistorySample[];
}

// ── Hygiene-status endpoint (GET /v1/system/hygiene-status) ──
// GC inventory + page-content coverage. `availability.gc ===
// 'unavailable'` is the design's whole thesis — render it as the
// honest unavailable state, never as a healthy zero.
interface HygieneGcGroup {
  readonly count: number;
  readonly bytes: number;
}
interface HygieneStatusResponse {
  readonly asOf: string | null;
  readonly availability: {
    readonly gc: 'ok' | 'stale' | 'unavailable';
    readonly pageContent: 'ok' | 'stale' | 'unavailable';
  };
  readonly gc: {
    readonly groups: Readonly<Record<string, HygieneGcGroup>>;
    readonly totalCount: number;
    readonly totalBytes: number;
  } | null;
  readonly pageContent: {
    readonly byState: Readonly<Record<string, number>>;
    readonly total: number;
    readonly indexed: number;
  } | null;
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

const formatBytes = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '?';
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
  // Honest id presentation (TODO-H8 remainder): name resolution needs a
  // heavy snapshot/threads read we deliberately keep off the polled
  // health path, so present the id explicitly as a (truncated) thread
  // reference rather than a mystery token — never fabricate a name.
  const rawId = event.threadId;
  const idRef =
    rawId === undefined
      ? 'thread'
      : `thread ${rawId.length > 10 ? `${rawId.slice(0, 8)}…` : rawId}`;
  return `Group recommendation · ${idRef} · ${String(event.resultCount ?? 0)} result${event.resultCount === 1 ? '' : 's'}`;
};

const fmtNum = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined ? 'no signal yet' : n.toFixed(digits);

const formatCandidateMetric = (value: DiagnosticCandidateMetric | undefined): string => {
  if (value === null || value === undefined) return 'no signal yet';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return value.length === 0 ? 'no signal yet' : value;
};

const formatCandidateStatus = (status: DiagnosticCandidate['status']): string => {
  if (status === 'off') return 'disabled';
  if (status === 'unavailable') return 'unavailable';
  return status;
};

const candidateRowClass = (status: DiagnosticCandidate['status']): string | undefined =>
  status === 'warning' || status === 'alarm' ? 'warn' : undefined;

const candidateStatusStamp = (status: DiagnosticCandidate['status']): string =>
  status === 'ok' ? 'deterministic' : status === 'alarm' ? 'signal' : 'partial';

const isCandidateSignal = (candidate: DiagnosticCandidate): boolean =>
  candidate.status === 'alarm' &&
  candidate.lane === 'active' &&
  (candidate.servingImpact === 'serving' || candidate.id === 'ranker.active-model');

const metricSummary = (candidate: DiagnosticCandidate): string =>
  Object.entries(candidate.metrics)
    .slice(0, 4)
    .map(([key, value]) => `${key}=${formatCandidateMetric(value)}`)
    .join(' · ');

type PipelineStatus = 'ok' | 'warn' | 'err' | 'idle' | 'unavailable';
interface PipelineStage {
  readonly id: string;
  readonly name: string;
  readonly status: PipelineStatus;
  readonly head: string;
  readonly detail: string;
  readonly mini?: string;
  readonly spark?: readonly number[];
}

// Maps a pipeline status to the design's pipenode variant. 'err' is the
// design's `alarm`, 'warn' is `warn`, 'unavailable' gets the dashed
// `unavail` border so a glance reads "didn't load", not "nothing yet".
const nodeVariant = (status: PipelineStatus): string =>
  status === 'err'
    ? 'alarm'
    : status === 'warn'
      ? 'warn'
      : status === 'unavailable'
        ? 'unavail'
        : '';

// StatusPill — tri-state honesty. ok→ok, degraded→warn, failed→warn,
// unavailable→unavail. Never a fabricated "healthy".
function StatusPill({
  value,
  label,
}: {
  value: 'ok' | 'warn' | 'stale' | 'unavail';
  label: string;
}) {
  return (
    <span className={`sx-status ${value}`} data-testid="hp-overall-status">
      <span className="dot" />
      {label}
    </span>
  );
}

function Spark({ data, variant }: { data: readonly number[]; variant: string }) {
  if (data.length === 0) return null;
  const max = Math.max(...data, 1);
  return (
    <span className={`sx-spark ${variant}`} aria-hidden>
      {data.map((v, i) => (
        <span key={i} style={{ height: `${String(Math.max(2, (v / max) * 14))}px` }} />
      ))}
    </span>
  );
}

function ReceiptRow({ dt, dd, mono }: { dt: string; dd: React.ReactNode; mono?: boolean }) {
  return (
    <div className="sx-receipt-row">
      <dt>{dt}</dt>
      <dd className={mono === true ? 'mono' : undefined}>{dd}</dd>
    </div>
  );
}

export function HealthPanel({
  onClose,
  companionPort,
  bridgeKey,
  queuedCaptureCount,
  droppedCaptureCount,
}: HealthPanelProps) {
  const [copied, setCopied] = useState(false);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [focusHealth, setFocusHealth] = useState<FocusHealthResponse | null>(null);
  const [hygiene, setHygiene] = useState<HygieneStatusResponse | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'live' | 'unavailable' | 'not-configured'>(
    companionPort === undefined || companionPort === null || !bridgeKey
      ? 'not-configured'
      : 'loading',
  );
  const [stage, setStage] = useState<string>('topics');
  const [toast, setToast] = useState<string | null>(null);
  type RebuildState = { kind: 'idle' } | { kind: 'accepted' } | { kind: 'error'; message: string };
  const [rebuildState, setRebuildState] = useState<RebuildState>({ kind: 'idle' });
  // Plan TODO-H8 (self-explanatory subset): the raw activity list is an
  // ever-churning wall of opaque-id rows that reads like failures. Roll
  // it into an honest rate header; the list is a collapsed drilldown.
  const [recallActivityOpen, setRecallActivityOpen] = useState(false);

  const base =
    companionPort === undefined || companionPort === null || !bridgeKey
      ? null
      : `http://127.0.0.1:${String(companionPort)}`;
  const authHeaders = bridgeKey ? { 'x-bac-bridge-key': bridgeKey } : undefined;

  const fetchReport = async (): Promise<void> => {
    if (base === null || authHeaders === undefined) {
      setReport(null);
      setLoadState('not-configured');
      return;
    }
    try {
      const response = await fetch(`${base}/v1/system/health`, { headers: authHeaders });
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

  // Focus-health + hygiene-status are best-effort drill-down sources.
  // Any failure (older companion, missing digest) leaves state null so
  // the drill renders the honest "unavailable" state — never a faked 0.
  const fetchFocusHealth = async (): Promise<void> => {
    if (base === null || authHeaders === undefined) return;
    try {
      const response = await fetch(`${base}/v1/system/focus-health?history=20`, {
        headers: authHeaders,
      });
      if (!response.ok) {
        setFocusHealth(null);
        return;
      }
      const body = (await response.json()) as { readonly data?: FocusHealthResponse };
      setFocusHealth(body.data ?? null);
    } catch {
      setFocusHealth(null);
    }
  };

  const fetchHygiene = async (): Promise<void> => {
    if (base === null || authHeaders === undefined) return;
    try {
      const response = await fetch(`${base}/v1/system/hygiene-status`, { headers: authHeaders });
      if (!response.ok) {
        setHygiene(null);
        return;
      }
      const body = (await response.json()) as { readonly data?: HygieneStatusResponse };
      setHygiene(body.data ?? null);
    } catch {
      setHygiene(null);
    }
  };

  const triggerRebuild = async (): Promise<void> => {
    if (base === null || authHeaders === undefined) {
      setRebuildState({ kind: 'error', message: 'Companion not configured.' });
      return;
    }
    setRebuildState({ kind: 'accepted' });
    try {
      const response = await fetch(`${base}/v1/recall/rebuild`, {
        method: 'POST',
        headers: authHeaders,
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

  // Force retrain → POST /v1/connections/ranker/retrain {force:true}.
  // The honest contract: forcing bypasses policy gates (threshold,
  // cooldown) but still respects substance gates — toast the returned
  // decision {status, reason} verbatim, never claim success.
  const forceRetrain = async (): Promise<void> => {
    if (base === null || authHeaders === undefined) {
      setToast('Companion not configured.');
      return;
    }
    setToast('Force retrain queued · honoring substance gates…');
    try {
      const response = await fetch(`${base}/v1/connections/ranker/retrain`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (!response.ok) {
        setToast(`Force retrain failed · HTTP ${String(response.status)}`);
        return;
      }
      const body = (await response.json()) as {
        readonly data?: { readonly status?: string; readonly reason?: string };
      };
      const status = body.data?.status ?? 'unknown';
      const reason = body.data?.reason;
      setToast(
        `Retrain ${status}${reason !== undefined && reason.length > 0 ? ` · ${reason}` : ''}`,
      );
      await Promise.all([fetchReport(), fetchFocusHealth()]);
    } catch (error) {
      setToast(`Force retrain failed · ${error instanceof Error ? error.message : 'error'}`);
    }
  };

  useEffect(() => {
    if (base === null) {
      setReport(null);
      setLoadState('not-configured');
      return undefined;
    }
    let cancelled = false;
    const run = async (): Promise<void> => {
      if (report === null) setLoadState('loading');
      await Promise.all([fetchReport(), fetchFocusHealth(), fetchHygiene()]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companionPort, bridgeKey, report?.recall.status]);

  const queueDepth = queuedCaptureCount ?? report?.capture.queueDepthHint ?? null;
  const dropped = droppedCaptureCount ?? report?.capture.droppedHint ?? null;
  const queueWarn = queueDepth !== null && queueDepth > 10;
  // Honest unavailable-vs-zero: when the server says the capture
  // section timed out we must NOT synthesize zero-count provider rows
  // (those read as a dead provider). Only show the rows the server
  // actually reported; a real empty (section ok, no providers) still
  // falls through to "no captures yet".
  const sections = report?.observability?.sections;
  const captureUnavailable = sections?.['capture'] === 'unavailable';
  const workGraphUnavailable = sections?.['workGraph'] === 'unavailable';
  const providerRows =
    report === null || captureUnavailable
      ? []
      : (report.capture.providers ?? fallbackProviderRows(report.capture.lastByProvider));
  const lastProvider = providerRows.find((row) => row.lastCaptureAt !== null);
  const window1h = report?.capture.window1h;
  const activity = report?.recall.activity;
  const candidates = report?.workGraph?.candidates ?? [];
  const candidateSignal = candidates.some(isCandidateSignal);
  const candidateWarningCount = candidates.filter(
    (candidate) =>
      candidate.status === 'warning' ||
      (candidate.status === 'alarm' && !isCandidateSignal(candidate)),
  ).length;
  const disabledCandidateCount = candidates.filter(
    (candidate) => candidate.status === 'off',
  ).length;
  const shadowCandidateCount = candidates.filter((candidate) => candidate.lane === 'shadow').length;
  const standbyCandidateCount = candidates.filter(
    (candidate) => candidate.lane === 'standby',
  ).length;

  // Pipeline-stage rollup. Each entry describes one logical stage in
  // the capture → … → sync flow. 'unavailable' = the server could not
  // collect this section's metrics (timed out); distinct from 'idle'
  // (collected, nothing yet) so the strip never fabricates a 0.
  const pipelineStages: readonly PipelineStage[] = (() => {
    if (report === null) return [];
    const captureStatus: PipelineStatus = captureUnavailable
      ? 'unavailable'
      : queueWarn
        ? 'warn'
        : lastProvider === undefined
          ? 'idle'
          : 'ok';
    const window1hSummary =
      window1h === undefined
        ? ''
        : ` · ${String(window1h.captures)} in 1h${
            window1h.warnings > 0 || window1h.fails > 0
              ? ` (${String(window1h.warnings)}w/${String(window1h.fails)}f)`
              : ''
          }`;
    const captureDetail = captureUnavailable
      ? 'unavailable — metrics didn’t load'
      : lastProvider === undefined
        ? 'no captures yet'
        : `${String(providerRows.length)} provider${providerRows.length === 1 ? '' : 's'} · ${formatWhen(lastProvider.lastCaptureAt)}${window1hSummary}`;
    const captureHead = captureUnavailable
      ? 'Unavailable'
      : lastProvider === undefined
        ? 'No signal yet'
        : `${String(providerRows.length)} provider${providerRows.length === 1 ? '' : 's'}`;

    const vaultStatus: PipelineStatus = report.vault.writable ? 'ok' : 'err';
    const vaultDetail = report.vault.writable
      ? `writable · ${formatBytes(report.vault.sizeBytes)}`
      : 'not writable';
    const vaultHead = report.vault.writable ? formatBytes(report.vault.sizeBytes) : 'Not writable';

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
    const matHead =
      matEntries.length === 0
        ? 'Not configured'
        : `${String(matEntries.length - matFailed - matDegraded)} / ${String(matEntries.length)}`;

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
    const rebuildPhaseTag = report.recall.rebuildPhase ? `[${report.recall.rebuildPhase}] ` : '';
    const recallDetail =
      recallStatus === 'rebuilding'
        ? report.recall.rebuildTotal !== undefined && report.recall.rebuildTotal > 0
          ? `rebuilding ${rebuildPhaseTag}${String(report.recall.rebuildEmbedded ?? 0)}/${String(report.recall.rebuildTotal)}`
          : `rebuilding ${rebuildPhaseTag}…`
        : recallStatus === undefined
          ? `${formatCount(report.recall.entryCount)} vectors`
          : `${recallStatus} · ${formatCount(report.recall.entryCount)} vectors`;
    const recallHead =
      recallStatus === 'rebuilding' ? 'Rebuilding' : `${formatCount(report.recall.entryCount)} vec`;

    // Ranker — driven by workGraph.ranker. Honest training mix: never
    // the raw negative count alone; the labeled triple + dataset-
    // changed flag + skip reason makes "0 user negatives" unambiguous.
    const rankerHealth = report.workGraph?.ranker;
    const rankerStatus: PipelineStatus = workGraphUnavailable
      ? 'unavailable'
      : rankerHealth === undefined
        ? 'idle'
        : rankerHealth.loadStatus === 'ready'
          ? 'ok'
          : rankerHealth.loadStatus === 'invalid-model'
            ? 'err'
            : 'warn';
    const mix = rankerHealth?.trainingMix;
    const mixLine =
      mix === undefined || mix === null
        ? ''
        : ` · +${String(mix.positivesAtTrain)} / uf-${String(
            mix.userFeedbackNegativesAtTrain,
          )} / neg-${mix.trainingNegatives === null ? 'unknown' : String(mix.trainingNegatives)}`;
    const staleLine =
      rankerHealth?.datasetChangedSinceTrain === true
        ? ` · data changed since train${
            rankerHealth.retrainSkipReason === null ? '' : ` (${rankerHealth.retrainSkipReason})`
          }`
        : '';
    const rankerDetail = workGraphUnavailable
      ? 'unavailable — metrics didn’t load'
      : rankerHealth === undefined
        ? 'workGraph not reported'
        : rankerHealth.loadStatus === 'ready' && rankerHealth.trainedAt !== null
          ? `snapshot ${formatRelative(
              new Date(rankerHealth.trainedAt).toISOString(),
            )}${mixLine}${staleLine}`
          : rankerHealth.loadStatus === 'missing'
            ? `${
                rankerHealth.retrainSkipReason === null
                  ? 'no snapshot yet'
                  : `pending · ${rankerHealth.retrainSkipReason}`
              }${mixLine}`
            : rankerHealth.loadStatus === 'invalid-model'
              ? 'snapshot invalid'
              : `ready${mixLine}${staleLine}`;
    const rankerHead = workGraphUnavailable
      ? 'Unavailable'
      : rankerHealth === undefined
        ? 'No signal yet'
        : rankerHealth.loadStatus === 'ready'
          ? rankerHealth.trainedAt !== null
            ? `Snapshot ${formatRelative(new Date(rankerHealth.trainedAt).toISOString())}`
            : 'Ready'
          : rankerHealth.loadStatus === 'invalid-model'
            ? 'Invalid model'
            : 'No snapshot';

    const experimentsStatus: PipelineStatus = workGraphUnavailable
      ? 'unavailable'
      : candidates.length === 0
        ? 'idle'
        : candidateSignal
          ? 'err'
          : candidateWarningCount > 0
            ? 'warn'
            : 'ok';
    // The shadow-vs-baseline A/B digest is now emitted every drain
    // (including skip drains — companion G2), so surface it inline in
    // the always-visible stage row instead of only in the drill. The
    // headline IS the idf-rkn-split clustering (the served producer
    // post-G1); the baseline union-find is retained only as the A/B
    // comparison input. Falls back to the candidate-lane summary when
    // the focus digest hasn't loaded (older companion / cold start).
    const svb = focusHealth?.digest?.shadowVsBaseline;
    const obs = focusHealth?.digest?.shadowObservation;
    const abAvailable = svb?.shadowTopicCount !== undefined;
    const warnSuffix = candidateWarningCount > 0 ? ` · ${String(candidateWarningCount)}w` : '';
    const experimentsHead = workGraphUnavailable
      ? 'Unavailable'
      : abAvailable
        ? `idf-rkn ${String(svb?.shadowTopicCount)} topics`
        : candidates.length === 0
          ? 'No signal yet'
          : `${String(shadowCandidateCount)} shadow · ${String(standbyCandidateCount)} standby`;
    const experimentsDetail = workGraphUnavailable
      ? 'unavailable — metrics didn’t load'
      : abAvailable
        ? `A/B vs union-find · noise ${fmtNum(svb?.noiseShare, 2)} · churn ${fmtNum(
            obs?.adjacentPerVisitChurn,
            2,
          )} · max share ${fmtNum(svb?.shadowMaxTopicShare, 3)}${warnSuffix}`
        : candidates.length === 0
          ? 'candidate lanes not reported'
          : `${String(candidateWarningCount)} warning${candidateWarningCount === 1 ? '' : 's'} · ${String(disabledCandidateCount)} disabled`;

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
    const syncHead =
      relay === undefined
        ? 'Single-replica'
        : relay.connected === true
          ? 'Connected'
          : relay.connected === false
            ? 'Disconnected'
            : 'Unknown';

    const topicHealth = report.workGraph?.topicProducer;
    const topicStatus: PipelineStatus = workGraphUnavailable
      ? 'unavailable'
      : topicHealth === undefined
        ? 'idle'
        : topicHealth.activeRevisionId === null
          ? 'warn'
          : topicHealth.topicCount === 0
            ? 'warn'
            : 'ok';
    const algoLabel =
      topicHealth?.algorithmVersion !== undefined && topicHealth.algorithmVersion !== null
        ? ` · ${topicHealth.algorithmVersion}`
        : '';
    const topicDetail = workGraphUnavailable
      ? 'unavailable — metrics didn’t load'
      : topicHealth === undefined
        ? 'workGraph not reported'
        : topicHealth.activeRevisionId === null
          ? 'no revision yet'
          : topicHealth.topicCount === 0
            ? 'no clusters yet'
            : `${String(topicHealth.topicCount)} topic${topicHealth.topicCount === 1 ? '' : 's'} · ${String(topicHealth.lineageCount)} lineage${algoLabel}`;
    const topicHead = workGraphUnavailable
      ? 'Unavailable'
      : topicHealth === undefined
        ? 'No signal yet'
        : topicHealth.activeRevisionId === null
          ? 'No revision'
          : topicHealth.topicCount === 0
            ? 'No clusters'
            : `${String(topicHealth.topicCount)} topic${topicHealth.topicCount === 1 ? '' : 's'}`;

    // Sparkline series only where a real series exists. Topics uses the
    // focus-health history shadowTopicCount; Vault uses gc family sizes.
    // No series → omit the sparkline (the design forbids faking bars).
    const topicSpark = (focusHealth?.history ?? [])
      .map((h) => h.shadowTopicCount)
      .filter((v): v is number => typeof v === 'number');

    return [
      {
        id: 'capture',
        name: 'Capture',
        status: captureStatus,
        head: captureHead,
        detail: captureDetail,
        ...(window1h !== undefined ? { mini: `${String(window1h.captures)} / 1h` } : {}),
      },
      {
        id: 'vault',
        name: 'Vault',
        status: vaultStatus,
        head: vaultHead,
        detail: vaultDetail,
      },
      {
        id: 'materializers',
        name: 'Materializers',
        status: matStatus,
        head: matHead,
        detail: matDetail,
      },
      {
        id: 'recall',
        name: 'Embedding',
        status: recallStatusFor,
        head: recallHead,
        detail: recallDetail,
      },
      {
        id: 'topics',
        name: 'Topics',
        status: topicStatus,
        head: topicHead,
        detail: topicDetail,
        ...(topicSpark.length > 1 ? { spark: topicSpark } : {}),
      },
      {
        id: 'ranker',
        name: 'Ranker',
        status: rankerStatus,
        head: rankerHead,
        detail: rankerDetail,
      },
      {
        id: 'experiments',
        name: 'Experiments',
        status: experimentsStatus,
        head: experimentsHead,
        detail: experimentsDetail,
      },
      {
        id: 'sync',
        name: 'Sync',
        status: syncStatus,
        head: syncHead,
        detail: syncDetail,
      },
    ];
  })();

  // Server-derived worst-of light. Preferred over an ad-hoc client
  // rollup because the companion already computed it (and it accounts
  // for sections the client can't see, e.g. timed-out collectors).
  const overallStatus: ObservabilityStatus | null = report?.observability?.status ?? null;
  const overallPill: 'ok' | 'warn' | 'stale' | 'unavail' =
    overallStatus === 'failed' || overallStatus === 'degraded' ? 'warn' : 'ok';
  const overallLabel =
    overallStatus === null
      ? loadState === 'live'
        ? 'Healthy'
        : loadState
      : overallStatus === 'ok'
        ? 'Healthy'
        : overallStatus === 'degraded'
          ? 'Degraded'
          : 'Failed';

  // Active alarms — derive from the pipeline stages that aren't healthy
  // (err → signal, warn → amber). Links back into the same drill-down.
  const pipelineAlarms = pipelineStages
    .filter((s) => s.status === 'err' || s.status === 'warn' || s.status === 'unavailable')
    .map((s) => ({
      stage: s.id,
      sev: s.status === 'err' ? 'signal' : 'amber',
      name: s.name,
      head: s.head,
      meta: s.detail,
    }));
  const candidateAlarms = candidates
    .filter(
      (candidate) =>
        candidate.status === 'warning' ||
        candidate.status === 'alarm' ||
        (candidate.status === 'unavailable' && candidate.lane === 'active'),
    )
    .map((candidate) => {
      return {
        stage: 'experiments',
        sev: isCandidateSignal(candidate) ? 'signal' : 'amber',
        name: `${candidate.family} · ${candidate.lane}`,
        head: formatCandidateStatus(candidate.status),
        meta: `${candidate.id}${candidate.reason === null ? '' : ` · ${candidate.reason}`}`,
      };
    });
  const alarms = [...pipelineAlarms, ...candidateAlarms];

  const copyDiagnostics = () => {
    if (report === null) return;
    const dump = JSON.stringify(
      {
        ...report,
        focusHealth,
        hygiene,
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

  const node = pipelineStages.find((n) => n.id === stage) ?? pipelineStages[0];

  // ── Drill-downs ──────────────────────────────────────────────────

  const renderExperimentsDrill = () => {
    const activeServingRows = candidates.filter(
      (candidate) => candidate.servingImpact === 'serving',
    );
    const diagnosticRows = candidates.filter((candidate) => candidate.lane === 'diagnostic');
    const contentLane = candidates.find(
      (candidate) => candidate.id === 'content-lane.dirty-source-queue',
    );
    const rankerMethodology = candidates.find(
      (candidate) => candidate.id === 'ranker.methodology-spine',
    );
    const driftSidecar = candidates.find(
      (candidate) => candidate.id === 'diagnostic.drift-sidecar',
    );
    const shadowHistory = focusHealth?.history ?? [];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="sx-drill-title">Experiments</h2>

        {candidates.length === 0 ? (
          <div className="sx-callout warn">
            Candidate lanes are not reported by this companion. Disabled and unavailable paths are
            intentionally not rendered as zero.
          </div>
        ) : null}

        <div className="sx-tilegrid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className={`sx-tile${candidateSignal ? ' alarm' : ''}`}>
            <div className="lbl">Serving rows</div>
            <div className="num">{String(activeServingRows.length)}</div>
            <div className="foot">active alarms that affect serving</div>
          </div>
          <div className={`sx-tile${candidateWarningCount > 0 ? ' warn' : ''}`}>
            <div className="lbl">Warnings</div>
            <div className="num">{String(candidateWarningCount)}</div>
            <div className="foot">promotion blockers · drift · backlogs</div>
          </div>
          <div className="sx-tile">
            <div className="lbl">Disabled</div>
            <div className="num">{String(disabledCandidateCount)}</div>
            <div className="foot">standby/off is informational</div>
          </div>
          <div className="sx-tile">
            <div className="lbl">Diagnostic</div>
            <div className="num">{String(diagnosticRows.length)}</div>
            <div className="foot">observe-only</div>
          </div>
        </div>

        <table className="sx-monotbl" data-testid="hp-experiments-table">
          <thead>
            <tr>
              <th>Family</th>
              <th>Lane</th>
              <th>Serving impact</th>
              <th>Candidate/revision</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Last observed</th>
              <th>What changed</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => (
              <tr key={candidate.id} className={candidateRowClass(candidate.status)}>
                <td>{candidate.family}</td>
                <td>{candidate.lane}</td>
                <td>{candidate.servingImpact}</td>
                <td className="mono">{candidate.revisionId ?? candidate.id}</td>
                <td>
                  <span className={`sx-stamp ${candidateStatusStamp(candidate.status)}`}>
                    {formatCandidateStatus(candidate.status)}
                  </span>
                </td>
                <td>{candidate.reason ?? '—'}</td>
                <td>{candidate.asOf === null ? 'no signal yet' : formatWhen(candidate.asOf)}</td>
                <td className="mono">{metricSummary(candidate) || 'no signal yet'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="sx-receipt">
          <div className="sx-receipt-head">
            <span className="sx-stamp deterministic">Receipts</span>
            <span className="sx-mono sx-dim" style={{ flex: 1 }}>
              workGraph.candidates[] · focus-health.history
            </span>
          </div>
          <dl>
            <ReceiptRow
              dt="Content lane"
              dd={`dirty ${formatCandidateMetric(
                contentLane?.metrics.dirtySourceCount,
              )} · tombstoned ${formatCandidateMetric(
                contentLane?.metrics.tombstonedSourceCount,
              )} · oldest ${formatCandidateMetric(contentLane?.metrics.oldestDirtySourceAgeMs)}`}
            />
            <ReceiptRow
              dt="Ranker ship gate"
              dd={`status ${formatCandidateMetric(
                rankerMethodology?.metrics.shipGateStatus,
              )} · enforced ${formatCandidateMetric(
                rankerMethodology?.metrics.servingGateEnforced,
              )}`}
            />
            <ReceiptRow
              dt="Drift"
              dd={`status ${formatCandidateMetric(
                driftSidecar?.metrics.driftStatus,
              )} · tripped ${formatCandidateMetric(
                driftSidecar?.metrics.trippedSignalCount,
              )} · warning ${formatCandidateMetric(driftSidecar?.metrics.warningSignalCount)}`}
            />
          </dl>
        </div>

        <h3 className="sx-h">Shadow trend</h3>
        {shadowHistory.length === 0 ? (
          <div className="sx-callout">
            No ring-buffer history yet. The panel reports <em>no signal yet</em> rather than drawing
            a synthetic trend.
          </div>
        ) : (
          <table className="sx-monotbl">
            <thead>
              <tr>
                <th>Drain</th>
                <th className="right">Shadow topics</th>
                <th className="right">Max share</th>
                <th className="right">Noise</th>
                <th className="right">Adjacent churn</th>
              </tr>
            </thead>
            <tbody>
              {shadowHistory
                .slice()
                .reverse()
                .slice(0, 8)
                .map((sample, index) => (
                  <tr key={`${sample.at}-${String(index)}`}>
                    <td>{formatWhen(sample.at)}</td>
                    <td className="right">{sample.shadowTopicCount ?? '—'}</td>
                    <td className="right">{fmtNum(sample.shadowMaxTopicShare, 3)}</td>
                    <td className="right">{fmtNum(sample.noiseShare, 2)}</td>
                    <td className="right">{fmtNum(sample.adjacentPerVisitChurn, 2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  const renderTopicsDrill = () => {
    const tp = report?.workGraph?.topicProducer;
    const fhUnavailable =
      focusHealth === null ||
      focusHealth.availability === 'unavailable' ||
      focusHealth.digest === null;
    const svb = focusHealth?.digest?.shadowVsBaseline;
    const obs = focusHealth?.digest?.shadowObservation;
    const history = focusHealth?.history ?? [];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="sx-drill-title">Topics</h2>
        <div className="sx-tilegrid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className={`sx-tile${workGraphUnavailable ? ' unavail' : ''}`}>
            <div className="lbl">Active revision</div>
            <div className="num">
              {workGraphUnavailable
                ? 'unavailable'
                : tp === undefined
                  ? 'no signal yet'
                  : tp.topicCount === 0
                    ? 'no clusters'
                    : String(tp.topicCount)}
              {!workGraphUnavailable && tp !== undefined && tp.topicCount > 0 ? (
                <small> topics</small>
              ) : null}
            </div>
            <div className="foot">
              {tp?.algorithmVersion ?? (workGraphUnavailable ? 'metrics didn’t load' : '—')}
            </div>
          </div>
          <div className={`sx-tile${fhUnavailable ? ' unavail' : ''}`}>
            <div className="lbl">Shadow comparison</div>
            <div className="num">
              {fhUnavailable
                ? 'unavailable'
                : svb?.shadowTopicCount === undefined
                  ? 'no signal yet'
                  : String(svb.shadowTopicCount)}
              {!fhUnavailable && svb?.shadowTopicCount !== undefined ? (
                <small> topics</small>
              ) : null}
            </div>
            <div className="foot">
              {fhUnavailable
                ? 'focus digest didn’t load'
                : `max share ${fmtNum(svb?.shadowMaxTopicShare, 3)} · noise ${fmtNum(
                    svb?.noiseShare,
                    2,
                  )} · adjacent churn ${fmtNum(obs?.adjacentPerVisitChurn, 2)}`}
            </div>
          </div>
        </div>

        <div className="sx-callout">
          The shadow comparison surfaces <code>shadowObservation.adjacentPerVisitChurn</code> (per
          drain), not <code>shadowVsBaseline.perVisitChurn</code> — the latter is degenerate when
          the baseline revision has collapsed. Absent figures render{' '}
          <em>&quot;no signal yet&quot;</em>, never a fabricated value.
        </div>

        <div className="sx-receipt">
          <div className="sx-receipt-head">
            <span className={`sx-stamp ${fhUnavailable ? 'partial' : 'deterministic'}`}>
              <span />
              {fhUnavailable ? 'Unavailable' : 'Observed'}
            </span>
            <span className="sx-mono sx-dim" style={{ flex: 1 }}>
              focus-health.digest
            </span>
          </div>
          <dl>
            <ReceiptRow dt="Active revision" dd={tp?.activeRevisionId ?? 'no signal yet'} mono />
            <ReceiptRow dt="Active algorithm" dd={tp?.algorithmVersion ?? 'no signal yet'} mono />
            <ReceiptRow
              dt="Active topics"
              dd={tp === undefined ? 'no signal yet' : String(tp.topicCount)}
            />
            <ReceiptRow
              dt="Shadow revision"
              dd={obs?.shadowRevisionId ?? svb?.candidate ?? 'no signal yet'}
              mono
            />
            <ReceiptRow
              dt="Shadow topics"
              dd={
                svb?.shadowTopicCount === undefined
                  ? 'no signal yet'
                  : `${String(svb.shadowTopicCount)} (max share ${fmtNum(
                      svb.shadowMaxTopicShare,
                      3,
                    )} · noise ${fmtNum(svb.noiseShare, 2)})`
              }
            />
            <ReceiptRow
              dt="Adjacent churn"
              dd={<span className="sx-mono">{fmtNum(obs?.adjacentPerVisitChurn, 2)}</span>}
            />
            <ReceiptRow
              dt="Digest as-of"
              dd={<span className="sx-mono">{formatWhen(focusHealth?.asOf)}</span>}
            />
          </dl>
        </div>

        <h3 className="sx-h">Drain trend · last {String(history.length)} drains (ring buffer)</h3>
        {history.length === 0 ? (
          <div className="sx-callout warn">
            No drain history recorded yet — the ring buffer next to <code>latest.json</code> is
            empty. This is the honest unavailable state, not zero churn.
          </div>
        ) : (
          <table className="sx-monotbl">
            <thead>
              <tr>
                <th>Drain</th>
                <th className="right">Shadow topics</th>
                <th className="right">Max share</th>
                <th className="right">Noise</th>
                <th className="right">Adjacent churn</th>
              </tr>
            </thead>
            <tbody>
              {history
                .slice()
                .reverse()
                .slice(0, 14)
                .map((h, i) => (
                  <tr key={`${h.at}-${String(i)}`}>
                    <td>{formatWhen(h.at)}</td>
                    <td className="right">{h.shadowTopicCount ?? '—'}</td>
                    <td className="right">{fmtNum(h.shadowMaxTopicShare, 3)}</td>
                    <td className="right">{fmtNum(h.noiseShare, 2)}</td>
                    <td className="right">{fmtNum(h.adjacentPerVisitChurn, 2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  const renderRankerDrill = () => {
    const r = report?.workGraph?.ranker;
    const mix = r?.trainingMix;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="sx-drill-title">
          Ranker
          {r?.loadStatus === 'ready' && r.trainedAt !== null
            ? ` · snapshot ${formatRelative(new Date(r.trainedAt).toISOString())}`
            : ''}
        </h2>

        {r?.datasetChangedSinceTrain === true ? (
          <div className="sx-callout warn">
            <strong>Data changed · the active model is behind.</strong>{' '}
            {r.retrainSkipReason === null ? (
              'No retrain decision recorded.'
            ) : (
              <>
                Reason: <code>{r.retrainSkipReason}</code>.
              </>
            )}{' '}
            Retrain cadence is feedback-only — a model can silently freeze whenever positive
            feedback stalls.
          </div>
        ) : null}

        <div className="sx-tilegrid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className={`sx-tile${mix === undefined || mix === null ? ' unavail' : ''}`}>
            <div className="lbl">Positives</div>
            <div className="num">
              {mix === undefined || mix === null ? 'no signal yet' : String(mix.positivesAtTrain)}
            </div>
            <div className="foot">user-asserted, at train</div>
          </div>
          <div className={`sx-tile${mix === undefined || mix === null ? ' unavail' : ''}`}>
            <div className="lbl">User-feedback neg</div>
            <div className="num">
              {mix === undefined || mix === null
                ? 'no signal yet'
                : String(mix.userFeedbackNegativesAtTrain)}
            </div>
            <div className="foot">labelled — not &quot;training negatives&quot;</div>
          </div>
          <div className={`sx-tile${mix === undefined || mix === null ? ' unavail' : ''}`}>
            <div className="lbl">Training neg</div>
            <div className="num">
              {mix === undefined || mix === null
                ? 'no signal yet'
                : mix.trainingNegatives === null
                  ? 'unknown'
                  : String(mix.trainingNegatives)}
            </div>
            <div className="foot">synthetic · null ⇒ unknown, never 0</div>
          </div>
        </div>

        <div className="sx-receipt">
          <div className="sx-receipt-head">
            <span
              className={`sx-stamp ${
                r === undefined ? 'partial' : r.loadStatus === 'ready' ? 'deterministic' : 'partial'
              }`}
            >
              <span />
              {r === undefined
                ? 'No signal'
                : r.loadStatus === 'ready'
                  ? 'Loaded'
                  : r.loadStatus === 'invalid-model'
                    ? 'Invalid'
                    : 'No snapshot'}
            </span>
            <span className="sx-mono sx-dim" style={{ flex: 1 }}>
              workGraph.ranker
            </span>
            <button
              type="button"
              className="sx-btn signal"
              onClick={() => {
                void forceRetrain();
              }}
            >
              <span className="icon">{Icons.refresh}</span>
              Force retrain
            </button>
          </div>
          <dl>
            <ReceiptRow dt="Active revision" dd={r?.activeRevisionId ?? 'no signal yet'} mono />
            <ReceiptRow
              dt="Load status"
              dd={<span className="sx-mono">{r?.loadStatus ?? 'no signal yet'}</span>}
            />
            <ReceiptRow
              dt="Trained"
              dd={
                r?.trainedAt === null || r?.trainedAt === undefined
                  ? 'no signal yet'
                  : formatRelative(new Date(r.trainedAt).toISOString())
              }
            />
            <ReceiptRow
              dt="Dataset changed?"
              dd={
                r?.datasetChangedSinceTrain === true ? (
                  <span className="sx-stamp partial">yes — model behind</span>
                ) : r === undefined ? (
                  <span className="sx-mono">no signal yet</span>
                ) : (
                  <span className="sx-mono">no</span>
                )
              }
            />
            <ReceiptRow
              dt="Skip reason"
              dd={<span className="sx-mono">{r?.retrainSkipReason ?? 'no signal yet'}</span>}
            />
            <ReceiptRow
              dt="New labels since"
              dd={r === undefined ? 'no signal yet' : String(r.retrainNewLabelCount)}
            />
          </dl>
          <div className="sx-receipt-reason">
            A force retrain bypasses <em>policy</em> gates (threshold, cooldown). It still respects{' '}
            <em>substance</em> gates (<code>unchanged</code>, <code>no-labels</code>,{' '}
            <code>no-training-candidates</code>) — forcing cannot manufacture a healthier-looking
            artifact than the data supports. The toast reports the decision verbatim.
          </div>
        </div>
      </div>
    );
  };

  const renderCaptureDrill = () => {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="sx-drill-title">
          Capture · {String(providerRows.length)} provider
          {providerRows.length === 1 ? '' : 's'}
        </h2>

        {captureUnavailable ? (
          <div className="sx-callout warn" data-testid="hp-capture-unavailable">
            Capture metrics unavailable — they didn’t load this snapshot (not zero captures). The
            companion timed out collecting this section; rows are intentionally not synthesized.
          </div>
        ) : (
          <div className="sx-tilegrid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div className={`sx-tile${window1h === undefined ? ' unavail' : ''}`}>
              <div className="lbl">Captures · 1h</div>
              <div className="num">
                {window1h === undefined ? 'no signal yet' : String(window1h.captures)}
              </div>
              <div className="foot">rolling window</div>
            </div>
            <div
              className={`sx-tile${
                window1h === undefined ? ' unavail' : window1h.warnings > 0 ? ' warn' : ''
              }`}
            >
              <div className="lbl">Warnings · 1h</div>
              <div className="num">
                {window1h === undefined ? 'no signal yet' : String(window1h.warnings)}
              </div>
              <div className="foot">soft failures</div>
            </div>
            <div
              className={`sx-tile${
                window1h === undefined ? ' unavail' : window1h.fails > 0 ? ' alarm' : ''
              }`}
            >
              <div className="lbl">Fails · 1h</div>
              <div className="num">
                {window1h === undefined ? 'no signal yet' : String(window1h.fails)}
              </div>
              <div className="foot">hard failures</div>
            </div>
          </div>
        )}

        <div className="sx-tilegrid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className={`sx-tile${queueDepth === null ? ' unavail' : queueWarn ? ' warn' : ''}`}>
            <div className="lbl">Queued captures</div>
            <div className="num">{queueDepth === null ? 'no signal yet' : String(queueDepth)}</div>
            <div className="foot">local extension buffer</div>
          </div>
          <div className={`sx-tile${dropped === null ? ' unavail' : dropped > 0 ? ' warn' : ''}`}>
            <div className="lbl">Dropped captures</div>
            <div className="num">{dropped === null ? 'no signal yet' : String(dropped)}</div>
            <div className="foot">
              {dropped === null ? 'local count unavailable' : `dropped ${String(dropped)} this run`}
            </div>
          </div>
        </div>

        <h3 className="sx-h">Providers</h3>
        {captureUnavailable ? (
          <div className="sx-callout">
            No provider rows — capture metrics are unavailable this snapshot.
          </div>
        ) : providerRows.length === 0 ? (
          <div className="sx-callout">No captures yet.</div>
        ) : (
          <table className="sx-monotbl">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Last captured</th>
                <th>Title</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {providerRows.map((row) => (
                <tr key={row.provider}>
                  <td>{providerLabel(row.provider)}</td>
                  <td>{formatWhen(row.lastCaptureAt)}</td>
                  <td>
                    {row.lastCaptureTitle !== undefined && row.lastCaptureTitle.length > 0
                      ? `“${row.lastCaptureTitle}”`
                      : '—'}
                  </td>
                  <td>
                    <span
                      className={`sx-status ${statusState(row.lastStatus) === 'ok' ? 'ok' : 'warn'}`}
                    >
                      <span className="dot" />
                      {row.lastStatus ?? 'seen'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {report !== null &&
        report.capture.recentWarnings !== undefined &&
        report.capture.recentWarnings.length > 0 ? (
          <>
            <h3 className="sx-h">Recent warnings</h3>
            {report.capture.recentWarnings.slice(0, 6).map((w) => (
              <div
                className="sx-callout warn"
                key={`${w.provider}-${w.capturedAt}-${w.code}`}
                style={{ marginBottom: 6 }}
              >
                <code>
                  {w.provider}.{w.code}
                </code>{' '}
                · {formatWhen(w.capturedAt)} — {w.message}
              </div>
            ))}
          </>
        ) : null}
      </div>
    );
  };

  const renderVaultDrill = () => {
    const gcUnavailable =
      hygiene === null || hygiene.availability.gc === 'unavailable' || hygiene.gc === null;
    const groups = hygiene?.gc?.groups ?? {};
    const groupEntries = Object.entries(groups);
    const sizeBytes = report?.vault.sizeBytes ?? null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="sx-drill-title">Vault · {formatBytes(sizeBytes)}</h2>

        <div className="sx-tilegrid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="sx-tile">
            <div className="lbl">On disk</div>
            <div className="num">{formatBytes(sizeBytes)}</div>
            <div className="foot">{report?.vault.root ?? '—'}</div>
          </div>
          <div className={`sx-tile${gcUnavailable ? ' unavail' : ''}`}>
            <div className="lbl">GC-tracked</div>
            <div className="num">
              {gcUnavailable ? 'unavailable' : formatBytes(hygiene?.gc?.totalBytes ?? null)}
            </div>
            <div className="foot">
              {gcUnavailable
                ? 'inventory didn’t load (not zero)'
                : `${String(hygiene?.gc?.totalCount ?? 0)} files`}
            </div>
          </div>
        </div>

        <h3 className="sx-h">Revision inventory</h3>
        {gcUnavailable ? (
          <div className="sx-callout warn">
            GC inventory unavailable — the cached walk hasn’t landed yet (
            <code>availability.gc === &apos;unavailable&apos;</code>). This is the honest
            unavailable state; counts are not fabricated as zero.
          </div>
        ) : groupEntries.length === 0 ? (
          <div className="sx-callout">No GC-tracked revision families.</div>
        ) : (
          <table className="sx-inv">
            <thead>
              <tr>
                <th>Family</th>
                <th>Count</th>
                <th>Bytes</th>
              </tr>
            </thead>
            <tbody>
              {groupEntries.map(([family, g]) => (
                <tr key={family}>
                  <td>{family}</td>
                  <td className="mono">{String(g.count)}</td>
                  <td className="mono">{formatBytes(g.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {hygiene?.pageContent != null ? (
          <>
            <h3 className="sx-h">Page-content coverage</h3>
            <dl className="sx-kv" style={{ display: 'block' }}>
              <div className="sx-kv">
                <dt>Indexed</dt>
                <dd className="mono">
                  {String(hygiene.pageContent.indexed)} / {String(hygiene.pageContent.total)}
                </dd>
              </div>
              {Object.entries(hygiene.pageContent.byState).map(([s, n]) => (
                <div className="sx-kv" key={s}>
                  <dt>{s}</dt>
                  <dd className="mono">{String(n)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </div>
    );
  };

  const renderMaterializersDrill = () => {
    const mats = report?.sync?.materializers ?? {};
    const entries = Object.entries(mats);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="sx-drill-title">Materializers · {String(entries.length)}</h2>
        {entries.length === 0 ? (
          <div className="sx-callout">
            Sync relay is not configured (single-replica mode) — no per-replica materializers.
          </div>
        ) : (
          <table className="sx-inv">
            <thead>
              <tr>
                <th>Materializer</th>
                <th>Last drain</th>
                <th>Pending</th>
                <th>Last effect</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([name, m]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="mono">
                    {m.lastSuccessAt === null ? 'never' : formatWhen(m.lastSuccessAt)}
                  </td>
                  <td className="mono">{m.pending ? 'pending' : '0'}</td>
                  <td className="mono sx-dim">—</td>
                  <td>
                    <span
                      className={`sx-status ${
                        m.status === 'healthy' ? 'ok' : m.status === 'degraded' ? 'warn' : 'warn'
                      }`}
                    >
                      <span className="dot" />
                      {m.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="sx-callout">
          Per-materializer &quot;last effect&quot; deltas (e.g. <code>+12 edges</code>) are not in
          the health contract — the column renders <code>—</code> rather than fabricating a sample
          number.
        </div>
      </div>
    );
  };

  const renderEmbeddingDrill = () => {
    const rec = report?.recall;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="sx-drill-title">
          Embedding · {formatCount(rec?.entryCount ?? null)} vectors
        </h2>
        <div className="sx-tilegrid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="sx-tile">
            <div className="lbl">Vectors</div>
            <div className="num">{formatCount(rec?.entryCount ?? null)}</div>
            <div className="foot">{formatBytes(rec?.sizeBytes ?? null)}</div>
          </div>
          <div
            className={`sx-tile${rec?.status === 'rebuilding' ? ' warn' : rec?.status === undefined ? ' unavail' : ''}`}
          >
            <div className="lbl">Status</div>
            <div className="num" style={{ fontSize: 18 }}>
              {rec?.status ?? 'no signal yet'}
            </div>
            <div className="foot">{rec?.modelId?.split('/').pop() ?? 'no model'}</div>
          </div>
          <div className="sx-tile">
            <div className="lbl">Last indexed</div>
            <div className="num" style={{ fontSize: 18 }}>
              {formatWhen(rec?.activity?.lastIndexedAt)}
            </div>
            <div className="foot">
              {rec?.activity?.lastIndexedCount === null ||
              rec?.activity?.lastIndexedCount === undefined
                ? '—'
                : `${String(rec.activity.lastIndexedCount)} turns`}
            </div>
          </div>
        </div>

        {rec?.status === 'rebuilding' ? (
          <div className="sx-callout warn">
            Rebuilding
            {rec.rebuildPhase != null ? (
              <>
                {' '}
                · phase <code>{rec.rebuildPhase}</code>
              </>
            ) : null}
            {rec.rebuildTotal !== undefined && rec.rebuildTotal > 0
              ? ` · ${String(rec.rebuildEmbedded ?? 0)}/${String(rec.rebuildTotal)} embedded`
              : ''}
          </div>
        ) : null}

        {rec?.embedderDevice !== undefined && rec.embedderDevice !== 'unknown' ? (
          <div className="sx-callout">
            Embedder:{' '}
            <code>{formatEmbedderLabel(rec.embedderDevice, rec.embedderAccelerator)}</code>
          </div>
        ) : null}

        {rec?.lastError != null ? (
          <div className="sx-callout alarm">Last error: {rec.lastError}</div>
        ) : null}

        <h3 className="sx-h">Recall activity</h3>
        {activity === undefined || activity.recent.length === 0 ? (
          <div className="sx-callout">No recall activity recorded this run.</div>
        ) : (
          (() => {
            const recent = activity.recent;
            const withResult = recent.filter((e) => typeof e.resultCount === 'number');
            const zero = withResult.filter((e) => e.resultCount === 0).length;
            const newestAt = recent[0]?.at;
            return (
              <>
                <div className="sx-callout">
                  {String(recent.length)} recall event{recent.length === 1 ? '' : 's'} this run
                  {withResult.length > 0
                    ? ` · ${String(zero)}/${String(withResult.length)} zero-result (expected — recommender found nothing to suggest)`
                    : ''}
                  {newestAt !== undefined ? ` · last ${formatWhen(newestAt)}` : ''}
                  {'  '}
                  <button
                    type="button"
                    className="sx-btn ghost"
                    onClick={() => setRecallActivityOpen((open) => !open)}
                  >
                    {recallActivityOpen ? 'hide' : 'details'}
                  </button>
                </div>
                {recallActivityOpen ? (
                  <table className="sx-monotbl">
                    <tbody>
                      {recent.slice(0, 8).map((event, index) => (
                        <tr key={`${event.kind}-${event.at}-${String(index)}`}>
                          <td>
                            {activityText(event)}
                            {event.resultCount === 0 ? ' (no match — expected)' : ''}
                          </td>
                          <td className="right">{formatWhen(event.at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </>
            );
          })()
        )}
      </div>
    );
  };

  const renderSyncDrill = () => {
    const sync = report?.sync;
    const relay = sync?.relay;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h2 className="sx-drill-title">
          Sync · {relay === undefined ? 'single-replica' : relay.mode}
        </h2>

        <div className="sx-callout">
          Structural-delta history is not yet recorded in the health contract — a 24-bar
          structural-delta chart would require a backing series that doesn’t exist. Showing the raw
          replica + seq instead is the honest substitute.
        </div>

        {sync === undefined ? (
          <div className="sx-callout">Sync relay is not configured (single-replica mode).</div>
        ) : (
          <>
            <div className="sx-tilegrid" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div className="sx-tile">
                <div className="lbl">This replica</div>
                <div className="num" style={{ fontSize: 16, fontFamily: 'var(--mono)' }}>
                  {sync.replicaId.slice(0, 12)}…
                </div>
                <div className="foot">seq · {String(sync.seq)}</div>
              </div>
              {relay !== undefined ? (
                <div className={`sx-tile${relay.connected === false ? ' warn' : ''}`}>
                  <div className="lbl">Relay</div>
                  <div className="num" style={{ fontSize: 16 }}>
                    {relay.connected === true
                      ? 'connected'
                      : relay.connected === false
                        ? 'disconnected'
                        : 'unknown'}
                  </div>
                  <div className="foot">{relay.url}</div>
                </div>
              ) : null}
            </div>

            <h3 className="sx-h">Replica · seq</h3>
            <dl className="sx-kv" style={{ display: 'block' }}>
              <div className="sx-kv">
                <dt>Replica id</dt>
                <dd className="mono">{sync.replicaId}</dd>
              </div>
              <div className="sx-kv">
                <dt>Seq</dt>
                <dd className="mono">{String(sync.seq)}</dd>
              </div>
              {relay !== undefined &&
              (relay.eventsIn !== undefined || relay.eventsOut !== undefined) ? (
                <div className="sx-kv">
                  <dt>Events in / out</dt>
                  <dd className="mono">
                    {String(relay.eventsIn ?? 0)} · {String(relay.eventsOut ?? 0)}
                  </dd>
                </div>
              ) : null}
            </dl>
            <div className="sx-callout">
              Structural-delta series not yet recorded — the design’s 24-bar chart has no backing
              data in the contract, so it is intentionally omitted rather than faked.
            </div>
          </>
        )}
      </div>
    );
  };

  const renderDrill = () => {
    if (node === undefined) return null;
    switch (node.id) {
      case 'topics':
        return renderTopicsDrill();
      case 'ranker':
        return renderRankerDrill();
      case 'experiments':
        return renderExperimentsDrill();
      case 'capture':
        return renderCaptureDrill();
      case 'vault':
        return renderVaultDrill();
      case 'materializers':
        return renderMaterializersDrill();
      case 'recall':
        return renderEmbeddingDrill();
      case 'sync':
        return renderSyncDrill();
      default:
        return renderTopicsDrill();
    }
  };

  return (
    <div className="sx-health" role="dialog" aria-label="Capture health">
      {/* Op-bar — board controls */}
      <div className="sx-opbar">
        <button type="button" className="sx-btn ghost" onClick={onClose} aria-label="Close">
          <span className="icon">{Icons.back}</span>
        </button>
        <span className="label">Health</span>
        {report !== null ? <StatusPill value={overallPill} label={overallLabel} /> : null}
        {node !== undefined ? <span className="reason">{node.detail}</span> : null}
        <span className="grow" />
        {report?.observability?.asOf !== undefined ? (
          <span className="sx-asof">as of {formatWhen(report.observability.asOf)}</span>
        ) : (
          <span className="sx-asof">snapshot · {loadState === 'live' ? 'live' : loadState}</span>
        )}
        <button
          type="button"
          className="sx-btn"
          onClick={copyDiagnostics}
          disabled={report === null}
        >
          <span className="icon">{copied ? Icons.check : Icons.copy}</span>
          {copied ? 'Copied' : 'Diagnostics bundle'}
        </button>
      </div>

      {report === null ? (
        <div className="sx-empty">
          <div className="sx-empty-title">
            {loadState === 'not-configured' ? 'Companion not configured' : 'Health unavailable'}
          </div>
          <div className="sx-empty-copy">
            {loadState === 'loading'
              ? 'Loading companion diagnostics…'
              : 'Connect the Sidetrack companion to show live capture, recall, and service diagnostics.'}
          </div>
        </div>
      ) : (
        <div className="sx-board">
          {/* Pipeline strip — the spine */}
          {pipelineStages.length > 0 ? (
            <div className="sx-pipeline" data-testid="hp-pipeline">
              {pipelineStages.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={`sx-pipenode ${stage === s.id ? 'selected ' : ''}${nodeVariant(s.status)}`}
                  onClick={() => setStage(s.id)}
                  title={`${s.name}: ${s.detail}`}
                  data-testid={`hp-pipeline-stage-${s.id}`}
                >
                  <div className="stage">{s.name}</div>
                  <div className="head">{s.head}</div>
                  <div className="sub">{s.detail}</div>
                  <div className="grow" />
                  {s.spark !== undefined || s.mini !== undefined ? (
                    <div className="footrow">
                      {s.spark !== undefined ? (
                        <Spark data={s.spark} variant={nodeVariant(s.status)} />
                      ) : null}
                      {s.mini !== undefined ? <span className="sx-mini">{s.mini}</span> : null}
                    </div>
                  ) : null}
                  <div className="arrow">›</div>
                </button>
              ))}
            </div>
          ) : null}

          {/* Body — main drill-down + side rail */}
          <div className="sx-board-body">
            <div className="sx-board-main">{renderDrill()}</div>

            <aside className="sx-board-side">
              <div>
                <h4 className="sx-h">Active alarms · {String(alarms.length)}</h4>
                {alarms.length === 0 ? (
                  <div className="sx-callout">All stages healthy.</div>
                ) : (
                  alarms.map((a) => (
                    <button
                      type="button"
                      key={`${a.stage}:${a.name}:${a.head}:${a.meta}`}
                      className={`sx-alarm ${a.sev}`}
                      onClick={() => setStage(a.stage)}
                    >
                      <div className="body">
                        <div className="stage">{a.name}</div>
                        <div className="head">{a.head}</div>
                        <div className="meta">{a.meta}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>

              <div>
                <h4 className="sx-h">Why this board</h4>
                <div className="sx-callout">
                  Every figure carries an <code>asOf</code> and one of{' '}
                  <span className="sx-mono">ok / stale / unavailable</span>. Budget-fallback or
                  missing data renders as <em>&quot;unavailable&quot;</em> /{' '}
                  <em>&quot;no signal yet&quot;</em>, never as a healthy zero.
                </div>
              </div>

              <div>
                <h4 className="sx-h">Honesty rule</h4>
                <div className="sx-callout warn">
                  A number whose name implies more than it measures (a bare negative-label count,
                  budget-fallback zeros, churn during a collapse) is relabeled with what it actually
                  measures or rendered as <em>&quot;no signal yet&quot;</em>.
                </div>
              </div>

              <div>
                <h4 className="sx-h">Re-index</h4>
                <button
                  type="button"
                  className="sx-btn"
                  disabled={
                    rebuildState.kind === 'accepted' || report.recall.status === 'rebuilding'
                  }
                  onClick={() => {
                    void triggerRebuild();
                  }}
                >
                  <span className="icon">{Icons.refresh}</span>
                  {report.recall.status === 'rebuilding'
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
                      : 'Re-index embeddings'}
                </button>
                {rebuildState.kind === 'error' ? (
                  <div className="sx-empty-copy" style={{ marginTop: 6 }}>
                    {rebuildState.message}
                  </div>
                ) : null}
              </div>
            </aside>
          </div>

          {toast !== null ? (
            <div className="sx-toast">
              <span>{toast}</span>
              <button type="button" onClick={() => setToast(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
