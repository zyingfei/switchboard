export declare const WORKSTREAM_UPSERTED: "workstream.upserted";
export declare const WORKSTREAM_DELETED: "workstream.deleted";
export type WorkstreamEventType = typeof WORKSTREAM_UPSERTED | typeof WORKSTREAM_DELETED;
export type WorkstreamPrivacy = 'private' | 'shared' | 'public';
export interface WorkstreamChecklistItem {
    readonly id: string;
    readonly text: string;
    readonly checked: boolean;
}
export interface WorkstreamUpsertedPayload {
    readonly bac_id: string;
    readonly title: string;
    readonly parentId?: string;
    readonly privacy?: WorkstreamPrivacy;
    readonly screenShareSensitive?: boolean;
    readonly tags?: readonly string[];
    readonly children?: readonly string[];
    readonly checklist?: readonly WorkstreamChecklistItem[];
    readonly description?: string;
}
export interface WorkstreamDeletedPayload {
    readonly bac_id: string;
}
export declare const isWorkstreamUpsertedPayload: (value: unknown) => value is WorkstreamUpsertedPayload;
export declare const isWorkstreamDeletedPayload: (value: unknown) => value is WorkstreamDeletedPayload;
//# sourceMappingURL=events.d.ts.map