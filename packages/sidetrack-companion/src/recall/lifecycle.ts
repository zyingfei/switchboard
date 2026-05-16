import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EventLog } from '../sync/eventLog.js';
import {
  embed,
  getResolvedEmbedderAccelerator,
  getResolvedEmbedderDevice,
  MODEL_ID,
  type EmbedderAccelerator,
  type EmbedderDevice,
} from './embedder.js';
import { RECALL_TOMBSTONE_TARGET } from './events.js';
import {
  appendEntry as appendEntryRaw,
  gcEntries as gcEntriesRaw,
  readIndex,
  tombstoneByThread as tombstoneByThreadRaw,
} from './indexFile.js';
import type { IndexEntry } from './ranker.js';
import { rebuildFromEventLog, type RecallRebuildPhase } from './rebuild.js';
import type { RecallActivityTracker } from './activity.js';

// Surfaces the current freshness of the recall index so the side
// panel can show what's happening (and so the companion can decide
// whether to auto-rebuild on startup or after a model upgrade).
//
//   missing    — no index file on disk
//   stale      — index file exists but its model id no longer matches
//                the companion's current model. Cosine search across
//                mixed embeddings is meaningless, so the index is
//                effectively unusable until rebuilt.
//   empty      — index file is current but has no entries (vault has
//                no captured turns yet, or only empty captures).
//   rebuilding — a background rebuild is currently in flight.
//   ready      — index is current AND has at least one entry.
export type RecallStatus = 'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready';

export interface RecallStatusReport {
  readonly status: RecallStatus;
  readonly entryCount: number;
  // Coverage estimate — total turns across every captured event in
  // the vault. The side panel can compare this against `entryCount`
  // to flag "events captured but not indexed" cases that need a
  // manual rebuild.
  readonly eventTurnCount: number;
  readonly modelId: string | null;
  readonly currentModelId: string;
  readonly companionVersion: string;
  readonly lastRebuildAt: string | null;
  readonly lastRebuildIndexed: number | null;
  readonly lastError: string | null;
  // Live progress while status === 'rebuilding'. `embedded` ticks
  // up after each batch the embedder finishes; `total` is the
  // upper bound (= every turn in the vault). Both are 0 outside
  // a rebuild, so the UI can guard on `status === 'rebuilding'`
  // before showing the fraction.
  readonly rebuildEmbedded: number;
  readonly rebuildTotal: number;
  // Current rebuild stage (follow-up #17). Non-null only while an
  // IN-PROCESS rebuild is running; null at rest AND during a
  // child-indexer rebuild (the child does not stream phases over IPC —
  // honest null, not a fabricated phase). Guard on `status` first.
  readonly rebuildPhase: RecallRebuildPhase | null;
  // Resolved embedder backend + accelerator from the most recent
  // pipeline load. 'unknown' until the first embed() call has
  // completed, after which it stays sticky for the process
  // lifetime (the pipeline is cached).
  readonly embedderDevice: EmbedderDevice;
  readonly embedderAccelerator: EmbedderAccelerator;
  // Drift between the index and the on-disk capture log. Drift only
  // counts entries MISSING from the index — when peers' captures
  // land via sync the entry count can exceed the local event count,
  // which is healthy. `pct` is `1 - entryCount / eventTurnCount`
  // when the local index lags, otherwise 0.
  readonly drift: {
    readonly eventTurnCount: number;
    readonly entryCount: number;
    readonly pct: number;
    readonly tolerance: number;
  };
}

export interface RecallLifecycle {
  readonly report: () => Promise<RecallStatusReport>;
  readonly ensureFresh: () => Promise<RecallStatusReport>;
  readonly scheduleRebuild: (reason: 'startup' | 'manual' | 'reconnect' | 'drift') => void;
  readonly waitForRebuild: () => Promise<void>;
  readonly isRebuilding: () => boolean;
  // Mutex-serialised write paths. Every concurrent write to the
  // recall index file MUST flow through one of these so a rebuild
  // can't interleave with an appendEntry mid-write.
  readonly appendEntry: (entry: IndexEntry) => Promise<void>;
  readonly gcEntries: (validIds: ReadonlySet<string>) => Promise<{ readonly removed: number }>;
  readonly tombstoneByThread: (threadId: string) => Promise<{ readonly tombstoned: number }>;
  // Mutex-serialised incremental ingest. Walks the merged event
  // log and projects unprocessed capture.recorded /
  // recall.tombstone.target events into the V3 index. Holding the
  // single-writer mutex for the whole run prevents a concurrent
  // rebuild or appendEntry from corrupting the index file.
  readonly ingestIncremental: (eventLog: import('../sync/eventLog.js').EventLog) => Promise<{
    readonly indexedChunks: number;
    readonly tombstonedChunks: number;
    readonly tombstonedEntries: number;
  }>;
}

export interface CreateRecallLifecycleOptions {
  readonly vaultRoot: string;
  readonly companionVersion: string;
  // Override for tests — defaults to the production embedder model.
  readonly currentModelId?: string;
  // Override for tests — defaults to the production rebuilder.
  readonly rebuilder?: RebuilderFn;
  // Override for tests — defaults to the production embedder.
  readonly embedder?: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
  // Optional logger — defaults to console.info / console.warn so the
  // companion stdout shows when a rebuild kicks in.
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly activity?: Pick<
    RecallActivityTracker,
    | 'recordRebuildStarted'
    | 'recordRebuildFinished'
    | 'recordRebuildFailed'
    | 'recordIncrementalIndex'
  >;
  // Drift tolerance: when entryCount < eventTurnCount * (1 - tolerance)
  // the report flips to `stale` and a rebuild is scheduled. 0.05 (5%)
  // is loose enough to absorb in-flight auto-index queues but tight
  // enough to catch a half-broken capture pipeline.
  readonly driftTolerance?: number;
  // Optional per-replica seq allocator. When wired, the auto-index
  // path stamps each new entry with `(replicaId, seq)`; without it,
  // entries fall back to the index file's local-replica defaults.
  // The recall index reuses the existing `lamport` field on disk for
  // backward compatibility — the value semantics are now "per-replica
  // seq", same source as the dot.seq, not a Lamport scalar across
  // replicas.
  readonly replica?: {
    readonly replicaId: string;
    readonly nextSeq: () => Promise<number>;
  };
  // Optional event log used to emit `recall.tombstone.target`
  // events when threads are archived/deleted. Without it, tombstones
  // still apply locally but peers won't learn of the deletion via
  // sync — they'd resurrect entries on rebuild from their own log.
  readonly eventLog?: EventLog;
  // Optional indexer client. When provided, scheduled rebuilds run
  // in the recall indexer child process instead of in-process. The
  // parent's main thread is free to serve /v1/status, /v1/recall/
  // query, and every other route while the child reads, chunks,
  // embeds, and writes the index. Falls back to in-process
  // rebuilding when omitted (test mode + library callers).
  readonly indexerClient?: {
    readonly rebuild: (input: {
      readonly vaultRoot: string;
      readonly reason: string;
      readonly onProgress?: (embedded: number, total: number) => void;
    }) => Promise<{
      readonly state: 'ready' | 'failed';
      readonly indexed?: number;
      readonly error?: string;
      readonly durationMs: number;
    }>;
  };
}

// Rebuilder signature must accept an `onProgress` so the lifecycle
// can surface live counts via /v1/system/health while embedding is
// in flight. The production rebuilder calls this after each batch.
type RebuilderFn = (
  vaultRoot: string,
  eventLogPath: string,
  options?: {
    readonly onProgress?: (embedded: number, total: number) => void;
    readonly onPhase?: (phase: RecallRebuildPhase) => void;
    readonly eventLog?: EventLog;
  },
) => Promise<{ readonly indexed: number }>;

const indexPathFor = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'recall', 'index.bin');

const eventLogPathFor = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'events');

const countTurnsInEventLog = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<number> => {
  // Sources, in priority order:
  //   1. The per-replica log under `_BAC/log/<replicaId>/*.jsonl`.
  //      This is where every post-PR-#93 capture lives — including
  //      events synced from peers via the relay. We MUST count this
  //      or drift detection is blind to cross-replica captures and
  //      auto-rebuilds never fire after a sync.
  //   2. The legacy `_BAC/events/*.jsonl` file. Pre-PR-#93 vaults
  //      have only this; post-#93 vaults still write a back-compat
  //      copy of the local replica's captures here. We dedupe by
  //      bac_id so we don't double-count a local capture that was
  //      written through both paths.
  let total = 0;
  const seenBacIds = new Set<string>();
  if (eventLog !== undefined) {
    const accepted = await eventLog.readMerged();
    for (const event of accepted) {
      if (event.type !== 'capture.recorded') continue;
      const payload = event.payload as { readonly bac_id?: unknown; readonly turns?: unknown };
      if (typeof payload.bac_id === 'string') {
        seenBacIds.add(payload.bac_id);
      }
      if (!Array.isArray(payload.turns)) continue;
      for (const rawTurn of payload.turns) {
        if (typeof rawTurn !== 'object' || rawTurn === null) continue;
        const text = (rawTurn as { readonly text?: unknown }).text;
        if (typeof text === 'string' && text.trim().length > 0) {
          total += 1;
        }
      }
    }
  }
  const eventDir = eventLogPathFor(vaultRoot);
  const files = await readdir(eventDir).catch(() => [] as readonly string[]);
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const raw = await readFile(join(eventDir, file), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) continue;
        const bacId = (parsed as { readonly bac_id?: unknown }).bac_id;
        if (typeof bacId === 'string' && seenBacIds.has(bacId)) {
          // Already accounted for via the per-replica log walk
          // above; skip so we don't double-count.
          continue;
        }
        const turns = (parsed as { readonly turns?: unknown }).turns;
        if (!Array.isArray(turns)) continue;
        for (const rawTurn of turns) {
          if (typeof rawTurn !== 'object' || rawTurn === null) continue;
          const text = (rawTurn as { readonly text?: unknown }).text;
          if (typeof text === 'string' && text.trim().length > 0) {
            total += 1;
          }
        }
      } catch {
        // Ignore malformed lines — the event log is append-only.
      }
    }
  }
  return total;
};

export const createRecallLifecycle = (opts: CreateRecallLifecycleOptions): RecallLifecycle => {
  const currentModelId = opts.currentModelId ?? MODEL_ID;
  const rebuilder = opts.rebuilder ?? rebuildFromEventLog;
  const embedFn = opts.embedder ?? embed;
  const driftTolerance = opts.driftTolerance ?? 0.05;
  const log =
    opts.log ??
    ((message: string) => {
      // eslint-disable-next-line no-console
      console.info(message);
    });
  const warn =
    opts.warn ??
    ((message: string) => {
      console.warn(message);
    });

  let rebuildPromise: Promise<void> | null = null;
  let lastError: string | null = null;
  let lastRebuildAt: string | null = null;
  let lastRebuildIndexed: number | null = null;
  // Live progress fields — only meaningful while rebuildPromise is
  // active; reset to 0 between runs so the UI doesn't latch onto
  // a stale fraction.
  let rebuildEmbedded = 0;
  let rebuildTotal = 0;
  let rebuildPhase: RecallRebuildPhase | null = null;

  // Single-writer mutex serialising every path that mutates the
  // index file. Rebuild, appendEntry, gcEntries, tombstoneByThread,
  // and the auto-index batch all queue here so two concurrent
  // callers cannot read-then-write the same file.
  let writeChain: Promise<unknown> = Promise.resolve();
  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(task, task);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const report = async (): Promise<RecallStatusReport> => {
    const [index, eventTurnCount] = await Promise.all([
      readIndex(indexPathFor(opts.vaultRoot)),
      countTurnsInEventLog(opts.vaultRoot, opts.eventLog),
    ]);
    // Tombstoned rows are still on disk (OR-Set semantics) but the
    // user's mental model is "deleted." Drift compares the live
    // entry count against the event log so a tombstoned row doesn't
    // mask missing index coverage.
    const liveEntryCount = (index?.items ?? []).filter((item) => item.tombstoned !== true).length;
    const entryCount = index?.items.length ?? 0;
    const modelId = index?.modelId ?? null;
    const driftPct =
      eventTurnCount > 0 && liveEntryCount < eventTurnCount
        ? Math.max(0, 1 - liveEntryCount / eventTurnCount)
        : 0;
    const driftBeyondTolerance = driftPct > driftTolerance;

    let status: RecallStatus;
    if (rebuildPromise !== null) {
      status = 'rebuilding';
    } else if (index === null) {
      status = 'missing';
    } else if (modelId !== currentModelId) {
      status = 'stale';
    } else if (entryCount === 0 && eventTurnCount > 0) {
      // Header is current but nothing got indexed (likely an
      // upgrade from before incremental indexing was wired). Treat
      // as stale so reconnect-time auto-rebuild can heal it.
      status = 'stale';
    } else if (driftBeyondTolerance) {
      status = 'stale';
    } else if (entryCount === 0) {
      status = 'empty';
    } else {
      status = 'ready';
    }

    return {
      status,
      entryCount,
      eventTurnCount,
      modelId,
      currentModelId,
      companionVersion: opts.companionVersion,
      lastRebuildAt,
      lastRebuildIndexed,
      lastError,
      rebuildEmbedded,
      rebuildTotal,
      rebuildPhase,
      embedderDevice: getResolvedEmbedderDevice(),
      embedderAccelerator: getResolvedEmbedderAccelerator(),
      drift: {
        eventTurnCount,
        entryCount,
        pct: driftPct,
        tolerance: driftTolerance,
      },
    };
  };

  const scheduleRebuild = (reason: 'startup' | 'manual' | 'reconnect' | 'drift'): void => {
    if (rebuildPromise !== null) return;
    opts.activity?.recordRebuildStarted(reason);
    log(`[recall] starting background rebuild (${reason})`);
    lastError = null;
    rebuildEmbedded = 0;
    rebuildTotal = 0;
    rebuildPhase = null;
    rebuildPromise = enqueueWrite(async () => {
      try {
        // Production path: hand off to the recall indexer child
        // process. The parent's main thread is then free to serve
        // /v1/status, /v1/recall/query (lexical-only while we
        // rebuild), and everything else. The child does the read +
        // chunk + embed + encode + write pipeline in isolation.
        // Fallback to in-process rebuilder for tests / library
        // callers that don't wire an indexerClient.
        const indexer = opts.indexerClient;
        if (indexer !== undefined) {
          const outcome = await indexer.rebuild({
            vaultRoot: opts.vaultRoot,
            reason,
            onProgress: (embedded, total) => {
              rebuildEmbedded = embedded;
              rebuildTotal = total;
            },
          });
          if (outcome.state === 'failed') {
            throw new Error(outcome.error ?? 'recall indexer child failed');
          }
          const indexed = outcome.indexed ?? 0;
          opts.activity?.recordRebuildFinished(indexed);
          lastRebuildAt = new Date().toISOString();
          lastRebuildIndexed = indexed;
          log(
            `[recall] background rebuild finished via indexer child: indexed ${String(indexed)} entries in ${String(outcome.durationMs)} ms`,
          );
          return;
        }
        const result = await rebuilder(opts.vaultRoot, eventLogPathFor(opts.vaultRoot), {
          onProgress: (embedded, total) => {
            rebuildEmbedded = embedded;
            rebuildTotal = total;
          },
          onPhase: (phase) => {
            rebuildPhase = phase;
          },
          ...(opts.eventLog === undefined ? {} : { eventLog: opts.eventLog }),
        });
        opts.activity?.recordRebuildFinished(result.indexed);
        lastRebuildAt = new Date().toISOString();
        lastRebuildIndexed = result.indexed;
        log(`[recall] background rebuild finished: indexed ${String(result.indexed)} entries`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Recall rebuild failed.';
        lastError = message;
        opts.activity?.recordRebuildFailed(message);
        warn(`[recall] background rebuild failed: ${message}`);
      } finally {
        rebuildPromise = null;
        rebuildEmbedded = 0;
        rebuildTotal = 0;
      }
    });
  };

  const ensureFresh = async (): Promise<RecallStatusReport> => {
    const current = await report();
    if (current.status === 'missing' || current.status === 'stale') {
      scheduleRebuild(current.status === 'missing' ? 'startup' : 'drift');
    }
    return current;
  };

  const waitForRebuild = async (): Promise<void> => {
    if (rebuildPromise !== null) {
      await rebuildPromise;
    }
  };

  const isRebuilding = (): boolean => rebuildPromise !== null;

  const indexPath = (): string => indexPathFor(opts.vaultRoot);

  // Cap matches rebuildFromEventLog so memory pressure stays bounded
  // during catch-up after a long offline window. 16 turns × ~1500
  // chars × 384-dim ≈ ~75KB of activations per batch on this model.
  const AUTO_INDEX_BATCH_SIZE = 16;

  const appendEntry = (entry: IndexEntry): Promise<void> =>
    enqueueWrite(async () => {
      await appendEntryRaw(indexPath(), entry, currentModelId);
    });

  const gcEntries = (validIds: ReadonlySet<string>): Promise<{ readonly removed: number }> =>
    enqueueWrite(async () => await gcEntriesRaw(indexPath(), validIds));

  const ingestIncremental = (
    eventLog: import('../sync/eventLog.js').EventLog,
  ): Promise<{
    readonly indexedChunks: number;
    readonly tombstonedChunks: number;
    readonly tombstonedEntries: number;
  }> =>
    enqueueWrite(async () => {
      // Lazy import keeps the lifecycle module's dependency graph
      // narrow — the ingestor pulls in the chunker + manifest paths
      // which are heavy.
      const { ingestIncremental: ingest } = await import('./ingestor.js');
      return await ingest(opts.vaultRoot, eventLog);
    });

  const tombstoneByThread = (threadId: string): Promise<{ readonly tombstoned: number }> =>
    enqueueWrite(async () => {
      // Emit a log event so peers learn about the tombstone via
      // sync. clientEventId is deterministic per (threadId,
      // replicaId) so a duplicate archive call collapses on the
      // eventLog's idempotency check rather than appending another
      // event. Best-effort; if the eventLog isn't wired (legacy
      // tests), we still mutate the index locally.
      if (opts.eventLog !== undefined && opts.replica !== undefined) {
        // Invariant C: do not pass an explicit baseVector. The
        // eventLog auto-resolves deps from this aggregate's prior
        // events, so concurrent tombstones from two replicas still
        // dominate any pre-tombstone projection.
        await opts.eventLog
          .appendServerObserved({
            clientEventId: `recall-tombstone:${opts.replica.replicaId}:${threadId}`,
            aggregateId: threadId,
            type: RECALL_TOMBSTONE_TARGET,
            payload: { threadId },
          })
          .catch(() => undefined);
      }
      return await tombstoneByThreadRaw(indexPath(), threadId);
    });

  return {
    report,
    ensureFresh,
    scheduleRebuild,
    waitForRebuild,
    isRebuilding,
    appendEntry,
    gcEntries,
    tombstoneByThread,
    ingestIncremental,
  };
};
