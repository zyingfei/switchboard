import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import type { IndexEntry } from './ranker.js';

// Binary format:
//   u32 headerLength, UTF-8 JSON header { magic, version, dim, count, modelId }
//   repeated count records:
//     u32 idLength + id UTF-8
//     u32 threadIdLength + threadId UTF-8
//     u32 capturedAtLength + capturedAt UTF-8
//     dim * float32 little-endian embedding values
// The index is a rebuildable cache under _BAC/recall; corruption returns null.
const MAGIC = 'SIDETRACK_RECALL_INDEX';
const VERSION = 1;
const DIM = 384;

export interface IndexFile {
  readonly modelId: string;
  readonly items: readonly IndexEntry[];
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
    };
    cursor.offset += headerLength;
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
      const embedding = new Float32Array(DIM);
      for (let dim = 0; dim < DIM; dim += 1) {
        embedding[dim] = buffer.readFloatLE(cursor.offset);
        cursor.offset += 4;
      }
      items.push({ id, threadId, capturedAt, embedding });
    }
    return { modelId: header.modelId, items };
  } catch {
    return null;
  }
};

export const writeIndex = async (
  path: string,
  items: readonly IndexEntry[],
  modelId: string,
): Promise<void> => {
  const headerBytes = Buffer.from(
    JSON.stringify({ magic: MAGIC, version: VERSION, dim: DIM, count: items.length, modelId }),
    'utf8',
  );
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32LE(headerBytes.length, 0);
  const records = items.map((item) => {
    const embedding = Buffer.alloc(DIM * 4);
    for (let index = 0; index < DIM; index += 1) {
      embedding.writeFloatLE(item.embedding[index] ?? 0, index * 4);
    }
    return Buffer.concat([
      encodeString(item.id),
      encodeString(item.threadId),
      encodeString(item.capturedAt),
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
): Promise<void> => {
  await upsertEntries(path, [entry], modelId);
};

export const upsertEntries = async (
  path: string,
  entries: readonly IndexEntry[],
  modelId: string,
): Promise<{ readonly added: number; readonly replaced: number }> => {
  const existing = await readIndex(path);
  const byId = new Map((existing?.items ?? []).map((item) => [item.id, item]));
  let added = 0;
  let replaced = 0;
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      replaced += 1;
    } else {
      added += 1;
    }
    byId.set(entry.id, entry);
  }
  await writeIndex(path, [...byId.values()], modelId);
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
  await writeIndex(path, kept, existing.modelId);
  return { removed: existing.items.length - kept.length };
};

export const INDEX_DIM = DIM;
