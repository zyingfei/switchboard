import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import type { ChunkMetadata, IndexEntry } from './ranker.js';

// Binary format V3:
//   u32 headerLength, UTF-8 JSON header
//     { magic, version, dim, count, modelId, modelRevision,
//       chunkSchemaVersion,
//       schemaCapabilities: ['tombstones', 'replica-id', 'lamport-clock', 'chunk-metadata'] }
//   repeated count records:
//     u32 idLength + id UTF-8                       (chunkId)
//     u32 threadIdLength + threadId UTF-8
//     u32 capturedAtLength + capturedAt UTF-8
//     u32 replicaIdLength + replicaId UTF-8         ('' = default 'local')
//     u32 lamport (little-endian)                   (0 = unset)
//     u8 tombstoned (0 or 1)
//     u32 metadataLength + metadata UTF-8 JSON      (V3; '' = no metadata)
//     dim * float32 little-endian embedding values
//
// The index is a rebuildable cache under _BAC/recall; corruption returns null.
//
// V1 / V2 indexes return null from the reader so the lifecycle's
// stale-check rebuilds them into V3 — same auto-upgrade pattern as
// V1 → V2. The CRDT-readiness fields (replicaId / lamport /
// tombstoned) carry forward unchanged; V3's only addition is the
// per-entry chunk metadata blob (heading breadcrumb, source title,
// snippet, etc.) so query results can be returned without an extra
// event-log read.

const MAGIC = 'SIDETRACK_RECALL_INDEX';
const VERSION = 3;
const CHUNK_SCHEMA_VERSION = 1;
const DIM = 384;
const DEFAULT_REPLICA = 'local';
const SCHEMA_CAPABILITIES: readonly string[] = [
  'tombstones',
  'replica-id',
  'lamport-clock',
  'chunk-metadata',
];

export interface IndexFile {
  readonly modelId: string;
  // V3: pinned model revision so a HF revision change marks the
  // index stale. Optional in the type for forward-compat with future
  // header bumps that might restructure model identity.
  readonly modelRevision?: string;
  readonly chunkSchemaVersion?: number;
  readonly items: readonly IndexEntry[];
  // Echoed from the on-disk header so callers (the lifecycle, tests)
  // can detect schema-capability changes without re-reading the file.
  readonly schemaCapabilities?: readonly string[];
}

const encodeString = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
};

const readString = (buffer: Buffer, cursor: { offset: number }): string => {
  const length = buffer.readUInt32LE(cursor.offset);
  cursor.offset += 4;
  const value = buffer.subarray(cursor.offset, cursor.offset + length).toString('utf8');
  cursor.offset += length;
  return value;
};

export const readIndex = async (path: string): Promise<IndexFile | null> => {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    return null;
  }
  try {
    const cursor = { offset: 0 };
    const headerLength = buffer.readUInt32LE(cursor.offset);
    cursor.offset += 4;
    const header = JSON.parse(
      buffer.subarray(cursor.offset, cursor.offset + headerLength).toString('utf8'),
    ) as {
      readonly magic?: unknown;
      readonly version?: unknown;
      readonly dim?: unknown;
      readonly count?: unknown;
      readonly modelId?: unknown;
      readonly modelRevision?: unknown;
      readonly chunkSchemaVersion?: unknown;
      readonly schemaCapabilities?: unknown;
    };
    cursor.offset += headerLength;
    // V1 / V2 files come back as null so the lifecycle's stale-check
    // triggers an auto-rebuild into the V3 format. We deliberately
    // do not attempt a backward-compat read of older versions — the
    // rebuild path is cheap, deterministic, and produces a cleaner
    // chunk-metadata-aware file.
    if (
      header.magic !== MAGIC ||
      header.version !== VERSION ||
      header.dim !== DIM ||
      typeof header.count !== 'number' ||
      typeof header.modelId !== 'string'
    ) {
      return null;
    }
    const items: IndexEntry[] = [];
    for (let index = 0; index < header.count; index += 1) {
      const id = readString(buffer, cursor);
      const threadId = readString(buffer, cursor);
      const capturedAt = readString(buffer, cursor);
      const replicaIdRaw = readString(buffer, cursor);
      const lamport = buffer.readUInt32LE(cursor.offset);
      cursor.offset += 4;
      const tombstoned = buffer.readUInt8(cursor.offset) === 1;
      cursor.offset += 1;
      const metadataRaw = readString(buffer, cursor);
      let metadata: ChunkMetadata | undefined;
      if (metadataRaw.length > 0) {
        try {
          metadata = JSON.parse(metadataRaw) as ChunkMetadata;
        } catch {
          metadata = undefined;
        }
      }
      const embedding = new Float32Array(DIM);
      for (let dim = 0; dim < DIM; dim += 1) {
        embedding[dim] = buffer.readFloatLE(cursor.offset);
        cursor.offset += 4;
      }
      items.push({
        id,
        threadId,
        capturedAt,
        embedding,
        replicaId: replicaIdRaw.length > 0 ? replicaIdRaw : DEFAULT_REPLICA,
        lamport,
        tombstoned,
        ...(metadata === undefined ? {} : { metadata }),
      });
    }
    const capabilities = Array.isArray(header.schemaCapabilities)
      ? header.schemaCapabilities.filter((v): v is string => typeof v === 'string')
      : SCHEMA_CAPABILITIES;
    return {
      modelId: header.modelId,
      ...(typeof header.modelRevision === 'string'
        ? { modelRevision: header.modelRevision }
        : {}),
      ...(typeof header.chunkSchemaVersion === 'number'
        ? { chunkSchemaVersion: header.chunkSchemaVersion }
        : {}),
      items,
      schemaCapabilities: capabilities,
    };
  } catch {
    return null;
  }
};

// Canonical on-disk ordering: `(threadId, id, replicaId, lamport)`.
// Two replicas (or two consecutive runs of the same replica) that
// merge to the same logical entry set produce byte-identical files,
// which is what makes the index a deterministic projection of the
// merged event log. The id format `<threadId>:<ordinal>` already
// encodes the per-thread sequence so sorting on id within a thread
// recovers ordinal order without parsing.
const sortEntriesCanonically = (items: readonly IndexEntry[]): IndexEntry[] => {
  const compareString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...items].sort((left, right) => {
    const byThread = compareString(left.threadId, right.threadId);
    if (byThread !== 0) return byThread;
    const byId = compareString(left.id, right.id);
    if (byId !== 0) return byId;
    const byReplica = compareString(
      left.replicaId ?? DEFAULT_REPLICA,
      right.replicaId ?? DEFAULT_REPLICA,
    );
    if (byReplica !== 0) return byReplica;
    return (left.lamport ?? 0) - (right.lamport ?? 0);
  });
};

export interface WriteIndexOptions {
  readonly modelRevision?: string;
}

// Stable JSON encoding for chunk metadata so byte-equal output holds
// across rebuilds. Keys are sorted; arrays preserve order.
const stableJsonStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
};

const encodeMetadata = (metadata: ChunkMetadata | undefined): Buffer =>
  encodeString(metadata === undefined ? '' : stableJsonStringify(metadata));

export const writeIndex = async (
  path: string,
  items: readonly IndexEntry[],
  modelId: string,
  options: WriteIndexOptions = {},
): Promise<void> => {
  const sorted = sortEntriesCanonically(items);
  const headerBytes = Buffer.from(
    JSON.stringify({
      magic: MAGIC,
      version: VERSION,
      dim: DIM,
      count: sorted.length,
      modelId,
      ...(options.modelRevision === undefined ? {} : { modelRevision: options.modelRevision }),
      chunkSchemaVersion: CHUNK_SCHEMA_VERSION,
      schemaCapabilities: SCHEMA_CAPABILITIES,
    }),
    'utf8',
  );
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32LE(headerBytes.length, 0);
  const records = sorted.map((item) => {
    const embedding = Buffer.alloc(DIM * 4);
    for (let index = 0; index < DIM; index += 1) {
      embedding.writeFloatLE(item.embedding[index] ?? 0, index * 4);
    }
    const replicaIdBytes = encodeString(item.replicaId ?? DEFAULT_REPLICA);
    const lamportBytes = Buffer.alloc(4);
    lamportBytes.writeUInt32LE(item.lamport ?? 0, 0);
    const tombstoneByte = Buffer.alloc(1);
    tombstoneByte.writeUInt8(item.tombstoned === true ? 1 : 0, 0);
    return Buffer.concat([
      encodeString(item.id),
      encodeString(item.threadId),
      encodeString(item.capturedAt),
      replicaIdBytes,
      lamportBytes,
      tombstoneByte,
      encodeMetadata(item.metadata),
      embedding,
    ]);
  });
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, Buffer.concat([headerLength, headerBytes, ...records]));
  await rename(tempPath, path);
};

export const appendEntry = async (
  path: string,
  entry: IndexEntry,
  modelId: string,
  options: WriteIndexOptions = {},
): Promise<void> => {
  await upsertEntries(path, [entry], modelId, options);
};

// CRDT-aware merge: for any (id, replicaId) pair, the entry with the
// highest lamport wins. In single-replica deployments this collapses
// to "newer write replaces older" because replicaId is constant.
const winnerOf = (left: IndexEntry, right: IndexEntry): IndexEntry => {
  const leftLamport = left.lamport ?? 0;
  const rightLamport = right.lamport ?? 0;
  if (rightLamport > leftLamport) return right;
  if (leftLamport > rightLamport) return left;
  // Tie-break on replicaId so the order is deterministic across
  // replicas that might both bump lamport without coordination.
  return (right.replicaId ?? DEFAULT_REPLICA) > (left.replicaId ?? DEFAULT_REPLICA) ? right : left;
};

export const upsertEntries = async (
  path: string,
  entries: readonly IndexEntry[],
  modelId: string,
  options: WriteIndexOptions = {},
): Promise<{ readonly added: number; readonly replaced: number }> => {
  const existing = await readIndex(path);
  // Bucket by (id, replicaId) so a write from another replica with
  // the same id doesn't clobber the local replica's entry on merge.
  const keyOf = (entry: IndexEntry): string =>
    `${entry.id} ${entry.replicaId ?? DEFAULT_REPLICA}`;
  const byKey = new Map((existing?.items ?? []).map((item) => [keyOf(item), item]));
  let added = 0;
  let replaced = 0;
  // Track the highest lamport this writer has seen across all known
  // entries so the next write monotonically advances. Single-replica
  // deployments don't strictly need this (the rebuild path emits
  // densely-numbered lamports), but it costs almost nothing and
  // makes incremental writes (`/v1/recall/index`) interleave cleanly
  // with rebuilds.
  let nextLamport = 1;
  for (const item of byKey.values()) {
    nextLamport = Math.max(nextLamport, (item.lamport ?? 0) + 1);
  }
  for (const entry of entries) {
    const key = keyOf(entry);
    const stamped: IndexEntry = {
      ...entry,
      replicaId: entry.replicaId ?? DEFAULT_REPLICA,
      lamport: entry.lamport ?? nextLamport,
      tombstoned: entry.tombstoned ?? false,
    };
    nextLamport = (stamped.lamport ?? nextLamport) + 1;
    const prior = byKey.get(key);
    if (prior === undefined) {
      added += 1;
    } else {
      replaced += 1;
    }
    byKey.set(key, prior === undefined ? stamped : winnerOf(prior, stamped));
  }
  // Preserve the existing modelRevision unless the caller overrides
  // it, so an incremental upsert doesn't accidentally clear the
  // revision pin from the header.
  const revision =
    options.modelRevision ?? existing?.modelRevision ?? undefined;
  await writeIndex(
    path,
    [...byKey.values()],
    modelId,
    revision === undefined ? {} : { modelRevision: revision },
  );
  return { added, replaced };
};

export const gcEntries = async (
  path: string,
  validIds: ReadonlySet<string>,
): Promise<{ readonly removed: number }> => {
  const existing = await readIndex(path);
  if (existing === null) {
    return { removed: 0 };
  }
  const kept = existing.items.filter((item) => validIds.has(item.id));
  await writeIndex(
    path,
    kept,
    existing.modelId,
    existing.modelRevision === undefined ? {} : { modelRevision: existing.modelRevision },
  );
  return { removed: existing.items.length - kept.length };
};

// Mark every entry whose threadId matches as tombstoned (OR-Set
// semantics: the row stays on disk so a future replica merging in an
// older non-tombstoned write doesn't resurrect it). Used by the
// archive route so the recall query stops returning results from
// archived threads without forcing a full rebuild.
export const tombstoneByThread = async (
  path: string,
  threadId: string,
): Promise<{ readonly tombstoned: number }> => {
  const existing = await readIndex(path);
  if (existing === null) return { tombstoned: 0 };
  let nextLamport = 1;
  for (const item of existing.items) {
    nextLamport = Math.max(nextLamport, (item.lamport ?? 0) + 1);
  }
  let count = 0;
  const updated: IndexEntry[] = existing.items.map((item) => {
    if (item.threadId !== threadId || item.tombstoned === true) return item;
    count += 1;
    const stamped: IndexEntry = {
      ...item,
      tombstoned: true,
      lamport: nextLamport,
      replicaId: item.replicaId ?? DEFAULT_REPLICA,
    };
    nextLamport += 1;
    return stamped;
  });
  await writeIndex(
    path,
    updated,
    existing.modelId,
    existing.modelRevision === undefined ? {} : { modelRevision: existing.modelRevision },
  );
  return { tombstoned: count };
};

export const INDEX_DIM = DIM;
export const INDEX_VERSION = VERSION;
export const INDEX_CHUNK_SCHEMA_VERSION = CHUNK_SCHEMA_VERSION;
export const INDEX_SCHEMA_CAPABILITIES = SCHEMA_CAPABILITIES;
export const INDEX_DEFAULT_REPLICA = DEFAULT_REPLICA;
