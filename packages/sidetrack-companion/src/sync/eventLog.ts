import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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
  vectorFromEvents,
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

// Sync Contract v1 — see ~/.claude/plans/kind-prancing-river.md.
//
// Two named append APIs replace the historical `appendClient`:
//
//   appendClientObserved — browser-driven events. baseVector is
//   REQUIRED. Empty `{}` is legal and means "the browser observed
//   nothing." Companion never substitutes its current frontier.
//
//   appendServerObserved — server-driven mutations (archive, delete,
//   recall tombstone, dispatch.linked, capture.extraction.produced
//   from a local re-extract). System stamps deps from the
//   aggregate's frontier. Caller asserts they ARE the latest
//   server-observed state.
//
// The internal `appendClient` accepts a `baseVector?` and is the
// shared implementation. New code must call one of the named APIs.

export interface AppendInputObserved<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly clientEventId: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly payload: TPayload;
  // REQUIRED. May be `{}` — that's a legitimate "browser observed
  // nothing" state. Companion does NOT replace it with the
  // aggregate's current frontier. A stale outbox event with `{}`
  // landing after peer events drained is accepted as concurrent;
  // it does not dominate. (Gate L1-G7.)
  readonly baseVector: VersionVector;
  readonly clientDeps?: readonly string[];
  readonly target?: TargetRef;
  readonly hlc?: Hlc;
}

export interface AppendInputServerObserved<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly clientEventId: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly payload: TPayload;
  // baseVector deliberately absent. The system stamps deps from the
  // aggregate's prior events. The caller is asserting that they ARE
  // the latest server-observed state (no other concurrent server
  // edits to the same aggregate). Use this for archive, delete,
  // recall tombstone, dispatch link, etc.
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
  // Optional — when omitted, the system auto-resolves from the
  // aggregate's frontier (server-observed semantic). When present,
  // deps are stamped exactly from this vector + resolved
  // clientDeps; never replaced.
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
  readonly appendClientObserved: <TPayload extends Record<string, unknown>>(
    input: AppendInputObserved<TPayload>,
  ) => Promise<AcceptedEvent<TPayload>>;
  /**
   * P2 — batched browser-observed append. ONE readMerged + dedupe +
   * shard write for the whole batch, instead of ~3 whole-log scans
   * PER event (findByClientEventId ×2 + deps readMerged). Correct
   * for edge events specifically: they pass `baseVector: {}` and no
   * `clientDeps`, so `computeDepsFromInput` returns `{}` independent
   * of `merged` — a single-snapshot batch is exactly equivalent to N
   * sequential appendClientObserved calls. Used by POST
   * /v1/edge/events (the ~1-min plugin flush; 39 s on backlog).
   * Returns per-input {clientEventId, imported} (false ⇒ duplicate,
   * already present or earlier in this batch).
   */
  readonly appendClientObservedBatch: <TPayload extends Record<string, unknown>>(
    inputs: readonly AppendInputObserved<TPayload>[],
    /**
     * Optional per-event hook, invoked once per NEWLY-accepted event
     * (not for deduped inputs) AFTER the durable batch write. The
     * runtime passes its `onLocalAccepted` here so the timeline ingest
     * still dispatches each event to the contract runner — the
     * timeline / projection / extraction materializers are dirty-bit
     * + event-driven and `catchUpAll` is startup-only, so a batch
     * append that skipped dispatch would leave their projections
     * stale until the next process start. Edge-event ingest passes
     * no hook (the connections materializer picks edge events up on
     * its next full-log reconcile).
     */
    onAccepted?: (event: AcceptedEvent<TPayload>) => void,
  ) => Promise<readonly { readonly clientEventId: string; readonly imported: boolean }[]>;
  /**
   * Server-driven event append. System stamps deps from the
   * aggregate's prior events. See `AppendInputServerObserved`.
   */
  readonly appendServerObserved: <TPayload extends Record<string, unknown>>(
    input: AppendInputServerObserved<TPayload>,
  ) => Promise<AcceptedEvent<TPayload>>;
  /**
   * @internal Shared implementation behind the two named APIs.
   * Test code may use this directly for legacy concurrency
   * simulations. Production code must use `appendClientObserved`
   * or `appendServerObserved`.
   */
  readonly appendClient: <TPayload extends Record<string, unknown>>(
    input: AppendInput<TPayload>,
  ) => Promise<AcceptedEvent<TPayload>>;
  readonly readMerged: () => Promise<readonly AcceptedEvent[]>;
  readonly readReplica: (replicaId: string) => Promise<readonly AcceptedEvent[]>;
  readonly readByAggregate: (aggregateId: string) => Promise<readonly AcceptedEvent[]>;
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

export const isAcceptedEvent = (value: unknown): value is AcceptedEvent => {
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

// Stage 5 polish — cooperative-yield batch size for the event-log
// parser. JSON.parse is synchronous; on a 5K-event dogfood vault the
// parse loop pegs the event loop for ~500ms straight, which is
// enough to starve /v1/status and produce the "Companion did not
// respond within 5s" banner during catchUp / retrain.
// `setImmediate` between batches lets the loop accept other I/O
// without measurably extending total parse time.
const EVENT_LOG_PARSE_YIELD_EVERY = 500;

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
  let processed = 0;
  for (const line of text.split('\n')) {
    const event = parseLine(line);
    if (event !== null) events.push(event);
    processed += 1;
    if (processed % EVENT_LOG_PARSE_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
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

  // P1 — readMerged() memoization. Re-reading + parsing the entire
  // multi-day, multi-shard event log on EVERY call (every hot HTTP
  // endpoint's cache-miss, findByClientEventId ×3 per edge-event,
  // every projector) was the deepest systemic CPU root behind the
  // dogfood runaway. Memoize on a CHEAP filesystem signature — the
  // set of shard files with their (mtimeMs,size). Any write by any
  // writer (local appendClient, peer importPeerEvent, relay sync,
  // log rotation, compaction) changes a file's mtime/size or the
  // file set, so the signature flips and the memo is correctly
  // invalidated; unchanged ⇒ O(#shardfiles) stats instead of
  // O(bytes) read+parse+sort. In-flight dedupe collapses the many
  // concurrent readMerged callers into one re-read on a miss.
  // (AcceptedEvent[] is readonly by contract everywhere; the memo
  // shares the array — callers must not mutate, which they don't.)
  let mergedMemo: { signature: string; value: readonly AcceptedEvent[] } | null = null;
  let mergedInFlight: { signature: string; promise: Promise<readonly AcceptedEvent[]> } | null =
    null;

  const computeLogSignature = async (): Promise<string> => {
    const ids = await listReplicaIds();
    const parts: string[] = [];
    for (const id of ids) {
      const files = (await listJsonlFiles(replicaLogDir(vaultPath, id))).sort();
      for (const file of files) {
        try {
          const s = await stat(file);
          parts.push(`${file}:${String(s.mtimeMs)}:${String(s.size)}`);
        } catch {
          parts.push(`${file}:absent`);
        }
      }
    }
    return parts.join('|');
  };

  const readMergedUncached = async (): Promise<readonly AcceptedEvent[]> => {
    const ids = await listReplicaIds();
    const all: AcceptedEvent[] = [];
    for (const id of ids) {
      for (const event of await readReplica(id)) all.push(event);
    }
    return sortAcceptedEvents(all);
  };

  const readMerged = async (): Promise<readonly AcceptedEvent[]> => {
    const signature = await computeLogSignature();
    if (mergedMemo !== null && mergedMemo.signature === signature) {
      return mergedMemo.value;
    }
    if (mergedInFlight !== null && mergedInFlight.signature === signature) {
      return mergedInFlight.promise;
    }
    const promise = (async (): Promise<readonly AcceptedEvent[]> => {
      try {
        const value = await readMergedUncached();
        mergedMemo = { signature, value };
        return value;
      } finally {
        if (mergedInFlight !== null && mergedInFlight.signature === signature) {
          mergedInFlight = null;
        }
      }
    })();
    mergedInFlight = { signature, promise };
    return promise;
  };

  const readByAggregate = async (aggregateId: string): Promise<readonly AcceptedEvent[]> => {
    const merged = await readMerged();
    return merged.filter((event) => event.aggregateId === aggregateId);
  };

  const findByClientEventId = async (clientEventId: string): Promise<AcceptedEvent | null> => {
    const merged = await readMerged();
    return merged.find((event) => event.clientEventId === clientEventId) ?? null;
  };

  const findByDot = async (dot: Dot): Promise<AcceptedEvent | null> => {
    const merged = await readMerged();
    return (
      merged.find((event) => event.dot.replicaId === dot.replicaId && event.dot.seq === dot.seq) ??
      null
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

  const appendClientObservedBatch = <TPayload extends Record<string, unknown>>(
    inputs: readonly AppendInputObserved<TPayload>[],
    onAccepted?: (event: AcceptedEvent<TPayload>) => void,
  ): Promise<readonly { readonly clientEventId: string; readonly imported: boolean }[]> =>
    enqueueAppend(async () => {
      if (inputs.length === 0) return [];
      // ONE readMerged for the whole batch (vs findByClientEventId +
      // deps readMerged PER event). Edge-event deps are `{}` (explicit
      // baseVector, no clientDeps) so this single snapshot is exact.
      const merged = await readMerged();
      const present = new Set(merged.map((event) => event.clientEventId));
      const events: AcceptedEvent<TPayload>[] = [];
      const results: { clientEventId: string; imported: boolean }[] = [];
      const at = now();
      for (const input of inputs) {
        if (present.has(input.clientEventId)) {
          // Already in the log OR earlier in this batch — dedupe,
          // exactly like appendClient's findByClientEventId guard.
          results.push({ clientEventId: input.clientEventId, imported: false });
          continue;
        }
        const deps = computeDepsFromInput(input, merged);
        // eslint-disable-next-line no-await-in-loop -- nextSeq is a cheap monotonic counter
        const seq = await replica.nextSeq();
        const event: AcceptedEvent<TPayload> = {
          clientEventId: input.clientEventId,
          dot: { replicaId: replica.replicaId, seq },
          deps,
          aggregateId: input.aggregateId,
          type: input.type,
          payload: input.payload,
          acceptedAtMs: at.getTime(),
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.hlc === undefined
            ? options.hlcStamper !== undefined
              ? maybeAttachHlc(options.hlcStamper())
              : {}
            : { hlc: input.hlc }),
        };
        present.add(input.clientEventId);
        events.push(event);
        results.push({ clientEventId: input.clientEventId, imported: true });
      }
      if (events.length > 0) {
        const dir = replicaLogDir(vaultPath, replica.replicaId);
        await mkdir(dir, { recursive: true });
        // Single append of all new events (vs one writeFile/event).
        await writeFile(
          replicaLogPath(vaultPath, replica.replicaId, at),
          `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
          { encoding: 'utf8', flag: 'a' },
        );
      }
      // Dispatch AFTER the durable write so a hook only ever sees
      // events that are on disk — same ordering guarantee as the
      // singular `appendClientObserved` → `onLocalAccepted` path.
      if (onAccepted !== undefined) {
        for (const event of events) onAccepted(event);
      }
      return results;
    });

  const importPeerEvent = (event: AcceptedEvent): Promise<{ readonly imported: boolean }> =>
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

  // Named APIs — production code uses these.
  const appendClientObserved = <TPayload extends Record<string, unknown>>(
    input: AppendInputObserved<TPayload>,
  ): Promise<AcceptedEvent<TPayload>> =>
    appendClient<TPayload>({
      clientEventId: input.clientEventId,
      aggregateId: input.aggregateId,
      type: input.type,
      payload: input.payload,
      baseVector: input.baseVector,
      ...(input.clientDeps === undefined ? {} : { clientDeps: input.clientDeps }),
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.hlc === undefined ? {} : { hlc: input.hlc }),
    });

  const appendServerObserved = <TPayload extends Record<string, unknown>>(
    input: AppendInputServerObserved<TPayload>,
  ): Promise<AcceptedEvent<TPayload>> =>
    appendClient<TPayload>({
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
    appendClientObservedBatch,
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
  let deps: VersionVector;
  if (explicit !== undefined) {
    deps = explicit;
  } else {
    deps = vectorFromEvents(merged.filter((event) => event.aggregateId === input.aggregateId));
  }
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

const maybeAttachHlc = (hlc: Hlc | undefined): { hlc?: Hlc } => (hlc === undefined ? {} : { hlc });
