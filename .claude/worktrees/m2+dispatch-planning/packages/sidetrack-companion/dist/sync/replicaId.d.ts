export declare const replicaIdPath: (vaultPath: string) => string;
export declare const replicaSeqPath: (vaultPath: string) => string;
export interface ReplicaContext {
    readonly replicaId: string;
    readonly created: boolean;
    readonly nextSeq: () => Promise<number>;
    readonly peekSeq: () => number;
    readonly observeSeq: (incoming: number) => Promise<void>;
}
export declare const loadOrCreateReplica: (vaultPath: string) => Promise<ReplicaContext>;
//# sourceMappingURL=replicaId.d.ts.map