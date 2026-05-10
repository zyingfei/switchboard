export interface AuditRetentionResult {
    readonly removed: number;
}
export declare const enforceRetention: (vaultRoot: string, opts?: {
    readonly maxBytes?: number;
    readonly maxAgeDays?: number;
}, now?: Date) => Promise<AuditRetentionResult>;
//# sourceMappingURL=auditRetention.d.ts.map