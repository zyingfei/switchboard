// Unit coverage for the path-independent similarity corpus assembly
// (connections/similarityCorpus.ts). Verifies option (b)'s two contracts:
//   1. When a typed event source is present, the corpus is assembled from the
//      typed read (path-independent), and the signature is stable across
//      re-orderings + advances only on content change.
//   2. When the typed source is null (event store off), it falls back to the
//      caller's window events byte-identically (W5 — default-off is unchanged).

import { describe, expect, it } from 'vitest';

import {
  buildEligibleSimilarityCorpus,
  CORPUS_SOURCE_TYPES,
  type SimilarityCorpusBuilders,
} from './similarityCorpus.js';
import type { EngagementClassifierInput } from './engagementClassifier.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventStore } from '../sync/eventStore.js';
import type { TimelineDayProjectionWithDimensions } from '../timeline/timelineDays.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';

const evt = (seq: number, type: string, canonicalUrl: string): AcceptedEvent => ({
  clientEventId: `evt-${String(seq)}`,
  dot: { replicaId: 'r', seq },
  deps: {},
  aggregateId: 'agg',
  type,
  payload: { canonicalUrl, url: canonicalUrl },
  acceptedAtMs: 1000 + seq,
});

// Minimal deterministic builders — one timeline day, one entry per distinct
// canonicalUrl seen in a BROWSER_TIMELINE_OBSERVED event, engagement folded
// straight through. Enough to exercise the assembly + signature.
const makeBuilders = (): SimilarityCorpusBuilders => ({
  buildTimelineDays: (events): readonly TimelineDayProjectionWithDimensions[] => {
    const byUrl = new Map<string, AcceptedEvent>();
    for (const e of events) {
      if (e.type !== BROWSER_TIMELINE_OBSERVED) continue;
      const url = (e.payload as { canonicalUrl: string }).canonicalUrl;
      byUrl.set(url, e);
    }
    if (byUrl.size === 0) return [];
    return [
      {
        day: '2026-07-24',
        updatedAt: '2026-07-24T00:00:00.000Z',
        entries: [...byUrl.keys()].map((url) => ({
          id: `entry-${url}`,
          canonicalUrl: url,
          url,
          title: url,
          lastSeenAt: '2026-07-24T00:00:00.000Z',
          dimensions: { engagement: { focusedWindowMs: 6000 } },
        })),
      } as unknown as TimelineDayProjectionWithDimensions,
    ];
  },
  buildEngagementClassifierInputs: (): readonly EngagementClassifierInput[] => [],
  enrichTimelineDaysWithEngagement: (days) => days,
});

const forEachChunkOfTypesFor =
  (events: readonly AcceptedEvent[]): EventStore['forEachChunkOfTypes'] =>
  async (types, cb) => {
    const matching = events.filter((e) => types.includes(e.type));
    await cb(matching);
  };

const stubStore = (events: readonly AcceptedEvent[]): EventStore =>
  ({
    forEachChunkOfTypes: forEachChunkOfTypesFor(events),
  }) as unknown as EventStore;

describe('buildEligibleSimilarityCorpus', () => {
  it('assembles the full corpus from the typed store (path-independent)', async () => {
    const events = [
      evt(1, BROWSER_TIMELINE_OBSERVED, 'https://a.test/'),
      evt(2, BROWSER_TIMELINE_OBSERVED, 'https://b.test/'),
      evt(3, 'engagement.session.aggregated', 'https://a.test/'),
      evt(4, 'unrelated.type', 'https://c.test/'),
    ];
    const result = await buildEligibleSimilarityCorpus({
      typedEventSource: stubStore(events),
      fallbackMerged: [],
      builders: makeBuilders(),
    });
    expect(result.assembledFromTypedStore).toBe(true);
    // Two distinct timeline visits (a, b) — the unrelated type is ignored.
    expect(result.entries.map((e) => e.canonicalUrl).sort()).toEqual([
      'https://a.test/',
      'https://b.test/',
    ]);
    expect(result.enrichedDays.flatMap((d) => d.entries)).toEqual(result.entries);
    expect(result.corpusSignature).toContain('corpus:2:');
  });

  it('only reads CORPUS_SOURCE_TYPES from the typed store', async () => {
    const seenTypes: string[][] = [];
    const store = {
      forEachChunkOfTypes: async (
        types: readonly string[],
        cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
      ): Promise<void> => {
        seenTypes.push([...types]);
        await cb([]);
      },
    } as unknown as EventStore;
    await buildEligibleSimilarityCorpus({
      typedEventSource: store,
      fallbackMerged: [],
      builders: makeBuilders(),
    });
    expect(seenTypes).toEqual([[...CORPUS_SOURCE_TYPES]]);
  });

  it('produces an order-independent signature (re-ordered corpus → same signature)', async () => {
    const a = await buildEligibleSimilarityCorpus({
      typedEventSource: stubStore([
        evt(1, BROWSER_TIMELINE_OBSERVED, 'https://a.test/'),
        evt(2, BROWSER_TIMELINE_OBSERVED, 'https://b.test/'),
      ]),
      fallbackMerged: [],
      builders: makeBuilders(),
    });
    const b = await buildEligibleSimilarityCorpus({
      typedEventSource: stubStore([
        evt(2, BROWSER_TIMELINE_OBSERVED, 'https://b.test/'),
        evt(1, BROWSER_TIMELINE_OBSERVED, 'https://a.test/'),
      ]),
      fallbackMerged: [],
      builders: makeBuilders(),
    });
    expect(a.corpusSignature).toBe(b.corpusSignature);
  });

  it('advances the signature when the corpus content changes', async () => {
    const two = await buildEligibleSimilarityCorpus({
      typedEventSource: stubStore([
        evt(1, BROWSER_TIMELINE_OBSERVED, 'https://a.test/'),
        evt(2, BROWSER_TIMELINE_OBSERVED, 'https://b.test/'),
      ]),
      fallbackMerged: [],
      builders: makeBuilders(),
    });
    const three = await buildEligibleSimilarityCorpus({
      typedEventSource: stubStore([
        evt(1, BROWSER_TIMELINE_OBSERVED, 'https://a.test/'),
        evt(2, BROWSER_TIMELINE_OBSERVED, 'https://b.test/'),
        evt(3, BROWSER_TIMELINE_OBSERVED, 'https://c.test/'),
      ]),
      fallbackMerged: [],
      builders: makeBuilders(),
    });
    expect(three.corpusSignature).not.toBe(two.corpusSignature);
  });

  // Runtime-agility guard (doctrine rule 9): the corpus assembly + signature
  // must scale ~linearly. The materializer runs this on EVERY store-backed
  // drain (the per-instance reuse cache was removed — it was dead under the
  // production child-fork model), so a regression that reintroduced a full-log
  // scan or an O(n^2) signature hash would silently return the per-nav CPU
  // class. The live corpus is ~9k eligible visits over ~26k corpus-source
  // events; exercise ~5k distinct visits here (well above the 5-visit W4(d)
  // fixture that could not see this cost) and assert a scale-appropriate wall
  // bound. This runs the FULL assembly pipeline (typed read stub + builders +
  // computeCorpusSignature over every entry) each call.
  it('assembles + signs a mid-scale corpus (~5k visits) within a linear-time budget', async () => {
    const events: AcceptedEvent[] = [];
    for (let i = 0; i < 5000; i += 1) {
      events.push(evt(i, BROWSER_TIMELINE_OBSERVED, `https://scale.test/page-${String(i)}`));
    }
    const startedAt = performance.now();
    const result = await buildEligibleSimilarityCorpus({
      typedEventSource: stubStore(events),
      fallbackMerged: [],
      builders: makeBuilders(),
    });
    const elapsedMs = performance.now() - startedAt;
    expect(result.entries).toHaveLength(5000);
    expect(result.corpusSignature).toContain('corpus:5000:');
    // 5k distinct visits assembled + hashed. A linear pass over this is a few
    // ms; 500ms is a generous ceiling that a quadratic regression (25M ops)
    // would blow well past while leaving ample headroom for CI jitter.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('falls back to the window events byte-identically when the typed store is null (W5)', async () => {
    const windowEvents = [
      evt(1, BROWSER_TIMELINE_OBSERVED, 'https://a.test/'),
      evt(2, BROWSER_TIMELINE_OBSERVED, 'https://b.test/'),
    ];
    const builders = makeBuilders();
    const result = await buildEligibleSimilarityCorpus({
      typedEventSource: null,
      fallbackMerged: windowEvents,
      builders,
    });
    expect(result.assembledFromTypedStore).toBe(false);
    // Byte-identical to running the builders directly over the window events.
    const days = builders.buildTimelineDays(windowEvents);
    const engagement = builders.buildEngagementClassifierInputs(windowEvents, days);
    const expected = builders.enrichTimelineDaysWithEngagement(days, engagement).flatMap(
      (d) => d.entries,
    );
    expect(result.entries).toEqual(expected);
  });
});
