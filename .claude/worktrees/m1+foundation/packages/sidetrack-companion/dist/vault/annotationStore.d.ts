import { type SerializedAnchor } from '../http/schemas.js';
export interface Annotation {
    readonly bac_id: string;
    readonly url: string;
    readonly pageTitle: string;
    readonly anchor: SerializedAnchor;
    readonly note: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly deletedAt: string | null;
    readonly revisions: readonly {
        readonly at: string;
        readonly note: string;
    }[];
}
export declare const writeAnnotation: (vaultRoot: string, input: Omit<Annotation, "bac_id" | "createdAt" | "updatedAt" | "deletedAt" | "revisions"> & {
    readonly bac_id?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly deletedAt?: string | null;
    readonly revisions?: readonly {
        readonly at: string;
        readonly note: string;
    }[];
}) => Promise<Annotation>;
export declare const listAnnotations: (vaultRoot: string, filter?: {
    readonly url?: string;
    readonly includeDeleted?: boolean;
}) => Promise<readonly Annotation[]>;
export declare const updateAnnotation: (vaultRoot: string, bac_id: string, patch: {
    readonly note: string;
}) => Promise<Annotation>;
export declare const softDeleteAnnotation: (vaultRoot: string, bac_id: string) => Promise<Annotation>;
//# sourceMappingURL=annotationStore.d.ts.map