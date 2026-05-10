import type { EventLog } from '../sync/eventLog.js';
interface IngestState {
    readonly processedEvents: Record<string, number>;
    readonly lastIncrementalIngestAt?: string;
    readonly lastFullRebuildAt?: string;
    readonly lastError?: string;
}
interface RecallManifest {
    readonly indexVersion: number;
    readonly chunkSchemaVersion: number;
    readonly modelId: string;
    readonly modelRevision: string;
    readonly embeddingDim: number;
    readonly builtAt: string;
}
export declare const readIngestState: (vaultRoot: string) => Promise<IngestState>;
export declare const readRecallManifest: (vaultRoot: string) => Promise<RecallManifest | null>;
export declare const writeRecallManifest: (vaultRoot: string) => Promise<void>;
interface IngestSummary {
    readonly indexedChunks: number;
    readonly tombstonedChunks: number;
    readonly tombstonedEntries: number;
    readonly processedEvents: Record<string, number>;
}
export declare const ingestIncremental: (vaultRoot: string, eventLog: EventLog) => Promise<IngestSummary>;
export declare const recallStateExists: (vaultRoot: string) => Promise<boolean>;
export {};
//# sourceMappingURL=ingestor.d.ts.map