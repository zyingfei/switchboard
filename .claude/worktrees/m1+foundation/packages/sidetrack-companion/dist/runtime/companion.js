import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { createIdempotencyStore } from '../http/idempotency.js';
import { pickInstaller } from '../install/index.js';
import { createRecallLifecycle } from '../recall/lifecycle.js';
import { createBucketRegistry } from '../routing/registry.js';
import { createCompanionHttpServer, startHttpServer, } from '../http/server.js';
import { enforceRetention } from '../vault/auditRetention.js';
import { createVaultWatcher } from '../vault/watcher.js';
import { createVaultWriter } from '../vault/writer.js';
import { COMPANION_VERSION } from '../version.js';
export const startCompanion = async (options) => {
    const ensured = await ensureBridgeKey(options.vaultPath);
    const vaultWriter = createVaultWriter(options.vaultPath);
    const idempotencyStore = createIdempotencyStore(options.vaultPath);
    const listeners = new Set();
    let watcher;
    try {
        watcher = createVaultWatcher(options.vaultPath, {
            onChange: (event) => {
                for (const listener of listeners) {
                    listener(event);
                }
            },
        });
    }
    catch {
        watcher = undefined;
    }
    const hygieneStatus = {};
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
    const recallLifecycle = createRecallLifecycle({
        vaultRoot: options.vaultPath,
        companionVersion: COMPANION_VERSION,
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
        vaultChanges: {
            subscribe(listener) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
        },
    });
    const started = await startHttpServer(server, options.port);
    return {
        url: started.url,
        vaultPath: options.vaultPath,
        bridgeKey: ensured.key,
        bridgeKeyPath: ensured.path,
        bridgeKeyCreated: ensured.created,
        close: async () => {
            clearInterval(idempotencyGc);
            clearInterval(auditRetention);
            await watcher?.close();
            await started.close();
        },
    };
};
//# sourceMappingURL=companion.js.map