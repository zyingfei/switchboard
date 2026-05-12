// Stage 5.2 W4 — IncrementalTopicClusterAccumulator.getEdges() tests.
// Verifies the ledger snapshot is sorted + carries the source tag,
// and that removeEdge updates getEdges consistently.

import { describe, expect, it } from 'vitest';

import {
  IncrementalTopicClusterAccumulator,
  type TopicVisit,
} from './topicClusterer.js';

const visit = (canonicalUrl: string): TopicVisit => ({
  canonicalUrl,
  title: canonicalUrl,
  focusedWindowMs: 60_000,
  firstObservedAt: '2026-05-12T10:00:00.000Z',
  lastObservedAt: '2026-05-12T10:30:00.000Z',
});

describe('Stage 5.2 W4 — IncrementalTopicClusterAccumulator.getEdges', () => {
  it('returns an empty list for a fresh accumulator', () => {
    const acc = new IncrementalTopicClusterAccumulator();
    expect(acc.getEdges()).toEqual([]);
  });

  it('returns added similarity + user-asserted edges sorted by (a, b) with source tag', () => {
    const acc = new IncrementalTopicClusterAccumulator();
    acc.addVisit(visit('a'));
    acc.addVisit(visit('b'));
    acc.addVisit(visit('c'));
    acc.addSimilarityEdge({ fromVisitKey: 'c', toVisitKey: 'b', cosine: 0.9 }, 0.85);
    acc.addUserAssertedRelation({
      kind: 'in_workstream',
      fromVisitKey: 'b',
      toVisitKey: 'a',
    });
    expect(acc.getEdges()).toEqual([
      { a: 'b', b: 'a', source: 'user-asserted' },
      { a: 'c', b: 'b', source: 'similarity' },
    ]);
  });

  it('removeEdge drops the entry from getEdges', () => {
    const acc = new IncrementalTopicClusterAccumulator();
    acc.addVisit(visit('a'));
    acc.addVisit(visit('b'));
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 }, 0.85);
    expect(acc.getEdges()).toHaveLength(1);
    acc.removeEdge('a', 'b');
    expect(acc.getEdges()).toEqual([]);
  });

  it('duplicate addSimilarityEdge keeps a single ledger entry (last-wins on source)', () => {
    const acc = new IncrementalTopicClusterAccumulator();
    acc.addVisit(visit('a'));
    acc.addVisit(visit('b'));
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 }, 0.85);
    acc.addUserAssertedRelation({
      kind: 'in_workstream',
      fromVisitKey: 'a',
      toVisitKey: 'b',
    });
    expect(acc.getEdges()).toHaveLength(1);
    // Last write wins — the user-asserted relation overrode the
    // similarity entry in the internal Map.
    expect(acc.getEdges()[0]?.source).toBe('user-asserted');
  });
});
