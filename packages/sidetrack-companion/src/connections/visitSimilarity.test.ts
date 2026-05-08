import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectionsSnapshot } from './snapshot.js';
import {
  buildVisitSimilarity,
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

const embedFromVectors = (
  vectors: ReadonlyMap<string, Float32Array>,
): VisitSimilarityEmbedder => async (texts) =>
  texts.map((text) => {
    const key = keyFromEmbeddingText(text);
    const vector = vectors.get(key);
    if (vector === undefined) {
      throw new Error(`missing vector for ${key}`);
    }
    return vector;
  });

const withoutProducedAt = (revision: Awaited<ReturnType<typeof buildVisitSimilarity>>) => {
  const { producedAt: _producedAt, ...rest } = revision;
  return rest;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildVisitSimilarity', () => {
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
    const revision = await buildVisitSimilarity(entries, async () => {
      throw new Error('model cache empty');
    });

    expect(revision.edges).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[materializer-error] visit-similarity embed failed: model cache empty'),
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
      visitSimilarity: revision,
    });
    expect(snapshot.nodes.map((node) => node.id)).toContain('timeline-visit:https://example.test/alpha');
    expect(snapshot.edges.find((edge) => edge.kind === 'visit_resembles_visit')).toBeUndefined();
  });

  it('does not emit a candidate below the top-K cutoff even when it clears threshold', async () => {
    const source = visit('a');
    const candidates: VisitSimilarityEntry[] = [];
    const vectors = new Map<string, Float32Array>([['visit-a', unit([1, 0])]]);
    for (let index = 1; index <= 60; index += 1) {
      const key = `b-${String(index).padStart(2, '0')}`;
      candidates.push(visit(key));
      const cosine =
        index <= 50 ? 0.99 - index * 0.001 : index === 51 ? 0.9 : 0.2;
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
    await buildVisitSimilarity(
      [visit('alpha'), visit('bravo')],
      async (texts) => {
        seen.push(...texts);
        return texts.map((text) =>
          text.includes('visit-alpha') ? unit([1, 0]) : unit([1, 0]),
        );
      },
    );

    expect(seen.filter((text) => text.startsWith('passage: '))).toHaveLength(2);
    expect(seen.filter((text) => text.startsWith('query: '))).toHaveLength(2);
  });
});
