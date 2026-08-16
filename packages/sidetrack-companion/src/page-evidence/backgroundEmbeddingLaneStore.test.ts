import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writePageContentExtracted } from '../page-content/store.js';
import { isBackgroundEmbeddingBacklog } from './backgroundEmbeddingLane.js';
import {
  createIncrementalBackgroundEmbeddingCandidateSource,
  discoverBackgroundEmbeddingBacklog,
  embedBacklogCanonicalUrl,
  listBackgroundEmbeddingCandidates,
  readBackgroundEmbeddingDiscoveryIndex,
  readBackgroundEmbeddingProgress,
  readPageEvidence,
  requeueQuarantinedEmbeddingBacklog,
  writeBackgroundEmbeddingProgress,
  writeExtractedPageEvidenceFast,
  writeMetadataOnlyPageEvidence,
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
    const record = await writeExtractedPageEvidenceFast(root, payload());
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
    await writeExtractedPageEvidenceFast(root, payload());

    const embedOne = await embedBacklogCanonicalUrl(root);
    const outcome = await embedOne(CANONICAL);
    expect(outcome).toBe('embedded');

    // After embedding, the record is no longer backlog.
    const after = await listBackgroundEmbeddingCandidates(root);
    expect(after[0]?.content?.embeddingState).toBe('ready');
    expect(after[0]?.content?.docEmbeddingRef).toBeDefined();
    expect(isBackgroundEmbeddingBacklog(after[0]!)).toBe(false);
  });

  it('embeds a backlog record whose evidence was touched by a LATER revisit (2026-08-16 regression)', async () => {
    // ROOT CAUSE (verified against the live test vault's page-content.db /
    // page-evidence.db, 394/771 = 51% of the genuine indexed_chunks/
    // missing backlog): `writeMetadataOnlyPageEvidence` — called from
    // `ensurePageEvidenceForTimelineEntries` on every timeline
    // ensure/revisit — bumps the evidence record's `updatedAt` to the
    // visit's `lastSeenAt` while carrying the existing `content` block
    // forward UNCHANGED. The background-embedding lane's backlog
    // reconstruction (`embedBacklogCanonicalUrl`) rebuilds a payload from
    // page-content whose `extractedAt` stays fixed at the ORIGINAL
    // extraction time. Before the fix, `isCurrentEvidenceForEmbeddingCompletion`
    // compared `record.updatedAt <= payload.extractedAt` unconditionally
    // and rejected the completion — even though the content (contentHash)
    // was byte-identical — so a merely-REVISITED page could never be
    // embedded by the backlog lane.
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
    await writeExtractedPageEvidenceFast(root, payload());

    // Simulate a revisit landing AFTER the original extraction — exactly
    // what `ensurePageEvidenceForTimelineEntries` does on every re-ensure.
    // This bumps `updatedAt` to `lastSeenAt` while the content block (and
    // its contentHash) is carried forward unchanged.
    const revisited = await writeMetadataOnlyPageEvidence(root, {
      canonicalUrl: CANONICAL,
      url: CANONICAL,
      lastSeenAt: '2026-05-16T10:05:00.000Z', // later than payload.extractedAt above
    });
    expect(revisited.updatedAt > payload().extractedAt).toBe(true);
    expect(revisited.content?.embeddingState).toBe('missing'); // still backlog

    const embedOne = await embedBacklogCanonicalUrl(root);
    const outcome = await embedOne(CANONICAL);
    expect(outcome).toBe('embedded');

    const after = await readPageEvidence(root, CANONICAL);
    expect(after.record?.content?.embeddingState).toBe('ready');
    expect(after.record?.content?.docEmbeddingRef).toBeDefined();
  });

  it('embedBacklogCanonicalUrl skips a record with no indexed content payload', async () => {
    // Evidence written features-only (no page-content raw text on disk):
    // the reconstruction returns null, so the lane must skip (not fail).
    await writeExtractedPageEvidenceFast(root, payload({ storageMode: 'features_only' }));
    const embedOne = await embedBacklogCanonicalUrl(root);
    // AUDIBLE FAILURES: skip now carries WHY (page-content has no current
    // indexed payload for this URL) instead of a bare string.
    expect(await embedOne(CANONICAL)).toEqual({ outcome: 'skipped', reason: 'no-page-content' });
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

// ─────────────────────────────────────────────────────────────────────
// Bug (b): incremental discovery — the lane must NOT re-parse the whole
// store every cycle. discoverBackgroundEmbeddingBacklog reads JSON only
// for the changed/new delta (mtime-bucketed), carrying prior verdicts
// forward for unchanged files.
// ─────────────────────────────────────────────────────────────────────
describe('incremental background-embedding discovery', () => {
  let root: string;

  const writeBacklogRecord = async (canonicalUrl: string): Promise<void> => {
    await writeExtractedPageEvidenceFast(root, payload({ canonicalUrl, url: canonicalUrl }));
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-embed-lane-discovery-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('first scan reads every file; a subsequent scan with no changes reads ZERO', async () => {
    for (let i = 0; i < 6; i += 1) {
      await writeBacklogRecord(`https://d.test/${String(i)}`);
    }
    // Cold scan: no prior index → reads all 6.
    const first = await discoverBackgroundEmbeddingBacklog(root, null);
    expect(first.totalFiles).toBe(6);
    expect(first.filesRead).toBe(6);
    expect(first.candidates).toHaveLength(6);

    // Warm scan with the refreshed index and no file changes → reads NONE,
    // but still returns the same backlog (carried forward from the index).
    const second = await discoverBackgroundEmbeddingBacklog(root, first.index);
    expect(second.totalFiles).toBe(6);
    expect(second.filesRead).toBe(0); // <-- the whole point: no full re-parse
    expect(second.candidates).toHaveLength(6);
  });

  it('reads ONLY the new file when the store grows by one', async () => {
    for (let i = 0; i < 4; i += 1) {
      await writeBacklogRecord(`https://g.test/${String(i)}`);
    }
    const first = await discoverBackgroundEmbeddingBacklog(root, null);
    expect(first.filesRead).toBe(4);

    // Append one record. Only that one should be JSON-read next cycle.
    await writeBacklogRecord('https://g.test/NEW');
    const second = await discoverBackgroundEmbeddingBacklog(root, first.index);
    expect(second.totalFiles).toBe(5);
    expect(second.filesRead).toBe(1);
    expect(second.candidates).toHaveLength(5);
  });

  it('drops a record from the backlog once its embedding becomes ready', async () => {
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
    await writeBacklogRecord(CANONICAL);
    const first = await discoverBackgroundEmbeddingBacklog(root, null);
    expect(first.candidates.some((c) => isBackgroundEmbeddingBacklog(c))).toBe(true);

    // Embed it (rewrites the record file with a ready vector, new mtime).
    process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
    try {
      const embedOne = await embedBacklogCanonicalUrl(root);
      expect(await embedOne(CANONICAL)).toBe('embedded');
    } finally {
      delete process.env['SIDETRACK_TEST_EMBEDDER'];
    }

    // The changed file is re-read; the record is no longer backlog.
    const second = await discoverBackgroundEmbeddingBacklog(root, first.index);
    expect(second.filesRead).toBe(1);
    const stillBacklog = second.candidates.filter((c) => isBackgroundEmbeddingBacklog(c));
    expect(stillBacklog).toHaveLength(0);
  });

  it('createIncrementalBackgroundEmbeddingCandidateSource persists + reuses the cursor across calls', async () => {
    for (let i = 0; i < 5; i += 1) {
      await writeBacklogRecord(`https://s.test/${String(i)}`);
    }
    const source = createIncrementalBackgroundEmbeddingCandidateSource(root);
    const c1 = await source.listCandidates();
    expect(c1).toHaveLength(5);
    expect(source.lastScan()).toEqual({ totalFiles: 5, filesRead: 5 });

    // The cursor was persisted to disk.
    expect(await readBackgroundEmbeddingDiscoveryIndex(root)).not.toBeNull();

    // Second call reuses the in-memory cursor → zero JSON reads.
    const c2 = await source.listCandidates();
    expect(c2).toHaveLength(5);
    expect(source.lastScan().filesRead).toBe(0);

    // A FRESH source (simulating a restart) loads the persisted cursor and
    // also does zero re-reads when nothing changed on disk.
    const restarted = createIncrementalBackgroundEmbeddingCandidateSource(root);
    const c3 = await restarted.listCandidates();
    expect(c3).toHaveLength(5);
    expect(restarted.lastScan().filesRead).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Boot-time requeue for bug-caused quarantine (2026-08-16 incident, item
// 4): entries quarantined for a BUG-CAUSED reason ('stale-guard',
// 'not-persisted') get one bounded, one-time fresh shot. Entries
// quarantined for a reason that can reflect a genuinely-unembeddable
// record ('no-page-content', 'embed-error') — or with no recorded reason
// at all — must NOT be resurrected.
// ─────────────────────────────────────────────────────────────────────
describe('requeueQuarantinedEmbeddingBacklog', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-embed-lane-requeue-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('clears only bug-caused reasons, leaving genuinely-bad and unrecorded entries quarantined', async () => {
    await writeBackgroundEmbeddingProgress(root, {
      schemaVersion: 1,
      attemptsByCanonicalUrl: {
        'https://stale-guard.test': 3,
        'https://not-persisted.test': 3,
        'https://embed-error.test': 3,
        'https://no-page-content.test': 3,
        'https://unrecorded.test': 3,
      },
      quarantinedAtMsByCanonicalUrl: {
        'https://stale-guard.test': 1_000,
        'https://not-persisted.test': 1_000,
        'https://embed-error.test': 1_000,
        'https://no-page-content.test': 1_000,
        'https://unrecorded.test': 1_000,
      },
      lastFailureReasonByCanonicalUrl: {
        'https://stale-guard.test': 'stale-guard',
        'https://not-persisted.test': 'not-persisted',
        'https://embed-error.test': 'embed-error',
        'https://no-page-content.test': 'no-page-content',
        // 'https://unrecorded.test' intentionally has no entry.
      },
      embeddedTotal: 0,
      lastRunAtMs: 1_000,
    });

    const result = await requeueQuarantinedEmbeddingBacklog(root);
    expect(new Set(result.requeued)).toEqual(
      new Set(['https://stale-guard.test', 'https://not-persisted.test']),
    );

    const after = await readBackgroundEmbeddingProgress(root);
    // Bug-caused entries: attempts + quarantine + reason all cleared.
    expect(after?.attemptsByCanonicalUrl['https://stale-guard.test']).toBeUndefined();
    expect(after?.quarantinedAtMsByCanonicalUrl?.['https://stale-guard.test']).toBeUndefined();
    expect(after?.attemptsByCanonicalUrl['https://not-persisted.test']).toBeUndefined();
    expect(after?.quarantinedAtMsByCanonicalUrl?.['https://not-persisted.test']).toBeUndefined();
    // Genuinely-bad / unrecorded entries: untouched.
    expect(after?.attemptsByCanonicalUrl['https://embed-error.test']).toBe(3);
    expect(after?.quarantinedAtMsByCanonicalUrl?.['https://embed-error.test']).toBe(1_000);
    expect(after?.attemptsByCanonicalUrl['https://no-page-content.test']).toBe(3);
    expect(after?.quarantinedAtMsByCanonicalUrl?.['https://no-page-content.test']).toBe(1_000);
    expect(after?.attemptsByCanonicalUrl['https://unrecorded.test']).toBe(3);
    expect(after?.quarantinedAtMsByCanonicalUrl?.['https://unrecorded.test']).toBe(1_000);
  });

  it('is a one-time sweep: running it again requeues nothing further for already-cleared entries', async () => {
    await writeBackgroundEmbeddingProgress(root, {
      schemaVersion: 1,
      attemptsByCanonicalUrl: { 'https://stale-guard.test': 3 },
      quarantinedAtMsByCanonicalUrl: { 'https://stale-guard.test': 1_000 },
      lastFailureReasonByCanonicalUrl: { 'https://stale-guard.test': 'stale-guard' },
      embeddedTotal: 0,
      lastRunAtMs: 1_000,
    });

    const first = await requeueQuarantinedEmbeddingBacklog(root);
    expect(first.requeued).toEqual(['https://stale-guard.test']);

    const second = await requeueQuarantinedEmbeddingBacklog(root);
    expect(second.requeued).toEqual([]);
  });

  it('is a no-op when there is no persisted progress or nothing quarantined', async () => {
    expect(await requeueQuarantinedEmbeddingBacklog(root)).toEqual({ requeued: [] });
    await writeBackgroundEmbeddingProgress(root, {
      schemaVersion: 1,
      attemptsByCanonicalUrl: {},
      embeddedTotal: 0,
      lastRunAtMs: 1_000,
    });
    expect(await requeueQuarantinedEmbeddingBacklog(root)).toEqual({ requeued: [] });
  });
});
