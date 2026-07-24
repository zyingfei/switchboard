// Round-2 build-side invariant — acceptance coverage for the similarity
// corpus-flapping fix (R1 reuse / R2 bootstrap / R5).
//
// The round-1 fix guarded only the PUBLISH seam (a >90% collapse of a
// NON-EMPTY served snapshot is carried forward). It left two holes the live
// post-deploy evidence exposed:
//
//   R1 — a warm delta-only drain assembles the similarity corpus from its
//   event WINDOW. When the window is eligible-empty AND `previousSnapshot`
//   (current.db) is already empty, the builder reconstructs hash(empty) even
//   though the persisted HNSW store still holds ~9k embeddings and the
//   revision store still holds the last good ~51k-edge revision. Round 1
//   never consulted the revision store, so it adopted hash(empty).
//
//   R2 — once current.db holds 0 `visit_resembles_visit` edges (the live
//   self-perpetuation state), the publish-seam guard disarms
//   (`previousServedEdgeCount <= 0` publishes immediately), so every empty
//   build republishes legally forever. The system can only recover by luck.
//
// The build-side layer (Layer 0) closes both at the single seam every drain
// path funnels through: it REUSES / BOOTSTRAPS the latest non-empty
// persisted revision instead of adopting hash(empty), and refuses to WIPE
// the HNSW store on an empty-corpus full rebuild while a corpus exists. A
// genuinely-empty vault still builds empty legitimately.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { createSimilarityHnswStore } from '../../connections/visitSimilarityHnsw.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import type { ConnectionsSnapshot } from '../../connections/types.js';
import {
  readLatestNonEmptyVisitSimilarityRevision,
  writeVisitSimilarityRevision,
} from '../../producers/visit-resembles-revision.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import { WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: Date.parse('2026-07-23T10:00:00.000Z') + input.seq * 1000,
});

// Full RECALL_MODEL-dimension embedder so the HNSW similarity store is
// actually populated + persisted (a low-dim embedder trips the dimension
// guard and routes through the legacy fallback, never exercising the HNSW
// store this fix guards). A shared unit vector makes every pair resemble
// every other pair → a dense edge set.
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
  key: string;
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

// A graph-drain-triggering event that adds NO gate-eligible timeline visit
// — so `windowSimilarityEntries` (and thus the built similarity corpus) is
// empty. WORKSTREAM_UPSERTED is in the materializer's HANDLES set (it
// triggers a real structural drain, unlike queue/engagement events which
// only ride into the next drain), but it contributes no visit, so the
// similarity stage sees an empty corpus and — reading the wiped current.db —
// reconstructs hash(empty). This reproduces the live empty-window drain
// (`timeline.entryCount:0`) without modelling the exact boot-catch-up timing.
const emptyCorpusDrainEvent = (seq: number): AcceptedEvent =>
  buildEvent({
    seq,
    type: WORKSTREAM_UPSERTED,
    payload: {
      bac_id: `workstream-${String(seq)}`,
      title: `stream ${String(seq)}`,
      payloadVersion: 1,
    },
  });

const resemblesEdgeCount = (
  edges: readonly { readonly kind: string }[] | undefined,
): number => (edges ?? []).filter((edge) => edge.kind === 'visit_resembles_visit').length;

const hnswElementCount = async (vaultRoot: string): Promise<number> => {
  const loaded = await createSimilarityHnswStore().ensureLoaded(vaultRoot, fullDim);
  const count = loaded.elementCount();
  await loaded.close();
  return count;
};

// Strip every `visit_resembles_visit` edge from the served snapshot and
// write it back — this is the EXACT live state the round-2 evidence
// describes: current.db holds 0 similarity edges (wiped by an earlier empty
// publish) while the revision store still holds the good revision.
const wipeServedSimilarityEdges = async (
  store: ReturnType<typeof createConnectionsStore>,
): Promise<void> => {
  const current = await store.readCurrent();
  if (current === null) throw new Error('expected a served snapshot to wipe');
  const wiped: ConnectionsSnapshot = {
    ...current,
    edges: current.edges.filter((edge) => edge.kind !== 'visit_resembles_visit'),
  };
  await store.putCurrent(wiped);
};

const readFloorDiagnostics = async (
  vaultRoot: string,
): Promise<{
  suppressedCollapse: boolean;
  laneUnloadedReuse: boolean;
  bootstrapAdopted: boolean;
  servedEdgeCount: number;
  builtEdgeCount: number;
  servedRevisionId: string;
  builtRevisionId: string;
}> => {
  const raw = await readFile(
    join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
    'utf8',
  );
  const latest = JSON.parse(raw) as { similarityFloor?: Record<string, unknown> };
  const floor = latest.similarityFloor;
  if (floor === undefined) throw new Error('expected similarityFloor diagnostics');
  return floor as never;
};

const seedThreeVisitsAndDrain = async (m: {
  catchUp: (log: ReturnType<typeof createEventLog>) => Promise<unknown>;
  awaitIdle: () => Promise<unknown>;
}, eventLog: ReturnType<typeof createEventLog>): Promise<void> => {
  for (const [i, key] of KEYS.entries()) {
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: i + 1,
        key,
        focusedWindowMs: 10_000,
        observedAt: `2026-07-23T10:0${String(i)}:00.000Z`,
      }),
    );
  }
  await m.catchUp(eventLog);
  await m.awaitIdle();
};

describe('connections materializer — build-side corpus reuse/bootstrap (round-2)', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-simreuse-'));
  });

  afterEach(async () => {
    delete process.env['SIDETRACK_SIMILARITY_FORCE_REBUILD'];
    delete process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'];
    vi.restoreAllMocks();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // R5.1 + R5.2 — the live scenario. Store holds a non-empty corpus and a
  // persisted non-empty revision; the served snapshot has been wiped to 0
  // (the self-perpetuation state). The next drain, whose window is
  // eligible-empty, must NOT serve hash(empty): it bootstraps the persisted
  // revision, the HNSW store is not wiped, and the served edges are the
  // persisted ones.
  it('bootstraps the persisted revision when current.db was wiped to 0 (built != hash(empty), store intact)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
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
    });

    await seedThreeVisitsAndDrain(m, eventLog);
    seeded = true;

    const goodEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(goodEdgeCount).toBeGreaterThan(0);
    const storeCountBefore = await hnswElementCount(vaultRoot);
    expect(storeCountBefore).toBe(KEYS.length);
    const persisted = await readLatestNonEmptyVisitSimilarityRevision(vaultRoot);
    expect(persisted?.edges.length).toBe(goodEdgeCount);
    const goodRevisionId = persisted?.revisionId;

    // Reproduce the live wiped state: current.db loses all similarity edges,
    // but the good revision stays in the revision store.
    await wipeServedSimilarityEdges(store);
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(0);

    // A drain whose window carries NO timeline entry (an empty similarity
    // corpus) while `previousSnapshot` (current.db) is already empty — the
    // builder reconstructs hash(empty). Pre-fix this served empty and pinned
    // the vault at 0 forever.
    await eventLog.importPeerEvent(emptyCorpusDrainEvent(20));
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // The served snapshot recovered to the persisted corpus — NOT hash(empty).
    const afterEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(afterEdgeCount).toBe(goodEdgeCount);

    // The HNSW store was NOT reset (its embeddings back the reused revision).
    expect(await hnswElementCount(vaultRoot)).toBe(storeCountBefore);

    // Diagnostics: the drain bootstrapped the persisted revision; the built
    // revision (hash(empty)) was discarded, not served.
    const floor = await readFloorDiagnostics(vaultRoot);
    expect(floor.bootstrapAdopted).toBe(true);
    expect(floor.suppressedCollapse).toBe(false);
    expect(floor.servedEdgeCount).toBe(goodEdgeCount);
    expect(floor.builtEdgeCount).toBe(0);
    expect(floor.servedRevisionId).toBe(goodRevisionId);
    expect(floor.builtRevisionId).not.toBe(goodRevisionId);
  });

  // R5.2 — convergence over the NEXT drain, modelled the way production runs
  // it: each drain is a FRESH materializer instance (the child-per-drain fork
  // re-instantiates the materializer + stores against the vault path). After
  // the bootstrap re-populates current.db, the next drain's materializer sees
  // a non-empty served snapshot again and behaves normally (no perpetual
  // re-bootstrap) — proving the recovery is durable, not a one-shot papering.
  it('converges: after bootstrap the served signal stays populated on the next drain', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);

    const runDrain = async (): Promise<void> => {
      const m = createConnectionsMaterializer({
        vaultRoot,
        eventLog,
        timelineStore,
        store,
        embed: embedFullDim(),
      });
      await m.catchUp(eventLog);
      await m.awaitIdle();
    };

    // Seed via a fresh materializer, then wipe the served snapshot.
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: i + 1,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-23T10:0${String(i)}:00.000Z`,
        }),
      );
    }
    await runDrain();
    const goodEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(goodEdgeCount).toBeGreaterThan(0);
    await wipeServedSimilarityEdges(store);

    // Drain A (fresh materializer) — bootstraps the served snapshot back.
    await eventLog.importPeerEvent(emptyCorpusDrainEvent(20));
    await runDrain();
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(goodEdgeCount);
    expect((await readFloorDiagnostics(vaultRoot)).bootstrapAdopted).toBe(true);

    // Drain B (fresh materializer) — a normal warm drain re-observing a known
    // visit ABOVE the gate. Served is populated again, so the bootstrap does
    // NOT re-fire (the recovery is durable, not a one-shot papering) and the
    // signal stays intact.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 21,
        key: 'alpha',
        focusedWindowMs: 10_000,
        observedAt: '2026-07-23T10:21:00.000Z',
      }),
    );
    await runDrain();
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(goodEdgeCount);
    const floor = await readFloorDiagnostics(vaultRoot);
    expect(floor.bootstrapAdopted).toBe(false);
    expect(floor.servedEdgeCount).toBe(goodEdgeCount);
  });

  // R3/R5 BLOCKER coverage — recovery must hold on the CHUNKED boot-catch-up
  // path (`catchUpInScopedChunks`), the exact 50-min live-boot scenario. When
  // the backlog of all-scoped timeline-delta events exceeds
  // BACKLOG_FALLBACK_THRESHOLD (5000) and no worker is used, catchUp routes
  // through the chunked path, which sets `requireScopedTimelineDeltaForDrain`
  // per chunk. Before the blocker fix, a Layer-0 recovery inside a chunk
  // forced a base rebuild (disarming the scoped-delta gate), so the drain hit
  // the `requireScopedTimelineDeltaForDrain` throw, aborted the chunk, left
  // the frontier stalled, and re-entered the same >5000-event backlog forever
  // — a hard wedge. The fix lets the recovery's complete base snapshot fall
  // through to the write path. This test drives >5000 scoped sub-gate timeline
  // events (eligible-empty windows) after wiping the served signal and asserts
  // the served corpus RECOVERS and the frontier ADVANCES (no wedge, no re-drain
  // of the same backlog).
  it('recovers through the chunked boot-catch-up path (>5000 scoped events) without wedging', async () => {
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

    await seedThreeVisitsAndDrain(m, eventLog);
    const goodEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(goodEdgeCount).toBeGreaterThan(0);
    const storeCountBefore = await hnswElementCount(vaultRoot);
    expect(storeCountBefore).toBe(KEYS.length);

    // Reproduce the live wiped state.
    await wipeServedSimilarityEdges(store);
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(0);

    // A backlog of >5000 SUB-gate (never-eligible) BROWSER_TIMELINE_OBSERVED
    // events — all scoped timeline-delta events, so catchUp routes through
    // `catchUpInScopedChunks`, and each chunk's similarity window is
    // eligible-empty (the builder reconstructs hash(empty)).
    const BACKLOG = 5_200;
    for (let i = 0; i < BACKLOG; i += 1) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: 100 + i,
          key: `subgate-${String(i)}`,
          focusedWindowMs: 500, // below the 5000ms engagement gate
          observedAt: new Date(Date.parse('2026-07-23T11:00:00.000Z') + i * 1000).toISOString(),
        }),
      );
    }

    // Pre-fix this THREW inside the chunk and left the frontier stalled; the
    // fix lets the recovery base snapshot write through.
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // No wedge: the materializer is healthy and reports no lastError.
    expect(m.health().status).toBe('healthy');

    // The served snapshot recovered to the persisted corpus and the HNSW store
    // was never wiped.
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(goodEdgeCount);
    expect(await hnswElementCount(vaultRoot)).toBe(storeCountBefore);

    // The frontier ADVANCED past the whole backlog: a follow-up catchUp with no
    // new events is a no-op (it does NOT re-enter the >5000-event chunked path).
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(m.health().status).toBe('healthy');
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(goodEdgeCount);
  });

  // R5.3 — a genuinely-empty vault (fresh install: no HNSW store, no
  // non-empty persisted revision). An empty build must STILL be allowed: no
  // reuse, no bootstrap, and the empty revision is served legitimately.
  it('still builds empty legitimately on a fresh vault (no store, no persisted revision)', async () => {
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

    // A single SUB-gate visit — never eligible, so the corpus is empty from
    // the start and no HNSW store / non-empty revision is ever produced.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 1,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-23T10:00:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // No similarity edges were served (legitimately empty), and no non-empty
    // revision exists to reuse.
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(0);
    expect(await readLatestNonEmptyVisitSimilarityRevision(vaultRoot)).toBeNull();

    const floor = await readFloorDiagnostics(vaultRoot);
    expect(floor.laneUnloadedReuse).toBe(false);
    expect(floor.bootstrapAdopted).toBe(false);
    expect(floor.suppressedCollapse).toBe(false);
    expect(floor.servedEdgeCount).toBe(0);
    expect(m.health().status).toBe('healthy');
  });

  // R1 reset guard — the destructive HNSW reset must NOT fire on an
  // empty-corpus full rebuild while the store holds embeddings and no
  // legitimate reset reason applies. Even when the served snapshot is wiped
  // (so the publish-seam guard is disarmed), the persisted store survives so
  // the reused/bootstrapped revision's embeddings remain intact.
  it('does not wipe the HNSW store on an empty-corpus rebuild when a corpus exists', async () => {
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

    await seedThreeVisitsAndDrain(m, eventLog);
    const storeCountBefore = await hnswElementCount(vaultRoot);
    expect(storeCountBefore).toBe(KEYS.length);
    await wipeServedSimilarityEdges(store);

    // Drive several empty-window drains — the store must never erode.
    for (let i = 0; i < 3; i += 1) {
      await eventLog.importPeerEvent(emptyCorpusDrainEvent(30 + i));
      await m.catchUp(eventLog);
      await m.awaitIdle();
      expect(await hnswElementCount(vaultRoot)).toBe(storeCountBefore);
    }
  });

  // MAJOR #2 regression — a warm eligible-empty SCOPED drain against a
  // POPULATED store (served signal non-empty) must keep the bounded
  // page-evidence read. The `|| similarityEligibleCount === 0` disjunct in
  // `similarityRecoveryLikely` used to fire on this common drain (the window
  // carries a sub-gate timeline visit → zero gate-eligible NEW visits), force
  // `canAttemptBoundedScopedDelta=false`, and drop the page-evidence load to
  // the ENTIRE corpus (`bounded=false`) on every such drain — the per-nav
  // full-corpus-read CPU pathology. Layer 0 does NOT even fire here (the
  // builder produces the full edge set from the store), so this must stay a
  // normal bounded warm drain. Asserted via the phase-log `pageEvidence.ensure`
  // line.
  it('keeps the bounded page-evidence read on a warm eligible-empty scoped drain', async () => {
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

    // Seed a populated store + non-empty served signal (do NOT wipe).
    await seedThreeVisitsAndDrain(m, eventLog);
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    expect(await hnswElementCount(vaultRoot)).toBe(KEYS.length);

    // Capture the phase log for the NEXT drain only.
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A warm drain whose window carries a single SUB-gate observation of a NEW
    // url — a scoped timeline-delta event, but eligible-empty (no new
    // gate-eligible visit, and it does not touch the existing eligible visits'
    // scopes). This is the common steady-state warm drain: the WINDOW has zero
    // gate-eligible NEW visits while the store stays populated.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 50,
        key: 'subgate-new',
        focusedWindowMs: 500, // below the engagement gate
        observedAt: '2026-07-23T10:30:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const pageEvidenceLines = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('pageEvidence.ensure'));
    warnSpy.mockRestore();

    // The drain took the bounded read (bounded=true), NOT the full-corpus read.
    // This is the load-bearing assertion: with the `|| similarityEligibleCount
    // === 0` disjunct present (the regression), this drain took bounded=false
    // and re-read page-evidence for the entire corpus every drain.
    expect(pageEvidenceLines.length).toBeGreaterThan(0);
    expect(pageEvidenceLines.some((line) => line.includes('bounded=true'))).toBe(true);
    expect(pageEvidenceLines.every((line) => !line.includes('bounded=false'))).toBe(true);

    // No Layer-0 recovery fired (the builder produced the full edge set from
    // the intact store), and the served corpus is preserved.
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(KEYS.length);
    const floor = await readFloorDiagnostics(vaultRoot);
    expect(floor.laneUnloadedReuse).toBe(false);
    expect(floor.bootstrapAdopted).toBe(false);
  });

  // MAJOR #3 + MINORS #1/#2 regression — the provenance guard. A
  // reused/bootstrapped persisted revision is served VERBATIM under its own
  // id (Pass 7 re-applies the REVISION's stored threshold, and its cosines
  // live in the model's build-time vector space). If it was built under a
  // DIFFERENT config/model than the live drain, adopting it re-serves
  // stale-config / wrong-space edges under a valid-looking id. There is no
  // reset reason for a runtime config change, and the same-dimension
  // model-change reset only fires when durable `servedModelRevision` is
  // non-null. So Layer 0 must reject a persisted revision whose
  // threshold/modelId/modelRevision/featureSchemaVersion differs from the live
  // drain. Driven through the REACHABLE bootstrap path (served wiped to 0): a
  // stale-THRESHOLD persisted revision must NOT be adopted; the legitimate
  // empty build stands, and the next in-provenance drain rebuilds the corpus.
  it('does not bootstrap a persisted revision built under a different threshold (provenance guard)', async () => {
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

    await seedThreeVisitsAndDrain(m, eventLog);
    const goodEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(goodEdgeCount).toBeGreaterThan(0);
    const goodRevision = await readLatestNonEmptyVisitSimilarityRevision(vaultRoot);
    expect(goodRevision).not.toBeNull();

    // Overwrite the persisted revision so the ONLY non-empty revision on disk
    // carries a DIFFERENT threshold than the live config (0.85 default). Same
    // id so it replaces the good one; a distinct threshold makes it stale-config.
    const staleThreshold = {
      ...goodRevision!,
      threshold: goodRevision!.threshold + 0.05, // != live similarityConfig.threshold
    };
    await writeVisitSimilarityRevision(vaultRoot, staleThreshold);
    const persistedNow = await readLatestNonEmptyVisitSimilarityRevision(vaultRoot);
    expect(persistedNow?.threshold).toBe(staleThreshold.threshold);

    // Wipe the served signal → bootstrap territory.
    await wipeServedSimilarityEdges(store);
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(0);

    // An eligible-empty drain. The ONLY persisted revision is stale-config, so
    // the provenance guard rejects it: no bootstrap, the empty build stands.
    await eventLog.importPeerEvent(emptyCorpusDrainEvent(200));
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const floor = await readFloorDiagnostics(vaultRoot);
    expect(floor.bootstrapAdopted).toBe(false);
    expect(floor.laneUnloadedReuse).toBe(false);
    // The stale-config revision was NOT served (served stays empty this drain).
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBe(0);
    expect(m.health().status).toBe('healthy');
  });
});
