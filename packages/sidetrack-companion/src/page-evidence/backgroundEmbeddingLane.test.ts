import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKGROUND_EMBEDDING_CONFIG,
  createBackgroundEmbeddingLane,
  isBackgroundEmbeddingBacklog,
  resolveEmbedBatchCapFromEnv,
  type BackgroundEmbeddingCandidate,
  type BackgroundEmbeddingLaneDeps,
} from './backgroundEmbeddingLane.js';

const candidate = (
  overrides: Partial<BackgroundEmbeddingCandidate> & { canonicalUrl: string },
): BackgroundEmbeddingCandidate => {
  const content =
    'content' in overrides
      ? overrides.content
      : overrides.evidenceTier === 'metadata_only'
        ? undefined
        : { embeddingState: 'missing' as const };
  const base: BackgroundEmbeddingCandidate = {
    canonicalUrl: overrides.canonicalUrl,
    url: overrides.url ?? overrides.canonicalUrl,
    evidenceTier: overrides.evidenceTier ?? 'indexed_chunks',
    ...(content === undefined ? {} : { content }),
  };
  return {
    ...base,
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
  };
};

const deps = (
  overrides: Partial<BackgroundEmbeddingLaneDeps> & {
    listCandidates: BackgroundEmbeddingLaneDeps['listCandidates'];
    embedCanonicalUrl: BackgroundEmbeddingLaneDeps['embedCanonicalUrl'];
  },
): BackgroundEmbeddingLaneDeps => ({
  isDrainActive: () => false,
  now: () => 1_000,
  ...overrides,
});

describe('isBackgroundEmbeddingBacklog', () => {
  it('is backlog when content is present with a missing embedding', () => {
    expect(isBackgroundEmbeddingBacklog(candidate({ canonicalUrl: 'https://a.test' }))).toBe(true);
    expect(
      isBackgroundEmbeddingBacklog(candidate({ canonicalUrl: 'https://a.test', content: {} })),
    ).toBe(true);
  });

  it('is NOT backlog for metadata-only, disabled, failed-marked, or ready records', () => {
    expect(
      isBackgroundEmbeddingBacklog(
        candidate({ canonicalUrl: 'https://a.test', evidenceTier: 'metadata_only' }),
      ),
    ).toBe(false);
    expect(
      isBackgroundEmbeddingBacklog(
        candidate({ canonicalUrl: 'https://a.test', content: { embeddingState: 'disabled' } }),
      ),
    ).toBe(false);
    expect(
      isBackgroundEmbeddingBacklog(
        candidate({ canonicalUrl: 'https://a.test', content: { embeddingState: 'failed' } }),
      ),
    ).toBe(false);
    expect(
      isBackgroundEmbeddingBacklog(
        candidate({
          canonicalUrl: 'https://a.test',
          content: { embeddingState: 'ready', docEmbeddingRef: { vectorId: 'v' } },
        }),
      ),
    ).toBe(false);
  });
});

describe('createBackgroundEmbeddingLane.runOnce', () => {
  it('embeds at most batchCap records per cycle', async () => {
    const embedded: string[] = [];
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () =>
          Array.from({ length: 20 }, (_, i) =>
            candidate({ canonicalUrl: `https://a.test/${String(i)}` }),
          ),
        embedCanonicalUrl: async (url) => {
          embedded.push(url);
          return 'embedded';
        },
      }),
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, batchCap: 3 },
    );
    const result = await lane.runOnce();
    expect(result.embedded).toBe(3);
    expect(embedded).toHaveLength(3);
    expect(result.backlog).toBe(20);
  });

  it('pauses entirely when a drain is active', async () => {
    let called = 0;
    const lane = createBackgroundEmbeddingLane(
      deps({
        isDrainActive: () => true,
        listCandidates: async () => [candidate({ canonicalUrl: 'https://a.test' })],
        embedCanonicalUrl: async () => {
          called += 1;
          return 'embedded';
        },
      }),
    );
    const result = await lane.runOnce();
    expect(result.pausedForDrain).toBe(true);
    expect(result.embedded).toBe(0);
    expect(called).toBe(0);
  });

  it('stops mid-cycle when a drain starts between records', async () => {
    let drainActive = false;
    const embedded: string[] = [];
    const lane = createBackgroundEmbeddingLane(
      deps({
        isDrainActive: () => drainActive,
        listCandidates: async () =>
          Array.from({ length: 5 }, (_, i) =>
            candidate({ canonicalUrl: `https://a.test/${String(i)}` }),
          ),
        embedCanonicalUrl: async (url) => {
          embedded.push(url);
          // A drain lands after the first record.
          if (embedded.length === 1) drainActive = true;
          return 'embedded';
        },
      }),
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, batchCap: 10 },
    );
    const result = await lane.runOnce();
    expect(result.pausedForDrain).toBe(true);
    expect(embedded).toHaveLength(1);
  });

  it('treats a thrown embed as failed and continues (never inline crash)', async () => {
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () => [
          candidate({ canonicalUrl: 'https://boom.test' }),
          candidate({ canonicalUrl: 'https://ok.test' }),
        ],
        embedCanonicalUrl: async (url) => {
          if (url === 'https://boom.test') throw new Error('embed exploded');
          return 'embedded';
        },
      }),
    );
    const result = await lane.runOnce();
    expect(result.failed).toBe(1);
    expect(result.embedded).toBe(1);
  });

  it('quarantines a record after maxAttempts consecutive failures', async () => {
    const listCandidates = async (): Promise<readonly BackgroundEmbeddingCandidate[]> => [
      candidate({ canonicalUrl: 'https://always-fails.test' }),
    ];
    const embedCanonicalUrl = async (): Promise<'failed'> => 'failed';
    const lane = createBackgroundEmbeddingLane(deps({ listCandidates, embedCanonicalUrl }), {
      ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG,
      maxAttemptsPerRecord: 2,
    });
    // Attempt 1 + 2 fail; the 3rd cycle the record is quarantined.
    const r1 = await lane.runOnce();
    expect(r1.failed).toBe(1);
    const r2 = await lane.runOnce();
    expect(r2.failed).toBe(1);
    const r3 = await lane.runOnce();
    expect(r3.failed).toBe(0);
    expect(r3.quarantined).toBe(1);
    expect(r3.backlog).toBe(0);
  });

  it('does not burn an attempt on skip (no content payload yet)', async () => {
    let attempt = 0;
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () => [candidate({ canonicalUrl: 'https://slow.test' })],
        embedCanonicalUrl: async () => {
          attempt += 1;
          // Always skipped — never counts toward quarantine.
          return 'skipped';
        },
      }),
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, maxAttemptsPerRecord: 1 },
    );
    await lane.runOnce();
    const r2 = await lane.runOnce();
    // Still visited (not quarantined) because skips don't accrue attempts.
    expect(r2.skipped).toBe(1);
    expect(r2.quarantined).toBe(0);
    expect(attempt).toBe(2);
  });

  it('excludes tombstoned domains from the backlog', async () => {
    let embedded = 0;
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () => [
          candidate({ canonicalUrl: 'https://private.test/page' }),
          candidate({ canonicalUrl: 'https://public.test/page' }),
        ],
        isTombstoned: (page) => page.url.includes('private.test'),
        embedCanonicalUrl: async () => {
          embedded += 1;
          return 'embedded';
        },
      }),
    );
    const result = await lane.runOnce();
    expect(result.backlog).toBe(1);
    expect(embedded).toBe(1);
  });

  it('notifies onEmbedded exactly once per successfully embedded URL', async () => {
    const requalified: string[] = [];
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () => [
          candidate({ canonicalUrl: 'https://a.test' }),
          candidate({ canonicalUrl: 'https://b.test' }),
        ],
        embedCanonicalUrl: async (url) => (url === 'https://a.test' ? 'embedded' : 'failed'),
        onEmbedded: (url) => requalified.push(url),
      }),
    );
    await lane.runOnce();
    expect(requalified).toEqual(['https://a.test']);
  });

  it('persists and reloads progress (attempt bookkeeping survives)', async () => {
    let stored: unknown = null;
    const embedCanonicalUrl = async (): Promise<'failed'> => 'failed';
    const listCandidates = async (): Promise<readonly BackgroundEmbeddingCandidate[]> => [
      candidate({ canonicalUrl: 'https://x.test' }),
    ];
    const makeLane = () =>
      createBackgroundEmbeddingLane(
        deps({
          listCandidates,
          embedCanonicalUrl,
          readProgress: async () => stored as never,
          writeProgress: async (p) => {
            stored = p;
          },
        }),
        { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, maxAttemptsPerRecord: 2 },
      );
    // First lane instance: one failure recorded + persisted.
    await makeLane().runOnce();
    expect(
      (stored as { attemptsByCanonicalUrl: Record<string, number> }).attemptsByCanonicalUrl[
        'https://x.test'
      ],
    ).toBe(1);
    // Fresh lane instance reloads the persisted attempt; a second failure
    // reaches the quarantine threshold.
    const second = makeLane();
    await second.runOnce();
    const r = await makeLane().runOnce();
    expect(r.quarantined).toBe(1);
  });

  it('does not throw when listCandidates fails', async () => {
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () => {
          throw new Error('readdir failed');
        },
        embedCanonicalUrl: async () => 'embedded',
      }),
    );
    const result = await lane.runOnce();
    expect(result.embedded).toBe(0);
    expect(result.pausedForDrain).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bug (a): WARMUP RACE — an embedder that becomes ready AFTER lane start
// must not permanently quarantine the backlog.
// ─────────────────────────────────────────────────────────────────────
describe('createBackgroundEmbeddingLane warmup recovery', () => {
  it('does no embed work + burns no attempts while the embedder is warming', async () => {
    let embedCalls = 0;
    const lane = createBackgroundEmbeddingLane(
      deps({
        isEmbedderReady: () => false, // still warming
        listCandidates: async () => [candidate({ canonicalUrl: 'https://a.test' })],
        embedCanonicalUrl: async () => {
          embedCalls += 1;
          return 'embedded';
        },
      }),
    );
    const r = await lane.runOnce();
    expect(r.pausedForWarmup).toBe(true);
    expect(r.embedded).toBe(0);
    expect(embedCalls).toBe(0); // the embedder was NEVER called against a cold child
    // No attempts burned — the backlog is intact once the child warms.
    expect(Object.keys(lane.progress().attemptsByCanonicalUrl)).toHaveLength(0);
  });

  it('recovers and embeds once the embedder becomes ready mid-run (no permanent quarantine)', async () => {
    let ready = false;
    let embedded = 0;
    const lane = createBackgroundEmbeddingLane(
      deps({
        isEmbedderReady: () => ready,
        listCandidates: async () => [candidate({ canonicalUrl: 'https://a.test' })],
        embedCanonicalUrl: async () => {
          embedded += 1;
          return 'embedded';
        },
      }),
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, maxAttemptsPerRecord: 3 },
    );
    // Simulate the exact soak race: several cycles fire while the child is
    // cold. Under the OLD code these would fail → quarantine at 3 attempts.
    await lane.runOnce();
    await lane.runOnce();
    await lane.runOnce();
    await lane.runOnce();
    expect(embedded).toBe(0);
    expect(lane.health().inert).toBe(false); // warming, not inert
    // Child warms. The very next cycle must embed the still-eligible record.
    ready = true;
    const r = await lane.runOnce();
    expect(r.pausedForWarmup).toBe(false);
    expect(r.embedded).toBe(1);
    expect(embedded).toBe(1);
  });

  it('lifts quarantine after the cooldown so a warmup-race victim recovers', async () => {
    let clock = 1_000;
    let failNext = true;
    const lane = createBackgroundEmbeddingLane(
      deps({
        now: () => clock,
        listCandidates: async () => [candidate({ canonicalUrl: 'https://victim.test' })],
        embedCanonicalUrl: async () => (failNext ? 'failed' : 'embedded'),
      }),
      {
        ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG,
        maxAttemptsPerRecord: 2,
        quarantineCooldownMs: 10_000,
      },
    );
    // Two failures → quarantined.
    await lane.runOnce();
    await lane.runOnce();
    const quarantinedCycle = await lane.runOnce();
    expect(quarantinedCycle.quarantined).toBe(1);
    expect(quarantinedCycle.backlog).toBe(0);
    // Before the cooldown elapses it stays quarantined.
    clock += 5_000;
    expect((await lane.runOnce()).quarantined).toBe(1);
    // After the cooldown the record becomes eligible again; now it embeds.
    clock += 6_000;
    failNext = false;
    const recovered = await lane.runOnce();
    expect(recovered.embedded).toBe(1);
    expect(recovered.quarantined).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bug (b): the batch cap must count ATTEMPTS (successes + failures), not
// successes only — a cycle of pure failures must make BOUNDED progress.
// ─────────────────────────────────────────────────────────────────────
describe('createBackgroundEmbeddingLane attempt-counted batch cap', () => {
  it('caps work by attempts so a cycle of pure failures is bounded (no spin)', async () => {
    let calls = 0;
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () =>
          Array.from({ length: 100 }, (_, i) =>
            candidate({ canonicalUrl: `https://fail.test/${String(i)}` }),
          ),
        embedCanonicalUrl: async () => {
          calls += 1;
          return 'failed';
        },
      }),
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, batchCap: 5 },
    );
    const r = await lane.runOnce();
    // Under the OLD (success-only) cap this would call embed 100 times
    // (never hitting the cap because nothing succeeded) — a full-backlog
    // spin. Attempt-counting bounds it to batchCap.
    expect(calls).toBe(5);
    expect(r.failed).toBe(5);
  });

  it('counts a mix of successes + failures toward the same cap', async () => {
    let calls = 0;
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () =>
          Array.from({ length: 20 }, (_, i) =>
            candidate({ canonicalUrl: `https://mix.test/${String(i)}` }),
          ),
        embedCanonicalUrl: async () => {
          calls += 1;
          return calls % 2 === 0 ? 'embedded' : 'failed';
        },
      }),
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, batchCap: 6 },
    );
    const r = await lane.runOnce();
    expect(calls).toBe(6);
    expect(r.embedded + r.failed).toBe(6);
  });

  it('bounds reconstruction skips without burning failure attempts', async () => {
    let calls = 0;
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () =>
          Array.from({ length: 10 }, (_, i) =>
            candidate({ canonicalUrl: `https://skip.test/${String(i)}` }),
          ),
        embedCanonicalUrl: async () => {
          calls += 1;
          return 'skipped';
        },
      }),
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, batchCap: 3 },
    );
    const r = await lane.runOnce();
    // A skip still performs a page-content lookup, so visits are capped even
    // though no failure/quarantine attempt is recorded for the candidate.
    expect(calls).toBe(3);
    expect(r.skipped).toBe(3);
    expect(Object.keys(lane.progress().attemptsByCanonicalUrl)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Lane health — a silently-inert lane (the 90-min soak failure) must be
// VISIBLE via a synchronous health snapshot.
// ─────────────────────────────────────────────────────────────────────
describe('createBackgroundEmbeddingLane.health', () => {
  it('flags inert=true when the lane ran but embedded nothing against a non-empty backlog', async () => {
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () => [candidate({ canonicalUrl: 'https://stuck.test' })],
        embedCanonicalUrl: async () => 'failed',
      }),
      { ...DEFAULT_BACKGROUND_EMBEDDING_CONFIG, maxAttemptsPerRecord: 1 },
    );
    expect(lane.health().lastCycle).toBe('never-run');
    await lane.runOnce();
    const h = lane.health();
    expect(h.inert).toBe(true);
    expect(h.embeddedTotal).toBe(0);
    expect(h.lastBacklog).toBeGreaterThan(0);
    expect(h.lastSuccessAtMs).toBeNull();
  });

  it('reports embeddedTotal + lastSuccessAtMs + not-inert after real progress', async () => {
    const clock = 5_000;
    const lane = createBackgroundEmbeddingLane(
      deps({
        now: () => clock,
        listCandidates: async () => [candidate({ canonicalUrl: 'https://good.test' })],
        embedCanonicalUrl: async () => 'embedded',
      }),
    );
    await lane.runOnce();
    const h = lane.health();
    expect(h.inert).toBe(false);
    expect(h.embeddedTotal).toBe(1);
    expect(h.embeddedThisProcess).toBe(1);
    expect(h.lastSuccessAtMs).toBe(5_000);
    expect(h.lastCycle).toBe('embedded');
  });

  it('distinguishes paused-warmup from inert', async () => {
    const lane = createBackgroundEmbeddingLane(
      deps({
        isEmbedderReady: () => false,
        listCandidates: async () => [candidate({ canonicalUrl: 'https://warm.test' })],
        embedCanonicalUrl: async () => 'embedded',
      }),
    );
    await lane.runOnce();
    const h = lane.health();
    expect(h.lastCycle).toBe('paused-warmup');
    // Backlog was never scanned (warmup gate short-circuits) so inert is
    // not asserted — the operator sees 'paused-warmup', not a false inert.
    expect(h.inert).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// AUDIBLE FAILURES (2026-08-16 incident). The live embed lane logged
// `cycle embedded=0 failed=4 skipped=4 ...` every cycle for hours with NO
// indication why — a silent-failure violation of the repo's audible-
// drain-failure rule. `embedCanonicalUrl` may now return
// `{outcome, reason}` instead of a bare string; the lane must turn that
// into a per-cycle reason histogram (`failedByReason`/`skippedByReason`)
// and log the FIRST occurrence of each distinct reason once (throttled —
// not once per attempt).
// ─────────────────────────────────────────────────────────────────────
describe('createBackgroundEmbeddingLane audible failures', () => {
  it('builds a failedByReason / skippedByReason histogram from classified outcomes', async () => {
    const outcomesByUrl: Record<
      string,
      'embedded' | { readonly outcome: 'skipped' | 'failed'; readonly reason: string }
    > = {
      'https://a.test': { outcome: 'failed', reason: 'stale-guard' },
      'https://b.test': { outcome: 'failed', reason: 'stale-guard' },
      'https://c.test': { outcome: 'failed', reason: 'embed-error' },
      'https://d.test': { outcome: 'skipped', reason: 'no-page-content' },
      'https://e.test': 'embedded',
    };
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () =>
          Object.keys(outcomesByUrl).map((canonicalUrl) => candidate({ canonicalUrl })),
        embedCanonicalUrl: async (url) => outcomesByUrl[url]!,
      }),
    );
    const result = await lane.runOnce();
    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.failedByReason).toEqual({ 'stale-guard': 2, 'embed-error': 1 });
    expect(result.skippedByReason).toEqual({ 'no-page-content': 1 });
  });

  it('still works when embedCanonicalUrl returns bare strings (backward compatible, no reasons)', async () => {
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () => [
          candidate({ canonicalUrl: 'https://a.test' }),
          candidate({ canonicalUrl: 'https://b.test' }),
        ],
        embedCanonicalUrl: async (url) => (url === 'https://a.test' ? 'failed' : 'skipped'),
      }),
    );
    const result = await lane.runOnce();
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failedByReason).toEqual({ unknown: 1 });
    expect(result.skippedByReason).toEqual({ unknown: 1 });
  });

  it('logs the first occurrence of a reason once, not once per attempt (throttled)', async () => {
    const lines: string[] = [];
    const lane = createBackgroundEmbeddingLane(
      deps({
        log: (message) => lines.push(message),
        listCandidates: async () => [
          candidate({ canonicalUrl: 'https://a.test' }),
          candidate({ canonicalUrl: 'https://b.test' }),
          candidate({ canonicalUrl: 'https://c.test' }),
        ],
        embedCanonicalUrl: async () => ({ outcome: 'failed', reason: 'stale-guard' }),
      }),
    );
    await lane.runOnce();
    const firstOccurrenceLines = lines.filter((line) => line.includes('first occurrence'));
    expect(firstOccurrenceLines).toHaveLength(1);
    expect(firstOccurrenceLines[0]).toContain('reason=stale-guard');
    // The cycle summary line still carries the full per-cycle COUNT.
    const cycleLine = lines.find((line) => line.includes('cycle embedded='));
    expect(cycleLine).toContain('failedByReason=stale-guard:3');

    // A SECOND cycle with the SAME reason logs no additional first-
    // occurrence line (still throttled) but the histogram still counts.
    await lane.runOnce();
    expect(lines.filter((line) => line.includes('first occurrence'))).toHaveLength(1);
  });

  it('classifies a thrown embed as reason=threw', async () => {
    const lane = createBackgroundEmbeddingLane(
      deps({
        listCandidates: async () => [candidate({ canonicalUrl: 'https://a.test' })],
        embedCanonicalUrl: async () => {
          throw new Error('boom');
        },
      }),
    );
    const result = await lane.runOnce();
    expect(result.failedByReason).toEqual({ threw: 1 });
  });
});

// SIDETRACK_EMBED_BATCH — env override for the per-cycle batch cap. Raising
// this was safe only AFTER the embed-cache write path stopped rewriting the
// whole cache file per record (embeddingCache.ts's append-only design);
// this suite just proves the env parsing/clamping is correct, independent
// of the write-path fix (covered in embeddingCacheWriteAmplification.test.ts).
describe('resolveEmbedBatchCapFromEnv', () => {
  it('defaults to the lane default when unset, blank, or non-numeric', () => {
    expect(resolveEmbedBatchCapFromEnv(undefined)).toBe(
      DEFAULT_BACKGROUND_EMBEDDING_CONFIG.batchCap,
    );
    expect(resolveEmbedBatchCapFromEnv('')).toBe(DEFAULT_BACKGROUND_EMBEDDING_CONFIG.batchCap);
    expect(resolveEmbedBatchCapFromEnv('   ')).toBe(DEFAULT_BACKGROUND_EMBEDDING_CONFIG.batchCap);
    expect(resolveEmbedBatchCapFromEnv('not-a-number')).toBe(
      DEFAULT_BACKGROUND_EMBEDDING_CONFIG.batchCap,
    );
  });

  it('honors a valid in-range value', () => {
    expect(resolveEmbedBatchCapFromEnv('4')).toBe(4);
    expect(resolveEmbedBatchCapFromEnv('32')).toBe(32);
  });

  it('floors fractional values', () => {
    expect(resolveEmbedBatchCapFromEnv('12.7')).toBe(12);
  });

  it('degrades zero/negative values to the default rather than disabling the lane', () => {
    expect(resolveEmbedBatchCapFromEnv('0')).toBe(DEFAULT_BACKGROUND_EMBEDDING_CONFIG.batchCap);
    expect(resolveEmbedBatchCapFromEnv('-5')).toBe(DEFAULT_BACKGROUND_EMBEDDING_CONFIG.batchCap);
  });

  it('clamps an out-of-range value to [1, 64] instead of erroring', () => {
    expect(resolveEmbedBatchCapFromEnv('9999')).toBe(64);
    expect(resolveEmbedBatchCapFromEnv('0.4')).toBe(1);
  });

  it('a custom fallback is used instead of the lane default', () => {
    expect(resolveEmbedBatchCapFromEnv(undefined, 5)).toBe(5);
  });
});
