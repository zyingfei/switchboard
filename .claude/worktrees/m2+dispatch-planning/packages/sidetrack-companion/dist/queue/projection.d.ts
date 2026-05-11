import { type AcceptedEvent, type RegisterProjection, type VersionVector } from '../sync/causal.js';
import { type QueueScope, type QueueStatus } from './events.js';
export interface QueueItemProjection {
    readonly bac_id: string;
    readonly base?: {
        readonly text: string;
        readonly scope: QueueScope;
        readonly targetId?: string;
        readonly createdBy: {
            readonly replicaId: string;
            readonly seq: number;
        };
    };
    readonly status: RegisterProjection<QueueStatus>;
    readonly vector: VersionVector;
    readonly updatedAtMs: number;
}
export declare const projectQueueItem: (bacId: string, events: readonly AcceptedEvent[]) => QueueItemProjection;
//# sourceMappingURL=projection.d.ts.map