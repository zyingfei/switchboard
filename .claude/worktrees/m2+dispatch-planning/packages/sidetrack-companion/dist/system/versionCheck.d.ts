export interface UpdateAdvisory {
    readonly current: string;
    readonly latest: string | null;
    readonly behind: boolean;
    readonly ageDays: number | null;
    readonly releasedAt: string | null;
    readonly warning?: string;
}
export declare const isBehind: (current: string, latest: string) => boolean;
export declare const clearVersionCheckCache: () => void;
export declare const checkLatestVersion: (currentVersion: string, fetchPort?: typeof globalThis.fetch, now?: Date) => Promise<UpdateAdvisory>;
//# sourceMappingURL=versionCheck.d.ts.map