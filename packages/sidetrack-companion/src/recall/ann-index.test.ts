import { mkdtemp } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  buildAnnIndex,
  createAnnIndexCache,
  queryFlatTopK,
  readAnnIndexFile,
  type UsearchLoader,
} from './ann-index.js';
import { writeIndex } from './indexFile.js';
import type { IndexEntry } from './ranker.js';

const entry = (id: string, embedding: readonly number[]): IndexEntry => ({
  id,
  threadId: `thread-${id}`,
  capturedAt: '2026-05-08T10:00:00.000Z',
  embedding: new Float32Array(embedding),
  tombstoned: false,
});

const loader = (): UsearchLoader => async () => {
  class FakeIndex {
    private readonly rows: { key: bigint; vector: Float32Array }[] = [];

    constructor(_config: unknown) {}

    add(keys: bigint | readonly bigint[] | BigUint64Array, vectors: Float32Array): void {
      const keyRows =
        typeof keys === 'bigint' ? [keys] : Array.from(keys as readonly bigint[]);
      const dimensions = vectors.length / keyRows.length;
      keyRows.forEach((key, index) => {
        this.rows.push({
          key,
          vector: vectors.slice(index * dimensions, (index + 1) * dimensions),
        });
      });
    }

    search(vectors: Float32Array, k: number): { keys: BigUint64Array; distances: Float32Array } {
      const ranked = this.rows
        .map((row) => {
          let dot = 0;
          for (let index = 0; index < Math.min(row.vector.length, vectors.length); index += 1) {
            dot += (row.vector[index] ?? 0) * (vectors[index] ?? 0);
          }
          return { key: row.key, distance: 1 - dot };
        })
        .sort((left, right) => left.distance - right.distance)
        .slice(0, k);
      return {
        keys: new BigUint64Array(ranked.map((row) => row.key)),
        distances: new Float32Array(ranked.map((row) => row.distance)),
      };
    }

    size(): number {
      return this.rows.length;
    }
  }

  return {
    Index: FakeIndex,
    MetricKind: { Cos: 'cos' },
    ScalarKind: { F32: 'f32' },
  };
};

describe('recall ANN index', () => {
  it('returns a top-K result set matching the flat top-K for deterministic vectors', async () => {
    const items = [
      entry('a', [1, 0, 0]),
      entry('b', [0.9, 0.1, 0]),
      entry('c', [0, 1, 0]),
      entry('d', [0, 0, 1]),
    ];
    const query = new Float32Array([1, 0, 0]);
    const flat = queryFlatTopK(query, items, { limit: 2 }).map((row) => row.item.id);
    const ann = await buildAnnIndex({
      revisionId: 'ann-test',
      items,
      loader: loader(),
    });

    expect(ann.backend).toBe('hnsw');
    expect(ann.query(query, { limit: 2 }).map((row) => row.item.id)).toEqual(flat);
  });

  it('falls back to flat scan and logs a warning when the HNSW backend is unavailable', async () => {
    const warnings: string[] = [];
    const items = [entry('a', [1, 0]), entry('b', [0, 1])];
    const ann = await buildAnnIndex({
      revisionId: 'ann-fallback',
      items,
      loader: async () => {
        throw new Error('native module missing');
      },
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(ann.backend).toBe('flat');
    expect(warnings).toEqual([
      '[recall-ann] HNSW unavailable for revision ann-fallback; falling back to flat scan: native module missing',
    ]);
    expect(ann.query(new Float32Array([0, 1]), { limit: 1 })[0]?.item.id).toBe('b');
  });

  it('caches index-file builds per file revision and rebuilds when index.bin changes', async () => {
    const root = await mkdtemp('/tmp/sidetrack-ann-');
    const path = `${root}/index.bin`;
    const cache = createAnnIndexCache();

    await writeIndex(path, [entry('a', [1, 0])], 'test-model');
    const first = await readAnnIndexFile(path, cache, { loader: loader() });
    const second = await readAnnIndexFile(path, cache, { loader: loader() });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeIndex(path, [entry('b', [0, 1])], 'test-model');
    const third = await readAnnIndexFile(path, cache, { loader: loader() });

    expect(first?.vectorIndex).toBe(second?.vectorIndex);
    expect(third?.revisionId).not.toBe(first?.revisionId);
    expect(third?.vectorIndex).not.toBe(first?.vectorIndex);
  });
});
