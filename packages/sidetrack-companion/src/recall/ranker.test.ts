import { describe, expect, it } from 'vitest';

import {
  buildLexicalIndex,
  freshnessDecay,
  rank,
  rankHybrid,
  type ChunkMetadata,
  type IndexEntry,
} from './ranker.js';

const entry = (
  id: string,
  threadId: string,
  capturedAt: string,
  embedding: readonly number[],
  metadata?: Partial<ChunkMetadata> & { readonly text: string },
): IndexEntry => ({
  id,
  threadId,
  capturedAt,
  embedding: Float32Array.from(embedding),
  ...(metadata === undefined
    ? {}
    : {
        metadata: {
          sourceBacId: metadata.sourceBacId ?? threadId,
          turnOrdinal: metadata.turnOrdinal ?? 0,
          headingPath: metadata.headingPath ?? [],
          paragraphIndex: metadata.paragraphIndex ?? 0,
          charStart: metadata.charStart ?? 0,
          charEnd: metadata.charEnd ?? metadata.text.length,
          textHash: metadata.textHash ?? 'a'.repeat(64),
          text: metadata.text,
          ...(metadata.provider === undefined ? {} : { provider: metadata.provider }),
          ...(metadata.threadUrl === undefined ? {} : { threadUrl: metadata.threadUrl }),
          ...(metadata.title === undefined ? {} : { title: metadata.title }),
          ...(metadata.role === undefined ? {} : { role: metadata.role }),
          ...(metadata.modelName === undefined ? {} : { modelName: metadata.modelName }),
          ...(metadata.quality === undefined ? {} : { quality: metadata.quality }),
        },
      }),
});

describe('recall ranker', () => {
  it('applies calibrated freshness bands', () => {
    const now = new Date('2026-05-03T00:00:00.000Z');

    expect(freshnessDecay('2026-05-01T00:00:00.000Z', now)).toBe(1);
    expect(freshnessDecay('2026-04-20T00:00:00.000Z', now)).toBe(0.85);
    expect(freshnessDecay('2026-03-01T00:00:00.000Z', now)).toBe(0.7);
    expect(freshnessDecay('2025-05-03T00:00:00.000Z', now)).toBe(0.5);
    expect(freshnessDecay('2020-05-03T00:00:00.000Z', now)).toBe(0.3);
  });

  it('sorts by similarity times freshness and filters workstream membership', () => {
    const results = rank(
      Float32Array.from([1, 0]),
      [
        entry('old', 'thread_a', '2020-05-03T00:00:00.000Z', [1, 0]),
        entry('fresh', 'thread_b', '2026-05-03T00:00:00.000Z', [0.8, 0]),
      ],
      new Date('2026-05-03T00:00:00.000Z'),
      { workstreamMembership: (threadId) => threadId === 'thread_b' },
    );

    expect(results.map((item) => item.id)).toEqual(['fresh']);
  });

  it('clamps limits to fifty', () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      entry(String(index), 'thread', '2026-05-03T00:00:00.000Z', [1]),
    );

    expect(rank(Float32Array.from([1]), items, new Date(), { limit: 999 })).toHaveLength(50);
  });
});

describe('rankHybrid — lexical + vector fusion', () => {
  const baseDate = new Date('2026-05-03T00:00:00.000Z');

  it('retrieves a chunk on a verbatim identifier when the embedding similarity is weak', () => {
    // Two chunks: A has the literal `sidetrack.threads.move` term but
    // a poor embedding; B has a strong embedding but no overlap with
    // the query string. Lexical fusion should surface A first.
    const items: readonly IndexEntry[] = [
      entry('chunk:A:0:0:aaaaaaaaaaaa', 'thread_a', '2026-05-03T00:00:00.000Z', [0.1, 0], {
        text: 'Move the thread by calling sidetrack.threads.move on the workstream.',
      }),
      entry('chunk:B:0:0:bbbbbbbbbbbb', 'thread_b', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'Discussion about archive workflows and unrelated content.',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid(
      'sidetrack.threads.move',
      Float32Array.from([1, 0]),
      items,
      baseDate,
      {
        lexical,
      },
    );
    expect(results[0]?.id).toBe('chunk:A:0:0:aaaaaaaaaaaa');
    expect(results[0]?.lexical?.rank).toBeDefined();
  });

  it('retrieves a chunk on semantic similarity when the literal term is absent', () => {
    // Vector-only retrieval — query words aren't in the chunk text,
    // but the embedding is identical so the vector ranker wins.
    const items: readonly IndexEntry[] = [
      entry('chunk:A:0:0:aaaaaaaaaaaa', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0, 0], {
        text: 'A discussion about local-first architecture and offline replication.',
      }),
      entry('chunk:B:0:0:bbbbbbbbbbbb', 'thread_b', '2026-05-03T00:00:00.000Z', [0, 0, 1], {
        text: 'Unrelated content about CSS layout patterns.',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid(
      'how do we sync without a server',
      Float32Array.from([1, 0, 0]),
      items,
      baseDate,
      { lexical },
    );
    expect(results[0]?.id).toBe('chunk:A:0:0:aaaaaaaaaaaa');
    expect(results[0]?.vector?.rank).toBe(1);
  });

  it('fused result outranks pure freshness — older relevant chunk beats newer irrelevant', () => {
    const items: readonly IndexEntry[] = [
      // 4 years old but exact match on identifier + good vector.
      entry('chunk:relevant:0:0:cccccccccccc', 'thread_a', '2022-05-03T00:00:00.000Z', [1, 0], {
        text: 'Use sidetrack.threads.move to relocate threads across workstreams.',
      }),
      // Brand new but unrelated.
      entry('chunk:fresh:0:0:dddddddddddd', 'thread_b', '2026-05-03T00:00:00.000Z', [0, 1], {
        text: 'Unrelated chat about CSS.',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid(
      'sidetrack threads move',
      Float32Array.from([1, 0]),
      items,
      baseDate,
      { lexical },
    );
    // The relevant chunk wins despite being years older — freshness
    // is an additive boost, not the dominant factor.
    expect(results[0]?.id).toBe('chunk:relevant:0:0:cccccccccccc');
  });

  it('excludes tombstoned chunks from both rankers', () => {
    const items: readonly IndexEntry[] = [
      {
        ...entry('chunk:gone:0:0:eeeeeeeeeeee', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0], {
          text: 'tombstoned chunk should never appear',
        }),
        tombstoned: true,
      },
      entry('chunk:live:0:0:ffffffffffff', 'thread_b', '2026-05-03T00:00:00.000Z', [0.1, 0], {
        text: 'live chunk is the only candidate',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid('chunk', Float32Array.from([1, 0]), items, baseDate, {
      lexical,
    });
    expect(results.map((r) => r.id)).toEqual(['chunk:live:0:0:ffffffffffff']);
  });

  it('honors workstream membership filter on both rankers', () => {
    const items: readonly IndexEntry[] = [
      entry('chunk:in:0:0:111111111111', 'thread_in', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'in-workstream chunk',
      }),
      entry('chunk:out:0:0:222222222222', 'thread_out', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'out-of-workstream chunk',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid('chunk', Float32Array.from([1, 0]), items, baseDate, {
      lexical,
      workstreamMembership: (threadId) => threadId === 'thread_in',
    });
    expect(results.map((r) => r.id)).toEqual(['chunk:in:0:0:111111111111']);
  });

  it('populates `why`, `snippet`, and `metadata` on every result', () => {
    const items: readonly IndexEntry[] = [
      entry('chunk:full:0:0:aaaaaaaaaaaa', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'Sidetrack queues outbound captures with idempotency keys for retry safety.',
        title: 'Capture queue',
        headingPath: ['Architecture'],
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid(
      'idempotency key retry',
      Float32Array.from([1, 0]),
      items,
      baseDate,
      { lexical },
    );
    expect(results[0]?.why?.length ?? 0).toBeGreaterThan(0);
    expect(results[0]?.snippet?.length ?? 0).toBeGreaterThan(0);
    expect(results[0]?.metadata?.title).toBe('Capture queue');
  });

  it('honors excludeIds on the lexical arm, not just the vector arm', () => {
    // chunk:A is a verbatim lexical match for the query. With its id
    // in excludeIds it must be dropped from the lexical results too —
    // excludeIds means "exclude from results", and visit-similarity
    // shares one lexical index across every source query, excluding
    // the source itself per call. (The vector arm honors excludeIds
    // inside vectorIndex.query; here, with no vectorIndex, chunk:A
    // still appears via the flat-scan fallback, so the assertion is
    // specifically that its *lexical* contribution is gone.)
    const items: readonly IndexEntry[] = [
      entry('chunk:A:0:0:aaaaaaaaaaaa', 'thread_a', '2026-05-03T00:00:00.000Z', [0.01, 0], {
        text: 'Move the thread by calling sidetrack.threads.move on the workstream.',
      }),
      entry('chunk:B:0:0:bbbbbbbbbbbb', 'thread_b', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'Unrelated discussion about archive workflows.',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const query = 'sidetrack.threads.move';
    const withA = rankHybrid(query, Float32Array.from([1, 0]), items, baseDate, { lexical });
    const withoutA = rankHybrid(query, Float32Array.from([1, 0]), items, baseDate, {
      lexical,
      excludeIds: new Set(['chunk:A:0:0:aaaaaaaaaaaa']),
    });
    expect(withA.find((r) => r.id === 'chunk:A:0:0:aaaaaaaaaaaa')?.lexical).toBeDefined();
    expect(withoutA.find((r) => r.id === 'chunk:A:0:0:aaaaaaaaaaaa')?.lexical).toBeUndefined();
  });
});

describe('rankHybrid — quality tiebreak', () => {
  const baseDate = new Date('2026-05-03T00:00:00.000Z');

  it('ranks the higher-quality chunk first when relevance is otherwise tied', () => {
    // Two chunks with identical text + identical embedding +
    // identical timestamp: pure RRF + freshness tie. Only the
    // quality tier differs, so the high-quality chunk must win.
    const text = 'Reciprocal rank fusion combines dense and sparse retrieval lists.';
    const items: readonly IndexEntry[] = [
      entry('chunk:low:0:0:aaaaaaaaaaaa', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0], {
        text,
        quality: 'low',
      }),
      entry('chunk:high:0:0:bbbbbbbbbbbb', 'thread_b', '2026-05-03T00:00:00.000Z', [1, 0], {
        text,
        quality: 'high',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid(
      'rank fusion dense sparse',
      Float32Array.from([1, 0]),
      items,
      baseDate,
      {
        lexical,
      },
    );
    expect(results.map((r) => r.id)).toEqual([
      'chunk:high:0:0:bbbbbbbbbbbb',
      'chunk:low:0:0:aaaaaaaaaaaa',
    ]);
    // High-quality chunk gets a positive quality contribution; low
    // gets a negative one. Their relevance is a tie — RRF only
    // separates them by an arbitrary adjacent-rank artifact (rank r
    // vs r+1 by insertion order), and the bounded quality tiebreak
    // is precisely what overturns that artifact so quality decides.
    const high = results.find((r) => r.id === 'chunk:high:0:0:bbbbbbbbbbbb');
    const low = results.find((r) => r.id === 'chunk:low:0:0:aaaaaaaaaaaa');
    expect(high?.explain?.qualityContribution ?? 0).toBeGreaterThan(0);
    expect(low?.explain?.qualityContribution ?? 0).toBeLessThan(0);
    // Both chunks hit BOTH lists, so the relevance "tie" surfaces as
    // a doubled adjacent-rank RRF artifact: 2 × (1/(K+1) − 1/(K+2))
    // ≈ 5.29e-4. Still a tie, not a genuine relevance gap (which
    // would be a ≥2-rank, i.e. ≥ ~1e-3, separation).
    const fusionGap = Math.abs((high?.explain?.fusion ?? 0) - (low?.explain?.fusion ?? 0));
    expect(fusionGap).toBeLessThanOrEqual(2 * (1 / 61 - 1 / 62) + 1e-12);
    // And the high-quality chunk's final score genuinely exceeds the
    // low one's despite that adjacent-rank handicap.
    expect(high?.score ?? 0).toBeGreaterThan(low?.score ?? 0);
  });

  it('does NOT let quality override a genuine relevance lead', () => {
    // A low-quality chunk that is a strong lexical + vector match
    // must still beat a high-quality chunk that only weakly matches.
    const items: readonly IndexEntry[] = [
      entry('chunk:lowrelevant:0:0:cccccccccccc', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'Use sidetrack.threads.move to relocate threads across workstreams quickly.',
        quality: 'low',
      }),
      entry('chunk:highnoise:0:0:dddddddddddd', 'thread_b', '2026-05-03T00:00:00.000Z', [0, 1], {
        text: 'An unrelated essay about CSS grid layout and flexbox alignment.',
        quality: 'high',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid(
      'sidetrack.threads.move',
      Float32Array.from([1, 0]),
      items,
      baseDate,
      { lexical },
    );
    expect(results[0]?.id).toBe('chunk:lowrelevant:0:0:cccccccccccc');
  });

  it('treats a missing quality tier as the neutral medium (no penalty, no boost)', () => {
    // Chunk A has no tier; chunk B is explicitly 'medium'. Identical
    // relevance ⇒ both must get zero quality contribution and the
    // score must equal the no-quality baseline (RRF + freshness).
    const text = 'Embedding cache keyed by embedTextHash avoids recomputing vectors.';
    const items: readonly IndexEntry[] = [
      entry('chunk:untiered:0:0:eeeeeeeeeeee', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0], {
        text,
      }),
      entry('chunk:medium:0:0:ffffffffffff', 'thread_b', '2026-05-03T00:00:00.000Z', [1, 0], {
        text,
        quality: 'medium',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid(
      'embedding cache vectors',
      Float32Array.from([1, 0]),
      items,
      baseDate,
      {
        lexical,
      },
    );
    for (const r of results) {
      expect(r.explain?.qualityContribution).toBe(0);
      expect(r.explain?.qualityTier).toBe('medium');
      // score == fusion + freshness only (quality is a pure no-op).
      const expected = (r.explain?.fusion ?? 0) + (r.explain?.freshnessContribution ?? 0);
      expect(r.score).toBeCloseTo(expected, 12);
    }
  });

  it('treats malformed persisted quality metadata as neutral', () => {
    const item = entry(
      'chunk:badquality:0:0:aaaaaaaaaaaa',
      'thread_a',
      baseDate.toISOString(),
      [1, 0],
      {
        text: 'Persisted recall metadata is parsed from disk and must be defensive.',
        quality: 'high',
      },
    );
    const metadata = item.metadata;
    if (metadata === undefined) throw new Error('metadata missing');
    const items: readonly IndexEntry[] = [
      {
        ...item,
        metadata: { ...metadata, quality: 'corrupt' } as unknown as ChunkMetadata,
      },
    ];
    const results = rankHybrid(
      'persisted recall metadata',
      Float32Array.from([1, 0]),
      items,
      baseDate,
      {
        lexical: buildLexicalIndex(items),
      },
    );

    expect(results[0]?.score).toBeTypeOf('number');
    expect(Number.isNaN(results[0]?.score)).toBe(false);
    expect(results[0]?.explain?.qualityTier).toBe('medium');
    expect(results[0]?.explain?.qualityContribution).toBe(0);
    expect(results[0]?.why?.some((why) => why.includes('quality'))).toBe(false);
  });

  it('leaves RRF + freshness math untouched when quality is equal across candidates', () => {
    // The literal "RRF unchanged when quality equal" guarantee: when
    // NO chunk carries a tier (⇒ all neutral 'medium'), the score is
    // exactly the legacy fusion + freshness with zero quality term —
    // byte-identical to pre-quality behavior. Tagging every chunk
    // the SAME explicit tier preserves ORDER and the fusion backbone
    // (only a constant, order-preserving offset is added).
    const mk = (q?: 'high'): readonly IndexEntry[] => [
      entry('chunk:x:0:0:111111111111', 'thread_a', '2024-01-01T00:00:00.000Z', [1, 0], {
        text: 'Anti-entropy reconciliation merges event logs across replicas.',
        ...(q === undefined ? {} : { quality: q }),
      }),
      entry('chunk:y:0:0:222222222222', 'thread_b', '2026-05-01T00:00:00.000Z', [0.6, 0], {
        text: 'Anti-entropy gossip exchanges merkle digests for replica sync.',
        ...(q === undefined ? {} : { quality: q }),
      }),
    ];
    const q = 'anti-entropy replica sync';
    const noneItems = mk();
    const allHighItems = mk('high');
    const none = rankHybrid(q, Float32Array.from([1, 0]), noneItems, baseDate, {
      lexical: buildLexicalIndex(noneItems),
    });
    const allHigh = rankHybrid(q, Float32Array.from([1, 0]), allHighItems, baseDate, {
      lexical: buildLexicalIndex(allHighItems),
    });
    // No tier ⇒ pure legacy math: score == fusion + freshness, quality term = 0.
    none.forEach((r) => {
      expect(r.explain?.qualityContribution).toBe(0);
      expect(r.score).toBeCloseTo(
        (r.explain?.fusion ?? 0) + (r.explain?.freshnessContribution ?? 0),
        12,
      );
    });
    // Uniform explicit tier: identical ordering + identical fusion
    // backbone; only a constant, order-preserving offset differs.
    expect(allHigh.map((r) => r.id)).toEqual(none.map((r) => r.id));
    none.forEach((r, i) => {
      expect(allHigh[i]?.explain?.fusion).toBeCloseTo(r.explain?.fusion ?? -1, 12);
      expect(allHigh[i]?.explain?.freshnessContribution).toBeCloseTo(
        r.explain?.freshnessContribution ?? -1,
        12,
      );
      // The only delta is the uniform quality offset (same sign/size
      // for every result ⇒ ranking is invariant).
      const delta = (allHigh[i]?.score ?? 0) - r.score;
      expect(delta).toBeCloseTo(allHigh[i]?.explain?.qualityContribution ?? -1, 12);
      expect(delta).toBeGreaterThan(0);
    });
  });
});

describe('rankHybrid — explainability breakdown', () => {
  const baseDate = new Date('2026-05-03T00:00:00.000Z');

  it('emits a structured explain breakdown whose parts sum to the score', () => {
    const items: readonly IndexEntry[] = [
      entry('chunk:full:0:0:aaaaaaaaaaaa', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'Sidetrack queues outbound captures with idempotency keys for retry safety.',
        title: 'Capture queue',
        headingPath: ['Architecture'],
        quality: 'high',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid(
      'idempotency key retry',
      Float32Array.from([1, 0]),
      items,
      baseDate,
      { lexical },
    );
    const top = results[0];
    expect(top?.explain).toBeDefined();
    const ex = top?.explain;
    if (ex === undefined) throw new Error('explain missing');
    // vector + lexical both hit ⇒ ranks present and 1-based.
    expect(ex.vectorRank).toBe(1);
    expect(ex.lexicalRank).toBe(1);
    expect(ex.rrfVector).toBeCloseTo(1 / (60 + 1), 12);
    expect(ex.rrfLexical).toBeCloseTo(1 / (60 + 1), 12);
    expect(ex.fusion).toBeCloseTo(ex.rrfVector + ex.rrfLexical, 12);
    // Composition identity: fusedScore == fusion + freshness + quality.
    expect(ex.fusedScore).toBeCloseTo(
      ex.fusion + ex.freshnessContribution + ex.qualityContribution,
      12,
    );
    // fusedScore mirrors the back-compat top-level score field.
    expect(ex.fusedScore).toBeCloseTo(top?.score ?? -1, 12);
    expect(ex.qualityTier).toBe('high');
    expect(ex.freshness).toBe(1);
    // `why` still carries the human-readable strings (back-compat).
    expect(top?.why?.some((w) => w.includes('quality high'))).toBe(true);
    expect(top?.why?.some((w) => w.startsWith('vector rank'))).toBe(true);
  });

  it('omits lexicalRank (rrfLexical=0) for a chunk absent from the lexical list', () => {
    // The flat vector scan ranks EVERY non-tombstoned chunk, so the
    // observable "single list" shape is: matched the vector list,
    // missed the lexical one. The lexically-matched chunk carries
    // BOTH ranks; the no-lexical-overlap chunk carries only the
    // vector rank with rrfLexical pinned to 0.
    const items: readonly IndexEntry[] = [
      entry('chunk:both:0:0:aaaaaaaaaaaa', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0, 0], {
        text: 'The verbatim token zxqwvtoken appears only in this chunk.',
      }),
      entry(
        'chunk:vecnolex:0:0:bbbbbbbbbbbb',
        'thread_b',
        '2026-05-03T00:00:00.000Z',
        [0.9, 0, 0],
        {
          text: 'Completely different prose with no shared query terms at all.',
        },
      ),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid('zxqwvtoken', Float32Array.from([1, 0, 0]), items, baseDate, {
      lexical,
    });
    const both = results.find((r) => r.id === 'chunk:both:0:0:aaaaaaaaaaaa');
    const vecOnly = results.find((r) => r.id === 'chunk:vecnolex:0:0:bbbbbbbbbbbb');
    // Lexically-matched chunk: both ranks present, both RRF terms > 0.
    expect(both?.explain?.lexicalRank).toBeDefined();
    expect(both?.explain?.vectorRank).toBeDefined();
    expect(both?.explain?.rrfLexical ?? 0).toBeGreaterThan(0);
    // No-lexical-overlap chunk: vector rank only, lexical RRF == 0.
    expect(vecOnly?.explain?.vectorRank).toBeDefined();
    expect(vecOnly?.explain?.lexicalRank).toBeUndefined();
    expect(vecOnly?.explain?.rrfLexical).toBe(0);
    // fusion == rrfVector + rrfLexical holds for both shapes.
    expect(vecOnly?.explain?.fusion).toBeCloseTo(vecOnly?.explain?.rrfVector ?? -1, 12);
  });
});

describe('rankHybrid — vector-only fallback preserved', () => {
  const baseDate = new Date('2026-05-03T00:00:00.000Z');

  it('rank() (the 0-hybrid fallback path) is unchanged and ignores quality', () => {
    // Plain rank() is the documented fallback the HTTP layer uses
    // when rankHybrid returns nothing. It must NOT gain quality
    // weighting, explain, or why — its shape stays byte-identical.
    const items: readonly IndexEntry[] = [
      entry('low', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'identical relevance, low tier',
        quality: 'low',
      }),
      entry('high', 'thread_b', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'identical relevance, high tier',
        quality: 'high',
      }),
    ];
    const results = rank(Float32Array.from([1, 0]), items, baseDate);
    // cosine == 1 and freshness == 1 for both ⇒ identical score; the
    // fallback does not reorder on quality.
    expect(results).toHaveLength(2);
    expect(results[0]?.score).toBeCloseTo(results[1]?.score ?? -1, 12);
    for (const r of results) {
      expect(r.score).toBeCloseTo(1, 12);
      // Back-compat shape: no hybrid-only fields on the fallback path.
      expect(r.explain).toBeUndefined();
      expect(r.why).toBeUndefined();
      expect(r.vector).toBeUndefined();
      expect(r.lexical).toBeUndefined();
    }
  });

  it('rankHybrid with an empty lexical index degenerates to vector ranking', () => {
    // Empty corpus for minisearch ⇒ zero lexical hits. RRF collapses
    // to the vector list; the vector-strongest chunk must rank first
    // and quality is still only a within-tie nudge.
    const items: readonly IndexEntry[] = [
      entry('chunk:strong:0:0:aaaaaaaaaaaa', 'thread_a', '2026-05-03T00:00:00.000Z', [1, 0], {
        text: 'alpha',
      }),
      entry('chunk:weak:0:0:bbbbbbbbbbbb', 'thread_b', '2026-05-03T00:00:00.000Z', [0.2, 0], {
        text: 'beta',
      }),
    ];
    const lexical = buildLexicalIndex(items);
    // Query string shares no tokens with either chunk ⇒ lexical
    // returns nothing; fusion is vector-only.
    const results = rankHybrid('zzzznomatch', Float32Array.from([1, 0]), items, baseDate, {
      lexical,
    });
    expect(results[0]?.id).toBe('chunk:strong:0:0:aaaaaaaaaaaa');
    expect(results[0]?.explain?.lexicalRank).toBeUndefined();
    expect(results[0]?.explain?.rrfLexical).toBe(0);
    expect(results[0]?.vector?.rank).toBe(1);
  });
});

// Mixed CJK + Latin tokenization regression (#69). The original
// tokenizer split only on Latin whitespace + ASCII punctuation, so a
// Chinese paragraph became one giant token (e.g. "再抽出它的测试模型")
// and MiniSearch's `prefix: true` search only matched query terms
// that the token STARTED with — embedded Latin terms ("Jepsen、Elle、
// TLA+、DST、fuzzing") AND mid-paragraph Chinese terms ("测试" inside
// "再抽出它的测试模型") were both invisible. The dogfood symptom: a
// captured ChatGPT thread whose full assistant text was in the events
// log returned zero recall hits for those embedded terms.
//
// Fix is in two layers:
//   1) Extend the splitter with CJK punctuation, ideographic space,
//      and ASCII `/`, plus a CJK↔Latin boundary lookahead/lookbehind
//      so embedded English in CJK text surfaces as its own token.
//   2) For pure-CJK tokens, additionally emit overlapping 2-grams so
//      MiniSearch's prefix-match can find a CJK query anywhere in a
//      glued Chinese paragraph (the Lucene CJKBigramAnalyzer pattern).
// Both layers are required: (1) alone misses mid-paragraph CJK like
// "测试" inside "再抽出它的测试模型"; (2) alone misses "Jepsen" because
// it gets glued onto "、Elle、TLA+…" with no whitespace.
describe('tokenizer — mixed CJK + Latin (regression for #69)', () => {
  const TARGET_ID = `chunk:target:0:0:${'a'.repeat(12)}`;
  const OTHER_ID = `chunk:other:0:0:${'b'.repeat(12)}`;
  const baseDate = new Date('2026-05-20T00:00:00.000Z');

  const queryHits = (q: string, items: readonly IndexEntry[]): readonly string[] => {
    const lexical = buildLexicalIndex(items);
    return rankHybrid(q, Float32Array.from([1, 0]), items, baseDate, { lexical }).map(
      (r) => r.id,
    );
  };

  it('embedded English in a CJK paragraph (Jepsen、Elle、TLA+) — was 0 hits', () => {
    const items: readonly IndexEntry[] = [
      entry(TARGET_ID, 'thread_target', '2026-05-20T00:00:00.000Z', [1, 0], {
        text: '它不替代 Jepsen、Elle、TLA+、DST、fuzzing，而是给 agent 一个上层框架。',
      }),
      entry(OTHER_ID, 'thread_other', '2026-05-20T00:00:00.000Z', [0, 1], {
        text: 'Unrelated chunk about persistence and replication.',
      }),
    ];
    for (const q of ['Jepsen', 'Elle', 'fuzzing', 'agent']) {
      expect(queryHits(q, items), `query=${q}`).toContain(TARGET_ID);
    }
  });

  it('mid-paragraph CJK term inside a long Chinese glued token — was 0 hits without bigrams', () => {
    // Same shape as the dogfood-captured chunk: a Chinese paragraph
    // where "测试" sits in the MIDDLE of a longer token (after
    // punctuation splits) so prefix-match alone never finds it.
    const items: readonly IndexEntry[] = [
      entry(TARGET_ID, 'thread_target', '2026-05-20T00:00:00.000Z', [1, 0], {
        text: '我会先看 repo 的 README/目录结构，再抽出它的测试模型和故障注入检查器。',
      }),
      entry(OTHER_ID, 'thread_other', '2026-05-20T00:00:00.000Z', [0, 1], {
        text: 'Unrelated chunk text.',
      }),
    ];
    for (const q of ['测试', '故障注入', 'README', '检查器']) {
      expect(queryHits(q, items), `query=${q}`).toContain(TARGET_ID);
    }
  });

  it('CJK↔Latin no-separator boundary still splits (lookbehind path)', () => {
    const items: readonly IndexEntry[] = [
      entry(TARGET_ID, 'thread_target', '2026-05-20T00:00:00.000Z', [1, 0], {
        text: '故障注入Jepsen混合段落',
      }),
      entry(OTHER_ID, 'thread_other', '2026-05-20T00:00:00.000Z', [0, 1], {
        text: 'Unrelated.',
      }),
    ];
    for (const q of ['Jepsen', '故障注入', '混合']) {
      expect(queryHits(q, items), `query=${q}`).toContain(TARGET_ID);
    }
  });

  it('preserves existing dotted-identifier split (sidetrack.threads.move)', () => {
    const items: readonly IndexEntry[] = [
      entry(TARGET_ID, 'thread_target', '2026-05-20T00:00:00.000Z', [1, 0], {
        text: 'Move the thread by calling sidetrack.threads.move on the workstream.',
      }),
      entry(OTHER_ID, 'thread_other', '2026-05-20T00:00:00.000Z', [0, 1], {
        text: 'Unrelated chunk text.',
      }),
    ];
    for (const q of ['sidetrack.threads.move', 'move', 'threads', 'sidetrack']) {
      expect(queryHits(q, items), `query=${q}`).toContain(TARGET_ID);
    }
  });

});
