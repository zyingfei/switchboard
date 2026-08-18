import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { installStubEmbedder, type StubEmbedderHandle } from '../test-helpers/stubEmbedder.js';
import { setEmbedderOverride } from '../recall/embedder.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { appendContentEnrichmentEvent, resetGistLookupMemoForTest } from './contentEnrichment.js';
import { createKeywordConceptStore } from './keywordConceptStore.js';
import {
  ingestGistKeywords,
  repairDegenerateKeywordConcepts,
  resetDegenerateLogThrottleForTest,
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
    resetDegenerateLogThrottleForTest();
  });

  afterEach(async () => {
    stub.restore();
    resetKeywordIngestHandlesForTest();
    resetGistLookupMemoForTest();
    resetDegenerateLogThrottleForTest();
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

// ---------------------------------------------------------------------------
// 2026-08-17 incident regressions — a live vault collapsed 360 distinct
// keywords into ONE concept (concepts=1). Root cause: the real
// multilingual-e5-small embedder, on bare single-word keyword inputs,
// produces a baseline pairwise-cosine noise floor (~0.78-0.87) that fully
// overlapped the old 0.82 assignment threshold, and the greedy online-
// leader clustering + running-mean centroid self-reinforced the collapse.
// See keywordConcepts.ts's THRESHOLD comment for the full measured
// evidence. These tests cover: (1) the guard that makes a degenerate
// EMBEDDING (unusable, or suspiciously constant across keywords) audible
// and non-merging instead of silent, (2) the ongoing audible guard for a
// degenerate CONCEPT DISTRIBUTION, (3) that genuinely distinct keywords
// still resolve to multiple concepts through the real deterministic test
// embedder (SIDETRACK_TEST_EMBEDDER=1 — same precedent
// http/prototypeLaneWiring.test.ts uses to avoid loading the 100+MB HF
// model in CI), and (4) the one-time self-heal repair.
// ---------------------------------------------------------------------------
describe('keywordIngest — degenerate-embedding guards (2026-08-17 incident)', () => {
  let vaultRoot: string;
  let stub: StubEmbedderHandle;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'keyword-ingest-degenerate-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    stub = installStubEmbedder({ shape: 'per-text-axis' });
    resetKeywordIngestHandlesForTest();
    resetGistLookupMemoForTest();
    resetDegenerateLogThrottleForTest();
  });

  afterEach(async () => {
    stub.restore();
    setEmbedderOverride(undefined);
    resetKeywordIngestHandlesForTest();
    resetGistLookupMemoForTest();
    resetDegenerateLogThrottleForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  sqliteIt('an all-zero embedding is skipped (never assigned) and logged audibly', async () => {
    stub.restore();
    setEmbedderOverride(async (texts) =>
      texts.map((text) => {
        const v = new Float32Array(384);
        if (!text.includes('zeroedout')) v[0] = 1; // every OTHER keyword embeds normally
        return v;
      }),
    );
    const lines: string[] = [];
    const result = await ingestGistKeywords(
      vaultRoot,
      'url',
      'https://a.example/',
      'Keywords: zeroedout, normalword',
      100,
      (message) => lines.push(message),
    );
    expect(result.ingested).toBe(true);

    const concepts = await createKeywordConceptStore(vaultRoot);
    try {
      expect(concepts.hasKeyword('zeroedout')).toBe(false); // skipped — never invented
      expect(concepts.hasKeyword('normalword')).toBe(true);
    } finally {
      concepts.close();
    }
    expect(
      lines.some((line) => line.includes('degenerate (all-zero/non-finite) embedding')),
    ).toBe(true);
  });

  sqliteIt('an embedder returning IDENTICAL vectors for distinct keywords is skipped and logged, not merged', async () => {
    stub.restore();
    const constantStub = installStubEmbedder({ shape: 'unit-axis-0' });
    try {
      const lines: string[] = [];
      const result = await ingestGistKeywords(
        vaultRoot,
        'url',
        'https://a.example/',
        'Keywords: kubernetes, sourdough, visa',
        100,
        (message) => lines.push(message),
      );
      expect(result.ingested).toBe(true);

      const concepts = await createKeywordConceptStore(vaultRoot);
      try {
        // NONE assigned — a degraded embedder must never be allowed to
        // merge distinct keywords into a shared concept.
        expect(concepts.stats().distinctKeywords).toBe(0);
      } finally {
        concepts.close();
      }
      expect(lines.some((line) => line.includes('IDENTICAL vectors'))).toBe(true);
    } finally {
      constantStub.restore();
    }
  });

  sqliteIt('the concept-distribution guard fires once enough keywords collapse into ONE concept across separate ingest calls', async () => {
    stub.restore();
    // A per-call batch of size 1 never trips isIdenticalVectorBatch (needs
    // 2+), so this exercises the DISTRIBUTION-level guard specifically —
    // distinct from the single-batch identical-vector guard above.
    const constantStub = installStubEmbedder({ shape: 'unit-axis-0' });
    try {
      const lines: string[] = [];
      for (let i = 0; i < 25; i += 1) {
        await ingestGistKeywords(
          vaultRoot,
          'url',
          `https://p${String(i)}.example/`,
          `Keywords: kw${String(i)}`,
          100 + i,
          (message) => lines.push(message),
        );
      }
      const concepts = await createKeywordConceptStore(vaultRoot);
      try {
        expect(concepts.stats().distinctKeywords).toBe(25);
        expect(concepts.stats().distinctConcepts).toBe(1); // the exact live-incident shape
      } finally {
        concepts.close();
      }
      expect(
        lines.some((line) => line.includes('concept distribution looks collapsed')),
      ).toBe(true);
    } finally {
      constantStub.restore();
    }
  });

  sqliteIt(
    'distinct real-ish keywords resolve to MULTIPLE concepts through the real deterministic test embedder (SIDETRACK_TEST_EMBEDDER=1)',
    async () => {
      // Fall through to the REAL embed() path (no override) — same
      // CI-safe deterministic embedder precedent as
      // http/prototypeLaneWiring.test.ts, avoiding the 100+MB ONNX model
      // download while still exercising the actual assignConceptForKeyword
      // / foldConceptMember call path this incident lives in.
      stub.restore();
      const priorTestEmbedder = process.env['SIDETRACK_TEST_EMBEDDER'];
      process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
      try {
        // KEYWORD_MAX_PER_GIST caps a single gist at 10 keywords — split
        // 20 genuinely distinct real-ish keywords across two pages.
        await ingestGistKeywords(
          vaultRoot,
          'url',
          'https://a.example/',
          'Keywords: database, docker, duckdb, sqlite, sliding, window, algorithms, substring, americans, android',
          100,
        );
        await ingestGistKeywords(
          vaultRoot,
          'url',
          'https://b.example/',
          'Keywords: binance, cloudflare, anthropic, llms, reasoning, agents, security, network, github, documentation',
          200,
        );
        const concepts = await createKeywordConceptStore(vaultRoot);
        try {
          expect(concepts.stats().distinctKeywords).toBe(20);
          // The exact failure this incident produced was ALL 20 in ONE
          // concept — assert comfortably past that floor.
          expect(concepts.stats().distinctConcepts).toBeGreaterThan(10);
        } finally {
          concepts.close();
        }
      } finally {
        if (priorTestEmbedder === undefined) delete process.env['SIDETRACK_TEST_EMBEDDER'];
        else process.env['SIDETRACK_TEST_EMBEDDER'] = priorTestEmbedder;
      }
    },
  );
});

describe('repairDegenerateKeywordConcepts — one-time self-heal', () => {
  let vaultRoot: string;
  let stub: StubEmbedderHandle;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'keyword-ingest-repair-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    stub = installStubEmbedder({ shape: 'unit-axis-0' }); // seeds the DEGENERATE state
    resetKeywordIngestHandlesForTest();
    resetGistLookupMemoForTest();
    resetDegenerateLogThrottleForTest();
  });

  afterEach(async () => {
    stub.restore();
    setEmbedderOverride(undefined);
    resetKeywordIngestHandlesForTest();
    resetGistLookupMemoForTest();
    resetDegenerateLogThrottleForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  sqliteIt('is a no-op when the concept distribution is already healthy', async () => {
    stub.restore();
    const healthyStub = installStubEmbedder({ shape: 'per-text-axis' });
    try {
      await ingestGistKeywords(
        vaultRoot,
        'url',
        'https://a.example/',
        'Keywords: kubernetes, docker, sourdough',
        100,
      );
      const keywordIndex = await createKeywordIndexStore(vaultRoot);
      const concepts = await createKeywordConceptStore(vaultRoot);
      try {
        const before = concepts.stats();
        const result = await repairDegenerateKeywordConcepts(vaultRoot, keywordIndex, concepts, () => undefined);
        expect(result.repaired).toBe(false);
        expect(concepts.stats()).toEqual(before);
      } finally {
        keywordIndex.close();
        concepts.close();
      }
    } finally {
      healthyStub.restore();
    }
  });

  sqliteIt(
    'resets and reassigns a degenerate concept distribution, producing multiple sane concepts',
    async () => {
      // Seed the EXACT live-incident shape via the direct store API
      // (bypassing ingestGistKeywords's now-guarded path, which would
      // itself refuse to create this state) — 30 distinct keywords, a
      // couple of pages, all landing in concept-1 via a constant-vector
      // embedder, mirroring the real vault's 360-keywords/1-concept
      // finding at smaller scale.
      const keywordIndex = await createKeywordIndexStore(vaultRoot);
      const concepts = await createKeywordConceptStore(vaultRoot);
      const keywords = Array.from({ length: 30 }, (_, i) => `keyword${String(i)}`);
      try {
        keywordIndex.upsertPageKeywords('url:https://a.example/', keywords.slice(0, 15), 'llm', 100);
        keywordIndex.upsertPageKeywords('url:https://b.example/', keywords.slice(15), 'llm', 200);
        const constant = new Float32Array(384);
        constant[0] = 1;
        for (const keyword of keywords) {
          concepts.assignKeyword(keyword, constant, 100);
        }
        expect(concepts.stats()).toEqual({ distinctKeywords: 30, distinctConcepts: 1 });

        // Repair with a DISCRIMINATIVE embedder installed — the healthy
        // path an operator would actually be running under.
        stub.restore();
        const healthyStub = installStubEmbedder({ shape: 'per-text-axis' });
        try {
          const lines: string[] = [];
          const result = await repairDegenerateKeywordConcepts(
            vaultRoot,
            keywordIndex,
            concepts,
            (message) => lines.push(message),
          );
          expect(result.repaired).toBe(true);
          expect(result.distinctKeywordsBefore).toBe(30);
          expect(result.distinctConceptsBefore).toBe(1);
          expect(result.distinctConceptsAfter).toBeGreaterThan(10);
          expect(concepts.stats().distinctKeywords).toBe(30);
          expect(concepts.stats().distinctConcepts).toBe(result.distinctConceptsAfter);
          expect(lines.some((line) => line.includes('repair complete'))).toBe(true);
        } finally {
          healthyStub.restore();
        }
      } finally {
        keywordIndex.close();
        concepts.close();
      }
    },
  );

  sqliteIt('aborts (leaves tables reset, not re-collapsed) when the embedder is STILL degenerate at repair time', async () => {
    const keywordIndex = await createKeywordIndexStore(vaultRoot);
    const concepts = await createKeywordConceptStore(vaultRoot);
    const keywords = Array.from({ length: 25 }, (_, i) => `keyword${String(i)}`);
    try {
      keywordIndex.upsertPageKeywords('url:https://a.example/', keywords, 'llm', 100);
      const constant = new Float32Array(384);
      constant[0] = 1;
      for (const keyword of keywords) {
        concepts.assignKeyword(keyword, constant, 100);
      }
      expect(concepts.stats().distinctConcepts).toBe(1);

      // stub is STILL the degenerate 'unit-axis-0' shape at repair time —
      // the repair must recognize this and abort rather than reassigning
      // everything right back into one concept.
      const lines: string[] = [];
      const result = await repairDegenerateKeywordConcepts(
        vaultRoot,
        keywordIndex,
        concepts,
        (message) => lines.push(message),
      );
      expect(result.repaired).toBe(true);
      expect(result.aborted).toBe('identical-vectors');
      expect(concepts.stats().distinctKeywords).toBe(0); // reset, not re-collapsed
      expect(lines.some((line) => line.includes('aborting reassignment'))).toBe(true);
    } finally {
      keywordIndex.close();
      concepts.close();
    }
  });
});
