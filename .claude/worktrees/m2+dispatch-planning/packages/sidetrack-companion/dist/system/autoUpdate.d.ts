import { type UpdateAdvisory } from './versionCheck.js';
export interface UpdateResult {
    readonly ok: boolean;
    readonly from: string;
    readonly to: string | null;
    readonly durationMs: number;
    readonly stderr?: string;
}
export interface AutoUpdateExecPort {
    readonly execFile: (file: string, args: readonly string[]) => Promise<{
        readonly stdout: string;
        readonly stderr: string;
    }>;
}
export declare const nodeAutoUpdateExecPort: AutoUpdateExecPort;
export declare const runAutoUpdate: (opts: {
    readonly confirm: string;
    readonly currentVersion: string;
    readonly exec?: AutoUpdateExecPort;
    readonly checkLatest?: (currentVersion: string, now: Date) => Promise<UpdateAdvisory>;
    readonly nowFn?: () => Date;
}) => Promise<UpdateResult>;
//# sourceMappingURL=autoUpdate.d.ts.map