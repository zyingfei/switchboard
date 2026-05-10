export interface RebuildOptions {
    readonly onProgress?: (embedded: number, total: number) => void;
}
export declare const rebuildFromEventLog: (vaultRoot: string, eventLogPath: string, options?: RebuildOptions) => Promise<{
    readonly indexed: number;
}>;
//# sourceMappingURL=rebuild.d.ts.map