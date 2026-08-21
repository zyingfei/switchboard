import { describe, expect, it } from 'vitest';

import {
  DEEP_PATH_MIN_SEGMENTS,
  MIN_HUB_FANOUT,
  PREFIX_PARENT_MIN_CHILDREN,
  SESSION_GAP_MS,
  SINGLE_VISIT_PATTERN_MAX_VISITS,
  applyAggregatorObservations,
  classifyLearnedAggregatorUrl,
  createEmptyAggregatorStatsState,
  isLearnedAggregatorHost,
  type AggregatorStatsState,
  type AggregatorVisitObservation,
} from './learnedAggregatorStats.js';

// A gap comfortably larger than SESSION_GAP_MS — every "visit" spaced this
// far apart is unambiguously a NEW visit, not more captures of the same
// open-tab dwell (see visitCount's own comment). Real single-visit item
// pages routinely fold MULTIPLE raw observations (their own
// navigation.committed plus several periodic BROWSER_TIMELINE_OBSERVED
// re-captures while the tab stays open) — an early build of this signal
// measured ~2.5 timeline captures per navigation on the real test vault, and
// wrongly read that capture density as "revisited". Fixtures below that
// intend to model DISTINCT real visits must space observedAtMs by at least
// this much; fixtures that intend to model captures WITHIN one visit should
// stay well under it.
const VISIT_SPACING_MS = SESSION_GAP_MS + 60_000;

// FEED-VS-ITEM v2, part (2) — deep-path item-inference overreach
// (2026-08-21, task #23). PR #408's re-measurement found the OLD
// deep-path-alone signal (PR #373/#406) fired on x.com permalinks (registry
// policy: always feed), reddit `/r/<sub>` roots (2 path segments — "deep" by
// segment count, but a listing page), and checkout/marketing paths. This
// file exercises the replacement: deep path is now NECESSARY, never
// SUFFICIENT, gated by a sibling-fan-out VETO plus a single-visit-pattern OR
// title-stability VOTE. Fixture domains are synthetic, never real sites, and
// deliberately model the THREE shapes the task names: a hub root (fans out
// via openers — pre-existing signal, unaffected), an item leaf (single-visit
// deep page under a listing), and a subreddit-style listing root (itself
// deep, but the shared prefix of many single-visit children).

const DOMAIN = 'deep-evidence.test';
const url = (path: string): string => `https://${DOMAIN}${path}`;

// Qualifies the domain as a hub via the pre-existing opener-chain fan-out
// signal — unrelated to anything under test here, so every test below can
// isolate the deep-path item-inference gate specifically.
const seedHubViaFanout = (state: AggregatorStatsState): void => {
  const observations: AggregatorVisitObservation[] = [
    { canonicalUrl: url('/feed-hub-1'), observedAtMs: 1_000, title: 'Front page one' },
    { canonicalUrl: url('/feed-hub-1'), observedAtMs: 2_000, title: 'Front page two' },
  ];
  for (let index = 0; index < MIN_HUB_FANOUT; index += 1) {
    observations.push({
      canonicalUrl: url(`/hub-leaf-${String(index)}`),
      observedAtMs: 3_000 + index,
      openerCanonicalUrl: url('/feed-hub-1'),
    });
  }
  applyAggregatorObservations(state, observations);
};

describe('revisit-concentration — single-visit-pattern vs. recurring-revisit', () => {
  it('a deep, single-visit (observed once), untitled URL still classifies as item (single-visit-pattern vote fires alone)', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    applyAggregatorObservations(state, [{ canonicalUrl: url('/deep/item-a'), observedAtMs: 10_000 }]);
    expect(classifyLearnedAggregatorUrl(state, url('/deep/item-a'))).toBe('item');
  });

  it('multiple raw observations WITHIN one session (a single open-tab dwell folding several periodic re-captures) still counts as ONE visit — item, not feed', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    // 3 raw observations a few seconds apart — the exact shape a single
    // real visit takes (its own navigation.committed plus periodic
    // BROWSER_TIMELINE_OBSERVED re-captures while the tab stays open), NOT
    // 3 distinct visits. This is the regression an early build of this
    // signal measured on github.com/owner/repo pages (observationCount=3,
    // visitCount should be 1).
    applyAggregatorObservations(state, [
      { canonicalUrl: url('/deep/single-session'), observedAtMs: 10_000 },
      { canonicalUrl: url('/deep/single-session'), observedAtMs: 10_005 },
      { canonicalUrl: url('/deep/single-session'), observedAtMs: 10_010 },
    ]);
    const stats = state.urlStats(url('/deep/single-session'));
    expect(stats?.observationCount).toBe(3);
    expect(stats?.visitCount).toBe(1);
    expect(classifyLearnedAggregatorUrl(state, url('/deep/single-session'))).toBe('item');
  });

  it('a deep URL revisited past SINGLE_VISIT_PATTERN_MAX_VISITS in DISTINCT, session-gap-separated visits, with no title evidence either way, falls to the conservative feed default (recurring-revisit, no title-stability vote to fall back on)', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    const observations: AggregatorVisitObservation[] = [];
    for (let visit = 0; visit <= SINGLE_VISIT_PATTERN_MAX_VISITS + 2; visit += 1) {
      observations.push({ canonicalUrl: url('/deep/recurring-a'), observedAtMs: 10_000 + visit * VISIT_SPACING_MS });
    }
    applyAggregatorObservations(state, observations);
    // Sanity: this URL really is deep and really is recurring (DISTINCT
    // visits, not raw observation count).
    expect(state.urlStats(url('/deep/recurring-a'))?.pathDepth).toBeGreaterThanOrEqual(DEEP_PATH_MIN_SEGMENTS);
    expect(state.urlStats(url('/deep/recurring-a'))?.visitCount).toBeGreaterThan(SINGLE_VISIT_PATTERN_MAX_VISITS);
    // OLD behavior (deep-path alone) would have called this 'item'; NEW
    // behavior requires a corroborating vote, and there is none here.
    expect(classifyLearnedAggregatorUrl(state, url('/deep/recurring-a'))).toBe('feed');
  });

  it('a deep URL revisited past the single-visit bar (distinct, session-gap-separated visits), but with a STABLE title, still classifies as item (title-stability vote carries it even without single-visit-pattern)', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    const observations: AggregatorVisitObservation[] = [];
    for (let visit = 0; visit <= SINGLE_VISIT_PATTERN_MAX_VISITS + 2; visit += 1) {
      observations.push({
        canonicalUrl: url('/deep/recurring-stable'),
        observedAtMs: 10_000 + visit * VISIT_SPACING_MS,
        title: 'A bookmarked article the user re-reads',
      });
    }
    applyAggregatorObservations(state, observations);
    const stats = state.urlStats(url('/deep/recurring-stable'));
    expect(stats?.visitCount).toBeGreaterThan(SINGLE_VISIT_PATTERN_MAX_VISITS);
    expect(stats?.titleChangeCount).toBe(0);
    expect(classifyLearnedAggregatorUrl(state, url('/deep/recurring-stable'))).toBe('item');
  });

  it('a deep URL that is BOTH recurring (distinct, session-gap-separated visits) AND (mildly) churny — below the feed churn-rate bar but non-zero — clears neither vote and falls to feed', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    // 6 title-bearing captures, one per distinct visit (session-gap
    // separated), exactly ONE post-settle-window churn transition -> churn
    // rate 1/5 = 0.2, well below MIN_TITLE_CHURN_RATE_FOR_FEED (0.34), so
    // the earlier "content keeps changing" check does NOT fire — this
    // isolates the NEW gate's title-stability vote specifically
    // (titleChangeCount !== 0 means NOT stable).
    const titles = ['draft one', 'draft one', 'draft one', 'revised content entirely', 'revised content entirely', 'revised content entirely'];
    applyAggregatorObservations(
      state,
      titles.map((title, index) => ({
        canonicalUrl: url('/deep/recurring-mild-churn'),
        observedAtMs: 10_000 + index * VISIT_SPACING_MS,
        title,
      })),
    );
    const stats = state.urlStats(url('/deep/recurring-mild-churn'));
    expect(stats?.captureCount).toBe(6);
    expect(stats?.titleChangeCount).toBe(1);
    expect(stats?.visitCount).toBeGreaterThan(SINGLE_VISIT_PATTERN_MAX_VISITS);
    expect(classifyLearnedAggregatorUrl(state, url('/deep/recurring-mild-churn'))).toBe('feed');
  });
});

describe('sibling fan-out — prefix-parent VETO (a URL that is itself the shared prefix of many children is a listing, not an item)', () => {
  // Models reddit's `/r/<sub>` shape: the "subreddit root" is 2 path
  // segments (deep, by segment count) but is the literal path-prefix of
  // every `/r/<sub>/comments/<id>` thread beneath it.
  const seedSubredditShapedListing = (state: AggregatorStatsState, threadCount: number): void => {
    const observations: AggregatorVisitObservation[] = [];
    for (let index = 0; index < threadCount; index += 1) {
      observations.push({
        canonicalUrl: url(`/r/pics/comments/thread-${String(index)}`),
        observedAtMs: 20_000 + index,
      });
    }
    applyAggregatorObservations(state, observations);
  };

  it('a subreddit-root-shaped URL (deep, prefix-parent of >= PREFIX_PARENT_MIN_CHILDREN single-visit children) classifies as feed via the veto, even though it is itself single-visit', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    seedSubredditShapedListing(state, PREFIX_PARENT_MIN_CHILDREN);
    // The root itself, visited once, with no title/fan-out evidence — the
    // OLD deep-path-alone (or even the new single-visit-pattern vote alone)
    // would call this 'item'; the sibling-fan-out veto must block it.
    applyAggregatorObservations(state, [{ canonicalUrl: url('/r/pics'), observedAtMs: 19_000 }]);
    expect(state.pathPrefixChildCount(url('/r/pics'))).toBeGreaterThanOrEqual(PREFIX_PARENT_MIN_CHILDREN);
    expect(classifyLearnedAggregatorUrl(state, url('/r/pics'))).toBe('feed');
  });

  it('one fewer child than the bar does NOT veto — the root falls back to the single-visit-pattern vote and classifies as item (no over-eager rounding)', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    seedSubredditShapedListing(state, PREFIX_PARENT_MIN_CHILDREN - 1);
    applyAggregatorObservations(state, [{ canonicalUrl: url('/r/pics'), observedAtMs: 19_000 }]);
    expect(state.pathPrefixChildCount(url('/r/pics'))).toBeLessThan(PREFIX_PARENT_MIN_CHILDREN);
    expect(classifyLearnedAggregatorUrl(state, url('/r/pics'))).toBe('item');
  });

  it('a thread leaf under the listing root (deep, single-visit, NOT itself a prefix-parent of anything) classifies as item', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    seedSubredditShapedListing(state, PREFIX_PARENT_MIN_CHILDREN);
    expect(state.pathPrefixChildCount(url('/r/pics/comments/thread-0'))).toBe(0);
    expect(classifyLearnedAggregatorUrl(state, url('/r/pics/comments/thread-0'))).toBe('item');
  });

  it('hub root vs. item leaf vs. subreddit-shaped listing root, side by side on one domain', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state); // /feed-hub-1 (opener-chain hub) + 8 hub-leaf-N (item)
    seedSubredditShapedListing(state, PREFIX_PARENT_MIN_CHILDREN); // /r/pics (prefix-parent) + N threads (item)
    applyAggregatorObservations(state, [{ canonicalUrl: url('/r/pics'), observedAtMs: 19_000 }]);

    expect(isLearnedAggregatorHost(state, DOMAIN)).toBe(true);
    // Hub root — pre-existing opener-chain fan-out signal, unaffected by
    // this task.
    expect(classifyLearnedAggregatorUrl(state, url('/feed-hub-1'))).toBe('feed');
    // Item leaves under the opener-chain hub — unaffected.
    expect(classifyLearnedAggregatorUrl(state, url('/hub-leaf-0'))).toBe('item');
    // Subreddit-shaped listing root — deep by segment count, but vetoed by
    // sibling fan-out.
    expect(classifyLearnedAggregatorUrl(state, url('/r/pics'))).toBe('feed');
    // Thread leaves under it — deep, single-visit, not themselves a
    // prefix-parent of anything.
    expect(classifyLearnedAggregatorUrl(state, url('/r/pics/comments/thread-0'))).toBe('item');
  });
});

describe('conservative combination — never deep-path alone', () => {
  it('PREFIX_PARENT_MIN_CHILDREN mirrors MIN_HUB_FANOUT — documentation-as-test guard against silent drift', () => {
    expect(PREFIX_PARENT_MIN_CHILDREN).toBe(MIN_HUB_FANOUT);
  });

  it('SINGLE_VISIT_PATTERN_MAX_VISITS is a small, positive bound', () => {
    expect(SINGLE_VISIT_PATTERN_MAX_VISITS).toBeGreaterThan(0);
    expect(SINGLE_VISIT_PATTERN_MAX_VISITS).toBeLessThan(MIN_HUB_FANOUT);
  });

  it('a SHALLOW ambiguous URL is untouched by any of this — still the conservative feed default', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubViaFanout(state);
    applyAggregatorObservations(state, [{ canonicalUrl: url('/about'), observedAtMs: 50_000 }]);
    expect(classifyLearnedAggregatorUrl(state, url('/about'))).toBe('feed');
  });
});
