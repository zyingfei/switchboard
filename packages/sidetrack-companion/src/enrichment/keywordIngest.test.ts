import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { installStubEmbedder, type StubEmbedderHandle } from '../test-helpers/stubEmbedder.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { appendContentEnrichmentEvent, resetGistLookupMemoForTest } from './contentEnrichment.js';
import { createKeywordConceptStore } from './keywordConceptStore.js';
import {
  ingestGistKeywords,
  resetKeywordIngestHandlesForTest,
  resyncGistKeywordsAfterRetraction,
} from './keywordIngest.js';
import { appendEnrichmentRetractionEvent } from './enrichmentRetraction.js';
import { createKeywordIndexStore } from '../search-index/keywordIndexStore.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

describe('keywordIngest', () => {
  let vaultRoot: string;
  let stub: StubEmbedderHandle;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'keyword-ingest-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    stub = installStubEmbedder({ shape: 'per-text-axis' });
    resetKeywordIngestHandlesForTest();
    resetGistLookupMemoForTest();
  });

  afterEach(async () => {
    stub.restore();
    resetKeywordIngestHandlesForTest();
    resetGistLookupMemoForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  sqliteIt('extracts, indexes, and concept-assigns keywords for a freshly-accepted gist', async () => {
    const gist =
      'Kubernetes orchestrates containers across a cluster of machines automatically.\n' +
      'Keywords: kubernetes, containers, orchestration';
    const result = await ingestGistKeywords(vaultRoot, 'url', 'https://a.example/', gist, 100);
    expect(result.ingested).toBe(true);
    expect(result.keywords).toEqual(['kubernetes', 'containers', 'orchestration']);
    expect(result.newConcepts).toBe(3);

    const index = await createKeywordIndexStore(vaultRoot);
    try {
      expect(index.keywordsForPage('url:https://a.example/')).toEqual([
        'kubernetes',
        'containers',
        'orchestration',
      ]);
    } finally {
      index.close();
    }

    const concepts = await createKeywordConceptStore(vaultRoot);
    try {
      expect(concepts.conceptForKeyword('kubernetes')).toBeDefined();
      expect(concepts.stats().distinctKeywords).toBe(3);
    } finally {
      concepts.close();
    }
  });

  sqliteIt('is a no-op when SIDETRACK_KEYWORD_INGEST is disabled', async () => {
    process.env['SIDETRACK_KEYWORD_INGEST'] = '0';
    try {
      const result = await ingestGistKeywords(vaultRoot, 'url', 'https://a.example/', 'Keywords: a, b, c', 100);
      expect(result.ingested).toBe(false);
      expect(result.keywords).toEqual([]);
    } finally {
      delete process.env['SIDETRACK_KEYWORD_INGEST'];
    }
  });

  sqliteIt('does not re-embed a keyword already assigned to a concept (idempotent across pages)', async () => {
    await ingestGistKeywords(vaultRoot, 'url', 'https://a.example/', 'Keywords: rust, ownership', 100);
    stub.reset();
    await ingestGistKeywords(vaultRoot, 'url', 'https://b.example/', 'Keywords: rust, borrowing', 200);
    // Only the NEW keyword ("borrowing") should have been embedded — "rust"
    // was already assigned by the first call. embed() applies the e5
    // "query: " input-prefix policy before the model sees the text, so the
    // recorded call text carries that prefix.
    const embeddedTexts = stub.calls.flatMap((c) => c.texts);
    expect(embeddedTexts).toEqual(['query: borrowing']);
  });

  sqliteIt('re-syncs the keyword index after a retraction withdraws the standing gist', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog: EventLog = createEventLog(vaultRoot, replica);
    await appendContentEnrichmentEvent(eventLog, {
      payloadVersion: 1,
      kind: 'url',
      id: 'https://a.example/',
      gist: 'A degenerate repeated gist.\nKeywords: bad, keywords, here',
      sourceContentHash: 'h1',
      model: 'gemma-3-1b-it',
      generatedAt: '2026-08-16T00:00:00.000Z',
    });
    await ingestGistKeywords(
      vaultRoot,
      'url',
      'https://a.example/',
      'A degenerate repeated gist.\nKeywords: bad, keywords, here',
      100,
    );
    const indexBefore = await createKeywordIndexStore(vaultRoot);
    try {
      expect(indexBefore.hasPage('url:https://a.example/')).toBe(true);
    } finally {
      indexBefore.close();
    }

    await appendEnrichmentRetractionEvent(eventLog, {
      payloadVersion: 1,
      family: 'content',
      kind: 'url',
      id: 'https://a.example/',
      reason: 'degenerate output',
      retractedAt: '2026-08-16T00:05:00.000Z',
    });
    resetGistLookupMemoForTest();
    await resyncGistKeywordsAfterRetraction(vaultRoot, eventLog, 'url', 'https://a.example/', 200);

    const indexAfter = await createKeywordIndexStore(vaultRoot);
    try {
      expect(indexAfter.keywordsForPage('url:https://a.example/')).toBeUndefined();
    } finally {
      indexAfter.close();
    }
  });

  sqliteIt('re-syncs to the SURVIVING gist when a hash-scoped retraction targets an old revision', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog: EventLog = createEventLog(vaultRoot, replica);
    await appendContentEnrichmentEvent(eventLog, {
      payloadVersion: 1,
      kind: 'url',
      id: 'https://a.example/',
      gist: 'First revision gist.\nKeywords: first, revision',
      sourceContentHash: 'h1',
      model: 'gemma-3-1b-it',
      generatedAt: '2026-08-16T00:00:00.000Z',
    });
    await appendContentEnrichmentEvent(eventLog, {
      payloadVersion: 1,
      kind: 'url',
      id: 'https://a.example/',
      gist: 'Second revision gist.\nKeywords: second, revision',
      sourceContentHash: 'h2',
      model: 'gemma-3-1b-it',
      generatedAt: '2026-08-16T00:10:00.000Z',
    });
    await appendEnrichmentRetractionEvent(eventLog, {
      payloadVersion: 1,
      family: 'content',
      kind: 'url',
      id: 'https://a.example/',
      sourceContentHash: 'h1', // scoped to the OLD revision — the new one survives
      reason: 'old revision was degenerate',
      retractedAt: '2026-08-16T00:20:00.000Z',
    });
    resetGistLookupMemoForTest();
    await resyncGistKeywordsAfterRetraction(vaultRoot, eventLog, 'url', 'https://a.example/', 300);

    const index = await createKeywordIndexStore(vaultRoot);
    try {
      expect(index.keywordsForPage('url:https://a.example/')).toEqual(['second', 'revision']);
    } finally {
      index.close();
    }
  });
});
