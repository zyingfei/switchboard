import { type EmbedderAccelerator, type EmbedderDevice } from './embedder.js';
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
}
export interface RecallLifecycle {
    readonly report: () => Promise<RecallStatusReport>;
    readonly ensureFresh: () => Promise<RecallStatusReport>;
    readonly scheduleRebuild: (reason: 'startup' | 'manual' | 'reconnect') => void;
    readonly waitForRebuild: () => Promise<void>;
    readonly isRebuilding: () => boolean;
}
export interface CreateRecallLifecycleOptions {
    readonly vaultRoot: string;
    readonly companionVersion: string;
    readonly currentModelId?: string;
    readonly rebuilder?: RebuilderFn;
    readonly log?: (message: string) => void;
    readonly warn?: (message: string) => void;
}
type RebuilderFn = (vaultRoot: string, eventLogPath: string, options?: {
    readonly onProgress?: (embedded: number, total: number) => void;
}) => Promise<{
    readonly indexed: number;
}>;
export declare const createRecallLifecycle: (opts: CreateRecallLifecycleOptions) => RecallLifecycle;
export {};
//# sourceMappingURL=lifecycle.d.ts.map