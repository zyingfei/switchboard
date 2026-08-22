import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SERVED_TOPIC_PRODUCER,
  SERVED_TOPIC_PRODUCER_ENV,
  buildServedTopicProducerReport,
  resolveServedTopicProducer,
} from './servedTopicProducer.js';

// W5 seam (post-#404) — 'incremental' added to the producer type/registry.
// The flip stays OFF by default; these are pure unit checks on the
// flag-resolution contract. End-to-end serving-path coverage (does
// SIDETRACK_TOPIC_PRODUCER=incremental actually select the incremental
// builder through connectionsMaterializer.ts) lives in
// connectionsMaterializer.test.ts's "W5 seam" describe block.

describe('resolveServedTopicProducer', () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env[SERVED_TOPIC_PRODUCER_ENV];
  });

  afterEach(() => {
    if (prior === undefined) delete process.env[SERVED_TOPIC_PRODUCER_ENV];
    else process.env[SERVED_TOPIC_PRODUCER_ENV] = prior;
  });

  it('defaults to leiden-cpm when the env var is unset — the incremental flip is opt-in only', () => {
    delete process.env[SERVED_TOPIC_PRODUCER_ENV];
    expect(resolveServedTopicProducer()).toBe('leiden-cpm');
    expect(DEFAULT_SERVED_TOPIC_PRODUCER).toBe('leiden-cpm');
  });

  it('SIDETRACK_TOPIC_PRODUCER=incremental selects the incremental producer', () => {
    process.env[SERVED_TOPIC_PRODUCER_ENV] = 'incremental';
    expect(resolveServedTopicProducer()).toBe('incremental');
  });

  it('is case-insensitive and trims whitespace, matching the existing producers\' contract', () => {
    process.env[SERVED_TOPIC_PRODUCER_ENV] = '  Incremental  ';
    expect(resolveServedTopicProducer()).toBe('incremental');
  });

  it('an unrecognised value falls back to the default rather than throwing', () => {
    process.env[SERVED_TOPIC_PRODUCER_ENV] = 'not-a-real-producer';
    expect(resolveServedTopicProducer()).toBe(DEFAULT_SERVED_TOPIC_PRODUCER);
  });

  it('the other existing producers are unaffected by the new member', () => {
    for (const value of ['idf-rkn-split', 'leiden-cpm', 'union-find'] as const) {
      process.env[SERVED_TOPIC_PRODUCER_ENV] = value;
      expect(resolveServedTopicProducer()).toBe(value);
    }
  });
});

describe('buildServedTopicProducerReport — generic over the producer value', () => {
  const revision = (topicCount: number, revisionId: string) => ({
    revisionId,
    algorithmVersion: 'topic-revision:v4:incremental',
    cosineThreshold: 0.9,
    visitSimilarityRevisionId: 'v1',
    topics: Array.from({ length: topicCount }, (_unused, i) => ({
      memberCanonicalUrls: [`https://example.test/${String(i)}`],
    })),
    lineage: [],
  });

  it('reports producer="incremental" with no special-casing needed', () => {
    const report = buildServedTopicProducerReport('incremental', revision(2, 'rev-b'), revision(1, 'rev-a'));
    expect(report.producer).toBe('incremental');
    expect(report.topicCount).toBe(2);
    expect(report.revisionId).toBe('rev-b');
    expect(report.previousRevisionId).toBe('rev-a');
  });
});
