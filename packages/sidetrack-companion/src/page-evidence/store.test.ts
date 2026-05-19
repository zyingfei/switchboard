import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryPageContent, writePageContentExtracted } from '../page-content/store.js';
import type { PageEvidenceExtractedRequest } from './types.js';
import {
  pageEvidenceStorageStats,
  ensurePageEvidenceForTimelineEntries,
  readPageEvidence,
  readPageEvidenceVectorMap,
  writeExtractedPageEvidence,
  writeMetadataOnlyPageEvidence,
} from './store.js';

const payload = (
  overrides: Partial<PageEvidenceExtractedRequest> = {},
): PageEvidenceExtractedRequest => ({
  payloadVersion: 1,
  canonicalUrl: 'https://engineering.example.com/f16-minipack',
  url: 'https://engineering.example.com/f16-minipack?utm_source=x',
  title: 'F16 Minipack Data Center Fabric',
  extractedAt: '2026-05-16T10:00:00.000Z',
  extractionSource: 'reader-mode',
  extractionPolicy: { trigger: 'attention-gate' },
  quality: 'high',
  qualitySignals: {
    extractedWordCount: 360,
    contentToDomRatio: 0.64,
    boilerplateFraction: 0.06,
    extractionStrategy: 'reader-mode',
  },
  content: {
    text: [
      'The full raw content sentence includes a privacy sentinel that must not be persisted.',
      'F16 Minipack data center fabric networking 100G switch design repeats for evidence.',
    ].join(' '),
    contentHash: 'hash-f16-minipack',
    charCount: 1800,
  },
  storageMode: 'features_only',
  ...overrides,
});

describe('page-evidence store', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-page-evidence-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores features-only evidence without raw page-content or search snippets', async () => {
    const record = await writeExtractedPageEvidence(root, payload(), { embeddingsEnabled: false });

    expect(record.evidenceTier).toBe('content_features_only');
    expect(record.content?.terms.some((term) => term.normalized === 'minipack')).toBe(true);
    await expect(queryPageContent(root, 'minipack fabric', { limit: 5 })).resolves.toEqual([]);
    await expect(readdir(join(root, '_BAC', 'page-content', 'raw'))).rejects.toThrow();
    await expect(readdir(join(root, '_BAC', 'page-content', 'chunks'))).rejects.toThrow();

    const evidenceFiles = await readdir(join(root, '_BAC', 'page-evidence', 'by-url'));
    const evidenceJson = await readFile(
      join(root, '_BAC', 'page-evidence', 'by-url', evidenceFiles[0]!),
      'utf8',
    );
    expect(evidenceJson).not.toContain(
      'The full raw content sentence includes a privacy sentinel that must not be persisted.',
    );
  });

  it('persists and reads doc-vector refs when an embedder is available', async () => {
    const embedder = async (texts: readonly string[]): Promise<readonly Float32Array[]> =>
      texts.map(() => {
        const vector = new Float32Array(384);
        vector[0] = 1;
        return vector;
      });

    const record = await writeExtractedPageEvidence(root, payload(), { embedder });

    expect(record.content?.docEmbeddingRef).toMatchObject({
      modelId: 'Xenova/multilingual-e5-small',
      dimensions: 384,
    });

    const vectors = await readPageEvidenceVectorMap(root, [record]);
    const vector = vectors.get(record.content!.docEmbeddingRef!.vectorId);
    expect(vector?.[0]).toBeCloseTo(1, 6);

    const stats = await pageEvidenceStorageStats(root);
    expect(stats.contentVectorReadyCount).toBe(1);
    expect(stats.contentVectorMissingCount).toBe(0);
    expect(stats.pageEvidenceRawTextPersistedBytes).toBe(0);
  });

  it('does not mark embedding ready when no vector ref is written', async () => {
    const embedder = async (): Promise<readonly Float32Array[]> => [];

    const record = await writeExtractedPageEvidence(root, payload(), { embedder });

    expect(record.content?.docEmbeddingRef).toBeUndefined();
    expect(record.content?.embeddingState).toBe('missing');
    const stats = await pageEvidenceStorageStats(root);
    expect(stats.contentVectorReadyCount).toBe(0);
    expect(stats.contentVectorMissingCount).toBe(1);
  });

  it('downgrades below-floor extracted content to metadata-only evidence', async () => {
    const record = await writeExtractedPageEvidence(
      root,
      payload({
        quality: 'low',
        qualitySignals: {
          extractedWordCount: 8,
          contentToDomRatio: 0.01,
          boilerplateFraction: 0.9,
          extractionStrategy: 'visible-dom',
        },
        content: {
          text: 'short noisy nav',
          contentHash: 'hash-short',
          charCount: 15,
        },
      }),
      { embeddingsEnabled: false },
    );

    expect(record.evidenceTier).toBe('metadata_only');
    expect(record.content).toBeUndefined();
  });

  it('seeds indexed PageEvidence from existing page-content records', async () => {
    const { storageMode: _storageMode, ...pageContentPayload } = payload({
      storageMode: 'indexed_chunks',
    });
    await writePageContentExtracted(root, {
      ...pageContentPayload,
      extractionPolicy: { trigger: 'manual' },
    });

    const records = await ensurePageEvidenceForTimelineEntries(root, [
      {
        id: 'timeline-visit:https://engineering.example.com/f16-minipack',
        firstSeenAt: '2026-05-16T09:00:00.000Z',
        lastSeenAt: '2026-05-16T10:00:00.000Z',
        url: 'https://engineering.example.com/f16-minipack',
        canonicalUrl: 'https://engineering.example.com/f16-minipack',
        title: 'F16 Minipack Data Center Fabric',
        provider: 'generic',
        visitCount: 1,
      },
    ]);
    const record = records.get('https://engineering.example.com/f16-minipack');

    expect(record?.evidenceTier).toBe('indexed_chunks');
    expect(record?.indexed?.chunkCount).toBeGreaterThan(0);
    expect(record?.content?.terms.some((term) => term.normalized === 'minipack')).toBe(true);
  });

  it('preserves content evidence when later timeline metadata refreshes the record', async () => {
    const initial = await writeExtractedPageEvidence(root, payload(), { embeddingsEnabled: false });
    await writeMetadataOnlyPageEvidence(root, {
      canonicalUrl: initial.canonicalUrl,
      title: 'New timeline title',
      lastSeenAt: '2026-05-16T11:00:00.000Z',
      visitCount: 2,
    });
    const refreshed = await readPageEvidence(root, initial.canonicalUrl);

    expect(refreshed.record?.evidenceTier).toBe('content_features_only');
    expect(refreshed.record?.content?.contentHash).toBe('hash-f16-minipack');
    expect(refreshed.record?.metadata.title).toBe('New timeline title');
  });
});
