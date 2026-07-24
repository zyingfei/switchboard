import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanCorpusText,
  corpusForVisitEntry,
  similarityCorpusConfigSignature,
  type VisitSimilarityEntry,
} from './visitSimilarity.js';

// The corpus cleaner is a SERVING-edge change, so it ships behind
// SIDETRACK_SIMILARITY_CLEAN_CORPUS (default OFF). These tests read back the
// corpus text the embedding pipeline actually feeds the encoder — the artifact
// that determines every same-site cosine (DEBUGGING_DOCTRINE rule 10).
const withCleanCorpus = (value: string | undefined, run: () => void): void => {
  const previous = process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'];
  if (value === undefined) delete process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'];
  else process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'];
    else process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = previous;
  }
};

const entry = (title: string, canonicalUrl: string): VisitSimilarityEntry => ({
  id: canonicalUrl,
  firstSeenAt: '2026-05-07T10:00:00.000Z',
  lastSeenAt: '2026-05-07T10:00:00.000Z',
  url: canonicalUrl,
  canonicalUrl,
  title,
  provider: 'generic',
  visitCount: 1,
});

describe('visitSimilarity corpus cleaning', () => {
  afterEach(() => {
    delete process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'];
  });

  describe('DEFAULT (flag OFF): frozen skeleton, byte-identical to legacy', () => {
    it('embeds title + host + path tokens for an HN item (the measured false-friend engine)', () => {
      withCleanCorpus(undefined, () => {
        const corpus = corpusForVisitEntry(
          entry(
            'Linux security mailing list ’almost unmanageable’ | Hacker News',
            'https://news.ycombinator.com/item?id=48178692',
          ),
        );
        // The skeleton `news.ycombinator.com item` is present (this is what
        // inflates same-site cosine by ~+0.03; see the flag's ROOT-CAUSE note).
        expect(corpus).toContain('news.ycombinator.com');
        expect(corpus).toContain('item');
        expect(corpus).toContain('| Hacker News');
      });
    });
  });

  describe('CLEAN (flag ON): title only, host/path dropped, site suffix stripped', () => {
    it('drops news.ycombinator.com and the item path token for an HN item', () => {
      withCleanCorpus('1', () => {
        const corpus = corpusForVisitEntry(
          entry(
            'Linux security mailing list ’almost unmanageable’ | Hacker News',
            'https://news.ycombinator.com/item?id=48178692',
          ),
        );
        // Root-cause lock: the corpus must NOT carry the shared URL skeleton.
        expect(corpus).not.toContain('news.ycombinator.com');
        expect(corpus).not.toContain('ycombinator');
        // The `item` path token must be gone (it appeared only via pathTokens).
        expect(corpus.split(/\s+/u)).not.toContain('item');
        // The site-title suffix is stripped.
        expect(corpus).not.toContain('Hacker News');
        // The actual story text survives.
        expect(corpus).toBe('Linux security mailing list ’almost unmanageable’');
      });
    });

    it('leaves a NON-aggregator title + path completely intact when cleaned', () => {
      // Non-aggregator pages keep their real path/host tokens? No — the cleaner
      // drops host/path for ALL pages (they double-count the structured
      // candidate sources). But the TITLE (the topical signal) is never touched
      // for a non-aggregator, since there is no site-suffix registered.
      withCleanCorpus('1', () => {
        const corpus = corpusForVisitEntry(
          entry(
            'Understanding TCP congestion control | My Blog',
            'https://blog.example.test/networking/tcp-congestion',
          ),
        );
        // Title preserved verbatim (no aggregator suffix stripped).
        expect(corpus).toBe('Understanding TCP congestion control | My Blog');
        // Host/path skeleton dropped for everyone (this is option B in the design).
        expect(corpus).not.toContain('blog.example.test');
        expect(corpus).not.toContain('networking');
      });
    });

    it('cleanCorpusText is the pure helper the pipeline uses', () => {
      withCleanCorpus('1', () => {
        expect(
          cleanCorpusText('Five Years of Tinygrad | Hacker News', 'https://news.ycombinator.com/item?id=1'),
        ).toBe('Five Years of Tinygrad');
      });
      withCleanCorpus(undefined, () => {
        expect(
          cleanCorpusText('Five Years of Tinygrad | Hacker News', 'https://news.ycombinator.com/item?id=1'),
        ).toContain('news.ycombinator.com');
      });
    });
  });

  describe('corpus-config signature (the propagation driver — findings B4/B5/B6)', () => {
    it('is the frozen `legacy-skeleton|title-corpus` when the flag is OFF (default byte-identity)', () => {
      withCleanCorpus(undefined, () => {
        expect(similarityCorpusConfigSignature()).toBe('legacy-skeleton|title-corpus');
      });
    });

    it('CHANGES when the clean-corpus flag flips ON — this is what the materializer compares to fire the reset', () => {
      withCleanCorpus('1', () => {
        expect(similarityCorpusConfigSignature()).toBe('clean-title-only|title-corpus');
      });
    });

    it('a flip produces a DIFFERENT signature (off !== on), so the durable compare detects the config change', () => {
      let off: string;
      let on: string;
      withCleanCorpus(undefined, () => {
        off = similarityCorpusConfigSignature();
      });
      withCleanCorpus('1', () => {
        on = similarityCorpusConfigSignature();
      });
      expect(off!).not.toBe(on!);
    });
  });
});
