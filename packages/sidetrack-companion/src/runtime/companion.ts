import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { createIdempotencyStore } from '../http/idempotency.js';
import { pickInstaller } from '../install/index.js';
import { createRecallActivityTracker } from '../recall/activity.js';
import { createRecallLifecycle } from '../recall/lifecycle.js';
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
import { createEventLog } from '../sync/eventLog.js';
import { createKnownReplicasStore } from '../sync/knownReplicas.js';
import { createProjectionChangeFeed } from '../sync/projectionChanges.js';
import { runImportProjectors } from '../sync/projectors.js';
import { createRelayTransport, stopRelayTransport } from '../sync/relayTransport.js';
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
    // Base64url-encoded shared secret (≥ 16 bytes after decoding).
    readonly rendezvousSecret: string;
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
  const ensured = await ensureBridgeKey(options.vaultPath);
  const replica = await loadOrCreateReplica(options.vaultPath);
  // Refuse startup if another live process owns the recall index
  // for this vault — concurrent writers would corrupt the binary.
  // The lock takeover for stale (PID-dead) entries happens inside
  // acquireRecallProcessLock; we only error out for live races.
  const recallLock: RecallProcessLock = await acquireRecallProcessLock(options.vaultPath);
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
  const hygieneStatus: { lastIdempotencyGcAt?: string; lastAuditRetentionAt?: string } = {};
  const idempotencyGc = setInterval(() => {
    void idempotencyStore.gcExpired?.(new Date()).then(() => {
      hygieneStatus.lastIdempotencyGcAt = new Date().toISOString();
    });
  }, 60 * 60 * 1000);
  const auditRetention = setInterval(() => {
    void enforceRetention(options.vaultPath).then(() => {
      hygieneStatus.lastAuditRetentionAt = new Date().toISOString();
    });
  }, 24 * 60 * 60 * 1000);
  const recallActivity = createRecallActivityTracker();
  const baseEventLog = createEventLog(options.vaultPath, replica);
  const projectionChanges = createProjectionChangeFeed(options.vaultPath);

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
    relayTransport.subscribePeers(new Set(), (_replicaId, event) => {
      void (async () => {
        try {
          const result = await baseEventLog.importPeerEvent(event);
          if (result.imported) {
            await runImportProjectors(
              {
                vaultRoot: options.vaultPath,
                eventLog: baseEventLog,
                projectionChanges,
              },
              event,
            );
          }
        } catch {
          // importPeerEvent surfaces DotCollisionError /
          // ClientEventIdReuseError; the relay drops the offending
          // peer and the user gets a side-panel alert (TODO).
        }
      })();
    });
  }

  // Decorate the eventLog with an after-accept publish hook so
  // outbound events fan out via the relay (and any future transports
  // wired up here) without each callsite having to know about them.
  const eventLog = {
    ...baseEventLog,
    appendClient: async <T extends Record<string, unknown>>(
      input: Parameters<typeof baseEventLog.appendClient<T>>[0],
    ) => {
      const accepted = await baseEventLog.appendClient(input);
      if (relayTransport !== null) {
        void relayTransport
          .publishEvent(accepted.dot.replicaId, accepted)
          .catch(() => undefined);
      }
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
  // Don't block startup on the rebuild — health endpoint will report
  // status: 'rebuilding' until the background task completes.
  void recallLifecycle.ensureFresh();
  const server = createCompanionHttpServer({
    bridgeKey: ensured.key,
    vaultWriter,
    vaultRoot: options.vaultPath,
    serviceInstaller: pickInstaller(),
    idempotencyStore,
    allowAutoUpdate: options.allowAutoUpdate ?? false,
    startedAt: new Date(),
    bucketRegistry: createBucketRegistry(options.vaultPath),
    hygieneStatus,
    recallLifecycle,
    recallActivity,
    replica,
    eventLog,
    projectionChanges,
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
      // Wait for in-flight rebuild + auto-index to complete before
      // releasing the lock — that way another companion starting
      // immediately after us doesn't race with a still-running
      // background write.
      await recallLifecycle.waitForRebuild();
      await recallLock.release();
    },
  };
};
