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
      entry(
        'chunk:A:0:0:aaaaaaaaaaaa',
        'thread_a',
        '2026-05-03T00:00:00.000Z',
        [0.1, 0],
        { text: 'Move the thread by calling sidetrack.threads.move on the workstream.' },
      ),
      entry(
        'chunk:B:0:0:bbbbbbbbbbbb',
        'thread_b',
        '2026-05-03T00:00:00.000Z',
        [1, 0],
        { text: 'Discussion about archive workflows and unrelated content.' },
      ),
    ];
    const lexical = buildLexicalIndex(items);
    const results = rankHybrid('sidetrack.threads.move', Float32Array.from([1, 0]), items, baseDate, {
      lexical,
    });
    expect(results[0]?.id).toBe('chunk:A:0:0:aaaaaaaaaaaa');
    expect(results[0]?.lexical?.rank).toBeDefined();
  });

  it('retrieves a chunk on semantic similarity when the literal term is absent', () => {
    // Vector-only retrieval — query words aren't in the chunk text,
    // but the embedding is identical so the vector ranker wins.
    const items: readonly IndexEntry[] = [
      entry(
        'chunk:A:0:0:aaaaaaaaaaaa',
        'thread_a',
        '2026-05-03T00:00:00.000Z',
        [1, 0, 0],
        { text: 'A discussion about local-first architecture and offline replication.' },
      ),
      entry(
        'chunk:B:0:0:bbbbbbbbbbbb',
        'thread_b',
        '2026-05-03T00:00:00.000Z',
        [0, 0, 1],
        { text: 'Unrelated content about CSS layout patterns.' },
      ),
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
      entry(
        'chunk:relevant:0:0:cccccccccccc',
        'thread_a',
        '2022-05-03T00:00:00.000Z',
        [1, 0],
        { text: 'Use sidetrack.threads.move to relocate threads across workstreams.' },
      ),
      // Brand new but unrelated.
      entry(
        'chunk:fresh:0:0:dddddddddddd',
        'thread_b',
        '2026-05-03T00:00:00.000Z',
        [0, 1],
        { text: 'Unrelated chat about CSS.' },
      ),
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
});
