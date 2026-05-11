import type { AcceptedEvent } from '../causal.js';
import type { EventLog } from '../eventLog.js';
import type { AcceptedEventContext, Materializer, MaterializerHealth } from './materializer.js';
export interface SyncContractRunner {
    readonly register: (m: Materializer) => void;
    readonly onAcceptedEvent: (event: AcceptedEvent, ctx: AcceptedEventContext) => void;
    readonly catchUpAll: (eventLog: EventLog) => Promise<void>;
    readonly onRelayReconnected: (eventLog: EventLog) => Promise<void>;
    readonly awaitIdle: () => Promise<void>;
    readonly health: () => Record<string, MaterializerHealth>;
}
export declare const createSyncContractRunner: () => SyncContractRunner;
//# sourceMappingURL=runner.d.ts.map