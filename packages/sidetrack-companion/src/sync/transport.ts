import type { AcceptedEvent } from './causal.js';

// Replica-to-replica transport for log shards. Each implementation
// adapts the abstract publish/subscribe operations to a concrete
// medium: filesystem (peers observe the log dir), in-memory (tests),
// or relay (PR 3 — Phase E, currently a throwing stub).
//
// The local persist-on-accept always goes through `eventLog.append` —
// `publishEvent` is a SIDE CHANNEL that informs peers a new event
// landed. For LocalFs that is a no-op because peers see the file
// directly. For Relay it pushes an encrypted frame upstream.

export interface LogTransport {
  readonly publishEvent: (replicaId: string, event: AcceptedEvent) => Promise<void>;
  // Subscribers can restrict the set of replicas they want to hear
  // from by passing a non-empty `knownReplicas` set; an empty set
  // means "deliver every peer event, even from replicas I haven't
  // seen before." Returns an unsubscribe handle.
  readonly subscribePeers: (
    knownReplicas: ReadonlySet<string>,
    onEvent: (replicaId: string, event: AcceptedEvent) => void,
  ) => () => void;
}

export interface InMemoryTransport extends LogTransport {
  readonly drain: () => void;
}

export const createInMemoryTransport = (): InMemoryTransport => {
  const subscribers = new Set<{
    readonly knownReplicas: ReadonlySet<string>;
    readonly onEvent: (replicaId: string, event: AcceptedEvent) => void;
  }>();

  const publishEvent = (replicaId: string, event: AcceptedEvent): Promise<void> => {
    for (const sub of subscribers) {
      if (sub.knownReplicas.size === 0 || sub.knownReplicas.has(replicaId)) {
        sub.onEvent(replicaId, event);
      }
    }
    return Promise.resolve();
  };

  const subscribePeers = (
    knownReplicas: ReadonlySet<string>,
    onEvent: (replicaId: string, event: AcceptedEvent) => void,
  ): (() => void) => {
    const entry = { knownReplicas, onEvent };
    subscribers.add(entry);
    return () => {
      subscribers.delete(entry);
    };
  };

  const drain = (): void => {
    subscribers.clear();
  };

  return { publishEvent, subscribePeers, drain };
};

// LocalFs transport. The on-disk event log is BOTH the durable
// record and the cross-replica message bus. publishEvent is a no-op
// because the file written by eventLog.append already lives in a
// directory peers observe via their vault watcher. subscribePeers
// fans changes from a generic file-watch subscription into per-event
// callbacks, replaying the existing on-disk state once on
// subscription so late-attached subscribers don't miss prior events.
//
// At-most-once delivery guarantees are NOT provided here — the
// caller dedupes by `event.id`. That keeps the transport stateless
// across restarts.

export interface LocalFsTransportOptions {
  readonly localReplicaId: string;
  // Generic subscription source — typically a thin filter on the
  // existing vault watcher. The listener fires once per change to a
  // path under `_BAC/log/<peerId>/...` (the path is provided so the
  // transport can pluck the peerId).
  readonly subscribePaths: (listener: (relPath: string) => void) => () => void;
  readonly readReplica: (replicaId: string) => Promise<readonly AcceptedEvent[]>;
  readonly listReplicaIds: () => Promise<readonly string[]>;
}

const isInsideLog = (relPath: string): boolean => {
  const segments = relPath.split('/').filter((s) => s.length > 0);
  return segments[0] === '_BAC' && segments[1] === 'log' && segments[2] !== undefined;
};

const peerFromPath = (relPath: string): string | null => {
  const segments = relPath.split('/').filter((s) => s.length > 0);
  return segments[0] === '_BAC' && segments[1] === 'log' ? (segments[2] ?? null) : null;
};

export const createLocalFsTransport = (opts: LocalFsTransportOptions): LogTransport => {
  // Peers see local writes directly via the vault watcher, so the
  // file IS the publication. Function signature matches the
  // LogTransport interface; both args are intentionally unused.
  const publishEvent = (replicaId: string, event: AcceptedEvent): Promise<void> => {
    void replicaId;
    void event;
    return Promise.resolve();
  };

  const subscribePeers = (
    knownReplicas: ReadonlySet<string>,
    onEvent: (replicaId: string, event: AcceptedEvent) => void,
  ): (() => void) => {
    let active = true;
    const seen = new Map<string, Set<string>>();

    const recordSeen = (peerId: string, eventId: string): boolean => {
      let set = seen.get(peerId);
      if (set === undefined) {
        set = new Set<string>();
        seen.set(peerId, set);
      }
      if (set.has(eventId)) return false;
      set.add(eventId);
      return true;
    };

    const drainPeer = async (peerId: string): Promise<void> => {
      if (!active) return;
      if (peerId === opts.localReplicaId) return;
      if (knownReplicas.size > 0 && !knownReplicas.has(peerId)) return;
      const events = await opts.readReplica(peerId);
      for (const event of events) {
        if (event.dot.replicaId !== peerId) continue;
        if (!recordSeen(peerId, event.clientEventId)) continue;
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
      if (!isInsideLog(relPath)) return;
      const peerId = peerFromPath(relPath);
      if (peerId === null) return;
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
