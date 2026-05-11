export interface EmbeddingCacheKey {
    readonly modelId: string;
    readonly modelRevision?: string;
    readonly embedTextHash: string;
}
export interface EmbeddingCache {
    readonly get: (key: EmbeddingCacheKey) => Promise<Float32Array | null>;
    readonly put: (key: EmbeddingCacheKey, vector: Float32Array) => Promise<void>;
    readonly stats: () => Promise<{
        readonly entries: number;
        readonly modelId: string | null;
    }>;
}
export declare const createEmbeddingCache: (vaultRoot: string, dim?: number) => EmbeddingCache;
//# sourceMappingURL=embeddingCache.d.ts.map