import { describe, expect, it } from 'vitest';

import {
  applyAggregatorObservations,
  createEmptyAggregatorStatsState,
  isLearnedAggregatorHost,
  registrableDomainOf,
  type AggregatorVisitObservation,
} from './learnedAggregatorStats.js';

// Fixture — the PR #373 blind spot this signal is for: distinguishing a
// coherent single-source blog from a true multi-topic aggregator, using
// CONTENT (keyword concepts) rather than URL structure.
const SINGLE_SOURCE_DOMAIN = 'blog.test';
const DIVERSE_DOMAIN = 'aggregator.test';

const singleSourceUrl = (path: string): string => `https://${SINGLE_SOURCE_DOMAIN}${path}`;
const diverseUrl = (path: string): string => `https://${DIVERSE_DOMAIN}${path}`;

describe('DomainAggregatorCounters.keywordConceptEntropyBits', () => {
  it('is 0 for a single-source domain — every page shares the same concept', () => {
    const state = createEmptyAggregatorStatsState();
    const observations: AggregatorVisitObservation[] = Array.from({ length: 6 }, (_, i) => ({
      canonicalUrl: singleSourceUrl(`/post-${String(i)}`),
      observedAtMs: 1_000 + i,
      title: `Post ${String(i)}`,
      keywordConceptIds: ['concept-rust'],
    }));
    applyAggregatorObservations(state, observations);
    const stats = state.domainStats(registrableDomainOf(SINGLE_SOURCE_DOMAIN));
    expect(stats?.keywordConceptEntropyBits).toBe(0);
  });

  it('is > 0 and higher than a single-source domain when pages span many unrelated concepts', () => {
    const state = createEmptyAggregatorStatsState();
    const concepts = ['concept-rust', 'concept-baking', 'concept-astronomy', 'concept-finance', 'concept-gardening', 'concept-music'];
    const observations: AggregatorVisitObservation[] = concepts.map((conceptId, i) => ({
      canonicalUrl: diverseUrl(`/item-${String(i)}`),
      observedAtMs: 1_000 + i,
      title: `Item ${String(i)}`,
      keywordConceptIds: [conceptId],
    }));
    applyAggregatorObservations(state, observations);
    const stats = state.domainStats(registrableDomainOf(DIVERSE_DOMAIN));
    expect(stats?.keywordConceptEntropyBits).toBeGreaterThan(0);
    // 6 equally-likely distinct concepts -> log2(6) bits, the maximum entropy
    // for that count.
    expect(stats?.keywordConceptEntropyBits).toBeCloseTo(Math.log2(6), 5);
  });

  it('is 0 (not distinguished from "coherent") when a domain has no keyword-concept observations at all', () => {
    const state = createEmptyAggregatorStatsState();
    applyAggregatorObservations(state, [
      { canonicalUrl: singleSourceUrl('/no-keywords'), observedAtMs: 1_000, title: 'A post' },
    ]);
    const stats = state.domainStats(registrableDomainOf(SINGLE_SOURCE_DOMAIN));
    expect(stats?.keywordConceptEntropyBits).toBe(0);
  });

  it('is SHADOW ONLY — does not change isLearnedAggregatorHost for a structurally single-source domain', () => {
    const state = createEmptyAggregatorStatsState();
    const concepts = ['concept-a', 'concept-b', 'concept-c', 'concept-d', 'concept-e', 'concept-f'];
    // Diverse CONTENT, but no same-domain outlink fan-out at all — this
    // domain does not structurally qualify as a hub, and adding diverse
    // keyword-concept data must not flip that (the classifier does not
    // consult this signal).
    const observations: AggregatorVisitObservation[] = concepts.map((conceptId, i) => ({
      canonicalUrl: diverseUrl(`/post-${String(i)}`),
      observedAtMs: 1_000 + i,
      title: `Post ${String(i)}`,
      keywordConceptIds: [conceptId],
    }));
    applyAggregatorObservations(state, observations);
    expect(isLearnedAggregatorHost(state, DIVERSE_DOMAIN)).toBe(false);
  });

  it('folds incrementally — O(1) per observation, no rescan of prior history', () => {
    const state = createEmptyAggregatorStatsState();
    applyAggregatorObservations(state, [
      { canonicalUrl: diverseUrl('/a'), observedAtMs: 1_000, keywordConceptIds: ['concept-a'] },
    ]);
    const before = state.domainStats(registrableDomainOf(DIVERSE_DOMAIN))?.keywordConceptEntropyBits;
    expect(before).toBe(0);
    applyAggregatorObservations(state, [
      { canonicalUrl: diverseUrl('/b'), observedAtMs: 2_000, keywordConceptIds: ['concept-b'] },
    ]);
    const after = state.domainStats(registrableDomainOf(DIVERSE_DOMAIN))?.keywordConceptEntropyBits;
    expect(after).toBeGreaterThan(before ?? -1);
  });
});
