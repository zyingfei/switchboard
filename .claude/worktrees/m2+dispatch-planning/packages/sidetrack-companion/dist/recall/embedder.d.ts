export declare const MODEL_ID: string;
type FeatureExtractor = (text: string, options: {
    readonly pooling: 'mean';
    readonly normalize: true;
}) => Promise<{
    readonly data: ArrayLike<number>;
}>;
export declare class RecallModelMissingError extends Error {
    readonly offline: boolean;
    readonly cacheDir: string;
    readonly code: "RECALL_MODEL_MISSING";
    constructor(message: string, offline: boolean, cacheDir: string);
}
export type EmbedderDevice = 'cpu' | 'wasm' | 'webgpu' | 'unknown';
export type EmbedderAccelerator = 'accelerate' | 'mkl' | 'cpu' | 'unknown';
export declare const getResolvedEmbedderDevice: () => EmbedderDevice;
export declare const getResolvedEmbedderAccelerator: () => EmbedderAccelerator;
export declare const getEmbedder: () => Promise<FeatureExtractor>;
export declare const embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
export {};
//# sourceMappingURL=embedder.d.ts.map