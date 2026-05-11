import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalEventString, maxVector, sortAcceptedEvents, vectorFromEvents, } from './causal.js';
// Errors surfaced when a peer event collides with an existing event
// under the (replicaId, seq) "dot" identity, or when a clientEventId
// gets reused under a different dot. Either case suggests a buggy
// or malicious peer; the runtime quarantines that replica rather
// than persisting the event.
export class DotCollisionError extends Error {
    dot;
    storedClientEventId;
    incomingClientEventId;
    constructor(dot, storedClientEventId, incomingClientEventId) {
        super(`Peer event collides on (${dot.replicaId}, ${String(dot.seq)}): existing clientEventId=${storedClientEventId}, incoming=${incomingClientEventId}`);
        this.dot = dot;
        this.storedClientEventId = storedClientEventId;
        this.incomingClientEventId = incomingClientEventId;
    }
}
export class ClientEventIdReuseError extends Error {
    clientEventId;
    storedDot;
    incomingDot;
    constructor(clientEventId, storedDot, incomingDot) {
        super(`clientEventId ${clientEventId} already bound to (${storedDot.replicaId}, ${String(storedDot.seq)}); incoming claims (${incomingDot.replicaId}, ${String(incomingDot.seq)})`);
        this.clientEventId = clientEventId;
        this.storedDot = storedDot;
        this.incomingDot = incomingDot;
    }
}
const LOG_ROOT_SEGMENTS = ['_BAC', 'log'];
const replicaDirSegment = (replicaId) => {
    if (!/^[0-9a-zA-Z._-]+$/.test(replicaId)) {
        throw new Error(`Invalid replicaId for event log path: ${replicaId}`);
    }
    return replicaId;
};
const dateStamp = (value) => value.toISOString().slice(0, 10);
const eventLogRoot = (vaultPath) => join(vaultPath, ...LOG_ROOT_SEGMENTS);
const replicaLogDir = (vaultPath, replicaId) => join(eventLogRoot(vaultPath), replicaDirSegment(replicaId));
const replicaLogPath = (vaultPath, replicaId, date) => join(replicaLogDir(vaultPath, replicaId), `${dateStamp(date)}.jsonl`);
const isAcceptedEvent = (value) => {
    if (typeof value !== 'object' || value === null)
        return false;
    const entry = value;
    if (typeof entry['clientEventId'] !== 'string')
        return false;
    const dot = entry['dot'];
    if (typeof dot !== 'object' || dot === null)
        return false;
    const dotRecord = dot;
    if (typeof dotRecord['replicaId'] !== 'string' || typeof dotRecord['seq'] !== 'number') {
        return false;
    }
    if (typeof entry['deps'] !== 'object' || entry['deps'] === null)
        return false;
    if (typeof entry['aggregateId'] !== 'string')
        return false;
    if (typeof entry['type'] !== 'string')
        return false;
    if (typeof entry['payload'] !== 'object' || entry['payload'] === null)
        return false;
    if (typeof entry['acceptedAtMs'] !== 'number')
        return false;
    return true;
};
const parseLine = (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0)
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        return isAcceptedEvent(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
};
const readLogFile = async (path) => {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    const events = [];
    for (const line of text.split('\n')) {
        const event = parseLine(line);
        if (event !== null)
            events.push(event);
    }
    return events;
};
const listJsonlFiles = async (dir) => {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map((entry) => join(dir, entry.name));
};
export const createEventLog = (vaultPath, replica, options = {}) => {
    const now = options.now ?? (() => new Date());
    let writeChain = Promise.resolve();
    const enqueueAppend = (task) => {
        const next = writeChain.then(task, task);
        writeChain = next.then(() => undefined, () => undefined);
        return next;
    };
    const readReplica = async (replicaId) => {
        const dir = replicaLogDir(vaultPath, replicaId);
        const files = (await listJsonlFiles(dir)).sort();
        const all = [];
        for (const file of files) {
            const events = await readLogFile(file);
            for (const event of events) {
                if (event.dot.replicaId === replicaId)
                    all.push(event);
            }
        }
        return sortAcceptedEvents(all);
    };
    const listReplicaIds = async () => {
        let entries;
        try {
            entries = await readdir(eventLogRoot(vaultPath), { withFileTypes: true });
        }
        catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    };
    const readMerged = async () => {
        const ids = await listReplicaIds();
        const all = [];
        for (const id of ids) {
            for (const event of await readReplica(id))
                all.push(event);
        }
        return sortAcceptedEvents(all);
    };
    const readByAggregate = async (aggregateId) => {
        const merged = await readMerged();
        return merged.filter((event) => event.aggregateId === aggregateId);
    };
    const findByClientEventId = async (clientEventId) => {
        const merged = await readMerged();
        return merged.find((event) => event.clientEventId === clientEventId) ?? null;
    };
    const findByDot = async (dot) => {
        const merged = await readMerged();
        return (merged.find((event) => event.dot.replicaId === dot.replicaId && event.dot.seq === dot.seq) ?? null);
    };
    const appendClient = (input) => enqueueAppend(async () => {
        const existing = await findByClientEventId(input.clientEventId);
        if (existing !== null) {
            return existing;
        }
        // Resolve clientDeps to dots so deps reflects "everything the
        // editor caused or observed at edit time."
        const merged = await readMerged();
        const deps = computeDepsFromInput(input, merged);
        const seq = await replica.nextSeq();
        const event = {
            clientEventId: input.clientEventId,
            dot: { replicaId: replica.replicaId, seq },
            deps,
            aggregateId: input.aggregateId,
            type: input.type,
            payload: input.payload,
            acceptedAtMs: now().getTime(),
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.hlc === undefined
                ? options.hlcStamper !== undefined
                    ? maybeAttachHlc(options.hlcStamper())
                    : {}
                : { hlc: input.hlc }),
        };
        const dir = replicaLogDir(vaultPath, replica.replicaId);
        await mkdir(dir, { recursive: true });
        await writeFile(replicaLogPath(vaultPath, replica.replicaId, now()), `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
        return event;
    });
    const importPeerEvent = (event) => enqueueAppend(async () => {
        // Refusing imports under our own replica id keeps the local
        // shard truthful — only `appendClient` writes there.
        if (event.dot.replicaId === replica.replicaId) {
            return { imported: false };
        }
        const byDot = await findByDot(event.dot);
        if (byDot !== null) {
            if (canonicalEquals(byDot, event)) {
                return { imported: false };
            }
            throw new DotCollisionError(event.dot, byDot.clientEventId, event.clientEventId);
        }
        const byClient = await findByClientEventId(event.clientEventId);
        if (byClient !== null) {
            // Same clientEventId arriving under a different dot: a peer
            // is reusing the id under different identities. Reject.
            throw new ClientEventIdReuseError(event.clientEventId, byClient.dot, event.dot);
        }
        const dir = replicaLogDir(vaultPath, event.dot.replicaId);
        await mkdir(dir, { recursive: true });
        const at = new Date(event.acceptedAtMs);
        await writeFile(replicaLogPath(vaultPath, event.dot.replicaId, at), `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
        // Each replica's seq counter is independent; we don't bump our
        // own seq when ingesting a peer event (that would corrupt our
        // local namespace). Causal ordering across replicas is handled
        // entirely by `deps`/dot comparisons in eventDominates.
        return { imported: true };
    });
    // Named APIs — production code uses these.
    const appendClientObserved = (input) => appendClient({
        clientEventId: input.clientEventId,
        aggregateId: input.aggregateId,
        type: input.type,
        payload: input.payload,
        baseVector: input.baseVector,
        ...(input.clientDeps === undefined ? {} : { clientDeps: input.clientDeps }),
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.hlc === undefined ? {} : { hlc: input.hlc }),
    });
    const appendServerObserved = (input) => appendClient({
        clientEventId: input.clientEventId,
        aggregateId: input.aggregateId,
        type: input.type,
        payload: input.payload,
        // baseVector deliberately absent → auto-resolve from frontier.
        ...(input.clientDeps === undefined ? {} : { clientDeps: input.clientDeps }),
        ...(input.target === undefined ? {} : { target: input.target }),
        ...(input.hlc === undefined ? {} : { hlc: input.hlc }),
    });
    return {
        appendClient,
        appendClientObserved,
        appendServerObserved,
        readMerged,
        readReplica,
        readByAggregate,
        findByClientEventId,
        findByDot,
        listReplicaIds,
        importPeerEvent,
    };
};
// Canonical event equality. Two events are "the same fact" iff
// every field except the cosmetic `hlc` block matches byte-for-byte.
// Used by importPeerEvent to distinguish a benign re-delivery from a
// true dot collision. Implementation lives in `causal.ts`
// (`canonicalEventString`) and is shared with the relay's signing
// payload so the local equality test and the wire signature scope
// stay in lockstep.
const canonicalEquals = (a, b) => canonicalEventString(a) === canonicalEventString(b);
// Critical correctness rule: deps must reflect the editor's observed
// state at edit time, NOT the companion's current frontier. Otherwise
// an outbox replay arriving after peer events would falsely claim to
// have observed those peer events and silently win conflicts.
//
// We resolve `clientDeps` against the merged log so events that
// depend on a sibling event in the SAME POST batch (e.g. a comment.set
// after a span.added) get the right dot. clientDeps that don't
// resolve are dropped (they refer to events not yet in our log;
// they'll be reconstructed when the missing events arrive).
const computeDepsFromInput = (input, merged) => {
    // Sync Contract v1: two semantics, expressed by presence of
    // `baseVector`:
    //
    //   - Browser-observed (appendClientObserved): baseVector is
    //     present (possibly `{}`). Deps stamped EXACTLY from
    //     baseVector. Empty `{}` means "browser observed nothing"
    //     and is a legitimate state — a stale outbox arriving after
    //     peer events drained is accepted as concurrent (does not
    //     dominate). The companion does NOT replace the explicit
    //     vector with its own frontier.
    //
    //   - Server-observed (appendServerObserved): baseVector is
    //     omitted. Deps stamped from the union of every prior event
    //     for the SAME aggregate. The caller asserts they ARE the
    //     latest server-observed state.
    //
    // Tests that simulate concurrent first-writes call this method
    // (or appendClient) with `baseVector: {}` directly — that's
    // the legitimate empty-observation case. There is no escape
    // hatch field; empty is just a legal arg.
    const explicit = input.baseVector;
    let deps;
    if (explicit !== undefined) {
        deps = explicit;
    }
    else {
        deps = vectorFromEvents(merged.filter((event) => event.aggregateId === input.aggregateId));
    }
    if (input.clientDeps !== undefined && input.clientDeps.length > 0) {
        const byClientId = new Map();
        for (const event of merged)
            byClientId.set(event.clientEventId, event);
        for (const dep of input.clientDeps) {
            const resolved = byClientId.get(dep);
            if (resolved !== undefined) {
                deps = maxVector(deps, { [resolved.dot.replicaId]: resolved.dot.seq });
            }
        }
    }
    return deps;
};
const maybeAttachHlc = (hlc) => hlc === undefined ? {} : { hlc };
//# sourceMappingURL=eventLog.js.map