export declare class RecallLockHeldError extends Error {
    readonly vaultRoot: string;
    readonly pid: number;
    constructor(vaultRoot: string, pid: number);
}
export interface RecallProcessLock {
    readonly path: string;
    readonly release: () => Promise<void>;
}
export declare const acquireRecallProcessLock: (vaultRoot: string) => Promise<RecallProcessLock>;
export declare const cleanupOrphanIndexTmpFiles: (vaultRoot: string) => Promise<{
    readonly removed: number;
}>;
//# sourceMappingURL=recovery.d.ts.map