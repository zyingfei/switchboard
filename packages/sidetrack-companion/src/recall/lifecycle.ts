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
import { rebuildFromEventLog } from './rebuild.js';
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

// One captured turn ready to be embedded + appended. The HTTP layer
// shapes capture events into this list and hands it to the
// lifecycle's `appendCaptureTurns` so the embedder + index writes go
// through the lifecycle's mutex (sharing the lane with rebuild).
export interface CaptureTurnInput {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly text: string;
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
  readonly appendCaptureTurns: (
    turns: readonly CaptureTurnInput[],
  ) => Promise<{ readonly indexed: number }>;
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
    'recordRebuildStarted' | 'recordRebuildFinished' | 'recordRebuildFailed' | 'recordIncrementalIndex'
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
}

// Rebuilder signature must accept an `onProgress` so the lifecycle
// can surface live counts via /v1/system/health while embedding is
// in flight. The production rebuilder calls this after each batch.
type RebuilderFn = (
  vaultRoot: string,
  eventLogPath: string,
  options?: {
    readonly onProgress?: (embedded: number, total: number) => void;
    readonly eventLog?: EventLog;
  },
) => Promise<{ readonly indexed: number }>;

const indexPathFor = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'recall', 'index.bin');

const eventLogPathFor = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'events');

const countTurnsInEventLog = async (vaultRoot: string): Promise<number> => {
  const eventDir = eventLogPathFor(vaultRoot);
  const files = await readdir(eventDir).catch(() => [] as readonly string[]);
  let total = 0;
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    const raw = await readFile(join(eventDir, file), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) continue;
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
      countTurnsInEventLog(opts.vaultRoot),
    ]);
    // Tombstoned rows are still on disk (OR-Set semantics) but the
    // user's mental model is "deleted." Drift compares the live
    // entry count against the event log so a tombstoned row doesn't
    // mask missing index coverage.
    const liveEntryCount = (index?.items ?? []).filter(
      (item) => item.tombstoned !== true,
    ).length;
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
    rebuildPromise = enqueueWrite(async () => {
      try {
        const result = await rebuilder(opts.vaultRoot, eventLogPathFor(opts.vaultRoot), {
          onProgress: (embedded, total) => {
            rebuildEmbedded = embedded;
            rebuildTotal = total;
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

  const gcEntries = (
    validIds: ReadonlySet<string>,
  ): Promise<{ readonly removed: number }> =>
    enqueueWrite(async () => await gcEntriesRaw(indexPath(), validIds));

  const tombstoneByThread = (
    threadId: string,
  ): Promise<{ readonly tombstoned: number }> =>
    enqueueWrite(async () => {
      // Emit a log event so peers learn about the tombstone via
      // sync. clientEventId is deterministic per (threadId,
      // replicaId) so a duplicate archive call collapses on the
      // eventLog's idempotency check rather than appending another
      // event. Best-effort; if the eventLog isn't wired (legacy
      // tests), we still mutate the index locally.
      if (opts.eventLog !== undefined && opts.replica !== undefined) {
        await opts.eventLog
          .appendClient({
            clientEventId: `recall-tombstone:${opts.replica.replicaId}:${threadId}`,
            aggregateId: threadId,
            type: RECALL_TOMBSTONE_TARGET,
            payload: { threadId },
            baseVector: {},
          })
          .catch(() => undefined);
      }
      return await tombstoneByThreadRaw(indexPath(), threadId);
    });

  const appendCaptureTurns = (
    turns: readonly CaptureTurnInput[],
  ): Promise<{ readonly indexed: number }> =>
    enqueueWrite(async () => {
      if (turns.length === 0) return { indexed: 0 };
      let indexed = 0;
      const indexedThreadIds: string[] = [];
      for (let offset = 0; offset < turns.length; offset += AUTO_INDEX_BATCH_SIZE) {
        const batch = turns.slice(offset, offset + AUTO_INDEX_BATCH_SIZE);
        const vectors = await embedFn(batch.map((turn) => turn.text));
        for (let index = 0; index < batch.length; index += 1) {
          const turn = batch[index];
          const embedding = vectors[index];
          if (turn === undefined || embedding === undefined) continue;
          const seq = opts.replica !== undefined ? await opts.replica.nextSeq() : undefined;
          const entry: IndexEntry = {
            id: turn.id,
            threadId: turn.threadId,
            capturedAt: turn.capturedAt,
            embedding,
            ...(opts.replica !== undefined ? { replicaId: opts.replica.replicaId } : {}),
            // The IndexEntry persists the per-replica seq under the
            // legacy `lamport` field name. CRDT-aware readers use
            // `(replicaId, lamport)` as the dot equivalent.
            ...(seq !== undefined ? { lamport: seq } : {}),
          };
          await appendEntryRaw(indexPath(), entry, currentModelId);
          indexed += 1;
          indexedThreadIds.push(turn.threadId);
        }
        // Yield between batches so the HTTP server stays responsive
        // while a large catch-up is running.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      if (indexed > 0) {
        opts.activity?.recordIncrementalIndex({ count: indexed, threadIds: indexedThreadIds });
      }
      return { indexed };
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
    appendCaptureTurns,
  };
};
