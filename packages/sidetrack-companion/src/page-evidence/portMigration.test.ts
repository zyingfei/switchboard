// F5 — one-time port of the legacy by-url/*.json layout into the
// single page-evidence.db SQLite store. Mirrors page-content's port
// test suite (page-content/portMigration.test.ts) — see that file's
// header for the three contracts under test (counts match, no re-port
// on a second boot, safe resume after a crashed prior attempt).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetPageEvidenceDbCacheForTests,
  listPageEvidenceRecords,
  pageEvidenceDbPath,
  pageEvidenceHash,
  pageEvidenceRoot,
  readPageEvidence,
} from './store.js';
import { PAGE_EVIDENCE_SCHEMA_VERSION } from './types.js';

const legacyByUrlDir = (root: string): string => join(pageEvidenceRoot(root), 'by-url');

interface LegacyFixtureRecord {
  readonly canonicalUrl: string;
  readonly title: string;
  readonly contentHash?: string;
}

const legacyRecordJson = (record: LegacyFixtureRecord): string =>
  JSON.stringify({
    schemaVersion: PAGE_EVIDENCE_SCHEMA_VERSION,
    canonicalUrl: record.canonicalUrl,
    semanticFeatureRevision: 'rev-1',
    behaviorMetadataRevision: 'rev-1',
    evidenceRevision: 'rev-1',
    updatedAt: '2026-08-16T00:00:00.000Z',
    evidenceTier: record.contentHash === undefined ? 'metadata_only' : 'indexed_chunks',
    versions: {
      extractionCodeVersion: 'page-evidence-extract-v1',
      tokenizerVersion: 'page-evidence-tokenizer-v5',
      featureSchemaVersion: 1,
    },
    metadata: { title: record.title, host: 'legacy.example', pathTokens: [], titleTokens: [] },
    ...(record.contentHash === undefined
      ? {}
      : {
          content: {
            contentHash: record.contentHash,
            extractionSource: 'reader-mode',
            quality: 'high',
            qualitySignals: {
              extractedWordCount: 300,
              contentToDomRatio: 0.6,
              boilerplateFraction: 0.1,
              extractionStrategy: 'reader-mode',
            },
            terms: [],
            keyphrases: [],
            entities: [],
          },
        }),
    provenance: { sources: ['page-content'] },
  });

const writeLegacyLayout = async (
  root: string,
  records: readonly LegacyFixtureRecord[],
): Promise<void> => {
  await mkdir(legacyByUrlDir(root), { recursive: true });
  for (const record of records) {
    await writeFile(
      join(legacyByUrlDir(root), `${pageEvidenceHash(record.canonicalUrl)}.json`),
      legacyRecordJson(record),
    );
  }
};

const FIXTURE_RECORDS: readonly LegacyFixtureRecord[] = [
  { canonicalUrl: 'https://legacy-evidence.example/a', title: 'A', contentHash: 'hash-a' },
  { canonicalUrl: 'https://legacy-evidence.example/b', title: 'B', contentHash: 'hash-b' },
  { canonicalUrl: 'https://legacy-evidence.example/c', title: 'C' },
];

describe('page-evidence SQLite port', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-page-evidence-port-'));
  });

  afterEach(async () => {
    // Restore unconditionally so an assertion throwing mid-test can't
    // leak a console.warn mock into the next test.
    vi.restoreAllMocks();
    __resetPageEvidenceDbCacheForTests(root);
    await rm(root, { recursive: true, force: true });
  });

  it('imports a synthetic old layout with matching counts, stays readable, and preserves the legacy files', async () => {
    await writeLegacyLayout(root, FIXTURE_RECORDS);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const records = await listPageEvidenceRecords(root);

    expect(records).toHaveLength(FIXTURE_RECORDS.length);
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('ported legacy file layout to SQLite'),
      ),
    ).toBe(true);

    const a = await readPageEvidence(root, 'https://legacy-evidence.example/a');
    expect(a.record?.evidenceTier).toBe('indexed_chunks');
    expect(a.record?.content?.contentHash).toBe('hash-a');
    const c = await readPageEvidence(root, 'https://legacy-evidence.example/c');
    expect(c.record?.evidenceTier).toBe('metadata_only');

    // The legacy files are left on disk — never deleted by this module.
    await expect(
      readFile(
        join(legacyByUrlDir(root), `${pageEvidenceHash('https://legacy-evidence.example/a')}.json`),
        'utf8',
      ),
    ).resolves.toContain('https://legacy-evidence.example/a');

    warnSpy.mockRestore();
  });

  it('does not re-port on a second boot (fresh db-handle cache, same vault path)', async () => {
    await writeLegacyLayout(root, FIXTURE_RECORDS);
    await listPageEvidenceRecords(root); // first "boot": ports.

    __resetPageEvidenceDbCacheForTests(root);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const records = await listPageEvidenceRecords(root);

    expect(records).toHaveLength(FIXTURE_RECORDS.length);
    expect(
      warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('ported legacy file layout to SQLite'),
      ),
    ).toBe(false);

    warnSpy.mockRestore();
  });

  it('resumes/restarts safely when a stale temp db is left behind by a crashed prior port attempt', async () => {
    await writeLegacyLayout(root, FIXTURE_RECORDS);
    const tmpPath = `${pageEvidenceDbPath(root)}.porting.tmp`;
    await mkdir(pageEvidenceRoot(root), { recursive: true });
    await writeFile(tmpPath, 'not a valid sqlite file, left over from a crash');
    await writeFile(`${tmpPath}-wal`, 'garbage wal sidecar');

    const records = await listPageEvidenceRecords(root);

    expect(records).toHaveLength(FIXTURE_RECORDS.length);
    const a = await readPageEvidence(root, 'https://legacy-evidence.example/a');
    expect(a.record?.content?.contentHash).toBe('hash-a');
  });

  it('a fresh vault with no legacy layout creates the store directly (no port)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const records = await listPageEvidenceRecords(root);

    expect(records).toHaveLength(0);
    expect(
      warnSpy.mock.calls.some((call) => String(call[0]).includes('ported legacy file layout')),
    ).toBe(false);

    warnSpy.mockRestore();
  });
});
