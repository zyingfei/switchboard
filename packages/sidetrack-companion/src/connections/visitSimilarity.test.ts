import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildExtractedPageEvidence } from '../page-evidence/extract.js';
import type { PageEvidenceExtractedRequest, VectorRef } from '../page-evidence/types.js';
import { createEmptyTabSessionProjection } from '../tabsession/projection.js';
import { buildConnectionsSnapshot } from './snapshot.js';
import {
  buildVisitSimilarity,
  resolveVisitSimilarityConfig,
  type VisitSimilarityEmbedder,
  type VisitSimilarityEntry,
} from './visitSimilarity.js';

const unit = (values: readonly number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Float32Array.from(values.map((value) => value / norm));
};

const vectorAtCosine = (cosine: number): Float32Array =>
  unit([cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine))]);

const visit = (
  key: string,
  overrides: {
    readonly focusedWindowMs?: number;
    readonly lastSeenAt?: string;
  } = {},
): VisitSimilarityEntry => {
  const url = `https://example.test/${key}`;
  return {
    id: url,
    firstSeenAt: '2026-05-07T10:00:00.000Z',
    lastSeenAt: overrides.lastSeenAt ?? '2026-05-07T10:00:00.000Z',
    url,
    canonicalUrl: url,
    title: `visit-${key}`,
    provider: 'generic',
    visitCount: 1,
    dimensions: {
      engagement: {
        focusedWindowMs: overrides.focusedWindowMs ?? 10_000,
      },
    },
  };
};

const keyFromEmbeddingText = (text: string): string => {
  const corpus = text.replace(/^(?:passage|query):\s+/u, '');
  return corpus.split(/\s+/u)[0] ?? '';
};

const embedFromVectors =
  (vectors: ReadonlyMap<string, Float32Array>): VisitSimilarityEmbedder =>
  async (texts) =>
    texts.map((text) => {
      const key = keyFromEmbeddingText(text);
      const vector = vectors.get(key);
      if (vector === undefined) {
        throw new Error(`missing vector for ${key}`);
      }
      return vector;
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

const vectorRef = (vectorId: string, overrides: Partial<VectorRef> = {}): VectorRef => ({
  vectorId,
  modelId: 'test-e5',
  modelVersion: 'rev-a',
  dimensions: 2,
  ...overrides,
});

const withoutProducedAt = (revision: Awaited<ReturnType<typeof buildVisitSimilarity>>) => {
  const { producedAt: _producedAt, ...rest } = revision;
  return rest;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

interface VisitSimilarityFixture {
  readonly entries: readonly VisitSimilarityEntry[];
  readonly vectors: ReadonlyMap<string, Float32Array>;
  readonly expectedEdges: readonly {
    readonly fromVisitKey: string;
    readonly toVisitKey: string;
    readonly cosine: number;
  }[];
}

const readVisitSimilarityFixture = async (filename: string): Promise<VisitSimilarityFixture> => {
  const raw = await readFile(new URL(`./__fixtures__/${filename}`, import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed['entries']) || !isRecord(parsed['vectors'])) {
    throw new Error(`invalid visit similarity fixture: ${filename}`);
  }

  const entries = parsed['entries'].map((entry): VisitSimilarityEntry => {
    if (!isRecord(entry) || typeof entry['key'] !== 'string') {
      throw new Error(`invalid visit similarity entry in ${filename}`);
    }
    const focusedWindowMs = entry['focusedWindowMs'];
    const lastSeenAt = entry['lastSeenAt'];
    return visit(entry['key'], {
      ...(isFiniteNumber(focusedWindowMs) ? { focusedWindowMs } : {}),
      ...(typeof lastSeenAt === 'string' ? { lastSeenAt } : {}),
    });
  });

  const vectors = new Map<string, Float32Array>();
  for (const [key, rawVector] of Object.entries(parsed['vectors'])) {
    if (!Array.isArray(rawVector) || !rawVector.every(isFiniteNumber)) {
      throw new Error(`invalid vector for ${key} in ${filename}`);
    }
    vectors.set(key, unit(rawVector));
  }

  const expectedEdges = parsed['expectedEdges'];
  if (!Array.isArray(expectedEdges)) {
    throw new Error(`invalid expected edges in ${filename}`);
  }
  return {
    entries,
    vectors,
    expectedEdges: expectedEdges.map((edge) => {
      if (
        !isRecord(edge) ||
        typeof edge['fromVisitKey'] !== 'string' ||
        typeof edge['toVisitKey'] !== 'string' ||
        !isFiniteNumber(edge['cosine'])
      ) {
        throw new Error(`invalid expected edge in ${filename}`);
      }
      return {
        fromVisitKey: edge['fromVisitKey'],
        toVisitKey: edge['toVisitKey'],
        cosine: edge['cosine'],
      };
    }),
  };
};

// These suites assert the content-enriched similarity CAPABILITY (the
// evidence corpus + content-vector channels). That path is gated behind
// SIDETRACK_SIMILARITY_CONTENT_CORPUS (default OFF in production until the
// eval-spine verdict clears it — see ADR-0011 amendment 2026-07-12b). Turn
// the gate ON for these unit tests so they exercise the mechanism; the
// default-OFF frozen behavior is asserted separately in
// similarityContentCorpus.test.ts.
const previousContentCorpusFlag: string | undefined =
  process.env['SIDETRACK_SIMILARITY_CONTENT_CORPUS'];
beforeEach(() => {
  process.env['SIDETRACK_SIMILARITY_CONTENT_CORPUS'] = '1';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousContentCorpusFlag === undefined) {
    delete process.env['SIDETRACK_SIMILARITY_CONTENT_CORPUS'];
  } else {
    process.env['SIDETRACK_SIMILARITY_CONTENT_CORPUS'] = previousContentCorpusFlag;
  }
});

describe('buildVisitSimilarity', () => {
  it('matches the documented basic fixture', async () => {
    const fixture = await readVisitSimilarityFixture('visitSimilarity-basic.json');

    const revision = await buildVisitSimilarity(fixture.entries, embedFromVectors(fixture.vectors));

    expect(revision.edges).toEqual(fixture.expectedEdges);
  });

  it('matches the documented engagement-gate fixture', async () => {
    const fixture = await readVisitSimilarityFixture('visitSimilarity-engagement-gate.json');

    const revision = await buildVisitSimilarity(fixture.entries, embedFromVectors(fixture.vectors));

    expect(revision.edges).toEqual(fixture.expectedEdges);
  });

  it('is deterministic for the same input excluding producedAt', async () => {
    const entries = [visit('alpha'), visit('bravo'), visit('charlie')];
    const vectors = new Map<string, Float32Array>([
      ['visit-alpha', unit([1, 0])],
      ['visit-bravo', unit([1, 0])],
      ['visit-charlie', unit([0, 1])],
    ]);
    const embed = embedFromVectors(vectors);

    const first = await buildVisitSimilarity(entries, embed);
    const second = await buildVisitSimilarity(entries, embed);

    expect(JSON.stringify(withoutProducedAt(first))).toBe(
      JSON.stringify(withoutProducedAt(second)),
    );
    expect(first.edges).toEqual([
      {
        fromVisitKey: 'https://example.test/alpha',
        toVisitKey: 'https://example.test/bravo',
        cosine: 1,
      },
    ]);
  });

  it('is order-insensitive', async () => {
    const entries = [visit('alpha'), visit('bravo'), visit('charlie')];
    const vectors = new Map<string, Float32Array>([
      ['visit-alpha', unit([1, 0])],
      ['visit-bravo', unit([1, 0])],
      ['visit-charlie', unit([0, 1])],
    ]);
    const embed = embedFromVectors(vectors);

    const forward = await buildVisitSimilarity(entries, embed);
    const shuffled = await buildVisitSimilarity([entries[2]!, entries[0]!, entries[1]!], embed);

    expect(JSON.stringify(withoutProducedAt(forward))).toBe(
      JSON.stringify(withoutProducedAt(shuffled)),
    );
  });

  it('applies the threshold boundary', async () => {
    const below = await buildVisitSimilarity(
      [visit('alpha'), visit('bravo')],
      embedFromVectors(
        new Map<string, Float32Array>([
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', vectorAtCosine(0.849)],
        ]),
      ),
    );
    expect(below.edges).toEqual([]);

    const above = await buildVisitSimilarity(
      [visit('alpha'), visit('bravo')],
      embedFromVectors(
        new Map<string, Float32Array>([
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', vectorAtCosine(0.851)],
        ]),
      ),
    );
    expect(above.edges).toHaveLength(1);
    expect(above.edges[0]?.cosine).toBeCloseTo(0.851, 6);
  });

  it('emits content-enriched metadata with compatible doc-vector support', async () => {
    const alpha = visit('alpha');
    const bravo = visit('bravo');
    const evidenceAlpha = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: alpha.canonicalUrl!,
        title: 'alpha',
        text: 'F16 Minipack data center fabric 100G networking switch design '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-alpha') },
    );
    const evidenceBravo = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: bravo.canonicalUrl!,
        title: 'bravo',
        text: 'Minipack F16 network fabric data center switch architecture '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-bravo') },
    );

    const revision = await buildVisitSimilarity(
      [alpha, bravo],
      embedFromVectors(
        new Map<string, Float32Array>([
          ['alpha', unit([1, 0])],
          ['bravo', unit([0, 1])],
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

    expect(revision.edges).toHaveLength(1);
    expect(revision.edges[0]?.metadata).toMatchObject({
      producer: 'content-enriched',
      channels: { contentVector: 1 },
    });
    expect(revision.edges[0]?.metadata?.matchedTerms).toContain('Minipack');
  });

  it('reports indexed chunk support on content-enriched edges', async () => {
    const alpha = visit('alpha');
    const bravo = visit('bravo');
    const evidenceAlpha = buildExtractedPageEvidence({
      ...evidencePayload({
        canonicalUrl: alpha.canonicalUrl!,
        title: 'alpha',
        text: 'F16 Minipack data center fabric 100G network switch '.repeat(20),
      }),
      storageMode: 'indexed_chunks',
    });
    const evidenceBravo = buildExtractedPageEvidence({
      ...evidencePayload({
        canonicalUrl: bravo.canonicalUrl!,
        title: 'bravo',
        text: 'Minipack F16 data center fabric 100G switch architecture '.repeat(20),
      }),
      storageMode: 'indexed_chunks',
    });

    const revision = await buildVisitSimilarity(
      [alpha, bravo],
      embedFromVectors(
        new Map<string, Float32Array>([
          ['alpha', unit([1, 0])],
          ['bravo', unit([0, 1])],
        ]),
      ),
      {
        threshold: 0.3,
        evidenceByCanonicalUrl: new Map([
          [evidenceAlpha.canonicalUrl, evidenceAlpha],
          [evidenceBravo.canonicalUrl, evidenceBravo],
        ]),
        pageContentChunksByCanonicalUrl: new Map([
          [
            evidenceAlpha.canonicalUrl,
            [{ terms: evidenceAlpha.content?.terms.slice(0, 8) ?? [], qualityWeight: 1 }],
          ],
          [
            evidenceBravo.canonicalUrl,
            [{ terms: evidenceBravo.content?.terms.slice(0, 8) ?? [], qualityWeight: 1 }],
          ],
        ]),
      },
    );

    expect(revision.edges).toHaveLength(1);
    expect(revision.edges[0]?.metadata?.channels.chunkSupport).toBeGreaterThan(0);
    expect(revision.edges[0]?.metadata?.chunkSupportCount).toBeGreaterThan(0);
    expect(revision.edges[0]?.metadata?.maxChunkPairScore).toBeGreaterThan(0);
  });

  it('skips the content-vector channel for incompatible doc-vector refs', async () => {
    const alpha = visit('alpha');
    const bravo = visit('bravo');
    const evidenceAlpha = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: alpha.canonicalUrl!,
        title: 'alpha',
        text: 'F16 Minipack data center fabric 100G networking switch design '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-alpha') },
    );
    const evidenceBravo = buildExtractedPageEvidence(
      evidencePayload({
        canonicalUrl: bravo.canonicalUrl!,
        title: 'bravo',
        text: 'Minipack F16 network fabric data center switch architecture '.repeat(20),
      }),
      undefined,
      { docEmbeddingRef: vectorRef('vec-bravo', { modelVersion: 'rev-b' }) },
    );

    const revision = await buildVisitSimilarity(
      [alpha, bravo],
      embedFromVectors(
        new Map<string, Float32Array>([
          ['alpha', unit([1, 0])],
          ['bravo', unit([1, 0])],
        ]),
      ),
      {
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

    expect(revision.edges[0]?.metadata?.channels.contentVector).toBeUndefined();
    expect(revision.edges[0]?.metadata?.channels.contentTerms).toBeGreaterThan(0);
  });

  it('requires both endpoints to pass the engagement gate', async () => {
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['visit-alpha', unit([1, 0])],
        ['visit-bravo', unit([1, 0])],
      ]),
    );

    const belowGate = await buildVisitSimilarity(
      [visit('alpha', { focusedWindowMs: 10_000 }), visit('bravo', { focusedWindowMs: 4_999 })],
      embed,
    );
    expect(belowGate.edges).toEqual([]);

    const atGate = await buildVisitSimilarity(
      [visit('alpha', { focusedWindowMs: 10_000 }), visit('bravo', { focusedWindowMs: 5_000 })],
      embed,
    );
    expect(atGate.edges).toHaveLength(1);
  });

  it('returns an empty-edge revision and leaves snapshot build usable when embed throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const entries = [visit('alpha'), visit('bravo')];
    const revision = await buildVisitSimilarity(
      entries,
      async () => {
        throw new Error('model cache empty');
      },
      // Stage 5 / T2: this test pins the original "embedder unavailable
      // ⇒ no edges" contract by explicitly disabling the lexical
      // fallback. Lexical-fallback behavior is covered separately.
      { lexicalFallbackEnabled: false },
    );

    expect(revision.edges).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[materializer-error] visit-similarity embed failed: model cache empty',
      ),
    );

    const snapshot = buildConnectionsSnapshot({
      events: [],
      threads: [],
      workstreams: [],
      dispatches: [],
      queueItems: [],
      reminders: [],
      codingSessions: [],
      timelineDays: [
        {
          date: '2026-05-07',
          entries,
          updatedAt: '2026-05-07T10:00:00.000Z',
          entryCount: entries.length,
        },
      ],
      tabSessionProjection: createEmptyTabSessionProjection(),
      visitSimilarity: revision,
    });
    expect(snapshot.nodes.map((node) => node.id)).toContain(
      'timeline-visit:https://example.test/alpha',
    );
    expect(snapshot.edges.find((edge) => edge.kind === 'visit_resembles_visit')).toBeUndefined();
  });

  it('does not emit a candidate below the top-K cutoff even when it clears threshold', async () => {
    // Determinism note (was an order-dependent CI flake): every visit here
    // shares the `example.test` host token, so the hybrid ranker's lexical
    // (BM25) fusion arm scored all 60 candidates identically — a 60-way tie
    // that the FUSION_WINDOW=50 slice cut arbitrarily. Which side of that
    // tie b-51 landed on (and therefore whether it acquired a lexical RRF
    // rank and displaced b-50 at the final top-K) depended on MiniSearch's
    // iteration order over the tied block, which is not stable across the
    // process history a bare `bun test` run accumulates — the flake.
    //
    // Fix: give the intended in-window candidates (and the source) a shared
    // `anchortopic` token the below-cutoff candidates lack, so the lexical
    // arm scores the in-window set strictly above the below-cutoff set. The
    // boundary between b-50 and b-51 is now genuinely untied on BOTH arms,
    // so no tie-iteration order can resurrect a below-cutoff candidate. The
    // assertion (top-K cutoff, not threshold, excludes b-51) is unchanged.
    const inWindowVisit = (key: string): VisitSimilarityEntry => ({
      ...visit(key),
      title: `visit-${key} anchortopic`,
    });
    const source = inWindowVisit('a');
    const candidates: VisitSimilarityEntry[] = [];
    const vectors = new Map<string, Float32Array>([['visit-a', unit([1, 0])]]);
    for (let index = 1; index <= 60; index += 1) {
      const key = `b-${String(index).padStart(2, '0')}`;
      candidates.push(index <= 50 ? inWindowVisit(key) : visit(key));
      const cosine = index <= 50 ? 0.99 - index * 0.001 : index === 51 ? 0.9 : 0.2;
      vectors.set(`visit-${key}`, vectorAtCosine(cosine));
    }

    const revision = await buildVisitSimilarity(
      [source, ...candidates],
      embedFromVectors(vectors),
      { topK: 50 },
    );

    expect(
      revision.edges.find(
        (edge) =>
          edge.fromVisitKey === 'https://example.test/a' &&
          edge.toVisitKey === 'https://example.test/b-51',
      ),
    ).toBeUndefined();
    expect(
      revision.edges.find(
        (edge) =>
          edge.fromVisitKey === 'https://example.test/a' &&
          edge.toVisitKey === 'https://example.test/b-50',
      ),
    ).toBeDefined();
  });

  it('uses passage and query prefixes for embedded corpus strings', async () => {
    const seen: string[] = [];
    await buildVisitSimilarity([visit('alpha'), visit('bravo')], async (texts) => {
      seen.push(...texts);
      return texts.map((text) => (text.includes('visit-alpha') ? unit([1, 0]) : unit([1, 0])));
    });

    expect(seen.filter((text) => text.startsWith('passage: '))).toHaveLength(2);
    expect(seen.filter((text) => text.startsWith('query: '))).toHaveLength(2);
  });

  it('tags the revision with producer="embedding" when the embedder succeeds', async () => {
    const revision = await buildVisitSimilarity(
      [visit('alpha'), visit('bravo')],
      embedFromVectors(
        new Map<string, Float32Array>([
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', unit([1, 0])],
        ]),
      ),
    );
    expect(revision.producer).toBe('embedding');
  });
});

describe('buildVisitSimilarity — Stage 5 / T2 env-driven gates', () => {
  it('lowers the cosine threshold from the env when no explicit option is supplied', async () => {
    const original = process.env['SIDETRACK_SIMILARITY_THRESHOLD'];
    process.env['SIDETRACK_SIMILARITY_THRESHOLD'] = '0.6';
    try {
      const revision = await buildVisitSimilarity(
        [visit('alpha'), visit('bravo')],
        embedFromVectors(
          new Map<string, Float32Array>([
            ['visit-alpha', unit([1, 0])],
            ['visit-bravo', vectorAtCosine(0.7)],
          ]),
        ),
      );
      expect(revision.threshold).toBeCloseTo(0.6, 6);
      expect(revision.edges).toHaveLength(1);
    } finally {
      if (original === undefined) {
        delete process.env['SIDETRACK_SIMILARITY_THRESHOLD'];
      } else {
        process.env['SIDETRACK_SIMILARITY_THRESHOLD'] = original;
      }
    }
  });

  it('lowers the engagement gate from the env when no explicit option is supplied', async () => {
    const original = process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'];
    process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = '500';
    try {
      const revision = await buildVisitSimilarity(
        [visit('alpha', { focusedWindowMs: 600 }), visit('bravo', { focusedWindowMs: 700 })],
        embedFromVectors(
          new Map<string, Float32Array>([
            ['visit-alpha', unit([1, 0])],
            ['visit-bravo', unit([1, 0])],
          ]),
        ),
      );
      expect(revision.edges).toHaveLength(1);
    } finally {
      if (original === undefined) {
        delete process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'];
      } else {
        process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = original;
      }
    }
  });

  it('uses explicit option arg in preference to the env var', async () => {
    const original = process.env['SIDETRACK_SIMILARITY_THRESHOLD'];
    process.env['SIDETRACK_SIMILARITY_THRESHOLD'] = '0.1';
    try {
      const revision = await buildVisitSimilarity(
        [visit('alpha'), visit('bravo')],
        embedFromVectors(
          new Map<string, Float32Array>([
            ['visit-alpha', unit([1, 0])],
            ['visit-bravo', vectorAtCosine(0.5)],
          ]),
        ),
        { threshold: 0.9 },
      );
      expect(revision.threshold).toBeCloseTo(0.9, 6);
      expect(revision.edges).toEqual([]);
    } finally {
      if (original === undefined) {
        delete process.env['SIDETRACK_SIMILARITY_THRESHOLD'];
      } else {
        process.env['SIDETRACK_SIMILARITY_THRESHOLD'] = original;
      }
    }
  });
});

describe('buildVisitSimilarity — Stage 5 / T2 lexical fallback', () => {
  it('falls back to Jaccard edges when the embedder throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // alpha and beta-alpha share three of four tokens ("foo bar baz") so
    // the Jaccard exceeds the default lexical threshold of 0.3.
    const a: VisitSimilarityEntry = {
      ...visit('a'),
      title: 'foo bar baz qux',
      canonicalUrl: 'https://example.test/x/a',
      url: 'https://example.test/x/a',
    };
    const b: VisitSimilarityEntry = {
      ...visit('b'),
      title: 'foo bar baz quux',
      canonicalUrl: 'https://example.test/x/b',
      url: 'https://example.test/x/b',
    };
    const revision = await buildVisitSimilarity(
      [a, b],
      () => Promise.reject(new Error('embedder offline')),
      { lexicalThreshold: 0.3 },
    );
    expect(revision.producer).toBe('lexical');
    expect(revision.edges.length).toBeGreaterThan(0);
    expect(revision.threshold).toBeCloseTo(0.3, 6);
    expect(warn).toHaveBeenCalled();
  });

  it('omits lexical edges below the lexical threshold', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // alpha and bravo share only the host ('example.test') — Jaccard < 0.3.
    const revision = await buildVisitSimilarity([visit('alpha'), visit('bravo')], () =>
      Promise.reject(new Error('embedder offline')),
    );
    expect(revision.producer).toBe('lexical');
    expect(revision.edges).toEqual([]);
  });

  it('falls back when the embedder returns the wrong number of vectors', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a: VisitSimilarityEntry = {
      ...visit('a'),
      title: 'foo bar baz qux',
      canonicalUrl: 'https://example.test/x/a',
      url: 'https://example.test/x/a',
    };
    const b: VisitSimilarityEntry = {
      ...visit('b'),
      title: 'foo bar baz quux',
      canonicalUrl: 'https://example.test/x/b',
      url: 'https://example.test/x/b',
    };
    const revision = await buildVisitSimilarity([a, b], () => Promise.resolve([unit([1, 0])]));
    expect(revision.producer).toBe('lexical');
    expect(revision.edges.length).toBeGreaterThan(0);
  });

  it('honors lexicalFallbackEnabled=false even when the embedder fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const a: VisitSimilarityEntry = {
      ...visit('a'),
      title: 'foo bar baz qux',
      canonicalUrl: 'https://example.test/x/a',
      url: 'https://example.test/x/a',
    };
    const b: VisitSimilarityEntry = {
      ...visit('b'),
      title: 'foo bar baz quux',
      canonicalUrl: 'https://example.test/x/b',
      url: 'https://example.test/x/b',
    };
    const revision = await buildVisitSimilarity(
      [a, b],
      () => Promise.reject(new Error('embedder offline')),
      { lexicalFallbackEnabled: false },
    );
    expect(revision.producer).toBe('embedding');
    expect(revision.edges).toEqual([]);
  });

  it('honors SIDETRACK_SIMILARITY_LEXICAL_FALLBACK=0 even when the embedder fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = process.env['SIDETRACK_SIMILARITY_LEXICAL_FALLBACK'];
    process.env['SIDETRACK_SIMILARITY_LEXICAL_FALLBACK'] = '0';
    try {
      const a: VisitSimilarityEntry = {
        ...visit('a'),
        title: 'foo bar baz qux',
        canonicalUrl: 'https://example.test/x/a',
        url: 'https://example.test/x/a',
      };
      const b: VisitSimilarityEntry = {
        ...visit('b'),
        title: 'foo bar baz quux',
        canonicalUrl: 'https://example.test/x/b',
        url: 'https://example.test/x/b',
      };
      const revision = await buildVisitSimilarity([a, b], () =>
        Promise.reject(new Error('embedder offline')),
      );
      expect(revision.producer).toBe('embedding');
      expect(revision.edges).toEqual([]);
    } finally {
      if (original === undefined) {
        delete process.env['SIDETRACK_SIMILARITY_LEXICAL_FALLBACK'];
      } else {
        process.env['SIDETRACK_SIMILARITY_LEXICAL_FALLBACK'] = original;
      }
    }
  });
});

describe('resolveVisitSimilarityConfig — Stage 5.0 follow-up', () => {
  it('reflects SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS in the effective gate', () => {
    const original = process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'];
    process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = '1000';
    try {
      const config = resolveVisitSimilarityConfig();
      expect(config.engagementGateMs).toBe(1_000);
    } finally {
      if (original === undefined) {
        delete process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'];
      } else {
        process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = original;
      }
    }
  });

  it('reflects every env knob and lets explicit options win', () => {
    const previous = {
      threshold: process.env['SIDETRACK_SIMILARITY_THRESHOLD'],
      topK: process.env['SIDETRACK_SIMILARITY_TOP_K'],
      gate: process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'],
      lexical: process.env['SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD'],
      fallback: process.env['SIDETRACK_SIMILARITY_LEXICAL_FALLBACK'],
    };
    process.env['SIDETRACK_SIMILARITY_THRESHOLD'] = '0.4';
    process.env['SIDETRACK_SIMILARITY_TOP_K'] = '12';
    process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = '750';
    process.env['SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD'] = '0.18';
    process.env['SIDETRACK_SIMILARITY_LEXICAL_FALLBACK'] = '0';
    try {
      const fromEnv = resolveVisitSimilarityConfig();
      expect(fromEnv).toEqual({
        threshold: 0.4,
        topK: 12,
        engagementGateMs: 750,
        lexicalThreshold: 0.18,
        lexicalFallbackEnabled: false,
      });
      const withOverrides = resolveVisitSimilarityConfig({
        threshold: 0.9,
        topK: 99,
        engagementGateMs: 8_000,
        lexicalThreshold: 0.42,
        lexicalFallbackEnabled: true,
      });
      expect(withOverrides).toEqual({
        threshold: 0.9,
        topK: 99,
        engagementGateMs: 8_000,
        lexicalThreshold: 0.42,
        lexicalFallbackEnabled: true,
      });
    } finally {
      // Restore each env var separately — keeps the names visible to a
      // future reader, and the static keys pacify the no-dynamic-delete
      // lint rule.

      if (previous.threshold === undefined) delete process.env['SIDETRACK_SIMILARITY_THRESHOLD'];
      else process.env['SIDETRACK_SIMILARITY_THRESHOLD'] = previous.threshold;
      if (previous.topK === undefined) delete process.env['SIDETRACK_SIMILARITY_TOP_K'];
      else process.env['SIDETRACK_SIMILARITY_TOP_K'] = previous.topK;
      if (previous.gate === undefined) delete process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'];
      else process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = previous.gate;
      if (previous.lexical === undefined)
        delete process.env['SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD'];
      else process.env['SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD'] = previous.lexical;
      if (previous.fallback === undefined)
        delete process.env['SIDETRACK_SIMILARITY_LEXICAL_FALLBACK'];
      else process.env['SIDETRACK_SIMILARITY_LEXICAL_FALLBACK'] = previous.fallback;
    }
  });
});

describe('buildVisitSimilarity — Stage 5.0 follow-up: revision identity', () => {
  // Identical visits / config: only the lexical threshold differs.
  // Pre-fix the revision id was hashed before the lexical-fallback
  // decision, so both runs would have collided.
  const sharedEntries = (): readonly VisitSimilarityEntry[] => {
    const a: VisitSimilarityEntry = {
      ...visit('a'),
      title: 'foo bar baz qux',
      canonicalUrl: 'https://example.test/x/a',
      url: 'https://example.test/x/a',
    };
    const b: VisitSimilarityEntry = {
      ...visit('b'),
      title: 'foo bar baz quux',
      canonicalUrl: 'https://example.test/x/b',
      url: 'https://example.test/x/b',
    };
    return [a, b];
  };

  it('changes the lexical revision id when SIDETRACK_SIMILARITY_LEXICAL_THRESHOLD changes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const entries = sharedEntries();
    const embedder = (): Promise<readonly Float32Array[]> =>
      Promise.reject(new Error('embedder offline'));
    const first = await buildVisitSimilarity(entries, embedder, { lexicalThreshold: 0.2 });
    const second = await buildVisitSimilarity(entries, embedder, { lexicalThreshold: 0.5 });
    expect(first.producer).toBe('lexical');
    expect(second.producer).toBe('lexical');
    expect(first.revisionId).not.toBe(second.revisionId);
  });

  it('assigns distinct revision ids to lexical vs embedding revisions over the same visits', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // `visit()` produces a corpus whose first token is `visit-alpha` /
    // `visit-bravo`, so `embedFromVectors` resolves the embedding path
    // cleanly. The lexical path runs because we make the embedder
    // throw.
    const entries = [visit('alpha'), visit('bravo')];
    const lexical = await buildVisitSimilarity(entries, () =>
      Promise.reject(new Error('embedder offline')),
    );
    const embedding = await buildVisitSimilarity(
      entries,
      embedFromVectors(
        new Map<string, Float32Array>([
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', unit([1, 0])],
        ]),
      ),
    );
    expect(lexical.producer).toBe('lexical');
    expect(embedding.producer).toBe('embedding');
    expect(lexical.revisionId).not.toBe(embedding.revisionId);
  });
});
