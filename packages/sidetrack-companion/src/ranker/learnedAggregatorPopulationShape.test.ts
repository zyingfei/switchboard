import { describe, expect, it } from 'vitest';

import {
  DEEP_PATH_MIN_SEGMENTS,
  ITEM_MAX_OUTLINK_FANOUT,
  MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB,
  MIN_HUB_CANDIDATE_REVISITS,
  MIN_HUB_FANOUT,
  MIN_SHALLOW_REVISITED_URLS_FOR_HUB,
  aggregatorHubEvidenceFor,
  applyAggregatorObservation,
  applyAggregatorObservations,
  classifyLearnedAggregatorUrl,
  createEmptyAggregatorStatsState,
  isLearnedAggregatorHost,
  registrableDomainOf,
  type AggregatorStatsState,
  type AggregatorVisitObservation,
} from './learnedAggregatorStats.js';

// Signal (a) — URL-population shape (2026-08-21, task #22). The fixture
// domains below are synthetic (never real sites) and, critically, are seeded
// with ZERO opener/previous edges — every observation is a bare
// BROWSER_TIMELINE_OBSERVED title-only or title-less capture, the same shape
// a real visit to a github.com/reddit.com/chatgpt.com/claude.ai item takes
// when it arrives via an external link or bookmark (PR #373's named blind
// spot: those domains never accumulate the OLD opener-chain fan-out signal
// no matter how much they're visited).
const HUB_DOMAIN = 'pop-hub.test';
const BLOG_DOMAIN = 'pop-blog.test';
const NOTES_DOMAIN = 'pop-notes.test';

const hubUrl = (path: string): string => `https://${HUB_DOMAIN}${path}`;
const blogUrl = (path: string): string => `https://${BLOG_DOMAIN}${path}`;
const notesUrl = (path: string): string => `https://${NOTES_DOMAIN}${path}`;

// Hub-shaped: MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB distinct DEEP (>=2-segment)
// paths, each observed exactly once, plus one SHALLOW (<=1-segment) path
// revisited MIN_HUB_CANDIDATE_REVISITS times. No opener/previous edges
// anywhere — population shape alone must be enough.
const seedPopulationHub = (state: AggregatorStatsState, deepCount: number): void => {
  const observations: AggregatorVisitObservation[] = [];
  for (let index = 0; index < deepCount; index += 1) {
    observations.push({ canonicalUrl: hubUrl(`/posts/item-${String(index)}`), observedAtMs: 1_000 + index });
  }
  for (let visit = 0; visit < MIN_HUB_CANDIDATE_REVISITS; visit += 1) {
    observations.push({ canonicalUrl: hubUrl('/home'), observedAtMs: 5_000 + visit });
  }
  applyAggregatorObservations(state, observations);
};

describe('learnedAggregatorStats — signal (a): URL-population shape', () => {
  describe('hub-shaped population qualifies with ZERO opener-chain evidence', () => {
    it('MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB distinct single-visit deep paths + one revisited shallow path -> hub', () => {
      const state = createEmptyAggregatorStatsState();
      seedPopulationHub(state, MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB);
      expect(isLearnedAggregatorHost(state, HUB_DOMAIN)).toBe(true);

      // Prove it's population-shape doing the work, not a fan-out fluke.
      const evidence = aggregatorHubEvidenceFor(state.domainStats(HUB_DOMAIN)!);
      expect(evidence.fanoutShaped).toBe(false);
      expect(evidence.populationShaped).toBe(true);
      expect(evidence.qualifiesAsHub).toBe(true);
    });

    it('one fewer deep single-visit URL than the bar does NOT qualify (no over-eager rounding)', () => {
      const state = createEmptyAggregatorStatsState();
      seedPopulationHub(state, MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB - 1);
      expect(isLearnedAggregatorHost(state, HUB_DOMAIN)).toBe(false);
    });

    it('deep single-visit URLs without ANY revisited shallow page do NOT qualify (both halves of the gate are required)', () => {
      const state = createEmptyAggregatorStatsState();
      const observations: AggregatorVisitObservation[] = [];
      for (let index = 0; index < MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB + 4; index += 1) {
        observations.push({ canonicalUrl: hubUrl(`/posts/item-${String(index)}`), observedAtMs: 1_000 + index });
      }
      applyAggregatorObservations(state, observations);
      expect(isLearnedAggregatorHost(state, HUB_DOMAIN)).toBe(false);
    });
  });

  describe('single-source blog (deep permalinks, never revisited) stays not-aggregator', () => {
    it('many distinct DEEP single-visit permalinks with no shallow-revisit page is single-source-blog-shaped, not hub-shaped', () => {
      // A real single-author blog often uses deep, dated permalinks
      // (/2026/03/15/my-post) — this must NOT alone flip it into a hub; the
      // shallow-revisited-listing half of the gate is what distinguishes a
      // blog (readers land on posts, rarely revisit an index page enough to
      // register) from a true hub (readers keep returning to the front page).
      const state = createEmptyAggregatorStatsState();
      const observations: AggregatorVisitObservation[] = [];
      for (let index = 0; index < MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB + 10; index += 1) {
        observations.push({
          canonicalUrl: blogUrl(`/2026/03/${String(index).padStart(2, '0')}/post-${String(index)}`),
          observedAtMs: 1_000 + index,
        });
      }
      applyAggregatorObservations(state, observations);
      expect(isLearnedAggregatorHost(state, BLOG_DOMAIN)).toBe(false);
      for (let index = 0; index < MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB + 10; index += 1) {
        expect(
          classifyLearnedAggregatorUrl(
            state,
            blogUrl(`/2026/03/${String(index).padStart(2, '0')}/post-${String(index)}`),
          ),
        ).toBe('not-aggregator');
      }
    });
  });

  describe('personal-notes domain (mostly-unique shallow paths, no revisits) stays not-aggregator', () => {
    it('single-segment paths, each visited once — neither deep-single-visit nor shallow-revisited', () => {
      const state = createEmptyAggregatorStatsState();
      const observations: AggregatorVisitObservation[] = [];
      for (let index = 0; index < MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB + 10; index += 1) {
        observations.push({ canonicalUrl: notesUrl(`/note-${String(index)}`), observedAtMs: 1_000 + index });
      }
      applyAggregatorObservations(state, observations);
      expect(isLearnedAggregatorHost(state, NOTES_DOMAIN)).toBe(false);
    });
  });

  describe('deepSingleVisitUrlCount is NOT monotonic — a revisit removes a URL from the single-visit bucket', () => {
    it('revisiting one of the deep URLs decrements deepSingleVisitUrlCount by exactly one', () => {
      const state = createEmptyAggregatorStatsState();
      seedPopulationHub(state, MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB);
      const before = state.domainStats(HUB_DOMAIN)?.deepSingleVisitUrlCount;
      expect(before).toBe(MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB);
      applyAggregatorObservation(state, { canonicalUrl: hubUrl('/posts/item-0'), observedAtMs: 9_000 });
      expect(state.domainStats(HUB_DOMAIN)?.deepSingleVisitUrlCount).toBe(MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB - 1);
    });

    it('...and can drop the domain below the hub bar if it was exactly at the threshold', () => {
      const state = createEmptyAggregatorStatsState();
      seedPopulationHub(state, MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB);
      expect(isLearnedAggregatorHost(state, HUB_DOMAIN)).toBe(true);
      applyAggregatorObservation(state, { canonicalUrl: hubUrl('/posts/item-0'), observedAtMs: 9_000 });
      expect(isLearnedAggregatorHost(state, HUB_DOMAIN)).toBe(false);
    });
  });

  describe('opener-independent per-URL item inference (population-shaped hub, no opener evidence at all)', () => {
    it('a deep single-visit URL on a population-shaped hub classifies as item — closing the blind spot', () => {
      const state = createEmptyAggregatorStatsState();
      seedPopulationHub(state, MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB);
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/posts/item-0'))).toBe('item');
      // Confirm there really is no opener evidence backing this call.
      expect(state.urlStats(hubUrl('/posts/item-0'))?.inboundSources.size).toBe(0);
    });

    it('a SHALLOW ambiguous URL on the same hub still falls to the conservative feed default (no opener-independent boost for shallow paths)', () => {
      const state = createEmptyAggregatorStatsState();
      seedPopulationHub(state, MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB);
      applyAggregatorObservation(state, { canonicalUrl: hubUrl('/about'), observedAtMs: 20_000 });
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/about'))).toBe('feed');
    });

    it('a deep URL that itself fans out to many same-domain targets is still feed, not item (step 4 still applies)', () => {
      const state = createEmptyAggregatorStatsState();
      seedPopulationHub(state, MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB);
      const observations: AggregatorVisitObservation[] = [];
      for (let index = 0; index < MIN_HUB_FANOUT + 1; index += 1) {
        observations.push({
          canonicalUrl: hubUrl(`/posts/item-0/reply-${String(index)}`),
          observedAtMs: 30_000 + index,
          openerCanonicalUrl: hubUrl('/posts/item-0'),
        });
      }
      observations.push({ canonicalUrl: hubUrl('/posts/item-0'), observedAtMs: 40_000 });
      applyAggregatorObservations(state, observations);
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/posts/item-0'))).toBe('feed');
    });

    it('a deep URL with meaningful fan-out but BELOW ITEM_MAX_OUTLINK_FANOUT still classifies as item', () => {
      const state = createEmptyAggregatorStatsState();
      seedPopulationHub(state, MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB);
      const observations: AggregatorVisitObservation[] = [];
      for (let index = 0; index < ITEM_MAX_OUTLINK_FANOUT; index += 1) {
        observations.push({
          canonicalUrl: hubUrl(`/posts/item-1/see-also-${String(index)}`),
          observedAtMs: 30_000 + index,
          openerCanonicalUrl: hubUrl('/posts/item-1'),
        });
      }
      applyAggregatorObservations(state, observations);
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/posts/item-1'))).toBe('item');
    });
  });

  describe('registrableDomainOf sharing with the fan-out signal', () => {
    it('population-shape evidence is keyed by registrable domain, same as the fan-out signal', () => {
      const state = createEmptyAggregatorStatsState();
      const observations: AggregatorVisitObservation[] = [];
      for (let index = 0; index < MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB; index += 1) {
        observations.push({
          canonicalUrl: `https://sub${String(index % 3)}.${HUB_DOMAIN}/posts/item-${String(index)}`,
          observedAtMs: 1_000 + index,
        });
      }
      for (let visit = 0; visit < MIN_HUB_CANDIDATE_REVISITS; visit += 1) {
        observations.push({ canonicalUrl: `https://sub0.${HUB_DOMAIN}/home`, observedAtMs: 5_000 + visit });
      }
      applyAggregatorObservations(state, observations);
      expect(registrableDomainOf(`sub0.${HUB_DOMAIN}`)).toBe(HUB_DOMAIN);
      expect(isLearnedAggregatorHost(state, `sub1.${HUB_DOMAIN}`)).toBe(true);
      expect(MIN_SHALLOW_REVISITED_URLS_FOR_HUB).toBeGreaterThan(0); // sanity: gate is not vacuous
      expect(DEEP_PATH_MIN_SEGMENTS).toBeGreaterThan(0); // sanity: gate is not vacuous
    });
  });
});
