// F5 disk-wear regression guard: a capture must write O(that capture's
// own data) bytes, never O(all-records). Before F5, every capture
// rewrote a chunks-manifest.json covering every indexed page (measured
// 157KB on the ~700-record test vault, GROWING with the corpus) on top
// of its own small per-record files. With the single SQLite store, one
// capture is one small transaction against its own rows — the marginal
// bytes a capture costs should stay roughly flat as the corpus grows,
// not scale with how many records already exist.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pageContentStorageStats, writePageContentExtracted } from './store.js';
import type { PageContentExtractedPayload } from './types.js';

const fillerPayload = (index: number): PageContentExtractedPayload => ({
  payloadVersion: 1,
  canonicalUrl: `https://byte-volume.example/${String(index)}`,
  url: `https://byte-volume.example/${String(index)}`,
  title: `Byte volume fixture ${String(index)}`,
  extractedAt: '2026-08-16T00:00:00.000Z',
  extractionSource: 'reader-mode',
  extractionPolicy: { trigger: 'manual' },
  quality: 'high',
  qualitySignals: {
    extractedWordCount: 200,
    contentToDomRatio: 0.6,
    boilerplateFraction: 0.1,
    extractionStrategy: 'reader-mode',
  },
  content: {
    text: `Fixture capture body text for byte-volume measurement, entry ${String(index)}. `.repeat(
      15,
    ),
    contentHash: `byte-volume-hash-${String(index)}`,
    charCount: 1200,
  },
});

describe('page-content capture write byte volume', () => {
  it('one capture writes roughly the same bytes whether 5 or 60 records already exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidetrack-page-content-byte-volume-'));
    try {
      for (let i = 0; i < 5; i += 1) {
        await writePageContentExtracted(root, fillerPayload(i));
      }
      const beforeEarly = (await pageContentStorageStats(root)).bytes;
      await writePageContentExtracted(root, fillerPayload(5));
      const afterEarly = (await pageContentStorageStats(root)).bytes;
      const deltaEarly = afterEarly - beforeEarly;

      for (let i = 6; i < 60; i += 1) {
        await writePageContentExtracted(root, fillerPayload(i));
      }
      const beforeLate = (await pageContentStorageStats(root)).bytes;
      await writePageContentExtracted(root, fillerPayload(60));
      const afterLate = (await pageContentStorageStats(root)).bytes;
      const deltaLate = afterLate - beforeLate;

      // An O(records) manifest rewrite would make deltaLate scale with
      // the corpus size (each write re-serializes every prior record).
      // Here both deltas cover only ONE capture's own rows, so they
      // stay in the same ballpark regardless of how many records
      // already existed — generous multiplicative + additive slack for
      // SQLite page-allocation noise, still far below a scale-with-N
      // regression (which would blow past this on corpus growth alone).
      expect(deltaLate).toBeLessThan(deltaEarly * 5 + 20_000);
      // And neither delta is anywhere near the old manifest-rewrite
      // scale (157KB, and growing, on the real test vault).
      expect(deltaEarly).toBeLessThan(50_000);
      expect(deltaLate).toBeLessThan(50_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
