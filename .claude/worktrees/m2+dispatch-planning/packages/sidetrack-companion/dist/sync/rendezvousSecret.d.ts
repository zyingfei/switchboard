export interface EnsuredRendezvousSecret {
    readonly secret: string;
    readonly path: string;
    readonly created: boolean;
}
export declare const ensureRendezvousSecret: (vaultRoot: string, preferred?: string) => Promise<EnsuredRendezvousSecret>;
//# sourceMappingURL=rendezvousSecret.d.ts.map