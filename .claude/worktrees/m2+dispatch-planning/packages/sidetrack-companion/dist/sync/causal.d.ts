export type ReplicaId = string;
export interface Dot {
    readonly replicaId: ReplicaId;
    readonly seq: number;
}
export type VersionVector = Readonly<Record<ReplicaId, number>>;
export interface TargetRef {
    readonly provider?: string;
    readonly canonicalUrl?: string;
    readonly conversationId?: string;
    readonly messageId?: string;
    readonly turnOrdinal?: number;
    readonly role?: 'user' | 'assistant' | 'system';
    readonly quoteHash?: string;
    readonly anchorFingerprint?: string;
    readonly sourceSnapshotHash?: string;
}
export interface Hlc {
    readonly physicalMs: number;
    readonly counter: number;
    readonly replicaId: ReplicaId;
    readonly confidence: 'trusted' | 'suspicious' | 'unknown';
}
export interface ClientEvent<TPayload = unknown> {
    readonly clientEventId: string;
    readonly aggregateId: string;
    readonly target?: TargetRef;
    readonly type: string;
    readonly payload: TPayload;
    readonly baseVector: VersionVector;
    readonly clientDeps?: readonly string[];
    readonly clientCreatedAtMs?: number;
}
export interface AcceptedEvent<TPayload = unknown> {
    readonly clientEventId: string;
    readonly dot: Dot;
    readonly deps: VersionVector;
    readonly aggregateId: string;
    readonly target?: TargetRef;
    readonly type: string;
    readonly payload: TPayload;
    readonly acceptedAtMs: number;
    readonly hlc?: Hlc;
}
export declare const vectorCovers: (vector: VersionVector, dot: Dot) => boolean;
export declare const maxVector: (a: VersionVector, b: VersionVector) => VersionVector;
export declare const eventDominates: (newer: AcceptedEvent, older: AcceptedEvent) => boolean;
export declare const vectorFromEvents: (events: readonly AcceptedEvent[]) => VersionVector;
export interface RegisterValue<T> {
    readonly value: T;
    readonly event: AcceptedEvent;
}
export type RegisterProjection<T> = {
    readonly status: 'resolved';
    readonly value?: T;
    readonly event?: Dot;
} | {
    readonly status: 'conflict';
    readonly candidates: readonly {
        readonly value: T;
        readonly event: Dot;
        readonly replicaId: ReplicaId;
        readonly acceptedAtMs: number;
    }[];
};
export declare const mergeRegister: <T>(values: readonly RegisterValue<T>[]) => RegisterProjection<T>;
export declare const sortAcceptedEvents: <T>(events: readonly AcceptedEvent<T>[]) => AcceptedEvent<T>[];
export declare const canonicalEventBytes: (event: AcceptedEvent) => Buffer;
export declare const canonicalEventString: (event: AcceptedEvent) => string;
//# sourceMappingURL=causal.d.ts.map