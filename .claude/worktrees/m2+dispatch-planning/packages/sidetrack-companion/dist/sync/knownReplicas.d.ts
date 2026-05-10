export interface KnownReplicaRecord {
    readonly publicKey: string;
    readonly label?: string;
    readonly approvedAt: string;
    readonly lastSeenAt?: string;
    readonly revokedAt?: string;
}
export type KnownReplicas = Readonly<Record<string, KnownReplicaRecord>>;
export type AdmitDecision = {
    readonly kind: 'accept';
    readonly record: KnownReplicaRecord;
    readonly fresh: boolean;
} | {
    readonly kind: 'reject-key-mismatch';
    readonly storedPublicKey: string;
} | {
    readonly kind: 'reject-revoked';
    readonly revokedAt: string;
};
export interface KnownReplicasStore {
    readonly snapshot: () => Promise<KnownReplicas>;
    readonly admit: (replicaId: string, publicKeyBase64Url: string, now?: () => Date) => Promise<AdmitDecision>;
    readonly revoke: (replicaId: string, now?: () => Date) => Promise<void>;
    readonly setLabel: (replicaId: string, label: string) => Promise<void>;
}
export declare const createKnownReplicasStore: (vaultPath: string) => KnownReplicasStore;
//# sourceMappingURL=knownReplicas.d.ts.map