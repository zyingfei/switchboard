import type { IndexEntry } from './ranker.js';
export interface IndexFile {
    readonly modelId: string;
    readonly modelRevision?: string;
    readonly chunkSchemaVersion?: number;
    readonly items: readonly IndexEntry[];
    readonly schemaCapabilities?: readonly string[];
}
export declare const readIndex: (path: string) => Promise<IndexFile | null>;
export interface WriteIndexOptions {
    readonly modelRevision?: string;
}
export declare const writeIndex: (path: string, items: readonly IndexEntry[], modelId: string, options?: WriteIndexOptions) => Promise<void>;
export declare const appendEntry: (path: string, entry: IndexEntry, modelId: string, options?: WriteIndexOptions) => Promise<void>;
export declare const upsertEntries: (path: string, entries: readonly IndexEntry[], modelId: string, options?: WriteIndexOptions) => Promise<{
    readonly added: number;
    readonly replaced: number;
}>;
export declare const replaceEntriesForSourceUnit: (path: string, input: {
    readonly sourceUnitId: string;
    readonly extractionRevisionId: string;
    readonly entries: readonly IndexEntry[];
}, modelId: string, options?: WriteIndexOptions) => Promise<{
    readonly removed: number;
    readonly inserted: number;
}>;
export declare const gcEntries: (path: string, validIds: ReadonlySet<string>) => Promise<{
    readonly removed: number;
}>;
export declare const tombstoneByThread: (path: string, threadId: string) => Promise<{
    readonly tombstoned: number;
}>;
export declare const INDEX_DIM = 384;
export declare const INDEX_VERSION = 3;
export declare const INDEX_CHUNK_SCHEMA_VERSION = 1;
export declare const INDEX_SCHEMA_CAPABILITIES: readonly string[];
export declare const INDEX_DEFAULT_REPLICA = "local";
//# sourceMappingURL=indexFile.d.ts.map