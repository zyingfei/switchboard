import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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
// Append-only with periodic compaction (TODO follow-up).
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

/** Test seam — the memo is process-global, so tests that write the file
 *  directly (rather than through this module) must be able to drop it. */
export const __resetEmbeddingCacheMemo = (): void => {
  memo.clear();
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
    while (cursor.offset < buffer.length) {
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

const writeCacheFile = async (
  state: CacheState,
  header: CacheHeader,
  entries: Map<string, Float32Array>,
): Promise<void> => {
  await mkdir(dirname(state.path), { recursive: true });
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32LE(headerBytes.length, 0);
  const records: Buffer[] = [];
  for (const [hash, vec] of entries) {
    const vecBytes = Buffer.alloc(state.dim * 4);
    for (let i = 0; i < state.dim; i += 1) {
      vecBytes.writeFloatLE(vec[i] ?? 0, i * 4);
    }
    records.push(Buffer.concat([encodeString(hash), vecBytes]));
  }
  const tempPath = join(dirname(state.path), `.embed-cache.${createRevision()}.tmp`);
  await writeFile(tempPath, Buffer.concat([headerLen, headerBytes, ...records]));
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
      // Model changed (or no file yet) — start clean. Serving vectors from a
      // different model would be worse than a cold cache.
      //
      // COPY, never mutate `existing.entries` in place: that Map may be the
      // MEMO's, and a write that fails after an in-place mutation would leave the
      // memo claiming entries that are not on disk (the file's stat is unchanged,
      // so nothing would ever invalidate it). writeCacheFile installs this fresh
      // map as the new memo on success.
      const entries = modelMatches
        ? new Map<string, Float32Array>(existing.entries)
        : new Map<string, Float32Array>();
      const header = modelMatches ? existing.header : freshHeader(model);
      for (const [hash, vector] of writable) entries.set(hash, vector);
      await writeCacheFile(state, header, entries);
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
