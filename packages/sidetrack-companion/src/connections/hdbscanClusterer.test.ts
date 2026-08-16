import { describe, expect, it } from 'vitest';

import {
  TOPIC_HDBSCAN_REVISION_KEY,
  TOPIC_INCREMENTAL_REVISION_KEY,
  TOPIC_LEIDEN_CPM_REVISION_KEY,
  TOPIC_REVISION_KEYS,
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
} from '../producers/topic-revision.js';
import {
  buildTopicRevision,
  type TopicVisit,
  type VisitSimilarityEdge,
  type VisitSimilarityRevisionInput,
} from './topicClusterer.js';
import { buildHdbscanTopicRevision, densityConnectedComponents } from './hdbscanClusterer.js';

const producedAt = Date.parse('2026-05-08T12:00:00.000Z');

const canonicalUrl = (suffix: string): string => `https://example.test/${suffix}`;

const visit = (
  canonicalUrlValue: string,
  overrides: Partial<Omit<TopicVisit, 'canonicalUrl'>> = {},
): TopicVisit => ({
  canonicalUrl: canonicalUrlValue,
  title: `Title ${canonicalUrlValue.slice(-2).toUpperCase()}`,
  focusedWindowMs: 10_000,
  firstObservedAt: '2026-05-08T10:00:00.000Z',
  lastObservedAt: '2026-05-08T11:00:00.000Z',
  ...overrides,
});

const edge = (fromVisitKey: string, toVisitKey: string, cosine: number): VisitSimilarityEdge => ({
  fromVisitKey,
  toVisitKey,
  cosine,
});

const cliqueEdges = (
  memberCanonicalUrls: readonly string[],
  cosine: number,
): readonly VisitSimilarityEdge[] =>
  memberCanonicalUrls.flatMap((fromVisitKey, index) =>
    memberCanonicalUrls
      .slice(index + 1)
      .map((toVisitKey) => edge(fromVisitKey, toVisitKey, cosine)),
  );

const membersInTopics = (revision: Awaited<ReturnType<typeof buildHdbscanTopicRevision>>) =>
  revision.topics.flatMap((topic) => topic.memberCanonicalUrls).sort();

describe('buildHdbscanTopicRevision', () => {
  it('registers the HDBSCAN topic revision key while Union-Find remains available', async () => {
    const a = canonicalUrl('key-a');
    const b = canonicalUrl('key-b');
    const visits = [visit(a), visit(b)];
    const visitSimilarity: VisitSimilarityRevisionInput = {
      revisionId: 'sim-key',
      edges: [edge(a, b, 0.95)],
    };

    const unionFindRevision = await buildTopicRevision({
      visits,
      visitSimilarity,
      options: { producedAt },
    });
    const hdbscanRevision = await buildHdbscanTopicRevision({
      visits,
      visitSimilarity,
      userAssertedRelations: [{ kind: 'in_thread', fromVisitKey: a, toVisitKey: b }],
      options: { producedAt },
    });

    expect(TOPIC_REVISION_KEYS).toEqual([
      TOPIC_UNION_FIND_REVISION_KEY,
      TOPIC_HDBSCAN_REVISION_KEY,
      TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
      TOPIC_LEIDEN_CPM_REVISION_KEY,
      TOPIC_INCREMENTAL_REVISION_KEY,
    ]);
    expect(unionFindRevision.algorithmVersion).toBe(TOPIC_UNION_FIND_REVISION_KEY);
    expect(hdbscanRevision.algorithmVersion).toBe(TOPIC_HDBSCAN_REVISION_KEY);
  });

  it('produces byte-identical output for identical input', async () => {
    const a = canonicalUrl('det-a');
    const b = canonicalUrl('det-b');
    const c = canonicalUrl('det-c');
    const d = canonicalUrl('det-d');
    const input = {
      visits: [
        visit(c, { workstreamId: 'ws-det' }),
        visit(a, { workstreamId: 'ws-det' }),
        visit(d),
        visit(b, { workstreamId: 'ws-det' }),
      ],
      visitSimilarity: {
        revisionId: 'sim-hdbscan-determinism',
        edges: [
          edge(c, d, 0.91),
          edge(a, b, 0.93),
          edge(b, c, 0.92),
          edge(a, c, 0.91),
          edge(b, d, 0.9),
        ],
      },
      options: { producedAt },
    };

    const first = await buildHdbscanTopicRevision(input);
    const second = await buildHdbscanTopicRevision(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('drops a single sparse outlier that Union-Find pulls into a 10-visit chain', async () => {
    const dense = Array.from({ length: 9 }, (_value, index) =>
      canonicalUrl(`dense-${String(index + 1).padStart(2, '0')}`),
    );
    const outlier = canonicalUrl('outlier');
    const visits = [...dense, outlier].map((url) => visit(url));
    const firstDense = dense[0];
    if (firstDense === undefined) throw new Error('missing dense fixture seed');
    const visitSimilarity: VisitSimilarityRevisionInput = {
      revisionId: 'sim-hdbscan-outlier',
      edges: [...cliqueEdges(dense, 0.94), edge(firstDense, outlier, 0.86)],
    };

    const unionFindRevision = await buildTopicRevision({
      visits,
      visitSimilarity,
      options: { producedAt },
    });
    const hdbscanRevision = await buildHdbscanTopicRevision({
      visits,
      visitSimilarity,
      options: { producedAt },
    });

    expect(unionFindRevision.topics).toHaveLength(1);
    expect(unionFindRevision.topics[0]?.memberCanonicalUrls).toEqual([...dense, outlier].sort());
    expect(hdbscanRevision.topics).toHaveLength(1);
    expect(hdbscanRevision.topics[0]?.memberCanonicalUrls).toEqual(dense);
    expect(membersInTopics(hdbscanRevision)).not.toContain(outlier);
  });

  it('keeps cohesion stable when HDBSCAN and Union-Find select the same component', async () => {
    const a = canonicalUrl('cohesion-a');
    const b = canonicalUrl('cohesion-b');
    const c = canonicalUrl('cohesion-c');
    const d = canonicalUrl('cohesion-d');
    const visits = [visit(a), visit(b), visit(c), visit(d)];
    const visitSimilarity: VisitSimilarityRevisionInput = {
      revisionId: 'sim-hdbscan-cohesion',
      edges: [
        edge(a, b, 0.85),
        edge(a, c, 0.9),
        edge(a, d, 0.95),
        edge(b, c, 0.88),
        edge(b, d, 0.92),
        edge(c, d, 0.96),
      ],
    };

    const unionFindRevision = await buildTopicRevision({
      visits,
      visitSimilarity,
      options: { producedAt },
    });
    const hdbscanRevision = await buildHdbscanTopicRevision({
      visits,
      visitSimilarity,
      options: { producedAt },
    });

    expect(hdbscanRevision.topics[0]?.memberCanonicalUrls).toEqual(
      unionFindRevision.topics[0]?.memberCanonicalUrls,
    );
    expect(hdbscanRevision.topics[0]?.metadata.cohesion).toBe(
      unionFindRevision.topics[0]?.metadata.cohesion,
    );
  });
});

describe('densityConnectedComponents — generic member-pool primitive', () => {
  const ids = (...values: readonly string[]): ReadonlySet<string> => new Set(values);

  it('clusters a tight triangle above threshold with minSamples=3', () => {
    const members = ids('a', 'b', 'c');
    const edges = [
      { fromId: 'a', toId: 'b', cosine: 0.95 },
      { fromId: 'b', toId: 'c', cosine: 0.94 },
      { fromId: 'a', toId: 'c', cosine: 0.93 },
    ];
    const components = densityConnectedComponents(members, edges, 0.9, 3);
    const real = components.filter((c) => c.members.length > 1);
    expect(real).toHaveLength(1);
    expect([...real[0]?.members ?? []].sort()).toEqual(['a', 'b', 'c']);
  });

  it('below cosineThreshold, nothing clusters (each id its own singleton)', () => {
    const members = ids('a', 'b', 'c');
    const edges = [
      { fromId: 'a', toId: 'b', cosine: 0.5 },
      { fromId: 'b', toId: 'c', cosine: 0.5 },
    ];
    const components = densityConnectedComponents(members, edges, 0.9, 3);
    expect(components.every((c) => c.members.length === 1)).toBe(true);
  });

  it('two disjoint dense groups produce two components, not one', () => {
    const members = ids('a', 'b', 'c', 'x', 'y', 'z');
    const edges = [
      { fromId: 'a', toId: 'b', cosine: 0.95 },
      { fromId: 'b', toId: 'c', cosine: 0.95 },
      { fromId: 'a', toId: 'c', cosine: 0.95 },
      { fromId: 'x', toId: 'y', cosine: 0.95 },
      { fromId: 'y', toId: 'z', cosine: 0.95 },
      { fromId: 'x', toId: 'z', cosine: 0.95 },
    ];
    const components = densityConnectedComponents(members, edges, 0.9, 3);
    const real = components.filter((c) => c.members.length > 1).map((c) => [...c.members].sort());
    expect(real).toHaveLength(2);
  });

  it('is order-independent (edge order does not change the result)', () => {
    const members = ids('a', 'b', 'c');
    const edges = [
      { fromId: 'a', toId: 'b', cosine: 0.95 },
      { fromId: 'b', toId: 'c', cosine: 0.94 },
      { fromId: 'a', toId: 'c', cosine: 0.93 },
    ];
    const forward = densityConnectedComponents(members, edges, 0.9, 3);
    const reversed = densityConnectedComponents(members, [...edges].reverse(), 0.9, 3);
    const normalize = (cs: typeof forward) =>
      [...cs].map((c) => [...c.members].sort()).sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
    expect(normalize(reversed)).toEqual(normalize(forward));
  });
});
