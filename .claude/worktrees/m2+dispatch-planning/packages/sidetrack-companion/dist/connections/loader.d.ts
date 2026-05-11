import type { TimelineDayProjection, TimelineStore } from '../timeline/projection.js';
import type { CodingSessionVaultRecord, DispatchVaultRecord, QueueVaultRecord, ReminderVaultRecord, ThreadVaultRecord, WorkstreamVaultRecord } from './snapshot.js';
export interface VaultReadResult {
    readonly threads: readonly ThreadVaultRecord[];
    readonly workstreams: readonly WorkstreamVaultRecord[];
    readonly dispatches: readonly DispatchVaultRecord[];
    readonly queueItems: readonly QueueVaultRecord[];
    readonly reminders: readonly ReminderVaultRecord[];
    readonly codingSessions: readonly CodingSessionVaultRecord[];
}
export declare const readVaultStores: (vaultRoot: string) => Promise<VaultReadResult>;
export declare const readAllTimelineDays: (store: TimelineStore) => Promise<readonly TimelineDayProjection[]>;
//# sourceMappingURL=loader.d.ts.map