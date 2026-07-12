import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

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
  /**
   * Watermark-resume read: events strictly past `frontier`, read
   * directly from shard tails (newest shard first, short-circuiting
   * whole shards whose tail seq is already covered). Independent of
   * the readMerged memo — the connections materializer advances its
   * frontier with this without materializing the full log.
   */
  readonly readMergedSince: (frontier: VersionVector) => Promise<readonly AcceptedEvent[]>;
  /**
   * Stream every event one at a time (O(1) memory) — never materialises
   * the merged array. For boot consumers that only need a small subset.
   * Shard order, not merged order.
   */
  readonly streamEvents: (
    onEvent: (event: AcceptedEvent) => void,
    typeHints?: ReadonlySet<string>,
  ) => Promise<void>;
  /**
   * Streamed `(await readMerged()).filter(predicate)` — collects only the
   * matching subset, then sorts it identically to the merged array. Use
   * when the subset is small (filter callers) to avoid warming the memo.
   * Pass `typeHints` (the event types the predicate accepts) to skip
   * JSON.parse on non-matching lines — avoids parsing the high-volume
   * engagement.interval bulk entirely.
   */
  readonly streamFiltered: (
    predicate: (event: AcceptedEvent) => boolean,
    typeHints?: ReadonlySet<string>,
  ) => Promise<readonly AcceptedEvent[]>;
  /**
   * Cheap content signature of the durable log (shard mtimes + sizes).
   * Changes iff any shard was appended/added. Lets callers cache derived
   * projections and serve them on an unchanged log WITHOUT calling
   * readMerged() — so the full-log memo can idle out instead of being
   * re-warmed by every poll.
   */
  readonly logSignature: () => Promise<string>;
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
  /**
   * Warm the append-path indexes off the request path (idempotent,
   * single-flighted; appends issued meanwhile join the in-flight
   * warm). Long-lived processes call this at boot so the FIRST user
   * write doesn't pay the one-time streaming pass over the log;
   * short-lived CLI invocations skip it and pay only if they append.
   */
  readonly prewarmAppendIndexes: () => Promise<void>;
}

export interface EventLogOptions {
  readonly now?: () => Date;
  readonly hlcStamper?: () => Hlc | undefined;
  /** True when shard files can be written by ANOTHER process (a sync
   *  transport dropping peer shards in, or a concurrent CLI `import`).
   *  Only then does the append path need to re-check the on-disk log
   *  signature before each dedupe/deps decision. In the common
   *  single-companion case (default false) the in-memory append indexes
   *  are the sole authority — this process is the only writer and
   *  maintains them incrementally — so the per-append signature scan
   *  (readdir of every replica dir + stat of every shard file, twice
   *  per write) is pure overhead and is skipped. */
  readonly externalWritersPossible?: boolean;
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

// Streaming tail-read helpers for `readMergedSince` — the watermark-resume
// path the connections materializer uses to advance its frontier without
// materializing the full merged log. Reads only past the frontier and
// short-circuits whole shards via their last-line seq.
const readLogFileSince = async (
  path: string,
  frontier: VersionVector,
  expectedReplicaId?: string,
): Promise<{ readonly events: AcceptedEvent[]; readonly maxSeq: number | null }> => {
  const events: AcceptedEvent[] = [];
  let maxSeq: number | null = null;
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(path, { encoding: 'utf8' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { events, maxSeq };
    }
    throw error;
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let processed = 0;
  try {
    for await (const line of lines) {
      const event = parseLine(line);
      if (
        event !== null &&
        (expectedReplicaId === undefined || event.dot.replicaId === expectedReplicaId)
      ) {
        maxSeq = Math.max(maxSeq ?? 0, event.dot.seq);
        if (event.dot.seq > (frontier[event.dot.replicaId] ?? 0)) {
          events.push(event);
        }
      }
      processed += 1;
      if (processed % EVENT_LOG_PARSE_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { events, maxSeq };
    }
    throw error;
  }
  return { events, maxSeq };
};

const TAIL_READ_CHUNK_BYTES = 64 * 1024;

// A shard file that exists but cannot be read (EACCES/EIO/EMFILE — a
// network-mounted or iCloud-dataless vault, fd exhaustion, or a
// permissions glitch on ONE shard). Distinguished from a missing shard
// (ENOENT, handled as "no tail") because a read failure must NOT be
// silently treated as an absent tail: if the seq file were ALSO lost,
// silently skipping the shard would let nextSeq reissue a duplicate dot.
// Callers decide policy (proceed on an intact seq file, refuse when the
// counter is untrusted) — see `maxShardTailSeqForReplica`.
export class ShardUnreadableError extends Error {
  readonly shardPath: string;
  constructor(shardPath: string, cause: unknown) {
    super(`Event-log shard is unreadable: ${shardPath}`, { cause });
    this.name = 'ShardUnreadableError';
    this.shardPath = shardPath;
  }
}

const isEnoent = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

// Yield the shard's non-empty lines from the END backward, one at a
// time, using bounded chunked reads (never a full-file materialisation
// for the common case where the last line already parses). The backward
// scan lets `readShardTailSeq` recover the last VALID line for a replica
// when the final line was torn by a crash mid-append.
async function* readNonEmptyLinesFromTail(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): AsyncGenerator<string, void, void> {
  let position = size;
  // `pending` holds bytes read but not yet split into complete lines —
  // its LEADING segment may still be the tail of a line whose start is
  // in an earlier chunk, so it is only emitted once we hit a newline
  // before it (or reach the file start).
  let pending = '';
  while (position > 0) {
    const readLength = Math.min(TAIL_READ_CHUNK_BYTES, position);
    position -= readLength;
    const buffer = Buffer.allocUnsafe(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, position);
    pending = `${buffer.subarray(0, bytesRead).toString('utf8')}${pending}`;
    // Emit every complete line whose start we have now seen (i.e. that
    // is preceded by a newline within `pending`). Keep the leading
    // segment (before the first newline) buffered — its start may be in
    // the next chunk.
    let lineBreak = pending.lastIndexOf('\n');
    while (lineBreak >= 0) {
      const line = pending.slice(lineBreak + 1).replace(/[\r\n]+$/u, '');
      pending = pending.slice(0, lineBreak);
      if (line.length > 0) yield line;
      lineBreak = pending.lastIndexOf('\n');
    }
  }
  const first = pending.replace(/[\r\n]+$/u, '');
  if (first.length > 0) yield first;
}

// Highest seq committed by `expectedReplicaId` in this shard, or null if
// the shard carries no valid line for that replica. Scans BACKWARD from
// the tail and returns the first line that parses AND belongs to the
// replica — so a crash that tore only the final line (no fsync anywhere)
// still recovers the prior valid line's seq rather than under-recovering
// to null. Throws `ShardUnreadableError` on a non-ENOENT read failure
// (the caller must not treat that as "no tail"); returns null on ENOENT.
const readShardTailSeq = async (
  path: string,
  expectedReplicaId: string,
): Promise<number | null> => {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new ShardUnreadableError(path, error);
  }
  try {
    const { size } = await handle.stat();
    for await (const line of readNonEmptyLinesFromTail(handle, size)) {
      const event = parseLine(line);
      if (event !== null && event.dot.replicaId === expectedReplicaId) {
        return event.dot.seq;
      }
      // Otherwise: torn last line, a foreign replica's interleaved line,
      // or garbage — keep scanning backward for this replica's last
      // valid line rather than giving up (which would under-recover the
      // high-water mark).
    }
    return null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new ShardUnreadableError(path, error);
  } finally {
    await handle.close();
  }
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

// Boot reconciliation for the replica seq high-water-mark. A lost,
// regressed, or garbled `replica-seq` file would otherwise hand out a
// seq that ALREADY appears on disk, minting a duplicate (replicaId,
// seq) dot — the causal event log's primary key. Because appendClient
// dedupes on clientEventId only, that reissued dot appends unchecked
// and poisons every downstream causal reader (deps, conflict verdicts,
// vector frontiers). Reconcile the counter against the durable truth:
// the highest seq this replica ever committed to its OWN shards.
//
// Bounded work: reads ONLY this replica's shard directory and tail-reads
// each shard file (last valid line, scanning backward), never a full-log
// scan. Within a replica's own shard, appendClient allocates strictly
// increasing seqs, so the tail line carries that file's max; the max
// across the replica's shards is its committed high-water mark.
//
// `unreadableShards` lists shards that EXIST but could not be read
// (non-ENOENT: EACCES/EIO/EMFILE). It is reported, NOT swallowed: a
// shard whose tail we could not verify may hide a higher committed seq,
// so advancing the counter as if it did not exist could reissue a
// duplicate dot when the seq file is also untrusted. The boot caller
// (`loadOrCreateReplica`) decides policy from this field.
export interface ShardTailReconciliation {
  // Max committed seq across the readable shards (0 when none).
  readonly maxSeq: number;
  // Paths of shards that exist but failed to read (non-ENOENT).
  readonly unreadableShards: readonly string[];
}

export const reconcileShardTailSeqForReplica = async (
  vaultPath: string,
  replicaId: string,
): Promise<ShardTailReconciliation> => {
  const files = await listJsonlFiles(replicaLogDir(vaultPath, replicaId));
  let maxSeq = 0;
  const unreadableShards: string[] = [];
  for (const file of files) {
    let tailSeq: number | null;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded, one tail read per shard
      tailSeq = await readShardTailSeq(file, replicaId);
    } catch (error) {
      if (error instanceof ShardUnreadableError) {
        unreadableShards.push(error.shardPath);
        continue;
      }
      throw error;
    }
    if (tailSeq !== null && tailSeq > maxSeq) maxSeq = tailSeq;
  }
  return { maxSeq, unreadableShards };
};

// Back-compat strict variant: the committed high-water mark, throwing on
// any unreadable shard. Retained for callers that want the raw number
// and treat an unreadable shard as fatal. Returns 0 for a fresh replica.
export const maxShardTailSeqForReplica = async (
  vaultPath: string,
  replicaId: string,
): Promise<number> => {
  const { maxSeq, unreadableShards } = await reconcileShardTailSeqForReplica(
    vaultPath,
    replicaId,
  );
  if (unreadableShards.length > 0) {
    throw new ShardUnreadableError(unreadableShards[0] as string, undefined);
  }
  return maxSeq;
};

export const createEventLog = (
  vaultPath: string,
  replica: ReplicaContext,
  options: EventLogOptions = {},
): EventLog => {
  const now = options.now ?? (() => new Date());
  const externalWritersPossible = options.externalWritersPossible ?? false;

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

  // Idle TTL eviction for the full-log memo. The memo holds every
  // AcceptedEvent as a JS object; on an active vault that is hundreds
  // of MB. Without eviction it lives for the whole process lifetime
  // even when nothing reads it. The sweep drops it after the log has
  // been idle (no readMerged access) for MERGED_MEMO_IDLE_MS; the next
  // reader rebuilds from disk. One unref'd timer slot, clear-before-rearm,
  // and it bails while a miss is in flight (the resolution re-installs +
  // re-schedules).
  const MERGED_MEMO_IDLE_MS = 60_000;
  let mergedMemoLastAccessMs = 0;
  let mergedMemoSweepTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelMergedSweep = (): void => {
    if (mergedMemoSweepTimer !== null) {
      clearTimeout(mergedMemoSweepTimer);
      mergedMemoSweepTimer = null;
    }
  };
  const scheduleMergedSweep = (delayMs: number): void => {
    cancelMergedSweep();
    const t = setTimeout(() => {
      mergedMemoSweepTimer = null;
      if (mergedInFlight !== null) return;
      if (mergedMemo === null) return;
      const idleMs = Date.now() - mergedMemoLastAccessMs;
      if (idleMs >= MERGED_MEMO_IDLE_MS) {
        mergedMemo = null;
      } else {
        scheduleMergedSweep(MERGED_MEMO_IDLE_MS - idleMs);
      }
    }, delayMs);
    t.unref?.();
    mergedMemoSweepTimer = t;
  };

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
      mergedMemoLastAccessMs = Date.now();
      return mergedMemo.value;
    }
    if (mergedInFlight !== null && mergedInFlight.signature === signature) {
      return mergedInFlight.promise;
    }
    const promise = (async (): Promise<readonly AcceptedEvent[]> => {
      try {
        const value = await readMergedUncached();
        mergedMemo = { signature, value };
        // Anchor the eviction timer to install time, not the prior
        // last-access, so the sweep can't fire against a stale memo.
        mergedMemoLastAccessMs = Date.now();
        scheduleMergedSweep(MERGED_MEMO_IDLE_MS);
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

  const readMergedSince = async (frontier: VersionVector): Promise<readonly AcceptedEvent[]> => {
    const ids = await listReplicaIds();
    const out: AcceptedEvent[] = [];
    for (const id of ids) {
      const files = (await listJsonlFiles(replicaLogDir(vaultPath, id))).sort().reverse();
      const frontierSeq = frontier[id] ?? 0;
      let parseBeforeTailCheck = true;
      for (const file of files) {
        if (!parseBeforeTailCheck) {
          const shardTailSeq = await readShardTailSeq(file, id);
          if (shardTailSeq !== null && shardTailSeq <= frontierSeq) break;
        }
        const shard = await readLogFileSince(file, frontier, id);
        for (const event of shard.events) {
          out.push(event);
        }
        if (shard.maxSeq !== null && shard.maxSeq <= frontierSeq) break;
        parseBeforeTailCheck = false;
      }
    }
    return sortAcceptedEvents(out);
  };

  // Stream every event through `onEvent` one at a time, O(1) memory —
  // never materialises the full merged array. The boot consumers that
  // only need a small subset (privacy: 3 types; recall freshness: a
  // count; projection: structural types) use this instead of
  // readMerged() so they don't each warm the ~700MB full-log memo.
  // Shard order (per-replica seq, replicas concatenated); callers that
  // need merged order use streamFiltered (which sorts the subset).
  const streamEvents = async (
    onEvent: (event: AcceptedEvent) => void,
    typeHints?: ReadonlySet<string>,
  ): Promise<void> => {
    // Pre-parse type skip: when the caller only wants specific event
    // types, test the raw line for `"type":"<t>"` BEFORE JSON.parse.
    // The ~173k engagement.interval lines (88% of the log) then never
    // get parsed, so the transient parse garbage that sets the libpas
    // high-water is never allocated. Safe: the type field is always
    // serialised as `"type":"value"` with the closing quote, so there
    // are no false negatives (and a substring type can't false-match a
    // longer type); a stray match inside a payload only costs one wasted
    // parse, which the caller's predicate still filters out.
    const needles = typeHints === undefined ? null : [...typeHints].map((t) => `"type":"${t}"`);
    const ids = await listReplicaIds();
    let processed = 0;
    for (const id of ids) {
      const files = (await listJsonlFiles(replicaLogDir(vaultPath, id))).sort();
      for (const file of files) {
        let stream: ReturnType<typeof createReadStream>;
        try {
          stream = createReadStream(file, { encoding: 'utf8' });
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
          throw error;
        }
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (needles === null || needles.some((n) => line.includes(n))) {
              const event = parseLine(line);
              if (event !== null) onEvent(event);
            }
            processed += 1;
            if (processed % EVENT_LOG_PARSE_YIELD_EVERY === 0) {
              await new Promise<void>((resolve) => {
                setImmediate(resolve);
              });
            }
          }
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
          throw error;
        }
      }
    }
  };

  // Streamed equivalent of `(await readMerged()).filter(predicate)`:
  // collects only the matching subset (bounded), then sorts it the same
  // way readMerged does. Byte-identical ordering to filtering the merged
  // array, because a total order is stable under subsetting — so callers
  // that fold/last-write-wins over the result are unaffected.
  const streamFiltered = async (
    predicate: (event: AcceptedEvent) => boolean,
    typeHints?: ReadonlySet<string>,
  ): Promise<readonly AcceptedEvent[]> => {
    const out: AcceptedEvent[] = [];
    await streamEvents((event) => {
      if (predicate(event)) out.push(event);
    }, typeHints);
    return sortAcceptedEvents(out);
  };

  const readByAggregate = async (aggregateId: string): Promise<readonly AcceptedEvent[]> => {
    const merged = await readMerged();
    return merged.filter((event) => event.aggregateId === aggregateId);
  };

  const findByClientEventId = async (clientEventId: string): Promise<AcceptedEvent | null> => {
    // Negative fast-path: when the append indexes are warm they are
    // authoritative for membership — absent there means absent in the
    // log, no need to read anything. (A stale-index false negative
    // self-corrects at the guarded append: freshAppendIndexes rebuilds
    // on a foreign signature change before any dedupe decision.)
    if (appendIndexes !== null && !appendIndexes.clientIdToDot.has(clientEventId)) {
      return null;
    }
    // Positive / cold path: stream-scan instead of readMerged. The
    // duplicate-replay case fires exactly when the companion is busy
    // (a write succeeded server-side but timed out client-side and
    // got replayed) — warming the ~700MB full-log memo there would
    // re-pin the memory the indexes exist to release.
    const matches = await streamFiltered((event) => event.clientEventId === clientEventId);
    return matches[0] ?? null;
  };

  const findByDot = async (dot: Dot): Promise<AcceptedEvent | null> => {
    // Stream-scan for the single event — see findByClientEventId for
    // why this avoids readMerged (memo pinning on the busy path).
    const matches = await streamFiltered(
      (event) => event.dot.replicaId === dot.replicaId && event.dot.seq === dot.seq,
    );
    return matches[0] ?? null;
  };

  // ── Append-path indexes ─────────────────────────────────────────
  // clientEventId → dot, dot-key set, aggregateId → deps vector.
  // Warmed ONCE via streamEvents (O(1) memory during the pass; the
  // retained maps hold ids/dots only, never payloads), then maintained
  // by every append/import — which all run under the enqueueAppend
  // mutex, so warm + reads + writes never race.
  //
  // Why: every append used to call readMerged() for dedupe + deps, and
  // the append itself invalidates the memo's file signature — so each
  // write re-read + re-parsed the ENTIRE log (333k events ≈ tens of
  // seconds under --smol), serialized behind the append mutex. Live
  // symptom: 46-69 s POST /v1/timeline/events / page-evidence writes
  // cascading every other write (incl. recall.served appends), panel
  // flapping to "busy". With the indexes, appends are O(batch) plus
  // one file append, and the ~700MB full-log memo can idle out instead
  // of being re-warmed per write.
  //
  // Indexes are add-only: rewriting/compacting shard files while the
  // process runs is not supported (the readMerged memo tolerates it
  // via its signature; these indexes would go stale — there is no such
  // writer in-tree today).
  interface AppendIndexes {
    readonly clientIdToDot: Map<string, Dot>;
    readonly dotKeys: Set<string>;
    readonly aggregateVectors: Map<string, VersionVector>;
  }
  let appendIndexes: AppendIndexes | null = null;
  let appendIndexesWarming: Promise<AppendIndexes> | null = null;

  const dotKeyOf = (dot: Dot): string => `${dot.replicaId}:${String(dot.seq)}`;

  const registerInAppendIndexes = (idx: AppendIndexes, event: AcceptedEvent): void => {
    idx.clientIdToDot.set(event.clientEventId, event.dot);
    idx.dotKeys.add(dotKeyOf(event.dot));
    const prior = idx.aggregateVectors.get(event.aggregateId) ?? {};
    idx.aggregateVectors.set(
      event.aggregateId,
      maxVector(prior, { [event.dot.replicaId]: event.dot.seq }),
    );
  };

  const warmAppendIndexes = (): Promise<AppendIndexes> => {
    if (appendIndexes !== null) return Promise.resolve(appendIndexes);
    appendIndexesWarming ??= (async () => {
      const idx: AppendIndexes = {
        clientIdToDot: new Map(),
        dotKeys: new Set(),
        aggregateVectors: new Map(),
      };
      await streamEvents((event) => {
        registerInAppendIndexes(idx, event);
      });
      appendIndexes = idx;
      appendIndexesWarming = null;
      return idx;
    })().catch((error: unknown) => {
      // A failed warm (transient read error mid-stream) must not pin a
      // rejected promise here forever — that would fail EVERY later
      // append until restart. Clear the slot so the next append
      // retries the warm from scratch.
      appendIndexesWarming = null;
      throw error;
    });
    return appendIndexesWarming;
  };

  // Log signature the indexes were last reconciled against. The
  // indexes are in-process state, but the shard files can gain events
  // from OUTSIDE this process (a CLI `import` run against the same
  // vault, file-level sync dropping a peer shard in). The old
  // readMerged-per-append path picked those up via the memo's file
  // signature; the indexes must do the same or dedupe/deps run against
  // stale data and mint duplicate identities. Every guarded append
  // compares the live signature first (one stat pass over the shard
  // files, single-digit ms) and rebuilds the indexes when something
  // else moved the log; after its own write it re-records the
  // signature so the next check doesn't self-trigger.
  let appendIndexesSignature: string | null = null;

  const freshAppendIndexes = async (): Promise<AppendIndexes> => {
    // Single-writer (default): the in-memory indexes are authoritative —
    // no other process mutates the log, so skip the on-disk signature
    // scan entirely (the indexes are warmed once and maintained by our
    // own appends).
    if (!externalWritersPossible) return warmAppendIndexes();
    let idx = await warmAppendIndexes();
    const sig = await computeLogSignature();
    if (appendIndexesSignature !== null && appendIndexesSignature !== sig) {
      appendIndexes = null;
      idx = await warmAppendIndexes();
      appendIndexesSignature = await computeLogSignature();
      return idx;
    }
    appendIndexesSignature = sig;
    return idx;
  };

  const recordAppendIndexesSignature = async (): Promise<void> => {
    // Only meaningful when freshAppendIndexes is signature-checking.
    if (!externalWritersPossible) return;
    appendIndexesSignature = await computeLogSignature();
  };

  // Critical correctness rule: deps must reflect the editor's observed
  // state at edit time, NOT the companion's current frontier. Otherwise
  // an outbox replay arriving after peer events would falsely claim to
  // have observed those peer events and silently win conflicts.
  //
  // Sync Contract v1, served from the maintained indexes instead of
  // the merged log:
  //   - Browser-observed (appendClientObserved): baseVector present
  //     (possibly `{}`) → deps stamped EXACTLY from it. Empty means
  //     "browser observed nothing" — legitimate; never replaced with
  //     the companion's own frontier.
  //   - Server-observed (appendServerObserved): baseVector omitted →
  //     deps = union vector of the aggregate's prior events (the fold
  //     registerInAppendIndexes maintains is vectorFromEvents of
  //     exactly that subset).
  //   - clientDeps → resolved id→dot via the index, so events that
  //     depend on a sibling event in the SAME POST batch get the right
  //     dot; unresolved deps drop (not yet in our log — reconstructed
  //     when the missing events arrive).
  const computeDepsIndexed = <TPayload extends Record<string, unknown>>(
    input: AppendInput<TPayload>,
    idx: AppendIndexes,
  ): VersionVector => {
    let deps: VersionVector =
      input.baseVector !== undefined
        ? input.baseVector
        : (idx.aggregateVectors.get(input.aggregateId) ?? {});
    if (input.clientDeps !== undefined && input.clientDeps.length > 0) {
      for (const dep of input.clientDeps) {
        const resolved = idx.clientIdToDot.get(dep);
        if (resolved !== undefined) {
          deps = maxVector(deps, { [resolved.replicaId]: resolved.seq });
        }
      }
    }
    return deps;
  };

  const appendClient = <TPayload extends Record<string, unknown>>(
    input: AppendInput<TPayload>,
  ): Promise<AcceptedEvent<TPayload>> =>
    enqueueAppend(async () => {
      const idx = await freshAppendIndexes();
      if (idx.clientIdToDot.has(input.clientEventId)) {
        // Duplicate replay (rare) — the index proves presence; fetch
        // the full event from the merged log for the return contract.
        const existing = await findByClientEventId(input.clientEventId);
        if (existing !== null) {
          return existing as AcceptedEvent<TPayload>;
        }
        // Index and merged log disagree (corrupt/unreadable line).
        // Minting a fresh dot for an id the log already carries would
        // poison sync with a ClientEventIdReuse on every peer — fail
        // the append loudly instead.
        throw new Error(
          `Event log inconsistent: clientEventId ${input.clientEventId} is indexed but unreadable from the shards.`,
        );
      }
      // Resolve deps from the maintained indexes — same Sync Contract
      // v1 stamping as computeDepsFromInput without re-reading the log.
      const deps = computeDepsIndexed(input, idx);
      const seq = await replica.nextSeq();
      const dot: Dot = { replicaId: replica.replicaId, seq };
      // Defense-in-depth against dot reuse: the boot reconciliation
      // (loadOrCreateReplica ← maxShardTailSeqForReplica) already lifts
      // the seq counter past every committed shard tail, so a fresh seq
      // must not collide. But if the seq counter were ever corrupted at
      // runtime, appending on a dot the index already carries would mint
      // a duplicate causal primary key. The index is already in hand
      // here (freshAppendIndexes above) — no extra scan — so reject
      // loudly instead of poisoning the log.
      if (idx.dotKeys.has(dotKeyOf(dot))) {
        throw new Error(
          `Refusing to reuse local dot (${dot.replicaId}, ${String(dot.seq)}) for clientEventId ${input.clientEventId}: the seq counter regressed behind the committed shard tail.`,
        );
      }
      const event: AcceptedEvent<TPayload> = {
        clientEventId: input.clientEventId,
        dot,
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
      // Register only after the durable write — a failed write must
      // not leave the index claiming presence (it would silently drop
      // the retry as a duplicate).
      registerInAppendIndexes(idx, event);
      await recordAppendIndexesSignature();
      return event;
    });

  const appendClientObservedBatch = <TPayload extends Record<string, unknown>>(
    inputs: readonly AppendInputObserved<TPayload>[],
    onAccepted?: (event: AcceptedEvent<TPayload>) => void,
  ): Promise<readonly { readonly clientEventId: string; readonly imported: boolean }[]> =>
    enqueueAppend(async () => {
      if (inputs.length === 0) return [];
      // Index-backed dedupe + deps (was: ONE readMerged per batch —
      // which still re-read the whole log every time, because the
      // previous batch's append invalidates the memo).
      const idx = await freshAppendIndexes();
      const presentInBatch = new Set<string>();
      // Dots minted earlier in THIS batch. Kept separate from the shared
      // idx.dotKeys (which only registers after the durable write) so a
      // mid-batch write failure can't strand phantom dots in the live
      // index, while a regressed counter that hands out the same seq
      // twice within one batch is still caught.
      const dotsInBatch = new Set<string>();
      const events: AcceptedEvent<TPayload>[] = [];
      const results: { clientEventId: string; imported: boolean }[] = [];
      const at = now();
      for (const input of inputs) {
        if (idx.clientIdToDot.has(input.clientEventId) || presentInBatch.has(input.clientEventId)) {
          // Already in the log OR earlier in this batch — dedupe,
          // exactly like appendClient's index guard.
          results.push({ clientEventId: input.clientEventId, imported: false });
          continue;
        }
        const deps = computeDepsIndexed(input, idx);
        // eslint-disable-next-line no-await-in-loop -- nextSeq is a cheap monotonic counter
        const seq = await replica.nextSeq();
        const dot: Dot = { replicaId: replica.replicaId, seq };
        // Same defense-in-depth as appendClient: boot reconciliation
        // (loadOrCreateReplica ← reconcileShardTailSeqForReplica) lifts
        // the counter past every committed shard tail, so a fresh seq
        // must not collide. But under the correlated fault this fix
        // guards (seq file lost/regressed AND a shard tail torn) the
        // counter could regress; without this guard the batch path would
        // SILENTLY write a duplicate (replicaId, seq) dot — a permanent
        // DotCollisionError that poisons sync. The index is already in
        // hand (no extra scan) — reject loudly instead. Also check the
        // batch-local set so a regressed counter handing out the same seq
        // twice WITHIN one batch is caught, without mutating the shared
        // index before the durable write (which would strand phantom dots
        // on a mid-batch write failure).
        const dotKey = dotKeyOf(dot);
        if (idx.dotKeys.has(dotKey) || dotsInBatch.has(dotKey)) {
          throw new Error(
            `Refusing to reuse local dot (${dot.replicaId}, ${String(dot.seq)}) for clientEventId ${input.clientEventId}: the seq counter regressed behind the committed shard tail.`,
          );
        }
        dotsInBatch.add(dotKey);
        const event: AcceptedEvent<TPayload> = {
          clientEventId: input.clientEventId,
          dot,
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
        presentInBatch.add(input.clientEventId);
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
        // Index registration only after the durable write (see
        // appendClient) — and after, not during, the input loop, so a
        // mid-batch write failure can't strand half a batch as
        // phantom duplicates.
        for (const event of events) registerInAppendIndexes(idx, event);
        await recordAppendIndexesSignature();
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
      const idx = await freshAppendIndexes();
      if (idx.dotKeys.has(dotKeyOf(event.dot))) {
        // Dot already present — the collision/equality verdict needs
        // the full stored event; this (rare) path may warm the memo.
        const byDot = await findByDot(event.dot);
        if (byDot !== null) {
          if (canonicalEquals(byDot, event)) {
            return { imported: false } as const;
          }
          throw new DotCollisionError(event.dot, byDot.clientEventId, event.clientEventId);
        }
        // Index claims the dot exists but the merged read can't
        // surface it (transient shard-read failure). Appending on top
        // of a claimed dot would write a duplicate identity — treat
        // as a benign redelivery instead; the peer retries if needed.
        return { imported: false } as const;
      }
      const knownDot = idx.clientIdToDot.get(event.clientEventId);
      if (knownDot !== undefined) {
        // Same clientEventId arriving under a different dot: a peer
        // is reusing the id under different identities. Reject.
        throw new ClientEventIdReuseError(event.clientEventId, knownDot, event.dot);
      }
      const dir = replicaLogDir(vaultPath, event.dot.replicaId);
      await mkdir(dir, { recursive: true });
      const at = new Date(event.acceptedAtMs);
      await writeFile(
        replicaLogPath(vaultPath, event.dot.replicaId, at),
        `${JSON.stringify(event)}\n`,
        { encoding: 'utf8', flag: 'a' },
      );
      registerInAppendIndexes(idx, event);
      await recordAppendIndexesSignature();
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
    readMergedSince,
    streamEvents,
    streamFiltered,
    logSignature: computeLogSignature,
    readReplica,
    readByAggregate,
    findByClientEventId,
    findByDot,
    listReplicaIds,
    importPeerEvent,
    prewarmAppendIndexes: async (): Promise<void> => {
      await warmAppendIndexes();
    },
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

const maybeAttachHlc = (hlc: Hlc | undefined): { hlc?: Hlc } => (hlc === undefined ? {} : { hlc });
