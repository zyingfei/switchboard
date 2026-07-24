import { describe, expect, it } from 'vitest';

import {
  aggregatorCommunityKey,
  classifyAggregatorPage,
  isAggregatorHost,
  stripSiteTitleSuffix,
} from './aggregatorProfiles.js';

describe('aggregatorProfiles', () => {
  describe('isAggregatorHost', () => {
    it('matches by registrable domain across subdomains and FQDN form', () => {
      for (const host of [
        'news.ycombinator.com',
        'ycombinator.com',
        'old.reddit.com',
        'm.youtube.com',
        'gemini.google.com',
        'www.google.com',
        'x.com',
        'lobste.rs',
        'foo.lobste.rs',
        'news.ycombinator.com.', // trailing-dot FQDN
        'stackoverflow.com',
        'claude.ai',
        'medium.com',
      ]) {
        expect(isAggregatorHost(host)).toBe(true);
      }
    });

    it('does not match look-alikes, non-aggregators, or bare TLDs', () => {
      for (const host of [
        'github.com',
        'blog.example.test',
        'kernel.org',
        'en.wikipedia.org',
        'notreddit.com', // suffix-anchored, not substring
        'reddit.com.evil.example', // registrable domain is evil.example
        '',
        'com',
      ]) {
        expect(isAggregatorHost(host)).toBe(false);
      }
    });
  });

  describe('classifyAggregatorPage — the core feed/item distinction', () => {
    it('classifies HN item?id= as item and everything else on the domain as feed', () => {
      expect(classifyAggregatorPage('https://news.ycombinator.com/item?id=48083580')).toBe('item');
      // Feed / listing shapes.
      for (const url of [
        'https://news.ycombinator.com/',
        'https://news.ycombinator.com/?p=2',
        'https://news.ycombinator.com/newest',
        'https://news.ycombinator.com/front',
        'https://news.ycombinator.com/active',
        'https://news.ycombinator.com/from?site=github.com',
        'https://news.ycombinator.com/user?id=someone',
      ]) {
        expect(classifyAggregatorPage(url)).toBe('feed');
      }
    });

    it('classifies reddit comment threads as item, subreddit listings as feed', () => {
      expect(
        classifyAggregatorPage('https://old.reddit.com/r/rust/comments/aaa/a_post/'),
      ).toBe('item');
      expect(classifyAggregatorPage('https://www.reddit.com/r/rust/')).toBe('feed');
      expect(classifyAggregatorPage('https://www.reddit.com/')).toBe('feed');
    });

    it('classifies youtube watch/shorts as item, channel/home as feed', () => {
      expect(classifyAggregatorPage('https://www.youtube.com/watch?v=abc123')).toBe('item');
      expect(classifyAggregatorPage('https://www.youtube.com/shorts/xyz')).toBe('item');
      expect(classifyAggregatorPage('https://www.youtube.com/')).toBe('feed');
      expect(classifyAggregatorPage('https://www.youtube.com/feed/subscriptions')).toBe('feed');
    });

    it('treats feed-only domains (search/chat) as always feed', () => {
      expect(classifyAggregatorPage('https://www.google.com/search?q=llm')).toBe('feed');
      expect(classifyAggregatorPage('https://chatgpt.com/c/abc')).toBe('feed');
      expect(classifyAggregatorPage('https://claude.ai/chat/def')).toBe('feed');
    });

    it('returns not-aggregator for other domains and malformed urls', () => {
      expect(classifyAggregatorPage('https://kernel.org/doc/security')).toBe('not-aggregator');
      expect(classifyAggregatorPage('https://github.com/owner/repo')).toBe('not-aggregator');
      expect(classifyAggregatorPage('not a url')).toBe('not-aggregator');
    });
  });

  describe('stripSiteTitleSuffix', () => {
    it('strips the HN suffix (case-insensitive tail) but leaves the story text', () => {
      expect(
        stripSiteTitleSuffix(
          'Linux security mailing list ’almost unmanageable’ | Hacker News',
          'news.ycombinator.com',
        ),
      ).toBe('Linux security mailing list ’almost unmanageable’');
      expect(
        stripSiteTitleSuffix('Five Years of Tinygrad | hacker news', 'news.ycombinator.com'),
      ).toBe('Five Years of Tinygrad');
    });

    it('strips YouTube suffix for its host', () => {
      expect(stripSiteTitleSuffix('Some talk - YouTube', 'www.youtube.com')).toBe('Some talk');
    });

    it('strips the reddit `: r/<subreddit>` variable tail (real title shape)', () => {
      // Real reddit titles end `… : r/<sub>` (verified live: 0/32 titles ended
      // ' : reddit'; the literal suffix matched nothing). The subreddit varies,
      // so this must be a pattern strip.
      expect(
        stripSiteTitleSuffix(
          'Engineering a Columnar Database in Rust : r/programming',
          'www.reddit.com',
        ),
      ).toBe('Engineering a Columnar Database in Rust');
      expect(stripSiteTitleSuffix('I made a thing : r/rust', 'old.reddit.com')).toBe(
        'I made a thing',
      );
      // Subreddits with mixed case / digits / underscores.
      expect(
        stripSiteTitleSuffix('Best books of 2024 : r/RSbookclub', 'www.reddit.com'),
      ).toBe('Best books of 2024');
      // A title WITHOUT the tail is untouched (no over-strip).
      expect(stripSiteTitleSuffix('A bare reddit title', 'www.reddit.com')).toBe(
        'A bare reddit title',
      );
    });

    it('leaves non-aggregator titles completely untouched', () => {
      const title = 'My blog post | My Site';
      expect(stripSiteTitleSuffix(title, 'blog.example.test')).toBe(title);
    });

    it('does not strip a suffix that belongs to a different aggregator', () => {
      // "- YouTube" is not HN's suffix, so an HN-host title keeping it is untouched.
      const title = 'A post - YouTube';
      expect(stripSiteTitleSuffix(title, 'news.ycombinator.com')).toBe(title);
    });
  });

  describe('aggregatorCommunityKey', () => {
    it('keys reddit by subreddit and medium by author', () => {
      expect(aggregatorCommunityKey('old.reddit.com', ['r', 'rust', 'comments', 'aaa'])).toBe(
        'forum:reddit.com/r/rust',
      );
      expect(aggregatorCommunityKey('medium.com', ['@jane', 'essay-abc'])).toBe(
        'author:medium.com/@jane',
      );
    });

    it('returns null for HN (no sub-community) and non-aggregators', () => {
      expect(aggregatorCommunityKey('news.ycombinator.com', ['item'])).toBeNull();
      expect(aggregatorCommunityKey('blog.example.test', ['posts', 'one'])).toBeNull();
    });
  });
});
