import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INDEX_DIM, gcEntries, readIndex, upsertEntries, writeIndex } from './indexFile.js';

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
});
