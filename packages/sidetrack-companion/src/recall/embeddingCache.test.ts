import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEmbeddingCache } from './embeddingCache.js';

describe('embedding cache', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'sidetrack-embed-cache-'));
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  const makeVector = (seed: number): Float32Array => {
    const v = new Float32Array(384);
    v[0] = seed;
    return v;
  };

  it('round-trips a put + get for the same key', async () => {
    const cache = createEmbeddingCache(vault);
    await cache.put(
      { modelId: 'Xenova/multilingual-e5-small', modelRevision: 'rev-1', embedTextHash: 'h1' },
      makeVector(7),
    );
    const got = await cache.get({
      modelId: 'Xenova/multilingual-e5-small',
      modelRevision: 'rev-1',
      embedTextHash: 'h1',
    });
    expect(got).not.toBeNull();
    expect(got![0]).toBe(7);
  });

  it('returns null for a missing key', async () => {
    const cache = createEmbeddingCache(vault);
    const got = await cache.get({
      modelId: 'Xenova/multilingual-e5-small',
      modelRevision: 'rev-1',
      embedTextHash: 'unknown',
    });
    expect(got).toBeNull();
  });

  it('drops the cache when modelId changes', async () => {
    const cache = createEmbeddingCache(vault);
    await cache.put({ modelId: 'A', modelRevision: 'r1', embedTextHash: 'h1' }, makeVector(1));
    // Different modelId — older entries are no longer addressable.
    const got = await cache.get({
      modelId: 'B',
      modelRevision: 'r1',
      embedTextHash: 'h1',
    });
    expect(got).toBeNull();
  });

  it('drops the cache when modelRevision changes', async () => {
    const cache = createEmbeddingCache(vault);
    await cache.put({ modelId: 'A', modelRevision: 'r1', embedTextHash: 'h1' }, makeVector(1));
    const got = await cache.get({
      modelId: 'A',
      modelRevision: 'r2',
      embedTextHash: 'h1',
    });
    expect(got).toBeNull();
  });

  it('stats() reports entry count + modelId after writes', async () => {
    const cache = createEmbeddingCache(vault);
    await cache.put({ modelId: 'A', embedTextHash: 'h1' }, makeVector(1));
    await cache.put({ modelId: 'A', embedTextHash: 'h2' }, makeVector(2));
    const s = await cache.stats();
    expect(s.entries).toBe(2);
    expect(s.modelId).toBe('A');
  });

  it('persists across reads (file-based)', async () => {
    const a = createEmbeddingCache(vault);
    await a.put({ modelId: 'A', embedTextHash: 'h1' }, makeVector(42));
    // Fresh cache instance reads the same file.
    const b = createEmbeddingCache(vault);
    const got = await b.get({ modelId: 'A', embedTextHash: 'h1' });
    expect(got).not.toBeNull();
    expect(got![0]).toBe(42);
  });
});
