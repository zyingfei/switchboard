// Throughput proof for the background page-evidence embedding lane.
//
// This is the regression test for the production-soak failure: over
// ~90 min with a ~1,000-record backlog the lane embedded a TOTAL of 2
// records (embeddedTotal frozen at 2, coverage flat) because
//   (a) a WARMUP RACE quarantined the backlog before the embedder child
//       finished warming, and
//   (b) the per-cycle work re-parsed the WHOLE store every 4 s while the
//       batch cap counted successes only.
//
// Here we seed N=50 synthetic page-evidence records (each with a
// page-content payload so it is genuinely embeddable), drive the REAL
// embed adapter through the DETERMINISTIC test embedder (a DI seam —
// SIDETRACK_TEST_EMBEDDER routes to a sync in-process fake; NO vi.mock of
// a process-global), start the embedder COLD, warm it mid-run, and assert
// the lane drains all 50 within a bounded number of cycles. It uses the
// REAL incremental store discovery so the cursor + mtime-bucketed scan
// are exercised end-to-end.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writePageContentExtracted } from '../page-content/store.js';
import {
  DEFAULT_BACKGROUND_EMBEDDING_CONFIG,
  createBackgroundEmbeddingLane,
} from './backgroundEmbeddingLane.js';
import {
  createIncrementalBackgroundEmbeddingCandidateSource,
  embedBacklogCanonicalUrl,
  listBackgroundEmbeddingCandidates,
  readBackgroundEmbeddingProgress,
  writeBackgroundEmbeddingProgress,
  writeExtractedPageEvidenceFast,
} from './store.js';
import type { PageEvidenceExtractedRequest } from './types.js';

const N = 50;

const urlFor = (i: number): string =>
  `https://throughput.test/doc-${String(i).padStart(3, '0')}`;

const requestFor = (i: number): PageEvidenceExtractedRequest => {
  const url = urlFor(i);
  return {
    payloadVersion: 1,
    canonicalUrl: url,
    url,
    title: `Doc ${String(i)}`,
    extractedAt: '2026-07-17T10:00:00.000Z',
    extractionSource: 'reader-mode',
    extractionPolicy: { trigger: 'attention-gate' },
    quality: 'high',
    qualitySignals: {
      extractedWordCount: 400,
      contentToDomRatio: 0.6,
      boilerplateFraction: 0.05,
      extractionStrategy: 'reader-mode',
    },
    content: {
      text: `Synthetic content body for doc ${String(i)} networking fabric switch design. `.repeat(20),
      contentHash: `hash-doc-${String(i)}`,
      charCount: 900,
    },
    storageMode: 'indexed_chunks',
  };
};

describe('background-embedding lane throughput (warmup-race regression)', () => {
  let root: string;
  let previousTestEmbedder: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-embed-lane-throughput-'));
    previousTestEmbedder = process.env['SIDETRACK_TEST_EMBEDDER'];
    // Deterministic sync in-process embedder — the DI seam. Not a vi.mock.
    process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
    // Seed N=50 content-tier records with a MISSING embedding + their
    // page-content payloads (raw text) so the real embed adapter can
    // reconstruct + embed each one. Parallelized — 50×2 sequential disk
    // writes exceeded the default 5 s hook timeout under suite contention.
    await Promise.all(
      Array.from({ length: N }, async (_unused, i) => {
        const req = requestFor(i);
        await writePageContentExtracted(root, {
          payloadVersion: 1,
          canonicalUrl: req.canonicalUrl,
          url: req.url,
          title: `Doc ${String(i)}`,
          extractedAt: req.extractedAt,
          extractionSource: req.extractionSource,
          extractionPolicy: req.extractionPolicy,
          quality: req.quality,
          qualitySignals: req.qualitySignals,
          content: req.content,
        });
        await writeExtractedPageEvidenceFast(root, req, { rebuildManifestAfterWrite: false });
      }),
    );
  }, 30_000);

  afterEach(async () => {
    if (previousTestEmbedder === undefined) delete process.env['SIDETRACK_TEST_EMBEDDER'];
    else process.env['SIDETRACK_TEST_EMBEDDER'] = previousTestEmbedder;
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it('drains all 50 records within a bounded number of cycles, warming mid-run', async () => {
    // Sanity: 50 records are backlog before the lane runs.
    const before = await listBackgroundEmbeddingCandidates(root);
    expect(before).toHaveLength(N);

    // The embedder starts COLD and becomes ready after a few cycles — the
    // exact soak race.
    let ready = false;
    const requalified: string[] = [];
    const source = createIncrementalBackgroundEmbeddingCandidateSource(root);
    const embedOne = await embedBacklogCanonicalUrl(root);

    const lane = createBackgroundEmbeddingLane(
      {
        listCandidates: source.listCandidates,
        embedCanonicalUrl: embedOne,
        isDrainActive: () => false,
        isEmbedderReady: () => ready,
        onEmbedded: (url) => requalified.push(url),
        readProgress: () => readBackgroundEmbeddingProgress(root),
        writeProgress: (p) => writeBackgroundEmbeddingProgress(root, p),
      },
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, batchCap: 8 },
    );

    // Cold cycles: the lane must yield (paused-warmup), embed NOTHING, and
    // burn NO attempts. It must NOT quarantine the backlog.
    for (let c = 0; c < 3; c += 1) {
      const r = await lane.runOnce();
      expect(r.pausedForWarmup).toBe(true);
      expect(r.embedded).toBe(0);
    }
    expect(lane.progress().embeddedTotal).toBe(0);
    expect(Object.keys(lane.progress().attemptsByCanonicalUrl)).toHaveLength(0);
    expect(lane.health().inert).toBe(false); // warming, not inert

    // Warm the embedder mid-run and drive cycles until the backlog drains.
    ready = true;
    let cycles = 0;
    const MAX_CYCLES = 20; // ceil(50 / 8) = 7 embed cycles; 20 is generous.
    while (lane.progress().embeddedTotal < N && cycles < MAX_CYCLES) {
      const r = await lane.runOnce();
      cycles += 1;
      expect(r.embedded).toBeLessThanOrEqual(8); // batch cap respected
    }

    // THROUGHPUT PROOF: all 50 embedded within the bounded cycle budget.
    expect(lane.progress().embeddedTotal).toBe(N);
    expect(cycles).toBeLessThanOrEqual(MAX_CYCLES);
    expect(requalified).toHaveLength(N); // every embed requalified its visit

    // Backlog is now drained on disk.
    const after = await listBackgroundEmbeddingCandidates(root);
    const stillBacklog = after.filter(
      (c) => c.content?.embeddingState !== 'ready' && c.content?.docEmbeddingRef === undefined,
    );
    expect(stillBacklog).toHaveLength(0);

    // A further cycle reports idle-empty; the lane is not inert.
    const finalCycle = await lane.runOnce();
    expect(finalCycle.backlog).toBe(0);
    const health = lane.health();
    expect(health.embeddedTotal).toBe(N);
    expect(health.embeddedThisProcess).toBe(N);
    expect(health.inert).toBe(false);
    expect(health.lastSuccessAtMs).not.toBeNull();
  }, 30_000);

  it('a mid-run drain pause yields but does not lose progress', async () => {
    let embeds = 0;
    let drainActive = false;
    const source = createIncrementalBackgroundEmbeddingCandidateSource(root);
    const embedOneReal = await embedBacklogCanonicalUrl(root);
    const embedCanonicalUrl = async (
      canonicalUrl: string,
    ): Promise<'embedded' | 'skipped' | 'failed'> => {
      const outcome = await embedOneReal(canonicalUrl);
      if (outcome === 'embedded') {
        embeds += 1;
        // A drain lands after the 10th embed — the lane must yield promptly.
        if (embeds === 10) drainActive = true;
      }
      return outcome;
    };
    const lane = createBackgroundEmbeddingLane(
      {
        listCandidates: source.listCandidates,
        embedCanonicalUrl,
        isDrainActive: () => drainActive,
        readProgress: () => readBackgroundEmbeddingProgress(root),
        writeProgress: (p) => writeBackgroundEmbeddingProgress(root, p),
      },
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, batchCap: 50 },
    );
    const paused = await lane.runOnce();
    expect(paused.pausedForDrain).toBe(true);
    expect(embeds).toBe(10);
    // Progress persisted despite the mid-cycle yield.
    const progress = await readBackgroundEmbeddingProgress(root);
    expect(progress?.embeddedTotal).toBe(10);

    // Drain clears; the lane resumes and drains the rest across cycles.
    drainActive = false;
    let cycles = 0;
    while (lane.progress().embeddedTotal < N && cycles < 10) {
      await lane.runOnce();
      cycles += 1;
    }
    expect(lane.progress().embeddedTotal).toBe(N);
  }, 30_000);
});
