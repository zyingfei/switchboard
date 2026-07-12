import { describe, expect, it } from 'vitest';

import {
  BM25_B,
  BM25_K1,
  bm25Scores,
  documentFromEvidence,
  recencyScores,
  tokenize,
  type CandidateDocument,
} from './lexicalBaseline.js';

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops 1-char noise', () => {
    expect(tokenize('Postgres MERGE write-skew a b2')).toEqual([
      'postgres',
      'merge',
      'write',
      'skew',
      'b2',
    ]);
  });
});

describe('bm25Scores', () => {
  // Hand-computable BM25 over a 2-candidate impression. Query = ["merge"].
  //   docA tokens: ["merge","merge","lock"]  (tf_merge = 2, dl = 3)
  //   docB tokens: ["invoice","aging"]        (tf_merge = 0, dl = 2)
  // n = 2, avgdl = (3 + 2) / 2 = 2.5.
  // df_merge = 1 (only docA has "merge").
  //   idf = max(0, ln((2 - 1 + 0.5) / (1 + 0.5) + 1))
  //       = ln(1.5/1.5 + 1) = ln(2) = 0.6931471805599453
  // docA score:
  //   denom = tf + k1*(1 - b + b*dl/avgdl)
  //         = 2 + 1.5*(1 - 0.75 + 0.75*3/2.5)
  //         = 2 + 1.5*(0.25 + 0.9) = 2 + 1.5*1.15 = 2 + 1.725 = 3.725
  //   score = idf * (tf*(k1+1))/denom = 0.6931471805599453 * (2*2.5)/3.725
  //         = 0.6931471805599453 * (5/3.725)
  //         = 0.6931471805599453 * 1.3422818791946308 = 0.930399...
  // docB score = 0 (no "merge").
  const docA: CandidateDocument = { entityId: 'a', tokens: ['merge', 'merge', 'lock'] };
  const docB: CandidateDocument = { entityId: 'b', tokens: ['invoice', 'aging'] };
  const documents = new Map([
    ['a', docA],
    ['b', docB],
  ]);

  it('scores the term-bearing candidate above the empty one, matching the hand computation', () => {
    const scores = bm25Scores(['merge'], ['a', 'b'], documents);
    const idf = Math.log(2);
    const denomA = 2 + BM25_K1 * (1 - BM25_B + (BM25_B * 3) / 2.5);
    const expectedA = idf * ((2 * (BM25_K1 + 1)) / denomA);
    expect(scores.get('a')).toBeCloseTo(expectedA, 10);
    expect(scores.get('b')).toBe(0);
    expect(scores.get('a')!).toBeGreaterThan(scores.get('b')!);
  });

  it('gives a candidate with no vault document a zero score (honest floor)', () => {
    const scores = bm25Scores(['merge'], ['a', 'missing'], documents);
    expect(scores.get('missing')).toBe(0);
  });

  it('gives EQUAL scores (no ranking signal) to a term present in every candidate', () => {
    // Both docs contain "shared" once (same dl) → df = n = 2 → equal BM25+
    // IDF, equal tf, equal length ⇒ identical scores ⇒ no ranking signal.
    const docs = new Map<string, CandidateDocument>([
      ['a', { entityId: 'a', tokens: ['shared'] }],
      ['b', { entityId: 'b', tokens: ['shared'] }],
    ]);
    const scores = bm25Scores(['shared'], ['a', 'b'], docs);
    expect(scores.get('a')).toBe(scores.get('b'));
  });
});

describe('recencyScores', () => {
  it('ranks by freshest timestamp; undated candidates fall to -Infinity', () => {
    const documents = new Map<string, CandidateDocument>([
      ['fresh', { entityId: 'fresh', tokens: [], updatedAtMs: 2000 }],
      ['stale', { entityId: 'stale', tokens: [], updatedAtMs: 1000 }],
      ['undated', { entityId: 'undated', tokens: [] }],
    ]);
    const scores = recencyScores(['fresh', 'stale', 'undated'], documents);
    expect(scores.get('fresh')).toBe(2000);
    expect(scores.get('stale')).toBe(1000);
    expect(scores.get('undated')).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('documentFromEvidence', () => {
  it('unions title + content terms + url path tokens; prefers lastSeenAt for recency', () => {
    const doc = documentFromEvidence('e1', 'https://host.test/postgres/merge', {
      schemaVersion: 1,
      canonicalUrl: 'https://host.test/postgres/merge',
      semanticFeatureRevision: 'r',
      behaviorMetadataRevision: 'r',
      evidenceRevision: 'r',
      updatedAt: '2026-01-01T00:00:00.000Z',
      evidenceTier: 'metadata_only',
      versions: {} as never,
      metadata: {
        title: 'Merge Concurrency',
        host: 'host.test',
        pathTokens: [],
        titleTokens: [],
        lastSeenAt: '2026-05-01T00:00:00.000Z',
      },
      content: {
        contentHash: 'h',
        extractionSource: 'reader-mode',
        quality: 'high',
        qualitySignals: {} as never,
        terms: [{ term: 'writeskew', normalized: 'writeskew', weight: 1, source: 'body' }],
        keyphrases: [],
        entities: [],
      },
      provenance: { sources: [] },
    });
    expect(doc.tokens).toContain('merge');
    expect(doc.tokens).toContain('concurrency');
    expect(doc.tokens).toContain('writeskew');
    expect(doc.tokens).toContain('postgres');
    // lastSeenAt (browsing recency) wins over updatedAt (evidence write time).
    expect(doc.updatedAtMs).toBe(Date.parse('2026-05-01T00:00:00.000Z'));
  });
});
