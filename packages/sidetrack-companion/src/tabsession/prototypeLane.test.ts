import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import type { GuessLaneResult } from './guessLanes.js';
import {
  lanePrequentialPath,
  scoreLanePredictions,
  type LaneFiling,
  type LanePredictionRecord,
} from './lanePrequential.js';
import {
  appendPrototypeLane,
  buildPrototypeLane,
  PROTOTYPE_LANE_ENV,
  PROTOTYPE_LANE_MAX_ACTION,
  PROTOTYPE_LANE_MIN_PRECISION,
  PROTOTYPE_LANE_MIN_SAMPLES,
  prototypeLaneEnabled,
  type AppendPrototypeLaneDeps,
  type PrototypeLaneStore,
} from './prototypeLane.js';
import type { PrototypeKeywordProfile } from '../workstreams/prototypeKeywordProfile.js';

type Hit = {
  readonly prototypeId: string;
  readonly workstreamId: string;
  readonly cosineDistance: number;
  readonly angle?: 'medoid' | 'synthetic-sibling';
};

const storeWithHits = (
  hits: readonly Hit[],
  extras: {
    readonly idf?: ReadonlyMap<string, number>;
    readonly profiles?: ReadonlyMap<string, PrototypeKeywordProfile>;
  } = {},
): PrototypeLaneStore => ({
  vectorBackendAvailable: true,
  queryPrototypeVector: () => hits,
  ...(extras.idf === undefined ? {} : { getPrototypeKeywordIdf: () => extras.idf! }),
  ...(extras.profiles === undefined
    ? {}
    : { getPrototypeKeywordProfile: (workstreamId: string) => extras.profiles!.get(workstreamId) }),
});

const fixedEmbed = async (): Promise<Float32Array> => new Float32Array([1, 0, 0]);

describe('buildPrototypeLane — pure vector + keyword-profile blend, NO LLM call at serve time', () => {
  it('typed-empty when the store is unavailable', async () => {
    const lane = await buildPrototypeLane({
      title: 'x',
      store: undefined,
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane).toEqual({
      lane: 'prototype',
      candidates: [],
      emptyReason: 'recall store unavailable',
    });
  });

  it('typed-empty when the vector backend is unavailable', async () => {
    const lane = await buildPrototypeLane({
      title: 'x',
      store: { vectorBackendAvailable: false, queryPrototypeVector: () => [] },
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.candidates).toHaveLength(0);
    expect(lane.emptyReason).toBe('vector backend unavailable');
  });

  it('typed-empty when there is no title or gist to compare', async () => {
    const lane = await buildPrototypeLane({
      title: null,
      store: storeWithHits([]),
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.emptyReason).toBe('no title or gist to compare');
  });

  it('typed-empty when the embedder is cold', async () => {
    const lane = await buildPrototypeLane({
      title: 'a real title',
      store: storeWithHits([]),
      embedderUsable: false,
    });
    expect(lane.emptyReason).toBe('embedder cold — cannot compare');
  });

  it('typed-empty when no workstream has any generated prototype yet', async () => {
    const lane = await buildPrototypeLane({
      title: 'a real title',
      store: storeWithHits([]),
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.emptyReason).toBe('no prototypes generated for any workstream yet');
  });

  it('groups hits by workstream, scores by MAX similarity, and ranks descending (clear margin passes)', async () => {
    // cosineDistance 0 -> similarity 1 (identical); a larger L2 distance ->
    // lower similarity. See cosineSimilarityFromL2's doc comment: for
    // L2-normalized vectors, sim = 1 - distance^2/2. Scores here are widely
    // spread (1.0 / 0.82 / 0), clearing the contrast-margin gate easily.
    const store = storeWithHits([
      { prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 0, angle: 'medoid' }, // sim 1.0
      { prototypeId: 'p2', workstreamId: 'ws-a', cosineDistance: 1.0, angle: 'medoid' }, // sim 0.5 (not the max)
      { prototypeId: 'p3', workstreamId: 'ws-b', cosineDistance: 0.6, angle: 'medoid' }, // sim 0.82
      { prototypeId: 'p4', workstreamId: 'ws-c', cosineDistance: 1.4142135623730951, angle: 'medoid' }, // sim 0
    ]);
    const lane = await buildPrototypeLane({
      title: 'a real title',
      store,
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.emptyReason).toBeUndefined();
    expect(lane.candidates.map((c) => c.workstreamId)).toEqual(['ws-a', 'ws-b', 'ws-c']);
    expect(lane.candidates[0]?.score).toBeCloseTo(1.0, 5);
    expect(lane.candidates[1]?.score).toBeCloseTo(0.82, 2);
    expect(lane.candidates[2]?.score).toBeCloseTo(0, 5);
    // ws-a had 2 hits; the why line should say so, in plain language (not
    // the ML term "prototype" — see prototypeLane.ts's UI-visibility note).
    expect(lane.candidates[0]?.why).toContain('2 examples generated for this workstream');
  });

  it('caps at the top 3 of the candidates that clear the contrast-margin gate', async () => {
    const hits = [
      { workstreamId: 'ws-1', cosineDistance: 0 }, // sim 1.0
      { workstreamId: 'ws-2', cosineDistance: 0.5 }, // sim 0.875
      { workstreamId: 'ws-3', cosineDistance: 0.9 }, // sim 0.595
      { workstreamId: 'ws-4', cosineDistance: 1.2 }, // sim 0.28
    ].map((h, i) => ({ prototypeId: `p${String(i)}`, ...h, angle: 'medoid' as const }));
    const lane = await buildPrototypeLane({
      title: 't',
      store: storeWithHits(hits),
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.candidates).toHaveLength(3);
    expect(lane.candidates[0]?.workstreamId).toBe('ws-1');
  });

  it('degrades to typed-empty (never throws) when the store throws', async () => {
    const throwingStore: PrototypeLaneStore = {
      vectorBackendAvailable: true,
      queryPrototypeVector: () => {
        throw new Error('boom');
      },
    };
    const lane = await buildPrototypeLane({
      title: 't',
      store: throwingStore,
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.emptyReason).toBe('no prototypes generated for any workstream yet');
  });
});

// ---- contrast-margin gate (v2 §11) ---------------------------------------

describe('buildPrototypeLane — contrast-margin gate (the day-one three-way-tie bug)', () => {
  it('a near-tie across workstreams is an honest empty, not three confident-looking candidates', async () => {
    const hits = [
      { prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 0.6, angle: 'medoid' as const }, // sim ~0.82
      { prototypeId: 'p2', workstreamId: 'ws-b', cosineDistance: 0.62, angle: 'medoid' as const }, // sim ~0.808
      { prototypeId: 'p3', workstreamId: 'ws-c', cosineDistance: 0.64, angle: 'medoid' as const }, // sim ~0.795
    ];
    const lane = await buildPrototypeLane({
      title: 'a generic tech page',
      store: storeWithHits(hits),
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.candidates).toEqual([]);
    expect(lane.emptyReason).toContain('no clearly closer workstream');
  });

  it('a lone candidate always passes the margin gate — nothing to contrast against', async () => {
    const lane = await buildPrototypeLane({
      title: 'x',
      store: storeWithHits([
        { prototypeId: 'p1', workstreamId: 'ws-only', cosineDistance: 0.6, angle: 'medoid' },
      ]),
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.candidates).toHaveLength(1);
    expect(lane.candidates[0]?.workstreamId).toBe('ws-only');
  });
});

// ---- keyword-profile blend (v2 §11) --------------------------------------

describe('buildPrototypeLane — keyword-profile blend', () => {
  it('a shared distinctive concept FLIPS the ranking versus pure vector order, with a self-explaining why', async () => {
    // ws-b leads on RAW vector similarity (sim 0.5 vs ws-a's 0.45); the
    // keyword-profile signal — ws-a's profile shares both of the page's own
    // concepts, ws-b's shares none — lifts ws-a's blended score above ws-b's,
    // flipping the final ranking. Proves the blend genuinely matters, not
    // just decorates an already-decided winner.
    const hits = [
      { prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 1.0488088481701516, angle: 'medoid' as const }, // sim 0.45
      { prototypeId: 'p2', workstreamId: 'ws-b', cosineDistance: 1.0, angle: 'medoid' as const }, // sim 0.5
    ];
    const idf = new Map([
      ['concept-duckdb', 1.5],
      ['concept-olap', 1.5],
    ]);
    const profiles = new Map<string, PrototypeKeywordProfile>([
      [
        'ws-a',
        {
          weights: new Map([
            ['concept-duckdb', 3],
            ['concept-olap', 3],
          ]),
          displayKeyword: new Map([
            ['concept-duckdb', 'duckdb'],
            ['concept-olap', 'olap'],
          ]),
        },
      ],
      ['ws-b', { weights: new Map(), displayKeyword: new Map() }],
    ]);
    const lane = await buildPrototypeLane({
      title: 'a page about duckdb',
      store: storeWithHits(hits, { idf, profiles }),
      embed: fixedEmbed,
      embedderUsable: true,
      pageConceptIds: ['concept-duckdb', 'concept-olap'],
    });
    expect(lane.candidates[0]?.workstreamId).toBe('ws-a');
    expect(lane.candidates[0]?.why).toContain("matches duckdb, olap from this workstream's pages");
  });

  it('missing pageConceptIds degrades to pure vector scoring (identical to pre-keyword-layer behavior)', async () => {
    const hits = [{ prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 0, angle: 'medoid' as const }];
    const idf = new Map([['concept-duckdb', 1.5]]);
    const profiles = new Map<string, PrototypeKeywordProfile>([
      ['ws-a', { weights: new Map([['concept-duckdb', 3]]), displayKeyword: new Map() }],
    ]);
    const lane = await buildPrototypeLane({
      title: 'x',
      store: storeWithHits(hits, { idf, profiles }),
      embed: fixedEmbed,
      embedderUsable: true,
      // pageConceptIds omitted
    });
    expect(lane.candidates[0]?.score).toBeCloseTo(1.0, 5);
    expect(lane.candidates[0]?.why).not.toContain('matches');
  });
});

// ---- sentence-level late interaction (§12, "the attention of sentence
// matters") ---------------------------------------------------------------

describe('buildPrototypeLane — sentence-level scoring (§12)', () => {
  // Small orthonormal axes so cosine similarity is exact: axis 0 = the
  // page's TITLE sentence, axis 1 = the page's GIST sentence, axis 2 =
  // "unrelated" (everything else, including the whole-vector query text —
  // irrelevant here since storeWithHitsAndSentences ignores the `vec` arg
  // entirely, same as storeWithHits).
  const TITLE_TEXT = 'DuckDB Notes';
  const GIST_TEXT = 'DuckDB is a fast in-process database.';
  const axis = (index: number): Float32Array => {
    const v = new Float32Array(3);
    v[index] = 1;
    return v;
  };
  const perSentenceEmbed = async (text: string): Promise<Float32Array> => {
    if (text === TITLE_TEXT) return axis(0);
    if (text === GIST_TEXT) return axis(1);
    return axis(2);
  };

  const storeWithHitsAndSentences = (
    hits: readonly Hit[],
    sentenceVectorsByPrototypeId: ReadonlyMap<string, readonly Float32Array[]>,
  ): PrototypeLaneStore => ({
    vectorBackendAvailable: true,
    queryPrototypeVector: () => hits,
    getSentenceVectorsForOwners: (_ownerKind, ownerIds) => {
      const out = new Map<string, readonly { readonly embedding: Float32Array }[]>();
      for (const ownerId of ownerIds) {
        const vectors = sentenceVectorsByPrototypeId.get(ownerId);
        if (vectors !== undefined) out.set(ownerId, vectors.map((embedding) => ({ embedding })));
      }
      return out;
    },
  });

  it('reproduces the day-one pooled tie, then fixes it: sentence-level scoring discriminates a real match from a fake one at the SAME pooled similarity', async () => {
    // Both workstreams tie on POOLED (whole-vector) cosine — the exact
    // day-one shape (prototypeContrastMargin.test.ts's own reproduction).
    const hits: readonly Hit[] = [
      { prototypeId: 'p-a', workstreamId: 'ws-a', cosineDistance: 0.6, angle: 'medoid' }, // sim ~0.82
      { prototypeId: 'p-b', workstreamId: 'ws-b', cosineDistance: 0.6, angle: 'medoid' }, // sim ~0.82 — a TIE
    ];

    // WITHOUT sentence vectors at all (store predates §12 / mid-backfill):
    // the pooled tie survives untouched — the day-one bug, reproduced.
    const poolOnlyLane = await buildPrototypeLane({
      title: TITLE_TEXT,
      gist: GIST_TEXT,
      store: storeWithHits(hits),
      embed: perSentenceEmbed,
      embedderUsable: true,
    });
    expect(poolOnlyLane.candidates).toEqual([]);
    expect(poolOnlyLane.emptyReason).toContain('no clearly closer workstream');

    // WITH sentence vectors: ws-a's prototype (p-a) sentences EXACTLY match
    // the page's own two sentences; ws-b's prototype (p-b) sentences are
    // both the unrelated axis — a real match vs. a fake one at an IDENTICAL
    // pooled score, exactly the shape sentence-level attention exists to
    // discriminate.
    const sentenceVectors = new Map<string, readonly Float32Array[]>([
      ['p-a', [axis(0), axis(1)]],
      ['p-b', [axis(2), axis(2)]],
    ]);
    const sentenceLane = await buildPrototypeLane({
      title: TITLE_TEXT,
      gist: GIST_TEXT,
      store: storeWithHitsAndSentences(hits, sentenceVectors),
      embed: perSentenceEmbed,
      embedderUsable: true,
    });
    expect(sentenceLane.emptyReason).toBeUndefined();
    expect(sentenceLane.candidates[0]?.workstreamId).toBe('ws-a');
    expect(sentenceLane.candidates[0]?.score).toBeGreaterThan(0.9);
  });

  it('falls back to the pooled score when a candidate workstream has NO sentence vectors for its hit prototypes', async () => {
    const hits: readonly Hit[] = [
      { prototypeId: 'p-a', workstreamId: 'ws-a', cosineDistance: 0.6, angle: 'medoid' },
    ];
    // ws-a's own prototype has sentence vectors, but the store call for a
    // DIFFERENT (never-hit) prototype id returns nothing for it — proving
    // the fallback is per-workstream, not all-or-nothing.
    const store = storeWithHitsAndSentences(hits, new Map());
    const lane = await buildPrototypeLane({
      title: TITLE_TEXT,
      gist: GIST_TEXT,
      store,
      embed: perSentenceEmbed,
      embedderUsable: true,
    });
    // Pooled cosineDistance 0.6 -> sim ~0.82, unchanged from the pre-§12
    // pooled-only path.
    expect(lane.candidates[0]?.score).toBeCloseTo(0.82, 2);
  });

  it('falls back to the pooled path entirely when the store predates §12 (no getSentenceVectorsForOwners)', async () => {
    const hits: readonly Hit[] = [
      { prototypeId: 'p-a', workstreamId: 'ws-a', cosineDistance: 0.6, angle: 'medoid' },
    ];
    const lane = await buildPrototypeLane({
      title: TITLE_TEXT,
      gist: GIST_TEXT,
      store: storeWithHits(hits), // no getSentenceVectorsForOwners at all
      embed: perSentenceEmbed,
      embedderUsable: true,
    });
    expect(lane.candidates[0]?.score).toBeCloseTo(0.82, 2);
  });

  it('records prototype:sentence and prototype:pooled as INDEPENDENTLY measured per-source predictions', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-prototype-lane-sentence-prequential-'));
    try {
      const hits: readonly Hit[] = [
        { prototypeId: 'p-a', workstreamId: 'ws-pooled-winner', cosineDistance: 0, angle: 'medoid' }, // sim 1.0, no sentence vectors
        { prototypeId: 'p-b', workstreamId: 'ws-sentence-winner', cosineDistance: 0.9, angle: 'medoid' }, // sim ~0.6 pooled, but exact sentence match
      ];
      const sentenceVectors = new Map<string, readonly Float32Array[]>([
        ['p-b', [axis(0), axis(1)]],
      ]);
      await buildPrototypeLane({
        title: TITLE_TEXT,
        gist: GIST_TEXT,
        store: storeWithHitsAndSentences(hits, sentenceVectors),
        embed: perSentenceEmbed,
        embedderUsable: true,
        canonicalUrl: 'https://a.test/1',
        vaultRoot,
      });
      const raw = await readFile(lanePrequentialPath(vaultRoot), 'utf8');
      const lines = raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as LanePredictionRecord);
      const byLane = new Map(lines.map((l) => [l.l, l.w]));
      // pooled: ws-pooled-winner has the higher RAW cosine (sim 1.0 vs 0.6).
      expect(byLane.get('prototype:pooled')).toBe('ws-pooled-winner');
      // sentence: ws-sentence-winner's prototype sentences exactly match the
      // page's own sentences (score 1.0); ws-pooled-winner has NO sentence
      // vectors at all (score 0) — sentence-level correctly picks the OTHER
      // workstream, proving the two sources are measured independently.
      expect(byLane.get('prototype:sentence')).toBe('ws-sentence-winner');
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});

// ---- per-source prequential recording (v2 §11) ---------------------------

describe('buildPrototypeLane — per-source prequential recording', () => {
  let vaultRoot: string;

  afterEach(async () => {
    if (vaultRoot !== undefined) await rm(vaultRoot, { recursive: true, force: true });
  });

  it('emits medoid/generated/keyword sub-predictions when canonicalUrl+vaultRoot are provided', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-prototype-lane-prequential-'));
    const hits: readonly Hit[] = [
      { prototypeId: 'p1', workstreamId: 'ws-medoid-winner', cosineDistance: 0, angle: 'medoid' },
      { prototypeId: 'p2', workstreamId: 'ws-generated-winner', cosineDistance: 0.2, angle: 'synthetic-sibling' },
    ];
    const idf = new Map([['concept-x', 1.5]]);
    const profiles = new Map<string, PrototypeKeywordProfile>([
      [
        'ws-keyword-winner',
        { weights: new Map([['concept-x', 3]]), displayKeyword: new Map([['concept-x', 'x-term']]) },
      ],
    ]);
    // ws-keyword-winner has NO vector hit at all — still eligible to win the
    // keyword sub-prediction, proving the three sources are measured
    // independently, not gated on each other.
    await buildPrototypeLane({
      title: 'a page',
      store: storeWithHits(hits, { idf, profiles }),
      embed: fixedEmbed,
      embedderUsable: true,
      pageConceptIds: ['concept-x'],
      canonicalUrl: 'https://a.test/1',
      vaultRoot,
    });

    const raw = await readFile(lanePrequentialPath(vaultRoot), 'utf8');
    const lines = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as LanePredictionRecord);
    const byLane = new Map(lines.map((l) => [l.l, l.w]));
    expect(byLane.get('prototype:medoid')).toBe('ws-medoid-winner');
    expect(byLane.get('prototype:generated')).toBe('ws-generated-winner');
    // keyword winner is a workstream with NO vector hits at all — the
    // keyword-profile-only scoring path chose it independently.
  });

  it('is a no-op when canonicalUrl/vaultRoot are absent (ready-to-splice, never throws)', async () => {
    const hits: readonly Hit[] = [
      { prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 0, angle: 'medoid' },
    ];
    // Should simply not attempt to write anything — no throw, no hang.
    const lane = await buildPrototypeLane({
      title: 'a page',
      store: storeWithHits(hits),
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.candidates).toHaveLength(1);
  });
});

describe('appendPrototypeLane — disclosure only, idempotent', () => {
  afterEach(() => {
    delete process.env[PROTOTYPE_LANE_ENV];
  });

  const deps = (store: PrototypeLaneStore): AppendPrototypeLaneDeps => ({
    store,
    embed: fixedEmbed,
    embedderUsable: true,
    guessLanesEnabled: true,
  });

  it('appends the lane to an existing lanes array', async () => {
    const result = { lanes: [] as GuessLaneResult[] };
    const out = await appendPrototypeLane(
      result,
      { title: 't' },
      deps(storeWithHits([{ prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 0 }])),
    );
    expect(out.lanes.map((l) => l.lane)).toEqual(['prototype']);
  });

  it('replaces (never duplicates) a prior prototype entry', async () => {
    const first = await appendPrototypeLane(
      { lanes: [] as GuessLaneResult[] },
      { title: 't' },
      deps(storeWithHits([{ prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 0 }])),
    );
    const second = await appendPrototypeLane(
      first,
      { title: 't' },
      deps(storeWithHits([{ prototypeId: 'p1', workstreamId: 'ws-b', cosineDistance: 0 }])),
    );
    expect(second.lanes.filter((l) => l.lane === 'prototype')).toHaveLength(1);
    expect(second.lanes[0]?.candidates[0]?.workstreamId).toBe('ws-b');
  });

  it('no-op when SIDETRACK_GUESS_LANES-equivalent (guessLanesEnabled) is false', async () => {
    const result = { lanes: [] as GuessLaneResult[] };
    const out = await appendPrototypeLane(
      result,
      { title: 't' },
      { ...deps(storeWithHits([])), guessLanesEnabled: false },
    );
    expect(out).toBe(result); // identity — untouched
  });

  it('no-op when result carries no lanes array at all (guess lanes off upstream)', async () => {
    const result = {};
    const out = await appendPrototypeLane(result, { title: 't' }, deps(storeWithHits([])));
    expect(out).toBe(result);
  });

  it('defaults ON — SIDETRACK_PROTOTYPE_LANE unset still appends the lane', async () => {
    delete process.env[PROTOTYPE_LANE_ENV];
    expect(prototypeLaneEnabled()).toBe(true);
  });

  it('kill switch: SIDETRACK_PROTOTYPE_LANE=0 omits the lane', async () => {
    process.env[PROTOTYPE_LANE_ENV] = '0';
    expect(prototypeLaneEnabled()).toBe(false);
    const result = { lanes: [] as GuessLaneResult[] };
    const out = await appendPrototypeLane(
      result,
      { title: 't' },
      deps(storeWithHits([{ prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 0 }])),
    );
    expect(out).toBe(result);
  });
});

// ---- promotion-gate PREP (4-part contract, part 4: declared max action) --

describe('promotion-gate prep constants', () => {
  it('declares the same-shape thresholds as laneCorroboration.ts, measured FRESH for this lane', () => {
    expect(PROTOTYPE_LANE_MIN_PRECISION).toBe(0.6);
    expect(PROTOTYPE_LANE_MIN_SAMPLES).toBe(20);
    expect(PROTOTYPE_LANE_MAX_ACTION).toBe('suggest');
  });
});

// ---- counter wiring (4-part contract, part 1) ----------------------------
//
// lanePrequential.ts is ALREADY generic over the lane id string — adding
// 'prototype' to the GuessLane union and appending it into `result.lanes`
// (server.ts's finalizeBatchResolveResults) is sufficient for precision/
// sample evidence to accrue with NO prototype-specific code in
// lanePrequential.ts itself. This test proves that generalization actually
// covers the new lane id, end to end through the real scorer — and that the
// SAME generalization covers the v2 per-source composite ids.

describe('prototype lane precision/sample counters (lanePrequential.ts generalization)', () => {
  it('scores a prototype-lane prediction exactly like any other lane', () => {
    const predictions: readonly LanePredictionRecord[] = [
      { u: 'https://a.test/1', l: 'prototype', w: 'ws-a', t: 1000 },
      { u: 'https://a.test/2', l: 'prototype', w: 'ws-b', t: 1000 },
    ];
    const filings: readonly LaneFiling[] = [
      { canonicalUrl: 'https://a.test/1', workstreamId: 'ws-a', atMs: 2000 }, // hit
      { canonicalUrl: 'https://a.test/2', workstreamId: 'ws-c', atMs: 2000 }, // miss
    ];
    const summary = scoreLanePredictions(predictions, filings);
    const proto = summary.lanes.find((entry) => entry.lane === 'prototype');
    expect(proto).toEqual({ lane: 'prototype', n: 2, hits: 1, precision: 0.5 });
  });

  it('scores the v2 per-source composite lane ids the same way, independently of each other', () => {
    const predictions: readonly LanePredictionRecord[] = [
      { u: 'https://a.test/1', l: 'prototype:medoid', w: 'ws-a', t: 1000 },
      { u: 'https://a.test/1', l: 'prototype:generated', w: 'ws-b', t: 1000 },
    ];
    const filings: readonly LaneFiling[] = [
      { canonicalUrl: 'https://a.test/1', workstreamId: 'ws-a', atMs: 2000 },
    ];
    const summary = scoreLanePredictions(predictions, filings);
    const medoid = summary.lanes.find((entry) => entry.lane === 'prototype:medoid');
    const generated = summary.lanes.find((entry) => entry.lane === 'prototype:generated');
    expect(medoid).toEqual({ lane: 'prototype:medoid', n: 1, hits: 1, precision: 1 });
    expect(generated).toEqual({ lane: 'prototype:generated', n: 1, hits: 0, precision: 0 });
  });
});
