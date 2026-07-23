import type { RecallActivityReport } from '../recall/activity.js';
import type { EventLaneHealth } from '../sync/eventLaneHealth.js';
import type { EngagementLaneHealth } from './engagementLaneHealth.js';
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

// Data-loss tripwires (durability wave, roadmap H3). PRD §15 claims zero
// data loss; before this section that claim was UNFALSIFIABLE — nothing
// on the health surface counted the places the read/write path detects a
// dropped or torn event. `counters` are the process-lifetime event-lane
// counters (any non-zero value is a visible red signal). `reconciliation`
// is the store's OWN store-vs-JSONL delta, computed cheaply from what the
// event store already tracks (its row count vs the sum of its per-replica
// watermarks) — never a full JSONL scan on the health path. It is absent
// when the event store is off / not open, so callers must distinguish
// `null` (not measured) from `{ delta: 0 }` (measured, converged).
export interface DataLossHealth {
  readonly counters: EventLaneHealth;
  // True iff every event-lane counter is zero AND (when measured) the
  // store reconciliation delta is zero. The load-bearing single boolean
  // the UI flips to red on.
  readonly clean: boolean;
  readonly reconciliation: {
    // Rows physically present in the event store mirror.
    readonly storeRowCount: number;
    // Sum of the store's per-replica watermarks — the count the store
    // expects to hold if every committed seq is present and dense.
    readonly expectedFromWatermark: number;
    // expectedFromWatermark - storeRowCount. Non-zero ⇒ the store is
    // missing committed events it believes it accepted (a durability
    // red flag), or seqs are sparse (also worth surfacing).
    readonly delta: number;
  } | null;
}

// Learned-rerank (ranker) refresh liveness. The background model refresh
// can fail silently — a dead ranker keeps serving the last order with no
// operator signal. Surfaced here so a stuck refresh is visible. All
// fields optional: the getter is only wired when a ranker is configured.
export interface RankerRefreshHealth {
  readonly serveable: boolean;
  readonly revisionId: string | null;
  readonly lastRefreshAt: string | null;
  readonly lastError: string | null;
}

// Spawned MCP child liveness. `running` reflects the actual child process
// state (not a config flag); a silently-dead child is otherwise invisible.
export interface McpChildHealth {
  readonly running: boolean;
  readonly pid: number | null;
  readonly lastExitCode: number | null;
  readonly lastError: string | null;
}

// F28 honest service.running. Historically `service.running` was inferred
// from plist EXISTENCE — a crashed-but-installed service read as running
// forever. Reconcile the installer's plist-existence heuristic with a real
// liveness probe: the probe is authoritative when it can answer
// (running/not-running); `unknown` (tool absent / timed out) falls back to
// the heuristic rather than fabricating a false negative. Pure + exported
// so the honesty rule is unit-testable without spinning up the server.
export const resolveServiceRunning = (
  plistInferredRunning: boolean,
  liveness: Liveness,
): boolean => {
  if (liveness === 'running') return true;
  if (liveness === 'not-running') return false;
  return plistInferredRunning;
};

// Mirror of install/launchd Liveness so health.ts owns a stable local
// type (the install module is the source of truth for the probe itself).
export type Liveness = 'running' | 'not-running' | 'unknown';

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
  // Data-loss tripwires — always populated by collectHealth (the getter
  // is cheap and required). Makes PRD §15 falsifiable.
  readonly dataLoss?: DataLossHealth;
  // Engagement-lane freshness — aggregate-vs-interval divergence.
  // Present only when the runtime wires the probe (needs the shared
  // event store). Observability only; freeze-safe.
  readonly engagementLane?: EngagementLaneHealth;
  // Liveness edges — present only when the runtime wires the getter.
  readonly ranker?: RankerRefreshHealth;
  readonly mcpChild?: McpChildHealth;
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
        readonly status: 'healthy' | 'busy' | 'degraded' | 'failed';
        readonly lastSuccessAt: string | null;
        readonly lastError: string | null;
        readonly pending: boolean;
        readonly frontier?: Record<string, number>;
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
  // Data-loss tripwires. `eventLaneHealth` is the sync module's
  // process-lifetime counter snapshot (getEventLaneHealth). Defaults to
  // an all-zero snapshot so legacy test call-sites need not wire it.
  readonly eventLaneHealth?: () => EventLaneHealth;
  // Cheap store-vs-JSONL reconciliation the store already knows (row
  // count + summed watermark). Returns null when the store is off/closed.
  // Must NOT full-scan; at most one COUNT query plus a watermark read.
  readonly storeReconciliation?: () => Promise<DataLossHealth['reconciliation']>;
  // Liveness edges — synchronous, side-effect-free getters. Omitted when
  // no ranker / MCP child is managed.
  readonly rankerHealth?: () => RankerRefreshHealth;
  readonly mcpChildHealth?: () => McpChildHealth;
  // Engagement-lane freshness probe (aggregate-vs-interval divergence).
  // Async — two indexed MAX queries against the shared event store.
  // Omitted (undefined) when the store is off; a throw/timeout degrades
  // to an absent engagementLane, never a failed health response.
  readonly engagementLaneHealth?: () => Promise<EngagementLaneHealth>;
}

const ZERO_EVENT_LANE_HEALTH: EventLaneHealth = {
  skippedMalformedLines: 0,
  storeSkippedOutOfOrder: 0,
  dotCollisions: 0,
  duplicateCaptures: 0,
  unreadableShards: 0,
};

// Exported so the drain-time §15 collector can reuse the exact
// counters-clean predicate the health surface uses (section15Artifact.ts
// folds dataLoss.clean into its per-day ledger for the ≥7-clean-days
// streak, and MUST agree with what /v1/system/health reports).
export const anyLaneCounterNonZero = (h: EventLaneHealth): boolean =>
  h.skippedMalformedLines > 0 ||
  h.storeSkippedOutOfOrder > 0 ||
  h.dotCollisions > 0 ||
  h.duplicateCaptures > 0 ||
  h.unreadableShards > 0;

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
  const [writableR, sizeBytesR, captureR, recallR, serviceR, workGraphR, reconciliationR] =
    await Promise.all([
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
      // Reconciliation is a cheap COUNT+watermark read, but a wedged
      // sqlite handle must never wedge the health path — give it a
      // FAST budget and fall back to "not measured" (null) on timeout.
      deps.storeReconciliation === undefined
        ? Promise.resolve<{ value: DataLossHealth['reconciliation']; timedOut: boolean }>({
            value: null,
            timedOut: false,
          })
        : withTrackedBudget<DataLossHealth['reconciliation']>(deps.storeReconciliation, null),
    ]);
  const writable = writableR.value;
  const sizeBytes = sizeBytesR.value;
  const capture = captureR.value;
  const recall = recallR.value;
  const service = serviceR.value;
  const workGraph = workGraphR.value;
  const sync = deps.syncSummary?.();

  // Data-loss tripwires. Counters are a synchronous snapshot (default
  // all-zero when unwired). `clean` folds the counters with the store
  // reconciliation delta so the UI has one boolean to flip red.
  const laneCounters = deps.eventLaneHealth?.() ?? ZERO_EVENT_LANE_HEALTH;
  const reconciliation = reconciliationR.value;
  const dataLoss: DataLossHealth = {
    counters: laneCounters,
    reconciliation,
    clean:
      !anyLaneCounterNonZero(laneCounters) &&
      (reconciliation === null || reconciliation.delta === 0),
  };
  // Liveness edges — synchronous getters; guard against a throwing getter
  // so a broken probe can't take down the whole health response.
  const ranker = ((): RankerRefreshHealth | undefined => {
    try {
      return deps.rankerHealth?.();
    } catch {
      return undefined;
    }
  })();
  const mcpChild = ((): McpChildHealth | undefined => {
    try {
      return deps.mcpChildHealth?.();
    } catch {
      return undefined;
    }
  })();
  // Engagement-lane freshness — async, best-effort. A stalled aggregate
  // lane is observability, not a health failure (it never sets `status`);
  // any error/absence just omits the field.
  const engagementLane = await (async (): Promise<EngagementLaneHealth | undefined> => {
    try {
      return await deps.engagementLaneHealth?.();
    } catch {
      return undefined;
    }
  })();

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
  // Served-signal floor guard (flapping fix, requirement B). Surface the
  // similarity floor as its OWN section so a suppressed collapse flips
  // the top-level status non-ok (`degraded`), not buried inside the
  // workGraph candidates list. Mirrors the dataLoss `stale` convention:
  // a suppressed collapse (candidate `alarm`) is a real, non-fallback
  // signal that the served graph would have flapped. Only wired when the
  // workGraph report is present + the candidate exists (absent for legacy
  // fixtures / pre-fix diagnostics).
  if (workGraph !== undefined && !workGraphR.timedOut) {
    const floorCandidate = workGraph.candidates.find(
      (candidate) => candidate.id === 'similarity.served-signal-floor',
    );
    if (floorCandidate !== undefined) {
      sections['similarityFloor'] = floorCandidate.status === 'alarm' ? 'stale' : 'ok';
    }
  }
  if (sync !== undefined) sections['sync'] = 'ok';
  // A tripped tripwire is `stale` (a real, non-fallback signal that
  // something durable went wrong), and the reconciliation timing out is
  // `unavailable`. Both drive the worst-of below.
  sections['dataLoss'] = reconciliationR.timedOut
    ? 'unavailable'
    : dataLoss.clean
      ? 'ok'
      : 'stale';
  if (ranker !== undefined) sections['ranker'] = ranker.lastError === null ? 'ok' : 'stale';
  if (mcpChild !== undefined) sections['mcpChild'] = mcpChild.running ? 'ok' : 'stale';

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
  // A tripped data-loss tripwire is a `failed`, not merely `degraded`,
  // signal: PRD §15 promises zero data loss, so any non-zero counter or
  // a non-zero reconciliation delta is the loudest thing this surface can
  // say. A silently-dead MCP child (running=false but installed) is a
  // real outage of that subsystem → failed.
  if (!dataLoss.clean) status = worst(status, 'failed');
  if (mcpChild !== undefined && !mcpChild.running) status = worst(status, 'failed');

  return {
    uptimeSec: Math.max(0, Math.floor((now.getTime() - deps.startedAt.getTime()) / 1000)),
    vault: { root: deps.vaultRoot, writable, sizeBytes },
    capture,
    recall,
    service,
    dataLoss,
    ...(engagementLane === undefined ? {} : { engagementLane }),
    observability: { asOf: now.toISOString(), status, sections },
    ...(ranker === undefined ? {} : { ranker }),
    ...(mcpChild === undefined ? {} : { mcpChild }),
    ...(workGraph === undefined ? {} : { workGraph }),
    ...(sync === undefined ? {} : { sync }),
  };
};
