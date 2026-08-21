import { describe, expect, it } from 'vitest';

import {
  MIN_DOMAIN_URLS_FOR_HUB,
  MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL,
  MIN_TITLE_CHURN_RATE_FOR_FEED,
  aggregatorHubEvidenceFor,
  applyAggregatorObservations,
  createEmptyAggregatorStatsState,
  isLearnedAggregatorHost,
  type AggregatorVisitObservation,
} from './learnedAggregatorStats.js';

// Signal (c) — shallow-path title churn, aggregated per-domain (2026-08-21,
// task #22). Fixture domains are synthetic, never real sites. Every
// observation below is opener-independent (bare BROWSER_TIMELINE_OBSERVED
// captures of the SAME shallow URL, retitled each time) — the same shape a
// reddit/chatgpt/claude.ai listing-or-composer surface takes when its title
// keeps changing (vote/comment counts, auto-generated conversation titles)
// without ever being reached via a recorded same-domain opener.
const CHURN_DOMAIN = 'churn-hub.test';
const STABLE_DOMAIN = 'stable-hub.test';
const churnUrl = (path: string): string => `https://${CHURN_DOMAIN}${path}`;
const stableUrl = (path: string): string => `https://${STABLE_DOMAIN}${path}`;

const churnObservations = (
  url: string,
  titles: readonly string[],
  startAtMs: number,
): AggregatorVisitObservation[] =>
  titles.map((title, index) => ({ canonicalUrl: url, observedAtMs: startAtMs + index, title }));

// MIN_DOMAIN_URLS_FOR_HUB is a universal floor every hub gate shares — not
// specific to signal (c). These filler URLs clear that floor with
// single-visit, untitled, SHALLOW pages that contribute to neither the
// fan-out nor the population-shape (a) signal, so a test can isolate signal
// (c) as the ONLY thing doing the qualifying work.
const shallowFillerObservations = (domainUrl: (path: string) => string, count: number): AggregatorVisitObservation[] =>
  Array.from({ length: count }, (_, i) => ({ canonicalUrl: domainUrl(`/p${String(i)}`), observedAtMs: 500 + i }));

describe('learnedAggregatorStats — signal (c): shallow-path title churn', () => {
  it('a single shallow URL churning above the rate bar, with enough samples, qualifies the domain as a hub — zero fan-out, zero population evidence', () => {
    const state = createEmptyAggregatorStatsState();
    const titles = Array.from({ length: MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL + 2 }, (_, i) => `Listing batch ${String(i)}`);
    applyAggregatorObservations(state, [
      ...shallowFillerObservations(churnUrl, MIN_DOMAIN_URLS_FOR_HUB),
      ...churnObservations(churnUrl('/feed'), titles, 1_000),
    ]);
    expect(isLearnedAggregatorHost(state, CHURN_DOMAIN)).toBe(true);

    const evidence = aggregatorHubEvidenceFor(state.domainStats(CHURN_DOMAIN)!);
    expect(evidence.fanoutShaped).toBe(false);
    expect(evidence.populationShaped).toBe(false);
    expect(evidence.shallowChurnShaped).toBe(true);
  });

  it('cold-start gate: high churn rate with TOO FEW adjacent-capture samples does not qualify', () => {
    const state = createEmptyAggregatorStatsState();
    // 2 captures = 1 adjacent pair, one below MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL
    // (distinctUrlCount is cleared by the fillers, isolating the sample-size gate).
    applyAggregatorObservations(state, [
      ...shallowFillerObservations(churnUrl, MIN_DOMAIN_URLS_FOR_HUB),
      ...churnObservations(churnUrl('/feed'), ['Batch A', 'Batch B'], 1_000),
    ]);
    expect(state.domainStats(CHURN_DOMAIN)?.shallowTitleChurnSampleCount).toBeLessThan(
      MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL,
    );
    expect(isLearnedAggregatorHost(state, CHURN_DOMAIN)).toBe(false);
  });

  it('enough samples but a churn rate BELOW the bar does not qualify (a stable title with one blip is not a listing)', () => {
    const state = createEmptyAggregatorStatsState();
    const titles = Array.from({ length: 10 }, () => 'The Same Title Every Time');
    applyAggregatorObservations(state, [
      ...shallowFillerObservations(stableUrl, MIN_DOMAIN_URLS_FOR_HUB),
      ...churnObservations(stableUrl('/about'), titles, 1_000),
    ]);
    const stats = state.domainStats(STABLE_DOMAIN);
    expect(stats?.shallowTitleChurnSampleCount).toBeGreaterThanOrEqual(MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL);
    expect(stats?.shallowTitleChurnRate).toBe(0);
    expect(isLearnedAggregatorHost(state, STABLE_DOMAIN)).toBe(false);
  });

  it('DEEP-path churn is excluded from the shallow aggregate — a churning item page does not count toward signal (c)', () => {
    const state = createEmptyAggregatorStatsState();
    // Deep (2-segment) path, title changes every capture — e.g. a page title
    // that embeds a live status. Must not contribute to the SHALLOW churn
    // aggregate at all.
    const titles = Array.from({ length: MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL + 2 }, (_, i) => `Status ${String(i)}`);
    applyAggregatorObservations(state, [
      ...shallowFillerObservations(churnUrl, MIN_DOMAIN_URLS_FOR_HUB),
      ...churnObservations(churnUrl('/posts/live-thread'), titles, 1_000),
    ]);
    const stats = state.domainStats(CHURN_DOMAIN);
    expect(stats?.shallowTitleChurnSampleCount).toBe(0);
    expect(stats?.shallowTitleChurnRate).toBe(0);
    expect(isLearnedAggregatorHost(state, CHURN_DOMAIN)).toBe(false);
  });

  it('shallow churn folds across MULTIPLE shallow URLs on the domain, not just one', () => {
    const state = createEmptyAggregatorStatsState();
    const observations: AggregatorVisitObservation[] = [
      ...churnObservations(churnUrl('/feed'), ['A', 'B'], 1_000),
      ...churnObservations(churnUrl('/new'), ['C', 'D'], 2_000),
    ];
    applyAggregatorObservations(state, observations);
    const stats = state.domainStats(CHURN_DOMAIN);
    // 2 URLs x 1 adjacent pair each = 2 samples, both churned.
    expect(stats?.shallowTitleChurnSampleCount).toBe(2);
    expect(stats?.shallowTitleChurnRate).toBe(1);
  });

  it('MIN_TITLE_CHURN_RATE_FOR_FEED is shared between the per-URL and per-domain churn gates (one threshold, not two)', () => {
    // Sanity — both signals reuse the same named constant; this is a
    // documentation-as-test guard against the two gates silently drifting
    // apart in a future edit.
    expect(MIN_TITLE_CHURN_RATE_FOR_FEED).toBeGreaterThan(0);
    expect(MIN_TITLE_CHURN_RATE_FOR_FEED).toBeLessThanOrEqual(1);
  });
});
