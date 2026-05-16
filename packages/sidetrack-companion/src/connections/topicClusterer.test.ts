import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { TOPIC_UNION_FIND_REVISION_KEY } from '../producers/topic-revision.js';
import {
  buildTopicRevision,
  type UserAssertedVisitRelation,
  type TopicVisit,
  type VisitSimilarityEdge,
  type VisitSimilarityRevisionInput,
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

type TopicLineageKind = 'birth' | 'continue' | 'split' | 'merge' | 'death' | 'resurface';

interface TopicFixture {
  readonly visits: readonly TopicVisit[];
  readonly visitSimilarity?: VisitSimilarityRevisionInput;
  readonly previousVisitSimilarity?: VisitSimilarityRevisionInput;
  readonly currentVisitSimilarity?: VisitSimilarityRevisionInput;
  readonly userAssertedRelations?: readonly UserAssertedVisitRelation[];
  readonly expectedMemberGroups?: readonly (readonly string[])[];
  readonly expectedCurrentTopicCount?: number;
  readonly expectedLineageKinds?: readonly TopicLineageKind[];
}

const parseFixtureVisit = (value: unknown, filename: string): TopicVisit => {
  if (
    !isRecord(value) ||
    typeof value['canonicalUrl'] !== 'string' ||
    !isFiniteNumber(value['focusedWindowMs']) ||
    typeof value['firstObservedAt'] !== 'string' ||
    typeof value['lastObservedAt'] !== 'string'
  ) {
    throw new Error(`invalid topic visit in ${filename}`);
  }
  const title = value['title'];
  const workstreamId = value['workstreamId'];
  return {
    canonicalUrl: value['canonicalUrl'],
    ...(typeof title === 'string' ? { title } : {}),
    focusedWindowMs: value['focusedWindowMs'],
    firstObservedAt: value['firstObservedAt'],
    lastObservedAt: value['lastObservedAt'],
    ...(typeof workstreamId === 'string' ? { workstreamId } : {}),
  };
};

const parseSimilarityEdge = (value: unknown, filename: string): VisitSimilarityEdge => {
  if (
    !isRecord(value) ||
    typeof value['fromVisitKey'] !== 'string' ||
    typeof value['toVisitKey'] !== 'string' ||
    !isFiniteNumber(value['cosine'])
  ) {
    throw new Error(`invalid topic similarity edge in ${filename}`);
  }
  return {
    fromVisitKey: value['fromVisitKey'],
    toVisitKey: value['toVisitKey'],
    cosine: value['cosine'],
  };
};

const parseVisitSimilarity = (
  value: unknown,
  filename: string,
): VisitSimilarityRevisionInput | undefined => {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value['revisionId'] !== 'string' ||
    !Array.isArray(value['edges'])
  ) {
    throw new Error(`invalid topic similarity revision in ${filename}`);
  }
  return {
    revisionId: value['revisionId'],
    edges: value['edges'].map((edgeValue) => parseSimilarityEdge(edgeValue, filename)),
  };
};

const parseUserAssertedRelations = (
  value: unknown,
  filename: string,
): readonly UserAssertedVisitRelation[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`invalid topic user relations in ${filename}`);
  }
  return value.map((relation): UserAssertedVisitRelation => {
    if (
      !isRecord(relation) ||
      (relation['kind'] !== 'in_thread' && relation['kind'] !== 'in_workstream') ||
      typeof relation['fromVisitKey'] !== 'string' ||
      typeof relation['toVisitKey'] !== 'string'
    ) {
      throw new Error(`invalid topic user relation in ${filename}`);
    }
    return {
      kind: relation['kind'],
      fromVisitKey: relation['fromVisitKey'],
      toVisitKey: relation['toVisitKey'],
    };
  });
};

const parseExpectedMemberGroups = (
  value: unknown,
  filename: string,
): readonly (readonly string[])[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`invalid topic expected member groups in ${filename}`);
  }
  const groups: string[][] = [];
  for (const group of value) {
    if (!Array.isArray(group) || !group.every((member) => typeof member === 'string')) {
      throw new Error(`invalid topic expected member group in ${filename}`);
    }
    groups.push([...group].sort());
  }
  return groups;
};

const parseExpectedLineageKinds = (
  value: unknown,
  filename: string,
): readonly TopicLineageKind[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`invalid topic expected lineage kinds in ${filename}`);
  }
  return value.map((kind) => {
    if (
      kind !== 'birth' &&
      kind !== 'continue' &&
      kind !== 'split' &&
      kind !== 'merge' &&
      kind !== 'death' &&
      kind !== 'resurface'
    ) {
      throw new Error(`invalid topic expected lineage kind in ${filename}`);
    }
    return kind;
  });
};

const readTopicFixture = async (filename: string): Promise<TopicFixture> => {
  const raw = await readFile(new URL(`./__fixtures__/${filename}`, import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed['visits'])) {
    throw new Error(`invalid topic fixture: ${filename}`);
  }
  const expectedCurrentTopicCount = parsed['expectedCurrentTopicCount'];
  const visitSimilarity = parseVisitSimilarity(parsed['visitSimilarity'], filename);
  const previousVisitSimilarity = parseVisitSimilarity(parsed['previousVisitSimilarity'], filename);
  const currentVisitSimilarity = parseVisitSimilarity(parsed['currentVisitSimilarity'], filename);
  const userAssertedRelations = parseUserAssertedRelations(
    parsed['userAssertedRelations'],
    filename,
  );
  const expectedMemberGroups = parseExpectedMemberGroups(parsed['expectedMemberGroups'], filename);
  const expectedLineageKinds = parseExpectedLineageKinds(parsed['expectedLineageKinds'], filename);
  return {
    visits: parsed['visits'].map((visitValue) => parseFixtureVisit(visitValue, filename)),
    ...(visitSimilarity === undefined ? {} : { visitSimilarity }),
    ...(previousVisitSimilarity === undefined ? {} : { previousVisitSimilarity }),
    ...(currentVisitSimilarity === undefined ? {} : { currentVisitSimilarity }),
    ...(userAssertedRelations === undefined ? {} : { userAssertedRelations }),
    ...(expectedMemberGroups === undefined ? {} : { expectedMemberGroups }),
    ...(isFiniteNumber(expectedCurrentTopicCount) ? { expectedCurrentTopicCount } : {}),
    ...(expectedLineageKinds === undefined ? {} : { expectedLineageKinds }),
  };
};

const topicMemberGroups = (
  revision: Awaited<ReturnType<typeof buildTopicRevision>>,
): readonly (readonly string[])[] =>
  revision.topics
    .map((topic) => [...topic.memberCanonicalUrls].sort())
    .sort((left, right) => (left.join('\u0000') < right.join('\u0000') ? -1 : 1));

const requireTopicSimilarity = (
  fixture: TopicFixture,
  field: 'visitSimilarity' | 'previousVisitSimilarity' | 'currentVisitSimilarity',
): VisitSimilarityRevisionInput => {
  const value = fixture[field];
  if (value === undefined) {
    throw new Error(`missing ${field} in topic fixture`);
  }
  return value;
};

const requireExpectedTopicCount = (fixture: TopicFixture): number => {
  if (fixture.expectedCurrentTopicCount === undefined) {
    throw new Error('missing expected topic count in topic fixture');
  }
  return fixture.expectedCurrentTopicCount;
};

describe('buildTopicRevision', () => {
  it('matches the documented topic-basic fixture', async () => {
    const fixture = await readTopicFixture('topic-basic.json');

    const revision = await buildTopicRevision({
      visits: fixture.visits,
      visitSimilarity: requireTopicSimilarity(fixture, 'visitSimilarity'),
      options: { producedAt },
    });

    expect(topicMemberGroups(revision)).toEqual(fixture.expectedMemberGroups);
  });

  it('matches the documented topic-user-assertion fixture', async () => {
    const fixture = await readTopicFixture('topic-user-assertion.json');

    const input = {
      visits: fixture.visits,
      visitSimilarity: requireTopicSimilarity(fixture, 'visitSimilarity'),
      options: { producedAt },
      ...(fixture.userAssertedRelations === undefined
        ? {}
        : { userAssertedRelations: fixture.userAssertedRelations }),
    };
    const revision = await buildTopicRevision(input);

    expect(topicMemberGroups(revision)).toEqual(fixture.expectedMemberGroups);
  });

  it('matches the documented topic-lineage split fixture', async () => {
    const fixture = await readTopicFixture('topic-lineage-split.json');
    const previous = await buildTopicRevision({
      visits: fixture.visits,
      visitSimilarity: requireTopicSimilarity(fixture, 'previousVisitSimilarity'),
      options: { producedAt: producedAt - 1_000 },
    });

    const current = await buildTopicRevision({
      visits: fixture.visits,
      visitSimilarity: requireTopicSimilarity(fixture, 'currentVisitSimilarity'),
      previousRevision: previous,
      options: { producedAt },
    });

    expect(current.topics).toHaveLength(requireExpectedTopicCount(fixture));
    expect(current.lineage.map((lineage) => lineage.kind).sort()).toEqual(
      fixture.expectedLineageKinds,
    );
  });

  it('matches the documented topic-lineage merge fixture', async () => {
    const fixture = await readTopicFixture('topic-lineage-merge.json');
    const previous = await buildTopicRevision({
      visits: fixture.visits,
      visitSimilarity: requireTopicSimilarity(fixture, 'previousVisitSimilarity'),
      options: { producedAt: producedAt - 1_000 },
    });

    const current = await buildTopicRevision({
      visits: fixture.visits,
      visitSimilarity: requireTopicSimilarity(fixture, 'currentVisitSimilarity'),
      previousRevision: previous,
      options: { producedAt },
    });

    expect(current.topics).toHaveLength(requireExpectedTopicCount(fixture));
    expect(current.lineage.map((lineage) => lineage.kind).sort()).toEqual(
      fixture.expectedLineageKinds,
    );
  });

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
        edges: [edge(a!, b!, 0.91), edge(b!, c!, 0.91), edge(c!, d!, 0.91)],
      },
      options: { producedAt: producedAt - 1_000 },
    });
    const previousTopicId = previous.topics[0]?.topicId;
    expect(previousTopicId).toBeDefined();

    const current = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'sim-current-split',
        edges: [edge(a!, b!, 0.91), edge(b!, c!, 0.91), edge(a!, c!, 0.91), edge(c!, d!, 0.84)],
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

  it('stores a medoid-backed stable suggestion id in topic metadata', async () => {
    const [a, b, c] = urls(['a', 'b', 'c']);
    const revision = await buildTopicRevision({
      visits: [
        visit(a!, { focusedWindowMs: 7_000 }),
        visit(b!, { focusedWindowMs: 9_000 }),
        visit(c!, { focusedWindowMs: 6_000 }),
      ],
      visitSimilarity: {
        revisionId: 'sim-medoid',
        edges: [edge(a!, b!, 0.95), edge(b!, c!, 0.96), edge(a!, c!, 0.86)],
      },
      options: { producedAt },
    });

    expect(revision.topics[0]?.metadata.medoidCanonicalUrl).toBe(b);
    expect(revision.topics[0]?.metadata.stableSuggestionId).toMatch(/^suggestion:/u);
  });

  it('emits continue, birth, and death lineage for adjacent revisions', async () => {
    const [a, b, c, d, e, f] = urls(['a', 'b', 'c', 'd', 'e', 'f']);
    const previous = await buildTopicRevision({
      visits: [visit(a!), visit(b!), visit(c!), visit(d!)],
      visitSimilarity: {
        revisionId: 'sim-lineage-previous',
        edges: [edge(a!, b!, 0.91), edge(c!, d!, 0.91)],
      },
      options: { producedAt: producedAt - 1_000 },
    });

    const current = await buildTopicRevision({
      visits: [visit(a!), visit(b!), visit(e!), visit(f!)],
      visitSimilarity: {
        revisionId: 'sim-lineage-current',
        edges: [edge(a!, b!, 0.91), edge(e!, f!, 0.91)],
      },
      previousRevision: previous,
      options: { producedAt },
    });

    expect(current.lineage.map((lineage) => lineage.kind).sort()).toEqual([
      'birth',
      'continue',
      'death',
    ]);
  });

  it('emits resurface lineage when a stable medoid id reappears under a new member set', async () => {
    const [a, b] = urls(['a', 'b']);
    const currentWithoutPrior = await buildTopicRevision({
      visits: [visit(a!), visit(b!)],
      visitSimilarity: {
        revisionId: 'sim-resurface-current-seed',
        edges: [edge(a!, b!, 0.91)],
      },
      options: { producedAt: producedAt - 500 },
    });
    const stableSuggestionId = currentWithoutPrior.topics[0]?.metadata.stableSuggestionId;
    expect(stableSuggestionId).toBeDefined();

    const current = await buildTopicRevision({
      visits: [visit(a!), visit(b!)],
      visitSimilarity: {
        revisionId: 'sim-resurface-current',
        edges: [edge(a!, b!, 0.91)],
      },
      previousRevision: {
        revisionId: 'topic-rev-old',
        visitSimilarityRevisionId: 'sim-resurface-old',
        cosineThreshold: 0.85,
        algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
        topics: [
          {
            topicId: 'topic:old-suggestion',
            memberCanonicalUrls: ['https://example.test/old-a', 'https://example.test/old-b'],
            metadata: {
              memberCount: 2,
              representativeTitles: ['Old'],
              medoidCanonicalUrl: 'https://example.test/old-a',
              stableSuggestionId: stableSuggestionId!,
              firstObservedAt: '2026-05-08T09:00:00.000Z',
              lastObservedAt: '2026-05-08T09:30:00.000Z',
              cohesion: 0.9,
            },
          },
        ],
        lineage: [],
        producedAt: producedAt - 1_000,
      },
      options: { producedAt },
    });

    expect(current.lineage).toContainEqual({
      fromTopicId: 'topic:old-suggestion',
      toTopicId: current.topics[0]!.topicId,
      kind: 'resurface',
      observedAt: '2026-05-08T12:00:00.000Z',
    });
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

  // Stage 5 follow-up — user assertions bypass the engagement gate.
  // Without this, T3 derives relations correctly but topics stay
  // empty in dogfood because most visits are below the 5 s gate.
  it('forms a topic from user-asserted relations even when visits are below the engagement gate', async () => {
    const a = 'https://example.test/a';
    const b = 'https://example.test/b';
    const revision = await buildTopicRevision({
      // Both visits have 1 s focused time, well below the 5 s default
      // gate. The user-asserted relation still unions them.
      visits: [visit(a, { focusedWindowMs: 1_000 }), visit(b, { focusedWindowMs: 1_000 })],
      visitSimilarity: { revisionId: 'sim-empty', edges: [] },
      userAssertedRelations: [{ kind: 'in_workstream' as const, fromVisitKey: a, toVisitKey: b }],
      options: { producedAt },
    });
    expect(revision.topics).toHaveLength(1);
    expect(revision.topics[0]?.memberCanonicalUrls).toEqual([a, b]);
  });

  it('keeps the engagement gate active for visits with no user assertion', async () => {
    const a = 'https://example.test/a';
    const b = 'https://example.test/b';
    const c = 'https://example.test/c';
    // a + b are user-asserted (bypass the gate). c only has a
    // similarity edge to a, with low engagement — it should NOT be
    // pulled into the topic.
    const revision = await buildTopicRevision({
      visits: [
        visit(a, { focusedWindowMs: 1_000 }),
        visit(b, { focusedWindowMs: 1_000 }),
        visit(c, { focusedWindowMs: 1_000 }),
      ],
      visitSimilarity: {
        revisionId: 'sim-mixed',
        edges: [edge(a, c, 0.95)],
      },
      userAssertedRelations: [{ kind: 'in_workstream' as const, fromVisitKey: a, toVisitKey: b }],
      options: { producedAt },
    });
    expect(revision.topics).toHaveLength(1);
    expect(revision.topics[0]?.memberCanonicalUrls).toEqual([a, b]);
  });

  it('honors SIDETRACK_TOPIC_ENGAGEMENT_GATE_MS for non-asserted visits too', async () => {
    const original = process.env['SIDETRACK_TOPIC_ENGAGEMENT_GATE_MS'];
    process.env['SIDETRACK_TOPIC_ENGAGEMENT_GATE_MS'] = '500';
    try {
      const a = 'https://example.test/a';
      const b = 'https://example.test/b';
      const revision = await buildTopicRevision({
        visits: [visit(a, { focusedWindowMs: 800 }), visit(b, { focusedWindowMs: 800 })],
        visitSimilarity: {
          revisionId: 'sim-env',
          edges: [edge(a, b, 0.95)],
        },
        options: { producedAt },
      });
      expect(revision.topics).toHaveLength(1);
      expect(revision.topics[0]?.memberCanonicalUrls).toEqual([a, b]);
    } finally {
      if (original === undefined) delete process.env['SIDETRACK_TOPIC_ENGAGEMENT_GATE_MS'];
      else process.env['SIDETRACK_TOPIC_ENGAGEMENT_GATE_MS'] = original;
    }
  });
});
