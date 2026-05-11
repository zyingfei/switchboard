import { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type Installer } from '../install/index.js';
import type { RecallLifecycle } from '../recall/lifecycle.js';
import type { BucketRegistry } from '../routing/registry.js';
import { type UpdateAdvisory } from '../system/versionCheck.js';
import type { VaultChangeEvent } from '../vault/watcher.js';
import { type VaultWriter } from '../vault/writer.js';
import type { IdempotencyStore } from './idempotency.js';
export interface CompanionHttpConfig {
    readonly bridgeKey: string;
    readonly vaultWriter: VaultWriter;
    readonly vaultRoot?: string;
    readonly serviceInstaller?: Installer;
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