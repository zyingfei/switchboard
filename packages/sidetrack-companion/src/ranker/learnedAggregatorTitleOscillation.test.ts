import { describe, expect, it } from 'vitest';

import {
  MAX_TRACKED_DISTINCT_TITLES_PER_URL,
  MIN_DISTINCT_URLS_FOR_BOILERPLATE_TITLE,
  MIN_TITLE_CHURN_RATE_FOR_FEED,
  applyAggregatorObservations,
  classifyLearnedAggregatorUrl,
  createEmptyAggregatorStatsState,
  type AggregatorStatsState,
  type AggregatorVisitObservation,
} from './learnedAggregatorStats.js';

// FEED-VS-ITEM v2, part (1) — oscillating placeholder titles (2026-08-21,
// task #23). The title-churn-robustness follow-up (task #22 remainder) fixed
// volatile IN-TITLE METADATA but left a different, previously-unnamed shape
// unaddressed: a generic loading-placeholder title ("ChatGPT", "Reddit - The
// heart of the internet") that ALTERNATES with the real title across
// captures (tab background/foreground re-renders). Each individual
// transition looks maximally "substantively different" by Jaccard (the
// placeholder and the real title share no tokens at all) — this is NOT a
// metadata-shape problem, it needs the oscillation-set + domain-boilerplate
// signals this file covers. Fixture domains are synthetic, never real sites.

const HUB_DOMAIN = 'osc-hub.test';
const hubUrl = (path: string): string => `https://${HUB_DOMAIN}${path}`;

// Seeds a hub domain via the pre-existing fan-out signal (unrelated to title
// churn), same style as learnedAggregatorTitleChurnRobustness.test.ts, so
// each test below can isolate the title-oscillation gate in
// classifyLearnedAggregatorPage.
const seedHubDomainViaFanout = (state: AggregatorStatsState): void => {
  const observations: AggregatorVisitObservation[] = [
    { canonicalUrl: hubUrl('/feed-hub-1'), observedAtMs: 1_000, title: 'Front page one' },
    { canonicalUrl: hubUrl('/feed-hub-1'), observedAtMs: 2_000, title: 'Front page two' },
  ];
  for (let index = 0; index < 8; index += 1) {
    observations.push({
      canonicalUrl: hubUrl(`/item-leaf-${String(index)}`),
      observedAtMs: 3_000 + index,
      openerCanonicalUrl: hubUrl('/feed-hub-1'),
    });
  }
  applyAggregatorObservations(state, observations);
};

describe('oscillation-set tracking — a small alternating title set is not churn', () => {
  it('alternating between exactly 2 values (placeholder <-> real title) never registers as churn, however different the values look', () => {
    const state = createEmptyAggregatorStatsState();
    applyAggregatorObservations(state, [
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 1_000, title: 'ChatGPT' },
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 1_100, title: 'Discussing quantum error correction' },
      // Beyond the settle window from here on — every transition below is a
      // RETURN to an already-seen value, never a novel title.
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 1_200, title: 'ChatGPT' },
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 1_300, title: 'Discussing quantum error correction' },
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 1_400, title: 'ChatGPT' },
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 1_500, title: 'Discussing quantum error correction' },
    ]);
    const stats = state.urlStats(hubUrl('/deep/convo-1'));
    expect(stats?.captureCount).toBe(6);
    expect(stats?.titleChangeCount).toBe(0);
    expect(stats?.distinctTitleCount).toBe(2);
  });

  it('a 3-value oscillation (placeholder + two transient variants) also never registers as churn once each value has been seen once', () => {
    const state = createEmptyAggregatorStatsState();
    applyAggregatorObservations(state, [
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 1_000, title: 'Reddit - The heart of the internet' },
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 1_100, title: 'My favorite post about otters' },
      // 3rd distinct value, still inside the "small set" spirit.
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 1_200, title: 'Reddit' },
      // From here every capture repeats one of the 3 established values.
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 1_300, title: 'My favorite post about otters' },
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 1_400, title: 'Reddit - The heart of the internet' },
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 1_500, title: 'Reddit' },
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 1_600, title: 'My favorite post about otters' },
    ]);
    const stats = state.urlStats(hubUrl('/deep/convo-2'));
    // Only the 3rd capture ("Reddit") is a genuinely NOVEL title beyond the
    // settle window (captures 1-2 are within the settle window) — one
    // churn transition, not more, despite 7 total captures alternating
    // wildly by token content.
    expect(stats?.titleChangeCount).toBe(1);
    expect(stats?.distinctTitleCount).toBe(3);
  });

  it('MAX_TRACKED_DISTINCT_TITLES_PER_URL bounds the tracked set — documentation-as-test guard', () => {
    expect(MAX_TRACKED_DISTINCT_TITLES_PER_URL).toBeGreaterThanOrEqual(3);
  });
});

describe('novel-title stream — genuinely rotating content still registers as churn', () => {
  const DISJOINT_WORDS = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
  ] as const;

  it('a URL whose title is NEVER a repeat of a prior value churns on every post-settle-window transition', () => {
    const state = createEmptyAggregatorStatsState();
    applyAggregatorObservations(
      state,
      DISJOINT_WORDS.map((word, index) => ({
        canonicalUrl: hubUrl('/deep/rotating'),
        observedAtMs: 1_000 + index,
        title: word,
      })),
    );
    const stats = state.urlStats(hubUrl('/deep/rotating'));
    expect(stats?.captureCount).toBe(DISJOINT_WORDS.length);
    // Settle window excuses exactly the first transition; every other
    // adjacent pair is a brand-new word, never previously seen.
    expect(stats?.titleChangeCount).toBe(DISJOINT_WORDS.length - 2);
    expect(stats?.distinctTitleCount).toBe(MAX_TRACKED_DISTINCT_TITLES_PER_URL);
  });
});

describe('classifyLearnedAggregatorPage — oscillating placeholder title classifies as item, not feed', () => {
  it('a deep item page whose title oscillates between a placeholder and the real title classifies as item', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubDomainViaFanout(state);
    applyAggregatorObservations(state, [
      { canonicalUrl: hubUrl('/deep/convo-3'), observedAtMs: 10_000, title: 'ChatGPT', openerCanonicalUrl: hubUrl('/feed-hub-1') },
      { canonicalUrl: hubUrl('/deep/convo-3'), observedAtMs: 10_100, title: 'Discussing quantum error correction' },
      { canonicalUrl: hubUrl('/deep/convo-3'), observedAtMs: 20_000, title: 'ChatGPT' },
      { canonicalUrl: hubUrl('/deep/convo-3'), observedAtMs: 20_100, title: 'Discussing quantum error correction' },
      { canonicalUrl: hubUrl('/deep/convo-3'), observedAtMs: 30_000, title: 'ChatGPT' },
    ]);
    expect(classifyLearnedAggregatorUrl(state, hubUrl('/deep/convo-3'))).toBe('item');
  });
});

describe('domain-boilerplate title exclusion — a title recurring across MANY distinct URLs is chrome, not content', () => {
  const BOILERPLATE_DOMAIN = 'boilerplate-hub.test';
  const boilerplateUrl = (path: string): string => `https://${BOILERPLATE_DOMAIN}${path}`;
  const PLACEHOLDER_TITLE = 'ChatGPT';

  // Each of `count` conversations gets exactly 3 title-bearing captures: the
  // placeholder twice, then a URL-SPECIFIC real title once. Observations are
  // built in TIME-INTERLEAVED ROUNDS (every conversation's 1st capture, then
  // every conversation's 2nd, then every conversation's 3rd) — the realistic
  // shape a live vault takes (a user multitasks across several open tabs
  // rather than finishing one conversation before starting the next), and
  // the shape that lets the domain accumulate boilerplate evidence from
  // EVERY conversation's early captures before any conversation reaches its
  // real-title transition. This module is INCREMENTAL by contract (module
  // header) — a transition is judged against evidence accumulated so far,
  // never against evidence that arrives later in the same feed.
  const interleavedConvos = (count: number, startAtMs: number): AggregatorVisitObservation[] => {
    const paths = Array.from({ length: count }, (_, index) => `/deep/convo-${String(index)}`);
    const observations: AggregatorVisitObservation[] = [];
    let ms = startAtMs;
    for (const path of paths) {
      observations.push({ canonicalUrl: boilerplateUrl(path), observedAtMs: ms, title: PLACEHOLDER_TITLE });
      ms += 1;
    }
    for (const path of paths) {
      observations.push({ canonicalUrl: boilerplateUrl(path), observedAtMs: ms, title: PLACEHOLDER_TITLE });
      ms += 1;
    }
    for (const path of paths) {
      observations.push({
        canonicalUrl: boilerplateUrl(path),
        observedAtMs: ms,
        title: `Distinct real title for ${path}`,
      });
      ms += 1;
    }
    return observations;
  };

  it('once the placeholder has recurred across MIN_DISTINCT_URLS_FOR_BOILERPLATE_TITLE distinct URLs, the placeholder -> real-title transition is excluded from churn on ALL of them', () => {
    const state = createEmptyAggregatorStatsState();
    applyAggregatorObservations(state, interleavedConvos(MIN_DISTINCT_URLS_FOR_BOILERPLATE_TITLE, 1_000));
    for (let index = 0; index < MIN_DISTINCT_URLS_FOR_BOILERPLATE_TITLE; index += 1) {
      const stats = state.urlStats(boilerplateUrl(`/deep/convo-${String(index)}`));
      expect(stats?.captureCount).toBe(3);
      expect(stats?.titleChangeCount).toBe(0);
    }
  });

  it('below the distinct-URL bar, the SAME placeholder title is not yet recognized as boilerplate — the transition still churns (threshold behavior, not a hardcoded string)', () => {
    const state = createEmptyAggregatorStatsState();
    // One fewer than the bar.
    applyAggregatorObservations(state, interleavedConvos(MIN_DISTINCT_URLS_FOR_BOILERPLATE_TITLE - 1, 1_000));
    const stats = state.urlStats(boilerplateUrl('/deep/convo-0'));
    expect(stats?.captureCount).toBe(3);
    // Not yet boilerplate — the 3rd capture is a genuine novel, substantive
    // transition and DOES register as churn.
    expect(stats?.titleChangeCount).toBe(1);
  });

  it('end to end: a deep item page whose title flips ONCE from a now-recognized domain placeholder classifies as item via title-stability (FEED-VS-ITEM v2 parts (1) and (2) composing)', () => {
    const state = createEmptyAggregatorStatsState();
    // Seed enough distinct URLs sharing the placeholder to cross the bar
    // (including the URL under test, convo-0) — all interleaved together so
    // the boilerplate count is established before ANY of them reaches its
    // real-title capture. With titleChangeCount corrected to 0 by the
    // boilerplate exclusion, convo-0 clears the NEW deep-path gate's
    // title-stability vote (part (2)) with no opener/fan-out evidence of
    // its own at all.
    const observations = [...interleavedConvos(MIN_DISTINCT_URLS_FOR_BOILERPLATE_TITLE, 1_000)];
    // Independent hub qualification via the pre-existing fan-out signal, so
    // BOILERPLATE_DOMAIN clears isLearnedAggregatorHost without relying on
    // anything this test is trying to isolate.
    observations.push(
      { canonicalUrl: boilerplateUrl('/feed-hub-1'), observedAtMs: 500, title: 'Front page one' },
      { canonicalUrl: boilerplateUrl('/feed-hub-1'), observedAtMs: 600, title: 'Front page two' },
    );
    for (let index = 0; index < 8; index += 1) {
      observations.push({
        canonicalUrl: boilerplateUrl(`/item-leaf-${String(index)}`),
        observedAtMs: 700 + index,
        openerCanonicalUrl: boilerplateUrl('/feed-hub-1'),
      });
    }
    applyAggregatorObservations(state, observations);
    expect(classifyLearnedAggregatorUrl(state, boilerplateUrl('/deep/convo-0'))).toBe('item');
  });
});

describe('MIN_TITLE_CHURN_RATE_FOR_FEED still gates the (now oscillation-aware) churn rate the same way', () => {
  it('sanity bounds', () => {
    expect(MIN_TITLE_CHURN_RATE_FOR_FEED).toBeGreaterThan(0);
    expect(MIN_TITLE_CHURN_RATE_FOR_FEED).toBeLessThanOrEqual(1);
  });
});
