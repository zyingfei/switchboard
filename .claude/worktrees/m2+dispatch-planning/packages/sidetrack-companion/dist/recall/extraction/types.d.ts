export type SourceUnitId = string;
export declare const sourceUnitIdFor: (input: {
    readonly provider: string;
    readonly conversationId?: string;
    readonly messageId?: string;
    readonly canonicalUrl?: string;
    readonly role?: string;
    readonly turnOrdinal?: number;
    readonly sourceSnapshotHash?: string;
}) => SourceUnitId;
export interface ExtractionRevision {
    readonly extractionRevisionId: string;
    readonly sourceUnitId: SourceUnitId;
    readonly sourceBacId: string;
    readonly extractorId: string;
    readonly extractorVersion: string;
    readonly extractionSchemaVersion: number;
    readonly inputHash: string;
    readonly outputHash: string;
    readonly chunkerVersion: string;
    readonly createdAt: string;
    readonly producerReplicaId: string;
    readonly producerDot: {
        readonly replicaId: string;
        readonly seq: number;
    };
    readonly content: ExtractionRevisionContent;
}
export interface ExtractionRevisionContent {
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
}
export interface ExtractionSourceState {
    readonly sourceUnitId: SourceUnitId;
    readonly sourceBacId: string;
    readonly latestExtractionRevision: string;
    readonly indexedExtractionRevision?: string;
    readonly status: 'current' | 'stale';
    readonly history: readonly {
        readonly extractionRevisionId: string;
        readonly extractorId: string;
        readonly extractorVersion: string;
        readonly createdAt: string;
        readonly extractionSchemaVersion?: number;
        readonly producerDot?: {
            readonly replicaId: string;
            readonly seq: number;
        };
    }[];
}
//# sourceMappingURL=types.d.ts.map