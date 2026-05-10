import type { AcceptedEvent } from './causal.js';
export interface LogTransport {
    readonly publishEvent: (replicaId: string, event: AcceptedEvent) => Promise<void>;
    readonly subscribePeers: (knownReplicas: ReadonlySet<string>, onEvent: (replicaId: string, event: AcceptedEvent) => void) => () => void;
}
export interface InMemoryTransport extends LogTransport {
    readonly drain: () => void;
}
export declare const createInMemoryTransport: () => InMemoryTransport;
export interface LocalFsTransportOptions {
    readonly localReplicaId: string;
    readonly subscribePaths: (listener: (relPath: string) => void) => () => void;
    readonly readReplica: (replicaId: string) => Promise<readonly AcceptedEvent[]>;
    readonly listReplicaIds: () => Promise<readonly string[]>;
}
export declare const createLocalFsTransport: (opts: LocalFsTransportOptions) => LogTransport;
//# sourceMappingURL=transport.d.ts.map