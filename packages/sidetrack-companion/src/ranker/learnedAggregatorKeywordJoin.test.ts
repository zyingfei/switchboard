import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createKeywordConceptStore } from '../enrichment/keywordConceptStore.js';
import { createKeywordIndexStore } from '../search-index/keywordIndexStore.js';
import {
  createAggregatorKeywordConceptLookup,
  withKeywordConceptIds,
} from './learnedAggregatorKeywordJoin.js';
import type { AggregatorVisitObservation } from './learnedAggregatorStats.js';

// Same SQLite-availability skip idiom as keywordIndexStore.test.ts /
// keywordConceptStore.test.ts (this module is a thin join over both).
const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const makeVault = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'aggregator-keyword-join-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
  return dir;
};

const vec = (...values: readonly number[]): Float32Array => Float32Array.from(values);

describe('createAggregatorKeywordConceptLookup', () => {
  sqliteIt('resolves a url: page to its keywords\' concept ids', async () => {
    const vaultRoot = await makeVault();
    const keywordIndex = await createKeywordIndexStore(vaultRoot);
    const concepts = await createKeywordConceptStore(vaultRoot);
    try {
      concepts.assignKeyword('kubernetes', vec(1, 0, 0), 100);
      keywordIndex.upsertPageKeywords(
        'url:https://a.example/post',
        ['kubernetes'],
        'llm',
        200,
      );
    } finally {
      keywordIndex.close();
      concepts.close();
    }

    const lookup = await createAggregatorKeywordConceptLookup(vaultRoot);
    try {
      expect(lookup.conceptIdsForUrl('https://a.example/post')).toEqual(['concept-1']);
    } finally {
      lookup.close();
    }
  });

  sqliteIt('returns undefined (not []) for a page never processed by the keyword index — "no data", not "coherent"', async () => {
    const vaultRoot = await makeVault();
    const lookup = await createAggregatorKeywordConceptLookup(vaultRoot);
    try {
      expect(lookup.conceptIdsForUrl('https://never-seen.example/page')).toBeUndefined();
    } finally {
      lookup.close();
    }
  });

  sqliteIt('returns undefined for a page whose keywords have no concept assignment yet', async () => {
    const vaultRoot = await makeVault();
    const keywordIndex = await createKeywordIndexStore(vaultRoot);
    try {
      // Processed by the keyword layer, but the concept-assignment pass
      // (keywordConceptStore) has not run for this keyword yet.
      keywordIndex.upsertPageKeywords('url:https://a.example/post', ['unassigned-term'], 'llm', 100);
    } finally {
      keywordIndex.close();
    }

    const lookup = await createAggregatorKeywordConceptLookup(vaultRoot);
    try {
      expect(lookup.conceptIdsForUrl('https://a.example/post')).toBeUndefined();
    } finally {
      lookup.close();
    }
  });
});

describe('withKeywordConceptIds', () => {
  const observations: readonly AggregatorVisitObservation[] = [
    { canonicalUrl: 'https://a.example/tagged', observedAtMs: 1_000 },
    { canonicalUrl: 'https://a.example/untagged', observedAtMs: 2_000 },
    // Already carries keywordConceptIds — the lookup must not override it.
    { canonicalUrl: 'https://a.example/preset', observedAtMs: 3_000, keywordConceptIds: ['concept-preset'] },
  ];

  const stubLookup = {
    conceptIdsForUrl: (canonicalUrl: string): readonly string[] | undefined =>
      canonicalUrl === 'https://a.example/tagged' ? ['concept-1', 'concept-2'] : undefined,
    close: (): void => {},
  };

  it('attaches keywordConceptIds only where the lookup has data', () => {
    const result = withKeywordConceptIds(observations, stubLookup);
    expect(result[0]?.keywordConceptIds).toEqual(['concept-1', 'concept-2']);
    expect(result[1]?.keywordConceptIds).toBeUndefined();
  });

  it('never overrides an observation that already carries keywordConceptIds', () => {
    const result = withKeywordConceptIds(observations, stubLookup);
    expect(result[2]?.keywordConceptIds).toEqual(['concept-preset']);
  });

  it('is pure — returns the SAME reference for an observation the lookup has no data for', () => {
    const result = withKeywordConceptIds(observations, stubLookup);
    expect(result[1]).toBe(observations[1]);
  });

  it('never mutates the input array or its elements', () => {
    const before = JSON.stringify(observations);
    withKeywordConceptIds(observations, stubLookup);
    expect(JSON.stringify(observations)).toBe(before);
  });
});
