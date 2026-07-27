import { describe, expect, it, vi } from 'vitest';

import {
  FEATURES_SOURCE_NOTE,
  featureBriefFrom,
  hasExtractedFeatures,
  normalizeEnrichmentText,
  resolveUrlEnrichmentText,
  sourceNoteOf,
  urlKeywordsOf,
  type PageEvidenceFeatureSummary,
} from '../../src/sidepanel/nano/enrichmentInput';
import { MIN_CONTENT_CHARS } from '../../src/sidepanel/nano/titleSynthesis';

// DEFECT 3 — "for a visited page, I already have 'features only' extraction,
// why can't AI generation use a similar input approach not asking user to index
// first?"
//
// The chain must exhaust what ALREADY EXISTS before it asks the user to do
// anything: indexed text → the page's already-extracted features → a live
// extract → (only then) "index this page". The live extract is the expensive,
// permission-hungry one, so these tests assert it is not even attempted when an
// earlier link answered.

const URL = 'https://docs.aws.amazon.com/athena/latest/partition-projection-tables';

const featuresOnly: PageEvidenceFeatureSummary = {
  tier: 'content_features_only',
  termCount: 42,
  keyphraseCount: 8,
  entityCount: 5,
  quality: 'good',
};

const deps = (over: Partial<Parameters<typeof resolveUrlEnrichmentText>[1]> = {}) => ({
  fetchIndexedText: vi.fn(async () => null),
  fetchEvidenceSummary: vi.fn(async () => null),
  extractLiveText: vi.fn(async () => null),
  titleFor: () => 'Partition projection tables in Athena',
  ...over,
});

describe('enrichment input chain — features-only detection', () => {
  it('reads the evidence payload the companion actually sends (tier + counts)', () => {
    expect(hasExtractedFeatures(featuresOnly)).toBe(true);
    expect(hasExtractedFeatures({ tier: 'indexed_chunks', termCount: 10 })).toBe(true);
    // metadata_only means nothing was extracted — there is no extraction to reuse.
    expect(hasExtractedFeatures({ tier: 'metadata_only', termCount: 0 })).toBe(false);
    // A content tier with zero features is empty, whatever it is called.
    expect(hasExtractedFeatures({ tier: 'content_features_only' })).toBe(false);
    expect(hasExtractedFeatures(null)).toBe(false);
  });

  it('builds a brief from the textual evidence the panel really holds', () => {
    const brief = featureBriefFrom({
      canonicalUrl: URL,
      title: 'Partition projection tables in Athena',
      summary: featuresOnly,
    });
    expect(brief).not.toBeNull();
    expect(brief).toContain('Partition projection tables in Athena');
    expect(brief).toContain('docs.aws.amazon.com');
    expect(brief).toContain('partition');
    // It states the evidence honestly: extracted, raw text not kept.
    expect(brief).toContain('42 terms');
    expect(brief).toContain('8 key phrases');
    expect(brief).toContain('5 entities');
    expect(brief).toContain('raw text was not stored');
    // …and it clears the thin-content gate, so the run is a real run.
    expect((brief ?? '').trim().length).toBeGreaterThanOrEqual(MIN_CONTENT_CHARS);
  });

  it('drops URL noise (ids, hashes, digits) from the address keywords', () => {
    expect(urlKeywordsOf('https://example.com/deploy/runbook/2026/8f3ac91b77de/rollback')).toBe(
      'deploy runbook rollback',
    );
    expect(urlKeywordsOf('not a url at all')).toBe('not url all');
  });
});

describe('enrichment input chain — order, and what it refuses to ask for', () => {
  it('indexed text wins, and neither the evidence route nor the live extract is touched', async () => {
    const d = deps({ fetchIndexedText: vi.fn(async () => 'the whole page text, stored at index time') });
    const out = await resolveUrlEnrichmentText(URL, d);
    expect(out).toEqual({ text: 'the whole page text, stored at index time', source: 'indexed' });
    expect(d.fetchEvidenceSummary).not.toHaveBeenCalled();
    expect(d.extractLiveText).not.toHaveBeenCalled();
  });

  it('a features-only page generates from its features — no live extract, no "index first"', async () => {
    const d = deps({ fetchEvidenceSummary: vi.fn(async () => featuresOnly) });
    const out = await resolveUrlEnrichmentText(URL, d);
    expect(out.source).toBe('features');
    expect(out.text).toContain('Partition projection tables in Athena');
    // THE FIX: the page was already extracted, so we never go back to the page.
    expect(d.extractLiveText).not.toHaveBeenCalled();
  });

  it('falls back to the live extract only when nothing is on file', async () => {
    const d = deps({
      fetchEvidenceSummary: vi.fn(async () => ({ tier: 'metadata_only', termCount: 0 })),
      extractLiveText: vi.fn(async () => 'freshly extracted page text'),
    });
    const out = await resolveUrlEnrichmentText(URL, d);
    expect(out).toEqual({ text: 'freshly extracted page text', source: 'live' });
    expect(d.extractLiveText).toHaveBeenCalledTimes(1);
  });

  it('reports "nothing available" only after every link came up empty', async () => {
    const d = deps();
    const out = await resolveUrlEnrichmentText(URL, d);
    expect(out).toEqual({ text: null, source: 'none' });
    expect(d.fetchIndexedText).toHaveBeenCalledTimes(1);
    expect(d.fetchEvidenceSummary).toHaveBeenCalledTimes(1);
    expect(d.extractLiveText).toHaveBeenCalledTimes(1);
  });

  it('a throwing link (404 on a not-indexed page) is a normal step, not a failure', async () => {
    const d = deps({
      fetchIndexedText: vi.fn(async () => {
        throw new Error('404 PAGE_NOT_INDEXED');
      }),
      fetchEvidenceSummary: vi.fn(async () => featuresOnly),
    });
    const out = await resolveUrlEnrichmentText(URL, d);
    expect(out.source).toBe('features');
  });
});

describe('enrichment input chain — labelling', () => {
  it('labels a features-derived gist, and leaves a full-text one unlabelled', () => {
    expect(sourceNoteOf('features')).toBe(FEATURES_SOURCE_NOTE);
    expect(FEATURES_SOURCE_NOTE).toContain('page features');
    expect(FEATURES_SOURCE_NOTE).toContain('no full text indexed');
    expect(sourceNoteOf('indexed')).toBeNull();
    expect(sourceNoteOf('live')).toBeNull();
    expect(sourceNoteOf(null)).toBeNull();
  });

  it('still accepts the legacy string | null fetcher, inventing no caveat', () => {
    expect(normalizeEnrichmentText('some text')).toEqual({ text: 'some text', source: 'indexed' });
    expect(normalizeEnrichmentText(null)).toEqual({ text: null, source: 'none' });
    expect(normalizeEnrichmentText('   ')).toEqual({ text: null, source: 'none' });
    expect(normalizeEnrichmentText({ text: 'brief', source: 'features' })).toEqual({
      text: 'brief',
      source: 'features',
    });
    // An empty typed result collapses to 'none' — no phantom source.
    expect(normalizeEnrichmentText({ text: '', source: 'features' })).toEqual({
      text: null,
      source: 'none',
    });
  });
});
