import type { EventLog } from './eventLog.js';
import type { ProjectionChangeFeed } from './projectionChanges.js';
export interface StartAntiEntropyDeps {
    readonly vaultRoot: string;
    readonly eventLog: EventLog;
    readonly projectionChanges?: ProjectionChangeFeed;
    readonly intervalMs?: number;
    readonly fireImmediately?: boolean;
    readonly onScanComplete?: (count: number) => void;
}
export interface AntiEntropyHandle {
    readonly stop: () => void;
    readonly scanNow: () => Promise<number>;
}
export declare const startAntiEntropyTask: (deps: StartAntiEntropyDeps) => AntiEntropyHandle;
//# sourceMappingURL=antiEntropy.d.ts.map