import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pageContentCoverageCounts,
  queryPageContent,
  readPageContentCoverage,
  writePageContentExtracted,
  writePageContentTombstoned,
} from './store.js';
import { PAGE_CONTENT_COVERAGE_STATES } from './types.js';
import type { PageContentExtractedPayload } from './types.js';

describe('page-content store', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-page-content-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const extractedPayload = (
    overrides: Partial<PageContentExtractedPayload> = {},
  ): PageContentExtractedPayload => ({
    payloadVersion: 1,
    canonicalUrl: 'https://docs.example.com/oracle/cloud',
    url: 'https://docs.example.com/oracle/cloud?utm_source=x',
    title: 'Oracle Cloud Infrastructure Cloud Adoption Framework',
    extractedAt: '2026-05-15T10:00:00.000Z',
    extractionSource: 'reader-mode',
    extractionPolicy: { trigger: 'manual' },
    quality: 'high',
    qualitySignals: {
      extractedWordCount: 320,
      contentToDomRatio: 0.62,
      boilerplateFraction: 0.08,
      extractionStrategy: 'reader-mode',
      headingSignatureHash: 'abc',
    },
    content: {
      text: `${'Oracle cloud adoption framework architecture guardrails '.repeat(70)}`,
      contentHash: 'hash-oracle-cloud',
      charCount: 3200,
    },
    ...overrides,
  });

  it('persists coverage, raw text, chunks, and typed query hits', async () => {
    const coverage = await writePageContentExtracted(root, extractedPayload());

    expect(coverage.state).toBe('indexed');
    expect(coverage.quality).toBe('high');
    expect(coverage.chunkCount).toBeGreaterThan(0);

    await expect(
      readFile(join(root, '_BAC', 'page-content', 'raw', 'hash-oracle-cloud.json'), 'utf8'),
    ).resolves.toContain('Oracle cloud adoption');

    const queried = await queryPageContent(root, 'oracle guardrails', { limit: 5 });
    expect(queried).toHaveLength(1);
    expect(queried[0]?.sourceKind).toBe('page-content');
    expect(queried[0]?.anchorNodeId).toBe('timeline-visit:https://docs.example.com/oracle/cloud');
  });

  it('marks below-floor extractions as metadata-only errors', async () => {
    const coverage = await writePageContentExtracted(
      root,
      extractedPayload({
        quality: 'low',
        qualitySignals: {
          extractedWordCount: 8,
          contentToDomRatio: 0.01,
          boilerplateFraction: 0.9,
          extractionStrategy: 'visible-dom',
        },
        content: { text: 'short noisy nav', contentHash: 'hash-short', charCount: 15 },
      }),
    );

    expect(coverage.state).toBe('metadata_only_error');
    expect(coverage.error).toBe('extraction_quality_below_floor');
    await expect(queryPageContent(root, 'short', { limit: 5 })).resolves.toEqual([]);
  });

  it('tombstones indexed content and removes searchability', async () => {
    await writePageContentExtracted(root, extractedPayload());
    const coverage = await writePageContentTombstoned(root, {
      payloadVersion: 1,
      canonicalUrl: 'https://docs.example.com/oracle/cloud',
      tombstonedAt: '2026-05-15T11:00:00.000Z',
      reason: 'user-delete',
    });

    expect(coverage.state).toBe('tombstoned');
    await expect(readPageContentCoverage(root, coverage.canonicalUrl)).resolves.toMatchObject({
      state: 'tombstoned',
    });
    await expect(queryPageContent(root, 'oracle', { limit: 5 })).resolves.toEqual([]);
  });

  it('aggregates per-state coverage counts with explicit zeros', async () => {
    // indexed (high quality)
    await writePageContentExtracted(
      root,
      extractedPayload({ canonicalUrl: 'https://docs.example.com/a', url: 'https://docs.example.com/a' }),
    );
    // indexed_low_quality (passes floor, below medium thresholds)
    await writePageContentExtracted(
      root,
      extractedPayload({
        canonicalUrl: 'https://docs.example.com/b',
        url: 'https://docs.example.com/b',
        quality: 'low',
        qualitySignals: {
          extractedWordCount: 40,
          contentToDomRatio: 0.1,
          boilerplateFraction: 0.5,
          extractionStrategy: 'visible-dom',
        },
        content: {
          text: `${'low quality filler words '.repeat(50)}`,
          contentHash: 'hash-low',
          charCount: 1250,
        },
      }),
    );
    // metadata_only_error (below floor)
    await writePageContentExtracted(
      root,
      extractedPayload({
        canonicalUrl: 'https://docs.example.com/c',
        url: 'https://docs.example.com/c',
        quality: 'low',
        qualitySignals: {
          extractedWordCount: 8,
          contentToDomRatio: 0.01,
          boilerplateFraction: 0.9,
          extractionStrategy: 'visible-dom',
        },
        content: { text: 'short noisy nav', contentHash: 'hash-c', charCount: 15 },
      }),
    );
    // tombstoned
    await writePageContentExtracted(
      root,
      extractedPayload({ canonicalUrl: 'https://docs.example.com/d', url: 'https://docs.example.com/d' }),
    );
    await writePageContentTombstoned(root, {
      payloadVersion: 1,
      canonicalUrl: 'https://docs.example.com/d',
      tombstonedAt: '2026-05-15T11:00:00.000Z',
      reason: 'user-delete',
    });

    const counts = await pageContentCoverageCounts(root);

    expect(typeof counts.producedAt).toBe('string');
    expect(Number.isNaN(Date.parse(counts.producedAt))).toBe(false);
    expect(counts.total).toBe(4);
    expect(counts.byState.indexed).toBe(1);
    expect(counts.byState.indexed_low_quality).toBe(1);
    expect(counts.byState.metadata_only_error).toBe(1);
    expect(counts.byState.tombstoned).toBe(1);
    expect(counts.indexed).toBe(2); // indexed + indexed_low_quality
    expect(counts.bytes).toBeGreaterThan(0);
    // Every known state present with an explicit zero, never missing.
    for (const state of PAGE_CONTENT_COVERAGE_STATES) {
      expect(counts.byState[state]).toBeTypeOf('number');
    }
    expect(counts.byState.indexing).toBe(0);
    expect(counts.byState.stale_index).toBe(0);
  });
});
