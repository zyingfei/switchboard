import type { EventLog } from '../eventLog.js';
import type { ProjectionChangeFeed } from '../projectionChanges.js';
import type { Materializer } from './materializer.js';
export interface CreateProjectionMaterializerDeps {
    readonly vaultRoot: string;
    readonly eventLog: EventLog;
    readonly projectionChanges?: ProjectionChangeFeed;
}
export declare const createProjectionMaterializer: (deps: CreateProjectionMaterializerDeps) => Materializer;
//# sourceMappingURL=projectionMaterializer.d.ts.map