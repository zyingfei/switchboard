import { afterEach, describe, expect, it } from 'vitest';

import { buildHdbscanTopicRevision } from './hdbscanClusterer.js';
import { buildTopicRevision, type TopicVisit } from './topicClusterer.js';
import { compareTopicRevisions, shouldBuildTopicHdbscanCandidate } from './topicCandidateAb.js';
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
    fromVisitKey: 'https://oracle.cloud/landing-zone',
    toVisitKey: 'https://oracle.cloud/cis-quickstart',
    cosine: 0.95,
  },
]);

describe('compareTopicRevisions', () => {
  it('produces an algorithm-agnostic A/B over two real revisions', async () => {
    const baseline = await buildTopicRevision({
      visits,
      visitSimilarity,
      options: { cosineThreshold: 0.85 },
    });
    const candidate = await buildHdbscanTopicRevision({
      visits,
      visitSimilarity,
      options: { cosineThreshold: 0.85 },
    });

    const ab = compareTopicRevisions({
      baselineRevision: baseline,
      candidateRevision: candidate,
      candidate: 'topic.hdbscan',
      runtimeMs: 12.5,
      reused: false,
    });

    expect(ab.candidate).toBe('topic.hdbscan');
    expect(ab.enabled).toBe(true);
    expect(ab.reused).toBe(false);
    expect(ab.runtimeMs).toBe(12.5);
    expect(ab.baselineAlgorithmVersion).toBe(baseline.algorithmVersion);
    expect(ab.algorithmVersion).toBe(candidate.algorithmVersion);
    expect(ab.baselineRevisionId).toBe(baseline.revisionId);
    expect(ab.candidateRevisionId).toBe(candidate.revisionId);
    expect(ab.baselineTopicCount).toBe(baseline.topics.length);
    expect(ab.candidateTopicCount).toBe(candidate.topics.length);
    expect(ab.topicCountDelta).toBe(candidate.topics.length - baseline.topics.length);
    expect(ab.perVisitChurn).toBeGreaterThanOrEqual(0);
    expect(ab.perVisitChurn).toBeLessThanOrEqual(1);
    expect(Number.isFinite(ab.noiseShare)).toBe(true);
    expect(Number.isFinite(ab.candidateMaxTopicShare)).toBe(true);
  });

  it('honors the reused (skip-path) signal: runtimeMs 0, reused true', async () => {
    const baseline = await buildTopicRevision({
      visits,
      visitSimilarity,
      options: { cosineThreshold: 0.85 },
    });
    const ab = compareTopicRevisions({
      baselineRevision: baseline,
      candidateRevision: baseline,
      candidate: 'topic.hdbscan',
      runtimeMs: 0,
      reused: true,
    });
    expect(ab.reused).toBe(true);
    expect(ab.runtimeMs).toBe(0);
    // identical revisions ⇒ zero churn, zero topic-count delta
    expect(ab.perVisitChurn).toBe(0);
    expect(ab.topicCountDelta).toBe(0);
  });
});

describe('shouldBuildTopicHdbscanCandidate', () => {
  const ENV = 'SIDETRACK_TOPIC_HDBSCAN_CANDIDATE';
  afterEach(() => {
    delete process.env[ENV];
  });

  it('defaults ON when unset', () => {
    delete process.env[ENV];
    expect(shouldBuildTopicHdbscanCandidate()).toBe(true);
  });

  it('is disabled by off/false/0/none (case-insensitive)', () => {
    for (const value of ['off', 'FALSE', '0', 'None', ' off ']) {
      process.env[ENV] = value;
      expect(shouldBuildTopicHdbscanCandidate()).toBe(false);
    }
  });

  it('stays ON for any other value', () => {
    process.env[ENV] = 'on';
    expect(shouldBuildTopicHdbscanCandidate()).toBe(true);
  });
});
