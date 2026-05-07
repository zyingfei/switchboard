import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INDEX_DEFAULT_REPLICA,
  INDEX_DIM,
  INDEX_SCHEMA_CAPABILITIES,
  INDEX_VERSION,
  gcEntries,
  readIndex,
  tombstoneByThread,
  upsertEntries,
  writeIndex,
} from './indexFile.js';

describe('recall index file', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-index-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips entries', async () => {
    const path = join(root, 'index.bin');
    const embedding = new Float32Array(INDEX_DIM);
    embedding[0] = 1;

    await writeIndex(
      path,
      [{ id: 'turn_1', threadId: 'thread_1', capturedAt: '2026-05-03T00:00:00.000Z', embedding }],
      'model',
    );

    const read = await readIndex(path);
    expect(read?.modelId).toBe('model');
    expect(read?.items[0]?.embedding[0]).toBe(1);
  });

  it('returns null on corruption', async () => {
    const path = join(root, 'index.bin');
    await writeFile(path, 'not an index');

    await expect(readIndex(path)).resolves.toBeNull();
  });

  it('upserts by id and reports add/replace counts', async () => {
    const path = join(root, 'index.bin');
    const first = new Float32Array(INDEX_DIM);
    first[0] = 1;
    const replacement = new Float32Array(INDEX_DIM);
    replacement[1] = 1;

    await expect(
      upsertEntries(
        path,
        [{ id: 'turn_1', threadId: 'thread_1', capturedAt: '2026-05-03T00:00:00.000Z', embedding: first }],
        'model',
      ),
    ).resolves.toEqual({ added: 1, replaced: 0 });
    await expect(
      upsertEntries(
        path,
        [
          {
            id: 'turn_1',
            threadId: 'thread_1',
            capturedAt: '2026-05-03T00:00:00.000Z',
            embedding: replacement,
          },
        ],
        'model',
      ),
    ).resolves.toEqual({ added: 0, replaced: 1 });

    const read = await readIndex(path);
    expect(read?.items).toHaveLength(1);
    expect(read?.items[0]?.embedding[1]).toBe(1);
  });

  it('garbage-collects entries outside the valid id set', async () => {
    const path = join(root, 'index.bin');
    const embedding = new Float32Array(INDEX_DIM);
    await writeIndex(
      path,
      [
        { id: 'keep', threadId: 'thread_1', capturedAt: '2026-05-03T00:00:00.000Z', embedding },
        { id: 'drop', threadId: 'thread_2', capturedAt: '2026-05-03T00:00:00.000Z', embedding },
      ],
      'model',
    );

    await expect(gcEntries(path, new Set(['keep']))).resolves.toEqual({ removed: 1 });
    expect((await readIndex(path))?.items.map((item) => item.id)).toEqual(['keep']);
  });

  it('writes the V3 header with schema capabilities + chunk-metadata flag', async () => {
    expect(INDEX_VERSION).toBe(3);
    expect(INDEX_SCHEMA_CAPABILITIES).toEqual([
      'tombstones',
      'replica-id',
      'lamport-clock',
      'chunk-metadata',
    ]);
    const path = join(root, 'index.bin');
    const embedding = new Float32Array(INDEX_DIM);
    await writeIndex(
      path,
      [{ id: 'turn_a', threadId: 'thread_a', capturedAt: '2026-05-03T00:00:00.000Z', embedding }],
      'model',
    );
    const read = await readIndex(path);
    expect(read?.schemaCapabilities).toEqual([
      'tombstones',
      'replica-id',
      'lamport-clock',
      'chunk-metadata',
    ]);
  });

  it('round-trips chunk metadata + modelRevision in the V3 header', async () => {
    const path = join(root, 'index.bin');
    const embedding = new Float32Array(INDEX_DIM);
    embedding[0] = 1;
    await writeIndex(
      path,
      [
        {
          id: 'chunk:bac_test:0:0:abcdef012345',
          threadId: 'thread_test',
          capturedAt: '2026-05-06T18:00:00.000Z',
          embedding,
          replicaId: 'replica-A',
          lamport: 7,
          tombstoned: false,
          metadata: {
            sourceBacId: 'bac_test',
            provider: 'chatgpt',
            threadUrl: 'https://chatgpt.com/c/test',
            title: 'Switchboard',
            role: 'assistant',
            turnOrdinal: 0,
            modelName: 'gpt-5-thinking',
            headingPath: ['1. Plugin / extension behavior'],
            paragraphIndex: 0,
            charStart: 0,
            charEnd: 200,
            textHash: 'a'.repeat(64),
            text: 'chunk body content',
          },
        },
      ],
      'model',
      { modelRevision: 'rev-deadbeef' },
    );
    const read = await readIndex(path);
    expect(read?.modelRevision).toBe('rev-deadbeef');
    expect(read?.chunkSchemaVersion).toBe(1);
    const entry = read?.items[0];
    expect(entry?.metadata?.headingPath).toEqual(['1. Plugin / extension behavior']);
    expect(entry?.metadata?.text).toBe('chunk body content');
    expect(entry?.metadata?.title).toBe('Switchboard');
  });

  it('returns null for a V2-magic file (forces lifecycle to rebuild into V3)', async () => {
    const path = join(root, 'index.bin');
    // Hand-write a V2-shaped file by patching the header version.
    const embedding = new Float32Array(INDEX_DIM);
    await writeIndex(
      path,
      [{ id: 'a', threadId: 'thread', capturedAt: '2026-05-03T00:00:00.000Z', embedding }],
      'model',
    );
    const buffer = await readFile(path);
    const headerLength = buffer.readUInt32LE(0);
    const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8')) as Record<
      string,
      unknown
    >;
    header['version'] = 2;
    const newHeaderBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const newHeaderLen = Buffer.alloc(4);
    newHeaderLen.writeUInt32LE(newHeaderBytes.length, 0);
    await writeFile(
      path,
      Buffer.concat([newHeaderLen, newHeaderBytes, buffer.subarray(4 + headerLength)]),
    );
    expect(await readIndex(path)).toBeNull();
  });

  it('round-trips replicaId, lamport, and tombstoned fields', async () => {
    const path = join(root, 'index.bin');
    const embedding = new Float32Array(INDEX_DIM);
    embedding[0] = 1;
    await writeIndex(
      path,
      [
        {
          id: 'turn_a',
          threadId: 'thread_a',
          capturedAt: '2026-05-03T00:00:00.000Z',
          embedding,
          replicaId: 'replica-A',
          lamport: 42,
          tombstoned: true,
        },
      ],
      'model',
    );
    const read = await readIndex(path);
    const entry = read?.items[0];
    expect(entry?.replicaId).toBe('replica-A');
    expect(entry?.lamport).toBe(42);
    expect(entry?.tombstoned).toBe(true);
  });

  it('upserts default missing CRDT fields and bumps lamport monotonically', async () => {
    const path = join(root, 'index.bin');
    const e1 = new Float32Array(INDEX_DIM);
    e1[0] = 1;
    await upsertEntries(
      path,
      [{ id: 'turn_a', threadId: 'thread_a', capturedAt: '2026-05-03T00:00:00.000Z', embedding: e1 }],
      'model',
    );
    const first = (await readIndex(path))?.items[0];
    expect(first?.replicaId).toBe(INDEX_DEFAULT_REPLICA);
    expect(first?.lamport).toBe(1);
    expect(first?.tombstoned).toBe(false);

    const e2 = new Float32Array(INDEX_DIM);
    e2[1] = 1;
    await upsertEntries(
      path,
      [{ id: 'turn_b', threadId: 'thread_a', capturedAt: '2026-05-03T00:00:00.000Z', embedding: e2 }],
      'model',
    );
    const items = (await readIndex(path))?.items ?? [];
    const turnB = items.find((i) => i.id === 'turn_b');
    expect(turnB?.lamport).toBeGreaterThan(first?.lamport ?? 0);
  });

  it('tombstoneByThread marks every matching entry without removing them', async () => {
    const path = join(root, 'index.bin');
    const embedding = new Float32Array(INDEX_DIM);
    await writeIndex(
      path,
      [
        { id: 'a:1', threadId: 'thread_archived', capturedAt: '2026-05-03T00:00:00.000Z', embedding },
        { id: 'a:2', threadId: 'thread_archived', capturedAt: '2026-05-03T00:00:00.000Z', embedding },
        { id: 'b:1', threadId: 'thread_kept', capturedAt: '2026-05-03T00:00:00.000Z', embedding },
      ],
      'model',
    );
    await expect(tombstoneByThread(path, 'thread_archived')).resolves.toEqual({ tombstoned: 2 });
    const items = (await readIndex(path))?.items ?? [];
    // All three rows survive on disk (OR-Set), but the archived
    // ones are flagged.
    expect(items).toHaveLength(3);
    const archived = items.filter((i) => i.threadId === 'thread_archived');
    expect(archived.every((i) => i.tombstoned === true)).toBe(true);
    const kept = items.filter((i) => i.threadId === 'thread_kept');
    expect(kept[0]?.tombstoned).toBe(false);
  });

  it('treats V1 (legacy) index files as missing so the lifecycle rebuilds them', async () => {
    const path = join(root, 'index.bin');
    // Hand-build a V1 binary: header has version=1, no CRDT fields
    // per record. The V2 reader must reject and return null.
    const embedding = new Float32Array(INDEX_DIM);
    const headerJson = JSON.stringify({
      magic: 'SIDETRACK_RECALL_INDEX',
      version: 1,
      dim: INDEX_DIM,
      count: 1,
      modelId: 'legacy',
    });
    const headerBytes = Buffer.from(headerJson, 'utf8');
    const headerLen = Buffer.alloc(4);
    headerLen.writeUInt32LE(headerBytes.length, 0);
    const idBytes = Buffer.from('turn_1', 'utf8');
    const idLen = Buffer.alloc(4);
    idLen.writeUInt32LE(idBytes.length, 0);
    const tidBytes = Buffer.from('thread_1', 'utf8');
    const tidLen = Buffer.alloc(4);
    tidLen.writeUInt32LE(tidBytes.length, 0);
    const tsBytes = Buffer.from('2026-05-03T00:00:00.000Z', 'utf8');
    const tsLen = Buffer.alloc(4);
    tsLen.writeUInt32LE(tsBytes.length, 0);
    const embedBuf = Buffer.alloc(INDEX_DIM * 4);
    for (let i = 0; i < INDEX_DIM; i += 1) {
      embedBuf.writeFloatLE(embedding[i] ?? 0, i * 4);
    }
    await writeFile(
      path,
      Buffer.concat([headerLen, headerBytes, idLen, idBytes, tidLen, tidBytes, tsLen, tsBytes, embedBuf]),
    );
    await expect(readIndex(path)).resolves.toBeNull();
  });
});
