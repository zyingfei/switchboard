import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSuggestionCandidateStore, type SuggestionCandidateStore } from './suggestionCandidateStore.js';
import {
  DEFAULT_KEYWORD_CLUSTER_WEIGHT,
  KEYWORD_CLUSTER_WEIGHT_ENV,
  hybridSimilarity,
  recomputeSuggestionCandidates,
  resolveKeywordClusterWeight,
  type SuggestionEvidenceItem,
} from './splitSuggestionEngine.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
  delete process.env[KEYWORD_CLUSTER_WEIGHT_ENV];
});

const makeStore = async (): Promise<SuggestionCandidateStore> => {
  const dir = await mkdtemp(join(tmpdir(), 'split-suggestion-hybrid-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
  return createSuggestionCandidateStore(dir);
};

const basis = (index: number, dims = 8): Float32Array => {
  const v = new Float32Array(dims);
  v[index] = 1;
  return v;
};

const noVector = (): Float32Array => new Float32Array(0);

describe('resolveKeywordClusterWeight — env parsing', () => {
  it('defaults when the env var is absent', () => {
    delete process.env[KEYWORD_CLUSTER_WEIGHT_ENV];
    expect(resolveKeywordClusterWeight()).toBe(DEFAULT_KEYWORD_CLUSTER_WEIGHT);
  });

  it('accepts a valid in-range value', () => {
    process.env[KEYWORD_CLUSTER_WEIGHT_ENV] = '0.6';
    expect(resolveKeywordClusterWeight()).toBe(0.6);
  });

  it('falls back to the default for an out-of-range or garbage value', () => {
    process.env[KEYWORD_CLUSTER_WEIGHT_ENV] = '1.5';
    expect(resolveKeywordClusterWeight()).toBe(DEFAULT_KEYWORD_CLUSTER_WEIGHT);
    process.env[KEYWORD_CLUSTER_WEIGHT_ENV] = 'not-a-number';
    expect(resolveKeywordClusterWeight()).toBe(DEFAULT_KEYWORD_CLUSTER_WEIGHT);
  });
});

describe('hybridSimilarity — the formula', () => {
  it('behaves exactly like plain cosine when neither item carries conceptIds', () => {
    const left: SuggestionEvidenceItem = { id: 'a', embedding: basis(0) };
    const right: SuggestionEvidenceItem = { id: 'b', embedding: basis(0) };
    expect(hybridSimilarity(left, right, 0.9)).toBeCloseTo(1, 5);
    const orthogonal: SuggestionEvidenceItem = { id: 'c', embedding: basis(1) };
    expect(hybridSimilarity(left, orthogonal, 0.9)).toBeCloseTo(0, 5);
  });

  it('falls through to pure concept-Jaccard when embeddings are absent/zero (zero vector coverage)', () => {
    const left: SuggestionEvidenceItem = { id: 'a', embedding: noVector(), conceptIds: ['c1', 'c2'] };
    const right: SuggestionEvidenceItem = { id: 'b', embedding: noVector(), conceptIds: ['c1', 'c2'] };
    expect(hybridSimilarity(left, right)).toBe(1);
    const disjoint: SuggestionEvidenceItem = { id: 'c', embedding: noVector(), conceptIds: ['c3'] };
    expect(hybridSimilarity(left, disjoint)).toBe(0);
  });

  it('blends cosine and concept-Jaccard when both are usable', () => {
    const left: SuggestionEvidenceItem = { id: 'a', embedding: basis(0), conceptIds: ['c1'] };
    const right: SuggestionEvidenceItem = { id: 'b', embedding: basis(1), conceptIds: ['c1'] };
    // cosine=0 (orthogonal), conceptJaccard=1 (identical) — weight 0.5 gives 0.5.
    expect(hybridSimilarity(left, right, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('returns 0 when neither embeddings nor concept-ids are usable', () => {
    const left: SuggestionEvidenceItem = { id: 'a', embedding: noVector() };
    const right: SuggestionEvidenceItem = { id: 'b', embedding: noVector() };
    expect(hybridSimilarity(left, right)).toBe(0);
  });
});

describe('recomputeSuggestionCandidates — hybrid distance at zero vector coverage', () => {
  sqliteIt('splits 6 pages into 2 concept-keyword groups with NO embeddings at all', async () => {
    const store = await makeStore();
    try {
      const groupA: SuggestionEvidenceItem[] = Array.from({ length: 3 }, (_, i) => ({
        id: `a-${i}`,
        embedding: noVector(),
        conceptIds: ['concept-rust', 'concept-systems'],
        keywords: ['rust', 'ownership'],
      }));
      const groupB: SuggestionEvidenceItem[] = Array.from({ length: 3 }, (_, i) => ({
        id: `b-${i}`,
        embedding: noVector(),
        conceptIds: ['concept-baking', 'concept-sourdough'],
        keywords: ['sourdough', 'fermentation'],
      }));
      const evidence = [...groupA, ...groupB];

      const result = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-zero-vec',
        kind: 'split',
        evidence,
        revisionId: 'rev-1',
        options: {
          cosineThreshold: 0.5,
          minSamples: 2,
          minClusterMembers: 3,
          stabilityMinConsecutive: 1,
          minEvidenceToAttempt: 5,
        },
      });

      expect(result.recomputed).toBe(true);
      expect(result.newlyEmitted.length).toBe(2);
      const memberSets = result.newlyEmitted.map((c) => [...c.memberIds].sort());
      expect(memberSets).toContainEqual(['a-0', 'a-1', 'a-2']);
      expect(memberSets).toContainEqual(['b-0', 'b-1', 'b-2']);
    } finally {
      store.close();
    }
  });

  sqliteIt('does NOT split a single coherent concept group (negative control)', async () => {
    const store = await makeStore();
    try {
      const evidence: SuggestionEvidenceItem[] = Array.from({ length: 6 }, (_, i) => ({
        id: `p-${i}`,
        embedding: noVector(),
        conceptIds: ['concept-rust'],
      }));
      const result = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-coherent',
        kind: 'split',
        evidence,
        revisionId: 'rev-1',
        options: {
          cosineThreshold: 0.5,
          minSamples: 2,
          minClusterMembers: 3,
          stabilityMinConsecutive: 1,
          minEvidenceToAttempt: 5,
        },
      });
      // One qualifying cluster (everything), which is BELOW the 'split'
      // kind's minQualifyingClusters=2 — a legitimately cohesive workstream
      // must not fire a split suggestion.
      expect(result.newlyEmitted.length).toBe(0);
    } finally {
      store.close();
    }
  });

  sqliteIt('prefers top shared RAW keywords for cluster naming when present', async () => {
    const store = await makeStore();
    try {
      const evidence: SuggestionEvidenceItem[] = Array.from({ length: 3 }, (_, i) => ({
        id: `k-${i}`,
        embedding: noVector(),
        conceptIds: ['concept-rust'],
        keywords: ['rust', 'ownership'],
        title: `unrelated title words page ${i}`,
      }));
      const result = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-naming',
        kind: 'new-category',
        evidence,
        revisionId: 'rev-1',
        options: {
          cosineThreshold: 0.5,
          minSamples: 2,
          minClusterMembers: 3,
          stabilityMinConsecutive: 1,
          minEvidenceToAttempt: 3,
        },
      });
      expect(result.newlyEmitted.length).toBe(1);
      const name = result.newlyEmitted[0]?.structuralName ?? '';
      expect(name).toContain('rust');
      expect(name).toContain('ownership');
      expect(name).not.toContain('unrelated');
    } finally {
      store.close();
    }
  });
});
