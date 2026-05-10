import { WebSocket as WsWebSocket } from 'ws';
import type { KnownReplicasStore } from './knownReplicas.js';
import { type ReplicaKeyPair } from './relayCrypto.js';
import type { LogTransport } from './transport.js';
export interface RelayTransportOptions {
    readonly relayUrl: string;
    readonly rendezvousSecret: Buffer;
    readonly localReplicaId: string;
    readonly localKeyPair: ReplicaKeyPair;
    readonly knownReplicas: KnownReplicasStore;
    readonly fetchWebSocket?: (url: string) => WsWebSocket;
    readonly random?: () => number;
    readonly logger?: (level: 'info' | 'warn' | 'error', message: string) => void;
}
export declare const createRelayTransport: (options: RelayTransportOptions) => LogTransport;
export interface RelayTransportStatus {
    readonly connected: boolean;
    readonly lastConnectedAtMs?: number;
    readonly lastDisconnectedAtMs?: number;
    readonly consecutiveFailures: number;
    readonly pendingPublishes: number;
}
export declare const getRelayTransportStatus: (transport: LogTransport) => RelayTransportStatus | null;
export declare const stopRelayTransport: (transport: LogTransport) => void;
//# sourceMappingURL=relayTransport.d.ts.map