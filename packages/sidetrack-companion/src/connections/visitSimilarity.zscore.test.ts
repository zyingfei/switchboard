import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmptyTabSessionProjection } from '../tabsession/projection.js';
import { buildConnectionsSnapshot } from './snapshot.js';
import {
  anisotropyZScore,
  buildVisitSimilarity,
  resolveAnisotropyBaseline,
  resolveSimilarityZMin,
  SIMILARITY_ANISOTROPY_MEAN,
  SIMILARITY_ANISOTROPY_MEAN_ENV,
  SIMILARITY_ANISOTROPY_SD,
  SIMILARITY_ANISOTROPY_SD_ENV,
  SIMILARITY_Z_MIN_ENV,
  type VisitSimilarityEmbedder,
  type VisitSimilarityEntry,
} from './visitSimilarity.js';

// -- Local test helpers (mirrors visitSimilarity.test.ts) --------------
const unit = (values: readonly number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Float32Array.from(values.map((value) => value / norm));
};

const vectorAtCosine = (cosine: number): Float32Array =>
  unit([cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine))]);

const visit = (key: string, focusedWindowMs = 10_000): VisitSimilarityEntry => {
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
    dimensions: { engagement: { focusedWindowMs } },
  };
};

const keyFromEmbeddingText = (text: string): string =>
  text.replace(/^(?:passage|query):\s+/u, '').split(/\s+/u)[0] ?? '';

const embedFromVectors =
  (vectors: ReadonlyMap<string, Float32Array>): VisitSimilarityEmbedder =>
  async (texts) =>
    texts.map((text) => {
      const vector = vectors.get(keyFromEmbeddingText(text));
      if (vector === undefined) throw new Error(`missing vector for ${keyFromEmbeddingText(text)}`);
      return vector;
    });

const stripProducedAt = (revision: Awaited<ReturnType<typeof buildVisitSimilarity>>): unknown => {
  const { producedAt: _producedAt, ...rest } = revision;
  return rest;
};

const restoreEnv = (name: string, previous: string | undefined): void => {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
};

describe('anisotropy z-score', () => {
  const savedMean = process.env[SIMILARITY_ANISOTROPY_MEAN_ENV];
  const savedSd = process.env[SIMILARITY_ANISOTROPY_SD_ENV];
  const savedZMin = process.env[SIMILARITY_Z_MIN_ENV];

  beforeEach(() => {
    delete process.env[SIMILARITY_ANISOTROPY_MEAN_ENV];
    delete process.env[SIMILARITY_ANISOTROPY_SD_ENV];
    delete process.env[SIMILARITY_Z_MIN_ENV];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv(SIMILARITY_ANISOTROPY_MEAN_ENV, savedMean);
    restoreEnv(SIMILARITY_ANISOTROPY_SD_ENV, savedSd);
    restoreEnv(SIMILARITY_Z_MIN_ENV, savedZMin);
  });

  describe('anisotropyZScore (pure)', () => {
    it('re-centers cosine against the 2026-07-14 vault baseline', () => {
      // Baseline mean 0.825, sd 0.029. The historical raw gate 0.85 sits
      // at (0.85 - 0.825) / 0.029 ≈ 0.86 sd above the noise floor.
      expect(anisotropyZScore(0.85)).toBe(0.86);
      // A pair exactly at the noise mean has z 0.
      expect(anisotropyZScore(SIMILARITY_ANISOTROPY_MEAN)).toBe(0);
      // One sd above the mean → z 1.
      expect(anisotropyZScore(SIMILARITY_ANISOTROPY_MEAN + SIMILARITY_ANISOTROPY_SD)).toBe(1);
      // p99 of noise (0.901) → z ≈ (0.901 - 0.825)/0.029 ≈ 2.62.
      expect(anisotropyZScore(0.901)).toBeCloseTo(2.62, 2);
    });

    it('rounds to 2dp and is finite for non-finite input', () => {
      expect(anisotropyZScore(0.9)).toBe(2.59);
      expect(anisotropyZScore(Number.NaN)).toBe(0);
      expect(anisotropyZScore(Number.POSITIVE_INFINITY)).toBe(0);
    });

    it('honors env overrides for mean and sd', () => {
      process.env[SIMILARITY_ANISOTROPY_MEAN_ENV] = '0.5';
      process.env[SIMILARITY_ANISOTROPY_SD_ENV] = '0.1';
      expect(resolveAnisotropyBaseline()).toEqual({ mean: 0.5, sd: 0.1 });
      expect(anisotropyZScore(0.7)).toBe(2);
    });

    it('floors a non-positive sd override back to the study constant', () => {
      process.env[SIMILARITY_ANISOTROPY_SD_ENV] = '0';
      expect(resolveAnisotropyBaseline().sd).toBe(SIMILARITY_ANISOTROPY_SD);
    });
  });

  describe('z-gate flag (SIDETRACK_SIMILARITY_Z_MIN)', () => {
    it('is undefined (OFF) when the flag is absent', () => {
      expect(resolveSimilarityZMin()).toBeUndefined();
    });

    it('default path (flag unset) is byte-identical to the raw 0.85 gate', async () => {
      // A pair at cosine 0.86 clears the raw 0.85 gate but sits at z ≈
      // 1.2 (below a would-be z-gate of 2). With the flag unset it MUST
      // still emit — i.e. the default serving behavior is unchanged.
      const entries = [visit('alpha'), visit('bravo')];
      const embed = embedFromVectors(
        new Map<string, Float32Array>([
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', vectorAtCosine(0.86)],
        ]),
      );
      const revision = await buildVisitSimilarity(entries, embed);
      expect(revision.edges).toHaveLength(1);
      expect(revision.edges[0]?.cosine).toBeCloseTo(0.86, 6);
    });

    it('gates on z >= zMin instead of the raw threshold when the flag is set', async () => {
      const entries = [visit('alpha'), visit('bravo')];
      // cosine 0.86 → z ≈ 1.21. A z-gate of 2 rejects it even though it
      // clears the raw 0.85 threshold.
      const embed = embedFromVectors(
        new Map<string, Float32Array>([
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', vectorAtCosine(0.86)],
        ]),
      );

      process.env[SIMILARITY_Z_MIN_ENV] = '2';
      const rejected = await buildVisitSimilarity(entries, embed);
      expect(rejected.edges).toEqual([]);

      // cosine 0.9 → z ≈ 2.59, which clears a z-gate of 2.
      const strongEmbed = embedFromVectors(
        new Map<string, Float32Array>([
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', vectorAtCosine(0.9)],
        ]),
      );
      const admitted = await buildVisitSimilarity(entries, strongEmbed);
      expect(admitted.edges).toHaveLength(1);
      expect(admitted.edges[0]?.cosine).toBeCloseTo(0.9, 6);
    });
  });

  describe('simZ stamp on served connection edges', () => {
    it('stamps metadata.simZ on the visit_resembles_visit edge (default-on, additive)', async () => {
      const entries = [visit('alpha'), visit('bravo')];
      const revision = await buildVisitSimilarity(
        entries,
        embedFromVectors(
          new Map<string, Float32Array>([
            ['visit-alpha', unit([1, 0])],
            ['visit-bravo', vectorAtCosine(0.9)],
          ]),
        ),
      );
      expect(revision.edges).toHaveLength(1);

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

      const edge = snapshot.edges.find((candidate) => candidate.kind === 'visit_resembles_visit');
      expect(edge).toBeDefined();
      const simZ = edge?.metadata?.['simZ'];
      const cosine = edge?.metadata?.['cosine'];
      expect(typeof simZ).toBe('number');
      expect(typeof cosine).toBe('number');
      // simZ is the z-score of the stamped cosine against the baseline.
      expect(simZ).toBe(anisotropyZScore(cosine as number));
      // Additive: the pre-existing evidenceTier stamp is untouched.
      expect(edge?.metadata?.['evidenceTier']).toBeDefined();
    });
  });
});
