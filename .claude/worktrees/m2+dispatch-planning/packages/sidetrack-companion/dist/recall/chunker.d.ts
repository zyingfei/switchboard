export interface RecallChunkInput {
    readonly sourceBacId: string;
    readonly threadId: string;
    readonly provider?: string;
    readonly threadUrl?: string;
    readonly title?: string;
    readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
    readonly turnOrdinal: number;
    readonly modelName?: string;
    readonly capturedAt: string;
    readonly text: string;
    readonly markdown?: string;
    readonly formattedText?: string;
}
export interface RecallChunk {
    readonly chunkId: string;
    readonly sourceBacId: string;
    readonly threadId: string;
    readonly provider?: string;
    readonly threadUrl?: string;
    readonly title?: string;
    readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
    readonly turnOrdinal: number;
    readonly modelName?: string;
    readonly capturedAt: string;
    readonly headingPath: readonly string[];
    readonly paragraphIndex: number;
    readonly charStart: number;
    readonly charEnd: number;
    readonly text: string;
    readonly textHash: string;
    readonly embedText: string;
}
export declare const chunkTurn: (input: RecallChunkInput) => readonly RecallChunk[];
//# sourceMappingURL=chunker.d.ts.map