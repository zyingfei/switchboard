export const createInMemoryTransport = () => {
    const subscribers = new Set();
    const publishEvent = (replicaId, event) => {
        for (const sub of subscribers) {
            if (sub.knownReplicas.size === 0 || sub.knownReplicas.has(replicaId)) {
                sub.onEvent(replicaId, event);
            }
        }
        return Promise.resolve();
    };
    const subscribePeers = (knownReplicas, onEvent) => {
        const entry = { knownReplicas, onEvent };
        subscribers.add(entry);
        return () => {
            subscribers.delete(entry);
        };
    };
    const drain = () => {
        subscribers.clear();
    };
    return { publishEvent, subscribePeers, drain };
};
const isInsideLog = (relPath) => {
    const segments = relPath.split('/').filter((s) => s.length > 0);
    return segments[0] === '_BAC' && segments[1] === 'log' && segments[2] !== undefined;
};
const peerFromPath = (relPath) => {
    const segments = relPath.split('/').filter((s) => s.length > 0);
    return segments[0] === '_BAC' && segments[1] === 'log' ? (segments[2] ?? null) : null;
};
export const createLocalFsTransport = (opts) => {
    // Peers see local writes directly via the vault watcher, so the
    // file IS the publication. Function signature matches the
    // LogTransport interface; both args are intentionally unused.
    const publishEvent = (replicaId, event) => {
        void replicaId;
        void event;
        return Promise.resolve();
    };
    const subscribePeers = (knownReplicas, onEvent) => {
        let active = true;
        const seen = new Map();
        const recordSeen = (peerId, eventId) => {
            let set = seen.get(peerId);
            if (set === undefined) {
                set = new Set();
                seen.set(peerId, set);
            }
            if (set.has(eventId))
                return false;
            set.add(eventId);
            return true;
        };
        const drainPeer = async (peerId) => {
            if (!active)
                return;
            if (peerId === opts.localReplicaId)
                return;
            if (knownReplicas.size > 0 && !knownReplicas.has(peerId))
                return;
            const events = await opts.readReplica(peerId);
            for (const event of events) {
                if (event.dot.replicaId !== peerId)
                    continue;
                if (!recordSeen(peerId, event.clientEventId))
                    continue;
                onEvent(peerId, event);
            }
        };
        void (async () => {
            const peers = await opts.listReplicaIds();
            for (const peerId of peers) {
                await drainPeer(peerId);
            }
        })();
        const unsubscribe = opts.subscribePaths((relPath) => {
            if (!isInsideLog(relPath))
                return;
            const peerId = peerFromPath(relPath);
            if (peerId === null)
                return;
            void drainPeer(peerId);
        });
        return () => {
            active = false;
            unsubscribe();
        };
    };
    return { publishEvent, subscribePeers };
};
// Relay transport lives in `relayTransport.ts`; re-exported via the
// runtime entry point in `runtime/companion.ts`. Keeping the stub
// removed here avoids accidental imports of a placeholder.
//# sourceMappingURL=transport.js.map