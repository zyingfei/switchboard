import { describe, expect, it } from 'vitest';

import {
  MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB,
  MIN_HUB_CANDIDATE_REVISITS,
  MIN_KEYWORD_CONCEPT_SAMPLES_FOR_VETO,
  applyAggregatorObservations,
  createEmptyAggregatorStatsState,
  isLearnedAggregatorHost,
  registrableDomainOf,
  type AggregatorStatsState,
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

  it('a VETO needs a structural gate to veto — high entropy alone (no fan-out, no population shape) never independently qualifies a domain', () => {
    const state = createEmptyAggregatorStatsState();
    const concepts = ['concept-a', 'concept-b', 'concept-c', 'concept-d', 'concept-e', 'concept-f'];
    // Diverse CONTENT, but no same-domain outlink fan-out AND no
    // population-shape evidence at all — this domain does not structurally
    // qualify as a hub, and adding diverse keyword-concept data must not
    // flip that (the veto can only SUBTRACT from a structural "yes", never
    // manufacture one on its own — see MIN_KEYWORD_CONCEPT_SAMPLES_FOR_VETO's
    // own comment).
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

// Signal (b) — the content-coherence VETO (2026-08-21, task #22). Wires
// keywordConceptEntropyBits into isLearnedAggregatorHost's decision for the
// first time: low entropy (a coherent single content source) with ENOUGH
// samples overrides a structural hub call the population-shape (a) or
// shallow-churn (c) signals would otherwise make — the false-positive guard
// those signals' own doc comments name (a single-author blog with many deep
// dated permalinks, or a stable page whose title happens to have churned a
// couple of times).
describe('keywordConceptEntropyBits as a content-coherence VETO', () => {
  const VETO_HUB_DOMAIN = 'veto-hub.test';
  const vetoHubUrl = (path: string): string => `https://${VETO_HUB_DOMAIN}${path}`;

  // Population-shape hub evidence (signal a) — see
  // learnedAggregatorPopulationShape.test.ts for signal (a) in isolation;
  // this file only cares about vetoing it.
  const seedPopulationHub = (state: AggregatorStatsState): void => {
    const observations: AggregatorVisitObservation[] = [];
    for (let index = 0; index < MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB; index += 1) {
      observations.push({ canonicalUrl: vetoHubUrl(`/posts/item-${String(index)}`), observedAtMs: 1_000 + index });
    }
    for (let visit = 0; visit < MIN_HUB_CANDIDATE_REVISITS; visit += 1) {
      observations.push({ canonicalUrl: vetoHubUrl('/home'), observedAtMs: 5_000 + visit });
    }
    applyAggregatorObservations(state, observations);
  };

  it('a population-shaped hub is VETOED back to not-aggregator when enough samples show low entropy (a coherent single source)', () => {
    const state = createEmptyAggregatorStatsState();
    seedPopulationHub(state);
    expect(isLearnedAggregatorHost(state, VETO_HUB_DOMAIN)).toBe(true); // structurally shaped, pre-veto

    const lowEntropyObservations: AggregatorVisitObservation[] = Array.from(
      { length: MIN_KEYWORD_CONCEPT_SAMPLES_FOR_VETO },
      (_, i) => ({
        canonicalUrl: vetoHubUrl(`/kw/tag-${String(i)}`), // fresh URLs — do NOT revisit the population-shape seed set
        observedAtMs: 9_000 + i,
        keywordConceptIds: ['concept-rust'], // every tagged page shares ONE concept
      }),
    );
    applyAggregatorObservations(state, lowEntropyObservations);
    expect(isLearnedAggregatorHost(state, VETO_HUB_DOMAIN)).toBe(false);
  });

  it('cold-start gate on the veto itself: low entropy with TOO FEW keyword-concept samples does NOT veto', () => {
    const state = createEmptyAggregatorStatsState();
    seedPopulationHub(state);
    const tooFewObservations: AggregatorVisitObservation[] = Array.from(
      { length: MIN_KEYWORD_CONCEPT_SAMPLES_FOR_VETO - 1 },
      (_, i) => ({
        canonicalUrl: vetoHubUrl(`/kw/tag-${String(i)}`), // fresh URLs — do NOT revisit the population-shape seed set
        observedAtMs: 9_000 + i,
        keywordConceptIds: ['concept-rust'],
      }),
    );
    applyAggregatorObservations(state, tooFewObservations);
    expect(isLearnedAggregatorHost(state, VETO_HUB_DOMAIN)).toBe(true); // still structurally shaped, no veto
  });

  it('HIGH entropy (diverse concepts) with enough samples does NOT veto — the structural hub call stands', () => {
    const state = createEmptyAggregatorStatsState();
    seedPopulationHub(state);
    const diverseObservations: AggregatorVisitObservation[] = [
      'concept-rust',
      'concept-baking',
      'concept-astronomy',
      'concept-finance',
    ].map((conceptId, i) => ({
      canonicalUrl: vetoHubUrl(`/kw/tag-${String(i)}`), // fresh URLs — do NOT revisit the population-shape seed set
      observedAtMs: 9_000 + i,
      keywordConceptIds: [conceptId],
    }));
    applyAggregatorObservations(state, diverseObservations);
    expect(isLearnedAggregatorHost(state, VETO_HUB_DOMAIN)).toBe(true);
  });
});
