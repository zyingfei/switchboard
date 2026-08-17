import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { createKeywordIndexStore } from '../search-index/keywordIndexStore.js';
import { createKeywordConceptStore } from '../enrichment/keywordConceptStore.js';
import {
  peekPrototypeKeywordConceptIds,
  resetPrototypeKeywordLaneLookupForTest,
  warmPrototypeKeywordLayer,
} from './prototypeKeywordLaneLookup.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

describe('prototypeKeywordLaneLookup — request-time cache (mirrors peekRecallV2Store)', () => {
  let vaultRoot: string;

  afterEach(async () => {
    resetPrototypeKeywordLaneLookupForTest();
    if (vaultRoot !== undefined) await rm(vaultRoot, { recursive: true, force: true });
  });

  it('returns undefined (never throws) before the layer has been warmed', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-proto-kw-lookup-'));
    const result = await peekPrototypeKeywordConceptIds(vaultRoot, 'https://a.test/1');
    expect(result).toBeUndefined();
  });

  sqliteIt('resolves a page\'s concept ids once the layer is warm and the page is indexed', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-proto-kw-lookup-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });

    // Seed the real stores directly (same files warmPrototypeKeywordLayer
    // will open) — canonicalUrl page-key convention: 'url:<canonicalUrl>'.
    const indexStore = await createKeywordIndexStore(vaultRoot);
    indexStore.upsertPageKeywords('url:https://a.test/1', ['duckdb', 'olap'], 'deterministic', 1000);
    indexStore.close();
    const conceptStore = await createKeywordConceptStore(vaultRoot);
    conceptStore.assignKeyword('duckdb', new Float32Array([1, 0, 0]), 1000);
    conceptStore.assignKeyword('olap', new Float32Array([0, 1, 0]), 1000);
    conceptStore.close();

    warmPrototypeKeywordLayer(vaultRoot);
    const result = await peekPrototypeKeywordConceptIds(vaultRoot, 'https://a.test/1');
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
  });

  sqliteIt('a page never indexed by the keyword layer resolves to undefined, not []', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-proto-kw-lookup-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    warmPrototypeKeywordLayer(vaultRoot);
    const result = await peekPrototypeKeywordConceptIds(vaultRoot, 'https://a.test/never-indexed');
    expect(result).toBeUndefined();
  });

  it('warming twice for the same vaultRoot is idempotent (does not reopen)', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-proto-kw-lookup-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    warmPrototypeKeywordLayer(vaultRoot);
    warmPrototypeKeywordLayer(vaultRoot);
    // No throw, no hang — the second call is a no-op cache hit.
    await peekPrototypeKeywordConceptIds(vaultRoot, 'https://a.test/1');
  });
});
