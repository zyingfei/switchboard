import type { IndexEntry } from './ranker.js';
export interface IndexFile {
    readonly modelId: string;
    readonly items: readonly IndexEntry[];
    readonly schemaCapabilities?: readonly string[];
}
export declare const readIndex: (path: string) => Promise<IndexFile | null>;
export declare const writeIndex: (path: string, items: readonly IndexEntry[], modelId: string) => Promise<void>;
export declare const appendEntry: (path: string, entry: IndexEntry, modelId: string) => Promise<void>;
export declare const upsertEntries: (path: string, entries: readonly IndexEntry[], modelId: string) => Promise<{
    readonly added: number;
    readonly replaced: number;
}>;
export declare const gcEntries: (path: string, validIds: ReadonlySet<string>) => Promise<{
    readonly removed: number;
}>;
export declare const tombstoneByThread: (path: string, threadId: string) => Promise<{
    readonly tombstoned: number;
}>;
export declare const INDEX_DIM = 384;
export declare const INDEX_VERSION = 2;
export declare const INDEX_SCHEMA_CAPABILITIES: readonly string[];
export declare const INDEX_DEFAULT_REPLICA = "local";
//# sourceMappingURL=indexFile.d.ts.map