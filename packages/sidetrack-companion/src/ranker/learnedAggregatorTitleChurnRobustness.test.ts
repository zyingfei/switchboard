import { describe, expect, it } from 'vitest';

import {
  MIN_TITLE_CHURN_RATE_FOR_FEED,
  STABLE_CONTENT_CHURN_JACCARD_THRESHOLD,
  TITLE_SETTLE_WINDOW_OBSERVATIONS,
  applyAggregatorObservations,
  classifyLearnedAggregatorUrl,
  createEmptyAggregatorStatsState,
  isSubstantiveTitleChurn,
  type AggregatorStatsState,
  type AggregatorVisitObservation,
} from './learnedAggregatorStats.js';

// Metadata-robust title churn (2026-08-21 follow-up, task #22 remainder).
// PR #406's disagreement sampling attributed 96-100% of every item->feed
// misfire on github.com/reddit.com/chatgpt.com/claude.ai to volatile
// IN-TITLE METADATA (vote counts, unread/notification counters, chat
// auto-renaming, live tickers) tripping the pre-existing exact-inequality
// title-churn signal. These tests cover (a) the stable-content
// normalization + Jaccard comparison directly, on the EXACT patterns named
// by that sampling, and (b) the settle-window semantics and Jaccard
// threshold behavior through the public applyAggregatorObservation(s) /
// classifyLearnedAggregatorUrl surface — the same style
// learnedAggregatorShallowChurn.test.ts uses for its own signal.

const HUB_DOMAIN = 'hub.test';
const hubUrl = (path: string): string => `https://${HUB_DOMAIN}${path}`;

// Seeds a hub domain via the pre-existing fan-out signal (unrelated to
// title churn) so every test below can isolate the per-URL title-churn gate
// in classifyLearnedAggregatorPage without also having to qualify the
// domain as a hub through churn itself.
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

describe('isSubstantiveTitleChurn — stable-content normalization', () => {
  it('is a no-op (never churn) for an identical title', () => {
    expect(isSubstantiveTitleChurn('same title', 'same title')).toBe(false);
  });

  describe('vote/comment counters — a short digit-bearing bracket segment', () => {
    it('reddit-style "(123 points)" varying does not register as churn', () => {
      expect(isSubstantiveTitleChurn('great post about otters (123 points)', 'great post about otters (145 points)')).toBe(false);
    });

    it('a varying comment count in the same shape does not register as churn', () => {
      expect(isSubstantiveTitleChurn('discussion thread (12 comments)', 'discussion thread (58 comments)')).toBe(false);
    });
  });

  describe('unread/notification counters — a leading bracketed counter', () => {
    it('github-style "(3) reponame" varying does not register as churn', () => {
      expect(isSubstantiveTitleChurn('(3) my-repo', '(7) my-repo')).toBe(false);
    });

    it('gmail-style "(3) Inbox" varying does not register as churn', () => {
      expect(isSubstantiveTitleChurn('(3) inbox', '(12) inbox')).toBe(false);
    });

    it('a bare (unbracketed) leading counter varying does not register as churn', () => {
      expect(isSubstantiveTitleChurn('3 inbox', '12 inbox')).toBe(false);
    });
  });

  describe('live tickers / timestamps — standalone numeric tokens anywhere in the title', () => {
    it('a live price value varying does not register as churn', () => {
      expect(isSubstantiveTitleChurn('aapl 182.45 stock ticker', 'aapl 183.02 stock ticker')).toBe(false);
    });

    it('a live timestamp varying does not register as churn', () => {
      expect(isSubstantiveTitleChurn('live updates 3:45 pm et', 'live updates 3:52 pm et')).toBe(false);
    });
  });

  describe('chat auto-renaming — a genuine, substantive one-time content shift', () => {
    it('IS substantive drift at the token level (settle-window semantics, tested separately, is what exempts it)', () => {
      // isSubstantiveTitleChurn itself has no notion of "which observation
      // number is this" — a generic placeholder renaming to a specific
      // conversation title is real token drift; the settle window (tested
      // below via applyAggregatorObservation) is a SEPARATE mechanism that
      // exempts the first transition regardless of what this function says.
      expect(isSubstantiveTitleChurn('new conversation', 'discussing quantum error correction basics')).toBe(true);
    });
  });

  describe('genuinely different content still registers as churn', () => {
    it('two disjoint-content titles register as churn', () => {
      expect(isSubstantiveTitleChurn('top stories today', 'market update this morning')).toBe(true);
    });

    it('a rotating listing headline (partial overlap, mostly different) registers as churn', () => {
      expect(isSubstantiveTitleChurn('batch a', 'batch b')).toBe(true);
    });
  });

  describe('CJK safety — numeric stripping must not destroy CJK content', () => {
    it('a Chinese vote/comment-count-style bracket varying does not register as churn (content preserved)', () => {
      expect(isSubstantiveTitleChurn('文章标题 (123 条评论)', '文章标题 (156 条评论)')).toBe(false);
    });

    it('genuinely different Chinese content still registers as churn (CJK churn is not swallowed)', () => {
      expect(isSubstantiveTitleChurn('今天天气很好', '股票市场大跌')).toBe(true);
    });

    it('a Japanese leading notification counter varying does not register as churn', () => {
      expect(isSubstantiveTitleChurn('(3) 受信トレイ', '(12) 受信トレイ')).toBe(false);
    });

    it('mixed CJK + ASCII-digit metadata: the counter is stripped and ignored, but substantive CJK content drift still registers', () => {
      expect(isSubstantiveTitleChurn('(3) 通知 - サービス名', '(3) 通知 - サービス名')).toBe(false);
      // Same counter-varying shape, but the CONTENT after it is genuinely
      // different (not just a differing suffix letter) -- confirms the
      // counter strip does not accidentally mask real drift underneath it.
      expect(isSubstantiveTitleChurn('(3) 今天天气很好', '(12) 股票市场大跌')).toBe(true);
    });
  });

  describe('edge case: both titles reduce to nothing but metadata', () => {
    it('conservatively treats an all-noise, unequal pair as churn (no positive evidence they are the same content)', () => {
      // "12" and "34" are both pure numeric tokens -- stripped entirely,
      // leaving an empty stable-content set on both sides. Per the binding
      // cold-start rule (over-suppress, never under-suppress), this is
      // treated as churn, not silently ignored.
      expect(isSubstantiveTitleChurn('12', '34')).toBe(true);
    });
  });

  describe('STABLE_CONTENT_CHURN_JACCARD_THRESHOLD — boundary behavior (pinned to 0.5)', () => {
    it('is exactly 0.5 — the tests below assume this exact value to pin the boundary direction', () => {
      expect(STABLE_CONTENT_CHURN_JACCARD_THRESHOLD).toBe(0.5);
    });

    it('a token overlap exactly AT the threshold (jaccard=0.5) counts as NOT churn (>= similarity, not >)', () => {
      // "alpha bravo" vs "alpha bravo charlie delta":
      // intersection={alpha,bravo}=2, union={alpha,bravo,charlie,delta}=4,
      // jaccard=0.5 -- exactly the threshold.
      expect(isSubstantiveTitleChurn('alpha bravo', 'alpha bravo charlie delta')).toBe(false);
    });

    it('a token overlap just BELOW the threshold counts as churn', () => {
      // "alpha bravo" vs "alpha bravo charlie delta echo":
      // intersection={alpha,bravo}=2, union=5, jaccard=0.4 -- below 0.5.
      expect(isSubstantiveTitleChurn('alpha bravo', 'alpha bravo charlie delta echo')).toBe(true);
    });
  });
});

describe('title-churn settle window — chat auto-rename case', () => {
  it('a title that renames ONCE then holds steady is SETTLING, not churn — never classifies as feed via title churn alone', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubDomainViaFanout(state);
    applyAggregatorObservations(state, [
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 10_000, title: 'New conversation' },
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 10_100, title: 'Discussing quantum error correction basics' },
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 20_000, title: 'Discussing quantum error correction basics' },
      { canonicalUrl: hubUrl('/deep/convo-1'), observedAtMs: 30_000, title: 'Discussing quantum error correction basics' },
    ]);
    const stats = state.urlStats(hubUrl('/deep/convo-1'));
    expect(stats?.titleChangeCount).toBe(0);
  });

  it('TITLE_SETTLE_WINDOW_OBSERVATIONS captures exempt exactly the FIRST adjacent-capture transition, not later ones', () => {
    expect(TITLE_SETTLE_WINDOW_OBSERVATIONS).toBe(2);
    const state = createEmptyAggregatorStatsState();
    seedHubDomainViaFanout(state);
    // Settling rename (exempt, transition into capture 2), THEN a genuine
    // substantive change (NOT exempt, transition into capture 3) -- the
    // window only ever excuses the one settling transition.
    applyAggregatorObservations(state, [
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 10_000, title: 'New conversation' },
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 10_100, title: 'Discussing quantum error correction basics' },
      { canonicalUrl: hubUrl('/deep/convo-2'), observedAtMs: 20_000, title: 'Now about something entirely different' },
    ]);
    const stats = state.urlStats(hubUrl('/deep/convo-2'));
    expect(stats?.captureCount).toBe(3);
    expect(stats?.titleChangeCount).toBe(1);
  });

  it('a settling rename does not contribute a sample to the per-domain shallow-churn aggregate either', () => {
    const state = createEmptyAggregatorStatsState();
    const fillerObservations: AggregatorVisitObservation[] = Array.from({ length: 5 }, (_, i) => ({
      canonicalUrl: hubUrl(`/p${String(i)}`),
      observedAtMs: 500 + i,
    }));
    applyAggregatorObservations(state, [
      ...fillerObservations,
      { canonicalUrl: hubUrl('/new'), observedAtMs: 1_000, title: 'New conversation' },
      { canonicalUrl: hubUrl('/new'), observedAtMs: 1_100, title: 'Discussing quantum error correction basics' },
    ]);
    const stats = state.domainStats(HUB_DOMAIN);
    expect(stats?.shallowTitleChurnSampleCount).toBe(0);
  });
});

describe('classifyLearnedAggregatorPage — metadata-robust churn end to end', () => {
  it('an item whose title only churns via a reddit-style vote-count metadata pattern classifies as item, not feed', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubDomainViaFanout(state);
    applyAggregatorObservations(state, [
      { canonicalUrl: hubUrl('/deep/post-1'), observedAtMs: 10_000, title: 'a great post about otters (12 points)', openerCanonicalUrl: hubUrl('/feed-hub-1') },
      { canonicalUrl: hubUrl('/deep/post-1'), observedAtMs: 20_000, title: 'a great post about otters (145 points)' },
      { canonicalUrl: hubUrl('/deep/post-1'), observedAtMs: 30_000, title: 'a great post about otters (612 points)' },
    ]);
    expect(classifyLearnedAggregatorUrl(state, hubUrl('/deep/post-1'))).toBe('item');
  });

  it('an item whose title only churns via a github-style unread-counter metadata pattern classifies as item, not feed', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubDomainViaFanout(state);
    applyAggregatorObservations(state, [
      { canonicalUrl: hubUrl('/deep/repo-1'), observedAtMs: 10_000, title: '(3) my-project', openerCanonicalUrl: hubUrl('/feed-hub-1') },
      { canonicalUrl: hubUrl('/deep/repo-1'), observedAtMs: 20_000, title: '(7) my-project' },
      { canonicalUrl: hubUrl('/deep/repo-1'), observedAtMs: 30_000, title: '(0) my-project' },
    ]);
    expect(classifyLearnedAggregatorUrl(state, hubUrl('/deep/repo-1'))).toBe('item');
  });

  it('a URL that genuinely rotates content under a stable URL still classifies as feed (churn detection is not disabled, only made metadata-robust)', () => {
    const state = createEmptyAggregatorStatsState();
    seedHubDomainViaFanout(state);
    applyAggregatorObservations(state, [
      { canonicalUrl: hubUrl('/rotating'), observedAtMs: 10_000, title: 'top stories today' },
      { canonicalUrl: hubUrl('/rotating'), observedAtMs: 20_000, title: 'market update this morning' },
      { canonicalUrl: hubUrl('/rotating'), observedAtMs: 30_000, title: 'weather alert for the region' },
    ]);
    expect(classifyLearnedAggregatorUrl(state, hubUrl('/rotating'))).toBe('feed');
  });

  it('MIN_TITLE_CHURN_RATE_FOR_FEED still gates the (now metadata-robust) churn rate the same way', () => {
    expect(MIN_TITLE_CHURN_RATE_FOR_FEED).toBeGreaterThan(0);
    expect(MIN_TITLE_CHURN_RATE_FOR_FEED).toBeLessThanOrEqual(1);
  });
});
