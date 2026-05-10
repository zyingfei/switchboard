export interface ChunkMetadata {
    readonly sourceBacId: string;
    readonly provider?: string;
    readonly threadUrl?: string;
    readonly title?: string;
    readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
    readonly turnOrdinal: number;
    readonly modelName?: string;
    readonly headingPath: readonly string[];
    readonly paragraphIndex: number;
    readonly charStart: number;
    readonly charEnd: number;
    readonly textHash: string;
    readonly text: string;
    readonly sourceUnitId?: string;
    readonly extractionRevisionId?: string;
    readonly extractorId?: string;
    readonly extractorVersion?: string;
    readonly extractionSchemaVersion?: number;
    readonly inputHash?: string;
    readonly outputHash?: string;
    readonly chunkerVersion?: string;
}
export interface IndexEntry {
    readonly id: string;
    readonly threadId: string;
    readonly capturedAt: string;
    readonly embedding: Float32Array;
    readonly replicaId?: string;
    readonly lamport?: number;
    readonly tombstoned?: boolean;
    readonly metadata?: ChunkMetadata;
}
export interface RankedItem {
    readonly id: string;
    readonly threadId: string;
    readonly capturedAt: string;
    readonly score: number;
    readonly similarity: number;
    readonly freshness: number;
    readonly vector?: {
        readonly rank: number;
        readonly similarity: number;
    };
    readonly lexical?: {
        readonly rank: number;
        readonly score: number;
    };
    readonly metadata?: ChunkMetadata;
    readonly snippet?: string;
    readonly why?: readonly string[];
}
export declare const freshnessDecay: (capturedAt: string, now: Date) => number;
export declare const rank: (queryEmbedding: Float32Array, items: readonly IndexEntry[], now: Date, opts?: {
    readonly limit?: number;
    readonly workstreamMembership?: (threadId: string) => boolean;
}) => readonly RankedItem[];
import MiniSearch from 'minisearch';
export interface HybridLexicalIndex {
    readonly mini: MiniSearch<{
        id: string;
        text: string;
        title: string;
        heading: string;
    }>;
    readonly idToEntry: ReadonlyMap<string, IndexEntry>;
}
export declare const buildLexicalIndex: (items: readonly IndexEntry[]) => HybridLexicalIndex;
export interface HybridRankOptions {
    readonly limit?: number;
    readonly workstreamMembership?: (threadId: string) => boolean;
    readonly lexical: HybridLexicalIndex;
}
export declare const rankHybrid: (queryText: string, queryEmbedding: Float32Array, items: readonly IndexEntry[], now: Date, opts: HybridRankOptions) => readonly RankedItem[];
//# sourceMappingURL=ranker.d.ts.map