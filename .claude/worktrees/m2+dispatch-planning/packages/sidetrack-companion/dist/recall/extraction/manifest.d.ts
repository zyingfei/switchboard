export type ExtractorCapability = 'code-blocks' | 'citations' | 'attachments' | 'model-name' | 'image-alt' | 'table-of-contents';
export interface ExtractorManifestEntry {
    readonly extractorId: string;
    readonly extractorVersion: string;
    readonly extractionSchemaVersion: number;
    readonly capabilities: ReadonlySet<ExtractorCapability>;
}
export declare const EXTRACTOR_MANIFEST: readonly ExtractorManifestEntry[];
export interface RevisionCandidate {
    readonly extractionRevisionId: string;
    readonly extractorId: string;
    readonly extractorVersion: string;
    readonly extractionSchemaVersion: number;
    readonly tombstoned?: boolean;
    readonly producerDot?: {
        readonly replicaId: string;
        readonly seq: number;
    };
}
export declare const selectActiveRevision: (candidates: readonly RevisionCandidate[]) => RevisionCandidate | undefined;
//# sourceMappingURL=manifest.d.ts.map