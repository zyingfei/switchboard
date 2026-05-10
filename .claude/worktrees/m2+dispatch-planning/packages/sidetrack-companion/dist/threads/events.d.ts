export declare const THREAD_UPSERTED: "thread.upserted";
export declare const THREAD_ARCHIVED: "thread.archived";
export declare const THREAD_UNARCHIVED: "thread.unarchived";
export declare const THREAD_DELETED: "thread.deleted";
export type ThreadEventType = typeof THREAD_UPSERTED | typeof THREAD_ARCHIVED | typeof THREAD_UNARCHIVED | typeof THREAD_DELETED;
export type ThreadStatus = 'active' | 'tracked' | 'queued' | 'needs_organize' | 'closed' | 'restorable' | 'archived' | 'removed';
export type ThreadTrackingMode = 'auto' | 'manual' | 'stopped' | 'removed';
export interface ThreadUpsertedPayload {
    readonly bac_id: string;
    readonly provider: string;
    readonly threadUrl: string;
    readonly title: string;
    readonly lastSeenAt: string;
    readonly status?: ThreadStatus;
    readonly primaryWorkstreamId?: string;
    readonly tags?: readonly string[];
    readonly trackingMode?: ThreadTrackingMode;
}
export interface ThreadArchivedPayload {
    readonly bac_id: string;
}
export interface ThreadUnarchivedPayload {
    readonly bac_id: string;
}
export interface ThreadDeletedPayload {
    readonly bac_id: string;
}
export declare const isThreadUpsertedPayload: (value: unknown) => value is ThreadUpsertedPayload;
export declare const isThreadStatusPayload: (value: unknown) => value is ThreadArchivedPayload;
//# sourceMappingURL=events.d.ts.map