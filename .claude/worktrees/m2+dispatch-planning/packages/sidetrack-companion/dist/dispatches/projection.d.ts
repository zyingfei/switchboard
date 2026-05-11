import { type AcceptedEvent, type VersionVector } from '../sync/causal.js';
export interface DispatchProjectionEntry {
    readonly bac_id: string;
    readonly target: {
        readonly provider: string;
    };
    readonly workstreamId?: string;
    readonly createdAt: string;
    readonly body: string;
    readonly replicaId: string;
    readonly seq: number;
}
export interface DispatchLinkProjection {
    readonly dispatchId: string;
    readonly threadId?: string;
    readonly conflict?: readonly {
        readonly threadId: string;
        readonly replicaId: string;
    }[];
}
export interface DispatchesProjection {
    readonly entries: readonly DispatchProjectionEntry[];
    readonly links: readonly DispatchLinkProjection[];
    readonly vector: VersionVector;
    readonly updatedAtMs: number;
}
export declare const projectDispatches: (events: readonly AcceptedEvent[]) => DispatchesProjection;
//# sourceMappingURL=projection.d.ts.map