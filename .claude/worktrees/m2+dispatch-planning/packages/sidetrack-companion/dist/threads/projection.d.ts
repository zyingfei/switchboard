import { type AcceptedEvent, type RegisterProjection, type VersionVector } from '../sync/causal.js';
import { type ThreadStatus, type ThreadTrackingMode } from './events.js';
export interface ThreadProjectionRecord {
    readonly bac_id: string;
    readonly provider: string;
    readonly threadUrl: string;
    readonly title: string;
    readonly lastSeenAt: string;
    readonly tags: readonly string[];
    readonly primaryWorkstreamId?: string;
    readonly trackingMode?: ThreadTrackingMode;
}
export interface ThreadProjection {
    readonly bac_id: string;
    readonly record: RegisterProjection<ThreadProjectionRecord>;
    readonly status: RegisterProjection<ThreadStatus>;
    readonly deleted: boolean;
    readonly vector: VersionVector;
    readonly updatedAtMs: number;
}
export declare const projectThread: (bacId: string, events: readonly AcceptedEvent[]) => ThreadProjection;
//# sourceMappingURL=projection.d.ts.map