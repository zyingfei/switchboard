import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type Installer, type InstallOptions } from '../install/index.js';
import type { RecallActivityTracker } from '../recall/activity.js';
import type { RecallLifecycle } from '../recall/lifecycle.js';
import type { BucketRegistry } from '../routing/registry.js';
import type { EventLog } from '../sync/eventLog.js';
import type { ProjectionChangeFeed } from '../sync/projectionChanges.js';
import type { ReplicaContext } from '../sync/replicaId.js';
import { type UpdateAdvisory } from '../system/versionCheck.js';
import type { VaultChangeEvent } from '../vault/watcher.js';
import { type VaultWriter } from '../vault/writer.js';
import type { IdempotencyStore } from './idempotency.js';
export interface CompanionHttpConfig {
    readonly bridgeKey: string;
    readonly vaultWriter: VaultWriter;
    readonly vaultRoot?: string;
    readonly serviceInstaller?: Installer;
    readonly serviceInstallDefaults?: Omit<InstallOptions, 'vaultPath'>;
    readonly sync?: {
        readonly relay?: {
            readonly mode: 'local' | 'remote';
            readonly url: string;
        };
        readonly getRelayStatus?: () => {
            readonly connected: boolean;
            readonly lastConnectedAtMs?: number;
            readonly lastDisconnectedAtMs?: number;
            readonly consecutiveFailures: number;
            readonly pendingPublishes: number;
        } | null;
    };
    readonly updateChecker?: () => Promise<UpdateAdvisory>;
    readonly idempotencyStore?: IdempotencyStore;
    readonly allowAutoUpdate?: boolean;
    readonly startedAt?: Date;
    readonly bucketRegistry?: BucketRegistry;
    readonly vaultChanges?: {
        readonly subscribe: (listener: (event: VaultChangeEvent) => void) => () => void;
    };
    readonly hygieneStatus?: {
        lastIdempotencyGcAt?: string;
        lastAuditRetentionAt?: string;
    };
    readonly recallLifecycle?: RecallLifecycle;
    readonly recallActivity?: RecallActivityTracker;
    readonly replica?: ReplicaContext;
    readonly eventLog?: EventLog;
    readonly syncMaterializerHealth?: () => Record<string, {
        readonly status: 'healthy' | 'degraded' | 'failed';
        readonly lastSuccessAt: string | null;
        readonly lastError: string | null;
        readonly pending: boolean;
    }>;
    readonly projectionChanges?: ProjectionChangeFeed;
    readonly mcp?: {
        readonly port: number;
        readonly authKey: string;
    };
    readonly importEdgeEvent?: (event: import('../sync/causal.js').AcceptedEvent) => Promise<{
        imported: boolean;
    }>;
    readonly timelineStore?: import('../timeline/projection.js').TimelineStore;
    readonly connectionsStore?: import('../connections/snapshot.js').ConnectionsStore;
}
export interface StartedHttpServer {
    readonly server: Server;
    readonly port: number;
    readonly url: string;
    readonly close: () => Promise<void>;
}
export declare const createCompanionHttpServer: (context: CompanionHttpConfig) => Server;
export declare const handleRequest: (request: IncomingMessage, response: ServerResponse, context: CompanionHttpConfig) => Promise<void>;
export declare const startHttpServer: (server: Server, port: number) => Promise<StartedHttpServer>;
//# sourceMappingURL=server.d.ts.map