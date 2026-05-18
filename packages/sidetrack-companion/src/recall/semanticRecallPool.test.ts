import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSemanticRecallPool,
  expandSemanticRecallCandidates,
  getOrBuildSemanticRecallPool,
  readSemanticRecallPool,
  SEMANTIC_RECALL_POOL_ENV,
  semanticRecallPoolEnabled,
  semanticRecallPoolSignature,
} from './semanticRecallPool.js';

// Two well-separated clusters: A* ~ [1,0], B* ~ [0,1].
const VEC: Record<string, readonly number[]> = {
  'https://x/a1': [1, 0.02],
  'https://x/a2': [1, 0.0],
  'https://x/a3': [0.99, 0.03],
  'https://x/b1': [0.02, 1],
  'https://x/b2': [0.0, 1],
  'https://x/b3': [0.03, 0.99],
};
const items = Object.keys(VEC).map((u) => ({ canonicalUrl: u, text: u }));
const embed = (texts: readonly string[]): Promise<readonly Float32Array[]> =>
  Promise.resolve(
    texts.map((t) => {
      const u = t.replace(/^query: /, '');
      return Float32Array.from(VEC[u] ?? [0, 0]);
    }),
  );

describe('semanticRecallPoolEnabled', () => {
  const ENV = SEMANTIC_RECALL_POOL_ENV;
  afterEach(() => delete process.env[ENV]);
  it('defaults ON; off only via off/false/0/none', () => {
    delete process.env[ENV];
    expect(semanticRecallPoolEnabled()).toBe(true);
    for (const v of ['off', 'FALSE', '0', 'None']) {
      process.env[ENV] = v;
      expect(semanticRecallPoolEnabled()).toBe(false);
    }
    process.env[ENV] = '1';
    expect(semanticRecallPoolEnabled()).toBe(true);
  });
});

describe('buildSemanticRecallPool', () => {
  it('clusters the two groups and records nearest neighbours', async () => {
    const pool = await buildSemanticRecallPool({ items, embed, modelId: 'e5-test' });
    expect(pool.entryCount).toBe(6);
    expect(pool.clusterCount).toBe(2);
    const a1 = pool.byUrl['https://x/a1'];
    expect(a1).toBeDefined();
    // a1's neighbours are the other A's, not the B's.
    expect(a1!.neighbors.map((n) => n.canonicalUrl).sort()).toEqual([
      'https://x/a2',
      'https://x/a3',
    ]);
    expect(pool.byUrl['https://x/a2']!.clusterId).toBe(a1!.clusterId);
    expect(pool.byUrl['https://x/b1']!.clusterId).not.toBe(a1!.clusterId);
  });

  it('signature is stable for same inputs, differs on text change', () => {
    const s1 = semanticRecallPoolSignature(items, 'e5-test');
    const s2 = semanticRecallPoolSignature(items, 'e5-test');
    const s3 = semanticRecallPoolSignature(
      [...items, { canonicalUrl: 'https://x/c', text: 'new' }],
      'e5-test',
    );
    expect(s1).toBe(s2);
    expect(s3).not.toBe(s1);
  });

  it('degenerate (<2 items) → empty pool, no throw', async () => {
    const pool = await buildSemanticRecallPool({
      items: [{ canonicalUrl: 'https://x/only', text: 'x' }],
      embed,
      modelId: 'e5-test',
    });
    expect(pool.entryCount).toBe(1);
    expect(pool.clusterCount).toBe(0);
  });
});

describe('expandSemanticRecallCandidates (read-only)', () => {
  it('expands an anchor to its cluster co-members + neighbours, excluding anchors', async () => {
    const pool = await buildSemanticRecallPool({ items, embed, modelId: 'e5-test' });
    const hits = expandSemanticRecallCandidates(pool, ['https://x/a1'], { limit: 10 });
    const urls = hits.map((h) => h.canonicalUrl);
    expect(urls).not.toContain('https://x/a1'); // anchor excluded
    expect(urls).toEqual(expect.arrayContaining(['https://x/a2', 'https://x/a3']));
    expect(urls).not.toContain('https://x/b1'); // different cluster, not a neighbour
    expect(hits.every((h) => h.via === 'cluster' || h.via === 'neighbor')).toBe(true);
  });
  it('null pool → empty (graceful)', () => {
    expect(expandSemanticRecallCandidates(null, ['https://x/a1'])).toEqual([]);
  });
});

describe('getOrBuildSemanticRecallPool (lazy + cached, offline-safe)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('builds, persists, and reuses on signature match; offline keeps last good', async () => {
    dir = await mkdtemp(join(tmpdir(), 'srp-'));
    expect(await readSemanticRecallPool(dir)).toBeNull();
    const built = await getOrBuildSemanticRecallPool(dir, { items, embed, modelId: 'e5-test' });
    expect(built?.entryCount).toBe(6);
    const reread = await readSemanticRecallPool(dir);
    expect(reread?.signature).toBe(built?.signature);
    // Same signature ⇒ cache hit (embed that would throw is never called).
    const failEmbed: typeof embed = () => Promise.reject(new Error('offline'));
    const cached = await getOrBuildSemanticRecallPool(dir, {
      items,
      embed: failEmbed,
      modelId: 'e5-test',
    });
    expect(cached?.signature).toBe(built?.signature);
    // Changed inputs + failing embed ⇒ keep last good, no throw.
    const stillGood = await getOrBuildSemanticRecallPool(dir, {
      items: [...items, { canonicalUrl: 'https://x/c', text: 'c' }],
      embed: failEmbed,
      modelId: 'e5-test',
    });
    expect(stillGood?.signature).toBe(built?.signature);
  });
});
