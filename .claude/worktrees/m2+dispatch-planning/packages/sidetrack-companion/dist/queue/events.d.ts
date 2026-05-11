export declare const QUEUE_CREATED: "queue.created";
export declare const QUEUE_STATUS_SET: "queue.statusSet";
export type QueueEventType = typeof QUEUE_CREATED | typeof QUEUE_STATUS_SET;
export type QueueScope = 'thread' | 'workstream' | 'global';
export type QueueStatus = 'pending' | 'done' | 'dismissed';
export interface QueueCreatedPayload {
    readonly bac_id: string;
    readonly text: string;
    readonly scope: QueueScope;
    readonly targetId?: string;
    readonly status?: QueueStatus;
}
export interface QueueStatusSetPayload {
    readonly bac_id: string;
    readonly status: QueueStatus;
}
export declare const isQueueCreatedPayload: (value: unknown) => value is QueueCreatedPayload;
export declare const isQueueStatusSetPayload: (value: unknown) => value is QueueStatusSetPayload;
//# sourceMappingURL=events.d.ts.map