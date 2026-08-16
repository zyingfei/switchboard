// F5 — one-time port of the legacy by-url/raw/chunks file layout into
// the single page-content.db SQLite store. Three contracts under test:
//   1. A synthetic old-layout vault ports with matching counts, is
//      readable through the normal store API afterward, and leaves the
//      legacy files untouched on disk.
//   2. A second "boot" (a fresh in-process db-handle, simulating a
//      process restart) does NOT re-port — no duplicate warning, same
//      data.
//   3. A stale/incomplete temp db left behind by a crashed prior port
//      attempt does not corrupt or block the next attempt — the port
//      discards it and rebuilds from the untouched legacy source.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetPageContentDbCacheForTests,
  pageContentCoverageCounts,
  pageContentDbPath,
  pageContentRoot,
  readPageContentChunksForCanonicalUrls,
  readPageContentCoverage,
  readPageContentExtractedPayloadForEvidence,
  sha256Hex,
} from './store.js';
import { PAGE_CONTENT_EXTRACTED, PAGE_CONTENT_TOMBSTONED } from './types.js';

const legacyByUrlDir = (root: string): string => join(pageContentRoot(root), 'by-url');
const legacyRawDir = (root: string): string => join(pageContentRoot(root), 'raw');
const legacyChunksDir = (root: string): string => join(pageContentRoot(root), 'chunks');

interface LegacyFixtureRecord {
  readonly canonicalUrl: string;
  readonly state: 'indexed' | 'tombstoned';
  readonly contentHash?: string;
  readonly text?: string;
}

/** Writes a synthetic legacy-layout vault: N indexed records (each with
 *  a matching raw text + chunks doc) plus one tombstoned record with no
 *  content. Mirrors exactly what the pre-F5 store.ts wrote to disk. */
const writeLegacyLayout = async (
  root: string,
  records: readonly LegacyFixtureRecord[],
): Promise<void> => {
  await mkdir(legacyByUrlDir(root), { recursive: true });
  await mkdir(legacyRawDir(root), { recursive: true });
  await mkdir(legacyChunksDir(root), { recursive: true });
  for (const record of records) {
    await writeFile(
      join(legacyByUrlDir(root), `${sha256Hex(record.canonicalUrl)}.json`),
      JSON.stringify({
        coverage: {
          canonicalUrl: record.canonicalUrl,
          state: record.state,
          ...(record.contentHash === undefined ? {} : { contentHash: record.contentHash }),
          ...(record.state === 'indexed'
            ? {
                quality: 'high',
                chunkCount: 1,
                indexedCharCount: record.text?.length ?? 0,
                extractionSource: 'reader-mode',
                qualitySignals: {
                  extractedWordCount: 200,
                  contentToDomRatio: 0.6,
                  boilerplateFraction: 0.1,
                  extractionStrategy: 'reader-mode',
                },
              }
            : {}),
        },
        url: record.canonicalUrl,
        title: `Title for ${record.canonicalUrl}`,
        updatedAt: '2026-08-16T00:00:00.000Z',
        sourceEventType: record.state === 'indexed' ? PAGE_CONTENT_EXTRACTED : PAGE_CONTENT_TOMBSTONED,
      }),
    );
    if (record.contentHash !== undefined && record.text !== undefined) {
      await writeFile(
        join(legacyRawDir(root), `${record.contentHash}.json`),
        JSON.stringify({
          version: 1,
          canonicalUrl: record.canonicalUrl,
          url: record.canonicalUrl,
          extractedAt: '2026-08-16T00:00:00.000Z',
          text: record.text,
        }),
      );
      await writeFile(
        join(legacyChunksDir(root), `${record.contentHash}.json`),
        JSON.stringify({
          version: 1,
          chunks: [
            {
              id: `${record.contentHash}:0`,
              canonicalUrl: record.canonicalUrl,
              url: record.canonicalUrl,
              contentHash: record.contentHash,
              chunkIndex: 0,
              charStart: 0,
              charEnd: record.text.length,
              text: record.text,
              extractedAt: '2026-08-16T00:00:00.000Z',
              quality: 'high',
              extractionStrategy: 'reader-mode',
            },
          ],
        }),
      );
    }
  }
};

const FIXTURE_RECORDS: readonly LegacyFixtureRecord[] = [
  { canonicalUrl: 'https://legacy.example/a', state: 'indexed', contentHash: 'hash-a', text: 'Legacy content A '.repeat(20) },
  { canonicalUrl: 'https://legacy.example/b', state: 'indexed', contentHash: 'hash-b', text: 'Legacy content B '.repeat(20) },
  { canonicalUrl: 'https://legacy.example/c', state: 'indexed', contentHash: 'hash-c', text: 'Legacy content C '.repeat(20) },
  { canonicalUrl: 'https://legacy.example/tombstoned', state: 'tombstoned' },
];

describe('page-content SQLite port', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-page-content-port-'));
  });

  afterEach(async () => {
    // Restore unconditionally (not a trailing mockRestore() in each test
    // body) so an assertion throwing mid-test can't leak a console.warn
    // mock into the next test.
    vi.restoreAllMocks();
    __resetPageContentDbCacheForTests(root);
    await rm(root, { recursive: true, force: true });
  });

  it('imports a synthetic old layout with matching counts, stays readable, and preserves the legacy files', async () => {
    await writeLegacyLayout(root, FIXTURE_RECORDS);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const counts = await pageContentCoverageCounts(root);

    expect(counts.total).toBe(FIXTURE_RECORDS.length);
    expect(counts.byState['indexed']).toBe(3);
    expect(counts.byState['tombstoned']).toBe(1);
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('ported legacy file layout to SQLite'),
      ),
    ).toBe(true);
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes('safe to delete')),
    ).toBe(true);

    // Readable through the normal API afterward.
    const coverage = await readPageContentCoverage(root, 'https://legacy.example/a');
    expect(coverage.state).toBe('indexed');
    expect(coverage.contentHash).toBe('hash-a');
    const extracted = await readPageContentExtractedPayloadForEvidence(
      root,
      'https://legacy.example/b',
    );
    expect(extracted?.content.text).toContain('Legacy content B');
    const chunks = await readPageContentChunksForCanonicalUrls(root, ['https://legacy.example/c']);
    expect(chunks.get('https://legacy.example/c')?.[0]?.text).toContain('Legacy content C');

    // The legacy files are left on disk — never deleted by this module.
    await expect(
      readFile(join(legacyByUrlDir(root), `${sha256Hex('https://legacy.example/a')}.json`), 'utf8'),
    ).resolves.toContain('https://legacy.example/a');
    await expect(readFile(join(legacyRawDir(root), 'hash-a.json'), 'utf8')).resolves.toContain(
      'Legacy content A',
    );

    warnSpy.mockRestore();
  });

  it('does not re-port on a second boot (fresh db-handle cache, same vault path)', async () => {
    await writeLegacyLayout(root, FIXTURE_RECORDS);
    await pageContentCoverageCounts(root); // first "boot": ports.

    // Simulate a process restart: drop the in-process db-handle cache
    // so the next call re-evaluates "does page-content.db exist" from
    // scratch — it does, so no port should run.
    __resetPageContentDbCacheForTests(root);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const counts = await pageContentCoverageCounts(root);

    expect(counts.total).toBe(FIXTURE_RECORDS.length);
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('ported legacy file layout to SQLite'),
      ),
    ).toBe(false);

    warnSpy.mockRestore();
  });

  it('resumes/restarts safely when a stale temp db is left behind by a crashed prior port attempt', async () => {
    await writeLegacyLayout(root, FIXTURE_RECORDS);
    // Simulate a crash partway through a prior port: an abandoned,
    // garbage temp file at the exact path portLegacyPageContent uses.
    const tmpPath = `${pageContentDbPath(root)}.porting.tmp`;
    await mkdir(pageContentRoot(root), { recursive: true });
    await writeFile(tmpPath, 'not a valid sqlite file, left over from a crash');
    await writeFile(`${tmpPath}-wal`, 'garbage wal sidecar');

    const counts = await pageContentCoverageCounts(root);

    // The port discarded the stale temp file and rebuilt cleanly from
    // the untouched legacy source — full, correct counts, no crash.
    expect(counts.total).toBe(FIXTURE_RECORDS.length);
    expect(counts.byState['indexed']).toBe(3);
    const extracted = await readPageContentExtractedPayloadForEvidence(
      root,
      'https://legacy.example/a',
    );
    expect(extracted?.content.text).toContain('Legacy content A');
  });

  it('a fresh vault with no legacy layout creates the store directly (no port)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const counts = await pageContentCoverageCounts(root);

    expect(counts.total).toBe(0);
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes('ported legacy file layout')),
    ).toBe(false);

    warnSpy.mockRestore();
  });
});
