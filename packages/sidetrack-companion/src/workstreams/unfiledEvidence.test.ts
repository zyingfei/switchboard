import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_UNFILED_POPULATION_CAP,
  UNFILED_POPULATION_CAP_ENV,
  resolveUnfiledPopulationCap,
  suggestionEvidenceFromUnfiled,
  type UnfiledEvidenceItem,
} from './unfiledEvidence.js';

describe('resolveUnfiledPopulationCap', () => {
  it('defaults when the env var is absent or garbage', () => {
    delete process.env[UNFILED_POPULATION_CAP_ENV];
    expect(resolveUnfiledPopulationCap()).toBe(DEFAULT_UNFILED_POPULATION_CAP);
    process.env[UNFILED_POPULATION_CAP_ENV] = 'nope';
    expect(resolveUnfiledPopulationCap()).toBe(DEFAULT_UNFILED_POPULATION_CAP);
    delete process.env[UNFILED_POPULATION_CAP_ENV];
  });

  it('accepts a valid positive integer', () => {
    process.env[UNFILED_POPULATION_CAP_ENV] = '250';
    expect(resolveUnfiledPopulationCap()).toBe(250);
    delete process.env[UNFILED_POPULATION_CAP_ENV];
  });
});

describe('suggestionEvidenceFromUnfiled', () => {
  const items: UnfiledEvidenceItem[] = [
    { canonicalUrl: 'https://old.example/', title: 'Old', firstSeenAtMs: 100 },
    { canonicalUrl: 'https://newest.example/', title: 'Newest', firstSeenAtMs: 900 },
    { canonicalUrl: 'https://mid.example/', title: 'Mid', firstSeenAtMs: 500 },
  ];

  it('sorts most-recent-first and respects the limit', () => {
    const result = suggestionEvidenceFromUnfiled(items, {}, 2);
    expect(result.map((e) => e.id)).toEqual(['https://newest.example/', 'https://mid.example/']);
  });

  it('joins concept ids and keywords when provided', () => {
    const result = suggestionEvidenceFromUnfiled(
      items,
      {
        conceptIdsForUrl: (url) => (url === 'https://newest.example/' ? ['concept-a'] : undefined),
        keywordsForUrl: (url) => (url === 'https://newest.example/' ? ['rust'] : undefined),
      },
      10,
    );
    const newest = result.find((e) => e.id === 'https://newest.example/');
    expect(newest?.conceptIds).toEqual(['concept-a']);
    expect(newest?.keywords).toEqual(['rust']);
    const old = result.find((e) => e.id === 'https://old.example/');
    expect(old?.conceptIds).toBeUndefined();
  });

  it('defaults to an empty embedding when no embeddingForUrl join is supplied', () => {
    const result = suggestionEvidenceFromUnfiled(items, {}, 10);
    for (const item of result) {
      expect(item.embedding.length).toBe(0);
    }
  });

  it('uses a real embedding when embeddingForUrl is supplied', () => {
    const vec = Float32Array.from([1, 0, 0]);
    const result = suggestionEvidenceFromUnfiled(
      items,
      { embeddingForUrl: (url) => (url === 'https://newest.example/' ? vec : undefined) },
      10,
    );
    const newest = result.find((e) => e.id === 'https://newest.example/');
    expect(Array.from(newest?.embedding ?? [])).toEqual([1, 0, 0]);
  });
});
