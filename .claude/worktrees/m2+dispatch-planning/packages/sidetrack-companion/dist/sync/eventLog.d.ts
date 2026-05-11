import { type AcceptedEvent, type Dot, type Hlc, type TargetRef, type VersionVector } from './causal.js';
import type { ReplicaContext } from './replicaId.js';
export declare class DotCollisionError extends Error {
    readonly dot: Dot;
    readonly storedClientEventId: string;
    readonly incomingClientEventId: string;
    constructor(dot: Dot, storedClientEventId: string, incomingClientEventId: string);
}
export declare class ClientEventIdReuseError extends Error {
    readonly clientEventId: string;
    readonly storedDot: Dot;
    readonly incomingDot: Dot;
    constructor(clientEventId: string, storedDot: Dot, incomingDot: Dot);
}
export interface AppendInputObserved<TPayload extends Record<string, unknown> = Record<string, unknown>> {
    readonly clientEventId: string;
    readonly aggregateId: string;
    readonly type: string;
    readonly payload: TPayload;
    readonly baseVector: VersionVector;
    readonly clientDeps?: readonly string[];
    readonly target?: TargetRef;
    readonly hlc?: Hlc;
}
export interface AppendInputServerObserved<TPayload extends Record<string, unknown> = Record<string, unknown>> {
    readonly clientEventId: string;
    readonly aggregateId: string;
    readonly type: string;
    readonly payload: TPayload;
    readonly clientDeps?: readonly string[];
    readonly target?: TargetRef;
    readonly hlc?: Hlc;
}
/**
 * @internal Shared backing type for the two named APIs. Test code
 * may call `appendClient` directly (with optional baseVector) for
 * legacy concurrency simulations; production code must use
 * `appendClientObserved` or `appendServerObserved`.
 */
export interface AppendInput<TPayload extends Record<string, unknown> = Record<string, unknown>> {
    readonly clientEventId: string;
    readonly aggregateId: string;
    readonly type: string;
    readonly payload: TPayload;
    readonly baseVector?: VersionVector;
    readonly clientDeps?: readonly string[];
    readonly target?: TargetRef;
    readonly hlc?: Hlc;
}
export interface EventLog {
    /**
     * Browser-driven event append. baseVector REQUIRED, may be `{}`.
     * See Sync Contract v1 / `AppendInputObserved`.
     */
    readonly appendClientObserved: <TPayload extends Record<string, unknown>>(input: AppendInputObserved<TPayload>) => Promise<AcceptedEvent<TPayload>>;
    /**
     * Server-driven event append. System stamps deps from the
     * aggregate's prior events. See `AppendInputServerObserved`.
     */
    readonly appendServerObserved: <TPayload extends Record<string, unknown>>(input: AppendInputServerObserved<TPayload>) => Promise<AcceptedEvent<TPayload>>;
    /**
     * @internal Shared implementation behind the two named APIs.
     * Test code may use this directly for legacy concurrency
     * simulations. Production code must use `appendClientObserved`
     * or `appendServerObserved`.
     */
    readonly appendClient: <TPayload extends Record<string, unknown>>(input: AppendInput<TPayload>) => Promise<AcceptedEvent<TPayload>>;
    readonly readMerged: () => Promise<readonly AcceptedEvent[]>;
    readonly readReplica: (replicaId: string) => Promise<readonly AcceptedEvent[]>;
    readonly readByAggregate: (aggregateId: string) => Promise<readonly AcceptedEvent[]>;
    readonly findByClientEventId: (clientEventId: string) => Promise<AcceptedEvent | null>;
    readonly findByDot: (dot: Dot) => Promise<AcceptedEvent | null>;
    readonly listReplicaIds: () => Promise<readonly string[]>;
    readonly importPeerEvent: (event: AcceptedEvent) => Promise<{
        readonly imported: boolean;
    }>;
}
export interface EventLogOptions {
    readonly now?: () => Date;
    readonly hlcStamper?: () => Hlc | undefined;
}
export declare const createEventLog: (vaultPath: string, replica: ReplicaContext, options?: EventLogOptions) => EventLog;
//# sourceMappingURL=eventLog.d.ts.map