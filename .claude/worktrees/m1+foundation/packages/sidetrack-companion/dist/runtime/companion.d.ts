export interface CompanionRuntimeOptions {
    readonly vaultPath: string;
    readonly port: number;
    readonly allowAutoUpdate?: boolean;
}
export interface CompanionRuntime {
    readonly url: string;
    readonly vaultPath: string;
    readonly bridgeKey: string;
    readonly bridgeKeyPath: string;
    readonly bridgeKeyCreated: boolean;
    readonly close: () => Promise<void>;
}
export declare const startCompanion: (options: CompanionRuntimeOptions) => Promise<CompanionRuntime>;
//# sourceMappingURL=companion.d.ts.map