import { describe, expect, it } from 'bun:test';

import {
  createSentenceVectorBackfillLane,
  gatherSentenceBackfillCandidates,
  sentenceBackfillCandidatesWithinCap,
  sentenceVectorBackfillEnabled,
  SENTENCE_VECTOR_BACKFILL_ENV,
  type SentenceBackfillCandidate,
  type SentenceVectorBackfillLaneDeps,
  type SentenceVectorBackfillProgress,
  type SentenceVectorBackfillStore,
} from './sentenceVectorBackfillLane.js';

const candidate = (n: number, opts?: { readonly gist?: string; readonly title?: string }): SentenceBackfillCandidate => ({
  canonicalUrl: `https://p${String(n)}.example/`,
  title: opts?.title ?? `Page ${String(n)}`,
  gist: opts?.gist ?? `A gist for page number ${String(n)} about a topic.`,
  firstSeenAtMs: 1_700_000_000_000 + n,
});

interface FakeStore extends SentenceVectorBackfillStore {
  readonly persisted: Map<string, readonly { readonly sentenceIndex: number; readonly source: string; readonly text: string }[]>;
}

const fakeStore = (preExisting: readonly string[] = []): FakeStore => {
  const persisted = new Map<string, readonly { readonly sentenceIndex: number; readonly source: string; readonly text: string }[]>();
  for (const url of preExisting) persisted.set(url, [{ sentenceIndex: 0, source: 'gist', text: 'x' }]);
  return {
    persisted,
    replaceSentenceVectors: (_ownerKind, ownerId, sentences) => {
      persisted.set(
        ownerId,
        sentences.map((s) => ({ sentenceIndex: s.sentenceIndex, source: s.source, text: s.text })),
      );
    },
    allSentenceVectorOwnerIds: () => new Set(persisted.keys()),
  };
};

const fakeEmbed = async (texts: readonly string[]): Promise<readonly Float32Array[]> =>
  texts.map(() => new Float32Array(4).fill(1));

interface Harness {
  readonly deps: SentenceVectorBackfillLaneDeps;
  readonly store: FakeStore;
  readonly embedCalls: { count: number };
  progressStore: SentenceVectorBackfillProgress | null;
}

const makeHarness = (
  candidates: readonly SentenceBackfillCandidate[],
  options?: { readonly preIndexed?: readonly string[]; readonly isEmbedderReady?: () => boolean },
): Harness => {
  const store = fakeStore(options?.preIndexed);
  const embedCalls = { count: 0 };
  let progressStore: SentenceVectorBackfillProgress | null = null;
  const deps: SentenceVectorBackfillLaneDeps = {
    listCandidates: async () => candidates,
    store,
    embed: async (texts) => {
      embedCalls.count += 1;
      return fakeEmbed(texts);
    },
    readProgress: async () => progressStore,
    writeProgress: async (progress) => {
      progressStore = progress;
    },
    ...(options?.isEmbedderReady === undefined ? {} : { isEmbedderReady: options.isEmbedderReady }),
  };
  return { deps, store, embedCalls, progressStore };
};

describe('createSentenceVectorBackfillLane — boundedness + idempotence', () => {
  it('never indexes more than batchCap candidates in one cycle, even with a much larger backlog', async () => {
    const candidates = Array.from({ length: 500 }, (_, i) => candidate(i));
    const harness = makeHarness(candidates);
    const lane = createSentenceVectorBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    const result = await lane.runOnce();
    expect(result.scanned).toBe(500);
    expect(result.backlog).toBe(500);
    expect(result.indexed).toBe(20);
    expect(harness.store.persisted.size).toBe(20);
  });

  it('is idempotent — a page already backfilled (present in allSentenceVectorOwnerIds) is never re-processed', async () => {
    const candidates = [candidate(0), candidate(1), candidate(2)];
    const harness = makeHarness(candidates, { preIndexed: [candidate(0).canonicalUrl] });
    const lane = createSentenceVectorBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    const result = await lane.runOnce();
    expect(result.backlog).toBe(2); // candidate(0) excluded
    expect(result.indexed).toBe(2);
  });

  it('actually persists split sentence rows via replaceSentenceVectors', async () => {
    const c = candidate(0, { title: 'A Title', gist: 'First claim here. Second claim here.' });
    const harness = makeHarness([c]);
    const lane = createSentenceVectorBackfillLane(harness.deps);
    await lane.runOnce();
    const rows = harness.store.persisted.get(c.canonicalUrl);
    expect(rows).toBeDefined();
    expect(rows!.length).toBeGreaterThanOrEqual(2); // title + >=1 gist sentence
    expect(rows![0]!.source).toBe('title');
  });

  it('a candidate whose title+gist splits to zero sentences is quarantined after maxAttemptsPerPage, never retried again', async () => {
    // Both title and gist below the splitter's minimum length floor.
    const c = candidate(0, { title: '', gist: 'ok' });
    const harness = makeHarness([c]);
    const lane = createSentenceVectorBackfillLane(harness.deps, {
      batchCap: 20,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 2,
    });
    const first = await lane.runOnce();
    expect(first.failed).toBe(1);
    const second = await lane.runOnce();
    expect(second.failed).toBe(1);
    const third = await lane.runOnce();
    // Quarantined — no longer offered as backlog.
    expect(third.backlog).toBe(0);
    expect(third.failed).toBe(0);
  });

  it('pauses (no work, no attempts burned) while isEmbedderReady() is false', async () => {
    const candidates = [candidate(0), candidate(1)];
    const harness = makeHarness(candidates, { isEmbedderReady: () => false });
    const lane = createSentenceVectorBackfillLane(harness.deps);
    const result = await lane.runOnce();
    expect(result.pausedForWarmup).toBe(true);
    expect(result.indexed).toBe(0);
    expect(harness.store.persisted.size).toBe(0);
  });

  it('progress is persisted across runOnce calls via readProgress/writeProgress', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => candidate(i));
    const harness = makeHarness(candidates);
    const lane1 = createSentenceVectorBackfillLane(harness.deps, {
      batchCap: 10,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    await lane1.runOnce();
    expect(harness.store.persisted.size).toBe(10);
    // A FRESH lane instance reading the SAME (persisted) progress + store
    // state continues from where the first left off (no re-indexing).
    const lane2 = createSentenceVectorBackfillLane(harness.deps, {
      batchCap: 10,
      cycleIntervalMs: 1,
      idleIntervalMs: 1,
      maxAttemptsPerPage: 3,
    });
    const result2 = await lane2.runOnce();
    expect(result2.backlog).toBe(20); // 30 total minus the 10 already-indexed
    expect(harness.store.persisted.size).toBe(20);
  });

  it('embeds each candidate in ONE batched call, not one call per sentence', async () => {
    const c = candidate(0, { title: 'A Title', gist: 'One. Two. Three. Four.' });
    const harness = makeHarness([c]);
    const lane = createSentenceVectorBackfillLane(harness.deps);
    await lane.runOnce();
    expect(harness.embedCalls.count).toBe(1);
  });
});

describe('sentenceVectorBackfillEnabled — kill switch', () => {
  it('defaults ON, off only for explicit 0/false', () => {
    const original = process.env[SENTENCE_VECTOR_BACKFILL_ENV];
    try {
      delete process.env[SENTENCE_VECTOR_BACKFILL_ENV];
      expect(sentenceVectorBackfillEnabled()).toBe(true);
      process.env[SENTENCE_VECTOR_BACKFILL_ENV] = '0';
      expect(sentenceVectorBackfillEnabled()).toBe(false);
      process.env[SENTENCE_VECTOR_BACKFILL_ENV] = 'false';
      expect(sentenceVectorBackfillEnabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env[SENTENCE_VECTOR_BACKFILL_ENV];
      else process.env[SENTENCE_VECTOR_BACKFILL_ENV] = original;
    }
  });
});

describe('sentenceBackfillCandidatesWithinCap — most-recent-first, bounded', () => {
  it('caps at `limit` and sorts most-recent-first', () => {
    const items = [candidate(0), candidate(5), candidate(2)];
    const capped = sentenceBackfillCandidatesWithinCap(items, 2);
    expect(capped.length).toBe(2);
    expect(capped[0]!.canonicalUrl).toBe(candidate(5).canonicalUrl); // highest firstSeenAtMs
  });
});

describe('gatherSentenceBackfillCandidates — non-sqlite / no-projection typed-empty', () => {
  it('returns [] for a non-SqliteConnectionsStore', async () => {
    const fakeConnectionsStore = {} as never;
    const result = await gatherSentenceBackfillCandidates(fakeConnectionsStore, null);
    expect(result).toEqual([]);
  });
});
