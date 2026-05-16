import type { RecallActivityReport } from '../recall/activity.js';
import type { WorkGraphHealthReport } from './workGraphHealth.js';

export interface CaptureProviderHealth {
  readonly provider: string;
  readonly lastCaptureAt: string | null;
  readonly lastStatus: 'ok' | 'warning' | 'failed' | null;
  readonly ok24h: number;
  readonly warn24h: number;
  readonly fail24h: number;
  readonly warning?: string;
  // Plan TODO-H7: content hint so a heartbeat timestamp says *what*
  // was captured, not just that something was.
  readonly lastCaptureTitle?: string;
  readonly lastCaptureThreadId?: string;
}

export interface CaptureWarningHealth {
  readonly provider: string;
  readonly capturedAt: string;
  readonly code: string;
  readonly message: string;
  readonly severity: 'info' | 'warning';
}

// Honesty contract (plan TODO-H1/H2/X1): a section is `unavailable`
// when its summary timed out and we fell back to an empty value — that
// is NOT the same as a real zero, and the UI must not render it as
// "no data". `stale` is when the section returned a real value that
// itself reports it is behind. `ok` is a fresh real value.
export type SectionAvailability = 'ok' | 'stale' | 'unavailable';
export type HealthStatus = 'ok' | 'degraded' | 'failed';

export interface HealthObservability {
  // ISO timestamp this report was collected (all sections share it
  // since they are gathered together).
  readonly asOf: string;
  // Server-side derived worst-of so the board renders one light
  // without re-deriving it ad hoc in the component.
  readonly status: HealthStatus;
  // Per-section reachability/freshness. Keys mirror HealthReport
  // sections that were collected: vault, capture, recall, service,
  // workGraph (if wired), sync (if wired).
  readonly sections: Readonly<Record<string, SectionAvailability>>;
}

export interface HealthReport {
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
    // Plan TODO-H6: a real 1h activity window. Deliberately NOT
    // queue/process-time percentiles — that data does not exist in the
    // capture event log, and fabricating it would be the exact
    // misleading-metric failure this work targets. This is the honest
    // signal that IS computable here: capture volume over the last hour.
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
    // Lifecycle fields — present when the companion was started with
    // a recall lifecycle manager (production); absent in tests that
    // don't care about freshness state.
    readonly status?: 'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready';
    readonly eventTurnCount?: number;
    readonly currentModelId?: string;
    readonly companionVersion?: string;
    readonly lastRebuildAt?: string | null;
    readonly lastRebuildIndexed?: number | null;
    readonly lastError?: string | null;
    readonly rebuildEmbedded?: number;
    readonly rebuildTotal?: number;
    // Follow-up #17: current rebuild stage, shown inline at the
    // Embedding pipeline node. Passthrough string (display only);
    // null/absent at rest or when a child-indexer rebuild can't
    // report phases.
    readonly rebuildPhase?: string | null;
    readonly embedderDevice?: 'cpu' | 'wasm' | 'webgpu' | 'unknown';
    readonly embedderAccelerator?: 'accelerate' | 'mkl' | 'cpu' | 'unknown';
    readonly activity?: RecallActivityReport;
    // Quantitative coverage metric. `pct` is `1 - liveEntryCount /
    // eventTurnCount` when the index lags the event log, else 0.
    // `tolerance` is the threshold at which the lifecycle flips to
    // 'stale' and schedules a rebuild.
    readonly drift?: {
      readonly eventTurnCount: number;
      readonly entryCount: number;
      readonly pct: number;
      readonly tolerance: number;
    };
    // Track 2: Sidetrack-managed embedding-model cache status. Lets
    // the side panel surface "model: cached / verified / missing"
    // without poking inside HF's default cache layout.
    readonly model?: {
      readonly id: string;
      readonly revision: string;
      readonly cacheDir: string;
      readonly present: boolean;
      readonly verified: boolean;
      readonly offline: boolean;
    };
  };
  readonly service: { readonly installed: boolean; readonly running: boolean };
  // Optional so the many call-sites/tests that construct HealthReport
  // literals stay valid; collectHealth always populates it.
  readonly observability?: HealthObservability;
  readonly workGraph?: WorkGraphHealthReport;
  // Identity of the local replica + its Lamport high-water mark.
  // Optional so legacy / test call-sites that don't wire a replica
  // context still produce a valid health report.
  readonly sync?: {
    readonly replicaId: string;
    readonly seq: number;
    readonly relay?: {
      readonly mode: 'local' | 'remote';
      readonly url: string;
    };
    // Sync Contract v1: per-materializer health so degraded
    // derivations are observable, not silent. Each entry is the
    // output of a registered Materializer's health() method. Gate
    // L1-G9 — materializer failure is visible here, not buried.
    readonly materializers?: Record<
      string,
      {
        readonly status: 'healthy' | 'degraded' | 'failed';
        readonly lastSuccessAt: string | null;
        readonly lastError: string | null;
        readonly pending: boolean;
      }
    >;
  };
}

export interface HealthDeps {
  readonly startedAt: Date;
  readonly now?: () => Date;
  readonly vaultRoot: string;
  readonly vaultWritable: () => Promise<boolean>;
  readonly vaultSizeBytes: () => Promise<number | null>;
  readonly captureSummary: () => Promise<HealthReport['capture']>;
  readonly recallSummary: () => Promise<HealthReport['recall']>;
  readonly serviceStatus: () => Promise<HealthReport['service']>;
  readonly syncSummary?: () => HealthReport['sync'];
  readonly workGraphSummary?: () => Promise<WorkGraphHealthReport>;
}

// Per-operation timeout. The 250ms cap that lived here originally
// was tight enough to silently force `captureSummary` and
// `recallSummary` into their empty fallbacks on any vault with
// multi-MB event logs — the UX was "Capture health is empty even
// though I just captured ten things." /v1/system/health is polled
// every ~30s, not on the request hot path, so a multi-second
// budget is the right tradeoff.
const FAST_OP_BUDGET_MS = 1_000;
const HEAVY_OP_BUDGET_MS = 5_000;

// Tracked variant: reports whether the operation timed out and we
// served the fallback. This is the load-bearing honesty signal — the
// previous withBudget could not tell a real empty value from a
// budget-fallback, which is exactly how "capture timed out" rendered
// as "no events yet".
const withTrackedBudget = async <T>(
  operation: () => Promise<T>,
  fallback: T,
  budgetMs: number = FAST_OP_BUDGET_MS,
): Promise<{ readonly value: T; readonly timedOut: boolean }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ value: T; timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ value: fallback, timedOut: true });
    }, budgetMs);
  });
  try {
    return await Promise.race([
      operation().then((value) => ({ value, timedOut: false as const })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const worst = (a: HealthStatus, b: HealthStatus): HealthStatus => {
  if (a === 'failed' || b === 'failed') return 'failed';
  if (a === 'degraded' || b === 'degraded') return 'degraded';
  return 'ok';
};

export const collectHealth = async (deps: HealthDeps): Promise<HealthReport> => {
  const now = deps.now?.() ?? new Date();
  const [writableR, sizeBytesR, captureR, recallR, serviceR, workGraphR] = await Promise.all([
    withTrackedBudget(deps.vaultWritable, false),
    withTrackedBudget(deps.vaultSizeBytes, null, HEAVY_OP_BUDGET_MS),
    withTrackedBudget(
      deps.captureSummary,
      { lastByProvider: {}, queueDepthHint: null, droppedHint: null },
      HEAVY_OP_BUDGET_MS,
    ),
    withTrackedBudget(
      deps.recallSummary,
      { indexExists: false, entryCount: null, modelId: null, sizeBytes: null },
      HEAVY_OP_BUDGET_MS,
    ),
    withTrackedBudget(deps.serviceStatus, { installed: false, running: false }),
    deps.workGraphSummary === undefined
      ? Promise.resolve<{ value: WorkGraphHealthReport | undefined; timedOut: boolean }>({
          value: undefined,
          timedOut: false,
        })
      : withTrackedBudget<WorkGraphHealthReport | undefined>(
          deps.workGraphSummary,
          undefined,
          HEAVY_OP_BUDGET_MS,
        ),
  ]);
  const writable = writableR.value;
  const sizeBytes = sizeBytesR.value;
  const capture = captureR.value;
  const recall = recallR.value;
  const service = serviceR.value;
  const workGraph = workGraphR.value;
  const sync = deps.syncSummary?.();

  // Per-section availability: timed-out summaries are `unavailable`
  // (served the empty fallback), not a real zero. A vault size that
  // timed out is `stale` rather than `unavailable` because writability
  // is the real liveness signal there.
  const sections: Record<string, SectionAvailability> = {
    vault: writableR.timedOut ? 'unavailable' : sizeBytesR.timedOut ? 'stale' : 'ok',
    capture: captureR.timedOut ? 'unavailable' : 'ok',
    recall: recallR.timedOut
      ? 'unavailable'
      : recall.status === 'missing' || recall.status === 'stale'
        ? 'stale'
        : 'ok',
    service: serviceR.timedOut ? 'unavailable' : 'ok',
  };
  if (workGraph !== undefined || deps.workGraphSummary !== undefined) {
    sections['workGraph'] = workGraphR.timedOut ? 'unavailable' : 'ok';
  }
  if (sync !== undefined) sections['sync'] = 'ok';

  // Derived worst-of. A real outage (vault not writable, a materializer
  // failed) is `failed`; missing/stale data or a degraded materializer
  // is `degraded`; everything fresh is `ok`.
  let status: HealthStatus = 'ok';
  if (!writable && !writableR.timedOut) status = worst(status, 'failed');
  for (const availability of Object.values(sections)) {
    if (availability === 'unavailable' || availability === 'stale') {
      status = worst(status, 'degraded');
    }
  }
  if (recall.status === 'missing' || recall.status === 'stale' || recall.status === 'rebuilding') {
    status = worst(status, 'degraded');
  }
  for (const materializer of Object.values(sync?.materializers ?? {})) {
    if (materializer.status === 'failed') status = worst(status, 'failed');
    else if (materializer.status === 'degraded') status = worst(status, 'degraded');
  }

  return {
    uptimeSec: Math.max(0, Math.floor((now.getTime() - deps.startedAt.getTime()) / 1000)),
    vault: { root: deps.vaultRoot, writable, sizeBytes },
    capture,
    recall,
    service,
    observability: { asOf: now.toISOString(), status, sections },
    ...(workGraph === undefined ? {} : { workGraph }),
    ...(sync === undefined ? {} : { sync }),
  };
};
