import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildExtractedPageEvidence } from '../page-evidence/extract.js';
import type { PageEvidenceExtractedRequest, VectorRef } from '../page-evidence/types.js';
import {
  buildVisitSimilarity,
  corpusForVisitEntry,
  similarityContentCorpusEnabled,
  type VisitSimilarityEmbedder,
  type VisitSimilarityEntry,
} from './visitSimilarity.js';

const FLAG = 'SIDETRACK_SIMILARITY_CONTENT_CORPUS';
const previous: string | undefined = process.env[FLAG];

afterEach(() => {
  if (previous === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previous;
});

const unit = (values: readonly number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Float32Array.from(values.map((value) => value / norm));
};

const visit = (key: string): VisitSimilarityEntry => {
  const url = `https://example.test/${key}`;
  return {
    id: url,
    firstSeenAt: '2026-05-07T10:00:00.000Z',
    lastSeenAt: '2026-05-07T10:00:00.000Z',
    url,
    canonicalUrl: url,
    title: `visit-${key}`,
    provider: 'generic',
    visitCount: 1,
    dimensions: { engagement: { focusedWindowMs: 10_000 } },
  } as VisitSimilarityEntry;
};

const vectorRef = (vectorId: string): VectorRef => ({
  vectorId,
  modelId: 'test-e5',
  modelVersion: 'rev-a',
  dimensions: 2,
});

const evidencePayload = (input: {
  readonly canonicalUrl: string;
  readonly title: string;
  readonly text: string;
}): PageEvidenceExtractedRequest => ({
  payloadVersion: 1,
  canonicalUrl: input.canonicalUrl,
  url: input.canonicalUrl,
  title: input.title,
  extractedAt: '2026-05-16T10:00:00.000Z',
  extractionSource: 'reader-mode',
  extractionPolicy: { trigger: 'attention-gate' },
  quality: 'high',
  qualitySignals: {
    extractedWordCount: 300,
    contentToDomRatio: 0.7,
    boilerplateFraction: 0.05,
    extractionStrategy: 'reader-mode',
  },
  content: {
    text: input.text,
    contentHash: `hash-${input.title.toLowerCase()}`,
    charCount: input.text.length,
  },
  storageMode: 'features_only',
});

const embedFromVectors =
  (vectors: ReadonlyMap<string, Float32Array>): VisitSimilarityEmbedder =>
  async (texts) =>
    texts.map((text) => {
      const corpus = text.replace(/^(?:passage|query):\s+/u, '');
      const key = corpus.split(/\s+/u)[0] ?? '';
      const vector = vectors.get(key);
      if (vector === undefined) throw new Error(`missing vector for ${key}`);
      return vector;
    });

describe('similarityContentCorpusEnabled', () => {
  it('defaults OFF (frozen title-only baseline until the eval verdict clears it)', () => {
    delete process.env[FLAG];
    expect(similarityContentCorpusEnabled()).toBe(false);
    process.env[FLAG] = '0';
    expect(similarityContentCorpusEnabled()).toBe(false);
    process.env[FLAG] = 'true';
    expect(similarityContentCorpusEnabled()).toBe(false);
    process.env[FLAG] = '1';
    expect(similarityContentCorpusEnabled()).toBe(true);
  });
});

describe('corpusForVisitEntry content gate', () => {
  const entry = visit('alpha');
  const evidence = buildExtractedPageEvidence(
    evidencePayload({
      canonicalUrl: entry.canonicalUrl ?? entry.url,
      title: 'alpha',
      text: 'distinctive corpus body about photonics lattice waveguides '.repeat(10),
    }),
    undefined,
    { docEmbeddingRef: vectorRef('vec-alpha') },
  );
  const evidenceByCanonicalUrl = new Map([[evidence.canonicalUrl, evidence]]);

  it('OFF: returns the title/host/path skeleton, ignoring loaded content', () => {
    delete process.env[FLAG];
    const corpus = corpusForVisitEntry(entry, evidenceByCanonicalUrl);
    expect(corpus).not.toContain('photonics');
    expect(corpus).toContain('visit-alpha');
    expect(corpus).toContain('example.test');
  });

  it('ON: draws the corpus from loaded page-evidence content', () => {
    process.env[FLAG] = '1';
    const corpus = corpusForVisitEntry(entry, evidenceByCanonicalUrl);
    expect(corpus).toContain('photonics');
  });

  it('ON with no loaded evidence still falls back to the skeleton', () => {
    process.env[FLAG] = '1';
    const corpus = corpusForVisitEntry(entry, new Map());
    expect(corpus).toContain('visit-alpha');
    expect(corpus).not.toContain('photonics');
  });
});

describe('content channels gate end-to-end (drives evidence-tier stamping)', () => {
  const buildPair = async () => {
    const alpha = visit('alpha');
    const bravo = visit('bravo');
    const evidenceAlpha = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: alpha.canonicalUrl ?? alpha.url,
        title: 'alpha',
        text: 'Minipack F16 data center fabric 100G networking switch design '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-alpha') },
    );
    const evidenceBravo = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: bravo.canonicalUrl ?? bravo.url,
        title: 'bravo',
        text: 'Minipack F16 network fabric data center switch architecture '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-bravo') },
    );
    return buildVisitSimilarity(
      [alpha, bravo],
      embedFromVectors(
        // Keyed on the corpus's first token, which differs by gate: the
        // content corpus starts with 'Minipack'/… (title-prefixed body),
        // the title-only skeleton starts with 'visit-alpha'/'visit-bravo'.
        // Supply both so the embed resolves under either gate.
        new Map<string, Float32Array>([
          ['alpha', unit([1, 0])],
          ['bravo', unit([0, 1])],
          // Title-only skeleton keys: give both the same vector so a
          // behavior-cosine edge still forms under the OFF gate — that
          // edge must be metadata-only (no content channels).
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', unit([1, 0])],
        ]),
      ),
      {
        threshold: 0.5,
        evidenceByCanonicalUrl: new Map([
          [evidenceAlpha.canonicalUrl, evidenceAlpha],
          [evidenceBravo.canonicalUrl, evidenceBravo],
        ]),
        evidenceVectorsByVectorId: new Map([
          ['vec-alpha', unit([1, 0])],
          ['vec-bravo', unit([1, 0])],
        ]),
      },
    );
  };

  it('OFF: edge carries no page-evidence metadata (frozen title-only tier)', async () => {
    delete process.env[FLAG];
    const revision = await buildPair();
    const edge = revision.edges[0];
    // A behavior-cosine edge still forms, but with evidence invisible to
    // the similarity path it carries NO page-evidence metadata at all —
    // snapshot.ts stamps this as 'title_only'. No content channels leak.
    expect(edge).toBeDefined();
    expect(edge?.metadata).toBeUndefined();
  });

  it('ON: pair emits the contentVector channel that stamps content_vector tier', async () => {
    process.env[FLAG] = '1';
    const revision = await buildPair();
    const edge = revision.edges[0];
    expect(edge?.metadata?.producer).toBe('content-enriched');
    // The channel presence is what snapshot.ts evidenceTierForSimilarityMetadata
    // reads to stamp 'content_vector' — the M4 tier-plumbing (task 4).
    expect(typeof edge?.metadata?.channels.contentVector).toBe('number');
    expect(edge?.metadata?.channels.contentVector ?? 0).toBeGreaterThan(0);
  });
});
