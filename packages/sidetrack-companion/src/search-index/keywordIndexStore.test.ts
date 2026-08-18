import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { KEYWORD_POSTING_CAP, createKeywordIndexStore } from './keywordIndexStore.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const makeVault = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'keyword-index-store-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
  return dir;
};

describe('keywordIndexStore', () => {
  sqliteIt('round-trips a page\'s keywords and the reverse posting list', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordIndexStore(vaultRoot);
    try {
      store.upsertPageKeywords('url:https://a.example/', ['rust', 'ownership'], 'llm', 100);
      expect(store.keywordsForPage('url:https://a.example/')).toEqual(['rust', 'ownership']);
      expect(store.pagesForKeyword('rust')).toEqual([
        { pageKey: 'url:https://a.example/', observedAtMs: 100 },
      ]);
    } finally {
      store.close();
    }
  });

  sqliteIt('distinguishes "never processed" (undefined) from "processed, found nothing" ([])', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordIndexStore(vaultRoot);
    try {
      expect(store.keywordsForPage('url:https://never.example/')).toBeUndefined();
      expect(store.hasPage('url:https://never.example/')).toBe(false);

      store.upsertPageKeywords('url:https://empty.example/', [], 'deterministic', 100);
      expect(store.keywordsForPage('url:https://empty.example/')).toEqual([]);
      expect(store.hasPage('url:https://empty.example/')).toBe(true);
    } finally {
      store.close();
    }
  });

  sqliteIt('incremental re-upsert replaces the prior posting set for a page (no accumulation)', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordIndexStore(vaultRoot);
    try {
      store.upsertPageKeywords('url:https://a.example/', ['rust', 'ownership'], 'llm', 100);
      // Content changed — a fresh gist supersedes the old keyword set.
      store.upsertPageKeywords('url:https://a.example/', ['golang', 'goroutines'], 'llm', 200);

      expect(store.keywordsForPage('url:https://a.example/')).toEqual(['golang', 'goroutines']);
      // The OLD keywords must no longer point back at this page — otherwise
      // the index would silently accumulate stale postings forever.
      expect(store.pagesForKeyword('rust')).toEqual([]);
      expect(store.pagesForKeyword('golang').map((r) => r.pageKey)).toEqual([
        'url:https://a.example/',
      ]);
    } finally {
      store.close();
    }
  });

  sqliteIt('removePage withdraws both the reverse row and every posting', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordIndexStore(vaultRoot);
    try {
      store.upsertPageKeywords('url:https://a.example/', ['rust'], 'llm', 100);
      store.removePage('url:https://a.example/');
      expect(store.keywordsForPage('url:https://a.example/')).toBeUndefined();
      expect(store.pagesForKeyword('rust')).toEqual([]);
    } finally {
      store.close();
    }
  });

  sqliteIt('is incremental across many single-page upserts — O(k) per page, not O(corpus) per call', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordIndexStore(vaultRoot);
    try {
      for (let i = 0; i < 50; i += 1) {
        store.upsertPageKeywords(`url:https://p${String(i)}.example/`, ['shared-term', `unique${String(i)}`], 'deterministic', i);
      }
      expect(store.stats().distinctPages).toBe(50);
      expect(store.pagesForKeyword('shared-term').length).toBe(50);
      // A single incremental upsert of one more page only ever touches that
      // page's own postings plus the cap check for its own keywords — proven
      // indirectly by every prior page's data surviving unchanged.
      store.upsertPageKeywords('url:https://p50.example/', ['shared-term'], 'deterministic', 1000);
      expect(store.keywordsForPage('url:https://p0.example/')).toEqual(['shared-term', 'unique0']);
      expect(store.stats().distinctPages).toBe(51);
    } finally {
      store.close();
    }
  });

  sqliteIt('bounds a posting list at KEYWORD_POSTING_CAP, evicting the oldest observation first', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordIndexStore(vaultRoot);
    try {
      for (let i = 0; i < KEYWORD_POSTING_CAP + 10; i += 1) {
        store.upsertPageKeywords(`url:https://p${String(i)}.example/`, ['common'], 'deterministic', i);
      }
      const rows = store.pagesForKeyword('common', KEYWORD_POSTING_CAP + 50);
      expect(rows.length).toBe(KEYWORD_POSTING_CAP);
      // The oldest 10 observations (observedAtMs 0..9) must have been evicted.
      const pageKeys = new Set(rows.map((r) => r.pageKey));
      expect(pageKeys.has('url:https://p0.example/')).toBe(false);
      expect(pageKeys.has(`url:https://p${String(KEYWORD_POSTING_CAP + 9)}.example/`)).toBe(true);
    } finally {
      store.close();
    }
  });

  sqliteIt('pagesForKeyword respects an explicit limit, most-recent-first', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordIndexStore(vaultRoot);
    try {
      for (let i = 0; i < 5; i += 1) {
        store.upsertPageKeywords(`url:https://p${String(i)}.example/`, ['term'], 'llm', i * 10);
      }
      const rows = store.pagesForKeyword('term', 2);
      expect(rows).toEqual([
        { pageKey: 'url:https://p4.example/', observedAtMs: 40 },
        { pageKey: 'url:https://p3.example/', observedAtMs: 30 },
      ]);
    } finally {
      store.close();
    }
  });

  sqliteIt('distinctKeywords lists every distinct keyword alphabetically, deduped across pages', async () => {
    const vaultRoot = await makeVault();
    const store = await createKeywordIndexStore(vaultRoot);
    try {
      store.upsertPageKeywords('url:https://a.example/', ['kubernetes', 'docker'], 'llm', 100);
      store.upsertPageKeywords('url:https://b.example/', ['docker', 'sourdough'], 'llm', 200);
      expect(store.distinctKeywords()).toEqual(['docker', 'kubernetes', 'sourdough']);
    } finally {
      store.close();
    }
  });

  sqliteIt('survives a reopen against the same vault (durable, not in-memory only)', async () => {
    const vaultRoot = await makeVault();
    const first = await createKeywordIndexStore(vaultRoot);
    first.upsertPageKeywords('url:https://a.example/', ['durable'], 'llm', 1);
    first.close();

    const second = await createKeywordIndexStore(vaultRoot);
    try {
      expect(second.keywordsForPage('url:https://a.example/')).toEqual(['durable']);
    } finally {
      second.close();
    }
  });
});
