import type { EventLog } from '../sync/eventLog.js';
import { type EmbedderAccelerator, type EmbedderDevice } from './embedder.js';
import type { IndexEntry } from './ranker.js';
import type { RecallActivityTracker } from './activity.js';
export type RecallStatus = 'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready';
export interface RecallStatusReport {
    readonly status: RecallStatus;
    readonly entryCount: number;
    readonly eventTurnCount: number;
    readonly modelId: string | null;
    readonly currentModelId: string;
    readonly companionVersion: string;
    readonly lastRebuildAt: string | null;
    readonly lastRebuildIndexed: number | null;
    readonly lastError: string | null;
    readonly rebuildEmbedded: number;
    readonly rebuildTotal: number;
    readonly embedderDevice: EmbedderDevice;
    readonly embedderAccelerator: EmbedderAccelerator;
    readonly drift: {
        readonly eventTurnCount: number;
        readonly entryCount: number;
        readonly pct: number;
        readonly tolerance: number;
    };
}
export interface RecallLifecycle {
    readonly report: () => Promise<RecallStatusReport>;
    readonly ensureFresh: () => Promise<RecallStatusReport>;
    readonly scheduleRebuild: (reason: 'startup' | 'manual' | 'reconnect' | 'drift') => void;
    readonly waitForRebuild: () => Promise<void>;
    readonly isRebuilding: () => boolean;
    readonly appendEntry: (entry: IndexEntry) => Promise<void>;
    readonly gcEntries: (validIds: ReadonlySet<string>) => Promise<{
        readonly removed: number;
    }>;
    readonly tombstoneByThread: (threadId: string) => Promise<{
        readonly tombstoned: number;
    }>;
    readonly ingestIncremental: (eventLog: import('../sync/eventLog.js').EventLog) => Promise<{
        readonly indexedChunks: number;
        readonly tombstonedChunks: number;
        readonly tombstonedEntries: number;
    }>;
}
export interface CreateRecallLifecycleOptions {
    readonly vaultRoot: string;
    readonly companionVersion: string;
    readonly currentModelId?: string;
    readonly rebuilder?: RebuilderFn;
    readonly embedder?: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
    readonly log?: (message: string) => void;
    readonly warn?: (message: string) => void;
    readonly activity?: Pick<RecallActivityTracker, 'recordRebuildStarted' | 'recordRebuildFinished' | 'recordRebuildFailed' | 'recordIncrementalIndex'>;
    readonly driftTolerance?: number;
    readonly replica?: {
        readonly replicaId: string;
        readonly nextSeq: () => Promise<number>;
    };
    readonly eventLog?: EventLog;
}
type RebuilderFn = (vaultRoot: string, eventLogPath: string, options?: {
    readonly onProgress?: (embedded: number, total: number) => void;
    readonly eventLog?: EventLog;
}) => Promise<{
    readonly indexed: number;
}>;
export declare const createRecallLifecycle: (opts: CreateRecallLifecycleOptions) => RecallLifecycle;
export {};
//# sourceMappingURL=lifecycle.d.ts.map