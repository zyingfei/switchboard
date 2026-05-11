export interface ModelCacheStatus {
    readonly modelId: string;
    readonly revision: string;
    readonly cacheDir: string;
    readonly present: boolean;
    readonly verified: boolean;
    readonly offline: boolean;
}
export interface ModelCacheOptions {
    readonly modelsDir?: string;
    readonly offline?: boolean;
}
export declare const resolveModelsDir: (options?: ModelCacheOptions) => string;
export declare const isOfflineMode: (options?: ModelCacheOptions) => boolean;
export declare const getModelCacheStatus: (options?: ModelCacheOptions) => Promise<ModelCacheStatus>;
//# sourceMappingURL=modelCache.d.ts.map