import { describe, expect, it } from 'vitest';

import {
  MIN_DOMAIN_URLS_FOR_HUB,
  MIN_HUB_FANOUT,
  buildAggregatorShadowAgreement,
  applyAggregatorObservation,
  applyAggregatorObservations,
  classifyLearnedAggregatorPage,
  classifyLearnedAggregatorUrl,
  createEmptyAggregatorStatsState,
  isLearnedAggregatorHost,
  registrableDomainOf,
  type AggregatorStatsState,
  type AggregatorVisitObservation,
} from './learnedAggregatorStats.js';

// Synthetic fixture domain — never a real site. `hub.test` behaves like a
// listing platform (many item leaves fanning out from a handful of hub
// pages); `blog.test` behaves like a single-source blog (never fans out).
const HUB_DOMAIN = 'hub.test';
const BLOG_DOMAIN = 'blog.test';

const hubUrl = (path: string): string => `https://${HUB_DOMAIN}${path}`;
const blogUrl = (path: string): string => `https://${BLOG_DOMAIN}${path}`;

// A hub domain needs MIN_DOMAIN_URLS_FOR_HUB distinct URLs AND one URL
// whose qualifying fan-out clears MIN_HUB_FANOUT. `feed-hub-1` is that URL;
// `item-leaf-1..N` are its fanout targets, each reached only from the hub
// (positive item evidence) and each fanning out to nothing itself.
const seedHubDomain = (state: AggregatorStatsState, leafCount: number): void => {
  const observations: AggregatorVisitObservation[] = [];
  // Two captures with a title change so the hub URL itself corroborates as
  // a qualifying fan-out candidate (qualifiesAsHubCandidate requires either
  // a revisit or a title change, not fan-out alone).
  observations.push({
    canonicalUrl: hubUrl('/feed-hub-1'),
    observedAtMs: 1_000,
    title: 'Front page — page 1',
  });
  observations.push({
    canonicalUrl: hubUrl('/feed-hub-1'),
    observedAtMs: 2_000,
    title: 'Front page — page 2',
  });
  for (let index = 0; index < leafCount; index += 1) {
    observations.push({
      canonicalUrl: hubUrl(`/item-leaf-${index}`),
      observedAtMs: 3_000 + index,
      openerCanonicalUrl: hubUrl('/feed-hub-1'),
    });
  }
  applyAggregatorObservations(state, observations);
};

describe('learnedAggregatorStats', () => {
  describe('registrableDomainOf', () => {
    it('takes the last two labels and normalizes www/case/trailing dot', () => {
      expect(registrableDomainOf('sub.hub.test')).toBe('hub.test');
      expect(registrableDomainOf('WWW.Hub.Test.')).toBe('hub.test');
      expect(registrableDomainOf('hub.test')).toBe('hub.test');
    });
  });

  describe('cold start / conservative defaults', () => {
    it('classifies a domain with no observations as not-aggregator', () => {
      const state = createEmptyAggregatorStatsState();
      expect(classifyLearnedAggregatorUrl(state, blogUrl('/never-seen'))).toBe('not-aggregator');
      expect(isLearnedAggregatorHost(state, BLOG_DOMAIN)).toBe(false);
    });

    it('a single-source blog domain that never fans out stays not-aggregator', () => {
      const state = createEmptyAggregatorStatsState();
      // Many distinct URLs (clears MIN_DOMAIN_URLS_FOR_HUB on url-count
      // alone) but zero opener/previous edges between any of them.
      const observations: AggregatorVisitObservation[] = [];
      for (let index = 0; index < MIN_DOMAIN_URLS_FOR_HUB + 5; index += 1) {
        observations.push({ canonicalUrl: blogUrl(`/post-${index}`), observedAtMs: index, title: `Post ${index}` });
      }
      applyAggregatorObservations(state, observations);
      expect(isLearnedAggregatorHost(state, BLOG_DOMAIN)).toBe(false);
      for (let index = 0; index < MIN_DOMAIN_URLS_FOR_HUB + 5; index += 1) {
        expect(classifyLearnedAggregatorUrl(state, blogUrl(`/post-${index}`))).toBe('not-aggregator');
      }
    });

    it('a URL never observed on a known hub domain defaults to feed (quarantine)', () => {
      const state = createEmptyAggregatorStatsState();
      seedHubDomain(state, MIN_HUB_FANOUT);
      expect(isLearnedAggregatorHost(state, HUB_DOMAIN)).toBe(true);
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/never-captured'))).toBe('feed');
    });
  });

  describe('hub-ness is behavior, not identity', () => {
    it('the fan-out origin classifies as feed once it clears the hub bar', () => {
      const state = createEmptyAggregatorStatsState();
      seedHubDomain(state, MIN_HUB_FANOUT);
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/feed-hub-1'))).toBe('feed');
    });

    it('leaves reached only from the hub, with no fan-out of their own, classify as item', () => {
      const state = createEmptyAggregatorStatsState();
      seedHubDomain(state, MIN_HUB_FANOUT);
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/item-leaf-0'))).toBe('item');
      expect(classifyLearnedAggregatorUrl(state, hubUrl(`/item-leaf-${MIN_HUB_FANOUT - 1}`))).toBe('item');
    });

    it('a leaf that itself fans out to many same-domain targets is feed, not item', () => {
      const state = createEmptyAggregatorStatsState();
      seedHubDomain(state, MIN_HUB_FANOUT);
      // item-leaf-0 now also behaves like a mini-hub: fans out to many
      // distinct same-domain targets of its own.
      const observations: AggregatorVisitObservation[] = [];
      for (let index = 0; index < MIN_HUB_FANOUT + 1; index += 1) {
        observations.push({
          canonicalUrl: hubUrl(`/sub-item-${index}`),
          observedAtMs: 5_000 + index,
          openerCanonicalUrl: hubUrl('/item-leaf-0'),
        });
      }
      // Corroborate item-leaf-0's own fan-out with a revisit.
      observations.push({ canonicalUrl: hubUrl('/item-leaf-0'), observedAtMs: 6_000 });
      applyAggregatorObservations(state, observations);
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/item-leaf-0'))).toBe('feed');
    });

    it('content that keeps changing under a stable URL classifies as feed via title churn', () => {
      const state = createEmptyAggregatorStatsState();
      seedHubDomain(state, MIN_HUB_FANOUT);
      // A leaf reached from the hub, but its own title changes on every
      // capture — a listing masquerading as a single URL.
      applyAggregatorObservations(state, [
        { canonicalUrl: hubUrl('/rotating-leaf'), observedAtMs: 7_000, title: 'Batch A', openerCanonicalUrl: hubUrl('/feed-hub-1') },
        { canonicalUrl: hubUrl('/rotating-leaf'), observedAtMs: 8_000, title: 'Batch B' },
        { canonicalUrl: hubUrl('/rotating-leaf'), observedAtMs: 9_000, title: 'Batch C' },
      ]);
      expect(classifyLearnedAggregatorUrl(state, hubUrl('/rotating-leaf'))).toBe('feed');
    });
  });

  describe('malformed input', () => {
    it('an unparseable URL classifies as not-aggregator', () => {
      const state = createEmptyAggregatorStatsState();
      expect(classifyLearnedAggregatorUrl(state, 'not a url')).toBe('not-aggregator');
    });
  });

  describe('incremental maintenance — feeding events in two batches equals one batch', () => {
    it('applyAggregatorObservation mutates in place without rescanning prior history', () => {
      const oneShot = createEmptyAggregatorStatsState();
      const observations: AggregatorVisitObservation[] = [];
      observations.push({ canonicalUrl: hubUrl('/feed-hub-1'), observedAtMs: 1_000, title: 'Front page — page 1' });
      observations.push({ canonicalUrl: hubUrl('/feed-hub-1'), observedAtMs: 2_000, title: 'Front page — page 2' });
      for (let index = 0; index < MIN_HUB_FANOUT; index += 1) {
        observations.push({
          canonicalUrl: hubUrl(`/item-leaf-${index}`),
          observedAtMs: 3_000 + index,
          openerCanonicalUrl: hubUrl('/feed-hub-1'),
        });
      }
      applyAggregatorObservations(oneShot, observations);

      // Same observations, split into two batches applied to a fresh state
      // via separate calls — the incremental contract this module is built
      // around (a caller persists `state` and only ever passes NEW events).
      const incremental = createEmptyAggregatorStatsState();
      const [firstBatch, secondBatch] = [observations.slice(0, 2), observations.slice(2)];
      applyAggregatorObservations(incremental, firstBatch);
      applyAggregatorObservations(incremental, secondBatch);

      expect(incremental.urlStats(hubUrl('/feed-hub-1'))).toEqual(oneShot.urlStats(hubUrl('/feed-hub-1')));
      expect(incremental.urlStats(hubUrl('/item-leaf-0'))).toEqual(oneShot.urlStats(hubUrl('/item-leaf-0')));
      expect(incremental.domainStats(HUB_DOMAIN)).toEqual(oneShot.domainStats(HUB_DOMAIN));
      expect(classifyLearnedAggregatorUrl(incremental, hubUrl('/feed-hub-1'))).toBe(
        classifyLearnedAggregatorUrl(oneShot, hubUrl('/feed-hub-1')),
      );
      expect(classifyLearnedAggregatorUrl(incremental, hubUrl('/item-leaf-0'))).toBe(
        classifyLearnedAggregatorUrl(oneShot, hubUrl('/item-leaf-0')),
      );
    });

    it('a single applyAggregatorObservation call only touches its own URL, never the whole state', () => {
      const state = createEmptyAggregatorStatsState();
      seedHubDomain(state, MIN_HUB_FANOUT);
      const before = state.urlStats(hubUrl('/item-leaf-0'));
      applyAggregatorObservation(state, { canonicalUrl: blogUrl('/unrelated'), observedAtMs: 99_999 });
      expect(state.urlStats(hubUrl('/item-leaf-0'))).toEqual(before);
    });
  });

  describe('buildAggregatorShadowAgreement', () => {
    it('tallies agreement, registry-only, learned-only, and feed/item disagreement buckets', () => {
      const agreement = buildAggregatorShadowAgreement([
        { registryType: 'feed', learnedType: 'feed' },
        { registryType: 'item', learnedType: 'item' },
        { registryType: 'not-aggregator', learnedType: 'not-aggregator' },
        { registryType: 'feed', learnedType: 'not-aggregator' }, // registry-only
        { registryType: 'not-aggregator', learnedType: 'feed' }, // learned-only
        { registryType: 'item', learnedType: 'feed' }, // feed-vs-item disagreement
      ]);
      expect(agreement.totalClassified).toBe(6);
      expect(agreement.agreementCount).toBe(3);
      expect(agreement.disagreementCount).toBe(3);
      expect(agreement.agreementRate).toBeCloseTo(0.5, 10);
      expect(agreement.registryOnlyAggregatorCount).toBe(1);
      expect(agreement.learnedOnlyAggregatorCount).toBe(1);
      expect(agreement.feedVsItemDisagreementCount).toBe(1);
      expect(agreement.confusion['feed->feed']).toBe(1);
      expect(agreement.confusion['item->feed']).toBe(1);
    });

    it('reports zero-rate, not NaN, for an empty pair list', () => {
      const agreement = buildAggregatorShadowAgreement([]);
      expect(agreement.totalClassified).toBe(0);
      expect(agreement.agreementRate).toBe(0);
    });
  });

  describe('classifyLearnedAggregatorPage vs classifyLearnedAggregatorUrl', () => {
    it('agree on a well-formed URL', () => {
      const state = createEmptyAggregatorStatsState();
      seedHubDomain(state, MIN_HUB_FANOUT);
      const url = hubUrl('/item-leaf-0');
      expect(classifyLearnedAggregatorPage(state, new URL(url).toString())).toBe(
        classifyLearnedAggregatorUrl(state, url),
      );
    });
  });
});
