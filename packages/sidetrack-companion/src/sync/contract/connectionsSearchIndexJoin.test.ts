// F8 W2 acceptance: the search-index stores (searchQueryIndexStore,
// captureTextFtsStore) kill the scoped-delta `pending-search-visit`
// bail (docs/plans/2026-08-16-f8-ivm-designs.md, "W2"). Root cause: a
// scoped drain builds `scopedSnapshot` from a tiny event WINDOW, so
// snapshot.ts Pass 6's `thread_text_mentions_search_query` join (query
// x all capture/dispatch/annotation text) and the ranker's
// `same_search_query` candidate join (query x all visits) can only see
// pairs entirely INSIDE that window — any cross-window pair silently
// disappears, so the old code bailed to a full rebuild whenever a
// drain window carried a search visit at all.
//
// These tests prove: with SIDETRACK_SEARCH_INDEX_STORE=1, a scoped
// drain whose window carries a search visit (or a capture that
// happens to match an existing search visit's query) produces
// `thread_text_mentions_search_query` / `closest_visit` edge sets
// byte-identical to a full rebuild, via the TRUE scoped-delta path
// (`replaceScopeRows scopedTimelineDelta`) — with no
// `buildConnectionsSnapshot base` mark on that drain. A companion
// control proves the flag actually gates this: with it off, the
// identical search-visit scenario still bails (and re-derives the
// base snapshot) today.
//
// NOTE on scope: mirrors connectionsThreadRegisterMembership.test.ts's
// structure and its "edge SET is the equivalence target" scoping note.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildConnectionsSnapshot,
  createConnectionsStore,
  type ClosestVisitRanker,
  type ConnectionsInput,
  type ConnectionsSnapshot,
  type ConnectionsStore,
} from '../../connections/snapshot.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import { CAPTURE_RECORDED } from '../../recall/events.js';
import type { RankerContributions } from '../../ranker/predict.js';
import { createEmptyTabSessionProjection } from '../../tabsession/projection.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore, type TimelineDayProjection } from '../../timeline/projection.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { type AcceptedEvent } from '../causal.js';
import { createEventLog, type EventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer, type ConnectionsMaterializer } from './connectionsMaterializer.js';

// Deterministic, near-orthogonal "embedding": maps each distinct input
// text to a one-hot vector keyed by a cheap string hash. Real cosine
// similarity is irrelevant to these tests (they exercise the
// same_search_query / thread_text_mentions_search_query joins, not
// visit_resembles_visit) — without this, the DEFAULT embedder can
// produce a genuine visit_resembles_visit edge between two
// textually-similar search-visit URLs, which trips an UNRELATED
// pre-existing mechanism (the Layer-0 similarity-floor recovery: a
// served-similarity-edge-count transition from 0 to non-zero forces a
// full base rebuild regardless of the search-index flag) and makes the
// test flaky/misleading about what it's actually proving.
const EMBED_DIM = 384; // must match RECALL_MODEL.embeddingDim (recall/modelManifest.ts)
const orthogonalEmbed: VisitSimilarityEmbedder = (texts) =>
  Promise.resolve(
    texts.map((text) => {
      let hash = 0;
      for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
      const vector = new Float32Array(EMBED_DIM);
      vector[hash % EMBED_DIM] = 1;
      return vector;
    }),
  );

const envKeys = [
  'SIDETRACK_SKIP_RANKER_SNAPSHOT',
  'SIDETRACK_CONNECTIONS_INPROCESS',
  'SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES',
  'SIDETRACK_CONNECTIONS_DRIFT_DISABLED',
  'SIDETRACK_TOPIC_PRODUCER',
  'SIDETRACK_SEARCH_INDEX_STORE',
  'SIDETRACK_CONNECTIONS_PHASE_LOG',
  'SIDETRACK_RANKER_ON_SCOPED_DELTA',
] as const;

const at = (seq: number): string => new Date(Date.parse('2026-08-16T10:00:00.000Z') + seq * 1000).toISOString();

const timelineObserved = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly url: string;
  readonly tabSessionId?: string;
  readonly deps?: Record<string, number>;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.timeline`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: `browser.timeline.observed:${input.url}`,
  type: BROWSER_TIMELINE_OBSERVED,
  payload: {
    eventId: `timeline-${input.replicaId}-${String(input.seq)}`,
    observedAt: at(input.seq),
    url: input.url,
    canonicalUrl: input.url,
    provider: 'generic',
    transition: 'activated',
    payloadVersion: 1,
    tabSessionId: input.tabSessionId ?? `tab-${input.replicaId}-${String(input.seq)}`,
    dimensions: { engagement: { focusedWindowMs: 10_000 } },
  },
  acceptedAtMs: Date.parse(at(input.seq)),
});

const captureRecorded = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly threadId?: string;
  readonly text: string;
  readonly deps?: Record<string, number>;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.capture`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: input.bacId,
  type: CAPTURE_RECORDED,
  payload: {
    bac_id: input.bacId,
    threadId: input.threadId ?? input.bacId,
    capturedAt: at(input.seq),
    turns: [{ ordinal: 0, role: 'user', text: input.text }],
  },
  acceptedAtMs: Date.parse(at(input.seq)),
});

const threadUpserted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly deps?: Record<string, number>;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.thread`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: input.bacId,
  type: THREAD_UPSERTED,
  payload: {
    bac_id: input.bacId,
    provider: 'chatgpt',
    threadUrl: `https://thread.example.test/${input.bacId}`,
    title: `${input.bacId} title`,
    lastSeenAt: at(input.seq),
  },
  acceptedAtMs: Date.parse(at(input.seq)),
});

// Manual TimelineDayProjection construction (mirrors
// connectionsIncrementalRanker.test.ts's `dayFor` helper) so
// `fullSnapshotFor` below reproduces exactly what the materializer's
// own buildTimelineDays(events) would project, without depending on
// that internal pipeline.
const dayFor = (events: readonly AcceptedEvent[]): TimelineDayProjection => {
  const entries = events
    .filter((event) => event.type === BROWSER_TIMELINE_OBSERVED)
    .map((event) => {
      const payload = event.payload as {
        readonly url: string;
        readonly canonicalUrl?: string;
        readonly tabSessionId?: string;
      };
      return {
        id: payload.canonicalUrl ?? payload.url,
        firstSeenAt: new Date(event.acceptedAtMs).toISOString(),
        lastSeenAt: new Date(event.acceptedAtMs).toISOString(),
        url: payload.url,
        canonicalUrl: payload.canonicalUrl ?? payload.url,
        visitCount: 1,
        ...(payload.tabSessionId === undefined ? {} : { tabSessionId: payload.tabSessionId }),
      };
    });
  return {
    date: '2026-08-16',
    updatedAt: entries.at(-1)?.lastSeenAt ?? at(0),
    entryCount: entries.length,
    entries,
  };
};

const emptyInput = (events: readonly AcceptedEvent[]): ConnectionsInput => ({
  events,
  threads: [],
  workstreams: [],
  dispatches: [],
  queueItems: [],
  reminders: [],
  codingSessions: [],
  timelineDays: [dayFor(events)],
  tabSessionProjection: createEmptyTabSessionProjection(),
  urlProjection: { schemaVersion: 1, byCanonicalUrl: new Map() },
});

const fullSnapshotFor = (events: readonly AcceptedEvent[]): ConnectionsSnapshot =>
  buildConnectionsSnapshot(emptyInput(events));

const searchQueryMentionEdges = (
  snapshot: ConnectionsSnapshot,
): readonly { readonly from: string; readonly to: string }[] =>
  [...snapshot.edges]
    .filter((edge) => edge.kind === 'thread_text_mentions_search_query')
    .map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId }))
    .sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));

const closestVisitEdges = (
  snapshot: ConnectionsSnapshot,
): readonly { readonly from: string; readonly to: string }[] =>
  [...snapshot.edges]
    .filter((edge) => edge.kind === 'closest_visit')
    .map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId }))
    .sort((a, b) => (a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1));

const contributions = (): RankerContributions => ({
  schemaVersion: 0,
  same_workstream: 0,
  opener_chain_depth: 0,
  in_navigation_chain: 0,
  same_canonical_url: 0,
  same_host: 0,
  same_repo: 0,
  same_search_query: 1,
  same_copied_snippet_count: 0,
  shared_title_tokens: 0,
  shared_path_tokens: 0,
  cosine_similarity: 0,
  recency_score_from: 0,
  recency_score_to: 0,
  engagement_class_match: 0,
  return_count_from: 0,
  return_count_to: 0,
  user_asserted_in_thread: 0,
  user_asserted_in_workstream: 0,
  same_active_topic: 0,
  topic_lineage_merge_split_related: 0,
  page_quality_tier_from: 0,
  page_quality_tier_to: 0,
});

const testRanker = (revisionId: string): ClosestVisitRanker => ({
  revisionId,
  threshold: 0.1,
  topK: 5,
  predict: () => ({ score: 0.9, contributions: contributions() }),
});

const liveMaterializers: ConnectionsMaterializer[] = [];

const createNoisyFreeMaterializer = (input: {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly store: ConnectionsStore;
  readonly withRanker?: boolean;
}): ConnectionsMaterializer => {
  const materializer = createConnectionsMaterializer({
    vaultRoot: input.vaultRoot,
    eventLog: input.eventLog,
    timelineStore: createTimelineStore(input.vaultRoot),
    store: input.store,
    embed: orthogonalEmbed,
    rankerRetrainer: () =>
      Promise.resolve({
        status: 'skipped',
        reason: 'no-labels',
        fingerprint: { hash: 'empty', labelCount: 0, positiveLabelCount: 0, negativeLabelCount: 0 },
        newLabelCount: 0,
      }),
    ...(input.withRanker === true
      ? {
          closestVisitRankerLoader: () =>
            Promise.resolve({
              status: 'ready' as const,
              activeRevisionId: 'ranker-rev-1',
              ranker: testRanker('ranker-rev-1'),
              model: { dispose: () => undefined } as never,
            }),
        }
      : {}),
    diagnosticsStore: { write: async () => undefined },
    diagnosticsLogger: () => {},
  });
  liveMaterializers.push(materializer);
  return materializer;
};

const importEvents = async (eventLog: EventLog, events: readonly AcceptedEvent[]): Promise<void> => {
  for (const accepted of events) await eventLog.importPeerEvent(accepted);
};

// Captures every console.warn line emitted DURING fn (the phase-log
// channel the materializer uses — see connectionsThreadRegisterMembership.
// test.ts's identical pattern) without silencing it for the rest of the
// suite.
const capturePhaseLog = async (fn: () => Promise<void>): Promise<string> => {
  const output: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown, ...rest: unknown[]): void => {
    output.push([String(message ?? ''), ...rest.map((value) => String(value))].join(' '));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return output.join('\n');
};

describe('F8 W2 — search-index stores kill the pending-search-visit bail', () => {
  let vaultRoot: string;
  let previousEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-search-index-join-'));
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = '1';
    process.env['SIDETRACK_CONNECTIONS_DRIFT_DISABLED'] = '1';
    process.env['SIDETRACK_TOPIC_PRODUCER'] = 'union-find';
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    delete process.env['SIDETRACK_RANKER_ON_SCOPED_DELTA'];
  });

  afterEach(async () => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const materializer of liveMaterializers.splice(0)) {
      await materializer.awaitIdle();
    }
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('scoped drain adding a search visit mints thread_text_mentions_search_query against an existing capture, matching a full rebuild', async () => {
    process.env['SIDETRACK_SEARCH_INDEX_STORE'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = captureRecorded({
      replicaId: 'A',
      seq: 1,
      bacId: 'T1',
      threadId: 'T1',
      text: 'we should study the quantum widget rollout metrics before shipping',
    });
    await importEvents(eventLog, [founding]);
    await materializer.catchUp(eventLog);

    // Drain 2's window carries ONLY the new search visit — the founding
    // capture (whose text the query must be matched against) has
    // already scrolled out of the drain window. The OLD gate bails to
    // a full rebuild on ANY window containing a search visit; the
    // search-index stores instead supply the cross-window join.
    const newSearchVisit = timelineObserved({
      replicaId: 'A',
      seq: 2,
      url: 'https://www.google.test/search?q=quantum+widget',
      deps: { A: 1 },
    });
    await importEvents(eventLog, [newSearchVisit]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).not.toContain('buildConnectionsSnapshot base');
    expect(phase).toContain('replaceScopeRows scopedTimelineDelta');

    const incremental = await store.readCurrent();
    if (incremental === null) throw new Error('expected scoped incremental snapshot');
    const full = fullSnapshotFor([founding, newSearchVisit]);
    // Sanity: the scenario really does cross a window boundary — the
    // full rebuild must actually produce the edge, or this test proves
    // nothing.
    expect(searchQueryMentionEdges(full)).toHaveLength(1);
    expect(searchQueryMentionEdges(incremental)).toEqual(searchQueryMentionEdges(full));
  });

  it('scoped drain adding a capture mints thread_text_mentions_search_query against an existing search-visit query, matching a full rebuild', async () => {
    process.env['SIDETRACK_SEARCH_INDEX_STORE'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = timelineObserved({
      replicaId: 'A',
      seq: 1,
      url: 'https://www.google.test/search?q=widget+catalog',
    });
    await importEvents(eventLog, [founding]);
    await materializer.catchUp(eventLog);

    // Drain 2's window carries a brand-new thread (T2, established the
    // same drain — collectScopedEventsForDelta requires SOME
    // navigation/thread signal to admit a capture into the scoped
    // build at all; a bare capture with no accompanying signal is a
    // pre-existing, orthogonal gap, not something W2 changes) plus a
    // capture on it — the founding search visit (whose query the
    // capture's text happens to mention) has already scrolled out of
    // the drain window, and this window contains no search visit at
    // all (so the OLD code never bailed here — this exercises the
    // reverse-join bound specifically, not the pending-search-visit
    // gate).
    const newThread = threadUpserted({ replicaId: 'A', seq: 2, bacId: 'T2', deps: { A: 1 } });
    const newCapture = captureRecorded({
      replicaId: 'A',
      seq: 3,
      bacId: 'T2',
      threadId: 'T2',
      text: "let's review the widget catalog before the launch review",
      deps: { A: 2 },
    });
    await importEvents(eventLog, [newThread, newCapture]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).not.toContain('buildConnectionsSnapshot base');
    expect(phase).toContain('replaceScopeRows scopedTimelineDelta');

    const incremental = await store.readCurrent();
    if (incremental === null) throw new Error('expected scoped incremental snapshot');
    const full = fullSnapshotFor([founding, newThread, newCapture]);
    expect(searchQueryMentionEdges(full)).toHaveLength(1);
    expect(searchQueryMentionEdges(incremental)).toEqual(searchQueryMentionEdges(full));
  });

  // NOT an equivalence test — see connectionsMaterializer.ts's
  // `searchQuerySiblingVisitIds` comment ("KNOWN LIMITATION"). On a
  // WARM drain (this scenario), `input.events` is only the pending
  // window, so closestVisitRankerEdgesForSnapshot's candidate
  // generation cannot discover a same_search_query pairing whose
  // OTHER endpoint's originating event isn't in that window — no
  // matter how the ranker frontier is seeded. This is a PRE-EXISTING
  // limitation of the ranker-frontier augmentation itself
  // (canUseIncrementalRanker takes the same narrow-frontier path
  // whether the base snapshot came from a scoped delta or the old
  // full-rebuild fallback — both share the same `input.events`), not
  // something the pending-search-visit bail's removal regresses or
  // was ever able to fix. This test documents that the scoped path
  // still runs cleanly (no crash, no base rebuild) and does not
  // silently invent a wrong edge — it asserts the CURRENT (unresolved)
  // behavior, not a false equivalence claim.
  it('scoped drain adding a search visit takes the scoped path cleanly; same_search_query siblings from a warm drain remain a documented residual', async () => {
    process.env['SIDETRACK_SEARCH_INDEX_STORE'] = '1';
    delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store, withRanker: true });

    const founding = timelineObserved({
      replicaId: 'A',
      seq: 1,
      url: 'https://www.google.test/search?q=widget+catalog',
      tabSessionId: 'tab-founding',
    });
    await importEvents(eventLog, [founding]);
    await materializer.catchUp(eventLog);

    // Drain 2's window carries a NEW search visit on the SAME query but
    // a DIFFERENT host (so it's a different canonical URL / visit node)
    // and a DIFFERENT tab session, workstream, and thread than the
    // founding visit — the only connecting signal is same_search_query.
    const newSearchVisit = timelineObserved({
      replicaId: 'A',
      seq: 2,
      url: 'https://www.bing.test/search?q=widget+catalog',
      tabSessionId: 'tab-new',
      deps: { A: 1 },
    });
    await importEvents(eventLog, [newSearchVisit]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    // The core W2 win: this window still takes the scoped path (no
    // full base rebuild) even though it carries a search visit.
    expect(phase).not.toContain('buildConnectionsSnapshot base');
    expect(phase).toContain('replaceScopeRows scopedTimelineDelta');

    const incremental = await store.readCurrent();
    if (incremental === null) throw new Error('expected scoped incremental snapshot');
    // Documented residual, not a regression: the OLD full-rebuild
    // fallback would ALSO have produced zero same_search_query
    // closest_visit edges here (same narrow `input.events`), so this
    // is parity with prior behavior, not a new gap.
    expect(closestVisitEdges(incremental)).toEqual([]);
  });

  it('control: with the store disabled, an identical search-visit window now DEMOTES instead of bailing to a base rebuild (F8 W3)', async () => {
    // No SIDETRACK_SEARCH_INDEX_STORE=1 — proves the flag (not some
    // unrelated fast path) is what changes drain behavior above.
    //
    // F8 W3 supersedes the interim hot-rebuild suppressor this test used
    // to exercise (docs/plans/2026-08-16-f8-ivm-designs.md, "W3"): the
    // `pending-search-visit` bail now ALWAYS demotes (progress-only write,
    // serve the PRIOR snapshot unchanged, enqueue the dirty scope) rather
    // than ever reaching a full/widened rebuild. With the search-index
    // store disabled there is no durable cross-window join source, so a
    // repair-drain attempt hits the SAME structural gate and re-demotes —
    // a genuine "cannot heal via scoped recompute" case (see
    // connectionsThreadRegisterMembership.test.ts's control test for the
    // sibling case, and connectionsRepairDemotion.test.ts for the
    // heals-when-it-can equivalence test with the store ON).
    delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = captureRecorded({
      replicaId: 'A',
      seq: 1,
      bacId: 'T1',
      threadId: 'T1',
      text: 'we should study the quantum widget rollout metrics before shipping',
    });
    await importEvents(eventLog, [founding]);
    await materializer.catchUp(eventLog);
    const priorSnapshot = await store.readCurrent();
    if (priorSnapshot === null) throw new Error('expected a snapshot after the founding drain');

    const newSearchVisit = timelineObserved({
      replicaId: 'A',
      seq: 2,
      url: 'https://www.google.test/search?q=quantum+widget',
      deps: { A: 1 },
    });
    await importEvents(eventLog, [newSearchVisit]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).toContain('scopedTimelineDelta.demoted reason=pending-search-visit');

    const served = await store.readCurrent();
    if (served === null) throw new Error('expected the prior snapshot to still be served');
    // Genuinely stale (byte-identical to the pre-search-visit snapshot —
    // the search visit's own timeline node never lands), never silently
    // wrong: no thread_text_mentions_search_query edge exists as if the
    // join had (incorrectly, partially) run.
    expect(searchQueryMentionEdges(served)).toEqual([]);
    expect(served.nodes.map((node) => node.id).sort()).toEqual(
      priorSnapshot.nodes.map((node) => node.id).sort(),
    );
    // Sanity: a full rebuild of the same two events WOULD mint the edge —
    // otherwise this test would not be distinguishing demoted-stale from
    // correctly-empty.
    expect(searchQueryMentionEdges(fullSnapshotFor([founding, newSearchVisit]))).toHaveLength(1);
  });
});
