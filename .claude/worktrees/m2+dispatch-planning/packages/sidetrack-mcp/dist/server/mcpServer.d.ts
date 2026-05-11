import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CodingSessionRecord, DispatchReadOptions, DispatchReadResult, LiveVaultSnapshot, ReviewReadOptions, ReviewReadResult, TurnsReadOptions, TurnsReadResult } from '../vault/liveVaultReader.js';
export type RequestDispatchTargetProvider = 'chatgpt' | 'claude' | 'gemini';
export type RequestDispatchMode = 'paste' | 'auto-send';
export interface SerializedAnchor {
    readonly textQuote: {
        readonly exact: string;
        readonly prefix: string;
        readonly suffix: string;
    };
    readonly textPosition: {
        readonly start: number;
        readonly end: number;
    };
    readonly cssSelector: string;
}
export interface CodingSessionRegisterResult {
    readonly bac_id: string;
    readonly workstreamId?: string | undefined;
    readonly tool?: 'claude_code' | 'codex' | 'cursor' | 'other' | undefined;
    readonly cwd?: string | undefined;
    readonly branch?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly name?: string | undefined;
    readonly resumeCommand?: string | undefined;
    readonly attachedAt?: string | undefined;
    readonly lastSeenAt?: string | undefined;
    readonly status?: 'attached' | 'detached' | undefined;
}
export interface CompanionWriteClient {
    readonly registerCodingSession: (input: {
        readonly token: string;
        readonly tool: 'claude_code' | 'codex' | 'cursor' | 'other';
        readonly cwd: string;
        readonly branch: string;
        readonly sessionId: string;
        readonly name: string;
        readonly resumeCommand?: string;
    }) => Promise<CodingSessionRegisterResult>;
    readonly requestDispatch?: (input: {
        readonly codingSessionId: string;
        readonly targetProvider: RequestDispatchTargetProvider;
        readonly title: string;
        readonly body: string;
        readonly mode: RequestDispatchMode;
        readonly workstreamId?: string;
        readonly sourceThreadId?: string;
    }) => Promise<{
        readonly dispatchId: string;
        readonly approval: 'auto-approved';
        readonly status: string;
        readonly requestedAt: string;
    }>;
    readonly moveThread?: (input: {
        readonly threadId: string;
        readonly workstreamId?: string;
    }) => Promise<{
        readonly bac_id: string;
        readonly revision: string;
    }>;
    readonly createQueueItem?: (input: {
        readonly text: string;
        readonly scope: 'thread' | 'workstream' | 'global';
        readonly targetId?: string;
    }) => Promise<{
        readonly bac_id: string;
        readonly revision: string;
    }>;
    readonly createAnnotation?: (input: {
        readonly term: string;
        readonly note: string;
        readonly threadId?: string;
        readonly url?: string;
        readonly pageTitle?: string;
        readonly selectionHint?: string;
        readonly sourceTurn?: 'assistant_latest' | 'assistant_all' | {
            readonly ordinal: number;
        };
        readonly anchorPolicy?: {
            readonly repeatedTerm?: 'first' | 'require_hint';
            readonly shortTermMinLength?: number;
        };
    }) => Promise<{
        readonly status: 'created';
        readonly annotationId: string;
        readonly occurrenceCount: number;
        readonly annotation: Record<string, unknown>;
        readonly totalForUrl?: number;
    } | {
        readonly status: 'anchor_failed' | 'validation_failed';
        readonly reason: 'term_not_found' | 'short_term_requires_selection_hint' | 'ambiguous_term_requires_selection_hint' | 'invalid_ordinal' | 'selection_hint_no_match' | 'thread_not_found' | 'thread_url_unresolved' | 'no_assistant_turns';
        readonly message: string;
        readonly occurrenceCount: number;
        readonly suggestedSelectionHints?: readonly string[];
    }>;
    readonly updateAnnotation?: (input: {
        readonly bac_id: string;
        readonly note: string;
    }) => Promise<Record<string, unknown>>;
    readonly deleteAnnotation?: (input: {
        readonly bac_id: string;
    }) => Promise<Record<string, unknown>>;
    readonly bumpWorkstream?: (input: {
        readonly bac_id: string;
    }) => Promise<{
        readonly bac_id: string;
        readonly revision: string;
    }>;
    readonly archiveThread?: (input: {
        readonly bac_id: string;
    }) => Promise<{
        readonly bac_id: string;
        readonly revision: string;
    }>;
    readonly unarchiveThread?: (input: {
        readonly bac_id: string;
    }) => Promise<{
        readonly bac_id: string;
        readonly revision: string;
    }>;
    readonly listDispatches?: (input: {
        readonly limit?: number;
        readonly since?: string;
    }) => Promise<readonly unknown[]>;
    readonly listAuditEvents?: (input: {
        readonly limit?: number;
        readonly since?: string;
    }) => Promise<readonly unknown[]>;
    readonly listWorkstreamNotes?: (input: {
        readonly workstreamId: string;
    }) => Promise<readonly unknown[]>;
    readonly listAnnotations?: (input: {
        readonly url?: string;
        readonly limit?: number;
    }) => Promise<readonly unknown[]>;
    readonly readThreadMarkdown?: (input: {
        readonly bac_id: string;
    }) => Promise<Record<string, unknown>>;
    readonly readWorkstreamMarkdown?: (input: {
        readonly bac_id: string;
    }) => Promise<Record<string, unknown>>;
    readonly listBuckets?: () => Promise<readonly unknown[]>;
    readonly systemHealth?: () => Promise<Record<string, unknown>>;
    readonly recall?: (input: {
        readonly query: string;
        readonly limit?: number;
        readonly workstreamId?: string;
    }) => Promise<readonly unknown[]>;
    readonly suggestWorkstream?: (input: {
        readonly threadId: string;
        readonly limit?: number;
    }) => Promise<readonly unknown[]>;
    readonly exportSettings?: () => Promise<Record<string, unknown>>;
    readonly systemUpdateCheck?: () => Promise<Record<string, unknown>>;
    readonly awaitCaptureForDispatch?: (input: {
        readonly dispatchId: string;
        readonly timeoutMs?: number;
        readonly includeLatestAssistantTurn?: boolean;
    }) => Promise<{
        readonly dispatchId: string;
        readonly matched: boolean;
        readonly linkedAt?: string;
        readonly thread?: {
            readonly threadId: string;
            readonly threadUrl?: string;
            readonly title?: string;
            readonly provider?: 'chatgpt' | 'claude' | 'gemini';
        };
        readonly resources?: {
            readonly dispatch: string;
            readonly thread: string;
            readonly turns: string;
            readonly markdown: string;
            readonly annotations: string;
        };
        readonly latestAssistantTurn?: {
            readonly ordinal: number;
            readonly text: string;
            readonly capturedAt: string;
        };
        readonly reason?: 'matched' | 'timeout';
    }>;
}
export interface SidetrackMcpReader {
    readonly readSnapshot: () => Promise<LiveVaultSnapshot>;
    readonly readCodingSessions: (options?: {
        readonly workstreamId?: string;
        readonly status?: 'attached' | 'detached';
    }) => Promise<readonly CodingSessionRecord[]>;
    readonly readDispatches: (options?: DispatchReadOptions) => Promise<DispatchReadResult>;
    readonly readReviews: (options?: ReviewReadOptions) => Promise<ReviewReadResult>;
    readonly readTurns: (options: TurnsReadOptions) => Promise<TurnsReadResult>;
}
export declare const createSidetrackMcpServer: (reader: SidetrackMcpReader, companionClient?: CompanionWriteClient) => McpServer;
//# sourceMappingURL=mcpServer.d.ts.map