import { describe, expect, it } from 'vitest';

import {
  buildTopicRevision,
  type TopicVisit,
  type VisitSimilarityEdge,
} from './topicClusterer.js';
import { topicId } from './topicId.js';

const producedAt = Date.parse('2026-05-08T12:00:00.000Z');

const visit = (
  canonicalUrl: string,
  overrides: Partial<Omit<TopicVisit, 'canonicalUrl'>> = {},
): TopicVisit => ({
  canonicalUrl,
  title: `Title ${canonicalUrl.slice(-1).toUpperCase()}`,
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

const urls = (suffixes: readonly string[]): readonly string[] =>
  suffixes.map((suffix) => `https://example.test/${suffix}`);

describe('buildTopicRevision', () => {
  it('clusters only cosine edges at or above the threshold', async () => {
    const [a, b, c] = urls(['a', 'b', 'c']);
    const visits = [visit(a!), visit(b!), visit(c!)];

    const weak = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'sim-weak',
        edges: [edge(a!, b!, 0.84), edge(b!, c!, 0.84), edge(a!, c!, 0.84)],
      },
      options: { producedAt },
    });
    expect(weak.topics).toHaveLength(0);

    const strong = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'sim-strong',
        edges: [edge(a!, b!, 0.86), edge(b!, c!, 0.86), edge(a!, c!, 0.86)],
      },
      options: { producedAt },
    });
    expect(strong.topics).toHaveLength(1);
    expect(strong.topics[0]?.memberCanonicalUrls).toEqual([a, b, c]);
  });

  it('lets user-asserted visit relations override missing cosine edges', async () => {
    const [a, b, c] = urls(['a', 'b', 'c']);

    const revision = await buildTopicRevision({
      visits: [visit(a!), visit(b!), visit(c!)],
      visitSimilarity: { revisionId: 'sim-empty', edges: [] },
      userAssertedRelations: [{ kind: 'in_thread', fromVisitKey: b!, toVisitKey: a! }],
      options: { producedAt },
    });

    expect(revision.topics).toHaveLength(1);
    expect(revision.topics[0]?.memberCanonicalUrls).toEqual([a, b]);
  });

  it('excludes visits below the focused-window engagement gate', async () => {
    const [a, b] = urls(['a', 'b']);

    const revision = await buildTopicRevision({
      visits: [visit(a!), visit(b!, { focusedWindowMs: 4_000 })],
      visitSimilarity: {
        revisionId: 'sim-gate',
        edges: [edge(a!, b!, 0.99)],
      },
      options: { producedAt },
    });

    expect(revision.topics).toHaveLength(0);
  });

  it('suppresses singleton topic components', async () => {
    const [a] = urls(['a']);

    const revision = await buildTopicRevision({
      visits: [visit(a!)],
      visitSimilarity: {
        revisionId: 'sim-singleton',
        edges: [edge(a!, a!, 0.99)],
      },
      options: { producedAt },
    });

    expect(revision.topics).toHaveLength(0);
  });

  it('emits split lineage including a singleton target whose topic node is suppressed', async () => {
    const [a, b, c, d] = urls(['a', 'b', 'c', 'd']);
    const visits = [visit(a!), visit(b!), visit(c!), visit(d!)];
    const previous = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'sim-previous-split',
        edges: [
          edge(a!, b!, 0.91),
          edge(b!, c!, 0.91),
          edge(c!, d!, 0.91),
        ],
      },
      options: { producedAt: producedAt - 1_000 },
    });
    const previousTopicId = previous.topics[0]?.topicId;
    expect(previousTopicId).toBeDefined();

    const current = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'sim-current-split',
        edges: [
          edge(a!, b!, 0.91),
          edge(b!, c!, 0.91),
          edge(a!, c!, 0.91),
          edge(c!, d!, 0.84),
        ],
      },
      previousRevision: previous,
      options: { producedAt },
    });

    const singletonTopicId = await topicId([d!]);
    const emittedTopicIds = current.topics.map((topic) => topic.topicId);
    expect(current.topics).toHaveLength(1);
    expect(emittedTopicIds).not.toContain(singletonTopicId);
    expect(current.lineage).toEqual(
      [
        {
          fromTopicId: previousTopicId!,
          toTopicId: current.topics[0]!.topicId,
          kind: 'split',
          observedAt: '2026-05-08T12:00:00.000Z',
        },
        {
          fromTopicId: previousTopicId!,
          toTopicId: singletonTopicId,
          kind: 'split',
          observedAt: '2026-05-08T12:00:00.000Z',
        },
      ].sort((left, right) => (left.toTopicId < right.toTopicId ? -1 : 1)),
    );
  });

  it('emits merge lineage when prior components join through a bridge visit', async () => {
    const [a, b, c, d, e, f] = urls(['a', 'b', 'c', 'd', 'e', 'f']);
    const visits = [visit(a!), visit(b!), visit(c!), visit(d!), visit(e!), visit(f!)];
    const previous = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'sim-previous-merge',
        edges: [edge(a!, b!, 0.91), edge(b!, c!, 0.91), edge(d!, e!, 0.91)],
      },
      options: { producedAt: producedAt - 1_000 },
    });
    expect(previous.topics).toHaveLength(2);

    const current = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'sim-current-merge',
        edges: [
          edge(a!, b!, 0.91),
          edge(b!, c!, 0.91),
          edge(c!, f!, 0.91),
          edge(f!, d!, 0.91),
          edge(d!, e!, 0.91),
        ],
      },
      previousRevision: previous,
      options: { producedAt },
    });

    expect(current.topics).toHaveLength(1);
    expect(current.topics[0]?.memberCanonicalUrls).toEqual([a, b, c, d, e, f]);
    expect(current.lineage).toEqual(
      previous.topics.map((topic) => ({
        fromTopicId: topic.topicId,
        toTopicId: current.topics[0]!.topicId,
        kind: 'merge' as const,
        observedAt: '2026-05-08T12:00:00.000Z',
      })),
    );
  });

  it('computes cohesion as mean cosine over in-topic similarity edges', async () => {
    const [a, b, c] = urls(['a', 'b', 'c']);

    const revision = await buildTopicRevision({
      visits: [visit(a!), visit(b!), visit(c!)],
      visitSimilarity: {
        revisionId: 'sim-cohesion',
        edges: [edge(a!, b!, 0.85), edge(a!, c!, 0.9), edge(b!, c!, 0.95)],
      },
      options: { producedAt },
    });

    expect(revision.topics[0]?.metadata.cohesion).toBe(0.9);
  });

  it('produces deterministic output for identical input and prior revision', async () => {
    const [a, b, c, d] = urls(['a', 'b', 'c', 'd']);
    const visits = [
      visit(c!, { focusedWindowMs: 7_500 }),
      visit(a!, { focusedWindowMs: 12_000, workstreamId: 'ws-a' }),
      visit(d!, { focusedWindowMs: 6_000 }),
      visit(b!, { focusedWindowMs: 8_000, workstreamId: 'ws-a' }),
    ];
    const input = {
      visits,
      visitSimilarity: {
        revisionId: 'sim-determinism',
        edges: [edge(b!, c!, 0.9), edge(a!, b!, 0.9), edge(c!, d!, 0.9)],
      },
      userAssertedRelations: [{ kind: 'in_workstream' as const, fromVisitKey: d!, toVisitKey: a! }],
      options: { producedAt },
    };

    const first = await buildTopicRevision(input);
    const second = await buildTopicRevision(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
