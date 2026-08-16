// System / service-lifecycle / health routes: liveness, version, status,
// vault-changes SSE registration, service install/uninstall, update-check,
// auto-update, the health assembly, hygiene-status, vault-ledger,
// focus-health, section15, reliability, tab-recovery, bridge-key rotation,
// and (systemRoutesC) the debug-dump endpoint.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { rotateBridgeKey } from '../../auth/bridgeKey.js';
import { readBuildInfo } from '../../build-info.js';
import { collectReliabilityReport } from '../../calibration/reliabilityCollector.js';
import {
  getDrainDegradation,
  type DrainDegradationSnapshot,
} from '../../connections/drainDegradation.js';
import {
  getGenerationRecovery,
  type GenerationRecoverySnapshot,
} from '../../connections/generationRecovery.js';
import { readHealthHistory } from '../../connections/healthHistory.js';
import { SqliteConnectionsStore } from '../../connections/snapshot.js';
import { gcInventoryCached } from '../../gc/plan.js';
import { summarizeVaultLedger, vaultLedgerCached } from '../../gc/vaultLedger.js';
import { pickInstaller, type InstallOptions } from '../../install/index.js';
import { probeServiceLiveness } from '../../install/launchd.js';
import {
  pageContentCoverageCounts,
  scanForOverCollapsedPageContent,
  type OverCollapsedRecord,
} from '../../page-content/store.js';
import { getModelCacheStatus } from '../../recall/modelCache.js';
import { rank } from '../../recall/ranker.js';
import { getSemanticRecallPoolMigrationStatus } from '../../recall/semanticRecallPool.js';
import { getEventLaneHealth } from '../../sync/eventLaneHealth.js';
import { eventStoreEnabled, getSharedEventStore } from '../../sync/eventStore.js';
import type { ReplicaContext } from '../../sync/replicaId.js';
import { runAutoUpdate } from '../../system/autoUpdate.js';
import { collectEngagementLaneHealth } from '../../system/engagementLaneHealth.js';
import {
  collectHealth,
  deriveDataLossHealth,
  healthStatusFromReport,
  resolveServiceRunning,
  withCurrentDataLossHealth,
  type CaptureWarningHealth,
  type DataLossHealth,
  type HealthReport,
  type SectionAvailability,
} from '../../system/health.js';
import {
  isReliabilityArtifactFresh,
  readReliabilityArtifact,
} from '../../system/reliabilityArtifact.js';
import type {
  ResourceReadinessWatchdogs,
  WatchdogStatus,
} from '../../system/resourceReadinessWatchdog.js';
import {
  getResolveCanary,
  resolveCanaryStatus,
  resolveCanaryThresholdMs,
  type ResolveCanarySnapshot,
} from '../../system/resolveCanary.js';
import { isSection15ArtifactFresh, readSection15Artifact } from '../../system/section15Artifact.js';
import { collectSection15Report } from '../../system/section15Collector.js';
import {
  CHROME_SESSIONS_RESTORE,
  TAB_RECOVERY_AGGREGATE_ID,
  isChromeSessionsRestorePayload,
} from '../../system/section15Events.js';
import { checkLatestVersion } from '../../system/versionCheck.js';
import { collectWorkGraphHealth, withLiveShipGateV2Serving } from '../../system/workGraphHealth.js';
import {
  isWorkGraphHealthArtifactFresh,
  readWorkGraphHealthArtifact,
} from '../../system/workGraphHealthArtifact.js';
import { lanePrequentialSummary } from '../../tabsession/lanePrequential.js';
import { COMPANION_VERSION } from '../../version.js';
import { autoUpdateSchema } from '../schemas.js';

import {
  HttpRouteError,
  baseVectorForAggregate,
  objectRecord,
  readBody,
  recallIndexPath,
  requireIdempotencyKey,
  requireVaultRoot,
  runIdempotent,
} from '../routeSupport.js';
import type { CompanionHttpConfig, RouteDefinition } from '../routeSupport.js';

// Spread-helper for the optional sync summary in /v1/system/health.
// Captures the replica context once so the inner closure doesn't
// need a non-null assertion.
const syncSummaryDeps = (
  replica: ReplicaContext | undefined,
  sync: CompanionHttpConfig['sync'],
  syncMaterializerHealth?: CompanionHttpConfig['syncMaterializerHealth'],
): {
  syncSummary?: () => {
    replicaId: string;
    seq: number;
    relay?: {
      readonly mode: 'local' | 'remote';
      readonly url: string;
      readonly connected?: boolean;
      readonly lastConnectedAtMs?: number;
      readonly lastDisconnectedAtMs?: number;
      readonly consecutiveFailures?: number;
      readonly pendingPublishes?: number;
    };
    materializers?: Record<
      string,
      {
        readonly status: 'healthy' | 'busy' | 'degraded' | 'failed';
        readonly lastSuccessAt: string | null;
        readonly lastError: string | null;
        readonly pending: boolean;
      }
    >;
  };
} =>
  replica === undefined
    ? {}
    : {
        syncSummary: () => {
          // Splice live transport status into the relay block so
          // the side panel can render relay_disconnected without
          // hitting a separate endpoint. Only present when both
          // (a) relay is configured AND (b) the runtime exposed
          // a getRelayStatus closure (production wiring does;
          // tests that pass --sync-relay-local without a live
          // transport may not).
          const relayBase = sync?.relay;
          const materializers = syncMaterializerHealth?.();
          const materializersBlock =
            materializers === undefined || Object.keys(materializers).length === 0
              ? {}
              : { materializers };
          if (relayBase === undefined) {
            return {
              replicaId: replica.replicaId,
              seq: replica.peekSeq(),
              ...materializersBlock,
            };
          }
          const live = sync?.getRelayStatus?.() ?? null;
          return {
            replicaId: replica.replicaId,
            seq: replica.peekSeq(),
            relay: {
              ...relayBase,
              ...(live === null
                ? {}
                : {
                    connected: live.connected,
                    consecutiveFailures: live.consecutiveFailures,
                    pendingPublishes: live.pendingPublishes,
                    ...(live.lastConnectedAtMs === undefined
                      ? {}
                      : { lastConnectedAtMs: live.lastConnectedAtMs }),
                    ...(live.lastDisconnectedAtMs === undefined
                      ? {}
                      : { lastDisconnectedAtMs: live.lastDisconnectedAtMs }),
                    // Stage 5 polish — peer-event throughput. Older
                    // runtimes that haven't been recompiled won't have
                    // these fields; guard via undefined.
                    ...(live.eventsIn === undefined ? {} : { eventsIn: live.eventsIn }),
                    ...(live.eventsOut === undefined ? {} : { eventsOut: live.eventsOut }),
                    ...(live.lastInboundAtMs === undefined
                      ? {}
                      : { lastInboundAtMs: live.lastInboundAtMs }),
                    ...(live.lastOutboundAtMs === undefined
                      ? {}
                      : { lastOutboundAtMs: live.lastOutboundAtMs }),
                    ...(live.byReplica === undefined ? {} : { byReplica: live.byReplica }),
                  }),
            },
            ...materializersBlock,
          };
        },
      };

const buildServiceInstallOptions = (context: CompanionHttpConfig): InstallOptions => {
  const defaults = context.serviceInstallDefaults;
  return {
    vaultPath: requireVaultRoot(context),
    port: defaults?.port ?? 17373,
    ...(defaults?.companionCommand === undefined
      ? {}
      : { companionCommand: defaults.companionCommand }),
    ...(defaults?.companionBin === undefined ? {} : { companionBin: defaults.companionBin }),
    ...(defaults?.mcpPort === undefined ? {} : { mcpPort: defaults.mcpPort }),
    ...(defaults?.mcpBin === undefined ? {} : { mcpBin: defaults.mcpBin }),
    ...(defaults?.syncRelayLocalPort === undefined
      ? {}
      : { syncRelayLocalPort: defaults.syncRelayLocalPort }),
    ...(defaults?.syncRelay === undefined ? {} : { syncRelay: defaults.syncRelay }),
  };
};

const directorySize = async (path: string): Promise<number> => {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return info.size;
  }
  const names = await readdir(path).catch(() => []);
  const sizes = await Promise.all(
    names.map((name) => directorySize(join(path, name)).catch(() => 0)),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
};

// `/v1/system/health` is polled by the extension (App.tsx every
// ~15-30s, HealthPanel ~30s) with NO in-flight dedupe across its
// (observed: 6) stacked sockets. Each call is ~0.85s and fully
// UNCACHED: directorySize() recurses the entire multi-GB _BAC tree,
// and the workGraph section's LIVE fallback (drain-time artifact
// missing — see system/workGraphHealthArtifact.ts) re-reads the typed
// event subsets (two FULL eventLog.readMerged passes when
// SIDETRACK_EVENT_STORE is off) + fingerprints every training label.
// Concurrent/rapid polls pile up into N overlapping full-tree walks
// ⇒ a pinned core (the second, non-connections CPU runaway). Mirror
// the /v1/system/hygiene-status fix (gcInventoryCached): a short TTL
// + in-flight dedupe so rapid/overlapping polls coalesce to ~1
// compute. Health is a status indicator; ≤TTL staleness is fine (the
// hygiene sibling uses a 5-MIN TTL — this is far more conservative).
// P3 — default raised 10s→60s. The extension polls /v1/system/health
// ~every 30s, so a 10s TTL guaranteed a cache MISS on every poll
// (~441ms recompute each). Health is a status indicator; ≤60s
// staleness is fine (the sibling /v1/system/hygiene-status uses a
// 5-min TTL). Env-tunable; resolved once (process-lifetime const).
const SYSTEM_HEALTH_TTL_MS = ((): number => {
  const raw = process.env['SIDETRACK_SYSTEM_HEALTH_TTL_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();

interface SystemHealthCacheEntry {
  readonly value: HealthReport;
  readonly computedAtMs: number;
}

const systemHealthCache = new Map<string, SystemHealthCacheEntry>();

const systemHealthInFlight = new Map<string, Promise<HealthReport>>();

const cachedCollectHealth = async (
  vaultRoot: string,
  build: () => Promise<HealthReport>,
): Promise<HealthReport> => {
  const cached = systemHealthCache.get(vaultRoot);
  if (cached !== undefined && Date.now() - cached.computedAtMs < SYSTEM_HEALTH_TTL_MS) {
    return cached.value;
  }
  const existing = systemHealthInFlight.get(vaultRoot);
  if (existing !== undefined) return existing;
  const compute = (async (): Promise<HealthReport> => {
    try {
      const value = await build();
      systemHealthCache.set(vaultRoot, { value, computedAtMs: Date.now() });
      return value;
    } catch (err) {
      // A failed refresh must not poison: serve the last good value
      // if we have one (mirrors gcInventoryCached).
      const prev = systemHealthCache.get(vaultRoot);
      if (prev !== undefined) return prev.value;
      throw err;
    } finally {
      systemHealthInFlight.delete(vaultRoot);
    }
  })();
  systemHealthInFlight.set(vaultRoot, compute);
  return compute;
};

// --- Reliability health section (resolve canary) ------------------------
//
// The resolve canary (system/resolveCanary.ts) is the standing probe for
// the single most user-felt metric — panel resolve latency. This helper
// folds its rolling-window snapshot into the health surface so a burst of
// slow/errored resolves is visible (and DECAYS: the window prunes, so the
// status returns to ok on its own — DEBUGGING_DOCTRINE §7, no stuck alarm).
// The canary module owns the timing/decay; server.ts owns only the HTTP-
// layer assembly (reading the registry + mapping to the health shape).

export interface ReliabilityHealthSection {
  // The canary's window snapshot plus its derived status. `idle` when no
  // canary is registered or the window has no samples (absence of signal
  // is not a failure — an empty/just-booted vault reads idle, not broken).
  readonly resolveCanary: ResolveCanarySnapshot & { readonly status: 'ok' | 'degraded' | 'idle' };
  // Drain degradation: times the HNSW delta-embedding similarity path threw
  // and the drain fell back to re-embedding the WHOLE eligible corpus
  // (minutes of ONNX instead of seconds — the measured cause of resolve
  // p95 blowing past the extension's client timeout). Silent before this:
  // the fallback only emitted a phase mark, and phase marks are off by
  // default. Non-zero here means at least one drain ran the slow path.
  readonly drainDegradation: DrainDegradationSnapshot;
  // Generation-swap recovery: reads that hit bun:sqlite's "disk I/O error" —
  // the signature of a handle whose double-buffer generation file was
  // unlinked/swapped underneath it — and were recovered by a reopen-and-retry
  // (or were not). This was the 2026-07-29 P0: a publish in ONE process GC'd a
  // write shadow open in ANOTHER, and the victim's next query threw an error
  // that was neither a lock nor corruption, so nothing retried it and it
  // surfaced as sync.materializers.connections 'failed'. The structural fix is
  // cross-process in-flight markers (generationBuffer.ts); these counters are
  // how a regression announces itself instead of being absorbed silently.
  // Absent == zero (process-lifetime counters, never persisted).
  readonly generationRecovery: GenerationRecoverySnapshot;
  // Section availability derived from the canary status: 'ok' when
  // ok/idle, 'stale' when degraded. This is what the observability board
  // renders for the reliability lane.
  readonly availability: SectionAvailability;
  // Size of the connections DB write-ahead log, bytes. A large/growing WAL
  // is a checkpoint-starvation fingerprint. null when the WAL file is
  // absent (fresh vault / in-memory / already checkpointed). Under M4
  // double-buffer this stats the live PUBLISHED generation's -wal, which the
  // publish-time wal_checkpoint(TRUNCATE) drives to ~0 (a near-zero steady
  // value is the health signal, vs the pre-M4 91MB swing).
  readonly walBytes: number | null;
  // M4 double-buffer (D5/D6). Absent (undefined) when double-buffer is off
  // (legacy single-file mode) so the surface can distinguish "not enabled"
  // from "enabled, zero swaps yet".
  readonly connectionsDoubleBuffer?: {
    readonly enabled: boolean;
    readonly generation: string | null;
    readonly swapCount: number;
    readonly lastSwapAtMs: number | null;
    readonly residentGenerations: readonly string[];
    // The last publish-time checkpoint outcome: pages folded + whether the
    // checkpoint was un-blocked (busy==0). Together with walBytes≈0 this is
    // the "checkpoint is keeping up" signal.
    readonly lastCheckpointTruncatedPages: number | null;
    readonly lastCheckpointOk: boolean | null;
    readonly lastGcUnlinked: number;
    readonly unchangedPublishSkipCount: number;
    readonly progressCheckpointCount: number;
    readonly lastPublishSkipAtMs: number | null;
    // In-place scoped/overlay publish (2026-08-16) — see the "Storage-tier
    // incremental publish" design note. Non-zero inPlacePublishCount with a
    // flat swapCount is the healthy steady state: scoped/overlay writes are
    // landing without minting new generations.
    readonly inPlacePublishCount: number;
    readonly lastInPlacePublishAtMs: number | null;
    readonly inPlacePublishFallbackCount: number;
    readonly lastInPlaceCheckpointAtMs: number | null;
  };
}

// M4 — the connections WAL now lives beside the PUBLISHED generation
// (`current.<gen>.db-wal`), not a fixed `current.db-wal`. Read the pointer to
// find the live gen; fall back to the legacy path for single-file mode.
const connectionsWalBytes = async (
  vaultRoot: string,
  doubleBuffer?: ConnectionsDoubleBufferHealth,
): Promise<number | null> => {
  const dir = join(vaultRoot, '_BAC', 'connections');
  try {
    const walPath =
      doubleBuffer?.enabled === true && doubleBuffer.generation !== null
        ? join(dir, `current.${doubleBuffer.generation}.db-wal`)
        : join(dir, 'current.db-wal');
    const info = await stat(walPath);
    return info.size;
  } catch {
    // ENOENT (no WAL — the common post-checkpoint case) or any stat error →
    // null (not an error state).
    return null;
  }
};

// M4 — the double-buffer diagnostics the store surfaces (structurally mirrors
// SqliteConnectionsStore.doubleBufferDiagnostics; kept local so this module
// doesn't import the store type into its health builder signature).
export interface ConnectionsDoubleBufferHealth {
  readonly enabled: boolean;
  readonly generation: string | null;
  readonly swapCount: number;
  readonly lastSwapAtMs: number | null;
  readonly residentGenerations: readonly string[];
  readonly lastCheckpointTruncatedPages: number | null;
  readonly lastCheckpointOk: boolean | null;
  readonly lastGcUnlinked: number;
  readonly unchangedPublishSkipCount: number;
  readonly progressCheckpointCount: number;
  readonly lastPublishSkipAtMs: number | null;
  readonly inPlacePublishCount: number;
  readonly lastInPlacePublishAtMs: number | null;
  readonly inPlacePublishFallbackCount: number;
  readonly lastInPlaceCheckpointAtMs: number | null;
}

export const buildReliabilityHealthSection = async (
  vaultRoot: string,
  // M4 — the parent store's live double-buffer diagnostics (generation, swap
  // counts, last checkpoint outcome). Omitted → double-buffer section absent.
  doubleBuffer?: ConnectionsDoubleBufferHealth,
): Promise<ReliabilityHealthSection> => {
  const canary = getResolveCanary(vaultRoot);
  const thresholdMs = resolveCanaryThresholdMs();
  const walBytes = await connectionsWalBytes(vaultRoot, doubleBuffer);
  const doubleBufferSection =
    doubleBuffer !== undefined && doubleBuffer.enabled
      ? {
          connectionsDoubleBuffer: {
            enabled: doubleBuffer.enabled,
            generation: doubleBuffer.generation,
            swapCount: doubleBuffer.swapCount,
            lastSwapAtMs: doubleBuffer.lastSwapAtMs,
            residentGenerations: doubleBuffer.residentGenerations,
            lastCheckpointTruncatedPages: doubleBuffer.lastCheckpointTruncatedPages,
            lastCheckpointOk: doubleBuffer.lastCheckpointOk,
            lastGcUnlinked: doubleBuffer.lastGcUnlinked,
            unchangedPublishSkipCount: doubleBuffer.unchangedPublishSkipCount,
            progressCheckpointCount: doubleBuffer.progressCheckpointCount,
            lastPublishSkipAtMs: doubleBuffer.lastPublishSkipAtMs,
            inPlacePublishCount: doubleBuffer.inPlacePublishCount,
            lastInPlacePublishAtMs: doubleBuffer.lastInPlacePublishAtMs,
            inPlacePublishFallbackCount: doubleBuffer.inPlacePublishFallbackCount,
            lastInPlaceCheckpointAtMs: doubleBuffer.lastInPlaceCheckpointAtMs,
          },
        }
      : {};
  if (canary === undefined) {
    // No canary registered on this path → idle, section available.
    const idleSnapshot = {
      sampleCount: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
      errorCount: 0,
      lastSampleAtMs: null,
      hasTarget: false,
    } as const;
    return {
      resolveCanary: { ...idleSnapshot, status: 'idle' },
      drainDegradation: getDrainDegradation(),
      generationRecovery: getGenerationRecovery(),
      availability: 'ok',
      walBytes,
      ...doubleBufferSection,
    };
  }
  const snapshot = canary.snapshot();
  // idle (no samples) is reported distinctly from ok so the surface can
  // say "no probe yet" vs "probing, healthy".
  const status: 'ok' | 'degraded' | 'idle' =
    snapshot.sampleCount === 0 ? 'idle' : resolveCanaryStatus(snapshot, thresholdMs);
  const availability: SectionAvailability = status === 'degraded' ? 'stale' : 'ok';
  return {
    resolveCanary: { ...snapshot, status },
    drainDegradation: getDrainDegradation(),
    generationRecovery: getGenerationRecovery(),
    availability,
    walBytes,
    ...doubleBufferSection,
  };
};

export const withReliabilityHealthSection = (
  report: HealthReport,
  section: ReliabilityHealthSection,
): HealthReport & { readonly reliability: ReliabilityHealthSection } => {
  const priorObservability = report.observability;
  const priorSections = priorObservability?.sections ?? {};
  const sections: Record<string, SectionAvailability> = {
    ...priorSections,
    reliability: section.availability,
  };
  const next: HealthReport & { readonly reliability: ReliabilityHealthSection } = {
    ...report,
    reliability: section,
    observability: {
      asOf: priorObservability?.asOf ?? new Date().toISOString(),
      status: 'ok',
      sections,
    },
  };
  return {
    ...next,
    observability: {
      ...next.observability!,
      // Recompute from the complete report so replacing a live row can clear
      // its cached failure without hiding an unrelated hard failure.
      status: healthStatusFromReport(next),
    },
  };
};

const OVER_COLLAPSED_PAGE_CONTENT_HYGIENE_CACHE_TTL_MS = 60_000;

let overCollapsedPageContentHygieneCache: {
  readonly vaultRoot: string;
  readonly computedAtMs: number;
  readonly records: readonly OverCollapsedRecord[];
} | null = null;

const scanForOverCollapsedPageContentHygieneCached = async (
  vaultRoot: string,
): Promise<readonly OverCollapsedRecord[]> => {
  const now = Date.now();
  if (
    overCollapsedPageContentHygieneCache !== null &&
    overCollapsedPageContentHygieneCache.vaultRoot === vaultRoot &&
    now - overCollapsedPageContentHygieneCache.computedAtMs <
      OVER_COLLAPSED_PAGE_CONTENT_HYGIENE_CACHE_TTL_MS
  ) {
    return overCollapsedPageContentHygieneCache.records;
  }
  const records = await scanForOverCollapsedPageContent(vaultRoot);
  overCollapsedPageContentHygieneCache = { vaultRoot, computedAtMs: now, records };
  return records;
};

// ---- Non-blocking event-store catch-up (CLASS A) ----------------------
// The first /v1/status after idle used to coincide with a synchronous JSONL
// catch-up (via getCaughtUpSharedEventStore on a resolve/projection route)
// that ran 47s on a 720k-event / 565MB vault and — holding the single Bun
// loop — froze EVERY endpoint (even /v1/version went 2s). Fix: /v1/status
// (and /v1/system/health, which shares the same store) kicks the catch-up in
// the BACKGROUND under a single-flight guard and returns immediately with an
// additive `catchingUp: true` + `lastCatchUpCompletedAt`, never awaiting the
// slow work inline. Subsequent polls return `catchingUp: false` once done.
interface StatusCatchUpState {
  inFlight: Promise<void> | null;
  lastCompletedAtMs: number | null;
  lastError: string | null;
}

const statusCatchUpState: StatusCatchUpState = {
  inFlight: null,
  lastCompletedAtMs: null,
  lastError: null,
};

// Kick a background catch-up if one is not already running. Returns whether a
// catch-up is currently in flight (freshly-kicked or still running). NEVER
// awaits the catch-up — the caller responds immediately.
const kickBackgroundEventStoreCatchUp = (catchUp: () => Promise<void>): boolean => {
  if (statusCatchUpState.inFlight !== null) return true;
  const run = (async (): Promise<void> => {
    try {
      await catchUp();
      statusCatchUpState.lastError = null;
    } catch (err) {
      statusCatchUpState.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      statusCatchUpState.lastCompletedAtMs = Date.now();
      statusCatchUpState.inFlight = null;
    }
  })();
  statusCatchUpState.inFlight = run;
  // Swallow rejections on the retained handle so an unhandled rejection can
  // never crash the loop; errors are captured in lastError above.
  run.catch(() => undefined);
  return true;
};

// Reset hook for deterministic tests (module state persists across a suite).
export const resetStatusCatchUpStateForTest = (): void => {
  statusCatchUpState.inFlight = null;
  statusCatchUpState.lastCompletedAtMs = null;
  statusCatchUpState.lastError = null;
};

const isSelectorCanary = (value: unknown): value is 'ok' | 'warning' | 'failed' =>
  value === 'ok' || value === 'warning' || value === 'failed';

const firstCaptureWarningMessage = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const message = (item as { readonly message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
};

const captureHealthSummary = async (vaultRoot: string): Promise<HealthReport['capture']> => {
  const root = join(vaultRoot, '_BAC', 'events');
  const names = await readdir(root).catch(() => []);
  const last: Record<string, string | null> = {};
  const providerRows = new Map<
    string,
    {
      provider: string;
      lastCaptureAt: string | null;
      lastStatus: 'ok' | 'warning' | 'failed' | null;
      ok24h: number;
      warn24h: number;
      fail24h: number;
      warning?: string;
      lastCaptureTitle?: string;
      lastCaptureThreadId?: string;
    }
  >();
  const recentWarnings: CaptureWarningHealth[] = [];
  const now = Date.now();
  const since24h = now - 24 * 60 * 60 * 1000;
  const since1h = now - 60 * 60 * 1000;
  let window1hCaptures = 0;
  let window1hWarnings = 0;
  let window1hFails = 0;
  for (const name of names
    .filter((candidate) => candidate.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, 14)) {
    const raw = await readFile(join(root, name), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line) as {
          readonly provider?: unknown;
          readonly capturedAt?: unknown;
          readonly selectorCanary?: unknown;
          readonly warnings?: unknown;
          readonly title?: unknown;
          readonly threadId?: unknown;
        };
        if (typeof event.provider === 'string' && typeof event.capturedAt === 'string') {
          const existing = last[event.provider];
          if (existing === undefined || existing === null || existing < event.capturedAt) {
            last[event.provider] = event.capturedAt;
          }
          const current = providerRows.get(event.provider) ?? {
            provider: event.provider,
            lastCaptureAt: null,
            lastStatus: null,
            ok24h: 0,
            warn24h: 0,
            fail24h: 0,
          };
          const selectorCanary = isSelectorCanary(event.selectorCanary)
            ? event.selectorCanary
            : null;
          const capturedMillis = Date.parse(event.capturedAt);
          if (
            !Number.isNaN(capturedMillis) &&
            capturedMillis >= since24h &&
            selectorCanary !== null
          ) {
            if (selectorCanary === 'ok') current.ok24h += 1;
            if (selectorCanary === 'warning') current.warn24h += 1;
            if (selectorCanary === 'failed') current.fail24h += 1;
          }
          if (!Number.isNaN(capturedMillis) && capturedMillis >= since1h) {
            window1hCaptures += 1;
            if (selectorCanary === 'warning') window1hWarnings += 1;
            if (selectorCanary === 'failed') window1hFails += 1;
          }
          if (current.lastCaptureAt === null || current.lastCaptureAt < event.capturedAt) {
            current.lastCaptureAt = event.capturedAt;
            current.lastStatus = selectorCanary;
            if (typeof event.title === 'string' && event.title.length > 0) {
              current.lastCaptureTitle = event.title;
            } else {
              delete current.lastCaptureTitle;
            }
            if (typeof event.threadId === 'string' && event.threadId.length > 0) {
              current.lastCaptureThreadId = event.threadId;
            } else {
              delete current.lastCaptureThreadId;
            }
            const warning = firstCaptureWarningMessage(event.warnings);
            if (warning !== undefined) {
              current.warning = warning;
            } else if (selectorCanary === 'warning') {
              current.warning = 'Selector canary warning.';
            } else if (selectorCanary === 'failed') {
              current.warning = 'Selector canary failed.';
            } else {
              delete current.warning;
            }
          }
          if (selectorCanary === 'warning' || selectorCanary === 'failed') {
            recentWarnings.push({
              provider: event.provider,
              capturedAt: event.capturedAt,
              code: `selector_${selectorCanary}`,
              message:
                selectorCanary === 'failed'
                  ? 'Selector canary failed.'
                  : 'Selector canary warning.',
              severity: 'warning',
            });
          }
          if (Array.isArray(event.warnings)) {
            for (const item of event.warnings) {
              if (typeof item !== 'object' || item === null) continue;
              const warning = item as {
                readonly code?: unknown;
                readonly message?: unknown;
                readonly severity?: unknown;
              };
              if (
                typeof warning.code === 'string' &&
                typeof warning.message === 'string' &&
                (warning.severity === 'info' || warning.severity === 'warning')
              ) {
                recentWarnings.push({
                  provider: event.provider,
                  capturedAt: event.capturedAt,
                  code: warning.code,
                  message: warning.message,
                  severity: warning.severity,
                });
              }
            }
          }
          providerRows.set(event.provider, current);
        }
      } catch {
        // Ignore malformed event-log rows for health reporting.
      }
    }
  }
  return {
    lastByProvider: last,
    queueDepthHint: null,
    droppedHint: null,
    providers: [...providerRows.values()].sort((left, right) =>
      (right.lastCaptureAt ?? '').localeCompare(left.lastCaptureAt ?? ''),
    ),
    recentWarnings: recentWarnings
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, 10),
    window1h: {
      captures: window1hCaptures,
      warnings: window1hWarnings,
      fails: window1hFails,
    },
  };
};

// The data-loss row is deliberately collected outside the 60s base-report
// cache. These are indexed O(1) reads against the shared store, so every health
// poll can observe a clean current reconciliation and decay an old warning
// without re-running the expensive vault/work-graph collectors.
const storeReconciliationForVault = async (
  vaultRoot: string,
): Promise<DataLossHealth['reconciliation']> => {
  const store = await getSharedEventStore(vaultRoot);
  if (store === null) return null;
  const storeRowCount = store.count();
  const expectedFromWatermark = store.expectedRetainedCount();
  return {
    storeRowCount,
    expectedFromWatermark,
    delta: expectedFromWatermark - storeRowCount,
  };
};

const LIVE_DATA_LOSS_BUDGET_MS = 1_000;

const collectLiveDataLoss = async (vaultRoot: string): Promise<DataLossHealth> => {
  const counters = getEventLaneHealth();
  const unavailable = Symbol('data-loss-reconciliation-unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof unavailable>((resolve) => {
      timer = setTimeout(() => resolve(unavailable), LIVE_DATA_LOSS_BUDGET_MS);
      timer.unref?.();
    });
    const reconciliation = await Promise.race([storeReconciliationForVault(vaultRoot), timeout]);
    return reconciliation === unavailable
      ? deriveDataLossHealth({
          counters,
          reconciliation: null,
          reconciliationUnavailable: true,
        })
      : deriveDataLossHealth({ counters, reconciliation });
  } catch {
    return deriveDataLossHealth({
      counters,
      reconciliation: null,
      reconciliationUnavailable: true,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const watchdogAvailability = (status: WatchdogStatus): SectionAvailability =>
  status === 'ok' ? 'ok' : status === 'warning' ? 'stale' : 'unavailable';

const withResourceReadinessWatchdogs = (
  report: HealthReport,
  watchdogs: ResourceReadinessWatchdogs,
): HealthReport & { readonly watchdogs: ResourceReadinessWatchdogs } => {
  const priorObservability = report.observability;
  const next: HealthReport & { readonly watchdogs: ResourceReadinessWatchdogs } = {
    ...report,
    watchdogs,
    observability: {
      asOf: priorObservability?.asOf ?? new Date().toISOString(),
      status: 'ok',
      sections: {
        ...(priorObservability?.sections ?? {}),
        rss: watchdogAvailability(watchdogs.rss.status),
        bootToServing: watchdogAvailability(watchdogs.bootToServing.status),
      },
    },
  };
  return {
    ...next,
    observability: {
      ...next.observability!,
      status: healthStatusFromReport(next),
    },
  };
};

// ---- /v1/system/health contributor registry -----------------------------
//
// GET /v1/system/health assembles its `data` object from this ordered,
// named list instead of inline in the route handler below. Each entry
// contributes one (or one small group of) top-level `data` key(s); the
// handler folds every entry's result into `data` via Object.assign, IN
// ARRAY ORDER. Object.assign preserves the exact insertion-order semantics
// the old object-spread chain had: a key an entry re-touches (`reliability`
// below overwrites `observability`) keeps its ORIGINAL position, while a
// brand-new key is appended at the end.
//
// Entries run SEQUENTIALLY — never Promise.all'd — because `reliability`
// reads `scratch.baseReport`, state the `baseReport` entry ahead of it
// writes. Any future entry that reads state an earlier entry computes must
// stay ordered after that entry, for the same reason.
//
// To add a new health key `foo`: append ONE entry to this array that
// computes and returns `{ foo: ... }` (or `{}` when it can't be computed —
// typed emptiness, never a fabricated value). Nothing else in the route
// handler changes.
interface HealthContributorScratch {
  // Written by the `baseReport` entry; read by `reliability` to fold its
  // section into `observability` in place.
  baseReport?: HealthReport;
}

interface HealthContributorArgs {
  readonly context: CompanionHttpConfig;
  readonly vaultRoot: string;
  readonly scratch: HealthContributorScratch;
}

interface HealthContributor {
  readonly name: string;
  readonly contribute: (args: HealthContributorArgs) => Promise<Record<string, unknown>>;
}

const healthContributors: readonly HealthContributor[] = [
  {
    name: 'baseReport',
    // Fold the resolve-canary reliability section into the health
    // response. The base report is served from the TTL'd cache; the
    // reliability section (the next entry) reads the (cheap) canary
    // snapshot + WAL stat live so it decays on its own window rather
    // than the health TTL.
    contribute: async ({ context, vaultRoot, scratch }) => {
      const indexPath = recallIndexPath(vaultRoot);
      const baseReport = await cachedCollectHealth(vaultRoot, () =>
        collectHealth({
          startedAt: context.startedAt ?? new Date(),
          vaultRoot,
          vaultWritable: async () => {
            try {
              await access(vaultRoot);
              return true;
            } catch {
              return false;
            }
          },
          vaultSizeBytes: () => directorySize(join(vaultRoot, '_BAC')).catch(() => null),
          captureSummary: () => captureHealthSummary(vaultRoot),
          recallSummary: async () => {
            // Recall serves from recall-v2 (sqlite-vec). The legacy
            // index.bin is deprecated; reading + parsing it here (24MB)
            // was both wrong and SLOW — it timed out this probe under
            // load, surfacing as a permanent false "degraded". Use a
            // cheap v2 sqlite stat + (when the store is already open)
            // its doc count, so the probe is fast and reflects the
            // actually-served backend.
            const { peekRecallV2Store } = await import('../../recall-v2/pipeline.js');
            const v2SqlitePath = join(vaultRoot, '_BAC', 'recall', 'v2', 'index.sqlite');
            const [info, modelStatus, v2Store, v2Stat] = await Promise.all([
              stat(indexPath).catch(() => undefined),
              getModelCacheStatus().catch(() => undefined),
              peekRecallV2Store(vaultRoot).catch(() => undefined),
              stat(v2SqlitePath).catch(() => undefined),
            ]);
            const v2DocCount = v2Store !== undefined ? v2Store.documentCount() : null;
            const v2Present =
              (v2DocCount !== null && v2DocCount > 0) || (v2Stat !== undefined && v2Stat.size > 0);
            // The legacy recall-lifecycle report runs countTurnsInEventLog
            // — a FULL scan of the entire event store that blew the 5s
            // health budget on a real-size vault (the ~5.0s /v1/system/health
            // wall). It's vestigial once v2 (sqlite-vec) is the served
            // backend (status is already reported 'ready' from v2 below),
            // so only pay the scan on a legacy non-v2 vault that still
            // depends on those drift fields.
            const lifecycleReport = v2Present
              ? undefined
              : await (context.recallLifecycle?.report() ?? Promise.resolve(undefined));
            const indexExists = v2Present;
            return {
              indexExists,
              entryCount: v2DocCount,
              modelId: modelStatus?.modelId ?? null,
              sizeBytes: v2Stat?.size ?? info?.size ?? null,
              semanticRecallPoolMigration: getSemanticRecallPoolMigrationStatus(),
              // Lifecycle fields are optional so legacy callers
              // (no recallLifecycle injected) keep the old shape.
              ...(lifecycleReport === undefined
                ? {}
                : {
                    status: lifecycleReport.status,
                    eventTurnCount: lifecycleReport.eventTurnCount,
                    currentModelId: lifecycleReport.currentModelId,
                    companionVersion: lifecycleReport.companionVersion,
                    lastRebuildAt: lifecycleReport.lastRebuildAt,
                    lastRebuildIndexed: lifecycleReport.lastRebuildIndexed,
                    lastError: lifecycleReport.lastError,
                    rebuildEmbedded: lifecycleReport.rebuildEmbedded,
                    rebuildTotal: lifecycleReport.rebuildTotal,
                    rebuildPhase: lifecycleReport.rebuildPhase,
                    embedderDevice: lifecycleReport.embedderDevice,
                    embedderAccelerator: lifecycleReport.embedderAccelerator,
                    drift: lifecycleReport.drift,
                  }),
              // recall-v2 is the served backend; when it's present,
              // recall is ready regardless of the deprecated legacy
              // lifecycle's status (which would otherwise force a false
              // "degraded" on a v2-only vault).
              ...(v2Present ? { status: 'ready' as const } : {}),
              ...(context.recallActivity === undefined
                ? {}
                : { activity: context.recallActivity.report() }),
              ...(modelStatus === undefined
                ? {}
                : {
                    model: {
                      id: modelStatus.modelId,
                      revision: modelStatus.revision,
                      cacheDir: modelStatus.cacheDir,
                      present: modelStatus.present,
                      verified: modelStatus.verified,
                      offline: modelStatus.offline,
                    },
                  }),
            };
          },
          serviceStatus: async () => {
            // `installed` still comes from the installer (plist/unit
            // existence), which is what "installed" honestly means.
            // `running`, however, must reflect ACTUAL process
            // liveness — the installer inferred it from plist
            // existence, so a crashed-but-installed service read as
            // "running" forever. Probe real liveness (launchctl /
            // systemctl); only when the probe is `unknown` (tool
            // absent / timed out) do we fall back to the installer's
            // heuristic rather than claim a false negative.
            const status = await (context.serviceInstaller ?? pickInstaller()).status();
            const liveness = await (
              context.serviceLiveness ?? (() => probeServiceLiveness(process.platform))
            )();
            return {
              installed: status.installed,
              running: resolveServiceRunning(status.running, liveness),
            };
          },
          // dataLoss is replaced by the live `dataLossCurrent` contributor
          // below. Do not duplicate its indexed reconciliation reads inside
          // this TTL'd base collect.
          // Engagement-lane freshness — two indexed MAX queries on
          // the shared store; observability only (aggregate-vs-interval
          // divergence, the fingerprint of the 06-27 regression that
          // starved visit similarity). Best-effort inside collectHealth.
          engagementLaneHealth: () => collectEngagementLaneHealth({ vaultRoot }),
          ...(context.rankerHealth === undefined ? {} : { rankerHealth: context.rankerHealth }),
          ...(context.mcpChildHealth === undefined
            ? {}
            : { mcpChildHealth: context.mcpChildHealth }),
          workGraphSummary: async () => {
            // Drain-time artifact first: the connections drain
            // materializes workgraph-health.json after every
            // successful pass (runtime/companion.ts onDrainSuccess),
            // keeping the cold-boot path off the heavy live collect
            // that used to blow the 5s budget and pin the section
            // on 'unavailable'. The serve gate is symmetric with
            // the writer's (eventStoreEnabled) AND age-bounded:
            // the writer only refreshes while the event store is
            // on, so a restart without SIDETRACK_EVENT_STORE=1
            // would otherwise serve a frozen snapshot forever —
            // drains succeed, the hook no-ops, sync.materializers
            // stays green, and nothing surfaces the staleness.
            // Missing/corrupt/schema-mismatched/stale ⇒ live
            // compute below, unchanged.
            if (eventStoreEnabled()) {
              const artifact = await readWorkGraphHealthArtifact(vaultRoot);
              if (artifact !== null && isWorkGraphHealthArtifactFresh(artifact)) {
                // The drain-time artifact froze shipGateV2.servingGateEnforced
                // + shadowDiff at drain time (before requests ran / under a
                // stale env). Overlay the LIVE enforcement flag + the
                // in-process shadow-diff window so the served surface
                // reflects the current serving decision and measurement.
                return withLiveShipGateV2Serving(artifact.report, vaultRoot);
              }
            }
            // Phase 4 — peek the canonical SQLite recall store so
            // health reports live document/chunk vector counts.
            // Non-blocking: returns undefined when the store
            // hasn't been opened yet (no /v2/recall fired since
            // companion start), in which case counts default to 0.
            const { peekRecallV2Store } = await import('../../recall-v2/pipeline.js');
            const canonicalRecallStore = await peekRecallV2Store(vaultRoot);
            return collectWorkGraphHealth({
              vaultRoot,
              ...(context.eventLog === undefined ? {} : { eventLog: context.eventLog }),
              ...(context.connectionsDiagnostics === undefined
                ? {}
                : { connectionsDiagnostics: context.connectionsDiagnostics }),
              ...(canonicalRecallStore === undefined ? {} : { canonicalRecallStore }),
            });
          },
          ...syncSummaryDeps(context.replica, context.sync, context.syncMaterializerHealth),
        }),
      );
      scratch.baseReport = baseReport;
      // HealthReport has no index signature, so it needs an explicit (safe:
      // every field is data) cast to the registry's key-bag return type.
      return baseReport as unknown as Record<string, unknown>;
    },
  },
  {
    name: 'reliability',
    contribute: async ({ context, vaultRoot, scratch }) => {
      const doubleBufferHealth =
        context.connectionsStore instanceof SqliteConnectionsStore
          ? context.connectionsStore.doubleBufferDiagnostics()
          : undefined;
      const reliability = await buildReliabilityHealthSection(vaultRoot, doubleBufferHealth);
      if (scratch.baseReport === undefined) {
        // Registry order guarantees the `baseReport` entry above already
        // ran (and populated this) by the time this entry executes.
        throw new Error('health contributor order violated: baseReport missing');
      }
      const report = withReliabilityHealthSection(scratch.baseReport, reliability);
      scratch.baseReport = report;
      return report as unknown as Record<string, unknown>;
    },
  },
  {
    name: 'dataLossCurrent',
    // The base report is TTL'd because most of its collectors are expensive.
    // dataLoss is not: cumulative counters + indexed reconciliation queries
    // are cheap, and recovery must not sit behind a cached warning. Re-touch
    // the existing key and observability row live on every health read.
    contribute: async ({ vaultRoot, scratch }) => {
      if (scratch.baseReport === undefined) {
        throw new Error('health contributor order violated: baseReport missing');
      }
      const report = withCurrentDataLossHealth(
        scratch.baseReport,
        await collectLiveDataLoss(vaultRoot),
      );
      scratch.baseReport = report;
      return report as unknown as Record<string, unknown>;
    },
  },
  {
    name: 'resourceReadinessWatchdogs',
    // One synchronous RSS read plus already-recorded boot timings. No timer,
    // vault scan, child query, or awaited I/O is allowed in this contributor.
    contribute: async ({ context, scratch }) => {
      if (context.getResourceReadinessWatchdogs === undefined) return {};
      if (scratch.baseReport === undefined) {
        throw new Error('health contributor order violated: baseReport missing');
      }
      let watchdogs: ResourceReadinessWatchdogs;
      try {
        watchdogs = context.getResourceReadinessWatchdogs();
      } catch {
        // A diagnostic getter must never take down the health endpoint. The
        // watchdog itself reports recoverable RSS read failures as `stale`;
        // this catch is only for an unexpected integration bug.
        return {};
      }
      const report = withResourceReadinessWatchdogs(scratch.baseReport, watchdogs);
      scratch.baseReport = report;
      return report as unknown as Record<string, unknown>;
    },
  },
  {
    name: 'laneCalibration',
    // LANE CALIBRATION (review E1). Per-lane measured precision@1 over the
    // trailing prequential window — the number that decides whether lane
    // agreement is allowed to count as corroboration, and the first honest
    // answer this system has ever had to "how good is the content lane?".
    //
    // Read live (outside the health TTL) for the same reason `reliability`
    // is: it decays on its own window and is memoized on the prediction
    // files' size+mtime, so a warm read is two stats. Best-effort — a
    // measurement must never be able to degrade the health probe it rides
    // on.
    contribute: async ({ vaultRoot }) => {
      const laneCalibration = await lanePrequentialSummary(vaultRoot).catch(() => null);
      // Additive, read-only. Omitted entirely (rather than sent as a
      // fake zero) when the summary could not be computed — typed
      // emptiness, not a fabricated measurement.
      return laneCalibration === null ? {} : { laneCalibration };
    },
  },
  {
    name: 'vaultLedger',
    // VAULT LEDGER SUMMARY. Which families own the disk, and the orphaned-
    // generation counter (the P0: three ~323 MB abandoned generation dbs
    // sat resident while the only storage surface reported 10.7 MB). Read
    // from the SAME TTL cache the /v1/system/vault-ledger route uses —
    // never a walk on this path — and omitted entirely rather than faked
    // when the first walk has not landed or the flag is off.
    contribute: async ({ vaultRoot }) => {
      const vaultLedgerCache = await vaultLedgerCached(vaultRoot).catch(() => null);
      const vaultLedger =
        vaultLedgerCache === null ||
        vaultLedgerCache.value === null ||
        (vaultLedgerCache.availability !== 'ok' && vaultLedgerCache.availability !== 'stale')
          ? null
          : summarizeVaultLedger(vaultLedgerCache.value, vaultLedgerCache.availability);
      return vaultLedger === null ? {} : { vaultLedger };
    },
  },
];
// NOTE: the companion no longer hosts a node-runtime title-synthesis
// generation lane (onnxruntime-node q4 unsupported / int8 unusable —
// measured). Generation now runs in the extension panel via WebGPU
// (transformers.js + the companion-cached gemma-3-1b q4), which POSTs
// synthesized titles/gists to /v1/enrichment/{titles,content}. The
// companion's role is MODEL HOST (/v1/models/...) + enrichment store, so
// there is no sweep singleton to surface on health here — no corresponding
// contributor above.

export const systemRoutesA: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    authRequired: false,
    handle: (_request, requestId) => Promise.resolve([200, { status: 'ok', requestId }]),
  },
  {
    // Minimal version/identity probe. Two consumers:
    //  - the attach-diagnostic (detect a stale companion: extension
    //    rebuilt but companion still on the prior build);
    //  - the extension's connection identity check — it pins
    //    {vaultRoot, codePath} on first attach and compares on every
    //    poll, so a port reused by a DIFFERENT companion (a common
    //    dogfood foot-gun: a test instance and the daily instance
    //    both want :17373) surfaces instead of silently serving the
    //    wrong vault.
    // Returns companion-controlled fields only; no auth needed
    // because the information leak is harmless (all local).
    method: 'GET',
    pattern: /^\/v1\/version$/,
    authRequired: false,
    handle: (_request, requestId, _match, context) =>
      Promise.resolve([
        200,
        {
          data: {
            companionVersion: COMPANION_VERSION,
            ...(context.vaultRoot === undefined ? {} : { vaultRoot: context.vaultRoot }),
            ...(context.startedAt === undefined
              ? {}
              : { startedAt: context.startedAt.toISOString() }),
            // codePath: the absolute path of the running entry script
            // (`dist/cli.js`). Directly answers "which checkout is
            // this companion built from" — the field the extension
            // compares to catch a build/checkout swap on a reused
            // port. process.argv[1] is the entry script; absent only
            // in exotic embeddings (then the field is just omitted).
            ...(typeof process.argv[1] === 'string' && process.argv[1].length > 0
              ? { codePath: process.argv[1] }
              : {}),
            // pid distinguishes restarts of the same companion from a
            // genuinely different process on the port.
            pid: process.pid,
            // instanceLabel: free-form operator tag via
            // SIDETRACK_INSTANCE_LABEL (e.g. "test" vs "daily"). Lets
            // the extension show, and the operator eyeball, which
            // instance is answering.
            ...(typeof process.env['SIDETRACK_INSTANCE_LABEL'] === 'string' &&
            process.env['SIDETRACK_INSTANCE_LABEL'].length > 0
              ? { instanceLabel: process.env['SIDETRACK_INSTANCE_LABEL'] }
              : {}),
            // gitSha is best-effort: it's set when the CLI is invoked
            // with --git-sha or with the SIDETRACK_COMPANION_GIT_SHA
            // env var. Absent in normal `bun dist/cli.js` runs.
            ...(typeof process.env['SIDETRACK_COMPANION_GIT_SHA'] === 'string' &&
            process.env['SIDETRACK_COMPANION_GIT_SHA'].length > 0
              ? { gitSha: process.env['SIDETRACK_COMPANION_GIT_SHA'] }
              : {}),
            // buildSha/buildTime/buildBranch: dist build provenance
            // stamped by scripts/stamp-build.mjs into
            // dist/BUILD_INFO.json at build time. Unlike gitSha (which
            // needs an explicit env/flag at launch), these are baked
            // into dist itself, so they answer "which build is this
            // dist" even for a plain `bun dist/cli.js` run. Always
            // present as fields; null when the artifact is absent
            // (e.g. a raw tsc-only build) so consumers can rely on the
            // keys existing. buildSha vs the current checkout is the
            // stale-dist signal the menu-bar app surfaces.
            ...readBuildInfo(),
            requestId,
          },
        },
      ]),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/status$/,
    authRequired: true,
    handle: async (_request, requestId, _match, context) => {
      // /v1/status is the **liveness + cached-readiness** probe the
      // side panel polls every 15s. It MUST:
      //   - Return immediately even if the materializer is in the
      //     middle of catchUp, the recall index is rebuilding, or
      //     the ONNX embedder hasn't been initialised yet.
      //   - Never trigger a rebuild, a model load, an embedder
      //     warmup, or an unbounded `waitForRebuild()` call.
      //   - Never transitively import recall/ingestor/embedder/
      //     transformers/ONNX. The only allowed dependencies are
      //     synchronous getters on the runtime context.
      // The response shape reports subsystem state as data; the
      // request itself does no work to make any subsystem ready.
      //
      // When the companion manages an MCP child, probe its /mcp
      // endpoint so the side panel knows whether restart/config
      // changes succeeded. Distinguishes three states the user
      // cares about:
      //   reachable=false                    — process not listening
      //   reachable=true, authAccepted=false — listening but our
      //                                        auth key is stale
      //   reachable=true, authAccepted=true  — fully healthy
      // Probe is a TCP-cheap GET with a 1s timeout — slow enough
      // to detect a wedged process, fast enough to not stall
      // /v1/status during normal polling.
      let mcpHealth:
        | {
            reachable: boolean;
            authAccepted: boolean;
            status: 'ok' | 'auth_failed' | 'unreachable';
            checkedAt: string;
            detail?: string;
          }
        | undefined;
      if (context.mcp !== undefined) {
        const checkedAt = new Date().toISOString();
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, 1000);
        try {
          const probe = await fetch(`http://127.0.0.1:${String(context.mcp.port)}/mcp`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${context.mcp.authKey}` },
            signal: controller.signal,
          });
          // 401 means a process is listening but doesn't accept
          // our key — surface as auth_failed so the side panel
          // can prompt the user to regenerate or re-paste.
          // Anything else that completed the round-trip counts as
          // ok; the MCP server returns 400 or 405 for the bare
          // GET, which still proves auth was accepted.
          if (probe.status === 401 || probe.status === 403) {
            mcpHealth = {
              reachable: true,
              authAccepted: false,
              status: 'auth_failed',
              checkedAt,
              detail: `http ${String(probe.status)}`,
            };
          } else {
            mcpHealth = {
              reachable: true,
              authAccepted: true,
              status: 'ok',
              checkedAt,
              detail: `http ${String(probe.status)}`,
            };
          }
        } catch (error) {
          mcpHealth = {
            reachable: false,
            authAccepted: false,
            status: 'unreachable',
            checkedAt,
            detail: error instanceof Error ? error.message : String(error),
          };
        } finally {
          clearTimeout(timer);
        }
      }
      // Live relay status for the side panel banner. Only present
      // when the companion was started with --sync-relay/-local
      // AND the runtime exposed a getRelayStatus closure. Routed
      // through /v1/status (not /v1/system/health) because the
      // extension polls /v1/status on every reachability check;
      // adding it there means the relay-down banner can flip the
      // moment the WS dies, with no extra HTTP round-trip.
      const relayLive = context.sync?.getRelayStatus?.() ?? null;
      const relayBlock =
        context.sync?.relay === undefined
          ? undefined
          : {
              ...context.sync.relay,
              ...(relayLive === null
                ? {}
                : {
                    connected: relayLive.connected,
                    consecutiveFailures: relayLive.consecutiveFailures,
                    pendingPublishes: relayLive.pendingPublishes,
                    ...(relayLive.lastConnectedAtMs === undefined
                      ? {}
                      : { lastConnectedAtMs: relayLive.lastConnectedAtMs }),
                    ...(relayLive.lastDisconnectedAtMs === undefined
                      ? {}
                      : { lastDisconnectedAtMs: relayLive.lastDisconnectedAtMs }),
                    // Peer-event throughput counters mirrored from
                    // /v1/system/health.sync — the side panel polls
                    // /v1/status frequently for reachability, so
                    // surfacing them here too means the throughput
                    // chips can update at the same cadence.
                    ...(relayLive.eventsIn === undefined ? {} : { eventsIn: relayLive.eventsIn }),
                    ...(relayLive.eventsOut === undefined
                      ? {}
                      : { eventsOut: relayLive.eventsOut }),
                    ...(relayLive.lastInboundAtMs === undefined
                      ? {}
                      : { lastInboundAtMs: relayLive.lastInboundAtMs }),
                    ...(relayLive.lastOutboundAtMs === undefined
                      ? {}
                      : { lastOutboundAtMs: relayLive.lastOutboundAtMs }),
                    ...(relayLive.byReplica === undefined
                      ? {}
                      : { byReplica: relayLive.byReplica }),
                  }),
            };
      // ---- cached subsystem state — no work allowed ----
      // Snapshot state: the connections snapshot store's last
      // committed revision. Read once, no rebuild trigger.
      //
      // CRITICAL — short timeout (500ms) on the SQLite read:
      //   bun:sqlite serializes queries on a single DB handle. If
      //   another caller is mid-`readCurrent()` (which can take 30+s
      //   on a 12k-edge snapshot — see materializer perf debt), the
      //   /status query queues behind it. The 45s extension timeout
      //   then fires and the side panel flips to "disconnected"
      //   even though the companion is reachable. The /status
      //   contract says "MUST return immediately even if the
      //   materializer is mid-catchUp" — honor that by reporting
      //   `state: 'busy'` instead of waiting on the metadata read.
      let snapshotState:
        | {
            readonly state: 'missing' | 'ready' | 'busy';
            readonly revision?: string;
            readonly updatedAt?: string;
          }
        | undefined;
      if (context.connectionsStore !== undefined) {
        try {
          const SNAPSHOT_PROBE_TIMEOUT_MS = 500;
          const readPromise =
            context.connectionsStore instanceof SqliteConnectionsStore
              ? context.connectionsStore.readSnapshotMetadata()
              : context.connectionsStore.readCurrent();
          const timeoutSentinel: unique symbol = Symbol('snapshot-probe-timeout');
          const current = (await Promise.race([
            readPromise,
            new Promise((resolve) =>
              setTimeout(() => resolve(timeoutSentinel), SNAPSHOT_PROBE_TIMEOUT_MS),
            ),
          ])) as Awaited<typeof readPromise> | typeof timeoutSentinel;
          if (current === timeoutSentinel) {
            // DB handle contended — caller (likely /v1/connections
            // doing a snapshot rebuild) has the lock. Don't block
            // /status; the side panel polls again in 15 s.
            snapshotState = { state: 'busy' };
          } else if (current === null) {
            snapshotState = { state: 'missing' };
          } else {
            snapshotState = {
              state: 'ready',
              ...(current.snapshotRevision === undefined
                ? {}
                : { revision: current.snapshotRevision }),
              updatedAt: current.updatedAt,
            };
          }
        } catch {
          snapshotState = { state: 'missing' };
        }
      }
      // Recall state — uses `isRebuilding()` (sync) only. Calling
      // `report()` here would read the index file (fast) but adds
      // I/O latency; `/v1/system/health` already exposes the rich
      // report for callers that want it. /status reports just the
      // coarse state so the panel can render "warming" vs "ready".
      const embedderStatus = context.getEmbedderStatus?.() ?? { state: 'disabled' as const };
      let recallState:
        | {
            readonly state: 'disabled' | 'rebuilding' | 'ready';
            readonly vectorState: 'disabled' | 'cold' | 'warming' | 'ready' | 'failed';
            readonly vectorError?: string;
            readonly semanticRecallPoolMigration: ReturnType<
              typeof getSemanticRecallPoolMigrationStatus
            >;
          }
        | undefined;
      if (context.recallLifecycle !== undefined) {
        recallState = {
          state: context.recallLifecycle.isRebuilding() ? 'rebuilding' : 'ready',
          vectorState: embedderStatus.state,
          ...(embedderStatus.lastError === undefined
            ? {}
            : { vectorError: embedderStatus.lastError }),
          semanticRecallPoolMigration: getSemanticRecallPoolMigrationStatus(),
        };
      } else {
        recallState = {
          state: 'disabled',
          vectorState: embedderStatus.state,
          semanticRecallPoolMigration: getSemanticRecallPoolMigrationStatus(),
        };
      }
      // Materializer state — cached health snapshot (sync).
      const materializerHealth = context.syncMaterializerHealth?.() ?? undefined;
      const materializerState =
        materializerHealth === undefined
          ? undefined
          : {
              state: Object.values(materializerHealth).some((h) => h.status === 'failed')
                ? 'failed'
                : Object.values(materializerHealth).some((h) => h.pending)
                  ? 'catching_up'
                  : 'idle',
              detail: materializerHealth,
            };
      const eventLoopState = context.getEventLoopSnapshot?.();
      const pageEvidenceEmbedLane = context.getBackgroundEmbeddingLaneHealth?.();
      const bodyEvidenceLane = context.getBodyEvidenceLaneHealth?.();
      // Non-blocking event-store catch-up (CLASS A). Kick it in the BACKGROUND
      // (single-flight) and report `catchingUp` — never await the potentially
      // 40s+ JSONL catch-up inline, which would freeze the loop for every
      // endpoint. When the runtime wires no catch-up hook the field is absent.
      const catchingUp =
        context.eventStoreCatchUp === undefined
          ? undefined
          : kickBackgroundEventStoreCatchUp(context.eventStoreCatchUp);
      return [
        200,
        {
          data: {
            companion: 'running',
            vault: await context.vaultWriter.status(),
            api: { live: true },
            ...(catchingUp === undefined
              ? {}
              : {
                  catchingUp,
                  ...(statusCatchUpState.lastCompletedAtMs === null
                    ? {}
                    : {
                        lastCatchUpCompletedAt: new Date(
                          statusCatchUpState.lastCompletedAtMs,
                        ).toISOString(),
                      }),
                }),
            ...(snapshotState === undefined ? {} : { snapshot: snapshotState }),
            ...(recallState === undefined ? {} : { recall: recallState }),
            ...(materializerState === undefined ? {} : { materializer: materializerState }),
            ...(eventLoopState === undefined ? {} : { eventLoop: eventLoopState }),
            ...(pageEvidenceEmbedLane === undefined ? {} : { pageEvidenceEmbedLane }),
            ...(bodyEvidenceLane === undefined ? {} : { bodyEvidenceLane }),
            ...(context.vaultChanges === undefined
              ? {}
              : { vaultChangeSubscribers: context.vaultChanges.subscriberCount() }),
            // P1-review: vaultRoot lets the side panel build Codex
            // MCP config snippets without asking the user to paste
            // the absolute vault path. Only included when the
            // companion was started with one (test mode passes
            // undefined).
            ...(context.vaultRoot === undefined ? {} : { vaultRoot: context.vaultRoot }),
            ...(context.mcp === undefined
              ? {}
              : {
                  mcp: {
                    port: context.mcp.port,
                    authKey: context.mcp.authKey,
                    url: `http://127.0.0.1:${String(context.mcp.port)}/mcp`,
                    ...(mcpHealth === undefined ? {} : { health: mcpHealth }),
                  },
                }),
            ...(relayBlock === undefined ? {} : { sync: { relay: relayBlock } }),
            requestId,
          },
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/vault\/changes$/,
    authRequired: true,
    handle: () => Promise.resolve([500, { data: { error: 'stream route was not intercepted' } }]),
  },
];

export const systemRoutesB: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/system\/service-status$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { data: await (context.serviceInstaller ?? pickInstaller()).status() },
    ],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/system\/install-service$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      {
        data: await (context.serviceInstaller ?? pickInstaller()).install(
          buildServiceInstallOptions(context),
        ),
      },
    ],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/system\/uninstall-service$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const installer = context.serviceInstaller ?? pickInstaller();
      await installer.uninstall();
      return [200, { data: await installer.status() }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/system\/update-check$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { data: await (context.updateChecker ?? (() => checkLatestVersion('0.0.0')))() },
    ],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/system\/auto-update$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.allowAutoUpdate !== true) {
        throw new HttpRouteError(
          403,
          'AUTO_UPDATE_DISABLED',
          'Auto-update is disabled.',
          'Start the companion with --allow-auto-update before invoking this endpoint.',
        );
      }
      const input = autoUpdateSchema.parse(await readBody(request));
      return [
        200,
        {
          data: await runAutoUpdate({
            confirm: input.confirm,
            currentVersion: '0.0.0',
          }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/system\/health$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      // Fold the registered contributors (defined above, ahead of
      // systemRoutesA) into `data` IN ORDER. See the registry comment for
      // why order is fixed and how a new health key is added.
      const scratch: HealthContributorScratch = {};
      const data: Record<string, unknown> = {};
      for (const { contribute } of healthContributors) {
        Object.assign(data, await contribute({ context, vaultRoot, scratch }));
      }
      return [200, { data }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/system\/hygiene-status$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      // GC inventory walks thousands of derived files — too slow for a
      // synchronous request on a real vault. Served from a TTL'd
      // background-refreshed cache (follow-up #15): O(1) here, the walk
      // happens off the request. Honest tri-state: unavailable until the
      // first compute lands, stale while refreshing an expired entry, ok
      // when fresh. pageContent counts are cheap → keep the inline
      // budget guard so a slow disk still degrades honestly (plan X1).
      const budget = async <T>(
        op: () => Promise<T>,
        ms: number,
      ): Promise<{ value: T | null; availability: 'ok' | 'unavailable' }> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            op().then((value) => ({ value, availability: 'ok' as const })),
            new Promise<{ value: null; availability: 'unavailable' }>((resolve) => {
              timer = setTimeout(() => {
                resolve({ value: null, availability: 'unavailable' });
              }, ms);
            }),
          ]);
        } catch {
          return { value: null, availability: 'unavailable' };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      const [gc, pageContent, overCollapsedRecords] = await Promise.all([
        gcInventoryCached(vaultRoot),
        budget(() => pageContentCoverageCounts(vaultRoot), 4_000),
        budget(() => scanForOverCollapsedPageContentHygieneCached(vaultRoot), 4_000),
      ]);
      return [
        200,
        {
          data: {
            ...(context.hygieneStatus ?? {}),
            asOf: new Date().toISOString(),
            availability: {
              gc: gc.availability,
              pageContent: pageContent.availability,
              overCollapsedRecords: overCollapsedRecords.availability,
            },
            gcAsOf: gc.asOf,
            gc: gc.value,
            pageContent: pageContent.value,
            overCollapsedRecords:
              overCollapsedRecords.value === null
                ? null
                : {
                    count: overCollapsedRecords.value.length,
                    samples: overCollapsedRecords.value.slice(0, 5),
                  },
          },
        },
      ];
    },
  },
  {
    // THE VAULT LEDGER. Every byte under `_BAC`, classified, reconciling to the
    // on-disk total — the answer `/v1/system/hygiene-status` structurally
    // cannot give (it reports the GC *plan*, which on the live vault was 10.7
    // MB of 3.02 GB). Read-only: no delete affordance in this landing.
    //
    // Served from the same TTL'd background-refreshed cache idiom as the
    // hygiene sibling: the walk is ~5.6k stats plus a sampled log read (190ms
    // measured on the live vault) and must not sit on a request. O(1) here.
    // `disabled` is a distinct availability from `unavailable` — an operator who
    // set SIDETRACK_VAULT_LEDGER=0 must not read that as a broken walk.
    method: 'GET',
    pattern: /^\/v1\/system\/vault-ledger$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const ledger = await vaultLedgerCached(vaultRoot);
      return [
        200,
        {
          data: {
            asOf: ledger.asOf,
            availability: ledger.availability,
            // Typed emptiness: `null` is "not computed yet / disabled", never
            // an empty vault. The availability field says which.
            ledger: ledger.value,
          },
        },
      ];
    },
  },
  {
    // Plan TODO-H4: Focus surface. Serves the pre-digested
    // diagnostics/latest.json (O(1) file read — the materializer
    // already writes it every drain) plus an optional ?history=N
    // window from the dumb ring buffer. Never scans diagnostics/history.
    method: 'GET',
    pattern: /^\/v1\/system\/focus-health$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/v1/system/focus-health', 'http://internal');
      const historyRaw = url.searchParams.get('history');
      const historyN =
        historyRaw === null ? 0 : Math.max(0, Math.min(96, Number.parseInt(historyRaw, 10) || 0));
      const latestPath = join(vaultRoot, '_BAC/connections/diagnostics/latest.json');
      let digest: unknown = null;
      let availability: 'ok' | 'unavailable' = 'unavailable';
      let asOf: string | null = null;
      try {
        const parsed = JSON.parse(await readFile(latestPath, 'utf8')) as {
          readonly producedAt?: unknown;
        };
        digest = parsed;
        availability = 'ok';
        asOf = typeof parsed.producedAt === 'string' ? parsed.producedAt : null;
      } catch {
        // Missing/corrupt digest → honest "unavailable", not a faked
        // healthy empty (plan X1).
        availability = 'unavailable';
      }
      const history = historyN > 0 ? await readHealthHistory(vaultRoot, historyN) : [];
      return [
        200,
        {
          data: {
            availability,
            asOf,
            digest,
            history,
          },
        },
      ];
    },
  },
  {
    // PRD §15 falsifiability counter table (ADR-0011 freeze-lift
    // condition). Serves the drain-time artifact
    // (system/section15Artifact.ts) that the connections drain
    // materializes after every successful pass — the same cold-boot-off
    // -the-heavy-collect pattern as workGraph-health above. The artifact
    // additionally persists the per-day clean ledger, so the
    // ≥7-clean-days streak (criterion 6) survives restarts; that streak
    // CANNOT be reconstructed live (dataLoss.clean is point-in-time), so
    // when the artifact is missing/stale the live fallback reports the
    // streak as 0 (honest — no ledger to walk) while the other five
    // counters are computed fresh. Serve gate is symmetric with the
    // writer's (eventStoreEnabled) AND age-bounded.
    method: 'GET',
    pattern: /^\/v1\/system\/section15$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      if (eventStoreEnabled()) {
        const artifact = await readSection15Artifact(vaultRoot);
        if (artifact !== null && isSection15ArtifactFresh(artifact)) {
          return [
            200,
            {
              data: {
                availability: 'ok',
                generatedAt: artifact.generatedAt,
                report: artifact.report,
              },
            },
          ];
        }
      }
      // Live fallback — no fresh artifact. CleanDays defaults to empty
      // (criterion 6 → streak 0) because the point-in-time clean ledger
      // only exists in the artifact.
      const report = await collectSection15Report({
        vaultRoot,
        ...(context.eventLog === undefined ? {} : { eventLog: context.eventLog }),
      });
      return [200, { data: { availability: 'live', generatedAt: null, report } }];
    },
  },
  {
    // Per-surface reliability diagram (north-star §5 S1, P9). Serves the
    // drain-time reliability artifact from disk when fresh; otherwise a
    // live collect (typed recall.served + recall.action read + per-surface
    // Platt/temperature fits). FREEZE-SAFE: measurement only — the fitted
    // calibrators are reported, never applied to a serving decision at S1.
    // Serve gate is symmetric with the writer's (eventStoreEnabled) AND
    // age-bounded, matching section15.
    method: 'GET',
    pattern: /^\/v1\/system\/reliability$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      if (eventStoreEnabled()) {
        const artifact = await readReliabilityArtifact(vaultRoot);
        if (artifact !== null && isReliabilityArtifactFresh(artifact)) {
          return [
            200,
            {
              data: {
                availability: 'ok',
                generatedAt: artifact.generatedAt,
                report: artifact.report,
              },
            },
          ];
        }
      }
      // Live fallback — no fresh artifact. Bounded typed read; on a store-
      // disabled install this is a single readMerged filtered to two types.
      const report = await collectReliabilityReport({
        vaultRoot,
        ...(context.eventLog === undefined ? {} : { eventLog: context.eventLog }),
      });
      return [200, { data: { availability: 'live', generatedAt: null, report } }];
    },
  },
  {
    // PRD §15 criterion 4 — tab recovery. The extension POSTs here after
    // a SUCCESSFUL chrome.sessions.restore (App.tsx restoreThreadSession)
    // so the recovery leaves a durable, event-log-sourced trace the §15
    // counter can read. Observability-only: no serving consumer reads
    // chrome.sessions.restore, so it is freeze-safe (ADR-0011).
    method: 'POST',
    pattern: /^\/v1\/system\/tab-recovery$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'tabRecovery', idempotencyKey, async () => {
        const payload = objectRecord(await readBody(request));
        if (payload === undefined || !isChromeSessionsRestorePayload(payload)) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must be a valid chrome.sessions.restore payload.',
          );
        }
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId: TAB_RECOVERY_AGGREGATE_ID,
          type: CHROME_SESSIONS_RESTORE,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, TAB_RECOVERY_AGGREGATE_ID),
        });
        return [201, { data: { accepted } }];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/rotate-bridge-key$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { data: await rotateBridgeKey(requireVaultRoot(context), context.bridgeKey) },
    ],
  },
];

export const systemRoutesC: readonly RouteDefinition[] = [
  // Stage 5 polish — debug snapshot endpoint. The side panel collects
  // current visual state (focused tab, urlInbox, urlSuggestions, panel
  // settings) and POSTs the JSON blob here. We always overwrite
  // `${vaultRoot}/_BAC/debug-dumps/latest.json` so the user (and any
  // assistant they hand the path to) can read a single stable location
  // without tracking timestamps; the timestamped copy under the same
  // directory is kept for short-history scrubbing.
  {
    method: 'POST',
    pattern: /^\/v1\/debug\/dump$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const body = await readBody(request);
      const dumpsDir = join(vaultRoot, '_BAC', 'debug-dumps');
      await mkdir(dumpsDir, { recursive: true });
      // Use an ISO timestamp + millisecond suffix so rapid-fire dumps
      // don't collide. Colons are valid on macOS / Linux but APFS
      // displays them oddly in Finder — strip to a safe pattern.
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const stamped = join(dumpsDir, `${ts}.json`);
      const latest = join(dumpsDir, 'latest.json');
      // Wrap the panel-supplied payload alongside a server-side header
      // (timestamp + companion uptime + vaultRoot) so the dump is
      // self-contained for offline review.
      const wrapped = {
        header: {
          dumpedAt: new Date().toISOString(),
          vaultRoot,
          companion: 'sidetrack-companion',
        },
        panel: body,
      };
      const json = JSON.stringify(wrapped, null, 2);
      await writeFile(stamped, json, 'utf8');
      await writeFile(latest, json, 'utf8');
      return [
        201,
        {
          data: { path: latest, stampedPath: stamped, sizeBytes: Buffer.byteLength(json, 'utf8') },
        },
      ];
    },
  },
];
