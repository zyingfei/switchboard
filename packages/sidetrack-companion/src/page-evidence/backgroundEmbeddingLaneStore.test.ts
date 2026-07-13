import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writePageContentExtracted } from '../page-content/store.js';
import { isBackgroundEmbeddingBacklog } from './backgroundEmbeddingLane.js';
import {
  embedBacklogCanonicalUrl,
  listBackgroundEmbeddingCandidates,
  readBackgroundEmbeddingProgress,
  writeBackgroundEmbeddingProgress,
  writeExtractedPageEvidenceFast,
} from './store.js';
import type { PageEvidenceExtractedRequest } from './types.js';

const CANONICAL = 'https://engineering.example.com/f16-minipack';

const payload = (
  overrides: Partial<PageEvidenceExtractedRequest> = {},
): PageEvidenceExtractedRequest => ({
  payloadVersion: 1,
  canonicalUrl: CANONICAL,
  url: CANONICAL,
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
    text: 'F16 Minipack data center fabric networking 100G switch design repeats for evidence. '.repeat(
      6,
    ),
    contentHash: 'hash-f16-minipack',
    charCount: 1800,
  },
  storageMode: 'indexed_chunks',
  ...overrides,
});

describe('background-embedding lane store adapters', () => {
  let root: string;
  let previousTestEmbedder: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-embed-lane-store-'));
    previousTestEmbedder = process.env['SIDETRACK_TEST_EMBEDDER'];
    process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
  });

  afterEach(async () => {
    if (previousTestEmbedder === undefined) delete process.env['SIDETRACK_TEST_EMBEDDER'];
    else process.env['SIDETRACK_TEST_EMBEDDER'] = previousTestEmbedder;
    await rm(root, { recursive: true, force: true });
  });

  it('lists a content-tier record with a missing embedding as backlog', async () => {
    // Write the page-content record (raw text) then the evidence record
    // WITHOUT embedding — the request-path shape the lane must pick up.
    await writePageContentExtracted(root, {
      payloadVersion: 1,
      canonicalUrl: CANONICAL,
      url: CANONICAL,
      title: 'F16 Minipack Data Center Fabric',
      extractedAt: '2026-05-16T10:00:00.000Z',
      extractionSource: 'reader-mode',
      extractionPolicy: { trigger: 'manual' },
      quality: 'high',
      qualitySignals: payload().qualitySignals,
      content: payload().content,
    });
    const record = await writeExtractedPageEvidenceFast(root, payload(), {
      rebuildManifestAfterWrite: false,
    });
    expect(record.content?.embeddingState).toBe('missing');

    const candidates = await listBackgroundEmbeddingCandidates(root);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.canonicalUrl).toBe(CANONICAL);
    expect(isBackgroundEmbeddingBacklog(candidates[0]!)).toBe(true);
  });

  it('embedBacklogCanonicalUrl embeds a backlog record end-to-end', async () => {
    await writePageContentExtracted(root, {
      payloadVersion: 1,
      canonicalUrl: CANONICAL,
      url: CANONICAL,
      title: 'F16 Minipack Data Center Fabric',
      extractedAt: '2026-05-16T10:00:00.000Z',
      extractionSource: 'reader-mode',
      extractionPolicy: { trigger: 'manual' },
      quality: 'high',
      qualitySignals: payload().qualitySignals,
      content: payload().content,
    });
    await writeExtractedPageEvidenceFast(root, payload(), { rebuildManifestAfterWrite: false });

    const embedOne = await embedBacklogCanonicalUrl(root);
    const outcome = await embedOne(CANONICAL);
    expect(outcome).toBe('embedded');

    // After embedding, the record is no longer backlog.
    const after = await listBackgroundEmbeddingCandidates(root);
    expect(after[0]?.content?.embeddingState).toBe('ready');
    expect(after[0]?.content?.docEmbeddingRef).toBeDefined();
    expect(isBackgroundEmbeddingBacklog(after[0]!)).toBe(false);
  });

  it('embedBacklogCanonicalUrl skips a record with no indexed content payload', async () => {
    // Evidence written features-only (no page-content raw text on disk):
    // the reconstruction returns null, so the lane must skip (not fail).
    await writeExtractedPageEvidenceFast(root, payload({ storageMode: 'features_only' }), {
      rebuildManifestAfterWrite: false,
    });
    const embedOne = await embedBacklogCanonicalUrl(root);
    expect(await embedOne(CANONICAL)).toBe('skipped');
  });

  it('persists + reads the progress artifact round-trip', async () => {
    expect(await readBackgroundEmbeddingProgress(root)).toBeNull();
    await writeBackgroundEmbeddingProgress(root, {
      schemaVersion: 1,
      attemptsByCanonicalUrl: { [CANONICAL]: 2 },
      embeddedTotal: 5,
      lastRunAtMs: 1_777_000_000_000,
    });
    const loaded = await readBackgroundEmbeddingProgress(root);
    expect(loaded?.embeddedTotal).toBe(5);
    expect(loaded?.attemptsByCanonicalUrl[CANONICAL]).toBe(2);
  });
});
