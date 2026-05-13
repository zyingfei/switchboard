import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { createIdempotencyStore } from '../http/idempotency.js';
import { pickInstaller } from '../install/index.js';
import { createRecallActivityTracker } from '../recall/activity.js';
import { createRecallLifecycle } from '../recall/lifecycle.js';
import {
  bootCollectorFramework,
  type CollectorFrameworkHandle,
} from '../collectors/framework/runtime.js';
import {
  gateStateForCollector,
  type CollectorCapability,
} from '../collectors/framework/capabilityGates.js';
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
import { createEventLog } from '../sync/eventLog.js';
import { createKnownReplicasStore } from '../sync/knownReplicas.js';
import { createProjectionChangeFeed } from '../sync/projectionChanges.js';
import { createExtractionMaterializer } from '../sync/contract/extractionMaterializer.js';
import { createConnectionsMaterializer } from '../sync/contract/connectionsMaterializer.js';
import { createConnectionsStore } from '../connections/snapshot.js';
import { createTimelineMaterializer } from '../sync/contract/timelineMaterializer.js';
import { createTimelineStore } from '../timeline/projection.js';
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
import { createVaultWatcher, type VaultChangeEvent, type VaultWatcher } from '../vault/watcher.js';
import { createVaultWriter } from '../vault/writer.js';
import { COMPANION_VERSION } from '../version.js';

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
  // startup". Local checkout flow uses `node dist/cli.js` here, so no
  // public npm package is required.
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
  const idempotencyStore = createIdempotencyStore(options.vaultPath);
  const listeners = new Set<(event: VaultChangeEvent) => void>();
  let watcher: VaultWatcher | undefined;
  try {
    watcher = createVaultWatcher(options.vaultPath, {
      onChange: (event) => {
        for (const listener of listeners) {
          listener(event);
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
  const hygieneStatus: { lastIdempotencyGcAt?: string; lastAuditRetentionAt?: string } = {};
  const idempotencyGc = setInterval(
    () => {
      void idempotencyStore.gcExpired?.(new Date()).then(() => {
        hygieneStatus.lastIdempotencyGcAt = new Date().toISOString();
      });
    },
    60 * 60 * 1000,
  );
  teardown.push(() => clearInterval(idempotencyGc));
  const auditRetention = setInterval(
    () => {
      void enforceRetention(options.vaultPath).then(() => {
        hygieneStatus.lastAuditRetentionAt = new Date().toISOString();
      });
    },
    24 * 60 * 60 * 1000,
  );
  teardown.push(() => clearInterval(auditRetention));
  const recallActivity = createRecallActivityTracker();
  const baseEventLog = createEventLog(options.vaultPath, replica);
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
    }),
  );
  // Class B Connections — consumer-only materializer that joins
  // existing aggregates into an evidence graph. Same dirty-bit +
  // failure-cooldown pattern as timeline. Reads vault stores
  // (threads, workstreams, dispatches, queue, reminders, coding
  // sessions) + timeline daily projections at snapshot time.
  const connectionsStore = createConnectionsStore(options.vaultPath);
  const connectionsMaterializer = createConnectionsMaterializer({
    vaultRoot: options.vaultPath,
    eventLog: baseEventLog,
    timelineStore,
    store: connectionsStore,
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
  teardown.push(() => antiEntropy.stop());

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
      teardown.push(() => stopRelayTransport(t));
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
  const recallLifecycle = createRecallLifecycle({
    vaultRoot: options.vaultPath,
    companionVersion: COMPANION_VERSION,
    activity: recallActivity,
    replica: {
      replicaId: replica.replicaId,
      nextSeq: replica.nextSeq,
    },
    eventLog,
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
      const all = await baseEventLog.readMerged();
      cachedPrivacyProjection = projectPrivacy(
        all.filter(
          (e) =>
            e.type === PRIVACY_GATE_FLIPPED ||
            e.type === PRIVACY_PERMISSION_GRANTED ||
            e.type === PRIVACY_PERMISSION_REVOKED,
        ),
      );
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

  const appendCollectorAudit = async (
    route: string,
    subject: string,
  ): Promise<void> => {
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
        const eventTypeForLog =
          (event as { type?: string }).type ?? 'collector.unknown';
        await eventLog.appendServerObserved({
          clientEventId,
          aggregateId: ruleId,
          type: eventTypeForLog,
          payload: event as Record<string, unknown>,
        });
      },
      auditRoute: appendCollectorAudit,
      resolveGate: (collectorId, capability, defaultEnabled) =>
        gateStateForCollector(
          cachedPrivacyProjection,
          collectorId,
          capability as CollectorCapability,
          defaultEnabled,
        ),
    });
    {
      const handle = collectorFramework;
      teardown.push(() => handle.close());
    }
  } catch {
    collectorFramework = null;
  }
  // ────────────────────────────────────────────────────────────────

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
  const server = createCompanionHttpServer({
    bridgeKey: ensured.key,
    vaultWriter,
    vaultRoot: options.vaultPath,
    serviceInstaller: pickInstaller(),
    idempotencyStore,
    allowAutoUpdate: options.allowAutoUpdate ?? false,
    startedAt: new Date(),
    bucketRegistry: createBucketRegistry(options.vaultPath),
    getEventLoopSnapshot: eventLoopMonitor.snapshot,
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
              gateStateForCollector(
                cachedPrivacyProjection,
                collectorId,
                capability as CollectorCapability,
                true,
              ),
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
      ...(options.service?.syncRelay === undefined ? {} : { syncRelay: options.service.syncRelay }),
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
    },
  });
  const started: StartedHttpServer = await startHttpServer(server, options.port);

  return {
    url: started.url,
    vaultPath: options.vaultPath,
    bridgeKey: ensured.key,
    bridgeKeyPath: ensured.path,
    bridgeKeyCreated: ensured.created,
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
