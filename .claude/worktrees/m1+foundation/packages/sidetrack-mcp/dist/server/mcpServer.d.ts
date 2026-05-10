import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CodingSessionRecord, DispatchReadOptions, DispatchReadResult, LiveVaultSnapshot, ReviewReadOptions, ReviewReadResult, TurnsReadOptions, TurnsReadResult } from '../vault/liveVaultReader.js';
export interface CompanionWriteClient {
    readonly registerCodingSession: (input: {
        readonly token: string;
        readonly tool: 'claude_code' | 'codex' | 'cursor' | 'other';
        readonly cwd: string;
        readonly branch: string;
        readonly sessionId: string;
        readonly name: string;
        readonly resumeCommand?: string;
    }) => Promise<{
        readonly bac_id: string;
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