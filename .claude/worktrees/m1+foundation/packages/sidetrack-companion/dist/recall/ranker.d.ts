export interface IndexEntry {
    readonly id: string;
    readonly threadId: string;
    readonly capturedAt: string;
    readonly embedding: Float32Array;
    readonly replicaId?: string;
    readonly lamport?: number;
    readonly tombstoned?: boolean;
}
export interface RankedItem {
    readonly id: string;
    readonly threadId: string;
    readonly capturedAt: string;
    readonly score: number;
    readonly similarity: number;
    readonly freshness: number;
}
export declare const freshnessDecay: (capturedAt: string, now: Date) => number;
export declare const rank: (queryEmbedding: Float32Array, items: readonly IndexEntry[], now: Date, opts?: {
    readonly limit?: number;
    readonly workstreamMembership?: (threadId: string) => boolean;
}) => readonly RankedItem[];
//# sourceMappingURL=ranker.d.ts.map