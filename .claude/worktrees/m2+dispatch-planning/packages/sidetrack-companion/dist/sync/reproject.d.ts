import type { EventLog } from './eventLog.js';
import type { ProjectionChangeFeed } from './projectionChanges.js';
export declare const PROJECTOR_VERSION = 1;
export interface ReprojectOnVersionMismatchDeps {
    readonly vaultRoot: string;
    readonly eventLog: EventLog;
    readonly projectionChanges?: ProjectionChangeFeed;
}
export interface ReprojectResult {
    readonly ranReproject: boolean;
    readonly priorVersion: number | null;
    readonly currentVersion: number;
    readonly aggregateCount: number;
}
export declare const reprojectOnVersionMismatch: (deps: ReprojectOnVersionMismatchDeps) => Promise<ReprojectResult>;
//# sourceMappingURL=reproject.d.ts.map