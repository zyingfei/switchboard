import type { VersionVector } from './causal.js';
export type ProjectionChangeKind = 'upsert' | 'delete';
export interface ProjectionChange {
    readonly seq: number;
    readonly aggregate: string;
    readonly aggregateId: string;
    readonly relPath: string;
    readonly vector: VersionVector;
    readonly kind: ProjectionChangeKind;
    readonly localWrittenAtMs: number;
}
export interface AppendChangeInput {
    readonly aggregate: string;
    readonly aggregateId: string;
    readonly relPath: string;
    readonly vector: VersionVector;
    readonly kind: ProjectionChangeKind;
}
export interface ProjectionChangeFeed {
    readonly appendChange: (input: AppendChangeInput) => Promise<ProjectionChange>;
    readonly readSince: (sinceSeq: number) => Promise<{
        readonly cursor: number;
        readonly changed: readonly ProjectionChange[];
    }>;
}
export declare const createProjectionChangeFeed: (vaultPath: string, options?: {
    readonly now?: () => number;
}) => ProjectionChangeFeed;
//# sourceMappingURL=projectionChanges.d.ts.map