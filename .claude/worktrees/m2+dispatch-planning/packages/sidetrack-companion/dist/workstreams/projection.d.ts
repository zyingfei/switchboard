import { type AcceptedEvent, type RegisterProjection, type VersionVector } from '../sync/causal.js';
import { type WorkstreamChecklistItem, type WorkstreamPrivacy } from './events.js';
export interface WorkstreamProjectionRecord {
    readonly bac_id: string;
    readonly title: string;
    readonly parentId?: string;
    readonly privacy?: WorkstreamPrivacy;
    readonly screenShareSensitive?: boolean;
    readonly tags: readonly string[];
    readonly children: readonly string[];
    readonly checklist: readonly WorkstreamChecklistItem[];
    readonly description?: string;
}
export interface WorkstreamProjection {
    readonly bac_id: string;
    readonly record: RegisterProjection<WorkstreamProjectionRecord>;
    readonly deleted: boolean;
    readonly vector: VersionVector;
    readonly updatedAtMs: number;
}
export declare const projectWorkstream: (bacId: string, events: readonly AcceptedEvent[]) => WorkstreamProjection;
//# sourceMappingURL=projection.d.ts.map