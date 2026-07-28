import { describe, expect, it } from 'bun:test';

import { appendAiLane, appendContentLane } from './contentLane.js';
import type { ConnectionsSnapshot } from '../connections/types.js';

// LANE 8 — 'ai'. Asked for directly: "can you show a guess lane for ai" /
// "what should i expect for ai guess lane? make it explicit please".
//
// The gist was already folded into the CONTENT lane's query text, so the AI's
// contribution was real but invisible — the lane said "8 matches (...)" and a
// reader could not tell what the model's reading had added. Lane 8 asks the
// same corpus with the GIST ALONE, so the difference between lane 7 and lane 8
// IS the AI's marginal effect.
//
// What it is NOT: a judgement, and not an input to fusion. Guess lanes are
// disclosure; this cannot file anything by itself.

interface Hit {
  entityId: string;
  canonicalUrl: string;
  title: string;
  bodyIndexed: number;
}

// A store that records what it was ASKED, so the test can assert the query
// text rather than trusting it.
const recordingStore = (hits: readonly Hit[]) => {
  const ftsQueries: string[] = [];
  const embedded: string[] = [];
  return {
    ftsQueries,
    embedded,
    store: {
      vectorBackendAvailable: true,
      queryByCanonicalUrl: () => [],
      queryVector: () => hits,
      queryFts: (args: { query: string }) => {
        ftsQueries.push(args.query);
        return hits;
      },
    } as never,
    embed: async (text: string) => {
      embedded.push(text);
      return new Float32Array([1, 0, 0]);
    },
  };
};

const SNAPSHOT = { nodes: [], edges: [] } as unknown as ConnectionsSnapshot;
const RESULT = { lanes: [] as never[] };

const HITS: Hit[] = [
  {
    entityId: 'e1',
    canonicalUrl: 'https://example.test/attention',
    title: 'Linear attention architectures',
    bodyIndexed: 1,
  },
];

const GIST =
  'Kimi Linear is a hybrid linear attention architecture using Kimi Delta Attention ' +
  'to reduce KV cache usage and raise decoding throughput.';

const depsFor = (r: ReturnType<typeof recordingStore>) => ({
  store: r.store,
  embed: r.embed,
  embedderUsable: true,
  guessLanesEnabled: true,
  lookupWorkstreamByUrl: () => 'WS_ATTENTION',
});

describe('lane 8 — the AI lane', () => {
  it('queries with the GIST ALONE — no title, no URL tokens', async () => {
    const r = recordingStore(HITS);
    await appendAiLane(
      RESULT,
      {
        canonicalUrl: 'https://arxiv.org/abs/2510.26692',
        snapshot: SNAPSHOT,
        title: '[2510.26692] Kimi Linear: An Expressive, Efficient Attention Architecture',
        gist: GIST,
      },
      depsFor(r),
    );
    // The embed text is the gist and nothing else. If the title leaked in, this
    // lane would just be the content lane wearing a different label.
    expect(r.embedded.length).toBeGreaterThan(0);
    expect(r.embedded[0]).toBe(GIST);
    expect(r.embedded[0]).not.toContain('2510.26692');
    expect(r.embedded[0]).not.toContain('arxiv');
  });

  it('the CONTENT lane still queries with gist + title + url — they are different questions', async () => {
    const r = recordingStore(HITS);
    await appendContentLane(
      RESULT,
      {
        canonicalUrl: 'https://arxiv.org/abs/2510.26692',
        snapshot: SNAPSHOT,
        title: 'Kimi Linear paper',
        gist: GIST,
      },
      depsFor(r),
    );
    expect(r.embedded[0]).toContain('Kimi Linear paper');
  });

  it('is labelled "ai" and appended, never replacing the content lane', async () => {
    const r = recordingStore(HITS);
    const withContent = await appendContentLane(
      RESULT,
      { canonicalUrl: 'https://x.test/a', snapshot: SNAPSHOT, title: 'T', gist: GIST },
      depsFor(r),
    );
    const withBoth = await appendAiLane(
      withContent,
      { canonicalUrl: 'https://x.test/a', snapshot: SNAPSHOT, title: 'T', gist: GIST },
      depsFor(r),
    );
    expect(withBoth.lanes.map((l) => l.lane)).toEqual(['content', 'ai']);
  });

  it('SAYS why it is empty when there is no gist, rather than vanishing', async () => {
    // A silently absent lane is indistinguishable from a broken one.
    const r = recordingStore(HITS);
    const out = await appendAiLane(
      RESULT,
      { canonicalUrl: 'https://x.test/a', snapshot: SNAPSHOT, title: 'T', gist: null },
      depsFor(r),
    );
    const lane = out.lanes.find((l) => l.lane === 'ai');
    expect(lane).toBeDefined();
    expect(lane?.candidates).toHaveLength(0);
    expect(lane?.emptyReason).toContain('gist');
    // ...and it must not have spent an embed on a page it cannot speak about.
    expect(r.embedded).toHaveLength(0);
  });

  it('is idempotent — re-appending replaces rather than duplicating', async () => {
    const r = recordingStore(HITS);
    const input = { canonicalUrl: 'https://x.test/a', snapshot: SNAPSHOT, title: 'T', gist: GIST };
    const once = await appendAiLane(RESULT, input, depsFor(r));
    const twice = await appendAiLane(once, input, depsFor(r));
    expect(twice.lanes.filter((l) => l.lane === 'ai')).toHaveLength(1);
  });

  it('is absent entirely when guess lanes are off — no new surface behind the flag', async () => {
    const r = recordingStore(HITS);
    const out = await appendAiLane(
      RESULT,
      { canonicalUrl: 'https://x.test/a', snapshot: SNAPSHOT, title: 'T', gist: GIST },
      { ...depsFor(r), guessLanesEnabled: false },
    );
    expect(out.lanes).toHaveLength(0);
  });
});
