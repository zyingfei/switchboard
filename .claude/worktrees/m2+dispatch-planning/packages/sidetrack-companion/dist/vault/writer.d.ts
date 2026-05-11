import type { AuditEventRecord, AuditListQuery, CaptureEventInput, CodingAttachTokenCreateInput, CodingAttachTokenRecord, CodingSessionListQuery, CodingSessionRecord, CodingSessionRegisterInput, DispatchEventRecord, DispatchLinkRecord, DispatchListQuery, QueueCreateInput, ReminderCreateInput, ReminderUpdateInput, ReviewEvent, ReviewListQuery, SettingsDocument, SettingsPatchInput, ThreadUpsertInput, TurnRecord, TurnsQuery, WorkstreamCreateInput, WorkstreamUpdateInput } from '../http/schemas.js';
export interface MutationResult {
    readonly bac_id: string;
    readonly revision: string;
}
export declare class SettingsRevisionConflictError extends Error {
    constructor();
}
export declare class CodingAttachTokenInvalidError extends Error {
    constructor(message?: string);
}
export declare class CodingSessionNotFoundError extends Error {
    constructor();
}
export declare class WorkstreamHasChildrenError extends Error {
    readonly childCount: number;
    constructor(childCount: number);
}
export declare class WorkstreamNotFoundError extends Error {
    constructor();
}
export interface AuditEvent {
    readonly requestId: string;
    readonly route: string;
    readonly outcome: 'success' | 'failure';
    readonly bac_id?: string;
    readonly timestamp: string;
}
export interface VaultWriter {
    readonly status: () => Promise<'connected' | 'unreachable'>;
    readonly writeCaptureEvent: (input: CaptureEventInput, requestId: string) => Promise<MutationResult>;
    readonly readRecentTurns: (query: TurnsQuery) => Promise<readonly TurnRecord[]>;
    readonly writeDispatchEvent: (input: DispatchEventRecord, requestId: string) => Promise<{
        readonly bac_id: string;
        readonly status: 'recorded';
    }>;
    readonly readDispatchEvents: (query: DispatchListQuery) => Promise<readonly DispatchEventRecord[]>;
    readonly linkDispatchToThread: (input: {
        readonly dispatchId: string;
        readonly threadId: string;
    }, requestId: string) => Promise<DispatchLinkRecord>;
    readonly readLinkForDispatch: (dispatchId: string) => Promise<DispatchLinkRecord | null>;
    readonly readLinksForThread: (threadId: string) => Promise<readonly DispatchLinkRecord[]>;
    readonly readAuditEvents: (query: AuditListQuery) => Promise<readonly AuditEventRecord[]>;
    readonly writeReviewEvent: (input: ReviewEvent, requestId: string) => Promise<{
        readonly bac_id: string;
        readonly status: 'recorded';
    }>;
    readonly readReviewEvents: (query: ReviewListQuery) => Promise<readonly ReviewEvent[]>;
    readonly readSettings: () => Promise<SettingsDocument>;
    readonly updateSettings: (patch: SettingsPatchInput, revision: string) => Promise<SettingsDocument>;
    readonly upsertThread: (input: ThreadUpsertInput, requestId: string) => Promise<MutationResult>;
    readonly createWorkstream: (input: WorkstreamCreateInput, requestId: string) => Promise<MutationResult>;
    readonly updateWorkstream: (workstreamId: string, input: WorkstreamUpdateInput, requestId: string) => Promise<MutationResult>;
    readonly deleteWorkstream: (workstreamId: string, requestId: string) => Promise<{
        readonly bac_id: string;
        readonly detachedThreadIds: readonly string[];
    }>;
    readonly createQueueItem: (input: QueueCreateInput, requestId: string) => Promise<MutationResult>;
    readonly createReminder: (input: ReminderCreateInput, requestId: string) => Promise<MutationResult>;
    readonly updateReminder: (reminderId: string, input: ReminderUpdateInput, requestId: string) => Promise<MutationResult>;
    readonly createCodingAttachToken: (input: CodingAttachTokenCreateInput, requestId: string) => Promise<CodingAttachTokenRecord>;
    readonly registerCodingSession: (input: CodingSessionRegisterInput, requestId: string) => Promise<CodingSessionRecord>;
    readonly listCodingSessions: (query: CodingSessionListQuery) => Promise<readonly CodingSessionRecord[]>;
    readonly detachCodingSession: (bac_id: string, requestId: string) => Promise<CodingSessionRecord>;
    readonly bumpWorkstream: (bac_id: string, requestId: string) => Promise<MutationResult>;
    readonly archiveThread: (bac_id: string, requestId: string) => Promise<MutationResult>;
    readonly unarchiveThread: (bac_id: string, requestId: string) => Promise<MutationResult>;
}
export declare const createVaultWriter: (vaultPath: string) => VaultWriter;
//# sourceMappingURL=writer.d.ts.map