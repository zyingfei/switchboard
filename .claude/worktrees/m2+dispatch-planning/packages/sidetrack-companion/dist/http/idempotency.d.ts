export interface IdempotencyRecord {
    readonly status: number;
    readonly body: unknown;
    readonly expiresAt?: string;
}
export interface IdempotencyStore {
    readonly read: (route: string, key: string) => Promise<IdempotencyRecord | undefined>;
    readonly write: (route: string, key: string, record: IdempotencyRecord) => Promise<void>;
    readonly gcExpired?: (now: Date) => Promise<{
        readonly removed: number;
    }>;
}
export declare const createIdempotencyStore: (vaultPath: string) => IdempotencyStore;
//# sourceMappingURL=idempotency.d.ts.map