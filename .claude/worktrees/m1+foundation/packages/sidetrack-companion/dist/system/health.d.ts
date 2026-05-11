export interface HealthReport {
    readonly uptimeSec: number;
    readonly vault: {
        readonly root: string;
        readonly writable: boolean;
        readonly sizeBytes: number | null;
    };
    readonly capture: {
        readonly lastByProvider: Record<string, string | null>;
        readonly queueDepthHint: number | null;
        readonly droppedHint: number | null;
    };
    readonly recall: {
        readonly indexExists: boolean;
        readonly entryCount: number | null;
        readonly modelId: string | null;
        readonly sizeBytes: number | null;
        readonly status?: 'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready';
        readonly eventTurnCount?: number;
        readonly currentModelId?: string;
        readonly companionVersion?: string;
        readonly lastRebuildAt?: string | null;
        readonly lastRebuildIndexed?: number | null;
        readonly lastError?: string | null;
        readonly rebuildEmbedded?: number;
        readonly rebuildTotal?: number;
        readonly embedderDevice?: 'cpu' | 'wasm' | 'webgpu' | 'unknown';
        readonly embedderAccelerator?: 'accelerate' | 'mkl' | 'cpu' | 'unknown';
    };
    readonly service: {
        readonly installed: boolean;
        readonly running: boolean;
    };
}
export interface HealthDeps {
    readonly startedAt: Date;
    readonly now?: () => Date;
    readonly vaultRoot: string;
    readonly vaultWritable: () => Promise<boolean>;
    readonly vaultSizeBytes: () => Promise<number | null>;
    readonly captureSummary: () => Promise<HealthReport['capture']>;
    readonly recallSummary: () => Promise<HealthReport['recall']>;
    readonly serviceStatus: () => Promise<HealthReport['service']>;
}
export declare const collectHealth: (deps: HealthDeps) => Promise<HealthReport>;
//# sourceMappingURL=health.d.ts.map