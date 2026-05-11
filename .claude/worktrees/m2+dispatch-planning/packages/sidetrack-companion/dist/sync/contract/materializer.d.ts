import type { AcceptedEvent, VersionVector } from '../causal.js';
import type { EventLog } from '../eventLog.js';
export interface MaterializerHealth {
    readonly status: 'healthy' | 'degraded' | 'failed';
    readonly lastSuccessAt: string | null;
    readonly lastError: string | null;
    readonly pending: boolean;
    readonly frontier?: VersionVector;
}
export interface AcceptedEventContext {
    readonly origin: 'local' | 'peer';
}
export interface Materializer {
    readonly name: string;
    readonly handles: ReadonlySet<string>;
    readonly onAccepted: (event: AcceptedEvent, ctx: AcceptedEventContext) => void;
    readonly catchUp: (eventLog: EventLog) => Promise<void>;
    readonly awaitIdle: () => Promise<void>;
    readonly health: () => MaterializerHealth;
}
//# sourceMappingURL=materializer.d.ts.map