// Stage 5.2 W4 — incremental topic accumulator (hot-add path only).
// Verifies that the union-find-based accumulator produces the same
// connected components as a one-shot buildTopicRevision over the same
// visits + edges + relations (modulo metadata + lineage which the
// accumulator deliberately omits).

import { describe, expect, it } from 'vitest';

import {
  buildTopicRevision,
  IncrementalTopicClusterAccumulator,
  type TopicVisit,
  type VisitSimilarityEdge,
} from './topicClusterer.js';

const visit = (canonicalUrl: string, focusedWindowMs = 60_000): TopicVisit => ({
  canonicalUrl,
  title: canonicalUrl,
  focusedWindowMs,
  firstObservedAt: '2026-05-12T10:00:00.000Z',
  lastObservedAt: '2026-05-12T10:30:00.000Z',
});

describe('Stage 5.2 W4 — IncrementalTopicClusterAccumulator', () => {
  it('hot-add of high-cosine edges produces the same components as buildTopicRevision', async () => {
    const visits = [
      visit('https://example.com/a'),
      visit('https://example.com/b'),
      visit('https://example.com/c'),
      visit('https://example.com/d'),
    ];
    const edges: readonly VisitSimilarityEdge[] = [
      { fromVisitKey: 'https://example.com/a', toVisitKey: 'https://example.com/b', cosine: 0.9 },
      { fromVisitKey: 'https://example.com/b', toVisitKey: 'https://example.com/c', cosine: 0.92 },
      // Edge below threshold — should NOT merge components.
      { fromVisitKey: 'https://example.com/c', toVisitKey: 'https://example.com/d', cosine: 0.5 },
    ];
    const acc = new IncrementalTopicClusterAccumulator();
    for (const v of visits) acc.addVisit(v);
    for (const edge of edges) acc.addSimilarityEdge(edge, 0.85);
    const components = await acc.getComponents();

    const oneShot = await buildTopicRevision({
      visits,
      visitSimilarity: { revisionId: 'r1', edges },
      options: { cosineThreshold: 0.85, engagementGateMs: 0 },
    });
    const oneShotMembers = oneShot.topics.map((t) => [...t.memberCanonicalUrls].sort());
    const accMembers = components.map((c) => [...c.memberCanonicalUrls].sort());
    expect(accMembers).toEqual(oneShotMembers);
  });

  it('user-asserted relations merge components regardless of cosine threshold', async () => {
    const visits = [visit('a'), visit('b'), visit('c')];
    const acc = new IncrementalTopicClusterAccumulator();
    for (const v of visits) acc.addVisit(v);
    acc.addUserAssertedRelation({ kind: 'in_workstream', fromVisitKey: 'a', toVisitKey: 'b' });
    acc.addUserAssertedRelation({ kind: 'in_workstream', fromVisitKey: 'b', toVisitKey: 'c' });
    const components = await acc.getComponents();
    expect(components).toHaveLength(1);
    expect([...components[0]!.memberCanonicalUrls].sort()).toEqual(['a', 'b', 'c']);
  });

  it('singleton components are filtered out', async () => {
    const acc = new IncrementalTopicClusterAccumulator();
    acc.addVisit(visit('isolated'));
    expect(await acc.getComponents()).toEqual([]);
  });

  it('edges with unknown endpoints are ignored (no implicit visit creation)', async () => {
    const acc = new IncrementalTopicClusterAccumulator();
    acc.addVisit(visit('a'));
    acc.addSimilarityEdge(
      { fromVisitKey: 'a', toVisitKey: 'unknown', cosine: 0.99 },
      0.85,
    );
    expect(await acc.getComponents()).toEqual([]);
  });

  it('removeEdge disconnects a component when no alternate path remains', async () => {
    const visits = [visit('a'), visit('b'), visit('c')];
    const acc = new IncrementalTopicClusterAccumulator();
    for (const v of visits) acc.addVisit(v);
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 }, 0.85);
    acc.addSimilarityEdge({ fromVisitKey: 'b', toVisitKey: 'c', cosine: 0.9 }, 0.85);
    // Initially {a,b,c} is one component.
    let components = await acc.getComponents();
    expect(components).toHaveLength(1);
    // Remove the a-b edge — {a} should split off, leaving {b,c}.
    acc.removeEdge('a', 'b');
    components = await acc.getComponents();
    expect(components).toHaveLength(1);
    expect([...components[0]!.memberCanonicalUrls].sort()).toEqual(['b', 'c']);
  });

  it('removeEdge keeps the component together when an alternate path exists', async () => {
    const visits = [visit('a'), visit('b'), visit('c')];
    const acc = new IncrementalTopicClusterAccumulator();
    for (const v of visits) acc.addVisit(v);
    // Triangle: a-b, b-c, a-c. Removing one edge keeps all in one component.
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 }, 0.85);
    acc.addSimilarityEdge({ fromVisitKey: 'b', toVisitKey: 'c', cosine: 0.9 }, 0.85);
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'c', cosine: 0.9 }, 0.85);
    acc.removeEdge('a', 'b');
    const components = await acc.getComponents();
    expect(components).toHaveLength(1);
    expect([...components[0]!.memberCanonicalUrls].sort()).toEqual(['a', 'b', 'c']);
  });

  it('removeEdge of a non-existent edge is a no-op', async () => {
    const acc = new IncrementalTopicClusterAccumulator();
    acc.addVisit(visit('a'));
    acc.addVisit(visit('b'));
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 }, 0.85);
    acc.removeEdge('a', 'z'); // 'z' isn't registered; removal silently ignored
    const components = await acc.getComponents();
    expect(components).toHaveLength(1);
    expect([...components[0]!.memberCanonicalUrls].sort()).toEqual(['a', 'b']);
  });

  it('addEdge is idempotent / commutative under permutation', async () => {
    const visits = [visit('a'), visit('b'), visit('c'), visit('d')];
    const edges: readonly VisitSimilarityEdge[] = [
      { fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 },
      { fromVisitKey: 'b', toVisitKey: 'c', cosine: 0.9 },
      { fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.95 }, // duplicate
    ];
    const forward = new IncrementalTopicClusterAccumulator();
    for (const v of visits) forward.addVisit(v);
    for (const e of edges) forward.addSimilarityEdge(e, 0.85);
    const reverse = new IncrementalTopicClusterAccumulator();
    for (const v of [...visits].reverse()) reverse.addVisit(v);
    for (const e of [...edges].reverse()) reverse.addSimilarityEdge(e, 0.85);

    const f = (await forward.getComponents()).map((c) => [...c.memberCanonicalUrls].sort());
    const r = (await reverse.getComponents()).map((c) => [...c.memberCanonicalUrls].sort());
    expect(r).toEqual(f);
  });
});
