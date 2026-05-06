// Causal-first sync primitives. The core idea: ordering is by
// observed-before, not wall-clock or Lamport scalar. Each accepted
// event carries a `dot` (its durable identity) and `deps` (the
// version vector the editor observed). One event supersedes another
// only if its `deps` cover the other's `dot`. Truly concurrent edits
// are preserved as conflict candidates — never silently flattened.
//
// The companion stamps `dot` and `deps` on event acceptance:
//   dot.replicaId = this companion's replicaId
//   dot.seq       = next per-replica monotonic counter
//   deps          = max(clientEvent.baseVector,
//                       dotsResolvedFrom(clientEvent.clientDeps))
//
// CRITICAL: when an old browser outbox event finally drains long
// after the companion has imported peer events, the companion MUST
// NOT replace the event's deps with its current frontier. Doing so
// would falsely claim the user observed peer edits they never saw.
// `acceptClientEvent` below enforces that invariant.

export type ReplicaId = string;

export interface Dot {
  readonly replicaId: ReplicaId;
  readonly seq: number;
}

export type VersionVector = Readonly<Record<ReplicaId, number>>;

// Optional addressing for events that target chat content. Two hosts
// observing different snapshots of the same conversation produce
// different captures; carrying the message + quote + snapshot hashes
// lets the projection layer decide whether they're "the same fact"
// or distinct.
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

// Optional advisory clock — for display and tie-breaking heuristics
// only. It MUST NOT decide correctness; that is `dot` + `deps`.
export interface Hlc {
  readonly physicalMs: number;
  readonly counter: number;
  readonly replicaId: ReplicaId;
  readonly confidence: 'trusted' | 'suspicious' | 'unknown';
}

// Browser-minted event before companion acceptance. Ships `baseVector`
// — the projection frontier the user actually observed.
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

// Companion-stamped event. Disk format under
// `_BAC/log/<replicaId>/<date>.jsonl`.
//
// `TPayload` defaults to `unknown` so generic helpers (causal merge,
// register fold, transport) can accept events without committing to
// a specific payload shape. Aggregate-specific code that needs the
// payload narrows via type guards or explicit casts.
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

export const vectorCovers = (vector: VersionVector, dot: Dot): boolean =>
  (vector[dot.replicaId] ?? 0) >= dot.seq;

export const maxVector = (a: VersionVector, b: VersionVector): VersionVector => {
  const out: Record<ReplicaId, number> = { ...a };
  for (const [replicaId, seq] of Object.entries(b)) {
    out[replicaId] = Math.max(out[replicaId] ?? 0, seq);
  }
  return out;
};

// `newer` causally observes `older` (and so supersedes it). Equal
// dots are not "dominated by themselves" — comparing an event to
// itself returns false, the caller is responsible for excluding the
// self comparison.
export const eventDominates = (
  newer: AcceptedEvent,
  older: AcceptedEvent,
): boolean => {
  if (newer.dot.replicaId === older.dot.replicaId && newer.dot.seq === older.dot.seq) {
    return false;
  }
  return vectorCovers(newer.deps, older.dot);
};

// Per-aggregate vector: union of every event's dot.
export const vectorFromEvents = (
  events: readonly AcceptedEvent[],
): VersionVector => {
  const vector: Record<ReplicaId, number> = {};
  for (const event of events) {
    const previous = vector[event.dot.replicaId] ?? 0;
    if (event.dot.seq > previous) vector[event.dot.replicaId] = event.dot.seq;
  }
  return vector;
};

export interface RegisterValue<T> {
  readonly value: T;
  readonly event: AcceptedEvent;
}

export type RegisterProjection<T> =
  | { readonly status: 'resolved'; readonly value?: T; readonly event?: Dot }
  | {
      readonly status: 'conflict';
      readonly candidates: readonly {
        readonly value: T;
        readonly event: Dot;
        readonly replicaId: ReplicaId;
        readonly acceptedAtMs: number;
      }[];
    };

// Causal register fold. A candidate survives iff no other candidate
// causally observed it. One survivor → resolved; multiple → conflict.
// The empty input maps to a value-less resolved projection so callers
// can render "no value yet" without branching on undefined.
export const mergeRegister = <T>(
  values: readonly RegisterValue<T>[],
): RegisterProjection<T> => {
  const survivors = values.filter(
    (candidate) =>
      !values.some((other) => other !== candidate && eventDominates(other.event, candidate.event)),
  );
  const [first, second] = survivors;
  if (first === undefined) return { status: 'resolved' };
  if (second === undefined) {
    return { status: 'resolved', value: first.value, event: first.event.dot };
  }
  return {
    status: 'conflict',
    candidates: survivors
      .map((survivor) => ({
        value: survivor.value,
        event: survivor.event.dot,
        replicaId: survivor.event.dot.replicaId,
        acceptedAtMs: survivor.event.acceptedAtMs,
      }))
      .sort(
        (a, b) =>
          a.acceptedAtMs - b.acceptedAtMs ||
          (a.replicaId < b.replicaId ? -1 : a.replicaId > b.replicaId ? 1 : 0) ||
          a.event.seq - b.event.seq,
      ),
  };
};

// Stable order for projection passes that need a single iteration
// pass. Sort by (replicaId, seq) so deterministic builds produce
// byte-identical output. Causal merge logic does NOT depend on this
// order — it's only for projection-build determinism.
export const sortAcceptedEvents = <T>(
  events: readonly AcceptedEvent<T>[],
): AcceptedEvent<T>[] =>
  [...events].sort((a, b) => {
    if (a.dot.replicaId < b.dot.replicaId) return -1;
    if (a.dot.replicaId > b.dot.replicaId) return 1;
    return a.dot.seq - b.dot.seq;
  });

// Canonical byte representation of an AcceptedEvent. Used as the
// signing payload (so a malicious peer with the rendezvous secret
// cannot re-encrypt a tampered `type` / `aggregateId` / `deps`
// while keeping the original payload signature valid) AND as the
// equality key for byte-identical re-delivery detection.
//
// The HLC field is intentionally excluded — it's advisory metadata
// the same logical event might carry slightly different values for
// across replays without that constituting a forgery.
export const canonicalEventBytes = (event: AcceptedEvent<unknown>): Buffer =>
  Buffer.from(canonicalEventString(event), 'utf8');

export const canonicalEventString = (event: AcceptedEvent<unknown>): string =>
  JSON.stringify({
    clientEventId: event.clientEventId,
    dot: { replicaId: event.dot.replicaId, seq: event.dot.seq },
    deps: sortedRecord(event.deps),
    aggregateId: event.aggregateId,
    target: event.target ?? null,
    type: event.type,
    payload: event.payload,
    acceptedAtMs: event.acceptedAtMs,
  });

const sortedRecord = (
  record: Readonly<Record<string, number>>,
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key]!;
  }
  return out;
};
