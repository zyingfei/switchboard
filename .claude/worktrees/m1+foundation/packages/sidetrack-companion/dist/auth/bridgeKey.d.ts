export declare const bridgeKeyPath: (vaultPath: string) => string;
export declare const createBridgeKey: () => string;
export interface EnsuredBridgeKey {
    readonly key: string;
    readonly path: string;
    readonly created: boolean;
}
export declare const ensureBridgeKey: (vaultPath: string) => Promise<EnsuredBridgeKey>;
export declare const bridgeKeysMatch: (expected: string, actual: string) => boolean;
export declare const isBridgeKeyAccepted: (vaultPath: string | undefined, expected: string, actual: string, now?: Date) => Promise<boolean>;
export declare const rotateBridgeKey: (vaultPath: string, previousKey: string, now?: Date) => Promise<{
    readonly previous: string;
    readonly current: string;
    readonly rotatedAt: string;
}>;
//# sourceMappingURL=bridgeKey.d.ts.map