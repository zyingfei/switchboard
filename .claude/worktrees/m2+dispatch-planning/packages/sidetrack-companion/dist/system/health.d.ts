import type { RecallActivityReport } from '../recall/activity.js';
export interface CaptureProviderHealth {
    readonly provider: string;
    readonly lastCaptureAt: string | null;
    readonly lastStatus: 'ok' | 'warning' | 'failed' | null;
    readonly ok24h: number;
    readonly warn24h: number;
    readonly fail24h: number;
    readonly warning?: string;
}
export interface CaptureWarningHealth {
    readonly provider: string;
    readonly capturedAt: string;
    readonly code: string;
    readonly message: string;
    readonly severity: 'info' | 'warning';
}
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
        readonly providers?: readonly CaptureProviderHealth[];
        readonly recentWarnings?: readonly CaptureWarningHealth[];
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
        readonly activity?: RecallActivityReport;
        readonly drift?: {
            readonly eventTurnCount: number;
            readonly entryCount: number;
            readonly pct: number;
            readonly tolerance: number;
        };
        readonly model?: {
            readonly id: string;
            readonly revision: string;
            readonly cacheDir: string;
            readonly present: boolean;
            readonly verified: boolean;
            readonly offline: boolean;
        };
    };
    readonly service: {
        readonly installed: boolean;
        readonly running: boolean;
    };
    readonly sync?: {
        readonly replicaId: string;
        readonly seq: number;
        readonly relay?: {
            readonly mode: 'local' | 'remote';
            readonly url: string;
        };
        readonly materializers?: Record<string, {
            readonly status: 'healthy' | 'degraded' | 'failed';
            readonly lastSuccessAt: string | null;
            readonly lastError: string | null;
            readonly pending: boolean;
        }>;
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
    readonly syncSummary?: () => HealthReport['sync'];
}
export declare const collectHealth: (deps: HealthDeps) => Promise<HealthReport>;
//# sourceMappingURL=health.d.ts.map