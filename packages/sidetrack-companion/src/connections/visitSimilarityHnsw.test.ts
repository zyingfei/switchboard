import { mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const randomUnitVectors = (count: number, dimension: number): ReadonlyArray<readonly number[]> => {
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

  it('round-trips canonical model and corpus revision provenance', async () => {
    const identity = {
      dimension: 4,
      modelId: 'model-a',
      modelRevision: 'model-rev-a',
      vectorCorpusRevision: 'corpus-rev-a',
    } as const;
    const first = await createSimilarityHnswStore().ensureLoaded(vaultRoot, identity);
    await first.insertOrUpdate('visit-a', [1, 0, 0, 0]);
    await first.persist();
    await first.close();

    const reopened = await createSimilarityHnswStore().ensureLoaded(vaultRoot, identity);
    expect(reopened.vectorIdentity?.()).toEqual(identity);
    expect(await reopened.embedding('visit-a')).toEqual([1, 0, 0, 0]);
  });

  it('accepts a schema-v1 compatibility index once and upgrades its sidecar', async () => {
    const legacy = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    await legacy.insertOrUpdate('visit-a', [1, 0, 0, 0]);
    await legacy.persist();
    await legacy.close();
    const base = join(vaultRoot, '_BAC', 'connections', 'visit-similarity-hnsw');
    const sidecarPath = `${base}.v1.json`;
    const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')) as Record<string, unknown>;
    sidecar['schemaVersion'] = 1;
    delete sidecar['modelId'];
    delete sidecar['modelRevision'];
    delete sidecar['vectorCorpusRevision'];
    await writeFile(sidecarPath, `${JSON.stringify(sidecar)}\n`, 'utf8');

    const identity = {
      dimension: 4,
      modelId: 'model-a',
      modelRevision: 'model-rev-a',
      vectorCorpusRevision: 'corpus-rev-a',
    } as const;
    const migrated = await createSimilarityHnswStore().ensureLoaded(vaultRoot, identity);
    expect(await migrated.embedding('visit-a')).toEqual([1, 0, 0, 0]);
    await migrated.persist();
    const upgraded = JSON.parse(await readFile(`${base}.v2.json`, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(upgraded).toMatchObject({
      schemaVersion: 2,
      modelId: identity.modelId,
      modelRevision: identity.modelRevision,
      vectorCorpusRevision: identity.vectorCorpusRevision,
    });
  });

  it('never serves a mismatched corpus revision and leaves the prior pointer rollbackable', async () => {
    const originalIdentity = {
      dimension: 4,
      modelId: 'model-a',
      modelRevision: 'model-rev-a',
      vectorCorpusRevision: 'corpus-rev-a',
    } as const;
    const original = await createSimilarityHnswStore().ensureLoaded(vaultRoot, originalIdentity);
    await original.insertOrUpdate('visit-a', [1, 0, 0, 0]);
    await original.persist();
    await original.close();

    const incompatible = await createSimilarityHnswStore().ensureLoaded(vaultRoot, {
      ...originalIdentity,
      vectorCorpusRevision: 'corpus-rev-b',
    });
    expect(incompatible.recoveredFromCorruption()).toBe(true);
    expect(incompatible.elementCount()).toBe(0);
    await incompatible.close();

    const rolledBack = await createSimilarityHnswStore().ensureLoaded(vaultRoot, originalIdentity);
    expect(await rolledBack.embedding('visit-a')).toEqual([1, 0, 0, 0]);
  });

  it('returns top-k neighbors matching brute-force cosine for a small corpus', async () => {
    const vectors = randomUnitVectors(100, 64);
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 64);
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
    const first = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 16);
    for (let i = 0; i < vectors.length; i += 1) {
      await first.insertOrUpdate(`vid-${String(i)}`, vectors[i]!);
    }
    const before = await first.queryTopK('vid-3', 8);
    await first.persist();
    await first.close();

    const second = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 16);
    expect(await second.queryTopK('vid-3', 8)).toEqual(before);
  });

  it('keeps the previous published version loadable when pointer rename fails', async () => {
    const first = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    await first.insertOrUpdate('query', [1, 0, 0, 0]);
    await first.insertOrUpdate('old-neighbor', [0.99, 0.01, 0, 0]);
    const before = await first.queryTopK('query', 1);
    await first.persist();
    await first.close();

    const failing = await createSimilarityHnswStore({
      renameFile: async (oldPath, newPath) => {
        if (String(newPath).endsWith('visit-similarity-hnsw.current')) {
          throw new Error('simulated pointer rename crash');
        }
        await rename(oldPath, newPath);
      },
    }).ensureLoaded(vaultRoot, 4);
    await failing.insertOrUpdate('new-neighbor', [0.999, 0.001, 0, 0]);
    await expect(failing.persist()).rejects.toThrow('simulated pointer rename crash');
    await failing.close();

    const recovered = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);

    expect(await recovered.queryTopK('query', 1)).toEqual(before);
  });

  it('insertOrUpdate replaces a visit embedding', async () => {
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    await store.insertOrUpdate('x', [1, 0, 0, 0]);
    await store.insertOrUpdate('near-a', [0.99, 0.01, 0, 0]);
    await store.insertOrUpdate('near-b', [0, 0.99, 0.01, 0]);

    expect((await store.queryTopK('x', 1))[0]?.neighborVisitId).toBe('near-a');

    await store.insertOrUpdate('x', [0, 1, 0, 0]);

    expect((await store.queryTopK('x', 1))[0]?.neighborVisitId).toBe('near-b');
  });

  it('delete removes a visit from query results', async () => {
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 3);
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

// ---------------------------------------------------------------------------
// Delta-gate (2026-08-21, F9 follow-up): persist() used to rewrite the whole
// 89.43MB artifact on every graph-touching drain because `dirty` is set
// unconditionally by insertOrUpdate/delete, even when the caller
// (connectionsMaterializer.ts's buildHnswVisitSimilarity) redundantly
// re-inserts already-unchanged embeddings for every carried-forward visit.
// These tests exercise the content-signature gate added to persist() that
// catches exactly that no-op case.
// ---------------------------------------------------------------------------
describe('persist() delta-gate (2026-08-21 F9 follow-up)', () => {
  let vaultRoot: string;
  let basePath: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-hnsw-gate-'));
    basePath = join(vaultRoot, '_BAC', 'connections', 'visit-similarity-hnsw');
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const pointerVersion = async (): Promise<string> =>
    (await readFile(`${basePath}.current`, 'utf8')).trim();

  const pathExists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };

  it('skips the rewrite when a redundant mutation reproduces already-published content', async () => {
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 8);
    const vectors = randomUnitVectors(30, 8);
    for (let i = 0; i < vectors.length; i += 1) {
      await store.insertOrUpdate(`vid-${String(i)}`, vectors[i]!);
    }
    await store.persist();
    expect(await pointerVersion()).toBe('v1');
    expect(await pathExists(`${basePath}.v2.bin`)).toBe(false);

    // Simulate the real-world root cause: the materializer's
    // carryForwardSimilarity re-inserts every carried-forward visit's
    // ALREADY-PUBLISHED embedding unconditionally, which sets `dirty` but
    // changes nothing publishable.
    for (let i = 0; i < vectors.length; i += 1) {
      await store.insertOrUpdate(`vid-${String(i)}`, vectors[i]!);
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.persist();

    // Assert on the spy BEFORE mockRestore() -- restoring clears recorded
    // call history (same semantics as Jest/vitest mockReset), so checking
    // afterward would always report "not called" regardless of behavior.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[hnsw.write] skipped'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('[hnsw.write] written'));
    warn.mockRestore();

    // No new version was minted -- the pointer, and every versioned file,
    // stay exactly where the first persist() left them.
    expect(await pointerVersion()).toBe('v1');
    expect(await pathExists(`${basePath}.v2.bin`)).toBe(false);
    expect(await pathExists(`${basePath}.v2.json`)).toBe(false);
  });

  it('writes a new version and correct content when an existing embedding actually changes', async () => {
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    await store.insertOrUpdate('x', [1, 0, 0, 0]);
    await store.insertOrUpdate('near-a', [0.99, 0.01, 0, 0]);
    await store.insertOrUpdate('near-b', [0, 0.99, 0.01, 0]);
    await store.persist();
    expect(await pointerVersion()).toBe('v1');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Re-embed 'x' with a genuinely different vector -- same visitId, same
    // label, different content. The signature must NOT treat this as a
    // no-op (an id/label-only signature would miss it).
    await store.insertOrUpdate('x', [0, 1, 0, 0]);
    await store.persist();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[hnsw.write] written'));
    warn.mockRestore();

    expect(await pointerVersion()).toBe('v2');
    expect(await pathExists(`${basePath}.v2.bin`)).toBe(true);

    // Correctness: reopening reflects the new embedding and new neighbor
    // ranking, not the stale one.
    const reopened = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    expect(await reopened.embedding('x')).toEqual([0, 1, 0, 0]);
    expect((await reopened.queryTopK('x', 1))[0]?.neighborVisitId).toBe('near-b');
  });

  it('writes a new version when a visit is added, even if all prior visits are unchanged', async () => {
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    await store.insertOrUpdate('a', [1, 0, 0, 0]);
    await store.insertOrUpdate('b', [0, 1, 0, 0]);
    await store.persist();
    expect(await pointerVersion()).toBe('v1');

    // Redundant re-insert of the unchanged pair PLUS one genuinely new visit
    // -- the shape of a real graph-touching drain that adds one visit.
    await store.insertOrUpdate('a', [1, 0, 0, 0]);
    await store.insertOrUpdate('b', [0, 1, 0, 0]);
    await store.insertOrUpdate('c', [0, 0, 1, 0]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.persist();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[hnsw.write] written'));
    warn.mockRestore();

    expect(await pointerVersion()).toBe('v2');

    const reopened = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    expect(await reopened.embedding('c')).toEqual([0, 0, 1, 0]);
  });

  it('writes a new version when a visit is deleted, even if remaining visits are unchanged', async () => {
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    await store.insertOrUpdate('a', [1, 0, 0, 0]);
    await store.insertOrUpdate('b', [0, 1, 0, 0]);
    await store.persist();
    expect(await pointerVersion()).toBe('v1');

    await store.delete('b');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.persist();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[hnsw.write] written'));
    warn.mockRestore();

    expect(await pointerVersion()).toBe('v2');

    const reopened = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    expect(await reopened.embedding('b')).toBeNull();
  });

  it('crash-safety: a missing signature file forces a rewrite even when content is unchanged', async () => {
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    await store.insertOrUpdate('a', [1, 0, 0, 0]);
    await store.persist();
    expect(await pointerVersion()).toBe('v1');
    expect(await pathExists(`${basePath}.sig`)).toBe(true);

    // Simulate a crash between "artifact fully published" and "signature
    // written" (persist()'s own doc comment: the sig write is strictly the
    // LAST step) by deleting the sig file that should have recorded v1's
    // content.
    await unlink(`${basePath}.sig`);

    // A redundant, logically no-op mutation -- if the gate trusted a
    // missing signature as "still matches", this would wrongly skip.
    await store.insertOrUpdate('a', [1, 0, 0, 0]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.persist();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[hnsw.write] written'));
    warn.mockRestore();

    expect(await pointerVersion()).toBe('v2');
    expect(await pathExists(`${basePath}.sig`)).toBe(true);
  });

  it('crash-safety: a stale/corrupt signature file forces a rewrite even when content is unchanged', async () => {
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 4);
    await store.insertOrUpdate('a', [1, 0, 0, 0]);
    await store.persist();
    expect(await pointerVersion()).toBe('v1');

    // Simulate a torn/partial write leaving garbage behind instead of a
    // clean 64-hex-char sha256 digest.
    await writeFile(`${basePath}.sig`, 'not-a-real-signature', 'utf8');

    await store.insertOrUpdate('a', [1, 0, 0, 0]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.persist();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[hnsw.write] written'));
    warn.mockRestore();

    expect(await pointerVersion()).toBe('v2');
  });

  it('measured: skip rate for a realistic carry-forward drain on a mid-size corpus', async () => {
    const CORPUS_SIZE = 500;
    const store = await createSimilarityHnswStore().ensureLoaded(vaultRoot, 32);
    const vectors = randomUnitVectors(CORPUS_SIZE, 32);
    for (let i = 0; i < vectors.length; i += 1) {
      await store.insertOrUpdate(`vid-${String(i)}`, vectors[i]!);
    }
    await store.persist();
    const bytesOnDisk = (await stat(`${basePath}.v1.bin`)).size;

    // Ten consecutive graph-touching drains, each re-inserting the FULL
    // unchanged corpus (the real carryForwardSimilarity shape) plus zero net
    // new content -- the exact steady-state pattern the F9 investigation
    // measured as an unconditional 89.43MB rewrite per drain.
    let skipped = 0;
    let written = 0;
    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < vectors.length; i += 1) {
        await store.insertOrUpdate(`vid-${String(i)}`, vectors[i]!);
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await store.persist();
      const calls = warn.mock.calls.map((call) => String(call[0]));
      warn.mockRestore();
      if (calls.some((line) => line.includes('[hnsw.write] skipped'))) skipped += 1;
      if (calls.some((line) => line.includes('[hnsw.write] written'))) written += 1;
    }

    expect(skipped).toBe(10);
    expect(written).toBe(0);
    expect(await pointerVersion()).toBe('v1');
    // Documents the measured saving for the landing note: 10 drains x the
    // on-disk artifact size that would otherwise have been rewritten every
    // single time.
    // eslint-disable-next-line no-console
    console.info(
      `[measured] ${String(CORPUS_SIZE)}-vector corpus, 10 redundant carry-forward drains: ` +
        `${String(skipped)}/10 skipped, 0 rewrites, ${String(bytesOnDisk)} bytes/rewrite avoided x10`,
    );
  });
});
