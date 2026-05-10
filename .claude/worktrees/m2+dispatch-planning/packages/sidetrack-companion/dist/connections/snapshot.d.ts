import type { AcceptedEvent } from '../sync/causal.js';
import type { TimelineDayProjection } from '../timeline/projection.js';
import { type ConnectionEdge, type ConnectionNode, type ConnectionsSnapshot, type ConnectionsSnapshotScope } from './types.js';
export type { ConnectionsSnapshot } from './types.js';
export interface ThreadVaultRecord {
    readonly bac_id: string;
    readonly title?: string;
    readonly threadUrl?: string;
    readonly canonicalUrl?: string;
    readonly provider?: string;
    readonly lastSeenAt?: string;
    readonly primaryWorkstreamId?: string;
}
export interface WorkstreamVaultRecord {
    readonly bac_id: string;
    readonly title?: string;
    readonly parentId?: string;
    readonly children?: readonly string[];
    readonly tags?: readonly string[];
    readonly privacy?: string;
}
export interface DispatchVaultRecord {
    readonly bac_id: string;
    readonly title?: string;
    readonly target?: {
        readonly provider?: string;
    };
    readonly status?: string;
    readonly createdAt?: string;
    readonly sourceThreadId?: string;
    readonly workstreamId?: string;
    readonly mcpRequest?: {
        readonly codingSessionId?: string;
    };
}
export interface QueueVaultRecord {
    readonly bac_id: string;
    readonly title?: string;
    readonly scope?: string;
    readonly targetId?: string;
    readonly status?: string;
    readonly createdAt?: string;
    readonly threadId?: string;
    readonly workstreamId?: string;
}
export interface ReminderVaultRecord {
    readonly bac_id?: string;
    readonly threadId: string;
    readonly provider?: string;
    readonly detectedAt?: string;
    readonly status?: string;
}
export interface CodingSessionVaultRecord {
    readonly bac_id: string;
    readonly workstreamId?: string;
    readonly tool?: string;
    readonly cwd?: string;
    readonly branch?: string;
    readonly name?: string;
    readonly attachedAt?: string;
    readonly lastSeenAt?: string;
    readonly status?: string;
}
export interface ConnectionsInput {
    readonly events: readonly AcceptedEvent[];
    readonly threads: readonly ThreadVaultRecord[];
    readonly workstreams: readonly WorkstreamVaultRecord[];
    readonly dispatches: readonly DispatchVaultRecord[];
    readonly queueItems: readonly QueueVaultRecord[];
    readonly reminders: readonly ReminderVaultRecord[];
    readonly codingSessions: readonly CodingSessionVaultRecord[];
    readonly timelineDays: readonly TimelineDayProjection[];
    readonly scope?: ConnectionsSnapshotScope;
}
export declare const buildConnectionsSnapshot: (input: ConnectionsInput) => ConnectionsSnapshot;
export interface ConnectionsStore {
    readonly putCurrent: (snapshot: ConnectionsSnapshot) => Promise<void>;
    readonly readCurrent: () => Promise<ConnectionsSnapshot | null>;
    readonly putDay: (date: string, snapshot: ConnectionsSnapshot) => Promise<void>;
    readonly readDay: (date: string) => Promise<ConnectionsSnapshot | null>;
    readonly listDays: () => Promise<readonly string[]>;
}
export declare const createConnectionsStore: (vaultRoot: string) => ConnectionsStore;
export declare const subgraphForNode: (snapshot: ConnectionsSnapshot, nodeId: string, hops: number) => ConnectionsSnapshot;
export declare const findPath: (snapshot: ConnectionsSnapshot, fromNodeId: string, toNodeId: string, maxHops?: number) => {
    found: true;
    nodes: readonly ConnectionNode[];
    edges: readonly ConnectionEdge[];
} | {
    found: false;
};
//# sourceMappingURL=snapshot.d.ts.map