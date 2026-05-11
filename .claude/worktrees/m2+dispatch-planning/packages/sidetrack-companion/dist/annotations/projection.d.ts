import { type AcceptedEvent, type RegisterProjection, type VersionVector } from '../sync/causal.js';
import { type SerializedAnchor } from './events.js';
export interface AnnotationProjectionEntry {
    readonly bac_id: string;
    readonly url: string;
    readonly anchor: SerializedAnchor;
    readonly note: RegisterProjection<string>;
    readonly pageTitle?: string;
    readonly deleted: boolean;
    readonly createdBy: {
        readonly replicaId: string;
        readonly seq: number;
    };
}
export interface AnnotationsProjection {
    readonly entries: readonly AnnotationProjectionEntry[];
    readonly vector: VersionVector;
    readonly updatedAtMs: number;
}
export declare const projectAnnotations: (events: readonly AcceptedEvent[]) => AnnotationsProjection;
//# sourceMappingURL=projection.d.ts.map