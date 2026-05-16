import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

export interface EmbeddingCache {
  readonly get: (key: EmbeddingCacheKey) => Promise<Float32Array | null>;
  readonly put: (key: EmbeddingCacheKey, vector: Float32Array) => Promise<void>;
  readonly stats: () => Promise<{ readonly entries: number; readonly modelId: string | null }>;
}

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

const readCacheFile = async (
  state: CacheState,
): Promise<{
  readonly header: CacheHeader;
  readonly entries: Map<string, Float32Array>;
} | null> => {
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
};

export const createEmbeddingCache = (vaultRoot: string, dim = 384): EmbeddingCache => {
  const state: CacheState = {
    path: join(vaultRoot, '_BAC', 'recall', 'embed-cache.bin'),
    dim,
  };

  const get = async (key: EmbeddingCacheKey): Promise<Float32Array | null> => {
    const cached = await readCacheFile(state);
    if (cached === null) return null;
    if (cached.header.modelId !== key.modelId) return null;
    if (cached.header.modelRevision !== key.modelRevision) return null;
    return cached.entries.get(key.embedTextHash) ?? null;
  };

  const put = async (key: EmbeddingCacheKey, vector: Float32Array): Promise<void> => {
    if (vector.length !== state.dim) return;
    const existing = await readCacheFile(state);
    let entries: Map<string, Float32Array>;
    let header: CacheHeader;
    if (existing === null) {
      entries = new Map();
      header = {
        magic: MAGIC,
        version: VERSION,
        modelId: key.modelId,
        ...(key.modelRevision === undefined ? {} : { modelRevision: key.modelRevision }),
        dim: state.dim,
      };
    } else if (
      existing.header.modelId !== key.modelId ||
      existing.header.modelRevision !== key.modelRevision
    ) {
      // Model changed — drop the old cache.
      entries = new Map();
      header = {
        magic: MAGIC,
        version: VERSION,
        modelId: key.modelId,
        ...(key.modelRevision === undefined ? {} : { modelRevision: key.modelRevision }),
        dim: state.dim,
      };
    } else {
      entries = existing.entries;
      header = existing.header;
    }
    entries.set(key.embedTextHash, vector);
    await writeCacheFile(state, header, entries);
  };

  const stats = async (): Promise<{ entries: number; modelId: string | null }> => {
    const cached = await readCacheFile(state);
    return {
      entries: cached?.entries.size ?? 0,
      modelId: cached?.header.modelId ?? null,
    };
  };

  return { get, put, stats };
};
