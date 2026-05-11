import { type ConflictRecord } from './schemas.js';
export interface ImportResult {
    readonly applied: number;
    readonly skipped: number;
    readonly conflicts: readonly ConflictRecord[];
}
export declare const importSettings: (vaultRoot: string, input: unknown) => Promise<ImportResult>;
//# sourceMappingURL=importBundle.d.ts.map