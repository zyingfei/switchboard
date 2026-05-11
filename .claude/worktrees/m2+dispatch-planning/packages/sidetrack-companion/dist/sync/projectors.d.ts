import type { AcceptedEvent } from './causal.js';
import type { EventLog } from './eventLog.js';
import type { ProjectionChangeFeed } from './projectionChanges.js';
export interface RunImportProjectorsDeps {
    readonly vaultRoot: string;
    readonly eventLog: EventLog;
    readonly projectionChanges?: ProjectionChangeFeed;
}
export declare const PROJECTED_EVENT_TYPES: readonly string[];
export declare const runImportProjectors: (deps: RunImportProjectorsDeps, event: AcceptedEvent) => Promise<void>;
//# sourceMappingURL=projectors.d.ts.map