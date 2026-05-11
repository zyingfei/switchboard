import type { EventLog } from '../sync/eventLog.js';
export interface RebuildOptions {
    readonly onProgress?: (embedded: number, total: number) => void;
    readonly eventLog?: EventLog;
}
export declare const rebuildFromEventLog: (vaultRoot: string, eventLogPath: string, options?: RebuildOptions) => Promise<{
    readonly indexed: number;
}>;
//# sourceMappingURL=rebuild.d.ts.map