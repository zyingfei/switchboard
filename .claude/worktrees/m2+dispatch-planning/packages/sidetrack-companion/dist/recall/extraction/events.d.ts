export declare const CAPTURE_EXTRACTION_PRODUCED: "capture.extraction.produced";
export type ExtractionEventType = typeof CAPTURE_EXTRACTION_PRODUCED;
export interface CaptureExtractionProducedPayload {
    readonly sourceUnitId: string;
    readonly sourceBacId: string;
    readonly extractionRevisionId: string;
    readonly extractorId: string;
    readonly extractorVersion: string;
    readonly extractionSchemaVersion: number;
    readonly inputHash: string;
    readonly outputHash: string;
    readonly chunkerVersion: string;
    readonly content: {
        readonly turns: readonly {
            readonly ordinal: number;
            readonly role: 'user' | 'assistant' | 'system' | 'unknown';
            readonly text: string;
            readonly markdown?: string;
            readonly formattedText?: string;
            readonly modelName?: string;
        }[];
        readonly title?: string;
        readonly threadUrl?: string;
        readonly capturedAt: string;
    };
}
export declare const isCaptureExtractionProducedPayload: (value: unknown) => value is CaptureExtractionProducedPayload;
//# sourceMappingURL=events.d.ts.map