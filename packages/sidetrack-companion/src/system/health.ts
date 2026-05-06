import type { RecallActivityReport } from '../recall/activity.js';

export interface CaptureProviderHealth {
  readonly provider: string;
  readonly lastCaptureAt: string | null;
  readonly lastStatus: 'ok' | 'warning' | 'failed' | null;
  readonly ok24h: number;
  readonly warn24h: number;
  readonly fail24h: number;
  readonly warning?: string;
}

export interface CaptureWarningHealth {
  readonly provider: string;
  readonly capturedAt: string;
  readonly code: string;
  readonly message: string;
  readonly severity: 'info' | 'warning';
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

const withBudget = async <T>(
  operation: () => Promise<T>,
  fallback: T,
  budgetMs: number = FAST_OP_BUDGET_MS,
): Promise<T> =>
  await Promise.race([
    operation(),
    new Promise<T>((resolve) => {
      setTimeout(() => {
        resolve(fallback);
      }, budgetMs);
    }),
  ]);

export const collectHealth = async (deps: HealthDeps): Promise<HealthReport> => {
  const now = deps.now?.() ?? new Date();
  const [writable, sizeBytes, capture, recall, service] = await Promise.all([
    withBudget(deps.vaultWritable, false),
    withBudget(deps.vaultSizeBytes, null, HEAVY_OP_BUDGET_MS),
    withBudget(
      deps.captureSummary,
      { lastByProvider: {}, queueDepthHint: null, droppedHint: null },
      HEAVY_OP_BUDGET_MS,
    ),
    withBudget(
      deps.recallSummary,
      { indexExists: false, entryCount: null, modelId: null, sizeBytes: null },
      HEAVY_OP_BUDGET_MS,
    ),
    withBudget(deps.serviceStatus, { installed: false, running: false }),
  ]);
  const sync = deps.syncSummary?.();
  return {
    uptimeSec: Math.max(0, Math.floor((now.getTime() - deps.startedAt.getTime()) / 1000)),
    vault: { root: deps.vaultRoot, writable, sizeBytes },
    capture,
    recall,
    service,
    ...(sync === undefined ? {} : { sync }),
  };
};
