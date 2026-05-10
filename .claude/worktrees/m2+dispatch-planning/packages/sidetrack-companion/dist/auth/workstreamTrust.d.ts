export declare const workstreamWriteTools: readonly ["sidetrack.threads.move", "sidetrack.queue.create", "sidetrack.workstreams.bump", "sidetrack.threads.archive", "sidetrack.threads.unarchive"];
export type WorkstreamWriteTool = (typeof workstreamWriteTools)[number];
export interface Trust {
    readonly workstreamId: string;
    readonly allowedTools: ReadonlySet<WorkstreamWriteTool>;
}
export declare const readTrust: (vaultRoot: string) => Promise<readonly Trust[]>;
export declare const writeTrust: (vaultRoot: string, list: readonly Trust[]) => Promise<void>;
export declare const isAllowed: (workstreamId: string, tool: WorkstreamWriteTool, list: readonly Trust[]) => boolean;
export declare const defaultAllowedTools: () => readonly WorkstreamWriteTool[];
//# sourceMappingURL=workstreamTrust.d.ts.map