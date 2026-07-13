import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { ensureMcpKey } from '../auth/mcpKey.js';
import { createIdempotencyStore } from '../http/idempotency.js';
import { pickInstaller } from '../install/index.js';
import { createRecallActivityTracker } from '../recall/activity.js';
import { createRecallLifecycle } from '../recall/lifecycle.js';
import {
  bootCollectorFramework,
  type CollectorFrameworkHandle,
} from '../collectors/framework/runtime.js';
import { gateStateForCollector } from '../collectors/framework/capabilityGates.js';
import { COLLECTOR_FRAMEWORK_VERSION } from '../version.js';
import { projectPrivacy, type PrivacyProjection } from '../privacy/projection.js';
import {
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
} from '../privacy/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  acquireRecallProcessLock,
  cleanupOrphanIndexTmpFiles,
  type RecallProcessLock,
} from '../recall/recovery.js';
import { createBucketRegistry } from '../routing/registry.js';
import {
  createCompanionHttpServer,
  startHttpServer,
  type StartedHttpServer,
} from '../http/server.js';
import { startEventLoopMonitor } from './eventLoopMonitor.js';
import { createEmbedderClient } from '../recall/embedderClient.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { eventStoreEnabled, getCaughtUpSharedEventStore } from '../sync/eventStore.js';
import {
  collectWorkGraphHealth,
  type ConnectionsDiagnosticSnapshot,
} from '../system/workGraphHealth.js';
import { writeWorkGraphHealthArtifact } from '../system/workGraphHealthArtifact.js';
import { writeSection15Artifact } from '../system/section15Artifact.js';
import { anyLaneCounterNonZero } from '../system/health.js';
import { getEventLaneHealth } from '../sync/eventLaneHealth.js';
import { createKnownReplicasStore } from '../sync/knownReplicas.js';
import { createProjectionChangeFeed } from '../sync/projectionChanges.js';
import { createExtractionMaterializer } from '../sync/contract/extractionMaterializer.js';
import { createConnectionsMaterializer } from '../sync/contract/connectionsMaterializer.js';
import { createConnectionsStore } from '../connections/snapshot.js';
import { createTimelineMaterializer } from '../sync/contract/timelineMaterializer.js';
import { createTimelineStore } from '../timeline/projection.js';
import {
  canonicalizeEvidenceUrl,
  ensurePageEvidenceForTimelineEntries,
  embedBacklogCanonicalUrl,
  listBackgroundEmbeddingCandidates,
  readBackgroundEmbeddingProgress,
  writeBackgroundEmbeddingProgress,
} from '../page-evidence/store.js';
import { createBackgroundEmbeddingLane } from '../page-evidence/backgroundEmbeddingLane.js';
import { buildDomainTombstoneSet } from '../privacy/domainTombstone.js';
import { readDomainTombstones } from '../privacy/domainTombstoneStore.js';
import type { TimelineProvider } from '../timeline/events.js';
import { createProjectionMaterializer } from '../sync/contract/projectionMaterializer.js';
import { createRecallMaterializer } from '../sync/contract/recallMaterializer.js';
import { createSyncContractRunner } from '../sync/contract/runner.js';
import { createExtractionStore } from '../recall/extraction/store.js';
import { createEmbeddingCache } from '../recall/embeddingCache.js';
import { reprojectOnVersionMismatch } from '../sync/reproject.js';
import { startAntiEntropyTask } from '../sync/antiEntropy.js';
import {
  createRelayTransport,
  getRelayTransportStatus,
  stopRelayTransport,
} from '../sync/relayTransport.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { loadOrCreateReplicaKeyPair } from '../sync/replicaKeyPair.js';
import type { LogTransport } from '../sync/transport.js';
import { enforceRetention } from '../vault/auditRetention.js';
import { applyGcPlan, buildGcPlan } from '../gc/plan.js';
import { createVaultWatcher, type VaultChangeEvent, type VaultWatcher } from '../vault/watcher.js';
import { createVaultWriter } from '../vault/writer.js';
import { COMPANION_VERSION } from '../version.js';

type PageEvidenceTimelineEntry = Parameters<typeof ensurePageEvidenceForTimelineEntries>[1][number];

export const appendObservedEdgeEventsBatch = async (
  eventLog: Pick<EventLog, 'appendClientObservedBatch'>,
  events: readonly AcceptedEvent[],
  onAccepted: (event: AcceptedEvent) => void,
): Promise<readonly { readonly clientEventId: string; readonly imported: boolean }[]> =>
  eventLog.appendClientObservedBatch(
    events.map((event) => ({
      clientEventId: event.clientEventId,
      aggregateId: event.aggregateId,
      type: event.type,
      payload: event.payload as Record<string, unknown>,
      baseVector: {},
    })),
    onAccepted as (event: AcceptedEvent<Record<string, unknown>>) => void,
  );

export interface HygieneStatus {
  lastIdempotencyGcAt?: string;
  lastAuditRetentionAt?: string;
  lastDerivedRevisionGcAt?: string;
  lastVacuumAt?: string;
  lastVacuumDurationMs?: number;
}

export const scheduleSqliteVacuumGc = (
  store: { readonly vacuum?: () => Promise<void> },
  hygieneStatus: HygieneStatus,
  options: { readonly everyMs: number; readonly startupDelayMs?: number },
): (() => void) => {
  const runSqliteVacuumGc = async (): Promise<void> => {
    if (store.vacuum === undefined) return;
    const started = performance.now();
    try {
      await store.vacuum();
      hygieneStatus.lastVacuumAt = new Date().toISOString();
      hygieneStatus.lastVacuumDurationMs = Math.round(performance.now() - started);
    } catch {
      // Best-effort — a failed VACUUM must never crash the companion.
    }
  };
  const sqliteVacuumGc = setInterval(() => {
    void runSqliteVacuumGc();
  }, options.everyMs);
  const sqliteVacuumGcKickoff = setTimeout(() => {
    void runSqliteVacuumGc();
  }, options.startupDelayMs ?? 60_000);
  return () => {
    clearInterval(sqliteVacuumGc);
    clearTimeout(sqliteVacuumGcKickoff);
  };
};

// Debounce so a drain burst coalesces into one artifact collect.
export const WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS = 2_000;
// Min-interval floor between successful collects. The artifact feeds
// the extension's health panel, which polls /v1/system/health on a
// ~30s cadence, and each collect materializes ALL recall.served /
// recall.action events — a cost that grows with history. Refreshing
// at drain cadence (every few seconds under active browsing) is
// precision no reader can observe: pure wasted work.
export const WORKGRAPH_HEALTH_ARTIFACT_MIN_INTERVAL_MS = 30_000;

// Scheduler for the drain-time workGraph health artifact. Exported as
// a factory (same testing seam as scheduleSqliteVacuumGc above) so the
// debounce / floor / trailing-rerun semantics are unit-testable
// without booting a companion.
export const createWorkGraphHealthArtifactScheduler = (options: {
  // Collects + writes one artifact. Resolves true only when the
  // artifact was actually written — failures and skips (event store
  // absent) must not advance the floor, so the next drain retries.
  readonly materialize: () => Promise<boolean>;
  // Cheap outer gate (SIDETRACK_EVENT_STORE): without the shared
  // event store, collectWorkGraphHealth degrades to TWO full
  // eventLog.readMerged() passes — that cost must not move to drain
  // time on default configs. The route's live fallback
  // (budget-guarded) still serves those installs.
  readonly enabled: () => boolean;
  readonly now?: () => number;
}): { readonly schedule: () => void; readonly teardown: () => void } => {
  const now = options.now ?? Date.now;
  let inFlight = false;
  let rerunRequested = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSuccessAtMs: number | null = null;

  const run = async (): Promise<void> => {
    if (inFlight) {
      // A drain landed while a collect was mid-read, so its changes
      // are not in the in-flight pass. Request one trailing rerun
      // instead of dropping it: on a quiet vault the next drain may
      // never come, which would freeze the artifact on pre-drain
      // state indefinitely. Single flag = single trailing collect,
      // so single-flight is preserved.
      rerunRequested = true;
      return;
    }
    inFlight = true;
    try {
      if (await options.materialize()) lastSuccessAtMs = now();
    } finally {
      inFlight = false;
      if (rerunRequested) {
        rerunRequested = false;
        schedule({ trailingRerun: true });
      }
    }
  };

  const schedule = (opts?: { readonly trailingRerun?: boolean }): void => {
    if (!options.enabled()) return;
    if (timer !== null) return;
    const sinceSuccessMs =
      lastSuccessAtMs === null ? Number.POSITIVE_INFINITY : now() - lastSuccessAtMs;
    const floorRemainingMs = WORKGRAPH_HEALTH_ARTIFACT_MIN_INTERVAL_MS - sinceSuccessMs;
    // Min-interval floor: a fresh-enough artifact already exists, and
    // the next drain (or the trailing rerun below) re-schedules, so a
    // plain skip is enough here.
    if (opts?.trailingRerun !== true && floorRemainingMs > 0) return;
    // The trailing rerun waits out the floor instead of bypassing it:
    // bypassing would re-enable back-to-back collects whenever a
    // collect overlaps a drain — exactly the busy periods the floor
    // exists for. Scheduling at floor expiry keeps ≤1 collect per
    // interval while still guaranteeing the missed drain's changes
    // land without waiting for another drain.
    const delayMs =
      opts?.trailingRerun === true
        ? Math.max(WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS, floorRemainingMs)
        : WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delayMs);
    // A pending refresh must never hold the process open (mirrors
    // the materializer's own drainDebounceTimer).
    timer.unref();
  };

  return {
    schedule: () => {
      schedule();
    },
    teardown: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
};

const maxLastSeenAt = (entries: readonly PageEvidenceTimelineEntry[]): string | undefined => {
  let latest: string | undefined;
  for (const entry of entries) {
    if (latest === undefined || entry.lastSeenAt > latest) latest = entry.lastSeenAt;
  }
  return latest;
};

export const createPageEvidenceWriteQueue = (
  vaultRoot: string,
): ((entries: readonly PageEvidenceTimelineEntry[]) => Promise<void>) => {
  const pendingByCanonicalUrl = new Map<string, Promise<void>>();
  const latestLastSeenAtByCanonicalUrl = new Map<string, string>();

  return async (entries: readonly PageEvidenceTimelineEntry[]): Promise<void> => {
    const byCanonicalUrl = new Map<string, PageEvidenceTimelineEntry[]>();
    for (const entry of entries) {
      const canonicalUrl = canonicalizeEvidenceUrl(entry.canonicalUrl ?? entry.url);
      const existing = byCanonicalUrl.get(canonicalUrl);
      if (existing === undefined) byCanonicalUrl.set(canonicalUrl, [entry]);
      else existing.push(entry);
    }

    await Promise.all(
      [...byCanonicalUrl.entries()].map(([canonicalUrl, groupedEntries]) => {
        const previous = pendingByCanonicalUrl.get(canonicalUrl) ?? Promise.resolve();
        const write = previous
          .catch(() => undefined)
          .then(async () => {
            const incomingLastSeenAt = maxLastSeenAt(groupedEntries);
            const latestKnown = latestLastSeenAtByCanonicalUrl.get(canonicalUrl);
            if (
              incomingLastSeenAt !== undefined &&
              latestKnown !== undefined &&
              incomingLastSeenAt < latestKnown
            ) {
              return;
            }
            await ensurePageEvidenceForTimelineEntries(vaultRoot, groupedEntries, {
              rebuildManifestAfterWrite: false,
            });
            if (incomingLastSeenAt !== undefined) {
              latestLastSeenAtByCanonicalUrl.set(canonicalUrl, incomingLastSeenAt);
            }
          });
        pendingByCanonicalUrl.set(canonicalUrl, write);
        void write.finally(() => {
          if (pendingByCanonicalUrl.get(canonicalUrl) === write) {
            pendingByCanonicalUrl.delete(canonicalUrl);
          }
        });
        return write;
      }),
    );
  };
};

export interface CompanionRuntimeOptions {
  readonly vaultPath: string;
  readonly port: number;
  readonly allowAutoUpdate?: boolean;
  // Set when the companion is launching the MCP WS server as a child.
  // Plumbed into HTTP config so /v1/status echoes the same key the
  // MCP server is accepting — the side panel reads it from there.
  readonly mcp?: { readonly port: number; readonly authKey: string };
  // Optional cloud-relay sync. When both fields are present, the
  // companion connects to the relay over WebSocket using end-to-end
  // encrypted frames so peer replicas sharing the same rendezvous
  // secret receive accepted events.
  readonly relay?: {
    readonly url: string;
    readonly mode?: 'local' | 'remote';
    // Base64url-encoded shared secret (≥ 16 bytes after decoding).
    readonly rendezvousSecret: string;
  };
  // Command prefix to persist when the side panel installs "run on
  // startup". Local checkout flow uses `bun dist/cli.js` here, so no
  // published package is required.
  readonly service?: {
    readonly companionCommand?: readonly string[];
    readonly mcpBin?: string;
    readonly syncRelay?: string;
    readonly syncRelayLocalPort?: number;
  };
}

export interface CompanionRuntime {
  readonly url: string;
  readonly vaultPath: string;
  readonly bridgeKey: string;
  readonly bridgeKeyPath: string;
  readonly bridgeKeyCreated: boolean;
  // F02 — MCP-scoped auth key. The companion spawner must pass this to the
  // MCP child as its --bridge-key argument so the companion server can
  // classify MCP callers separately from the extension surface.
  readonly mcpKey: string;
  readonly mcpKeyPath: string;
  readonly replicaId: string;
  readonly replicaIdCreated: boolean;
  readonly close: () => Promise<void>;
}

export const startCompanion = async (
  options: CompanionRuntimeOptions,
): Promise<CompanionRuntime> => {
  // Teardown stack: every side-effecting setup step (lock, intervals,
  // watcher, relay transport) registers a rollback here. If startup
  // throws partway through (most often `await startHttpServer`
  // rejecting with EADDRINUSE on a busy port), the catch block runs
  // these in reverse so we don't leak the recall lock or strand
  // setInterval handles in the event loop. Without this, the
  // process would set exitCode=1 and then linger forever — both
  // because the event loop kept running on the unreleased
  // intervals, and because the lock file would still point at the
  // now-zombie pid, blocking every subsequent launch on the
  // recovery's stale-pid takeover path.
  const teardown: (() => Promise<void> | void)[] = [];
  const runTeardown = async (): Promise<void> => {
    while (teardown.length > 0) {
      const fn = teardown.pop();
      if (fn === undefined) continue;
      try {
        await fn();
      } catch {
        // Continue tearing down — one failed step shouldn't block
        // the rest. Lock release is the most important; it runs
        // last (registered first).
      }
    }
  };
  try {
    const ensured = await ensureBridgeKey(options.vaultPath);
    // Generate the MCP-scoped auth key alongside bridge.key. The companion
    // passes this key to the MCP child process (as its --bridge-key arg) so
    // the server can distinguish MCP callers from the extension surface and
    // apply workstream-trust enforcement (F02). Stable across boots — the
    // same file is reused if it already exists (same pattern as bridge.key).
    const ensuredMcpKey = await ensureMcpKey(options.vaultPath);
    const replica = await loadOrCreateReplica(options.vaultPath);
    // Refuse startup if another live process owns the recall index
    // for this vault — concurrent writers would corrupt the binary.
    // The lock takeover for stale (PID-dead) entries happens inside
    // acquireRecallProcessLock; we only error out for live races.
    const recallLock: RecallProcessLock = await acquireRecallProcessLock(options.vaultPath);
    teardown.push(() => recallLock.release());
    // Sweep stale `.index.bin.<rev>.tmp` files from a prior crash.
    // Idempotent; runs every startup.
    await cleanupOrphanIndexTmpFiles(options.vaultPath);
    const vaultWriter = createVaultWriter(options.vaultPath);
    const pageEvidenceWriteQueue = createPageEvidenceWriteQueue(options.vaultPath);
    const idempotencyStore = createIdempotencyStore(options.vaultPath);
    const listeners = new Set<(event: VaultChangeEvent) => void>();
    const markPostDrain = (label: string, startedAtMs: number): void => {
      console.warn(
        `[connections-phase] post-drain.${label} dt=${String(
          Math.round(performance.now() - startedAtMs),
        )}ms`,
      );
    };
    const markSlowPostDrainObserver = (label: string, startedAtMs: number): void => {
      if (performance.now() - startedAtMs >= 50) {
        markPostDrain(label, startedAtMs);
      }
    };
    let watcher: VaultWatcher | undefined;
    try {
      watcher = createVaultWatcher(options.vaultPath, {
        onChange: (event) => {
          const isConnectionsChange = event.relPath
            .split('/')
            .join('/')
            .startsWith('_BAC/connections/');
          const fanoutStartedAtMs = performance.now();
          for (const listener of listeners) {
            const listenerStartedAtMs = performance.now();
            try {
              listener(event);
            } catch {
              // A subscriber's handler must never break fan-out to the
              // other subscribers (or throw into the vault watcher).
            } finally {
              if (isConnectionsChange) {
                markSlowPostDrainObserver('observer.listener', listenerStartedAtMs);
              }
            }
          }
          if (isConnectionsChange) {
            markSlowPostDrainObserver('observer.listeners', fanoutStartedAtMs);
          }
        },
      });
    } catch {
      watcher = undefined;
    }
    if (watcher !== undefined) {
      const w = watcher;
      teardown.push(() => w.close());
    }
    const hygieneStatus: HygieneStatus = {};
    const idempotencyGc = setInterval(
      () => {
        void idempotencyStore.gcExpired?.(new Date()).then(() => {
          hygieneStatus.lastIdempotencyGcAt = new Date().toISOString();
        });
      },
      60 * 60 * 1000,
    );
    teardown.push(() => {
      clearInterval(idempotencyGc);
    });
    const auditRetention = setInterval(
      () => {
        void enforceRetention(options.vaultPath).then(() => {
          hygieneStatus.lastAuditRetentionAt = new Date().toISOString();
        });
      },
      24 * 60 * 60 * 1000,
    );
    teardown.push(() => {
      clearInterval(auditRetention);
    });
    // Derived-revision sweep: visit-similarity / topic / closest-visit
    // revision files (one written per rebuild) plus stale connections
    // temp files. buildGcPlan keeps the newest N of each; previously the
    // sweep ran ONLY as a manual CLI command, so these dirs grew
    // unbounded — visit-similarity alone reached ~1.7 GiB per vault.
    const runDerivedRevisionGc = async (): Promise<void> => {
      try {
        const plan = await buildGcPlan(options.vaultPath);
        if (plan.entries.length > 0) {
          await applyGcPlan(plan);
        }
        hygieneStatus.lastDerivedRevisionGcAt = new Date().toISOString();
      } catch {
        // Best-effort — a failed sweep must never crash the companion.
      }
    };
    const derivedRevisionGc = setInterval(
      () => {
        void runDerivedRevisionGc();
      },
      60 * 60 * 1000,
    );
    teardown.push(() => {
      clearInterval(derivedRevisionGc);
    });
    // Clear any startup backlog without competing with boot's catch-up
    // reconcile.
    const derivedRevisionGcKickoff = setTimeout(() => {
      void runDerivedRevisionGc();
    }, 60_000);
    teardown.push(() => {
      clearTimeout(derivedRevisionGcKickoff);
    });
    const sqliteVacuumEveryMs = (() => {
      const raw = process.env['SIDETRACK_SQLITE_VACUUM_EVERY_MS'];
      const parsed = raw === undefined ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 6 * 60 * 60 * 1000;
    })();
    const recallActivity = createRecallActivityTracker();
    // The append-path signature guard (re-stat the whole log per write to
    // detect external shard writers) is only needed when another process
    // can write shards: a configured sync relay, or an operator running a
    // concurrent CLI `import` (force via SIDETRACK_EXTERNAL_WRITERS=1).
    // The default single-companion vault is the sole writer, so the guard
    // is skipped and writes don't pay ~222 syscalls × 2 per append.
    const externalWritersPossible =
      (options.relay !== undefined && options.relay.rendezvousSecret.trim().length > 0) ||
      process.env['SIDETRACK_EXTERNAL_WRITERS'] === '1';
    const baseEventLog = createEventLog(options.vaultPath, replica, { externalWritersPossible });
    const projectionChanges = createProjectionChangeFeed(options.vaultPath);

    // Sync Contract v1 — runner. Single dispatch point for every
    // accepted event (local OR peer). Materializers register below
    // (projection always; recall after recallLifecycle exists). The
    // relay subscriber + the local appendClient decorator both call
    // `runner.onAcceptedEvent` so source-vs-peer asymmetry is
    // structurally impossible (gate L1-G10). See plan
    // (~/.claude/plans/kind-prancing-river.md), Lane 1.
    const syncContractRunner = createSyncContractRunner();
    syncContractRunner.register(
      createProjectionMaterializer({
        vaultRoot: options.vaultPath,
        eventLog: baseEventLog,
        projectionChanges,
      }),
    );
    // Lane 2 / Class E — extraction materializer wraps capture.recorded
    // as legacy extraction revisions and consumes capture.extraction.
    // produced peer events. Recall is a downstream consumer of the
    // extraction store via its own catchUp.
    const extractionStore = createExtractionStore(options.vaultPath);
    syncContractRunner.register(
      createExtractionMaterializer({
        store: extractionStore,
        eventLog: baseEventLog,
        vaultRoot: options.vaultPath,
      }),
    );
    // First future surface — Class B timeline projection. Reduces
    // browser.timeline.observed events into daily-bucketed projection
    // files at _BAC/timeline/projections/<YYYY-MM-DD>.json. Pure
    // reduction over the event log; deterministic; replay-recoverable
    // via catchUp.
    const timelineStore = createTimelineStore(options.vaultPath);
    syncContractRunner.register(
      createTimelineMaterializer({
        store: timelineStore,
        eventLog: baseEventLog,
        vaultRoot: options.vaultPath,
      }),
    );
    // Class B Connections — consumer-only materializer that joins
    // existing aggregates into an evidence graph. Same dirty-bit +
    // failure-cooldown pattern as timeline. Reads vault stores
    // (threads, workstreams, dispatches, queue, reminders, coding
    // sessions) + timeline daily projections at snapshot time.
    const connectionsStore = createConnectionsStore(options.vaultPath);
    teardown.push(
      scheduleSqliteVacuumGc(connectionsStore, hygieneStatus, { everyMs: sqliteVacuumEveryMs }),
    );
    const connectionsMaterializer = createConnectionsMaterializer({
      vaultRoot: options.vaultPath,
      eventLog: baseEventLog,
      timelineStore,
      store: connectionsStore,
      // Drain-time workGraph health artifact. The scheduler is defined
      // below (next to the server wiring — it shares the route's dep
      // set); referencing it through this closure is safe because the
      // hook can only fire after a drain completes, long past this
      // startup frame, and the materializer swallows hook errors.
      onDrainSuccess: () => {
        scheduleWorkGraphHealthArtifact();
        scheduleSection15Artifact();
      },
    });
    syncContractRunner.register(connectionsMaterializer);

    // Reproject on startup if the projector logic has changed since
    // the last run. Writes a `_BAC/.projector-version` sentinel so
    // subsequent startups are no-ops. Recovers from:
    //   - an upgrade where a projector's output shape changed.
    //   - a vault that was last touched by an older companion that
    //     didn't write the version file.
    //   - a manually-deleted projection file (the next event for
    //     that aggregate would re-create it anyway, but reproject
    //     fixes it without waiting for activity).
    // Best-effort — startup proceeds even if reproject errors out.
    await reprojectOnVersionMismatch({
      vaultRoot: options.vaultPath,
      eventLog: baseEventLog,
      projectionChanges,
    }).catch(() => undefined);

    // Periodic anti-entropy. Walks the merged log every 30 min and
    // re-runs the projector for every aggregate's latest event. Repairs
    // drift from dropped relay events or partial-write recovery without
    // waiting for the next user-driven event on that aggregate. Refer
    // to sync/antiEntropy.ts for the rationale (Cassandra-style read-
    // repair pattern).
    const antiEntropy = startAntiEntropyTask({
      vaultRoot: options.vaultPath,
      eventLog: baseEventLog,
      projectionChanges,
    });
    teardown.push(() => {
      antiEntropy.stop();
    });

    // Optional outbound relay transport. When wired, every accepted
    // event is rebroadcast via the relay so peers learn about it
    // without a shared filesystem.
    let relayTransport: LogTransport | null = null;
    if (options.relay !== undefined && options.relay.rendezvousSecret.trim().length > 0) {
      const keyPair = await loadOrCreateReplicaKeyPair(options.vaultPath);
      const knownReplicas = createKnownReplicasStore(options.vaultPath);
      relayTransport = createRelayTransport({
        relayUrl: options.relay.url,
        rendezvousSecret: Buffer.from(options.relay.rendezvousSecret, 'base64url'),
        localReplicaId: replica.replicaId,
        localKeyPair: keyPair,
        knownReplicas,
      });
      {
        const t = relayTransport;
        teardown.push(() => {
          stopRelayTransport(t);
        });
      }
      relayTransport.subscribePeers(new Set(), (_replicaId, event) => {
        void (async () => {
          try {
            const result = await baseEventLog.importPeerEvent(event);
            if (result.imported) {
              // Sync Contract v1: hand to the runner. The projection
              // materializer dispatches into runImportProjectors; the
              // recall materializer schedules a coalesced ingest. No
              // direct runImportProjectors call here — the runner is
              // the single dispatch point for both local and peer
              // accepted events (gate L1-G10).
              syncContractRunner.onAcceptedEvent(event, { origin: 'peer' });
            }
          } catch {
            // importPeerEvent surfaces DotCollisionError /
            // ClientEventIdReuseError; the relay drops the offending
            // peer and the user gets a side-panel alert (TODO).
          }
        })();
      });
    }

    // Decorate the eventLog with an after-accept hook that:
    //   1. Hands the accepted event to the contract runner with
    //      `origin: 'local'`. The runner dispatches to materializers,
    //      symmetrically with the peer-import path. This is gate
    //      L1-G10 — local accepted events enter the same contract.
    //   2. Publishes via the relay so peers learn about the event
    //      without a shared filesystem.
    //
    // Note on flat-shape vs projection-shape (L1.S3 follow-up): the
    // projection materializer writes the projection envelope to the
    // _BAC/<aggregate>/projections/ subpath while vault/writer.ts
    // continues to write the flat path for legacy readers
    // (parseThreadUpsertBody, deleteWorkstream). Path decoupling is
    // L1.S3; this stage wires the runner.
    const onLocalAccepted = (accepted: { dot: { replicaId: string } }) => {
      // Sync Contract v1: local accepted event enters the runner.
      // Runner dispatches to projection materializer (and recall +
      // future materializers). Local + peer symmetric (gate L1-G10).
      syncContractRunner.onAcceptedEvent(accepted as never, { origin: 'local' });
      if (relayTransport !== null) {
        void relayTransport
          .publishEvent(accepted.dot.replicaId, accepted as never)
          .catch(() => undefined);
      }
      // Stage 4: privacy events refresh the cached projection so
      // collector capability gates see the new state on next promote.
      onPrivacyEventAccepted(accepted as AcceptedEvent);
    };
    const eventLog = {
      ...baseEventLog,
      appendClient: async <T extends Record<string, unknown>>(
        input: Parameters<typeof baseEventLog.appendClient<T>>[0],
      ) => {
        const accepted = await baseEventLog.appendClient(input);
        onLocalAccepted(accepted);
        return accepted;
      },
      appendClientObserved: async <T extends Record<string, unknown>>(
        input: Parameters<typeof baseEventLog.appendClientObserved<T>>[0],
      ) => {
        const accepted = await baseEventLog.appendClientObserved(input);
        onLocalAccepted(accepted);
        return accepted;
      },
      appendServerObserved: async <T extends Record<string, unknown>>(
        input: Parameters<typeof baseEventLog.appendServerObserved<T>>[0],
      ) => {
        const accepted = await baseEventLog.appendServerObserved(input);
        onLocalAccepted(accepted);
        return accepted;
      },
    };
    // Warm the append-path indexes off the request path: the first
    // write after boot otherwise pays the one-time streaming pass over
    // the log (tens of seconds on a 333k-event vault). Fire-and-forget
    // — appends issued while the warm runs join the in-flight pass
    // (single-flight) instead of triggering their own.
    void baseEventLog.prewarmAppendIndexes().catch(() => undefined);
    // Recall indexer client — runs full rebuilds in a separate OS
    // process so the main thread is never pinned by the recall
    // pipeline (read merged log + project + scan legacy JSONL +
    // JSON.parse + chunk turns + encode index file). Earlier
    // mitigations (embedder sidecar in 042b2642, per-text yield in
    // 05c5ad6c, scan/chunk yields in 07b3c5ec) cut the worst case
    // from 65 s to ~400 ms; the indexer-child approach drives it
    // toward zero because the parent literally doesn't run the
    // pipeline. Same SIDETRACK_EMBEDDER_INPROCESS=1 / TEST_EMBEDDER=1
    // opt-out as the embedder sidecar: tests + library callers get
    // the in-process rebuilder so they can assert on lifecycle state.
    const useChildProcesses =
      process.env['SIDETRACK_EMBEDDER_INPROCESS'] !== '1' &&
      process.env['SIDETRACK_TEST_EMBEDDER'] !== '1';
    const indexerClient = useChildProcesses
      ? (await import('../recall/indexerClient.js')).createRecallIndexerClient()
      : null;
    if (indexerClient !== null) {
      teardown.push(async () => {
        await indexerClient.stop();
      });
    }
    const recallLifecycle = createRecallLifecycle({
      vaultRoot: options.vaultPath,
      companionVersion: COMPANION_VERSION,
      activity: recallActivity,
      replica: {
        replicaId: replica.replicaId,
        nextSeq: replica.nextSeq,
      },
      eventLog,
      ...(indexerClient === null ? {} : { indexerClient }),
    });

    // Recall materializer registers AFTER recallLifecycle exists. Uses
    // the dirty-bit coalesced scheduler so a burst of capture events
    // (e.g., reconnect backlog) creates exactly one in-flight ingest
    // worker (gate L1-G6).
    syncContractRunner.register(
      createRecallMaterializer({
        recallLifecycle,
        recallActivity,
        eventLog: baseEventLog,
        // Lane 2: recall consumer reads the extraction store on
        // catchUp and source-replaces stale entries via
        // replaceEntriesForSourceUnit. Closes gates L2-G1 +
        // L2-G10 when extraction revisions change.
        extractionStore,
        indexPath: `${options.vaultPath}/_BAC/recall/index.bin`,
        // L2-G2 — embedding cache. Metadata-only extractor upgrades
        // reuse vectors keyed by embedTextHash; the embedder is only
        // invoked for chunks whose text actually changed.
        embeddingCache: createEmbeddingCache(options.vaultPath),
      }),
    );
    // ─── Collector framework (Stage 4) ──────────────────────────────
    // Wired BEFORE the HTTP server starts so the GET /v1/collectors and
    // POST /v1/collectors/{id}/replay routes have a live framework
    // handle to query. Best-effort: if boot throws (corrupt manifest,
    // FS issue, etc.) we log + continue without it; HTTP routes return
    // 503 in that case.
    let collectorFramework: CollectorFrameworkHandle | null = null;
    let cachedPrivacyProjection: PrivacyProjection = projectPrivacy([]);
    const refreshPrivacyProjectionFromLog = async (): Promise<void> => {
      try {
        const store = await getCaughtUpSharedEventStore(options.vaultPath);
        const events: AcceptedEvent[] = [];
        if (store === null) {
          // Stream + collect only the 3 privacy event types instead of
          // materialising the full ~700MB merged log just to filter them.
          // This is the FIRST boot caller, so warming the memo here set
          // the libpas high-water for the whole process.
          events.push(
            ...(await baseEventLog.streamFiltered(
              (e) =>
                e.type === PRIVACY_GATE_FLIPPED ||
                e.type === PRIVACY_PERMISSION_GRANTED ||
                e.type === PRIVACY_PERMISSION_REVOKED,
              new Set([
                PRIVACY_GATE_FLIPPED,
                PRIVACY_PERMISSION_GRANTED,
                PRIVACY_PERMISSION_REVOKED,
              ]),
            )),
          );
        } else {
          await store.forEachChunk((chunk) => {
            for (const event of chunk) {
              if (
                event.type === PRIVACY_GATE_FLIPPED ||
                event.type === PRIVACY_PERMISSION_GRANTED ||
                event.type === PRIVACY_PERMISSION_REVOKED
              ) {
                events.push(event);
              }
            }
          }, 2000);
        }
        cachedPrivacyProjection = projectPrivacy(events);
      } catch {
        // Initial empty projection is the safe default.
      }
    };
    const onPrivacyEventAccepted = (event: AcceptedEvent): void => {
      if (
        event.type === PRIVACY_GATE_FLIPPED ||
        event.type === PRIVACY_PERMISSION_GRANTED ||
        event.type === PRIVACY_PERMISSION_REVOKED
      ) {
        // Async refresh; collector promotions read the CACHED projection
        // synchronously, so a brief stale window is acceptable. The
        // alternative (synchronous refresh) would block every privacy
        // event accept on a full event-log read.
        void refreshPrivacyProjectionFromLog();
      }
    };
    await refreshPrivacyProjectionFromLog();

    const appendCollectorAudit = async (route: string, subject: string): Promise<void> => {
      const now = new Date();
      const datePath = join(
        options.vaultPath,
        '_BAC',
        'audit',
        `${now.toISOString().slice(0, 10)}.jsonl`,
      );
      try {
        await mkdir(join(datePath, '..'), { recursive: true });
        const entry = {
          requestId: `collector:${randomUUID()}`,
          route,
          outcome: 'success' as const,
          bac_id: subject,
          timestamp: now.toISOString(),
        };
        await writeFile(datePath, `${JSON.stringify(entry)}\n`, {
          encoding: 'utf8',
          flag: 'a',
        });
      } catch {
        // Audit-write failures are non-fatal — the collector framework
        // does not depend on audit success.
      }
    };

    try {
      collectorFramework = await bootCollectorFramework({
        vaultRoot: options.vaultPath,
        companionFrameworkVersion: COLLECTOR_FRAMEWORK_VERSION,
        vaultMajor: 1,
        appendClassA: async (event, ruleId, line) => {
          // Idempotent clientEventId — Patch 2 (post-review):
          // PRIMARY key is the collector's source_record_id when it
          // declares one. That's the only stable id across collector
          // restarts and across replay-on-startup.
          //
          // Final-review fix: when source_record_id is absent, hash
          // the FULL CollectorEvent line (envelope + payload +
          // dimensions). The earlier fallback hashed only
          // (ruleId + emittedAt + runId + type) — but two lines with
          // identical envelope-metadata can carry different payloads,
          // and we need them to promote independently. Hashing the
          // full line (via stable JSON serialization of the envelope's
          // canonical fields) covers payload + dimensions so distinct
          // lines always produce distinct ids, while a true re-promote
          // of the SAME bytes still short-circuits at the event log's
          // clientEventId dedupe.
          const clientEventId = (() => {
            if (line.source_record_id !== undefined && line.source_record_id.length > 0) {
              return `collector:${ruleId}:${line.source_record_id}`;
            }
            const lineDigest = createHash('sha256')
              .update(
                JSON.stringify({
                  collector_id: line.collector_id,
                  event_type: line.event_type,
                  payload_version: line.payload_version,
                  emitted_at: line.emitted_at,
                  collector_version: line.collector_version,
                  collector_run_id: line.collector_run_id,
                  payload: line.payload,
                  dimensions: line.dimensions,
                }),
                'utf8',
              )
              .digest('hex')
              .slice(0, 24);
            return `collector:${ruleId}:fallback:${lineDigest}`;
          })();
          const eventTypeForLog = (event as { type?: string }).type ?? 'collector.unknown';
          await eventLog.appendServerObserved({
            clientEventId,
            aggregateId: ruleId,
            type: eventTypeForLog,
            payload: event as Record<string, unknown>,
          });
        },
        auditRoute: appendCollectorAudit,
        resolveGate: (collectorId, capability, defaultEnabled) =>
          gateStateForCollector(cachedPrivacyProjection, collectorId, capability, defaultEnabled),
      });
      {
        const handle = collectorFramework;
        teardown.push(() => handle.close());
      }
    } catch {
      collectorFramework = null;
    }
    // ────────────────────────────────────────────────────────────────

    // Embedder sidecar — owns ONNX + transformers.js in a child process
    // so the main thread isn't blocked by inference. Opt-out with
    // SIDETRACK_EMBEDDER_INPROCESS=1 if a caller (test harness, special
    // diagnostic) wants the legacy in-process path. The test embedder
    // env (SIDETRACK_TEST_EMBEDDER=1) ALWAYS routes in-process — the
    // deterministic test embedder is sync and the child overhead is
    // pure waste.
    //
    // MUST be installed BEFORE the recall catchUp/rebuild IIFE below: that
    // background task embeds (recall ingest + visit similarity), and if the
    // override isn't set yet those calls fall through to the in-process
    // ONNX/CoreML path, faulting ~200MB of IOAccelerator (Metal) surfaces
    // into the MAIN process. Setting the override first routes every embed
    // to the child, so the main never links the GPU surfaces.
    const inProcessEmbedder = !useChildProcesses;
    const embedderClient = inProcessEmbedder ? null : createEmbedderClient();
    if (embedderClient !== null) {
      teardown.push(async () => {
        await embedderClient.stop();
      });
      // Install the sidecar as the global embed implementation so all
      // call sites (recall rebuild, recall ingestor, visit similarity)
      // dispatch through the child process automatically. The override
      // is module-scoped in `recall/embedder.ts`.
      const { setEmbedderOverride } = await import('../recall/embedder.js');
      setEmbedderOverride(embedderClient.embed);
    }

    // Don't block startup on the rebuild — health endpoint will report
    // status: 'rebuilding' until the background task completes.
    // The fresh-check + incremental ingest BOTH run through the
    // lifecycle's single-writer mutex, so they serialize against each
    // other and against any subsequent appendEntry / tombstone /
    // gcEntries call. ensureFresh schedules a rebuild ONLY when the
    // index is stale (model swap, schema bump, drift, missing); the
    // common case where the index is already ready is a noop and the
    // ingest runs immediately.
    void (async () => {
      try {
        await recallLifecycle.ensureFresh();
        // Wait for any rebuild ensureFresh kicked off — otherwise the
        // ingestor's enqueueWrite would queue behind the rebuild's
        // batches anyway, but holding the await here makes the order
        // explicit + lets us bail cleanly if rebuild errors.
        await recallLifecycle.waitForRebuild();
        // Sync Contract v1: catchUp every materializer over the
        // merged event log. Replaces the prior direct
        // ingestIncremental call — the recall materializer's catchUp
        // hands through to the same lifecycle.ingestIncremental, but
        // the projection materializer now ALSO catches up here so
        // any peer events that landed before startup get projected.
        // AWAITS each materializer's drain (gate L1-G4).
        await syncContractRunner.catchUpAll(baseEventLog);
      } catch {
        // Errors are non-fatal — the manual `recall reingest` CLI
        // verb + lifecycle stale-check rebuilds remain available.
      }
    })();
    // Off-main-loop page-evidence content embedding lane. Drains the
    // backlog of content-tier page-evidence records that have no doc
    // vector yet (the ~13.6%-coverage ceiling the audit flagged),
    // embedding them in bounded idle batches through the embedder CHILD
    // (the same setEmbedderOverride installed above) so the heavy
    // ONNX/CoreML work never lands on the API process. Gated by
    // SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING (default OFF — the flag
    // now drives THIS lane, not the retired setTimeout(0) request-path
    // embed) AND by useChildProcesses (an in-process embedder would put
    // the exact main-loop CPU this lane exists to avoid right back on the
    // event loop). On each completed embed the lane requalifies the visit
    // so the next connections drain re-derives its similarity edges.
    const backgroundEmbeddingLaneEnabled =
      (process.env['SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING'] === '1' ||
        process.env['SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING']?.toLowerCase() === 'true') &&
      useChildProcesses;
    if (backgroundEmbeddingLaneEnabled) {
      // Load the privacy tombstone set once at startup. A page whose
      // domain is tombstoned is never embedded (privacy gate). The set is
      // a snapshot; a tombstone added mid-session takes effect on the next
      // restart — acceptable because the backlog is durable and the
      // record's content is already on disk regardless.
      const tombstoneSet = buildDomainTombstoneSet(
        await readDomainTombstones(options.vaultPath).catch(() => []),
      );
      const embedOne = await embedBacklogCanonicalUrl(options.vaultPath);
      const backgroundEmbeddingLane = createBackgroundEmbeddingLane({
        listCandidates: () => listBackgroundEmbeddingCandidates(options.vaultPath),
        embedCanonicalUrl: embedOne,
        isDrainActive: () => connectionsMaterializer.isDrainActive(),
        isTombstoned: (page) => tombstoneSet.matchesPage(page),
        onEmbedded: (canonicalUrl) =>
          connectionsMaterializer.requalifyVisitForSimilarity(canonicalUrl),
        readProgress: () => readBackgroundEmbeddingProgress(options.vaultPath),
        writeProgress: (progress) =>
          writeBackgroundEmbeddingProgress(options.vaultPath, progress),
        log: (message) => process.stdout.write(`${message}\n`),
      });
      backgroundEmbeddingLane.start();
      teardown.push(() => {
        backgroundEmbeddingLane.stop();
      });
    }

    // Event-loop stall monitor. Spans the entire process lifetime so
    // /v1/status can report `eventLoop.maxRecentStallMs` etc. independent
    // of whether the materializer or recall lifecycle is doing work.
    // Any synchronous-CPU phase that pins the main thread for >250 ms
    // prints `[api.stall] eventLoopBlockedMs=… note=…` so the operator
    // can locate the blocking phase without re-running with profilers.
    const eventLoopMonitor = startEventLoopMonitor();
    teardown.push(() => {
      eventLoopMonitor.stop();
    });

    const getEmbedderStatus = (): {
      readonly state: 'disabled' | 'cold' | 'warming' | 'ready' | 'failed';
      readonly lastError?: string;
    } => {
      if (embedderClient === null) {
        return { state: 'disabled' };
      }
      const err = embedderClient.lastError();
      return {
        state: embedderClient.state(),
        ...(err === undefined ? {} : { lastError: err }),
      };
    };
    // Server-shaped view of the connections dirty queue. Shared by the
    // /v1/system/health route context below AND the drain-time
    // workGraph health artifact so both surfaces report the same
    // numbers.
    const connectionsDiagnostics = (): ConnectionsDiagnosticSnapshot => {
      const dirty = connectionsMaterializer.getDirtySources();
      return {
        dirtySourceCount: dirty.dirtySourceUnitIds.length,
        tombstonedSourceCount: dirty.tombstonedSourceUnitIds.length,
        latestExtractionCount: dirty.latestExtractionFor.size,
        oldestDirtySourceAgeMs: null,
      };
    };
    // Drain-time workGraph health artifact (system/workGraphHealthArtifact.ts).
    // collectWorkGraphHealth is too heavy for the request path on a
    // cold process (typed event reads + a usearch native load blow the
    // /v1/system/health 5s budget → the workGraph section pins
    // 'unavailable' for the whole-report TTL after every boot), so
    // materialize it after each successful connections drain and let
    // the route serve the report from disk. Debounce / min-interval
    // floor / single-flight + trailing rerun live in
    // createWorkGraphHealthArtifactScheduler above; errors swallowed —
    // observability must never surface as a drain failure.
    const materializeWorkGraphHealthArtifact = async (): Promise<boolean> => {
      try {
        // The scheduler's env gate proves the flag, not the store:
        // sync/eventStore.ts caches a FAILED open as a forever-null
        // promise, and with a broken store collectWorkGraphHealth's
        // readEventsForHealth silently degrades to TWO full
        // eventLog.readMerged() passes per collect — the exact cost
        // this artifact exists to avoid. Resolve the shared store
        // first and bail (false → floor does not advance) when it is
        // actually unavailable.
        const store = await getCaughtUpSharedEventStore(options.vaultPath);
        if (store === null) return false;
        // Same dep set the route's live fallback builds (server.ts
        // workGraphSummary): peek — never open — the canonical recall
        // store; absent pre-first-/v2/recall ⇒ counts default to 0.
        const { peekRecallV2Store } = await import('../recall-v2/pipeline.js');
        const canonicalRecallStore = await peekRecallV2Store(options.vaultPath);
        const report = await collectWorkGraphHealth({
          vaultRoot: options.vaultPath,
          eventLog,
          connectionsDiagnostics,
          ...(canonicalRecallStore === undefined ? {} : { canonicalRecallStore }),
        });
        await writeWorkGraphHealthArtifact(options.vaultPath, report);
        return true;
      } catch {
        // Best-effort: the serve side falls back to live compute when
        // no (fresh) artifact exists.
        return false;
      }
    };
    const workGraphArtifactScheduler = createWorkGraphHealthArtifactScheduler({
      materialize: materializeWorkGraphHealthArtifact,
      enabled: eventStoreEnabled,
    });
    const scheduleWorkGraphHealthArtifact = workGraphArtifactScheduler.schedule;
    teardown.push(workGraphArtifactScheduler.teardown);
    // Drain-time PRD §15 falsifiability artifact (system/section15Artifact.ts).
    // Same discipline as the workGraph artifact: typed event reads
    // (forEachChunkOfTypes) + a bounded audit-file scan materialized after
    // each successful drain, served from disk by GET /v1/system/section15.
    // The ≥7-clean-days streak (criterion 6) is folded here from the
    // event-lane counters + the store reconciliation delta — the exact
    // dataLoss.clean the health surface computes — so a restart never
    // resets the streak (the folded per-day ledger lives in the artifact).
    // Reuses the workGraph scheduler factory (generic debounce/floor/
    // single-flight); errors swallowed — observability must never surface
    // as a drain failure.
    const materializeSection15Artifact = async (): Promise<boolean> => {
      try {
        const store = await getCaughtUpSharedEventStore(options.vaultPath);
        if (store === null) return false;
        // dataLoss.clean, computed exactly as /v1/system/health does:
        // every process-lifetime lane counter zero AND the store
        // reconciliation delta zero. count()/watermark() are single
        // indexed queries — never a JSONL scan.
        const watermark = store.watermark();
        const expectedFromWatermark = Object.values(watermark).reduce((sum, seq) => sum + seq, 0);
        const reconciliationClean = expectedFromWatermark - store.count() === 0;
        const dataLossClean = !anyLaneCounterNonZero(getEventLaneHealth()) && reconciliationClean;
        await writeSection15Artifact({
          vaultRoot: options.vaultPath,
          eventLog,
          dataLossClean,
        });
        return true;
      } catch {
        return false;
      }
    };
    const section15ArtifactScheduler = createWorkGraphHealthArtifactScheduler({
      materialize: materializeSection15Artifact,
      enabled: eventStoreEnabled,
    });
    const scheduleSection15Artifact = section15ArtifactScheduler.schedule;
    teardown.push(section15ArtifactScheduler.teardown);
    const server = createCompanionHttpServer({
      bridgeKey: ensured.key,
      // F02: classify MCP callers by this key so the auth gate can apply
      // workstream-trust enforcement. Always set (generated at boot).
      mcpBridgeKey: ensuredMcpKey.key,
      vaultWriter,
      vaultRoot: options.vaultPath,
      serviceInstaller: pickInstaller(),
      idempotencyStore,
      allowAutoUpdate: options.allowAutoUpdate ?? false,
      startedAt: new Date(),
      bucketRegistry: createBucketRegistry(options.vaultPath),
      getEventLoopSnapshot: eventLoopMonitor.snapshot,
      getEmbedderStatus,
      ...(collectorFramework === null
        ? {}
        : {
            collectorFramework: {
              loadedCollectors: collectorFramework.loadedCollectors,
              quarantineCountFor: collectorFramework.quarantineCountFor,
              replayCollector: collectorFramework.replayCollector,
              // Patch 1 (post-review): expose gate resolver + last-
              // promoted-at on the HTTP context so the route handler
              // populates capability_gates and last_promoted_at fields.
              resolveGate: (collectorId, capability) =>
                gateStateForCollector(cachedPrivacyProjection, collectorId, capability, true),
              lastPromotedAtFor: collectorFramework.lastPromotedAtFor,
            },
          }),
      hygieneStatus,
      recallLifecycle,
      recallActivity,
      replica,
      eventLog,
      projectionChanges,
      syncMaterializerHealth: () => syncContractRunner.health(),
      connectionsDiagnostics,
      // Class F edge-event import path: plugin-originated events
      // (e.g. browser.timeline.observed) arrive pre-shaped with an
      // edge dot allocated by the plugin. Earlier turns relayed those
      // edge events as-is, but the relay enforces an IDENTITY_MISMATCH
      // check (publish.replica_id must match the transport's subscribed
      // replica_id) so cross-replica timeline sync was silently failing
      // — peer companions never observed timeline visits.
      //
      // Phase 4 fix: re-stamp under the companion's MAIN replica via
      // appendClientObserved. The plugin's clientEventId still gates
      // dedupe (appendClient line ~349 short-circuits if the
      // clientEventId already exists), so re-deliveries from the same
      // plugin remain idempotent. The decorated eventLog's
      // onLocalAccepted then publishes via the relay under the main
      // replica id, which IS what the relay subscription is bound to,
      // so peer companions correctly receive the event.
      importEdgeEvent: async (event) => {
        const existing = await baseEventLog.findByClientEventId(event.clientEventId);
        if (existing !== null) {
          return { imported: false };
        }
        await eventLog.appendClientObserved({
          clientEventId: event.clientEventId,
          aggregateId: event.aggregateId,
          type: event.type,
          payload: event.payload as Record<string, unknown>,
          baseVector: {},
        });
        return { imported: true };
      },
      // P2 — batched edge-event ingest. The plugin's ~1-min flush
      // imports a whole buffered batch; per-event importEdgeEvent did
      // ~3 whole-log scans each (~quadratic; 39s on backlog). One
      // readMerged + dedupe + shard write for the batch.
      //
      // The onAccepted hook is still required. Edge events include
      // navigation.committed / engagement signals that the connections
      // materializer handles incrementally; without this hook accepted
      // edge batches sit in the event log until some unrelated catchUp,
      // which is exactly the "fresh HN click still says Direct / no
      // signals" tail.
      importEdgeEvents: async (events) =>
        appendObservedEdgeEventsBatch(eventLog, events, onLocalAccepted),
      // Batched timeline ingest — `POST /v1/timeline/events`. Same
      // ONE-readMerged dedupe as importEdgeEvents (vs the singular
      // importEdgeEvent's per-event whole-log scan, measured at
      // 0.4-3.4 s/POST). The difference: timeline events MUST still
      // be dispatched per event — the timeline / projection /
      // extraction materializers are dirty-bit + event-driven and
      // `runner.catchUpAll` runs at startup only, so a batch append
      // that skipped dispatch would leave the daily timeline
      // projection stale. Passing `onLocalAccepted` as the hook
      // reproduces the singular path's dispatch exactly (contract
      // runner + relay publish + privacy refresh), per event, while
      // the dedupe scan is amortized once over the batch.
      importTimelineEvents: async (events) => {
        const results = await eventLog.appendClientObservedBatch(
          events.map((event) => ({
            clientEventId: event.clientEventId,
            aggregateId: event.aggregateId,
            type: event.type,
            payload: event.payload as Record<string, unknown>,
            baseVector: {},
          })),
          onLocalAccepted,
        );
        // D — fast page evidence. Write the page-evidence record
        // (metadata_only, + indexed-chunks upgrade if content was
        // already extracted) for each observed URL right after
        // ingest, so `/v1/page-evidence/summary` — the side-panel
        // badge poll — resolves on its next tick. Previously the only
        // writer of these records was the connections reconcile
        // (`ensurePageEvidenceForTimelineEntries` inside the ~3-min
        // buildVisitSimilarity cycle), so a freshly-navigated page's
        // badge was reconcile-gated. Fire-and-forget — it must add
        // zero latency to the ingest response (B's whole point);
        // `rebuildManifestAfterWrite:false` keeps it to per-URL record
        // writes (the badge reads record files directly). The
        // reconcile still runs the bulk ensure as the catchUp /
        // peer-event backstop and rebuilds the manifest.
        const observed = events.flatMap((event) => {
          const p = event.payload as Record<string, unknown>;
          const url = p['url'];
          if (typeof url !== 'string') return [];
          const observedAt =
            typeof p['observedAt'] === 'string' ? p['observedAt'] : new Date().toISOString();
          return [
            {
              id: event.clientEventId,
              url,
              ...(typeof p['canonicalUrl'] === 'string' ? { canonicalUrl: p['canonicalUrl'] } : {}),
              ...(typeof p['title'] === 'string' ? { title: p['title'] } : {}),
              ...(typeof p['provider'] === 'string'
                ? { provider: p['provider'] as TimelineProvider }
                : {}),
              firstSeenAt: observedAt,
              lastSeenAt: observedAt,
              visitCount: 1,
              ...(p['dimensions'] === undefined ? {} : { dimensions: p['dimensions'] }),
            },
          ];
        });
        if (observed.length > 0) {
          void pageEvidenceWriteQueue(observed).catch(() => undefined);
        }
        return results;
      },
      timelineStore,
      connectionsStore,
      refreshConnections: async () => {
        await connectionsMaterializer.catchUp(baseEventLog);
        await connectionsMaterializer.awaitIdle();
      },
      serviceInstallDefaults: {
        port: options.port,
        ...(options.service?.companionCommand === undefined
          ? {}
          : { companionCommand: options.service.companionCommand }),
        ...(options.mcp === undefined ? {} : { mcpPort: options.mcp.port }),
        ...(options.service?.mcpBin === undefined ? {} : { mcpBin: options.service.mcpBin }),
        ...(options.service?.syncRelayLocalPort === undefined
          ? {}
          : { syncRelayLocalPort: options.service.syncRelayLocalPort }),
        ...(options.service?.syncRelay === undefined
          ? {}
          : { syncRelay: options.service.syncRelay }),
      },
      ...(options.relay === undefined
        ? {}
        : {
            sync: {
              relay: {
                url: options.relay.url,
                mode: options.relay.mode ?? 'remote',
              },
              // Health endpoint reads the live transport state on
              // every request so the side panel can flip the
              // relay-down banner the moment the relay drops. Null
              // when the transport hasn't been wired (offline tests).
              getRelayStatus: () =>
                relayTransport === null ? null : getRelayTransportStatus(relayTransport),
            },
          }),
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      vaultChanges: {
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        subscriberCount: () => listeners.size,
      },
    });
    const started: StartedHttpServer = await startHttpServer(server, options.port);

    return {
      url: started.url,
      vaultPath: options.vaultPath,
      bridgeKey: ensured.key,
      bridgeKeyPath: ensured.path,
      bridgeKeyCreated: ensured.created,
      mcpKey: ensuredMcpKey.key,
      mcpKeyPath: ensuredMcpKey.path,
      replicaId: replica.replicaId,
      replicaIdCreated: replica.created,
      close: async () => {
        clearInterval(idempotencyGc);
        clearInterval(auditRetention);
        if (relayTransport !== null) stopRelayTransport(relayTransport);
        await watcher?.close();
        await started.close();
        // Drain the contract runner FIRST — extraction/projection/recall
        // materializers may still be processing accepted events.
        // Without this drain, a recall materializer ingest could be
        // mid-write when we release the lock, and the next companion
        // starting up would race the still-running background write.
        // Reviewer-flagged ordering.
        await syncContractRunner.awaitIdle();
        // Then wait for any rebuild that those materializers (or a
        // direct path) kicked off.
        await recallLifecycle.waitForRebuild();
        await recallLock.release();
      },
    };
  } catch (error) {
    // Startup failed partway through. Roll back every side-effect
    // we registered so the process can actually exit. Without this,
    // setInterval handles + the recall lock would strand the
    // process despite cli.ts setting exitCode=1 — the event loop
    // would never drain and the lock file would still point at our
    // pid, blocking the next launch on the recovery's stale-pid
    // takeover path.
    await runTeardown();
    throw error;
  }
};
