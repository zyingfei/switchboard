// Stage 5.2 W4 — byte-equality parity test for
// buildTopicRevisionFromAccumulator vs buildTopicRevision.

import { describe, expect, it } from 'vitest';

import {
  buildTopicRevision,
  buildTopicRevisionFromAccumulator,
  IncrementalTopicClusterAccumulator,
  type TopicVisit,
  type VisitSimilarityEdge,
} from './topicClusterer.js';
import { DEFAULT_TOPIC_COSINE_THRESHOLD } from '../producers/topic-revision.js';

const visit = (canonicalUrl: string, focusedWindowMs = 60_000): TopicVisit => ({
  canonicalUrl,
  title: canonicalUrl,
  focusedWindowMs,
  firstObservedAt: '2026-05-12T10:00:00.000Z',
  lastObservedAt: '2026-05-12T10:30:00.000Z',
});

describe('Stage 5.2 W4 — buildTopicRevisionFromAccumulator', () => {
  it('byte-equal output (modulo producedAt) with buildTopicRevision for same input', async () => {
    const visits = [
      visit('https://example.com/a'),
      visit('https://example.com/b'),
      visit('https://example.com/c'),
      visit('https://example.com/d'),
    ];
    const edges: readonly VisitSimilarityEdge[] = [
      { fromVisitKey: 'https://example.com/a', toVisitKey: 'https://example.com/b', cosine: 0.9 },
      { fromVisitKey: 'https://example.com/b', toVisitKey: 'https://example.com/c', cosine: 0.92 },
    ];
    const visitSimilarity = { revisionId: 'rev-1', edges };

    const producedAt = 1_700_000_000_000;
    const oneShot = await buildTopicRevision({
      visits,
      visitSimilarity,
      options: { cosineThreshold: 0.85, engagementGateMs: 0, producedAt },
    });

    const acc = new IncrementalTopicClusterAccumulator();
    for (const v of visits) acc.addVisit(v);
    for (const edge of edges) acc.addSimilarityEdge(edge, DEFAULT_TOPIC_COSINE_THRESHOLD);
    const fromAcc = await buildTopicRevisionFromAccumulator({
      accumulator: acc,
      visits,
      visitSimilarity,
      options: { cosineThreshold: 0.85, producedAt },
    });

    expect(fromAcc.revisionId).toBe(oneShot.revisionId);
    expect(fromAcc.topics).toEqual(oneShot.topics);
    expect(fromAcc.lineage).toEqual(oneShot.lineage);
  });

  it('lineage tracks merges when two previous topics combine in the new revision', async () => {
    const visits = [visit('a'), visit('b'), visit('c'), visit('d')];
    // Previous revision has two topics: {a, b} and {c, d}.
    const previousRevision = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'rev-0',
        edges: [
          { fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 },
          { fromVisitKey: 'c', toVisitKey: 'd', cosine: 0.9 },
        ],
      },
      options: { cosineThreshold: 0.85, engagementGateMs: 0, producedAt: 1_000 },
    });
    expect(previousRevision.topics).toHaveLength(2);
    // New revision merges both into one component via a-c bridge.
    const acc = new IncrementalTopicClusterAccumulator();
    for (const v of visits) acc.addVisit(v);
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 }, 0.85);
    acc.addSimilarityEdge({ fromVisitKey: 'c', toVisitKey: 'd', cosine: 0.9 }, 0.85);
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'c', cosine: 0.9 }, 0.85);
    const next = await buildTopicRevisionFromAccumulator({
      accumulator: acc,
      visits,
      visitSimilarity: {
        revisionId: 'rev-1',
        edges: [
          { fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 },
          { fromVisitKey: 'c', toVisitKey: 'd', cosine: 0.9 },
          { fromVisitKey: 'a', toVisitKey: 'c', cosine: 0.9 },
        ],
      },
      previousRevision,
      options: { cosineThreshold: 0.85, producedAt: 2_000 },
    });
    expect(next.topics).toHaveLength(1);
    expect(next.lineage.some((l) => l.kind === 'merge')).toBe(true);
  });

  it('empty accumulator produces an empty topic revision', async () => {
    const acc = new IncrementalTopicClusterAccumulator();
    const rev = await buildTopicRevisionFromAccumulator({
      accumulator: acc,
      visits: [],
      visitSimilarity: { revisionId: 'rev-empty', edges: [] },
      options: { producedAt: 1_000 },
    });
    expect(rev.topics).toEqual([]);
    expect(rev.lineage).toEqual([]);
  });
});
