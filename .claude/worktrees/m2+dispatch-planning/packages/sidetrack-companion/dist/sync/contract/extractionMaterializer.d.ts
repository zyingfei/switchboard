import type { ExtractionStore } from '../../recall/extraction/store.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer } from './materializer.js';
export interface CreateExtractionMaterializerDeps {
    readonly store: ExtractionStore;
    readonly eventLog: EventLog;
}
export declare const createExtractionMaterializer: (deps: CreateExtractionMaterializerDeps) => Materializer;
//# sourceMappingURL=extractionMaterializer.d.ts.map