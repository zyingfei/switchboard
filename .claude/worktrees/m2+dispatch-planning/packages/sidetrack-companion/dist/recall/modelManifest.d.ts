export interface RecallModelManifest {
    readonly modelId: string;
    readonly revision: string;
    readonly embeddingDim: number;
    readonly dtypePreference: readonly ('q8' | 'fp16' | 'fp32')[];
    readonly inputPrefix: string;
    readonly transformersVersionRange: string;
}
export declare const RECALL_MODEL: RecallModelManifest;
export declare const RECALL_MODEL_ID: string;
//# sourceMappingURL=modelManifest.d.ts.map