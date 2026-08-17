import { describe, expect, it } from 'bun:test';

import {
  createKeywordBackfillLane,
  keywordBackfillCandidatesFromGistLookup,
  type KeywordBackfillCandidate,
  type KeywordBackfillLaneDeps,
  type KeywordBackfillProgress,
} from './keywordBackfillLane.js';
import type { GistLookup } from './contentEnrichment.js';

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
