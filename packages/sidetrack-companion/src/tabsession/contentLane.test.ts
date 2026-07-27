import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import {
  __resetContentLaneLru,
  appendContentLane,
  buildContentLane,
  type ContentFtsHit,
  type ContentLaneStore,
  type ContentVectorHit,
} from './contentLane.js';
import type { GuessLaneResult } from './guessLanes.js';

// ---- fixtures ---------------------------------------------------------

const DIM = 384;
const vecOf = (seed: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[0] = seed;
  return v;
};

// A snapshot with two workstreams: ws_alpha (via a URL visit edge) and ws_beta
// (via a thread edge). Used for the workstream join.
const snapshot = (): ConnectionsSnapshot => ({
  scope: {},
  nodes: [
    {
      id: 'timeline-visit:https://alpha.test/one',
      kind: 'timeline-visit',
      label: 'Alpha One',
      originReplicaIds: [],
      metadata: { canonicalUrl: 'https://alpha.test/one', title: 'Alpha One' },
    },
    {
      id: 'timeline-visit:https://alpha.test/two',
      kind: 'timeline-visit',
      label: 'Alpha Two',
      originReplicaIds: [],
      metadata: { canonicalUrl: 'https://alpha.test/two', title: 'Alpha Two' },
    },
    {
      id: 'thread:thread-beta',
      kind: 'thread',
      label: 'Beta thread',
      originReplicaIds: [],
      metadata: {},
    },
    { id: 'workstream:ws_alpha', kind: 'workstream', label: 'Alpha', originReplicaIds: [], metadata: {} },
    { id: 'workstream:ws_beta', kind: 'workstream', label: 'Beta', originReplicaIds: [], metadata: {} },
  ],
  edges: [
    {
      id: 'edge:visit_in_workstream:timeline-visit:https://alpha.test/one:workstream:ws_alpha',
      kind: 'visit_in_workstream',
      fromNodeId: 'timeline-visit:https://alpha.test/one',
      toNodeId: 'workstream:ws_alpha',
      observedAt: '2026-07-01T00:00:00.000Z',
      producedBy: { source: 'event-log' },
      confidence: 'asserted',
    },
    {
      id: 'edge:visit_in_workstream:timeline-visit:https://alpha.test/two:workstream:ws_alpha',
      kind: 'visit_in_workstream',
      fromNodeId: 'timeline-visit:https://alpha.test/two',
      toNodeId: 'workstream:ws_alpha',
      observedAt: '2026-07-01T00:00:00.000Z',
      producedBy: { source: 'event-log' },
      confidence: 'asserted',
    },
    {
      id: 'edge:thread_in_workstream:thread:thread-beta:workstream:ws_beta',
      kind: 'thread_in_workstream',
      fromNodeId: 'thread:thread-beta',
      toNodeId: 'workstream:ws_beta',
      observedAt: '2026-07-01T00:00:00.000Z',
      producedBy: { source: 'event-log' },
      confidence: 'asserted',
    },
  ],
  updatedAt: '2026-07-01T00:00:00.000Z',
  nodeCount: 5,
  edgeCount: 3,
  snapshotRevision: 'rev-content-test',
});

// A configurable fake store. All methods default to empty; each test overrides
// what it needs. `vectorBackendAvailable` gates whether the query-vector path
// even runs.
interface FakeStoreOpts {
  vectorBackendAvailable?: boolean;
  ownRows?: readonly ContentFtsHit[];
  vectorHits?: readonly ContentVectorHit[];
  chunkHits?: readonly (ContentVectorHit & { pooledChunkCount: number })[];
  ftsHits?: readonly ContentFtsHit[];
  withChunk?: boolean;
}
const fakeStore = (
  opts: FakeStoreOpts,
): ContentLaneStore & {
  queryVector: ReturnType<typeof vi.fn>;
  queryFts: ReturnType<typeof vi.fn>;
  queryByCanonicalUrl: ReturnType<typeof vi.fn>;
} => {
  const base = {
    vectorBackendAvailable: opts.vectorBackendAvailable ?? true,
    queryByCanonicalUrl: vi.fn(() => opts.ownRows ?? []),
    queryVector: vi.fn(() => opts.vectorHits ?? []),
    queryFts: vi.fn(() => opts.ftsHits ?? []),
  };
  return opts.withChunk === true
    ? (Object.assign(base, { queryChunkVector: vi.fn(() => opts.chunkHits ?? []) }) as never)
    : (base as never);
};

const vhit = (
  entityId: string,
  canonicalUrl: string | undefined,
  title: string | undefined,
  bodyIndexed: 0 | 1,
): ContentVectorHit => ({ entityId, canonicalUrl, title, cosineDistance: 0.1, bodyIndexed });

const fhit = (
  entityId: string,
  canonicalUrl: string | undefined,
  title: string | undefined,
  extra: Partial<ContentFtsHit> = {},
): ContentFtsHit => ({ entityId, canonicalUrl, title, bm25: 1, ...extra });

afterEach(() => {
  __resetContentLaneLru();
});

describe('buildContentLane', () => {
  it('(4) no title + not indexed → typed empty', async () => {
    const store = fakeStore({}); // vector backend on, nothing indexed, no hits
    const embed = vi.fn(async () => vecOf(1));
    const lane = await buildContentLane({
      canonicalUrl: 'https://novel.test/x',
      snapshot: snapshot(),
      title: null,
      store,
      embed,
      embedderUsable: true,
    });
    expect(lane.candidates).toHaveLength(0);
    expect(lane.emptyReason).toBe('no title to compare and page not indexed');
  });

  it('(3) embedder cold → lexical-only, no embed call', async () => {
    const embed = vi.fn(async () => vecOf(1));
    const store = fakeStore({
      ftsHits: [fhit('e1', 'https://alpha.test/two', 'Alpha Two', { bodyIndexed: 1 })],
    });
    const lane = await buildContentLane({
      canonicalUrl: 'https://query.test/x',
      snapshot: snapshot(),
      title: 'AWS CloudTrail',
      store,
      embed,
      embedderUsable: false, // cold
    });
    // No vector query attempted when the embedder is not usable.
    expect(embed).not.toHaveBeenCalled();
    expect(store.queryVector).not.toHaveBeenCalled();
    // FTS still produced a hit that joins to ws_alpha.
    expect(lane.candidates.map((c) => c.workstreamId)).toEqual(['ws_alpha']);
  });

  it('(3b) embedder cold AND no lexical hits → embedder-cold typed empty', async () => {
    const store = fakeStore({});
    const lane = await buildContentLane({
      canonicalUrl: 'https://query.test/x',
      snapshot: snapshot(),
      title: 'nothing matches this',
      store,
      embedderUsable: false,
    });
    expect(lane.emptyReason).toBe('embedder cold — no lexical matches');
  });

  it('(2) un-indexed + titleHint + warm embedder → embed path, LRU hit on 2nd call', async () => {
    const embed = vi.fn(async () => vecOf(7));
    const store = fakeStore({
      vectorHits: [vhit('v1', 'https://alpha.test/one', 'Alpha One', 1)],
    });
    const args = {
      canonicalUrl: 'https://query.test/topic',
      snapshot: snapshot(),
      title: 'Alpha topic',
      store,
      embed,
      embedderUsable: true,
    } as const;
    const first = await buildContentLane(args);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(store.queryVector).toHaveBeenCalledTimes(1);
    expect(first.candidates.map((c) => c.workstreamId)).toEqual(['ws_alpha']);
    // Second call, same url+title ⇒ LRU hit, no second embed.
    const second = await buildContentLane(args);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(second.candidates.map((c) => c.workstreamId)).toEqual(['ws_alpha']);
  });

  it('(1) indexed page classified via its own rows; own rows excluded from KNN', async () => {
    const embed = vi.fn(async () => vecOf(3));
    const store = fakeStore({
      ownRows: [fhit('own-1', 'https://alpha.test/one', 'Alpha One', { bodyIndexed: 1 })],
      vectorHits: [vhit('v2', 'https://alpha.test/two', 'Alpha Two', 1)],
    });
    const lane = await buildContentLane({
      canonicalUrl: 'https://alpha.test/one',
      snapshot: snapshot(),
      title: 'Alpha One',
      store,
      embed,
      embedderUsable: true,
    });
    // Own rows are read (classification) and passed as the KNN exclude set.
    expect(store.queryByCanonicalUrl).toHaveBeenCalled();
    const knnArgs = store.queryVector.mock.calls[0]?.[0] as {
      excludeEntityIds: ReadonlySet<string>;
    };
    expect(knnArgs.excludeEntityIds.has('own-1')).toBe(true);
    expect(lane.candidates.map((c) => c.workstreamId)).toEqual(['ws_alpha']);
  });

  it('(5) RRF aggregation + normalization + top-3', async () => {
    // ws_alpha gets 2 hits (both rankings), ws_beta gets 1 (fts only). Alpha's
    // summed RRF is higher ⇒ normalized to 1.0; beta < 1.0.
    const embed = vi.fn(async () => vecOf(9));
    const store = fakeStore({
      vectorHits: [
        vhit('a1', 'https://alpha.test/one', 'Alpha One', 1),
        vhit('a2', 'https://alpha.test/two', 'Alpha Two', 1),
      ],
      ftsHits: [
        fhit('a1', 'https://alpha.test/one', 'Alpha One', { bodyIndexed: 1 }),
        fhit('b1', undefined, 'Beta doc', { threadId: 'thread-beta', bodyIndexed: 1 }),
      ],
    });
    const lane = await buildContentLane({
      canonicalUrl: 'https://query.test/multi',
      snapshot: snapshot(),
      title: 'multi topic',
      store,
      embed,
      embedderUsable: true,
    });
    expect(lane.candidates.map((c) => c.workstreamId)).toEqual(['ws_alpha', 'ws_beta']);
    expect(lane.candidates[0]!.score).toBeCloseTo(1, 5);
    expect(lane.candidates[1]!.score).toBeLessThan(1);
    expect(lane.candidates[1]!.score).toBeGreaterThan(0);
    // why names count + up to 2 titles; content provenance (bodyIndexed=1) ⇒ no
    // title-vector marker.
    expect(lane.candidates[0]!.why).toContain('2 matches');
    expect(lane.candidates[0]!.why).not.toContain('title-vector');
  });

  it('(5b) top-3 cap + title-vector provenance when all hits are title-only', async () => {
    const embed = vi.fn(async () => vecOf(4));
    // Four workstreams' worth of hits would exceed the cap; here 1 ws with a
    // title-only (bodyIndexed=0) hit ⇒ the why must say title-vector.
    const store = fakeStore({
      ftsHits: [fhit('t1', 'https://alpha.test/one', 'Alpha One', { bodyIndexed: 0 })],
    });
    const lane = await buildContentLane({
      canonicalUrl: 'https://query.test/tv',
      snapshot: snapshot(),
      title: 'Alpha',
      store,
      embed,
      embedderUsable: true,
    });
    expect(lane.candidates).toHaveLength(1);
    expect(lane.candidates[0]!.why).toContain('title-vector');
  });

  it('(6) workstream join drops unattributed hits', async () => {
    const embed = vi.fn(async () => vecOf(5));
    // Two hits: one attributed (alpha/one → ws_alpha), one to a URL with no
    // workstream edge (dropped).
    const store = fakeStore({
      vectorHits: [
        vhit('u1', 'https://alpha.test/one', 'Alpha One', 1),
        vhit('u2', 'https://unattributed.test/x', 'Orphan', 1),
      ],
    });
    const lane = await buildContentLane({
      canonicalUrl: 'https://query.test/drop',
      snapshot: snapshot(),
      title: 'topic',
      store,
      embed,
      embedderUsable: true,
    });
    expect(lane.candidates.map((c) => c.workstreamId)).toEqual(['ws_alpha']);
    // Only the single attributed hit counted.
    expect(lane.candidates[0]!.why).toContain('1 match');
  });

  it('(6b) ALL hits unattributed → typed empty says matches were found (not "nothing matches")', async () => {
    // The live beyondloom probe hit this: /v2 finds real neighbors (the HN
    // Decker thread) but none are filed anywhere, and the lane reported
    // "nothing indexed matches this page yet" — conflating a retrieval miss
    // with label sparsity. The reason must count the matches and point at
    // filing, not indexing.
    const embed = vi.fn(async () => vecOf(5));
    const store = fakeStore({
      vectorHits: [
        vhit('u1', 'https://unattributed.test/a', 'Orphan A', 1),
        vhit('u2', 'https://unattributed.test/b', 'Orphan B', 1),
      ],
    });
    const lane = await buildContentLane({
      canonicalUrl: 'https://query.test/all-dropped',
      snapshot: snapshot(),
      title: 'topic',
      store,
      embed,
      embedderUsable: true,
    });
    expect(lane.candidates).toEqual([]);
    expect(lane.emptyReason).toBe('2 similar pages found, none filed to a workstream yet');
  });

  it('(6c) joins neighbors through the PROJECTION lookup even when the scoped snapshot has no edges for them [the hatchet.run case]', async () => {
    // Live falsification (user-caught, 2026-07-27): hatchet.run/blog/
    // postgres-survival-guide was user-filed, yet the lane said "none filed"
    // — the resolver's snapshot is scoped to the QUERY url, so neighbor
    // membership edges are absent from it. The authoritative URL projection
    // lookup must be consulted first; slash variants must both hit.
    const embed = vi.fn(async () => vecOf(5));
    const store = fakeStore({
      vectorHits: [
        vhit('u1', 'https://hatchet.run/blog/postgres-survival-guide', 'Postgres survival guide', 1),
        // Projection stores the trailing-slash spelling for this one — the
        // slash-variant discipline must still join it.
        vhit('u2', 'https://openai.com/index/scaling-postgresql', 'Scaling PostgreSQL', 1),
      ],
    });
    const filed = new Map<string, string>([
      ['https://hatchet.run/blog/postgres-survival-guide', 'ws_pg'],
      ['https://openai.com/index/scaling-postgresql/', 'ws_pg'],
    ]);
    const lane = await buildContentLane({
      canonicalUrl: 'https://github.com/NikolayS/PGSimCity',
      // Deliberately an EMPTY snapshot: the scoped subgraph carries no
      // neighbor membership edges — the projection lookup must carry the join.
      snapshot: snapshot(),
      title: 'PGSimCity postgres',
      store,
      embed,
      embedderUsable: true,
      lookupWorkstreamByUrl: (url) => filed.get(url),
    });
    expect(lane.candidates.map((c) => c.workstreamId)).toEqual(['ws_pg']);
    expect(lane.candidates[0]!.why).toContain('2 matches');
  });

  it('recall store unavailable → typed empty', async () => {
    const lane = await buildContentLane({
      canonicalUrl: 'https://x.test/y',
      snapshot: snapshot(),
      title: 'anything',
      store: undefined,
      embedderUsable: true,
    });
    expect(lane.emptyReason).toBe('recall store unavailable');
  });

  it('prefers chunk KNN when supported, falls back to doc KNN when chunk empty', async () => {
    const embed = vi.fn(async () => vecOf(2));
    const store = fakeStore({
      withChunk: true,
      chunkHits: [], // chunk KNN empty ⇒ fall back to doc KNN
      vectorHits: [vhit('c1', 'https://alpha.test/one', 'Alpha One', 1)],
    });
    const lane = await buildContentLane({
      canonicalUrl: 'https://query.test/chunk',
      snapshot: snapshot(),
      title: 'Alpha',
      store,
      embed,
      embedderUsable: true,
    });
    expect(store.queryVector).toHaveBeenCalledTimes(1);
    expect(lane.candidates.map((c) => c.workstreamId)).toEqual(['ws_alpha']);
  });
});

describe('appendContentLane', () => {
  const sixLane: GuessLaneResult[] = [
    { lane: 'graph', candidates: [], emptyReason: 'x' },
    { lane: 'similarity', candidates: [], emptyReason: 'x' },
    { lane: 'topic', candidates: [], emptyReason: 'x' },
    { lane: 'title', candidates: [], emptyReason: 'x' },
    { lane: 'domain', candidates: [], emptyReason: 'x' },
    { lane: 'recency', candidates: [], emptyReason: 'x' },
  ];

  it('(7) SIDETRACK_CONTENT_LANE=0 → six-lane array untouched', async () => {
    const prior = process.env['SIDETRACK_CONTENT_LANE'];
    process.env['SIDETRACK_CONTENT_LANE'] = '0';
    try {
      const out = await appendContentLane(
        { lanes: sixLane },
        { canonicalUrl: 'https://x.test/y', snapshot: snapshot(), title: 'z' },
        { store: fakeStore({}), embedderUsable: true, guessLanesEnabled: true },
      );
      expect(out.lanes).toHaveLength(6);
      expect(out.lanes?.some((l) => l.lane === 'content')).toBe(false);
    } finally {
      if (prior === undefined) delete process.env['SIDETRACK_CONTENT_LANE'];
      else process.env['SIDETRACK_CONTENT_LANE'] = prior;
    }
  });

  it('appends content lane (7th) when enabled', async () => {
    const out = await appendContentLane(
      { lanes: sixLane },
      { canonicalUrl: 'https://x.test/y', snapshot: snapshot(), title: null },
      { store: undefined, embedderUsable: true, guessLanesEnabled: true },
    );
    expect(out.lanes?.map((l) => l.lane)).toEqual([
      'graph',
      'similarity',
      'topic',
      'title',
      'domain',
      'recency',
      'content',
    ]);
  });

  it('no-op when guess lanes are off (no lanes array)', async () => {
    const out = await appendContentLane(
      {},
      { canonicalUrl: 'https://x.test/y', snapshot: snapshot(), title: null },
      { store: undefined, embedderUsable: true, guessLanesEnabled: false },
    );
    expect(out.lanes).toBeUndefined();
  });

  it('is idempotent — replaces a prior content lane rather than duplicating', async () => {
    const withContent: GuessLaneResult[] = [
      ...sixLane,
      { lane: 'content', candidates: [], emptyReason: 'stale' },
    ];
    const out = await appendContentLane(
      { lanes: withContent },
      { canonicalUrl: 'https://x.test/y', snapshot: snapshot(), title: null },
      { store: undefined, embedderUsable: true, guessLanesEnabled: true },
    );
    expect(out.lanes?.filter((l) => l.lane === 'content')).toHaveLength(1);
  });
});

// (8) titleHints validation is exercised end-to-end in http/visitsRoutes.test.ts
// (the parse+validate lives on the batch-resolve route). Kept there so the
// oversize/invalid-ignored behavior is asserted against the real request path.
