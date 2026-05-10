import { z } from 'zod';
declare const threadSchema: z.ZodObject<{
    bac_id: z.ZodString;
    provider: z.ZodOptional<z.ZodString>;
    threadId: z.ZodOptional<z.ZodString>;
    threadUrl: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    lastSeenAt: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
    primaryWorkstreamId: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$loose>;
declare const workstreamSchema: z.ZodObject<{
    bac_id: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodString>;
    children: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    checklist: z.ZodOptional<z.ZodArray<z.ZodUnknown>>;
    privacy: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const queueItemSchema: z.ZodObject<{
    bac_id: z.ZodString;
    text: z.ZodOptional<z.ZodString>;
    scope: z.ZodOptional<z.ZodString>;
    targetId: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const reminderSchema: z.ZodObject<{
    bac_id: z.ZodString;
    threadId: z.ZodOptional<z.ZodString>;
    provider: z.ZodOptional<z.ZodString>;
    detectedAt: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const codingSessionSchema: z.ZodObject<{
    bac_id: z.ZodString;
    workstreamId: z.ZodOptional<z.ZodString>;
    tool: z.ZodEnum<{
        claude_code: "claude_code";
        codex: "codex";
        cursor: "cursor";
        other: "other";
    }>;
    cwd: z.ZodString;
    branch: z.ZodString;
    sessionId: z.ZodString;
    name: z.ZodString;
    resumeCommand: z.ZodOptional<z.ZodString>;
    attachedAt: z.ZodString;
    lastSeenAt: z.ZodString;
    status: z.ZodEnum<{
        attached: "attached";
        detached: "detached";
    }>;
}, z.core.$loose>;
declare const dispatchEventSchema: z.ZodObject<{
    bac_id: z.ZodString;
    kind: z.ZodEnum<{
        other: "other";
        research: "research";
        review: "review";
        coding: "coding";
        note: "note";
    }>;
    target: z.ZodObject<{
        provider: z.ZodEnum<{
            claude_code: "claude_code";
            codex: "codex";
            cursor: "cursor";
            other: "other";
            chatgpt: "chatgpt";
            claude: "claude";
            gemini: "gemini";
        }>;
        mode: z.ZodEnum<{
            paste: "paste";
            "auto-send": "auto-send";
        }>;
    }, z.core.$strip>;
    sourceThreadId: z.ZodOptional<z.ZodString>;
    workstreamId: z.ZodOptional<z.ZodString>;
    title: z.ZodString;
    body: z.ZodString;
    createdAt: z.ZodISODateTime;
    redactionSummary: z.ZodObject<{
        matched: z.ZodNumber;
        categories: z.ZodArray<z.ZodString>;
    }, z.core.$strip>;
    tokenEstimate: z.ZodNumber;
    status: z.ZodEnum<{
        queued: "queued";
        sent: "sent";
        replied: "replied";
        noted: "noted";
        pending: "pending";
        failed: "failed";
    }>;
}, z.core.$strip>;
declare const reviewEventSchema: z.ZodObject<{
    bac_id: z.ZodString;
    sourceThreadId: z.ZodString;
    sourceTurnOrdinal: z.ZodNumber;
    provider: z.ZodEnum<{
        unknown: "unknown";
        chatgpt: "chatgpt";
        claude: "claude";
        gemini: "gemini";
    }>;
    verdict: z.ZodEnum<{
        agree: "agree";
        disagree: "disagree";
        partial: "partial";
        needs_source: "needs_source";
        open: "open";
    }>;
    reviewerNote: z.ZodString;
    spans: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        text: z.ZodString;
        comment: z.ZodString;
        capturedAt: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    outcome: z.ZodEnum<{
        save: "save";
        submit_back: "submit_back";
        dispatch_out: "dispatch_out";
    }>;
    createdAt: z.ZodISODateTime;
}, z.core.$strip>;
export type ThreadRecord = z.infer<typeof threadSchema>;
export type WorkstreamRecord = z.infer<typeof workstreamSchema>;
export type QueueItemRecord = z.infer<typeof queueItemSchema>;
export type ReminderRecord = z.infer<typeof reminderSchema>;
export type CodingSessionRecord = z.infer<typeof codingSessionSchema>;
export type DispatchEvent = z.infer<typeof dispatchEventSchema>;
export type ReviewEvent = z.infer<typeof reviewEventSchema>;
declare const turnRoleSchema: z.ZodEnum<{
    unknown: "unknown";
    user: "user";
    assistant: "assistant";
    system: "system";
}>;
declare const captureEventSchema: z.ZodObject<{
    threadUrl: z.ZodURL;
    capturedAt: z.ZodISODateTime;
    turns: z.ZodArray<z.ZodObject<{
        role: z.ZodEnum<{
            unknown: "unknown";
            user: "user";
            assistant: "assistant";
            system: "system";
        }>;
        text: z.ZodString;
        formattedText: z.ZodOptional<z.ZodString>;
        ordinal: z.ZodNumber;
        capturedAt: z.ZodISODateTime;
        sourceSelector: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type TurnRole = z.infer<typeof turnRoleSchema>;
export type CapturedTurn = z.infer<typeof captureEventSchema>['turns'][number];
export interface DispatchReadOptions {
    readonly limit?: number;
    readonly since?: string;
    readonly workstreamId?: string;
    readonly provider?: string;
}
export interface DispatchReadResult {
    readonly data: readonly DispatchEvent[];
    readonly cursor?: string;
}
export interface ReviewReadOptions {
    readonly limit?: number;
    readonly since?: string;
    readonly threadId?: string;
    readonly verdict?: ReviewEvent['verdict'];
}
export interface ReviewReadResult {
    readonly data: readonly ReviewEvent[];
    readonly cursor?: string;
}
export interface TurnsReadOptions {
    readonly threadUrl: string;
    readonly limit?: number;
    readonly role?: TurnRole;
}
export interface TurnsReadResult {
    readonly data: readonly CapturedTurn[];
    readonly cursor?: string;
}
export interface LiveVaultSnapshot {
    readonly threads: readonly ThreadRecord[];
    readonly workstreams: readonly WorkstreamRecord[];
    readonly queueItems: readonly QueueItemRecord[];
    readonly reminders: readonly ReminderRecord[];
    readonly events: readonly Record<string, unknown>[];
    readonly generatedAt: string;
}
export declare class LiveVaultReader {
    private readonly vaultPath;
    constructor(vaultPath: string);
    readSnapshot(): Promise<LiveVaultSnapshot>;
    readDispatches(options?: DispatchReadOptions): Promise<DispatchReadResult>;
    readTurns(options: TurnsReadOptions): Promise<TurnsReadResult>;
    readCodingSessions(options?: {
        readonly workstreamId?: string;
        readonly status?: 'attached' | 'detached';
    }): Promise<readonly CodingSessionRecord[]>;
    readReviews(options?: ReviewReadOptions): Promise<ReviewReadResult>;
}
export {};
//# sourceMappingURL=liveVaultReader.d.ts.map