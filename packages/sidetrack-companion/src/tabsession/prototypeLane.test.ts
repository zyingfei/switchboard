import { afterEach, describe, expect, it } from 'bun:test';

import type { GuessLaneResult } from './guessLanes.js';
import {
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

const storeWithHits = (
  hits: readonly {
    readonly prototypeId: string;
    readonly workstreamId: string;
    readonly cosineDistance: number;
  }[],
): PrototypeLaneStore => ({
  vectorBackendAvailable: true,
  queryPrototypeVector: () => hits,
});

const fixedEmbed = async (): Promise<Float32Array> => new Float32Array([1, 0, 0]);

describe('buildPrototypeLane — pure vector match, NO LLM call at serve time', () => {
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

  it('groups hits by workstream, scores by MAX similarity, and ranks descending', async () => {
    // cosineDistance 0 -> similarity 1 (identical); a larger L2 distance ->
    // lower similarity. See cosineSimilarityFromL2's doc comment: for
    // L2-normalized vectors, sim = 1 - distance^2/2.
    const store = storeWithHits([
      { prototypeId: 'p1', workstreamId: 'ws-a', cosineDistance: 0 }, // sim 1.0
      { prototypeId: 'p2', workstreamId: 'ws-a', cosineDistance: 1.0 }, // sim 0.5 (not the max for ws-a)
      { prototypeId: 'p3', workstreamId: 'ws-b', cosineDistance: 0.6 }, // sim 0.82
      { prototypeId: 'p4', workstreamId: 'ws-c', cosineDistance: 1.4142135623730951 }, // sqrt(2) -> sim 0
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

  it('caps at the top 3 candidates', async () => {
    const hits = ['ws-1', 'ws-2', 'ws-3', 'ws-4'].map((workstreamId, i) => ({
      prototypeId: `p${String(i)}`,
      workstreamId,
      cosineDistance: i * 0.1,
    }));
    const lane = await buildPrototypeLane({
      title: 't',
      store: storeWithHits(hits),
      embed: fixedEmbed,
      embedderUsable: true,
    });
    expect(lane.candidates).toHaveLength(3);
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
// covers the new lane id, end to end through the real scorer.

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
});
