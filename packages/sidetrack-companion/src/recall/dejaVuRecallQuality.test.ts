// Déjà-vu recall-quality regression suite.
//
// Goldens captured from the 2026-05-24 dogfood case study: a user
// selects "Claude is not your architect. Stop letting it pretend
// (hollandtech.net)" on Hacker News and expects prior visits to the
// HN thread, kanbots.dev, red.anthropic.com/2026/cvd to surface as
// recall candidates — instead the popover returned three software-
// architecture pages (Meta data-center, codeutopia metaphors,
// r/networking) that lexically matched "architect → architecture",
// then padded the Similar tier with pages cosine-close to THOSE
// off-topic anchors.
//
// The bug had two layers: (a) `semanticRecallExpansion` anchored on
// the lexical hits' canonical URLs rather than the query text, so
// when lexical drifted the semantic tier amplified the drift; and
// (b) `buildDejaVuHits` sorted by raw score across tiers that aren't
// score-comparable (BM25 5-30 vs cosine 0-0.49). This file is the
// regression net for the fix — it MUST keep passing as we tune.

import { describe, expect, it } from 'vitest';

import {
  expandSemanticByQuery,
  expandSemanticRecallCandidates,
  type SemanticRecallPool,
} from './semanticRecallPool.js';

// Synthetic 3-D embedding space — three orthogonal "topic axes":
//   axis 0 = AI / agent / Claude / architect-as-role
//   axis 1 = software-architecture / design
//   axis 2 = networking / data-center
//
// Documents are placed at known coordinates so cosine ordering is
// deterministic and easy to read.
const VEC = {
  // Documents the user EXPECTS to surface (axis 0 dominant):
  'https://news.ycombinator.com/item?id=48259784': [0.95, 0.1, 0.05],
  'https://www.kanbots.dev/': [0.9, 0.2, 0.05],
  'https://red.anthropic.com/2026/cvd/': [0.85, 0.15, 0.1],
  // Documents the OLD popover ranked first (axis 1/2 dominant —
  // they hit the lexical 'architecture' fuzzy match):
  'https://engineering.fb.com/data-center-network/': [0.05, 0.2, 0.95],
  'https://codeutopia.net/metaphors/': [0.1, 0.85, 0.2],
  'https://reddit.com/r/networking/fb-data-center/': [0.1, 0.25, 0.9],
  // True noise — should never surface:
  'https://example.com/random-tutorial/': [0.0, 0.0, 0.1],
} satisfies Record<string, readonly number[]>;

const vec = (key: keyof typeof VEC): Float32Array => Float32Array.from(VEC[key]);

const vectorStore = new Map<string, Float32Array>(
  Object.keys(VEC).map((u) => [u, vec(u as keyof typeof VEC)]),
);

describe('Déjà-vu recall quality — case study 2026-05-24', () => {
  describe('expandSemanticByQuery (P0: query-anchored semantic recall)', () => {
    it('ranks expected docs ABOVE off-topic ones when the query embeds on the AI/agent axis', () => {
      // Query that semantically lives on axis 0 (AI/agent role) — the
      // intent the user actually expressed by selecting the HN title.
      const queryEmbedding = Float32Array.from([0.95, 0.1, 0.05]);
      const hits = expandSemanticByQuery(vectorStore, queryEmbedding, { limit: 5 });
      const urls = hits.map((h) => h.canonicalUrl);
      // Top 3 must be the expected docs in some order.
      expect(urls.slice(0, 3).sort()).toEqual(
        [
          'https://news.ycombinator.com/item?id=48259784',
          'https://red.anthropic.com/2026/cvd/',
          'https://www.kanbots.dev/',
        ].sort(),
      );
      // The off-topic Meta/codeutopia/r-networking docs must NOT be
      // in the top 3. (Old anchor-anchored expansion had them at
      // ranks 1-3 because lexical 'architect' fuzzy-matched them.)
      const off = new Set([
        'https://engineering.fb.com/data-center-network/',
        'https://codeutopia.net/metaphors/',
        'https://reddit.com/r/networking/fb-data-center/',
      ]);
      for (const url of urls.slice(0, 3)) {
        expect(off.has(url)).toBe(false);
      }
    });

    it('excludes URLs the caller already has (e.g. lexical primary hits)', () => {
      const queryEmbedding = Float32Array.from([0.95, 0.1, 0.05]);
      const exclude = new Set(['https://news.ycombinator.com/item?id=48259784']);
      const hits = expandSemanticByQuery(vectorStore, queryEmbedding, { limit: 3, exclude });
      expect(hits.find((h) => h.canonicalUrl === 'https://news.ycombinator.com/item?id=48259784'))
        .toBeUndefined();
    });

    it('returns [] when the vector store is empty or null (graceful degrade)', () => {
      const q = Float32Array.from([1, 0, 0]);
      expect(expandSemanticByQuery(null, q)).toEqual([]);
      expect(expandSemanticByQuery(new Map<string, Float32Array>(), q)).toEqual([]);
    });

    it('returns hits with stable ordering (cosine desc, then URL asc on ties)', () => {
      // Two docs at the same cosine — deterministic tiebreak by URL.
      const vecs = new Map<string, Float32Array>([
        ['https://a.test/', Float32Array.from([1, 0, 0])],
        ['https://b.test/', Float32Array.from([1, 0, 0])],
        ['https://c.test/', Float32Array.from([0.5, 0.5, 0])],
      ]);
      const queryEmbedding = Float32Array.from([1, 0, 0]);
      const hits = expandSemanticByQuery(vecs, queryEmbedding);
      // a < b alphabetically, both before c.
      expect(hits.map((h) => h.canonicalUrl)).toEqual([
        'https://a.test/',
        'https://b.test/',
        'https://c.test/',
      ]);
    });
  });

  describe('contrast: anchor-anchored expansion (the OLD path, kept for back-compat)', () => {
    it('compounds drift when anchors are off-topic', () => {
      // Simulate the dogfood failure: the lexical primary returned
      // Meta data-center. The anchor-anchored expansion would then
      // find pages clustered near it — r/networking (axis-2 neighbor)
      // — instead of finding pages near the user's query intent.
      const pool: SemanticRecallPool = {
        signature: 'test',
        modelId: 'e5-test',
        featureVersion: 1,
        producedAtMs: 0,
        entryCount: 3,
        clusterCount: 1,
        byUrl: {
          'https://engineering.fb.com/data-center-network/': {
            canonicalUrl: 'https://engineering.fb.com/data-center-network/',
            // Pre-clustered with r/networking as a same-cluster neighbour.
            clusterId: 'c-networking',
            neighbors: [
              {
                canonicalUrl: 'https://reddit.com/r/networking/fb-data-center/',
                cosine: 0.92,
              },
            ],
            textHash: 'h1',
          },
          'https://reddit.com/r/networking/fb-data-center/': {
            canonicalUrl: 'https://reddit.com/r/networking/fb-data-center/',
            clusterId: 'c-networking',
            neighbors: [],
            textHash: 'h2',
          },
          // The user's expected match exists in the pool but ISN'T
          // a neighbour of the lexical-primary anchor — the old path
          // can't reach it.
          'https://www.kanbots.dev/': {
            canonicalUrl: 'https://www.kanbots.dev/',
            clusterId: 'c-ai',
            neighbors: [],
            textHash: 'h3',
          },
        },
      };
      const anchors = ['https://engineering.fb.com/data-center-network/'];
      const oldExpansion = expandSemanticRecallCandidates(pool, anchors, { limit: 5 });
      const oldUrls = oldExpansion.map((h) => h.canonicalUrl);
      // OLD path surfaces r/networking (same-cluster neighbour) but
      // NOT kanbots.dev — confirming the design bug the new
      // expandSemanticByQuery fixes.
      expect(oldUrls).toContain('https://reddit.com/r/networking/fb-data-center/');
      expect(oldUrls).not.toContain('https://www.kanbots.dev/');
    });
  });
});
