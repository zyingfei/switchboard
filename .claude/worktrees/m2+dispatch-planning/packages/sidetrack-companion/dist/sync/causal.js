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
export const vectorCovers = (vector, dot) => (vector[dot.replicaId] ?? 0) >= dot.seq;
export const maxVector = (a, b) => {
    const out = { ...a };
    for (const [replicaId, seq] of Object.entries(b)) {
        out[replicaId] = Math.max(out[replicaId] ?? 0, seq);
    }
    return out;
};
// `newer` causally observes `older` (and so supersedes it). Equal
// dots are not "dominated by themselves" — comparing an event to
// itself returns false, the caller is responsible for excluding the
// self comparison.
export const eventDominates = (newer, older) => {
    if (newer.dot.replicaId === older.dot.replicaId && newer.dot.seq === older.dot.seq) {
        return false;
    }
    return vectorCovers(newer.deps, older.dot);
};
// Per-aggregate vector: union of every event's dot.
export const vectorFromEvents = (events) => {
    const vector = {};
    for (const event of events) {
        const previous = vector[event.dot.replicaId] ?? 0;
        if (event.dot.seq > previous)
            vector[event.dot.replicaId] = event.dot.seq;
    }
    return vector;
};
// Causal register fold. A candidate survives iff no other candidate
// causally observed it. One survivor → resolved; multiple → conflict.
// The empty input maps to a value-less resolved projection so callers
// can render "no value yet" without branching on undefined.
export const mergeRegister = (values) => {
    const survivors = values.filter((candidate) => !values.some((other) => other !== candidate && eventDominates(other.event, candidate.event)));
    const [first, second] = survivors;
    if (first === undefined)
        return { status: 'resolved' };
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
            .sort((a, b) => a.acceptedAtMs - b.acceptedAtMs ||
            (a.replicaId < b.replicaId ? -1 : a.replicaId > b.replicaId ? 1 : 0) ||
            a.event.seq - b.event.seq),
    };
};
// Stable order for projection passes that need a single iteration
// pass. Sort by (replicaId, seq) so deterministic builds produce
// byte-identical output. Causal merge logic does NOT depend on this
// order — it's only for projection-build determinism.
export const sortAcceptedEvents = (events) => [...events].sort((a, b) => {
    if (a.dot.replicaId < b.dot.replicaId)
        return -1;
    if (a.dot.replicaId > b.dot.replicaId)
        return 1;
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
export const canonicalEventBytes = (event) => Buffer.from(canonicalEventString(event), 'utf8');
export const canonicalEventString = (event) => JSON.stringify({
    clientEventId: event.clientEventId,
    dot: { replicaId: event.dot.replicaId, seq: event.dot.seq },
    deps: sortedRecord(event.deps),
    aggregateId: event.aggregateId,
    target: event.target ?? null,
    type: event.type,
    payload: event.payload,
    acceptedAtMs: event.acceptedAtMs,
});
const sortedRecord = (record) => {
    const out = {};
    for (const key of Object.keys(record).sort()) {
        const value = record[key];
        if (value !== undefined) {
            out[key] = value;
        }
    }
    return out;
};
//# sourceMappingURL=causal.js.map