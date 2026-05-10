import type { AcceptedEvent } from '../sync/causal.js';
export interface RecallProjectionInput {
    readonly id: string;
    readonly threadId: string;
    readonly capturedAt: string;
    readonly text: string;
    readonly replicaId: string;
    readonly lamport: number;
    readonly tombstoned: boolean;
    readonly sourceBacId: string;
    readonly turnOrdinal: number;
    readonly markdown?: string;
    readonly formattedText?: string;
    readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
    readonly modelName?: string;
    readonly provider?: string;
    readonly threadUrl?: string;
    readonly title?: string;
}
export declare const projectRecallFromLog: (events: readonly AcceptedEvent[]) => readonly RecallProjectionInput[];
export declare const collectLogBacIds: (events: readonly AcceptedEvent[]) => ReadonlySet<string>;
//# sourceMappingURL=projection.d.ts.map