import type { RecallActivityTracker } from '../../recall/activity.js';
import type { EmbeddingCache } from '../../recall/embeddingCache.js';
import type { RecallLifecycle } from '../../recall/lifecycle.js';
import type { ExtractionStore } from '../../recall/extraction/store.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer } from './materializer.js';
export interface CreateRecallMaterializerDeps {
    readonly recallLifecycle: RecallLifecycle;
    readonly recallActivity: RecallActivityTracker;
    readonly eventLog: EventLog;
    readonly extractionStore?: ExtractionStore;
    readonly indexPath?: string;
    readonly embeddingCache?: EmbeddingCache;
}
export declare const createRecallMaterializer: (deps: CreateRecallMaterializerDeps) => Materializer;
//# sourceMappingURL=recallMaterializer.d.ts.map