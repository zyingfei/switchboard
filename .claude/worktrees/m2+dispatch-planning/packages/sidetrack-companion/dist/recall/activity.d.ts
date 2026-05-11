export type RecallActivityKind = 'incremental-index' | 'ingest-failed' | 'rebuild-started' | 'rebuild-finished' | 'rebuild-failed' | 'query' | 'suggestion';
export interface RecallActivityEvent {
    readonly kind: RecallActivityKind;
    readonly at: string;
    readonly count?: number;
    readonly threadIds?: readonly string[];
    readonly queryLength?: number;
    readonly resultCount?: number;
    readonly threadId?: string;
    readonly reason?: 'startup' | 'manual' | 'reconnect' | 'drift';
    readonly error?: string;
}
export interface RecallActivityReport {
    readonly lastIndexedAt: string | null;
    readonly lastIndexedCount: number | null;
    readonly lastIndexedThreadIds: readonly string[];
    readonly lastRecallQueryAt: string | null;
    readonly lastRecallQueryResultCount: number | null;
    readonly lastSuggestionAt: string | null;
    readonly lastSuggestionThreadId: string | null;
    readonly recent: readonly RecallActivityEvent[];
}
export interface RecallActivityTracker {
    readonly recordIncrementalIndex: (input: {
        readonly count: number;
        readonly threadIds: readonly string[];
    }) => void;
    readonly recordRebuildStarted: (reason: 'startup' | 'manual' | 'reconnect' | 'drift') => void;
    readonly recordRebuildFinished: (count: number) => void;
    readonly recordRebuildFailed: (error: string) => void;
    readonly recordIngestFailed: (error: string) => void;
    readonly recordQuery: (input: {
        readonly queryLength: number;
        readonly resultCount: number;
    }) => void;
    readonly recordSuggestion: (input: {
        readonly threadId: string;
        readonly resultCount: number;
    }) => void;
    readonly report: () => RecallActivityReport;
}
export declare const createRecallActivityTracker: (now?: () => Date) => RecallActivityTracker;
//# sourceMappingURL=activity.d.ts.map