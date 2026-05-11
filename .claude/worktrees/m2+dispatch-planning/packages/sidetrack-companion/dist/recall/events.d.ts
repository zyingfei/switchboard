export declare const CAPTURE_RECORDED: "capture.recorded";
export declare const RECALL_TOMBSTONE_TARGET: "recall.tombstone.target";
export type RecallEventType = typeof CAPTURE_RECORDED | typeof RECALL_TOMBSTONE_TARGET;
export interface CaptureTurnInputShape {
    readonly ordinal?: number;
    readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
    readonly text: string;
    readonly capturedAt?: string;
    readonly markdown?: string;
    readonly formattedText?: string;
    readonly modelName?: string;
}
export interface CaptureRecordedPayload {
    readonly bac_id: string;
    readonly threadId?: string;
    readonly threadUrl?: string;
    readonly provider?: string;
    readonly title?: string;
    readonly capturedAt: string;
    readonly turns: readonly CaptureTurnInputShape[];
}
export interface RecallTombstonePayload {
    readonly threadId: string;
}
export declare const isCaptureRecordedPayload: (value: unknown) => value is CaptureRecordedPayload;
export declare const isRecallTombstonePayload: (value: unknown) => value is RecallTombstonePayload;
//# sourceMappingURL=events.d.ts.map