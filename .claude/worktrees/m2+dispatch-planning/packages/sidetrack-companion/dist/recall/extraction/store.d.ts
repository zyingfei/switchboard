import type { ExtractionRevision, ExtractionSourceState, SourceUnitId } from './types.js';
export interface ExtractionStore {
    readonly putRevision: (revision: ExtractionRevision) => Promise<void>;
    readonly readRevision: (extractionRevisionId: string) => Promise<ExtractionRevision | null>;
    readonly putSourceState: (state: ExtractionSourceState) => Promise<void>;
    readonly readSourceState: (sourceUnitId: SourceUnitId) => Promise<ExtractionSourceState | null>;
    readonly listStaleSources: () => Promise<readonly ExtractionSourceState[]>;
    readonly listAllSources: () => Promise<readonly ExtractionSourceState[]>;
    readonly markIndexed: (sourceUnitId: SourceUnitId, extractionRevisionId: string) => Promise<void>;
}
export declare const createExtractionStore: (vaultRoot: string) => ExtractionStore;
//# sourceMappingURL=store.d.ts.map