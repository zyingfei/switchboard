import type { EventLog } from '../eventLog.js';
import type { Materializer } from './materializer.js';
import { type TimelineStore } from '../../timeline/projection.js';
export interface CreateTimelineMaterializerDeps {
    readonly store: TimelineStore;
    readonly eventLog: EventLog;
}
export declare const createTimelineMaterializer: (deps: CreateTimelineMaterializerDeps) => Materializer;
//# sourceMappingURL=timelineMaterializer.d.ts.map