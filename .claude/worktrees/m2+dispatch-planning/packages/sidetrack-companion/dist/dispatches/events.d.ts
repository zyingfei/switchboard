export declare const DISPATCH_RECORDED: "dispatch.recorded";
export declare const DISPATCH_LINKED: "dispatch.linked";
export type DispatchEventType = typeof DISPATCH_RECORDED | typeof DISPATCH_LINKED;
export interface DispatchRecordedPayload {
    readonly bac_id: string;
    readonly target: {
        readonly provider: string;
    };
    readonly workstreamId?: string;
    readonly createdAt: string;
    readonly body: string;
    readonly sourceThreadId?: string;
    readonly mcpRequest?: {
        readonly codingSessionId: string;
    };
    readonly title?: string;
}
export interface DispatchLinkedPayload {
    readonly dispatchId: string;
    readonly threadId: string;
}
export declare const isDispatchRecordedPayload: (value: unknown) => value is DispatchRecordedPayload;
export declare const isDispatchLinkedPayload: (value: unknown) => value is DispatchLinkedPayload;
//# sourceMappingURL=events.d.ts.map