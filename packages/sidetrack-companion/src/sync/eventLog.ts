import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type AcceptedEvent,
  canonicalEventString,
  type Dot,
  type Hlc,
  maxVector,
  sortAcceptedEvents,
  type TargetRef,
  type VersionVector,
} from './causal.js';
import type { ReplicaContext } from './replicaId.js';

// Errors surfaced when a peer event collides with an existing event
// under the (replicaId, seq) "dot" identity, or when a clientEventId
// gets reused under a different dot. Either case suggests a buggy
// or malicious peer; the runtime quarantines that replica rather
// than persisting the event.
export class DotCollisionError extends Error {
  constructor(
    readonly dot: Dot,
    readonly storedClientEventId: string,
    readonly incomingClientEventId: string,
  ) {
    super(
      `Peer event collides on (${dot.replicaId}, ${String(dot.seq)}): existing clientEventId=${storedClientEventId}, incoming=${incomingClientEventId}`,
    );
  }
}

export class ClientEventIdReuseError extends Error {
  constructor(
    readonly clientEventId: string,
    readonly storedDot: Dot,
    readonly incomingDot: Dot,
  ) {
    super(
      `clientEventId ${clientEventId} already bound to (${storedDot.replicaId}, ${String(storedDot.seq)}); incoming claims (${incomingDot.replicaId}, ${String(incomingDot.seq)})`,
    );
  }
}

// Per-replica append-only log of AcceptedEvents.
//
// Each replica writes only inside `_BAC/log/<replicaId>/<YYYY-MM-DD>.jsonl`.
// File-syncing tools (Syncthing) pointed at `_BAC/log/` ferry shards
// between replicas without write conflicts because no two replicas
// ever target the same path.
//
// `appendClient` is the only durable write path. It:
//   1. Returns the existing AcceptedEvent if the client retried
//      (same `clientEventId`) — same dot, same deps, same
//      acceptedAtMs. Idempotent under retry.
//   2. Otherwise allocates a fresh seq, stamps deps from the client's
//      `baseVector` (NEVER from the companion's current frontier —
//      that would falsely claim the editor observed peer events they
//      never saw) plus any resolved clientDeps, and appends to disk.

export interface AppendInput<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly clientEventId: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly payload: TPayload;
  // Optional. The companion uses `clientEvent.baseVector` directly
  // to stamp `deps`. If absent, treated as the empty vector — which
  // means "the user observed nothing" (rare; only for first-write
  // bootstraps).
  readonly baseVector?: VersionVector;
  // Optional dependency on other client events that haven't been
  // accepted yet — e.g. a comment.set that depends on a span.added
  // batched in the same POST. The companion resolves these to dots
  // at acceptance time and folds them into deps.
  readonly clientDeps?: readonly string[];
  readonly target?: TargetRef;
  readonly hlc?: Hlc;
}

export interface EventLog {
  readonly appendClient: <TPayload extends Record<string, unknown>>(
    input: AppendInput<TPayload>,
  ) => Promise<AcceptedEvent<TPayload>>;
  readonly readMerged: () => Promise<readonly AcceptedEvent[]>;
  readonly readReplica: (replicaId: string) => Promise<readonly AcceptedEvent[]>;
  readonly readByAggregate: (
    aggregateId: string,
  ) => Promise<readonly AcceptedEvent[]>;
  readonly findByClientEventId: (clientEventId: string) => Promise<AcceptedEvent | null>;
  readonly findByDot: (dot: Dot) => Promise<AcceptedEvent | null>;
  readonly listReplicaIds: () => Promise<readonly string[]>;
  // Persist a peer-authored event under the peer's replica subdir.
  // Used by sync transports (relay, future Syncthing-watcher) to
  // ingest events from other replicas.
  //
  // Strict identity rules:
  //   1. (replicaId, seq) is a globally-unique event identity. Two
  //      imports with the same dot must be byte-identical or the
  //      caller throws DotCollisionError (the source replica has
  //      diverged or is forging events).
  //   2. clientEventId is a logical identity. Two imports with the
  //      same clientEventId but different dots throw
  //      ClientEventIdReuseError (a peer reusing the id under a
  //      different dot is suspicious).
  //   3. Byte-identical re-imports (same dot AND same content) are
  //      no-ops — Syncthing redelivery, relay replay, etc.
  readonly importPeerEvent: (event: AcceptedEvent) => Promise<{ readonly imported: boolean }>;
}

export interface EventLogOptions {
  readonly now?: () => Date;
  readonly hlcStamper?: () => Hlc | undefined;
}

const LOG_ROOT_SEGMENTS = ['_BAC', 'log'] as const;

const replicaDirSegment = (replicaId: string): string => {
  if (!/^[0-9a-zA-Z._-]+$/.test(replicaId)) {
    throw new Error(`Invalid replicaId for event log path: ${replicaId}`);
  }
  return replicaId;
};

const dateStamp = (value: Date): string => value.toISOString().slice(0, 10);

const eventLogRoot = (vaultPath: string): string => join(vaultPath, ...LOG_ROOT_SEGMENTS);

const replicaLogDir = (vaultPath: string, replicaId: string): string =>
  join(eventLogRoot(vaultPath), replicaDirSegment(replicaId));

const replicaLogPath = (vaultPath: string, replicaId: string, date: Date): string =>
  join(replicaLogDir(vaultPath, replicaId), `${dateStamp(date)}.jsonl`);

const isAcceptedEvent = (value: unknown): value is AcceptedEvent => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry['clientEventId'] !== 'string') return false;
  const dot = entry['dot'];
  if (typeof dot !== 'object' || dot === null) return false;
  const dotRecord = dot as Record<string, unknown>;
  if (typeof dotRecord['replicaId'] !== 'string' || typeof dotRecord['seq'] !== 'number') {
    return false;
  }
  if (typeof entry['deps'] !== 'object' || entry['deps'] === null) return false;
  if (typeof entry['aggregateId'] !== 'string') return false;
  if (typeof entry['type'] !== 'string') return false;
  if (typeof entry['payload'] !== 'object' || entry['payload'] === null) return false;
  if (typeof entry['acceptedAtMs'] !== 'number') return false;
  return true;
};

const parseLine = (line: string): AcceptedEvent | null => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isAcceptedEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readLogFile = async (path: string): Promise<AcceptedEvent[]> => {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const events: AcceptedEvent[] = [];
  for (const line of text.split('\n')) {
    const event = parseLine(line);
    if (event !== null) events.push(event);
  }
  return events;
};

const listJsonlFiles = async (dir: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(dir, entry.name));
};

export const createEventLog = (
  vaultPath: string,
  replica: ReplicaContext,
  options: EventLogOptions = {},
): EventLog => {
  const now = options.now ?? (() => new Date());

  let writeChain: Promise<unknown> = Promise.resolve();
  const enqueueAppend = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(task, task);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const readReplica = async (replicaId: string): Promise<AcceptedEvent[]> => {
    const dir = replicaLogDir(vaultPath, replicaId);
    const files = (await listJsonlFiles(dir)).sort();
    const all: AcceptedEvent[] = [];
    for (const file of files) {
      const events = await readLogFile(file);
      for (const event of events) {
        if (event.dot.replicaId === replicaId) all.push(event);
      }
    }
    return sortAcceptedEvents(all);
  };

  const listReplicaIds = async (): Promise<readonly string[]> => {
    let entries;
    try {
      entries = await readdir(eventLogRoot(vaultPath), { withFileTypes: true });
    } catch (error) {
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

  const readMerged = async (): Promise<readonly AcceptedEvent[]> => {
    const ids = await listReplicaIds();
    const all: AcceptedEvent[] = [];
    for (const id of ids) {
      for (const event of await readReplica(id)) all.push(event);
    }
    return sortAcceptedEvents(all);
  };

  const readByAggregate = async (
    aggregateId: string,
  ): Promise<readonly AcceptedEvent[]> => {
    const merged = await readMerged();
    return merged.filter((event) => event.aggregateId === aggregateId);
  };

  const findByClientEventId = async (
    clientEventId: string,
  ): Promise<AcceptedEvent | null> => {
    const merged = await readMerged();
    return merged.find((event) => event.clientEventId === clientEventId) ?? null;
  };

  const findByDot = async (dot: Dot): Promise<AcceptedEvent | null> => {
    const merged = await readMerged();
    return (
      merged.find(
        (event) => event.dot.replicaId === dot.replicaId && event.dot.seq === dot.seq,
      ) ?? null
    );
  };

  const appendClient = <TPayload extends Record<string, unknown>>(
    input: AppendInput<TPayload>,
  ): Promise<AcceptedEvent<TPayload>> =>
    enqueueAppend(async () => {
      const existing = await findByClientEventId(input.clientEventId);
      if (existing !== null) {
        return existing as AcceptedEvent<TPayload>;
      }
      // Resolve clientDeps to dots so deps reflects "everything the
      // editor caused or observed at edit time."
      const merged = await readMerged();
      const deps = computeDepsFromInput(input, merged);
      const seq = await replica.nextSeq();
      const event: AcceptedEvent<TPayload> = {
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
      await writeFile(
        replicaLogPath(vaultPath, replica.replicaId, now()),
        `${JSON.stringify(event)}\n`,
        { encoding: 'utf8', flag: 'a' },
      );
      return event;
    });

  const importPeerEvent = (
    event: AcceptedEvent,
  ): Promise<{ readonly imported: boolean }> =>
    enqueueAppend(async () => {
      // Refusing imports under our own replica id keeps the local
      // shard truthful — only `appendClient` writes there.
      if (event.dot.replicaId === replica.replicaId) {
        return { imported: false } as const;
      }
      const byDot = await findByDot(event.dot);
      if (byDot !== null) {
        if (canonicalEquals(byDot, event)) {
          return { imported: false } as const;
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
      await writeFile(
        replicaLogPath(vaultPath, event.dot.replicaId, at),
        `${JSON.stringify(event)}\n`,
        { encoding: 'utf8', flag: 'a' },
      );
      // Each replica's seq counter is independent; we don't bump our
      // own seq when ingesting a peer event (that would corrupt our
      // local namespace). Causal ordering across replicas is handled
      // entirely by `deps`/dot comparisons in eventDominates.
      return { imported: true } as const;
    });

  return {
    appendClient,
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
const canonicalEquals = (a: AcceptedEvent, b: AcceptedEvent): boolean =>
  canonicalEventString(a) === canonicalEventString(b);

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
const computeDepsFromInput = <TPayload extends Record<string, unknown>>(
  input: AppendInput<TPayload>,
  merged: readonly AcceptedEvent[],
): VersionVector => {
  let deps: VersionVector = input.baseVector ?? {};
  if (input.clientDeps !== undefined && input.clientDeps.length > 0) {
    const byClientId = new Map<string, AcceptedEvent>();
    for (const event of merged) byClientId.set(event.clientEventId, event);
    for (const dep of input.clientDeps) {
      const resolved = byClientId.get(dep);
      if (resolved !== undefined) {
        deps = maxVector(deps, { [resolved.dot.replicaId]: resolved.dot.seq });
      }
    }
  }
  return deps;
};

const maybeAttachHlc = (hlc: Hlc | undefined): { hlc?: Hlc } =>
  hlc === undefined ? {} : { hlc };
