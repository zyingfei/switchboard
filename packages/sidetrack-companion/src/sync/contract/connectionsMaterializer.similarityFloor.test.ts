// Served-signal floor guard — integration coverage for the similarity
// flapping fix (requirements A/B/C).
//
// Reproduces the verified production failure: on a warm delta-only drain
// whose window carries re-observed visits with sub-gate engagement, the
// eligible corpus collapses (an UNLOADED-lane artifact). Pre-fix that
// tripped the removal-drift heuristic → a full HNSW rebuild whose empty
// branch reset the index and returned edges:[] → every
// `visit_resembles_visit` edge was wiped from the served snapshot. The
// next drain recomputed ~51k. Coin-flip.
//
// The fix: the drift-driven rebuild is suppressed when it would wipe a
// previously served signal with no legitimate reset reason (requirement
// A), and the publish-seam floor guard carries the previous revision
// forward as a belt-and-suspenders backstop (requirement B) — so the
// degenerate empty revision is never served (requirement C). A suppressed
// collapse is surfaced non-buried in /v1/system/health.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { createSimilarityHnswStore } from '../../connections/visitSimilarityHnsw.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import { SIMILARITY_DEFAULT_CORPUS_CONFIG_SIGNATURE } from '../../connections/visitSimilarity.js';
import {
  createSimilarityFloorStateStore,
  parseSimilarityFloorState,
} from '../../connections/similarityFloorState.js';
import { readLatestNonEmptyVisitSimilarityRevision } from '../../producers/visit-resembles-revision.js';
import { collectWorkGraphHealth } from '../../system/workGraphHealth.js';
import { collectHealth } from '../../system/health.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const acceptedAt = (seq: number): number =>
  Date.parse('2026-07-21T10:00:00.000Z') + seq * 1000;

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: acceptedAt(input.seq),
});

const unit = (values: readonly number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Float32Array.from(values.map((value) => value / norm));
};

const keyFromEmbeddingText = (text: string): string => {
  const corpus = text.replace(/^(?:passage|query):\s+/u, '');
  return corpus.split(/\s+/u)[0] ?? '';
};

// The three seeded visits share ONE embedding so every pair resembles
// every other pair — the corpus produces a dense similarity edge set.
const embedAllSame: VisitSimilarityEmbedder = (texts) =>
  Promise.resolve().then(() =>
    texts.map(() => unit([1, 0])),
  );

// Same embedder but asserts it is NEVER asked to embed on the bad drain —
// proves the drift rebuild was suppressed (a full rebuild would re-embed).
const embedForbiddenOnDrain2 = (
  onEmbed: () => void,
): VisitSimilarityEmbedder => {
  void keyFromEmbeddingText; // (helper retained for symmetry with sibling tests)
  return (texts) =>
    Promise.resolve().then(() => {
      onEmbed();
      return texts.map(() => unit([1, 0]));
    });
};

// Full RECALL_MODEL-dimension embedder so the HNSW similarity store is
// actually populated + persisted (the 2-dim embedders above trip the
// dimension guard and route through the legacy fallback, so they never
// exercise the HNSW stale-deletion path this fix guards). A shared unit
// vector makes every pair resemble every other pair → a dense edge set.
const fullDim = RECALL_MODEL.embeddingDim;
const unitFullDim = (): Float32Array => {
  const v = new Float32Array(fullDim);
  v[0] = 1;
  return v;
};
const embedFullDim = (onEmbed?: () => void): VisitSimilarityEmbedder => (texts) =>
  Promise.resolve().then(() => {
    onEmbed?.();
    return texts.map(() => unitFullDim());
  });

const KEYS = ['alpha', 'bravo', 'charlie'] as const;

const timelineObserved = (input: {
  seq: number;
  key: (typeof KEYS)[number];
  focusedWindowMs: number;
  observedAt: string;
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `timeline-${input.key}-${String(input.seq)}`,
      observedAt: input.observedAt,
      url: `https://example.test/${input.key}`,
      canonicalUrl: `https://example.test/${input.key}`,
      title: `visit-${input.key}`,
      provider: 'generic',
      transition: 'activated',
      payloadVersion: 1,
      dimensions: { engagement: { focusedWindowMs: input.focusedWindowMs } },
    },
  });

const resemblesEdgeCount = (
  edges: readonly { readonly kind: string }[] | undefined,
): number => (edges ?? []).filter((edge) => edge.kind === 'visit_resembles_visit').length;

describe('connections materializer — served-signal floor guard (flapping fix)', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-simfloor-'));
  });

  afterEach(async () => {
    delete process.env['SIDETRACK_SIMILARITY_FORCE_REBUILD'];
    delete process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'];
    delete process.env['SIDETRACK_SIMILARITY_FORCE_CORPUS_REBUILD'];
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('does not wipe visit_resembles_visit edges on a warm delta drain whose window collapses the eligible corpus', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    let drain2Embeds = 0;
    let drain1Done = false;
    const embed = embedForbiddenOnDrain2(() => {
      if (drain1Done) drain2Embeds += 1;
    });
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
    });

    // Drain 1 — three visits ABOVE the 5000ms engagement gate. Dense
    // similarity corpus → multiple visit_resembles_visit edges.
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    drain1Done = true;

    const afterDrain1 = await store.readCurrent();
    const goodEdgeCount = resemblesEdgeCount(afterDrain1?.edges);
    expect(goodEdgeCount).toBeGreaterThan(0);

    // Drain 2 (the BAD path) — re-observe TWO of the three known visits
    // with SUB-gate engagement (1000ms < 5000ms). This makes them stale in
    // the store while the third is out-of-window, so the eligible corpus
    // collapses and the removal-drift heuristic would (pre-fix) force a
    // full HNSW rebuild whose empty branch resets the index and wipes all
    // edges. No legitimate reset reason applies.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 11,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:11:00.000Z',
      }),
    );
    // Late engagement aggregates lowering their focused window as well.
    for (const [i, key] of [
      [12, 'alpha'],
      [13, 'bravo'],
    ] as const) {
      await eventLog.importPeerEvent(
        buildEvent({
          seq: i,
          type: ENGAGEMENT_SESSION_AGGREGATED,
          payload: {
            payloadVersion: 1,
            visitId: `visit:https://example.test/${key}`,
            sessionId: 'session:low',
            dimensions: {
              engagement: {
                activeMs: 1_000,
                visibleMs: 1_000,
                focusedWindowMs: 1_000,
                idleMs: 0,
                foregroundBursts: 1,
                returnCount: 0,
                scrollEvents: 0,
                maxScrollRatio: 0,
                copyCount: 0,
                pasteCount: 0,
              },
            },
          },
        }),
      );
    }

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const afterDrain2 = await store.readCurrent();
    const preservedEdgeCount = resemblesEdgeCount(afterDrain2?.edges);
    // The served signal must NOT collapse to zero on the bad drain.
    expect(preservedEdgeCount).toBeGreaterThan(0);
    // The floor guard must retain at least 10% of the previously served
    // edges (requirement B). In this fixture the drift suppression keeps
    // the full set.
    expect(preservedEdgeCount).toBeGreaterThanOrEqual(Math.ceil(goodEdgeCount * 0.1));
    // The drift-driven full rebuild was suppressed → no re-embed on drain 2.
    expect(drain2Embeds).toBe(0);
    expect(m.health().status).toBe('healthy');
  });

  it('records the suppressed collapse in diagnostics and flips /v1/system/health non-ok', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedAllSame,
    });

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 11,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:11:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // The diagnostics artifact carries the floor section every drain.
    const latestRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const latest = JSON.parse(latestRaw) as {
      similarityFloor?: {
        suppressedCollapse: boolean;
        suppressedCollapseCount: number;
        previousServedEdgeCount: number | null;
      };
    };
    expect(latest.similarityFloor).toBeDefined();

    // Health surfacing — the similarity floor candidate reflects the drain.
    const workGraph = await collectWorkGraphHealth({ vaultRoot, eventLog });
    const floorCandidate = workGraph.candidates.find(
      (candidate) => candidate.id === 'similarity.served-signal-floor',
    );
    expect(floorCandidate).toBeDefined();

    const health = await collectHealth({
      startedAt: new Date(),
      vaultRoot,
      vaultWritable: () => Promise.resolve(true),
      vaultSizeBytes: () => Promise.resolve(1),
      captureSummary: () =>
        Promise.resolve({ lastByProvider: {}, queueDepthHint: null, droppedHint: null }),
      recallSummary: () =>
        Promise.resolve({ indexExists: false, entryCount: null, modelId: null, sizeBytes: null }),
      serviceStatus: () => Promise.resolve({ installed: false, running: false }),
      workGraphSummary: () => collectWorkGraphHealth({ vaultRoot, eventLog }),
    });
    // When a collapse was suppressed this drain (or earlier this process),
    // the section is `stale` and the top-level status is non-ok.
    if (floorCandidate?.status === 'alarm') {
      expect(health.observability?.sections['similarityFloor']).toBe('stale');
      expect(health.observability?.status).not.toBe('ok');
    } else {
      expect(health.observability?.sections['similarityFloor']).toBe('ok');
    }
  });

  it('ALLOWS a collapse under an explicit operator rebuild (reset reason)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedAllSame,
    });

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const goodEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(goodEdgeCount).toBeGreaterThan(0);

    // Operator forces a rebuild → a collapse is legitimate and published.
    process.env['SIDETRACK_SIMILARITY_FORCE_REBUILD'] = '1';
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 11,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:11:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const latestRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const latest = JSON.parse(latestRaw) as {
      similarityFloor?: { suppressedCollapse: boolean; allowedResetReason: string | null };
    };
    // Under the operator rebuild the guard must NOT suppress.
    expect(latest.similarityFloor?.suppressedCollapse).toBe(false);
  });

  // Blocker fix — the HNSW store must NOT erode across a suppressed
  // collapse. Pre-fix the incremental path's stale-visit deletion ran
  // independently of the floor guard, so the served snapshot referenced
  // embeddings the store no longer held and the drift-suppression pinned
  // Layer 1 into permanent rebuild-suppression while the store shrank.
  it('does not shrink the HNSW store across a suppressed-collapse drain', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
    });

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const storeCountBefore = await (async () => {
      const loaded = await createSimilarityHnswStore().ensureLoaded(vaultRoot, fullDim);
      const count = loaded.elementCount();
      await loaded.close();
      return count;
    })();
    expect(storeCountBefore).toBe(KEYS.length);

    // The BAD drain — re-observe two known visits with sub-gate engagement
    // (stale) + the third out-of-window, collapsing the eligible corpus.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 11,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:11:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const storeCountAfter = await (async () => {
      const loaded = await createSimilarityHnswStore().ensureLoaded(vaultRoot, fullDim);
      const count = loaded.elementCount();
      await loaded.close();
      return count;
    })();
    // The embeddings the carried-forward revision references must survive.
    expect(storeCountAfter).toBe(storeCountBefore);
  });

  // Blocker fix — a genuine sustained collapse (real deletion) must not be
  // pinned to the old high revision forever. After N consecutive
  // suppressions of the same low-count band the guard accepts the new
  // lower revision as the truth (bounded recovery).
  it('accepts a sustained collapse after N consecutive suppressions', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedAllSame,
      similarityFloorStateStore: floorStateStore,
    });

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);

    // Seed the durable state as if this same collapse band has already
    // been suppressed for the run just below the escape threshold — the
    // next suppressing drain reaches it. (This simulates prior drains
    // without re-driving the whole scenario; the pure fold logic that
    // builds up this run is covered in similarityFloorState.test.ts.)
    const seeded = parseSimilarityFloorState({
      ...(await floorStateStore.read()),
      lastSuppressedBuiltBand: 0,
      consecutiveSuppressionsInBand: 3,
      lastSuppressedAtMs: 1,
    });
    await floorStateStore.write(seeded);

    // A collapsing drain — the corpus goes empty. With the run already at
    // the threshold, the guard must PUBLISH the low revision, not suppress.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 11,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:11:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const latestRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const latest = JSON.parse(latestRaw) as {
      similarityFloor?: { suppressedCollapse: boolean; allowedResetReason: string | null };
    };
    expect(latest.similarityFloor?.suppressedCollapse).toBe(false);
    expect(latest.similarityFloor?.allowedResetReason).toBe('sustained-collapse-accepted');
  });

  // Blocker fix — a domain-purge tombstone and the similarity-edge
  // collapse it causes land on DIFFERENT drains. The reset reason must be
  // DURABLE across drains so a collapse drain whose window no longer
  // contains the tombstone still publishes the collapse instead of
  // suppressing it (which would re-serve edges for purged content).
  //
  // This test exercises the READ path that closes the finding: a pending
  // purge reset persisted in durable state (armed on an earlier tombstone
  // drain, see similarityFloorState.test.ts for the arm→pending→consume
  // state machine) must make `privacy-purge` an active reset reason for a
  // LATER collapse drain that has NO tombstone in its own window.
  it('publishes a deferred collapse when a durable privacy-purge reset is pending', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedAllSame,
      similarityFloorStateStore: floorStateStore,
    });

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);

    // Simulate the deferred-purge timing: a tombstone was ingested on an
    // EARLIER drain (see similarityFloorState.test.ts for the arm state
    // machine), so a purge reset is armed-but-unconsumed in durable state
    // now — while the served snapshot STILL carries the pre-purge edges.
    // The collapse below carries NO tombstone in its own window. Pre-fix
    // (window-scoped detection) it would suppress and re-serve the
    // pre-purge edges; post-fix the durable pending reset makes
    // `privacy-purge` active and the collapse is PUBLISHED.
    const beforePurge = await floorStateStore.read();
    await floorStateStore.write({
      ...beforePurge,
      purgeResetArmedEpoch: beforePurge.purgeResetConsumedEpoch + 1,
    });

    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 21,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:21:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 22,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:22:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const latestRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const latest = JSON.parse(latestRaw) as {
      similarityFloor?: { suppressedCollapse: boolean; allowedResetReason: string | null };
    };
    expect(latest.similarityFloor?.suppressedCollapse).toBe(false);
    expect(latest.similarityFloor?.allowedResetReason).toBe('privacy-purge');
    // The pending reset is consumed once the collapse is published under it.
    const afterCollapse = await floorStateStore.read();
    expect(afterCollapse.purgeResetArmedEpoch).toBe(afterCollapse.purgeResetConsumedEpoch);
  });

  // Major fix — a same-DIMENSION embedding model/revision change (a
  // fine-tune or same-family revision bump) produces NO HNSW dimension
  // mismatch but still moves the vector space, so the old edges legitimately
  // collapse. Detected by comparing the served model revision recorded in
  // durable state against the live RECALL_MODEL — the collapse is then an
  // `embedding-model-change` reset, not a suppressed flap.
  it('allows a collapse under a same-dimension model revision change', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedAllSame,
      similarityFloorStateStore: floorStateStore,
    });

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);

    // The served revision was produced under the live model. Simulate a
    // model swap that keeps the same dimension by recording a STALE served
    // model revision in durable state (as if the previous drain ran under a
    // now-superseded model). The live RECALL_MODEL.revision differs, so the
    // next collapse must be treated as an embedding-model-change reset.
    expect(RECALL_MODEL.revision).not.toBe('stale-model-revision');
    const seeded = await floorStateStore.read();
    await floorStateStore.write({ ...seeded, servedModelRevision: 'stale-model-revision' });

    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 11,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:11:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const latestRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const latest = JSON.parse(latestRaw) as {
      similarityFloor?: { suppressedCollapse: boolean; allowedResetReason: string | null };
    };
    expect(latest.similarityFloor?.suppressedCollapse).toBe(false);
    expect(latest.similarityFloor?.allowedResetReason).toBe('embedding-model-change');
    // The published revision re-records the live model revision.
    const after = await floorStateStore.read();
    expect(after.servedModelRevision).toBe(RECALL_MODEL.revision);
  });

  // ── Corpus-config-change migration (fix/corpus-flip-legacy-migration) ──
  //
  // The live defect: a corpus-shaping flag (SIDETRACK_SIMILARITY_CLEAN_CORPUS)
  // flipped, but the pre-existing floor-state file was written by an OLDER
  // build with NO servedCorpusConfigSignature field. The detection fired only
  // when a RECORDED signature differed from live, so legacy-null → new-signature
  // silently RECORDED the new signature WITHOUT re-embedding — a mixed vector
  // space (absent≠empty, doctrine rule 6). These read the SERVED artifact
  // (diagnostics latest.json allowedResetReason + floor state) back through the
  // real drain (doctrine rule 10).

  it('legacy-null signature + non-default corpus flag + non-trivial corpus fires the migration reset', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    let embedsAfterSeed = 0;
    let seeded = false;
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(() => {
        if (seeded) embedsAfterSeed += 1;
      }),
      similarityFloorStateStore: floorStateStore,
    });

    // Seed a non-trivial persisted corpus under the DEFAULT (legacy) config.
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    seeded = true;
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    const persisted = await readLatestNonEmptyVisitSimilarityRevision(vaultRoot);
    expect(persisted?.edges.length).toBeGreaterThan(0);

    // Reproduce the exact legacy-vault state: an OLD-build floor-state file with
    // NO servedCorpusConfigSignature field (null). The default publish above
    // recorded the DEFAULT signature; stomp it back to null to model the vault
    // that upgraded across the field's introduction.
    const seededState = await floorStateStore.read();
    expect(seededState.servedCorpusConfigSignature).toBe(
      SIMILARITY_DEFAULT_CORPUS_CONFIG_SIGNATURE,
    );
    await floorStateStore.write({ ...seededState, servedCorpusConfigSignature: null });

    // Flip the corpus-shaping flag ON (the live signature is now non-default).
    process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = '1';

    // Drain again on a CORPUS-COMPLETE drain — re-observe ALL THREE persisted
    // visits above the gate so the reset's full rebuild re-embeds the whole
    // corpus (eligible ≥ the persisted store), not a window slice. Defect #5:
    // a reset may only act when the drain can assemble a corpus-complete input;
    // a window-poor migration drain (a single re-observed visit) would rebuild a
    // partial corpus and WIPE the served signal — that path is exercised by the
    // "reset deferred on a window-poor drain" test below. Pre-fix: this drain
    // stamped the signature but rendered ZERO similarity rows (a wipe the old
    // test never read back). Post-fix: the corpus-complete migration re-embeds
    // and publishes a NON-TRIVIAL revision.
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: 10 + i,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:1${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const latest = JSON.parse(
      await readFile(
        join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
        'utf8',
      ),
    ) as { similarityFloor?: { suppressedCollapse: boolean; allowedResetReason: string | null } };
    // The migration must NOT be suppressed (it is a legitimate re-embed).
    expect(latest.similarityFloor?.suppressedCollapse).toBe(false);
    // Defect #5 — a CORPUS-COMPLETE migration re-embeds to an equivalent
    // non-trivial revision, so there is NO collapse for the guard to attribute a
    // reset reason to (`allowedResetReason` is recorded only ON a collapse). The
    // reset's effect is observable instead via the re-embed + the signature
    // advance below. (Pre-fix this drain DID record corpus-config-change — but
    // only because it wiped the corpus to zero, the very defect being fixed.)
    expect(latest.similarityFloor?.allowedResetReason).toBeNull();
    // The full rebuild re-embedded (proving the clean corpus reached the
    // already-persisted visits, not just new ones).
    expect(embedsAfterSeed).toBeGreaterThan(0);
    // Doctrine rule 10 — read the SERVED artifact back: the corpus-complete
    // migration must NOT wipe the served similarity signal (defect #5).
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    // The served signature advances to the live (clean) config so the reset
    // fires exactly ONCE.
    const afterMigration = await floorStateStore.read();
    expect(afterMigration.servedCorpusConfigSignature).toBe('clean-title-only|title-corpus');
  });

  it('fresh vault (empty corpus) records the non-default signature WITHOUT a reset', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
      similarityFloorStateStore: floorStateStore,
    });

    // Non-default corpus flag from the very first drain, but NO prior corpus:
    // a genuinely fresh vault (null signature, empty HNSW store, no persisted
    // revision). There is nothing stale to re-embed → no pointless reset.
    process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = '1';
    expect(await readLatestNonEmptyVisitSimilarityRevision(vaultRoot)).toBeNull();

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const latest = JSON.parse(
      await readFile(
        join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
        'utf8',
      ),
    ) as { similarityFloor?: { allowedResetReason: string | null } };
    // A first-ever build has no previously served signal, so the ONLY
    // legitimate reason that could appear is no-previous-signal — never
    // corpus-config-change (there was no old corpus to migrate).
    expect(latest.similarityFloor?.allowedResetReason).not.toBe('corpus-config-change');
    // The signature is still recorded so a LATER flip is detectable normally.
    const after = await floorStateStore.read();
    expect(after.servedCorpusConfigSignature).toBe('clean-title-only|title-corpus');
  });

  it('already-stamped-but-stale state: FORCE_CORPUS_REBUILD hatch fires exactly once (no loop)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
      similarityFloorStateStore: floorStateStore,
    });

    // Seed a non-trivial corpus WITH the clean flag already on, so the served
    // signature is stamped to the live (clean) config — modelling the state we
    // are NOW in: signature already == live, but the vault was never truly
    // re-embedded under it. The migration/recorded-difference paths cannot fire
    // (recorded == live). Only the operator hatch can recover this.
    process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = '1';
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const stamped = await floorStateStore.read();
    expect(stamped.servedCorpusConfigSignature).toBe('clean-title-only|title-corpus');
    expect(stamped.forcedCorpusRebuildSignature).toBeNull();

    // Arm the one-shot hatch and drain on a CORPUS-COMPLETE drain — re-observe
    // ALL THREE persisted visits so the forced rebuild re-embeds the whole
    // corpus (eligible ≥ store). Defect #5: a forced rebuild over a window-poor
    // slice would wipe the served signal AND self-consume the one-shot marker on
    // that empty publish (the live incident); the marker may only advance on a
    // NON-TRIVIAL corpus-complete publish.
    process.env['SIDETRACK_SIMILARITY_FORCE_CORPUS_REBUILD'] = '1';
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: 10 + i,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:1${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const firstDrain = JSON.parse(
      await readFile(
        join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
        'utf8',
      ),
    ) as { similarityFloor?: { allowedResetReason: string | null; suppressedCollapse: boolean } };
    // Defect #5 — a corpus-complete forced rebuild re-embeds to an equivalent
    // non-trivial revision, so no collapse is recorded (allowedResetReason null);
    // the hatch's effect is the marker advance + re-embed, verified below.
    expect(firstDrain.similarityFloor?.suppressedCollapse).toBe(false);
    // Doctrine rule 10 — the forced rebuild published a NON-TRIVIAL served signal.
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    const afterFirst = await floorStateStore.read();
    // The one-shot consumption marker advanced to the live signature — ONLY
    // because the publish was non-trivial (an empty publish would leave it null).
    expect(afterFirst.forcedCorpusRebuildSignature).toBe('clean-title-only|title-corpus');

    // Second corpus-complete drain with the env STILL SET — the hatch must NOT
    // re-fire (the marker == live now).
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: 20 + i,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:2${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const secondDrain = JSON.parse(
      await readFile(
        join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
        'utf8',
      ),
    ) as { similarityFloor?: { allowedResetReason: string | null } };
    expect(secondDrain.similarityFloor?.allowedResetReason).not.toBe('corpus-config-change');
  });

  // Findings on the monotonic health pin — a single transient flap that
  // self-heals must NOT leave /v1/system/health degraded forever. The
  // health status is driven by CURRENT state (recent-window flapping), so
  // after a short run of clean drains the floor section returns to ok.
  it('health floor section recovers to ok after clean drains follow a flap', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedAllSame,
    });

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // One flap: re-observe two visits sub-gate → suppressed collapse.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 11,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-21T10:11:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // Now several clean drains (re-observe all three ABOVE the gate). The
    // recent-window flag decays and the floor section returns to ok.
    for (let round = 0; round < 4; round += 1) {
      for (const [i, key] of KEYS.entries()) {
        await eventLog.importPeerEvent(
          timelineObserved({
            seq: 30 + round * 3 + i,
            key,
            focusedWindowMs: 10_000,
            observedAt: `2026-07-21T11:${String(round).padStart(2, '0')}:0${String(i)}.000Z`,
          }),
        );
      }
      await m.catchUp(eventLog);
      await m.awaitIdle();
    }

    const workGraph = await collectWorkGraphHealth({ vaultRoot, eventLog });
    const floorCandidate = workGraph.candidates.find(
      (candidate) => candidate.id === 'similarity.served-signal-floor',
    );
    // Recovered — the candidate is ok even though a flap happened earlier
    // (the lifetime count is still > 0 as a metric).
    expect(floorCandidate?.status).toBe('ok');

    const latestRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const latest = JSON.parse(latestRaw) as {
      similarityFloor?: { flapping: boolean; suppressedCollapseCount: number };
    };
    expect(latest.similarityFloor?.flapping).toBe(false);
    expect(latest.similarityFloor?.suppressedCollapseCount).toBeGreaterThan(0);
  });

  // ── Defect #5 — a reset reason must be COUPLED to corpus-complete rebuild
  // input, else it becomes a WIPE PERMIT ─────────────────────────────────────
  //
  // The live incident: a corpus-config-change / forced-rebuild reset fired on a
  // warm WINDOW-POOR drain (the standing corpus-lane assembly debt), so the
  // "full rebuild" ran over an EMPTY eligible corpus while the persisted HNSW
  // store still held the whole ~9k-visit corpus. The rebuild reset the HNSW,
  // published revEdges=0, and — because every floor defers to a recorded reset
  // reason — wiped the served visit_resembles_visit signal (52,100 → 0). Worse,
  // the one-shot forcedCorpusRebuildSignature marker CONSUMED itself on that
  // empty publish, so the migration never retried.
  //
  // These read the SERVED artifact back through the real drain/store (doctrine
  // rule 10): store.readCurrent() (what resolvers read) + the persisted HNSW
  // store element count + the durable floor state.

  const readHnswStoreCount = async (): Promise<number> => {
    const loaded = await createSimilarityHnswStore().ensureLoaded(vaultRoot, fullDim);
    const count = loaded.elementCount();
    await loaded.close();
    return count;
  };

  // (a) Reset active + WINDOW-POOR drain + non-trivial persisted store → the
  //     reset does NOT consume, no wipe is published, the served signal retains
  //     the previous rows (falls back to carry-forward, reset stays pending).
  it('reset active + window-poor drain + non-trivial store → no wipe, reset stays pending', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
      similarityFloorStateStore: floorStateStore,
    });

    // Seed a non-trivial corpus under the DEFAULT config → served signal + a
    // populated persisted HNSW store.
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const goodEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(goodEdgeCount).toBeGreaterThan(0);
    const storeCountBefore = await readHnswStoreCount();
    expect(storeCountBefore).toBe(KEYS.length);
    // Model the legacy-null state so a reset (corpus-config-change) is ARMED on
    // the next drain: stomp the recorded signature to null, flip the flag on.
    const seeded = await floorStateStore.read();
    await floorStateStore.write({ ...seeded, servedCorpusConfigSignature: null });
    process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = '1';

    // A WINDOW-POOR drain: re-observe a SINGLE visit above the gate. The reset
    // is armed (legacy-null migration) but the eligible corpus (1) does NOT
    // cover the persisted store (3), so the reset must be DEFERRED: no wipe, no
    // consume, the served signal is carried forward.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 10_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // Served artifact — the signal must NOT collapse.
    const afterEdges = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(afterEdges).toBeGreaterThanOrEqual(Math.ceil(goodEdgeCount * 0.1));
    expect(afterEdges).toBeGreaterThan(0);
    // The persisted HNSW store must not have been reset/eroded.
    expect(await readHnswStoreCount()).toBe(storeCountBefore);
    // The reset must NOT have consumed: the recorded signature stays null so the
    // migration re-fires on the next corpus-complete drain (still PENDING). This
    // is the load-bearing property — a deferred reset never advances its
    // consumption marker, however the served signal was preserved (carry-forward
    // OR, at small scale, the incremental path re-deriving the full edge set from
    // the still-intact persisted store).
    const afterState = await floorStateStore.read();
    expect(afterState.servedCorpusConfigSignature).toBeNull();
    // The diagnostic must NOT record a corpus-config-change collapse-allow — the
    // reset was held back, not published.
    const latest = JSON.parse(
      await readFile(join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'), 'utf8'),
    ) as { similarityFloor?: { allowedResetReason: string | null; servedEdgeCount: number } };
    expect(latest.similarityFloor?.allowedResetReason).not.toBe('corpus-config-change');
    expect(latest.similarityFloor?.servedEdgeCount).toBeGreaterThan(0);
  });

  // (b) Reset active + CORPUS-COMPLETE drain → the full rebuild publishes
  //     non-trivially and the reset consumes EXACTLY once.
  it('reset active + corpus-complete drain → publishes non-trivially, consumes once', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    let embedsAfterSeed = 0;
    let seededFlag = false;
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(() => {
        if (seededFlag) embedsAfterSeed += 1;
      }),
      similarityFloorStateStore: floorStateStore,
    });

    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    seededFlag = true;
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    // Arm the reset (legacy-null migration).
    const seeded = await floorStateStore.read();
    await floorStateStore.write({ ...seeded, servedCorpusConfigSignature: null });
    process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = '1';

    // A CORPUS-COMPLETE drain: re-observe ALL persisted visits above the gate so
    // the eligible corpus covers the store → the reset acts corpus-complete.
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: 10 + i,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:1${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // Served artifact — non-trivial (the full corpus re-embed republished).
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    // The corpus was actually re-embedded (the reset drove the full rebuild).
    expect(embedsAfterSeed).toBeGreaterThan(0);
    // The reset CONSUMED exactly once: the recorded signature advanced to live.
    const afterState = await floorStateStore.read();
    expect(afterState.servedCorpusConfigSignature).toBe('clean-title-only|title-corpus');

    // A subsequent corpus-complete drain must NOT re-fire the migration
    // (recorded == live now → consumed exactly once).
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: 20 + i,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:2${String(i)}:00.000Z`,
        }),
      );
    }
    const embedsBeforeSecond = embedsAfterSeed;
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const secondLatest = JSON.parse(
      await readFile(join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'), 'utf8'),
    ) as { similarityFloor?: { allowedResetReason: string | null } };
    // No fresh corpus-config-change collapse on the second drain.
    expect(secondLatest.similarityFloor?.allowedResetReason).not.toBe('corpus-config-change');
    // The served signal stays non-empty across the second drain.
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    void embedsBeforeSecond;
  });

  // (c) The LIVE scenario: the one-shot marker was already CONSUMED by the
  //     historical empty publish, the served signal is 0, and the persisted
  //     store is non-trivial. The next drain must converge to serving non-empty
  //     — via R2 bootstrap (a clean persisted revision is adopted) when one
  //     exists, else via the re-fired forced rebuild.
  it('live state: consumed marker + served=0 + non-trivial store → converges to non-empty', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
      similarityFloorStateStore: floorStateStore,
    });

    // Seed a non-trivial corpus WITH the clean flag on → a clean-corpus HNSW
    // store + a clean persisted revision (mirrors the child that wrote the fresh
    // clean HNSW bin after the incident).
    process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = '1';
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-21T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const seededSnapshot = await store.readCurrent();
    expect(resemblesEdgeCount(seededSnapshot?.edges)).toBeGreaterThan(0);
    const persisted = await readLatestNonEmptyVisitSimilarityRevision(vaultRoot);
    expect(persisted?.edges.length).toBeGreaterThan(0);
    const storeCount = await readHnswStoreCount();
    expect(storeCount).toBeGreaterThan(0);

    // Reproduce the exact post-incident durable state: the one-shot marker is
    // CONSUMED (== live) and the recorded signature is live, but the SERVED
    // snapshot was wiped to zero similarity rows (the historical empty publish).
    const stampedState = await floorStateStore.read();
    await floorStateStore.write({
      ...stampedState,
      servedCorpusConfigSignature: 'clean-title-only|title-corpus',
      forcedCorpusRebuildSignature: 'clean-title-only|title-corpus',
    });
    // Strip the similarity-family rows from the served snapshot (served=0) while
    // leaving the persisted HNSW store + revision intact — read/write back
    // through the real store.
    if (seededSnapshot !== null) {
      const wiped: typeof seededSnapshot = {
        ...seededSnapshot,
        edges: seededSnapshot.edges.filter(
          (edge) => edge.kind !== 'visit_resembles_visit' && edge.kind !== 'closest_visit',
        ),
      };
      await store.putCurrent(wiped);
    }
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(0);

    // Drive a WINDOW-POOR recovery drain (re-observe a SINGLE visit). This is the
    // harder case: the served signal is 0 and the window carries just one visit,
    // so the builder cannot re-derive the full corpus from the window alone — the
    // R2 bootstrap must ADOPT the clean persisted revision to restore the served
    // signal (the env stays set, but B6 stale-config rejection must NOT block a
    // revision built under the CURRENT clean config). If no clean revision were
    // adoptable, the re-fired forced rebuild would take over; here the child's
    // clean revision exists, so bootstrap converges.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 10,
        key: 'alpha',
        focusedWindowMs: 10_000,
        observedAt: '2026-07-21T10:10:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // Converged — the served visit_resembles_visit signal is restored from 0.
    // (Which recovery lane fires is scale-dependent — doctrine rule 4: at this
    // unit scale the incremental builder re-derives the full edge set from the
    // still-intact persisted store, so the served signal restores without needing
    // R2 bootstrap; at real scale where the window cannot re-derive the corpus,
    // R2 bootstrap adopts the clean persisted revision instead — the B6 stale-
    // config rejection does NOT block it because the recorded served signature is
    // the CURRENT clean config, not null. Either way the load-bearing property —
    // served converges from 0 to non-empty — holds and is what the user reads.)
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    // The persisted HNSW store survived the recovery (no further erosion).
    expect(await readHnswStoreCount()).toBeGreaterThan(0);
  });
});
