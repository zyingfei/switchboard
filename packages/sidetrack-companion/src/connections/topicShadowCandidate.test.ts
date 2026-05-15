import { describe, expect, it } from 'vitest';

import { TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY } from '../producers/topic-revision.js';
import { buildTopicRevision, type TopicVisit } from './topicClusterer.js';
import { buildTopicShadowCandidate } from './topicShadowCandidate.js';
import type { VisitSimilarityRevision } from './types.js';

const visit = (canonicalUrl: string, title: string): TopicVisit => ({
  canonicalUrl,
  title,
  focusedWindowMs: 10_000,
  firstObservedAt: '2026-05-14T10:00:00.000Z',
  lastObservedAt: '2026-05-14T10:10:00.000Z',
});

const similarityRevision = (edges: VisitSimilarityRevision['edges']): VisitSimilarityRevision => ({
  revisionId: 'sim-replay',
  modelId: 'Xenova/multilingual-e5-small',
  modelRevision: 'test-model',
  featureSchemaVersion: 1,
  threshold: 0.85,
  producedAt: Date.parse('2026-05-14T10:11:00.000Z'),
  producer: 'embedding',
  edges,
});

describe('buildTopicShadowCandidate', () => {
  it('removes in_workstream hard unions and prunes weak reciprocal bridge edges', async () => {
    const visits = [
      visit('https://matching.dev/order-book', 'matching engine order book'),
      visit('https://matching.dev/price-time-priority', 'matching engine price time priority'),
      visit('https://oracle.cloud/landing-zone', 'oracle cloud landing zone'),
      visit('https://oracle.cloud/cis-quickstart', 'oracle cloud cis quickstart'),
    ];
    const visitSimilarity = similarityRevision([
      {
        fromVisitKey: 'https://matching.dev/order-book',
        toVisitKey: 'https://matching.dev/price-time-priority',
        cosine: 0.95,
      },
      {
        fromVisitKey: 'https://matching.dev/price-time-priority',
        toVisitKey: 'https://oracle.cloud/landing-zone',
        cosine: 0.86,
      },
      {
        fromVisitKey: 'https://oracle.cloud/landing-zone',
        toVisitKey: 'https://oracle.cloud/cis-quickstart',
        cosine: 0.95,
      },
    ]);
    const userAssertedRelations = [
      {
        kind: 'in_workstream' as const,
        fromVisitKey: 'https://matching.dev/order-book',
        toVisitKey: 'https://oracle.cloud/cis-quickstart',
      },
    ];
    const baselineRevision = await buildTopicRevision({
      visits,
      visitSimilarity,
      userAssertedRelations,
      options: { producedAt: Date.parse('2026-05-14T10:12:00.000Z') },
    });

    expect(baselineRevision.topics).toHaveLength(1);
    expect(baselineRevision.topics[0]?.memberCanonicalUrls).toHaveLength(4);

    const shadow = await buildTopicShadowCandidate({
      visits,
      visitSimilarity,
      userAssertedRelations,
      baselineRevision,
      cosineThreshold: 0.85,
    });

    expect(shadow.revision.algorithmVersion).toBe(TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY);
    expect(shadow.revision.topics.map((topic) => topic.memberCanonicalUrls).sort()).toEqual([
      ['https://matching.dev/order-book', 'https://matching.dev/price-time-priority'],
      ['https://oracle.cloud/cis-quickstart', 'https://oracle.cloud/landing-zone'],
    ]);
    expect(shadow.diagnostics.workstreamHardUnionEdgesRemoved).toBe(1);
    expect(shadow.diagnostics.edgeCountBeforePruning).toBe(3);
    expect(shadow.diagnostics.edgeCountAfterPruning).toBe(2);
    expect(shadow.diagnostics.shadowTopicCount).toBe(2);
    expect(shadow.diagnostics.shadowMaxTopicSize).toBe(2);
  });

  it('adds capped secondary affiliations without changing primary topic membership', async () => {
    const visits = [
      visit('https://alpha-one.localdomain/design-patterns', 'alpha design patterns'),
      visit('https://alpha-one.localdomain/system-design', 'alpha system design'),
      visit('https://bravo-two.invalid/model-evaluation', 'bravo model evaluation'),
      visit('https://bravo-two.invalid/model-training', 'bravo model training'),
      visit('https://neutral-three.example/reference', 'unrelated reference'),
    ];
    const visitSimilarity = similarityRevision([
      {
        fromVisitKey: 'https://alpha-one.localdomain/design-patterns',
        toVisitKey: 'https://alpha-one.localdomain/system-design',
        cosine: 0.95,
      },
      {
        fromVisitKey: 'https://bravo-two.invalid/model-evaluation',
        toVisitKey: 'https://bravo-two.invalid/model-training',
        cosine: 0.95,
      },
      {
        fromVisitKey: 'https://alpha-one.localdomain/design-patterns',
        toVisitKey: 'https://neutral-three.example/reference',
        cosine: 0.9,
      },
      {
        fromVisitKey: 'https://bravo-two.invalid/model-evaluation',
        toVisitKey: 'https://neutral-three.example/reference',
        cosine: 0.9,
      },
    ]);
    const baselineRevision = await buildTopicRevision({
      visits,
      visitSimilarity,
      options: { producedAt: Date.parse('2026-05-14T10:12:00.000Z') },
    });

    const shadow = await buildTopicShadowCandidate({
      visits,
      visitSimilarity,
      userAssertedRelations: [],
      baselineRevision,
      cosineThreshold: 0.85,
    });

    const primaryMembers = new Set(
      shadow.revision.topics.flatMap((topic) => topic.memberCanonicalUrls),
    );
    const secondaryAffiliations = shadow.revision.topics.flatMap(
      (topic) => topic.secondaryAffiliations ?? [],
    );
    expect(primaryMembers.has('https://neutral-three.example/reference')).toBe(false);
    expect(
      secondaryAffiliations.filter(
        (affiliation) => affiliation.canonicalUrl === 'https://neutral-three.example/reference',
      ),
    ).toHaveLength(2);
    expect(shadow.diagnostics.secondaryAffiliationCount).toBe(2);
  });

  it('deduplicates secondary affiliations across repeated timeline entries', async () => {
    const visits = [
      visit('https://alpha-one.localdomain/design-patterns', 'alpha design patterns'),
      visit('https://alpha-one.localdomain/system-design', 'alpha system design'),
      visit('https://neutral-three.example/reference', 'neutral reference'),
      visit('https://neutral-three.example/reference', 'neutral reference follow-up'),
    ];
    const visitSimilarity = similarityRevision([
      {
        fromVisitKey: 'https://alpha-one.localdomain/design-patterns',
        toVisitKey: 'https://alpha-one.localdomain/system-design',
        cosine: 0.95,
      },
      {
        fromVisitKey: 'https://alpha-one.localdomain/design-patterns',
        toVisitKey: 'https://neutral-three.example/reference',
        cosine: 0.9,
      },
    ]);
    const baselineRevision = await buildTopicRevision({
      visits,
      visitSimilarity,
      options: { producedAt: Date.parse('2026-05-14T10:12:00.000Z') },
    });

    const shadow = await buildTopicShadowCandidate({
      visits,
      visitSimilarity,
      userAssertedRelations: [],
      baselineRevision,
      cosineThreshold: 0.85,
    });

    const secondaryAffiliations = shadow.revision.topics.flatMap(
      (topic) => topic.secondaryAffiliations ?? [],
    );
    expect(
      secondaryAffiliations.filter(
        (affiliation) => affiliation.canonicalUrl === 'https://neutral-three.example/reference',
      ),
    ).toHaveLength(1);
    expect(shadow.diagnostics.secondaryAffiliationCount).toBe(1);
  });
});
