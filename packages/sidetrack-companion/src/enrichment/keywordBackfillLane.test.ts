import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEYWORD_BACKFILL_ENV,
  createKeywordBackfillLane,
  keywordBackfillCandidatesFromGistLookup,
  keywordBackfillEnabled,
  scheduleKeywordBackfillLoop,
  type KeywordBackfillCandidate,
  type KeywordBackfillLaneDeps,
  type KeywordBackfillProgress,
} from './keywordBackfillLane.js';
import { appendContentEnrichmentEvent } from './contentEnrichment.js';
import type { GistLookup } from './contentEnrichment.js';
import { createKeywordConceptStore } from './keywordConceptStore.js';
import { createKeywordIndexStore } from '../search-index/keywordIndexStore.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { setEmbedderOverride } from '../recall/embedder.js';
import { hybridSimilarity, type SuggestionEvidenceItem } from '../workstreams/splitSuggestionEngine.js';

// A CONTENT-hash embedder, not the shared installStubEmbedder's per-BATCH-
// position shape: ingestGistKeywords calls embed() once per page's newly-
// unassigned keywords, so a position-indexed stub (axis = index within that
// one call) would assign the SAME axis to unrelated keywords from different
// pages purely by call-order coincidence, breaking concept differentiation
// across pages. Hashing the keyword TEXT itself gives the same keyword the
// same axis every time it is embedded, regardless of which call/batch it
// falls in — the property this e2e test's cross-topic assertion needs.
const contentHashVector = (text: string): Float32Array => {
  const v = new Float32Array(384);
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  v[hash % 384] = 1;
  return v;
};

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const candidate = (n: number): KeywordBackfillCandidate => ({
  pageKey: `url:https://p${String(n)}.example/`,
  kind: 'url',
  id: `https://p${String(n)}.example/`,
  gist: `Gist number ${String(n)} about a topic.`,
});

interface Harness {
  readonly deps: KeywordBackfillLaneDeps;
  readonly indexedPageKeys: string[];
  readonly indexCalls: { count: number };
  progressStore: KeywordBackfillProgress | null;
}

const makeHarness = (
  candidates: readonly KeywordBackfillCandidate[],
  options?: { readonly failFor?: ReadonlySet<string> },
): Harness => {
  const indexedPageKeys: string[] = [];
  const indexCalls = { count: 0 };
  let progressStore: KeywordBackfillProgress | null = null;
  const deps: KeywordBackfillLaneDeps = {
    listCandidates: async () => candidates,
    hasIndexed: async (pageKey) => indexedPageKeys.includes(pageKey),
    indexCandidate: async (c) => {
      indexCalls.count += 1;
      if (options?.failFor?.has(c.pageKey) === true) {
        throw new Error(`simulated failure for ${c.pageKey}`);
      }
      indexedPageKeys.push(c.pageKey);
    },
    readProgress: async () => progressStore,
    writeProgress: async (progress) => {
      progressStore = progress;
    },
  };
  return { deps, indexedPageKeys, indexCalls, progressStore };
};

describe('createKeywordBackfillLane — boundedness', () => {
  it('never indexes more than batchCap candidates in one cycle, even with a much larger backlog', async () => {
    const candidates = Array.from({ length: 500 }, (_, i) => candidate(i));
    const harness = makeHarness(candidates);
    const lane = createKeywordBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    const result = await lane.runOnce();
    expect(result.scanned).toBe(500);
    expect(result.backlog).toBe(500);
    expect(result.indexed).toBe(20);
    expect(harness.indexCalls.count).toBe(20);
  });

  it('is idempotent — a page already indexed (hasIndexed=true) is never re-processed', async () => {
    const candidates = [candidate(0), candidate(1), candidate(2)];
    const harness = makeHarness(candidates);
    harness.indexedPageKeys.push(candidate(0).pageKey);
    const lane = createKeywordBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    const result = await lane.runOnce();
    expect(result.backlog).toBe(2); // candidate(0) excluded
    expect(harness.indexCalls.count).toBe(2);
  });

  it('makes forward progress across multiple bounded cycles until the backlog is exhausted', async () => {
    const candidates = Array.from({ length: 45 }, (_, i) => candidate(i));
    const harness = makeHarness(candidates);
    const lane = createKeywordBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    const first = await lane.runOnce();
    expect(first.indexed).toBe(20);
    const second = await lane.runOnce();
    expect(second.indexed).toBe(20);
    const third = await lane.runOnce();
    expect(third.indexed).toBe(5);
    const fourth = await lane.runOnce();
    expect(fourth.backlog).toBe(0);
    expect(fourth.indexed).toBe(0);
    expect(lane.progress().processedTotal).toBe(45);
  });
});

describe('createKeywordBackfillLane — persisted progress', () => {
  it('persists processedTotal across runs and it survives a fresh lane instance reading it back', async () => {
    const candidates = [candidate(0), candidate(1)];
    const harness = makeHarness(candidates);
    const lane = createKeywordBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    await lane.runOnce();
    expect(lane.progress().processedTotal).toBe(2);

    // A FRESH lane instance sharing the same readProgress/writeProgress deps
    // resumes from the persisted counter rather than starting at 0.
    const secondLane = createKeywordBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    await secondLane.runOnce(); // no new candidates left (both already indexed)
    expect(secondLane.progress().processedTotal).toBe(2);
  });

  it('quarantines a page after maxAttemptsPerPage consecutive failures and never retries it again', async () => {
    const target = candidate(0);
    const harness = makeHarness([target], { failFor: new Set([target.pageKey]) });
    const lane = createKeywordBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 2,
    });
    const first = await lane.runOnce();
    expect(first.failed).toBe(1);
    const second = await lane.runOnce();
    expect(second.failed).toBe(1);
    expect(second.quarantined).toBe(1);
    // Third cycle: the page is quarantined and excluded from backlog
    // entirely — never retried, never counted as scanned-but-failed again.
    const third = await lane.runOnce();
    expect(third.backlog).toBe(0);
    expect(third.failed).toBe(0);
    expect(harness.indexCalls.count).toBe(2); // exactly maxAttemptsPerPage
  });

  it('a successful index clears any prior failure count for that page', async () => {
    const target = candidate(0);
    let shouldFail = true;
    const indexedPageKeys: string[] = [];
    let progressStore: KeywordBackfillProgress | null = null;
    const deps: KeywordBackfillLaneDeps = {
      listCandidates: async () => [target],
      hasIndexed: async (pageKey) => indexedPageKeys.includes(pageKey),
      indexCandidate: async () => {
        if (shouldFail) throw new Error('transient');
        indexedPageKeys.push(target.pageKey);
      },
      readProgress: async () => progressStore,
      writeProgress: async (progress) => {
        progressStore = progress;
      },
    };
    const lane = createKeywordBackfillLane(deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 5,
    });
    await lane.runOnce();
    expect(lane.progress().attemptsByPageKey[target.pageKey]).toBe(1);
    shouldFail = false;
    await lane.runOnce();
    expect(lane.progress().attemptsByPageKey[target.pageKey]).toBeUndefined();
  });
});

describe('keywordBackfillCandidatesFromGistLookup', () => {
  it('sorts most-recent-first and respects the limit', () => {
    const lookup: GistLookup = new Map([
      ['url:https://old.example/', { gist: 'old', sourceContentHash: 'h1', generatedAt: '2026-01-01T00:00:00.000Z' }],
      ['url:https://newest.example/', { gist: 'newest', sourceContentHash: 'h2', generatedAt: '2026-08-16T00:00:00.000Z' }],
      ['url:https://mid.example/', { gist: 'mid', sourceContentHash: 'h3', generatedAt: '2026-04-01T00:00:00.000Z' }],
    ]);
    const result = keywordBackfillCandidatesFromGistLookup(lookup, 2);
    expect(result.map((c) => c.id)).toEqual(['https://newest.example/', 'https://mid.example/']);
  });

  it('skips keys that do not parse as a known (kind,id) pair', () => {
    const lookup: GistLookup = new Map([
      ['not-a-valid-key', { gist: 'x', sourceContentHash: 'h1', generatedAt: '2026-01-01T00:00:00.000Z' }],
      ['url:https://ok.example/', { gist: 'ok', sourceContentHash: 'h2', generatedAt: '2026-01-02T00:00:00.000Z' }],
    ]);
    const result = keywordBackfillCandidatesFromGistLookup(lookup, 10);
    expect(result.length).toBe(1);
    expect(result[0]?.id).toBe('https://ok.example/');
  });
});

describe('keywordBackfillEnabled — env flag', () => {
  const prev = process.env[KEYWORD_BACKFILL_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[KEYWORD_BACKFILL_ENV];
    else process.env[KEYWORD_BACKFILL_ENV] = prev;
  });

  it('defaults to enabled when unset', () => {
    delete process.env[KEYWORD_BACKFILL_ENV];
    expect(keywordBackfillEnabled()).toBe(true);
  });

  it('is disabled by "0" or "false"', () => {
    process.env[KEYWORD_BACKFILL_ENV] = '0';
    expect(keywordBackfillEnabled()).toBe(false);
    process.env[KEYWORD_BACKFILL_ENV] = 'false';
    expect(keywordBackfillEnabled()).toBe(false);
  });
});

describe('createKeywordBackfillLane — audible per-cycle mark', () => {
  it('emits [keyword-backfill] cycle processed=/remaining=/concepts= on every cycle, including an idle one', async () => {
    const lines: string[] = [];
    const candidates = [candidate(0), candidate(1)];
    const indexedPageKeys: string[] = [];
    let progressStore: KeywordBackfillProgress | null = null;
    const deps: KeywordBackfillLaneDeps = {
      listCandidates: async () => candidates,
      hasIndexed: async (pageKey) => indexedPageKeys.includes(pageKey),
      indexCandidate: async (c) => {
        indexedPageKeys.push(c.pageKey);
      },
      readProgress: async () => progressStore,
      writeProgress: async (progress) => {
        progressStore = progress;
      },
      conceptsTotal: () => 7,
      log: (message) => lines.push(message),
    };
    const lane = createKeywordBackfillLane(deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });

    await lane.runOnce();
    expect(lines).toContain('[keyword-backfill] cycle processed=2 remaining=0 concepts=7');

    // A second, fully-idle cycle (nothing left to index) STILL emits the
    // mark — audibility must not depend on there being work to do; a lane
    // that only logs when busy is indistinguishable from a lane that never
    // started at all once the backlog drains.
    lines.length = 0;
    await lane.runOnce();
    expect(lines).toContain('[keyword-backfill] cycle processed=0 remaining=0 concepts=7');
  });

  it('a conceptsTotal() throw never suppresses the mark — reports concepts=0 instead', async () => {
    const lines: string[] = [];
    const deps: KeywordBackfillLaneDeps = {
      listCandidates: async () => [],
      hasIndexed: async () => false,
      indexCandidate: async () => undefined,
      conceptsTotal: () => {
        throw new Error('concept store unavailable');
      },
      log: (message) => lines.push(message),
    };
    const lane = createKeywordBackfillLane(deps);
    await lane.runOnce();
    expect(lines).toContain('[keyword-backfill] cycle processed=0 remaining=0 concepts=0');
  });
});

describe('scheduleKeywordBackfillLoop — production wiring', () => {
  let vaultRoot: string;
  let eventLog: EventLog;
  let dispose: (() => void) | null = null;

  const setUp = async (): Promise<void> => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'keyword-backfill-scheduler-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    setEmbedderOverride(async (texts) => texts.map(contentHashVector));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
  };

  const tearDown = async (): Promise<void> => {
    dispose?.();
    dispose = null;
    setEmbedderOverride(undefined);
    await rm(vaultRoot, { recursive: true, force: true });
  };

  afterEach(async () => {
    await tearDown();
  });

  sqliteIt(
    'end-to-end: N gists seeded WITHOUT going through live ingest are backfilled — keyword-index ' +
      'rows + concepts appear, and the resulting evidence feeds a real hybridSimilarity computation',
    async () => {
      await setUp();

      // Seed 3 gists via the SAME durable append the enrichment route uses,
      // but WITHOUT calling ingestGistKeywords (unlike enrichmentRoutes.ts's
      // live-ingest hook) — this is exactly the backlog shape the backfill
      // lane exists for: a gist durably on the log that the keyword layer
      // has never seen (predates the feature, or ingest was off when it
      // landed). No "Keywords:" line -> falls to the deterministic
      // extractor (keywordExtract.ts), same as every pre-existing gist on
      // the live vault this fix targets.
      const pages: readonly { readonly url: string; readonly gist: string }[] = [
        {
          url: 'https://a.example/rust',
          gist: 'A deep dive into rust ownership and rust borrowing rules for systems programming.',
        },
        {
          url: 'https://b.example/rust',
          gist: 'More rust ownership patterns and rust systems programming techniques explained.',
        },
        {
          url: 'https://c.example/baking',
          gist: 'Sourdough baking technique focuses on fermentation and sourdough starter maintenance.',
        },
      ];
      for (const [i, page] of pages.entries()) {
        await appendContentEnrichmentEvent(eventLog, {
          payloadVersion: 1,
          kind: 'url',
          id: page.url,
          gist: page.gist,
          sourceContentHash: `hash-${String(i)}`,
          model: 'test-model',
          generatedAt: '2026-08-16T00:00:00.000Z',
        });
      }

      const lines: string[] = [];
      dispose = scheduleKeywordBackfillLoop(eventLog, vaultRoot, {
        startupDelayMs: 0,
        config: { batchCap: 20, cycleIntervalMs: 50, idleIntervalMs: 50, maxAttemptsPerPage: 3 },
        log: (message) => lines.push(message),
      });

      const deadline = Date.now() + 10_000;
      while (
        !lines.some((line) => line.startsWith('[keyword-backfill] cycle processed=3')) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lines.some((line) => line.startsWith('[keyword-backfill] cycle processed=3'))).toBe(
        true,
      );

      // The two stores the lane fills are actually populated.
      const keywordIndex = await createKeywordIndexStore(vaultRoot);
      const concepts = await createKeywordConceptStore(vaultRoot);
      let evidence: SuggestionEvidenceItem[];
      try {
        for (const page of pages) {
          expect(keywordIndex.hasPage(`url:${page.url}`)).toBe(true);
          const keywords = keywordIndex.keywordsForPage(`url:${page.url}`);
          expect(keywords).toBeDefined();
          expect((keywords ?? []).length).toBeGreaterThan(0);
        }
        expect(concepts.stats().distinctConcepts).toBeGreaterThan(0);

        // Consumability: build REAL SuggestionEvidenceItem[] the exact way
        // suggestionRecomputeLane.ts's buildDeps join does (keywordsForPage
        // -> conceptIdsForKeywords), and confirm the suggestion engine's
        // hybridSimilarity actually distinguishes rust pages from the
        // baking page using ONLY what the backfill lane just produced (no
        // embeddings at all here — the zero-vector-coverage path).
        const noVector = (): Float32Array => new Float32Array(0);
        evidence = pages.map((page) => {
          const keywords = keywordIndex.keywordsForPage(`url:${page.url}`) ?? [];
          const conceptIds = concepts.conceptIdsForKeywords(keywords);
          return { id: page.url, embedding: noVector(), conceptIds, keywords };
        });
      } finally {
        keywordIndex.close();
        concepts.close();
      }

      const [rustA, rustB, baking] = evidence;
      expect(rustA).toBeDefined();
      expect(rustB).toBeDefined();
      expect(baking).toBeDefined();
      const rustSimilarity = hybridSimilarity(rustA!, rustB!);
      const crossTopicSimilarity = hybridSimilarity(rustA!, baking!);
      expect(rustSimilarity).toBeGreaterThan(crossTopicSimilarity);
    },
    15_000,
  );

  sqliteIt(
    'self-heals a degenerate concept distribution found at scheduler startup, before the lane runs its first cycle (2026-08-17 incident)',
    async () => {
      await setUp();

      // Seed the EXACT live-incident shape directly on disk: 25 distinct
      // keywords already indexed, all collapsed into ONE concept via a
      // constant-vector embedder — mirroring the real vault's 360-
      // keyword/1-concept finding, then close the handles so the
      // scheduler opens its own (matching real boot: this vault's stores
      // already exist with degenerate data from a PRIOR run).
      const seedIndex = await createKeywordIndexStore(vaultRoot);
      const seedConcepts = await createKeywordConceptStore(vaultRoot);
      const keywords = Array.from({ length: 25 }, (_, i) => `seedword${String(i)}`);
      seedIndex.upsertPageKeywords('url:https://seed.example/', keywords, 'llm', 1);
      const constant = new Float32Array(384);
      constant[0] = 1;
      for (const keyword of keywords) seedConcepts.assignKeyword(keyword, constant, 1);
      expect(seedConcepts.stats()).toEqual({ distinctKeywords: 25, distinctConcepts: 1 });
      seedIndex.close();
      seedConcepts.close();

      const lines: string[] = [];
      dispose = scheduleKeywordBackfillLoop(eventLog, vaultRoot, {
        startupDelayMs: 0,
        config: { batchCap: 20, cycleIntervalMs: 50, idleIntervalMs: 50, maxAttemptsPerPage: 3 },
        log: (message) => lines.push(message),
      });

      const deadline = Date.now() + 10_000;
      while (
        !lines.some((line) => line.startsWith('[keyword-concepts] repair complete')) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lines.some((line) => line.startsWith('[keyword-concepts] repair complete'))).toBe(
        true,
      );
      expect(
        lines.some((line) => line.includes('degenerate concept distribution detected')),
      ).toBe(true);

      const concepts = await createKeywordConceptStore(vaultRoot);
      try {
        const after = concepts.stats();
        expect(after.distinctKeywords).toBe(25);
        // The content-hash embedder (setUp) is discriminative — repair
        // must produce MORE than the one degenerate concept it started
        // with.
        expect(after.distinctConcepts).toBeGreaterThan(1);
      } finally {
        concepts.close();
      }
    },
    15_000,
  );

  sqliteIt('disabled via SIDETRACK_KEYWORD_BACKFILL=0 — no store handle opens, one boot line, no-op disposer', async () => {
    await setUp();
    const prevFlag = process.env[KEYWORD_BACKFILL_ENV];
    process.env[KEYWORD_BACKFILL_ENV] = '0';
    const lines: string[] = [];
    try {
      dispose = scheduleKeywordBackfillLoop(eventLog, vaultRoot, {
        startupDelayMs: 0,
        log: (message) => lines.push(message),
      });
      expect(lines).toEqual([`[keyword-backfill] disabled via ${KEYWORD_BACKFILL_ENV}=0`]);
      // Give any (incorrectly-started) timer a chance to fire before
      // asserting silence — proof the scheduler truly opened nothing.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lines.length).toBe(1);
    } finally {
      if (prevFlag === undefined) delete process.env[KEYWORD_BACKFILL_ENV];
      else process.env[KEYWORD_BACKFILL_ENV] = prevFlag;
    }
  });
});
