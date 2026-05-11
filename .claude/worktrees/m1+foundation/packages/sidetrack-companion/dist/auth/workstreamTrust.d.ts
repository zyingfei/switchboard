export declare const workstreamWriteTools: readonly ["bac.move_item", "bac.queue_item", "bac.bump_workstream", "bac.archive_thread", "bac.unarchive_thread"];
export type WorkstreamWriteTool = (typeof workstreamWriteTools)[number];
export interface Trust {
    readonly workstreamId: string;
    readonly allowedTools: ReadonlySet<WorkstreamWriteTool>;
}
export declare const readTrust: (vaultRoot: string) => Promise<readonly Trust[]>;
export declare const writeTrust: (vaultRoot: string, list: readonly Trust[]) => Promise<void>;
export declare const isAllowed: (workstreamId: string, tool: WorkstreamWriteTool, list: readonly Trust[]) => boolean;
//# sourceMappingURL=workstreamTrust.d.ts.map