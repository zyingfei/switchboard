import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSimilarityHnswStore } from './visitSimilarityHnsw.js';

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const unit = (values: readonly number[]): readonly number[] => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
};

const createRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const randomUnitVectors = (
  count: number,
  dimension: number,
): ReadonlyArray<readonly number[]> => {
  const rng = createRng(0x5eed);
  return Array.from({ length: count }, () =>
    unit(Array.from({ length: dimension }, () => rng() * 2 - 1)),
  );
};

describe('SimilarityHnswStore', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-hnsw-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('returns top-k neighbors matching brute-force cosine for a small corpus', async () => {
    const vectors = randomUnitVectors(100, 64);
    const store = createSimilarityHnswStore();
    await store.ensureLoaded(vaultRoot, 64);
    for (let i = 0; i < vectors.length; i += 1) {
      await store.insertOrUpdate(`vid-${String(i)}`, vectors[i]!);
    }

    const queryId = 'vid-17';
    const actual = await store.queryTopK(queryId, 50);
    const expected = vectors
      .map((embedding, index) => ({
        id: `vid-${String(index)}`,
        similarity: cosine(vectors[17]!, embedding),
      }))
      .filter((row) => row.id !== queryId)
      .sort((left, right) => {
        if (right.similarity !== left.similarity) return right.similarity - left.similarity;
        return left.id.localeCompare(right.id);
      })
      .slice(0, 50)
      .map((row) => row.id);

    expect(actual.map((row) => row.neighborVisitId)).toEqual(expected);
  });

  it('persists and reopens the index with stable query results', async () => {
    const vectors = randomUnitVectors(20, 16);
    const first = createSimilarityHnswStore();
    await first.ensureLoaded(vaultRoot, 16);
    for (let i = 0; i < vectors.length; i += 1) {
      await first.insertOrUpdate(`vid-${String(i)}`, vectors[i]!);
    }
    const before = await first.queryTopK('vid-3', 8);
    await first.persist();
    await first.close();

    const second = createSimilarityHnswStore();
    await second.ensureLoaded(vaultRoot, 16);
    expect(await second.queryTopK('vid-3', 8)).toEqual(before);
  });

  it('keeps the previous published version loadable when pointer rename fails', async () => {
    const first = createSimilarityHnswStore();
    await first.ensureLoaded(vaultRoot, 4);
    await first.insertOrUpdate('query', [1, 0, 0, 0]);
    await first.insertOrUpdate('old-neighbor', [0.99, 0.01, 0, 0]);
    const before = await first.queryTopK('query', 1);
    await first.persist();
    await first.close();

    const failing = createSimilarityHnswStore({
      renameFile: async (oldPath, newPath) => {
        if (String(newPath).endsWith('visit-similarity-hnsw.current')) {
          throw new Error('simulated pointer rename crash');
        }
        await rename(oldPath, newPath);
      },
    });
    await failing.ensureLoaded(vaultRoot, 4);
    await failing.insertOrUpdate('new-neighbor', [0.999, 0.001, 0, 0]);
    await expect(failing.persist()).rejects.toThrow('simulated pointer rename crash');
    await failing.close();

    const recovered = createSimilarityHnswStore();
    await recovered.ensureLoaded(vaultRoot, 4);

    expect(await recovered.queryTopK('query', 1)).toEqual(before);
  });

  it('insertOrUpdate replaces a visit embedding', async () => {
    const store = createSimilarityHnswStore();
    await store.ensureLoaded(vaultRoot, 4);
    await store.insertOrUpdate('x', [1, 0, 0, 0]);
    await store.insertOrUpdate('near-a', [0.99, 0.01, 0, 0]);
    await store.insertOrUpdate('near-b', [0, 0.99, 0.01, 0]);

    expect((await store.queryTopK('x', 1))[0]?.neighborVisitId).toBe('near-a');

    await store.insertOrUpdate('x', [0, 1, 0, 0]);

    expect((await store.queryTopK('x', 1))[0]?.neighborVisitId).toBe('near-b');
  });

  it('delete removes a visit from query results', async () => {
    const store = createSimilarityHnswStore();
    await store.ensureLoaded(vaultRoot, 3);
    const vectors = [
      [1, 0, 0],
      [0.9, 0.1, 0],
      [0.8, 0.2, 0],
      [0.7, 0.3, 0],
      [0.6, 0.4, 0],
      [0.5, 0.5, 0],
    ] as const;
    for (let i = 0; i < vectors.length; i += 1) {
      await store.insertOrUpdate(`vid-${String(i)}`, vectors[i]!);
    }

    await store.delete('vid-2');
    const results = await store.queryTopK('vid-0', 5);

    expect(results).toHaveLength(4);
    expect(results.map((row) => row.neighborVisitId)).not.toContain('vid-2');
  });
});
