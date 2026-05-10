export declare const MODEL_ID = "Xenova/multilingual-e5-small#prefix-query-v1";
type FeatureExtractor = (text: string, options: {
    readonly pooling: 'mean';
    readonly normalize: true;
}) => Promise<{
    readonly data: ArrayLike<number>;
}>;
export type EmbedderDevice = 'cpu' | 'wasm' | 'webgpu' | 'unknown';
export type EmbedderAccelerator = 'accelerate' | 'mkl' | 'cpu' | 'unknown';
export declare const getResolvedEmbedderDevice: () => EmbedderDevice;
export declare const getResolvedEmbedderAccelerator: () => EmbedderAccelerator;
export declare const getEmbedder: () => Promise<FeatureExtractor>;
export declare const embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
export {};
//# sourceMappingURL=embedder.d.ts.map