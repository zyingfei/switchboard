export interface CompanionRuntimeOptions {
    readonly vaultPath: string;
    readonly port: number;
    readonly allowAutoUpdate?: boolean;
    readonly mcp?: {
        readonly port: number;
        readonly authKey: string;
    };
    readonly relay?: {
        readonly url: string;
        readonly mode?: 'local' | 'remote';
        readonly rendezvousSecret: string;
    };
    readonly service?: {
        readonly companionCommand?: readonly string[];
        readonly mcpBin?: string;
        readonly syncRelay?: string;
        readonly syncRelayLocalPort?: number;
    };
}
export interface CompanionRuntime {
    readonly url: string;
    readonly vaultPath: string;
    readonly bridgeKey: string;
    readonly bridgeKeyPath: string;
    readonly bridgeKeyCreated: boolean;
    readonly replicaId: string;
    readonly replicaIdCreated: boolean;
    readonly close: () => Promise<void>;
}
export declare const startCompanion: (options: CompanionRuntimeOptions) => Promise<CompanionRuntime>;
//# sourceMappingURL=companion.d.ts.map