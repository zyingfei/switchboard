export declare const mcpAuthKeyPath: (vaultPath: string) => string;
export declare const createMcpAuthKey: () => string;
export interface EnsuredMcpAuthKey {
    readonly key: string;
    readonly path: string;
    readonly created: boolean;
}
export declare const ensureMcpAuthKey: (vaultPath: string) => Promise<EnsuredMcpAuthKey>;
//# sourceMappingURL=mcpAuthKey.d.ts.map