import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';

// Sync Contract v1 / Class B + E — embedding cache.
//
// Keyed by (modelId, modelRevision, embedTextHash). When an
// extraction upgrade changes only metadata (e.g., extractor adds a
// new tag, schema version bumps) but the chunk text is unchanged,
// the embedder doesn't run — the cache returns the prior vector.
// This is what makes metadata-only plugin upgrades cheap.
//
// Storage: a single binary file at `_BAC/recall/embed-cache.bin`.
//
//   u32 headerLength + UTF-8 JSON header
//     { magic, version, modelId, modelRevision, dim }
//   repeated records:
//     u32 hashLength + hash UTF-8     (embedTextHash; identifier)
//     dim * float32 little-endian     (vector)
//
// Mismatched modelId or modelRevision → cache is dropped on next
// write (the lifecycle's stale-check already rebuilds the index in
// that case; the cache is purely an optimization).
//
// ---------------------------------------------------------------------------
// WRITE PATH (2026-08-17) — APPEND, NOT REWRITE.
//
// `putMany` used to read the WHOLE file and rewrite it (tmp + rename) on
// EVERY call, no matter how small the incoming batch was. At a ~10-14MB live
// cache and the page-evidence embed lane calling `putMany`+`put` once PER
// embedded record (two full-file rewrites per record: one for the chunk
// vectors, one for the doc vector), that put write volume at O(cache-size)
// PER RECORD instead of O(record-size) — a full-file rewrite every ~4s cycle
// traced to ~350MB/min of disk writes dominated by this file, the SSD-wear
// top concern.
//
// The on-disk FORMAT already supported this without any migration: records
// are read sequentially into a Map keyed by hash, so a later record for the
// same hash simply overwrites an earlier one when parsed — a duplicate-key
// log is already valid input. So the fix needed no new file, no schema
// version bump, and no one-time port: when the model identity is unchanged,
// `putMany` now APPENDS just the new/changed records (one `appendFile` of
// only the incoming batch's bytes) instead of re-serializing every entry in
// the cache. A first write, or a model-identity change, still does a full
// (fresh, therefore small) rewrite — that path was never the expensive one.
//
// COMPACTION: repeated overwrites of the same hash (re-embeds, model
// migrations via `migrateModel`) leave stale superseded records in the log.
// Each append that overwrites an existing hash counts that record's encoded
// byte length as "stale" (`staleBytesSinceCompaction`, module-scoped per
// path). Once accumulated stale bytes cross `compactionStaleBytesThreshold`
// (default 2MB), the next write does one full compacting rewrite instead of
// an append, reclaiming the dead space, then resumes appending. This is the
// "periodic compaction" this file's docstring named as a TODO for years —
// now the actual write strategy, not a follow-up.
//
// CRASH SAFETY: an append is not a single atomic rename like the old
// rewrite-then-swap was, so a crash mid-`appendFile` can leave a truncated
// trailing record. `readCacheFileUncached` treats an incomplete trailing
// record as end-of-file (stopping the scan there) rather than discarding the
// whole parse — every record fully written before the crash is still read
// back. Losing an in-flight, not-yet-fsynced batch is acceptable: this file
// is a CACHE (embedTextHash → vector); the worst case is re-embedding a few
// texts, never corrupting recall (the lifecycle rebuilds the index from
// source content, not from this cache).
// ---------------------------------------------------------------------------
//
// ---------------------------------------------------------------------------
// E2 (2026-07-29) — THIS FILE IS THE SHARED SUBSTRATE.
//
// The audit's §G2 names two systems answering "what is similar?" — the
// materialized visit-similarity build and the recall-v2 chunk vectors — with
// separate embed paths and separate cold-caches. They are being converged on
// THIS cache so that one (model, text) pair is embedded once machine-wide.
// Corpora and edge semantics are deliberately NOT merged (see
// docs/audits/2026-07-29-similarity-substrate-map.md).
//
// That convergence needs two things the original single-key API could not give:
//
//   1. BATCH ACCESS. `get`/`put` each read (and `put` also rewrites) the WHOLE
//      file. The similarity build's cold path does one get per text and one put
//      per vector, so a corpus of N texts costs O(N) full-file reads and O(N)
//      full-file rewrites of a file that grows to N × dim × 4 bytes — quadratic
//      in bytes. At the live corpus (63,221 similarity-family edges, ~63k
//      texts × 384 dims) that is ~97MB rewritten per vector. `getMany`/`putMany`
//      make it one read and one write PER BATCH, which is what every call site
//      already structures its work around.
//   2. A PROCESS MEMO. The query-time lane path needs a lookup per resolved
//      URL; a full-file read there would put exactly the kind of unbounded I/O
//      back on the request path that the resolve work keeps removing. The memo
//      is validated against (mtimeMs, size), so a write from the drain child is
//      picked up on the next call without any cross-process signalling.
//
// `embedTextHash(text)` is the ONE canonical key derivation. Any site that
// keys this cache on something else (page-evidence keys its DOC vector on a
// vectorId) is a separate keyspace in the same file and can never share a hit —
// the map documents that seam.
// ---------------------------------------------------------------------------

const MAGIC = 'SIDETRACK_EMBED_CACHE';
const VERSION = 1;

interface CacheHeader {
  readonly magic: string;
  readonly version: number;
  readonly modelId: string;
  readonly modelRevision?: string;
  readonly dim: number;
}

export interface EmbeddingCacheKey {
  readonly modelId: string;
  readonly modelRevision?: string;
  readonly embedTextHash: string;
}

/** The identity half of a cache key, shared by every entry in one batch. */
export interface EmbeddingCacheModelKey {
  readonly modelId: string;
  readonly modelRevision?: string;
}

export interface EmbeddingCache {
  readonly get: (key: EmbeddingCacheKey) => Promise<Float32Array | null>;
  readonly put: (key: EmbeddingCacheKey, vector: Float32Array) => Promise<void>;
  /** One file read for the whole batch (zero I/O on a warm memo). Missing
   *  hashes are simply absent from the returned map. */
  readonly getMany: (
    model: EmbeddingCacheModelKey,
    embedTextHashes: readonly string[],
  ) => Promise<ReadonlyMap<string, Float32Array>>;
  /** One read + one write for the whole batch. Entries whose vector has the
   *  wrong dimension are skipped rather than corrupting the file. */
  readonly putMany: (
    model: EmbeddingCacheModelKey,
    entries: readonly (readonly [string, Float32Array])[],
  ) => Promise<void>;
  readonly stats: () => Promise<{ readonly entries: number; readonly modelId: string | null }>;
  /** Typed read-back: an absent file is not the same signal as an initialized
   *  corpus with zero vectors. */
  readonly inspect: (
    model: EmbeddingCacheModelKey,
  ) => Promise<
    | { readonly kind: 'absent' }
    | { readonly kind: 'ready'; readonly entries: number; readonly model: EmbeddingCacheModelKey }
  >;
  /** Atomically promote an exact-model cache to a new lifecycle revision.
   *  Vectors are copied byte-for-byte; a rollback copy remains available. */
  readonly migrateModel: (
    from: EmbeddingCacheModelKey,
    to: EmbeddingCacheModelKey,
  ) => Promise<'absent' | 'not-applicable' | 'already-current' | 'migrated'>;
  /** Restore the byte-for-byte pre-migration cache, if one exists. */
  readonly rollbackMigration: () => Promise<boolean>;
  /** Publish an initialized-empty corpus without inventing a sentinel vector. */
  readonly initialize: (model: EmbeddingCacheModelKey) => Promise<void>;
}

export interface EmbeddingCacheOptions {
  readonly lockAttempts?: number;
  readonly lockRetryMs?: number;
  readonly lockStaleMs?: number;
  /** Accumulated stale (superseded-record) bytes in the append log that
   *  trigger a compacting rewrite. Default 2MB. Tests lower this to force a
   *  deterministic compaction. */
  readonly compactionStaleBytesThreshold?: number;
  /** Audibility hook: called with a throttled, ONE-LINE-per-window summary
   *  of bytes actually written to disk (`[embed-cache] flushed
   *  entries=N bytes=M kind=append|compact`) so write volume is
   *  attributable from the log. Defaults to a no-op — callers that want
   *  the line on stdout pass `(m) => process.stdout.write(`${m}\n`)`, same
   *  convention as the background-embedding lane's `log` dep. */
  readonly log?: (message: string) => void;
  /** Minimum ms between flush log lines per cache file. Pending
   *  entries/bytes accumulate across throttled-away flushes so the next
   *  emitted line still reports the true total for the window. Default
   *  5000ms; tests pass 0 to log every flush deterministically. */
  readonly flushLogIntervalMs?: number;
}

export class EmbeddingCacheBackpressureError extends Error {
  readonly code = 'EMBEDDING_CACHE_BACKPRESSURE' as const;
  constructor(readonly attempts: number) {
    super(`embedding cache writer remained busy after ${String(attempts)} attempts`);
    this.name = 'EmbeddingCacheBackpressureError';
  }
}

/**
 * The ONE key derivation for text-addressed entries. Every substrate must use
 * this and nothing else — a second hash function over the same texts would put
 * two disjoint keyspaces in one file and silently guarantee a 0% hit rate
 * between them (which is exactly the shape of the page-evidence doc-vector
 * seam documented in the map).
 */
export const embedTextHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const encodeString = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
};

const readString = (buffer: Buffer, cursor: { offset: number }): string => {
  const length = buffer.readUInt32LE(cursor.offset);
  cursor.offset += 4;
  const value = buffer.subarray(cursor.offset, cursor.offset + length).toString('utf8');
  cursor.offset += length;
  return value;
};

/** Encode one (hash, vector) record in the on-disk record format. Shared by
 *  the full-rewrite path (writeCacheFile) and the append-only path, so a
 *  record looks byte-identical regardless of which path wrote it. */
const encodeRecord = (hash: string, vector: Float32Array, dim: number): Buffer => {
  const vecBytes = Buffer.alloc(dim * 4);
  for (let i = 0; i < dim; i += 1) {
    vecBytes.writeFloatLE(vector[i] ?? 0, i * 4);
  }
  return Buffer.concat([encodeString(hash), vecBytes]);
};

const encodeRecords = (
  entries: Iterable<readonly [string, Float32Array]>,
  dim: number,
): Buffer => {
  const records: Buffer[] = [];
  for (const [hash, vector] of entries) records.push(encodeRecord(hash, vector, dim));
  return Buffer.concat(records);
};

interface CacheState {
  readonly path: string;
  readonly dim: number;
}

interface LoadedCache {
  readonly header: CacheHeader;
  readonly entries: Map<string, Float32Array>;
}

// Process memo of the parsed file, keyed by path and validated against the
// file's (mtimeMs, size). Parsing is O(file); without this, a per-URL lookup on
// the resolve path would re-read and re-parse the whole cache on every call.
// Validating against a stat (rather than assuming this process is the only
// writer) is what makes it correct when the fork-per-drain child writes the
// file underneath the parent — the parent picks the new bytes up on its next
// call, with no cross-process signalling to get wrong.
const memo = new Map<string, { mtimeMs: number; size: number; ino: number; loaded: LoadedCache }>();

/** Test seam — the memo (and the append/compaction/flush-log bookkeeping,
 *  all process-global) so tests that write the file directly (rather than
 *  through this module) must be able to drop them. */
export const __resetEmbeddingCacheMemo = (): void => {
  memo.clear();
  staleBytesSinceCompaction.clear();
  flushLogState.clear();
};

const readCacheFileUncached = async (state: CacheState): Promise<LoadedCache | null> => {
  let buffer: Buffer;
  try {
    buffer = await readFile(state.path);
  } catch {
    return null;
  }
  try {
    const cursor = { offset: 0 };
    const headerLength = buffer.readUInt32LE(cursor.offset);
    cursor.offset += 4;
    const headerJson = buffer
      .subarray(cursor.offset, cursor.offset + headerLength)
      .toString('utf8');
    cursor.offset += headerLength;
    const header = JSON.parse(headerJson) as CacheHeader;
    if (header.magic !== MAGIC || header.version !== VERSION) return null;
    if (header.dim !== state.dim) return null;
    const entries = new Map<string, Float32Array>();
    // CRASH SAFETY: appends are no longer swapped in atomically (see the
    // WRITE PATH note above), so a crash mid-`appendFile` can leave a
    // truncated trailing record. Treat "not enough bytes left for one more
    // full record" as end-of-file rather than a parse error — every record
    // fully written before the crash is still returned; only the in-flight,
    // never-fsynced tail is dropped (acceptable: this is a cache).
    const recordBytes = (hashByteLength: number): number => 4 + hashByteLength + state.dim * 4;
    while (cursor.offset < buffer.length) {
      if (cursor.offset + 4 > buffer.length) break; // truncated hash-length field
      const hashLength = buffer.readUInt32LE(cursor.offset);
      if (cursor.offset + recordBytes(hashLength) > buffer.length) break; // truncated record
      const hash = readString(buffer, cursor);
      const vec = new Float32Array(state.dim);
      for (let i = 0; i < state.dim; i += 1) {
        vec[i] = buffer.readFloatLE(cursor.offset);
        cursor.offset += 4;
      }
      entries.set(hash, vec);
    }
    return { header, entries };
  } catch {
    return null;
  }
};

const readCacheFile = async (state: CacheState): Promise<LoadedCache | null> => {
  let mtimeMs: number;
  let size: number;
  let ino: number;
  try {
    const info = await stat(state.path);
    mtimeMs = info.mtimeMs;
    size = info.size;
    ino = info.ino;
  } catch {
    // No file yet (or unreadable) — drop any memo so a later create is seen.
    memo.delete(state.path);
    return null;
  }
  const hit = memo.get(state.path);
  if (hit !== undefined && hit.mtimeMs === mtimeMs && hit.size === size && hit.ino === ino) {
    return hit.loaded;
  }
  const loaded = await readCacheFileUncached(state);
  if (loaded === null) {
    memo.delete(state.path);
    return null;
  }
  memo.set(state.path, { mtimeMs, size, ino, loaded });
  return loaded;
};

// A full rewrite (tmp + atomic rename). This is the EXPENSIVE, O(cache-size)
// path — used only for: the first write to a path, a model-identity change
// ("start clean"), a `migrateModel`/`rollbackMigration`, and a compaction
// once accumulated stale bytes cross the threshold. Returns the total bytes
// written so callers can attribute the write in the flush log.
const writeCacheFile = async (
  state: CacheState,
  header: CacheHeader,
  entries: Map<string, Float32Array>,
): Promise<number> => {
  await mkdir(dirname(state.path), { recursive: true });
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(headerBytes.length, 0);
  const recordBytes = encodeRecords(entries, state.dim);
  const fileBytes = Buffer.concat([headerLen, headerBytes, recordBytes]);
  const tempPath = join(dirname(state.path), `.embed-cache.${createRevision()}.tmp`);
  await writeFile(tempPath, fileBytes);
  await rename(tempPath, state.path);
  // Refresh the memo from what we just wrote so the next read is free instead
  // of re-parsing bytes this process already has in hand.
  try {
    const info = await stat(state.path);
    memo.set(state.path, {
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
      loaded: { header, entries },
    });
  } catch {
    memo.delete(state.path);
  }
  staleBytesSinceCompaction.delete(state.path);
  return fileBytes.length;
};

// APPEND-ONLY path: writes only the incoming batch's encoded bytes to the
// end of the file (one `appendFile` call), then updates the memo in-memory
// (merged map) so a subsequent read doesn't re-parse the file it already
// has in hand. This is the O(batch), not O(cache-size), write. Returns the
// bytes actually written to disk.
const appendCacheEntries = async (
  state: CacheState,
  header: CacheHeader,
  mergedEntries: Map<string, Float32Array>,
  incoming: readonly (readonly [string, Float32Array])[],
): Promise<number> => {
  const appendBytes = encodeRecords(incoming, state.dim);
  await appendFile(state.path, appendBytes);
  try {
    const info = await stat(state.path);
    memo.set(state.path, {
      mtimeMs: info.mtimeMs,
      size: info.size,
      ino: info.ino,
      loaded: { header, entries: mergedEntries },
    });
  } catch {
    memo.delete(state.path);
  }
  return appendBytes.length;
};

// Per-path accumulator of superseded-record bytes still sitting in the
// append log (a later record for the same hash makes the earlier on-disk
// record dead weight). Drives the compaction trigger — see the WRITE PATH
// doc comment above.
const staleBytesSinceCompaction = new Map<string, number>();
const DEFAULT_COMPACTION_STALE_BYTES_THRESHOLD = 2 * 1024 * 1024;

// Throttled flush-log accumulator, keyed by path. Pending entries/bytes
// accumulate across throttled-away flushes so the next emitted line still
// reports the true total for the window — a flush is never silently
// unaccounted for, only its LOG LINE is coalesced.
interface FlushLogState {
  lastLogAtMs: number;
  pendingEntries: number;
  pendingBytes: number;
  kinds: Set<'append' | 'compact'>;
}
const flushLogState = new Map<string, FlushLogState>();
const DEFAULT_FLUSH_LOG_INTERVAL_MS = 5_000;

const recordFlush = (
  path: string,
  kind: 'append' | 'compact',
  entries: number,
  bytes: number,
  log: (message: string) => void,
  intervalMs: number,
): void => {
  const nowMs = Date.now();
  const state = flushLogState.get(path) ?? {
    lastLogAtMs: 0,
    pendingEntries: 0,
    pendingBytes: 0,
    kinds: new Set<'append' | 'compact'>(),
  };
  state.pendingEntries += entries;
  state.pendingBytes += bytes;
  state.kinds.add(kind);
  if (nowMs - state.lastLogAtMs < intervalMs) {
    flushLogState.set(path, state);
    return;
  }
  const kindLabel = [...state.kinds].sort().join('+');
  log(
    `[embed-cache] flushed entries=${String(state.pendingEntries)} bytes=${String(
      state.pendingBytes,
    )} kind=${kindLabel} path=${path}`,
  );
  flushLogState.set(path, {
    lastLogAtMs: nowMs,
    pendingEntries: 0,
    pendingBytes: 0,
    kinds: new Set<'append' | 'compact'>(),
  });
};

export const createEmbeddingCache = (
  vaultRoot: string,
  dim = 384,
  options: EmbeddingCacheOptions = {},
): EmbeddingCache => {
  const state: CacheState = {
    path: join(vaultRoot, '_BAC', 'recall', 'embed-cache.bin'),
    dim,
  };
  const lockPath = `${state.path}.lock`;
  const rollbackPath = `${state.path}.rollback`;
  const lockAttempts = Math.max(1, options.lockAttempts ?? 6);
  const lockRetryMs = Math.max(0, options.lockRetryMs ?? 5);
  const lockStaleMs = Math.max(1, options.lockStaleMs ?? 120_000);
  const compactionStaleBytesThreshold = Math.max(
    0,
    options.compactionStaleBytesThreshold ?? DEFAULT_COMPACTION_STALE_BYTES_THRESHOLD,
  );
  const log = options.log ?? ((): void => undefined);
  const flushLogIntervalMs = Math.max(0, options.flushLogIntervalMs ?? DEFAULT_FLUSH_LOG_INTERVAL_MS);

  const withWriteLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    await mkdir(dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
      try {
        await mkdir(lockPath);
        try {
          return await fn();
        } finally {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > lockStaleMs) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if (!(lockError instanceof Error && 'code' in lockError && lockError.code === 'ENOENT')) {
            throw lockError;
          }
        }
        if (attempt === lockAttempts - 1) {
          throw new EmbeddingCacheBackpressureError(lockAttempts);
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, lockRetryMs * 2 ** attempt);
        });
      }
    }
    throw new EmbeddingCacheBackpressureError(lockAttempts);
  };

  const get = async (key: EmbeddingCacheKey): Promise<Float32Array | null> => {
    const cached = await readCacheFile(state);
    if (cached === null) return null;
    if (cached.header.modelId !== key.modelId) return null;
    if (cached.header.modelRevision !== key.modelRevision) return null;
    return cached.entries.get(key.embedTextHash) ?? null;
  };

  const freshHeader = (model: EmbeddingCacheModelKey): CacheHeader => ({
    magic: MAGIC,
    version: VERSION,
    modelId: model.modelId,
    ...(model.modelRevision === undefined ? {} : { modelRevision: model.modelRevision }),
    dim: state.dim,
  });

  const putMany = async (
    model: EmbeddingCacheModelKey,
    incoming: readonly (readonly [string, Float32Array])[],
  ): Promise<void> => {
    const writable = incoming.filter(([, vector]) => vector.length === state.dim);
    if (writable.length === 0) return;
    await withWriteLock(async () => {
      // Re-read only after taking the cross-process writer lock. The previous
      // implementation read before write with no exclusion, so the parent and
      // drain child could each publish a map that omitted the other's batch.
      //
      // Memoized read is CORRECT here: the memo is guarded on the file's
      // (mtimeMs, size, ino), so any foreign process's write since our last
      // read busts it and forces a real parse — and we hold the writer lock,
      // so nobody can write between the stat check and our write. The
      // uncached read cost a full file parse (10.5MB live) per ≤8-vector
      // batch on the embed lane's 4s cadence during backfills.
      const existing = await readCacheFile(state);
      const modelMatches =
        existing !== null &&
        existing.header.modelId === model.modelId &&
        existing.header.modelRevision === model.modelRevision;
      if (!modelMatches) {
        // Model changed (or no file yet) — start clean. Serving vectors from
        // a different model would be worse than a cold cache. This is a
        // FULL rewrite, but of a fresh (therefore small — just this batch)
        // map, so it is cheap; it is not the O(cache-size)-per-record path
        // the append design exists to avoid.
        const header = freshHeader(model);
        const entries = new Map<string, Float32Array>();
        for (const [hash, vector] of writable) entries.set(hash, vector);
        const bytes = await writeCacheFile(state, header, entries);
        recordFlush(state.path, 'compact', entries.size, bytes, log, flushLogIntervalMs);
        return;
      }
      // Model matches the on-disk header — APPEND only the incoming batch's
      // bytes (O(batch), not O(cache-size)). See the WRITE PATH doc comment
      // at the top of this file for why the on-disk record format already
      // supports a duplicate-key log without any migration.
      //
      // COPY, never mutate `existing.entries` in place: that Map may be the
      // MEMO's, and a write that fails after an in-place mutation would leave
      // the memo claiming entries that are not on disk (the file's stat is
      // unchanged, so nothing would ever invalidate it). appendCacheEntries
      // installs this merged map as the new memo only after the append lands.
      const merged = new Map<string, Float32Array>(existing.entries);
      let staleBytes = 0;
      for (const [hash, vector] of writable) {
        const prior = existing.entries.get(hash);
        if (prior !== undefined) staleBytes += encodeRecord(hash, prior, state.dim).length;
        merged.set(hash, vector);
      }
      const appendedBytes = await appendCacheEntries(state, existing.header, merged, writable);
      const totalStaleBytes = (staleBytesSinceCompaction.get(state.path) ?? 0) + staleBytes;
      if (totalStaleBytes >= compactionStaleBytesThreshold && compactionStaleBytesThreshold > 0) {
        // Enough superseded records have piled up in the log — reclaim the
        // dead space with one compacting rewrite. Still amortized: this
        // triggers only after `compactionStaleBytesThreshold` bytes of
        // OVERWRITES accumulate, not on every write.
        const compactedBytes = await writeCacheFile(state, existing.header, merged);
        recordFlush(state.path, 'compact', merged.size, compactedBytes, log, flushLogIntervalMs);
      } else {
        staleBytesSinceCompaction.set(state.path, totalStaleBytes);
        recordFlush(state.path, 'append', writable.length, appendedBytes, log, flushLogIntervalMs);
      }
    });
  };

  const put = async (key: EmbeddingCacheKey, vector: Float32Array): Promise<void> => {
    await putMany(
      {
        modelId: key.modelId,
        ...(key.modelRevision === undefined ? {} : { modelRevision: key.modelRevision }),
      },
      [[key.embedTextHash, vector]],
    );
  };

  const getMany = async (
    model: EmbeddingCacheModelKey,
    embedTextHashes: readonly string[],
  ): Promise<ReadonlyMap<string, Float32Array>> => {
    const out = new Map<string, Float32Array>();
    if (embedTextHashes.length === 0) return out;
    const cached = await readCacheFile(state);
    if (cached === null) return out;
    if (cached.header.modelId !== model.modelId) return out;
    if (cached.header.modelRevision !== model.modelRevision) return out;
    for (const hash of embedTextHashes) {
      const hit = cached.entries.get(hash);
      if (hit !== undefined) out.set(hash, hit);
    }
    return out;
  };

  const stats = async (): Promise<{ entries: number; modelId: string | null }> => {
    const cached = await readCacheFile(state);
    return {
      entries: cached?.entries.size ?? 0,
      modelId: cached?.header.modelId ?? null,
    };
  };

  const inspect = async (
    model: EmbeddingCacheModelKey,
  ): Promise<
    | { readonly kind: 'absent' }
    | { readonly kind: 'ready'; readonly entries: number; readonly model: EmbeddingCacheModelKey }
  > => {
    const cached = await readCacheFile(state);
    if (
      cached === null ||
      cached.header.modelId !== model.modelId ||
      cached.header.modelRevision !== model.modelRevision
    ) {
      return { kind: 'absent' };
    }
    return { kind: 'ready', entries: cached.entries.size, model };
  };

  const migrateModel = async (
    from: EmbeddingCacheModelKey,
    to: EmbeddingCacheModelKey,
  ): Promise<'absent' | 'not-applicable' | 'already-current' | 'migrated'> =>
    await withWriteLock(async () => {
      const cached = await readCacheFileUncached(state);
      if (cached === null) return 'absent';
      if (
        cached.header.modelId === to.modelId &&
        cached.header.modelRevision === to.modelRevision
      ) {
        return 'already-current';
      }
      if (
        cached.header.modelId !== from.modelId ||
        cached.header.modelRevision !== from.modelRevision
      ) {
        return 'not-applicable';
      }
      // Copy first. If the new publication fails, the active file remains the
      // old revision and rollback is still byte-for-byte available.
      await mkdir(dirname(rollbackPath), { recursive: true });
      await copyFile(state.path, rollbackPath);
      await writeCacheFile(state, freshHeader(to), new Map(cached.entries));
      return 'migrated';
    });

  const rollbackMigration = async (): Promise<boolean> =>
    await withWriteLock(async () => {
      try {
        const temporary = `${state.path}.rollback-${createRevision()}.tmp`;
        await copyFile(rollbackPath, temporary);
        await rename(temporary, state.path);
        memo.delete(state.path);
        staleBytesSinceCompaction.delete(state.path);
        return true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
    });

  const initialize = async (model: EmbeddingCacheModelKey): Promise<void> => {
    await withWriteLock(async () => {
      const cached = await readCacheFileUncached(state);
      if (
        cached !== null &&
        cached.header.modelId === model.modelId &&
        cached.header.modelRevision === model.modelRevision
      ) {
        return;
      }
      await writeCacheFile(state, freshHeader(model), new Map());
    });
  };

  return {
    get,
    put,
    getMany,
    putMany,
    stats,
    inspect,
    migrateModel,
    rollbackMigration,
    initialize,
  };
};
