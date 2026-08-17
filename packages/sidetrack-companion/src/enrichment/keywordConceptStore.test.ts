import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createKeywordConceptStore } from './keywordConceptStore.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const makeVault = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'keyword-concept-store-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
  return dir;
};

const vec = (...values: readonly number[]): Float32Array => Float32Array.from(values);

describe('keywordConceptStore', () => {
  sqliteIt('mints a new concept for the first keyword', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordConceptStore(vaultRoot);
    try {
      const outcome = store.assignKeyword('kubernetes', vec(1, 0, 0), 100);
      expect(outcome.created).toBe(true);
      expect(store.conceptForKeyword('kubernetes')).toBe(outcome.conceptId);
    } finally {
      store.close();
    }
  });

  sqliteIt('joins near-duplicate keywords ("k8s" / "kubernetes") into the SAME concept', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordConceptStore(vaultRoot);
    try {
      const first = store.assignKeyword('kubernetes', vec(1, 0, 0), 100, 0.9);
      const second = store.assignKeyword('k8s', vec(0.98, 0.2, 0), 200, 0.9);
      expect(second.created).toBe(false);
      expect(second.conceptId).toBe(first.conceptId);
    } finally {
      store.close();
    }
  });

  sqliteIt('mints a SEPARATE concept for an unrelated keyword', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordConceptStore(vaultRoot);
    try {
      const first = store.assignKeyword('kubernetes', vec(1, 0, 0), 100, 0.9);
      const second = store.assignKeyword('sourdough', vec(0, 1, 0), 200, 0.9);
      expect(second.created).toBe(true);
      expect(second.conceptId).not.toBe(first.conceptId);
    } finally {
      store.close();
    }
  });

  sqliteIt('is idempotent — reassigning an already-assigned keyword does not double-fold the centroid', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordConceptStore(vaultRoot);
    try {
      const first = store.assignKeyword('kubernetes', vec(1, 0, 0), 100);
      const before = store.allCentroids().find((c) => c.conceptId === first.conceptId);
      const again = store.assignKeyword('kubernetes', vec(0, 0, 1), 200); // different vector, must be ignored
      const after = store.allCentroids().find((c) => c.conceptId === first.conceptId);
      expect(again.conceptId).toBe(first.conceptId);
      expect(again.created).toBe(false);
      expect(after?.memberCount).toBe(before?.memberCount);
      expect(Array.from(after?.centroid ?? [])).toEqual(Array.from(before?.centroid ?? []));
    } finally {
      store.close();
    }
  });

  sqliteIt('concept-id resolution is STABLE across a store reopen (concept stability)', async () => {
    const vaultRoot = await makeVault();
    const first = await createKeywordConceptStore(vaultRoot);
    const outcome = first.assignKeyword('kubernetes', vec(1, 0, 0), 100, 0.9);
    first.close();

    const second = await createKeywordConceptStore(vaultRoot);
    try {
      expect(second.conceptForKeyword('kubernetes')).toBe(outcome.conceptId);
      // A near-duplicate keyword introduced AFTER reopen must still join the
      // SAME concept — the centroid persisted correctly, not just the id.
      const rejoin = second.assignKeyword('k8s', vec(0.97, 0.24, 0), 300, 0.9);
      expect(rejoin.conceptId).toBe(outcome.conceptId);
      expect(rejoin.created).toBe(false);
    } finally {
      second.close();
    }
  });

  sqliteIt('conceptIdsForKeywords dedupes and skips never-assigned keywords', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordConceptStore(vaultRoot);
    try {
      const a = store.assignKeyword('kubernetes', vec(1, 0, 0), 100, 0.9);
      store.assignKeyword('k8s', vec(0.98, 0.2, 0), 200, 0.9);
      const ids = store.conceptIdsForKeywords(['kubernetes', 'k8s', 'never-seen']);
      expect(ids).toEqual([a.conceptId]);
    } finally {
      store.close();
    }
  });

  sqliteIt('reports stats reflecting distinct keywords vs distinct concepts', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordConceptStore(vaultRoot);
    try {
      store.assignKeyword('kubernetes', vec(1, 0, 0), 100, 0.9);
      store.assignKeyword('k8s', vec(0.98, 0.2, 0), 200, 0.9);
      store.assignKeyword('sourdough', vec(0, 1, 0), 300, 0.9);
      const stats = store.stats();
      expect(stats.distinctKeywords).toBe(3);
      expect(stats.distinctConcepts).toBe(2);
    } finally {
      store.close();
    }
  });
});
