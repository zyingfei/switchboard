// Round-3 RENDERED-edge floor — STORE-LEVEL acceptance coverage.
//
// The round-1/round-2 mistake was testing one layer too high (the REVISION's
// edge count). Round 3 proved a drain can adopt a non-empty visitSimilarity
// revision (51,156 edges) yet publish ZERO `visit_resembles_visit` rows to
// current.db, because buildConnectionsSnapshot Pass 7 emits a similarity edge
// only when BOTH endpoint timeline-visit nodes exist in the snapshot — a
// window-poor node set silently strips every edge. The terminal invariant
// therefore must live at (and be verified against) the SERVED ARTIFACT: these
// tests write a snapshot through the REAL publish path with a window-poor node
// set + a non-empty adopted revision, then READ BACK current.db and assert the
// similarity-family row count did not collapse.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import type { ConnectionsSnapshot } from '../../connections/types.js';
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
  acceptedAtMs: Date.parse('2026-07-24T10:00:00.000Z') + input.seq * 1000,
});

// Full RECALL_MODEL-dimension embedder so the HNSW store is really populated
// (a low-dim embedder trips the dimension guard). A shared unit vector makes
// every pair resemble every other → a dense edge set.
const fullDim = RECALL_MODEL.embeddingDim;
const unitFullDim = (): Float32Array => {
  const v = new Float32Array(fullDim);
  v[0] = 1;
  return v;
};
const embedFullDim = (): VisitSimilarityEmbedder => (texts) =>
  Promise.resolve().then(() => texts.map(() => unitFullDim()));

// Six visits → a dense 15-edge similarity corpus (well above the counts where
// a >90% collapse is unambiguous).
const KEYS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'] as const;

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

// A graph-drain-triggering event that adds NO gate-eligible timeline visit, so
// the built similarity corpus for the drain's WINDOW is empty (reproduces the
// live empty-window catch-up drain without modelling exact boot timing).
const emptyCorpusDrainEvent = (seq: number): AcceptedEvent =>
  buildEvent({
    seq,
    type: WORKSTREAM_UPSERTED,
    payload: { bac_id: `workstream-${String(seq)}`, title: `stream ${String(seq)}`, payloadVersion: 1 },
  });

const resemblesEdgeCount = (edges: readonly { readonly kind: string }[] | undefined): number =>
  (edges ?? []).filter((edge) => edge.kind === 'visit_resembles_visit').length;

const timelineVisitNodeCount = (
  nodes: readonly { readonly kind: string }[] | undefined,
): number => (nodes ?? []).filter((node) => node.kind === 'timeline-visit').length;

// Reproduce the EXACT round-3 live current.db: a WINDOW-POOR served snapshot
// whose similarity rows were stripped by a poor Pass 7 render. Keep only the
// first `keepVisits` timeline-visit nodes and every similarity edge BOTH of
// whose endpoints survive — i.e. current.db as it looks after a chunked
// catch-up published from a node-poor window. The persisted HNSW store +
// revision store (which back the full corpus) are left untouched, so the
// adopted revision on the next drain — built via the exact-HNSW path when the
// full known set is reconciled — is still the full non-empty corpus while the
// SERVED rendered rows collapsed >90%.
const makeServedSnapshotWindowPoor = async (
  store: ReturnType<typeof createConnectionsStore>,
  keepVisits: number,
): Promise<void> => {
  const current = await store.readCurrent();
  if (current === null) throw new Error('expected a served snapshot');
  const visitNodeIds = current.nodes
    .filter((node) => node.kind === 'timeline-visit')
    .map((node) => node.id);
  const survivingVisitNodeIds = new Set(visitNodeIds.slice(0, keepVisits));
  const droppedVisitNodeIds = new Set(visitNodeIds.slice(keepVisits));
  const poor: ConnectionsSnapshot = {
    ...current,
    nodes: current.nodes.filter(
      (node) => node.kind !== 'timeline-visit' || survivingVisitNodeIds.has(node.id),
    ),
    // Drop every similarity edge whose endpoint node was removed — exactly what
    // the window-poor Pass 7 render produced (an edge that loses an endpoint is
    // filtered). With keepVisits=2 exactly ONE edge (the surviving pair)
    // remains → a >90% collapse of the 15-edge corpus, NOT a full wipe (so the
    // round-2 R2 bootstrap, which only fires on served=0, does NOT mask the
    // round-3 render/rebuild path under test).
    edges: current.edges.filter(
      (edge) =>
        edge.kind !== 'visit_resembles_visit' ||
        (!droppedVisitNodeIds.has(edge.fromNodeId) && !droppedVisitNodeIds.has(edge.toNodeId)),
    ),
  };
  await store.putCurrent(poor);
};

const readFloorDiagnostics = async (
  vaultRoot: string,
): Promise<{
  renderRepaired: boolean;
  renderedSimilarityFamilyEdgeCount: number;
  servedEdgeCount: number;
  bootstrapAdopted: boolean;
  laneUnloadedReuse: boolean;
  suppressedCollapse: boolean;
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

const seedDenseCorpus = async (
  m: { catchUp: (log: ReturnType<typeof createEventLog>) => Promise<unknown>; awaitIdle: () => Promise<unknown> },
  eventLog: ReturnType<typeof createEventLog>,
): Promise<void> => {
  for (const [i, key] of KEYS.entries()) {
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: i + 1,
        key,
        focusedWindowMs: 10_000,
        observedAt: `2026-07-24T10:0${String(i)}:00.000Z`,
      }),
    );
  }
  await m.catchUp(eventLog);
  await m.awaitIdle();
};

describe('connections materializer — RENDERED-edge floor (round-3, store-level)', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-renderfloor-'));
  });

  afterEach(async () => {
    delete process.env['SIDETRACK_SIMILARITY_FORCE_REBUILD'];
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // THE round-3 acceptance: window-poor served node set + a non-empty adopted
  // revision → the published current.db must NOT collapse its similarity rows.
  it('does not collapse current.db similarity rows when the served node set is window-poor', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);

    // Each drain is a FRESH materializer instance — mirrors the production
    // child-per-drain fork (the round-2 lesson: durable state must survive it).
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

    // Seed a dense 6-visit corpus.
    const seedM = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
    });
    await seedDenseCorpus(seedM, eventLog);
    const goodEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(goodEdgeCount).toBeGreaterThanOrEqual(10);

    // Reproduce the live round-3 current.db: keep only 2 of the 6 timeline-visit
    // nodes → the served snapshot renders just 1 similarity edge (a >90%
    // collapse of the 15-edge corpus), NOT zero. Served>0 means the round-2 R2
    // bootstrap (served=0 only) stays disarmed, isolating the round-3 rendered-
    // recovery path under test. This is the "snapshot ... only 3,089
    // timeline-visit nodes vs the ~9k-visit corpus" state, scaled down.
    await makeServedSnapshotWindowPoor(store, 2);
    const poorEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(poorEdgeCount).toBeGreaterThan(0);
    expect(poorEdgeCount).toBeLessThan(goodEdgeCount * 0.1); // >90% rendered collapse
    expect(timelineVisitNodeCount((await store.readCurrent())?.nodes)).toBe(2);

    // A drain that re-observes ALL 6 KNOWN visits above the gate. The full known
    // set is reconciled into the (still-populated) HNSW store, so the builder
    // recomputes the full corpus via the exact-HNSW path → the adopted revision
    // is the full 15-edge set. But the base would render from the window-poor
    // served snapshot (2 nodes) and Pass 7 would strip 14 edges. The round-3
    // rendered-recovery predicate (adopted 15 >> served-rendered 1) forces the
    // full-corpus base rebuild so current.db recovers; the T1 render floor is
    // the terminal backstop.
    for (const [i, key] of KEYS.entries()) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: 30 + i,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-24T10:3${String(i)}:00.000Z`,
        }),
      );
    }
    await runDrain();

    // READ BACK current.db (the served artifact resolvers read) and assert the
    // similarity-family rows did NOT collapse.
    const afterCurrent = await store.readCurrent();
    const afterEdgeCount = resemblesEdgeCount(afterCurrent?.edges);
    expect(afterEdgeCount).toBe(goodEdgeCount);
    // Endpoint-completion: the endpoint timeline-visit nodes the carried edges
    // reference all exist in the published snapshot (no dangling endpoints).
    const nodeIds = new Set((afterCurrent?.nodes ?? []).map((node) => node.id));
    for (const edge of afterCurrent?.edges ?? []) {
      if (edge.kind !== 'visit_resembles_visit') continue;
      expect(nodeIds.has(edge.fromNodeId)).toBe(true);
      expect(nodeIds.has(edge.toNodeId)).toBe(true);
    }
    // Diagnostics report the served-artifact truth: the rendered count matches
    // what is actually in current.db.
    const floor = await readFloorDiagnostics(vaultRoot);
    expect(floor.renderedSimilarityFamilyEdgeCount).toBeGreaterThanOrEqual(goodEdgeCount);
  });

  // Fresh-vault publish still works (no previous snapshot → nothing to repair;
  // the floor must not interfere with a legitimate first build).
  it('fresh vault: first publish emits the full similarity corpus (floor is inert)', async () => {
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
    await seedDenseCorpus(m, eventLog);
    const afterCurrent = await store.readCurrent();
    expect(resemblesEdgeCount(afterCurrent?.edges)).toBeGreaterThanOrEqual(10);
    // The floor did not repair anything on the fresh build.
    const floor = await readFloorDiagnostics(vaultRoot);
    expect(floor.renderRepaired).toBe(false);
  });

  // Defect #5 — a reset reason is NOT an unconditional wipe permit at the
  // rendered level either. An operator-forced rebuild over an EMPTY / window-poor
  // corpus (eligible << the persisted store) cannot assemble a corpus-complete
  // input, so the reset is DEFERRED and the render floor still REPAIRS the
  // window-poor collapse — the served signal is protected, not wiped. (A
  // corpus-complete operator rebuild — where the eligible set covers the store —
  // still publishes its collapse honestly; that is the corpus-complete path.)
  // Pre-fix this drain published the rendered collapse under the reset (a wipe);
  // the fix couples the reset to corpus-complete rebuild input.
  it('DEFERS an operator rebuild over an empty corpus and repairs the render (no wipe)', async () => {
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

    const seedM = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
    });
    await seedDenseCorpus(seedM, eventLog);
    const goodEdgeCount = resemblesEdgeCount((await store.readCurrent())?.edges);
    expect(goodEdgeCount).toBeGreaterThanOrEqual(10);

    await makeServedSnapshotWindowPoor(store, 2);
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeLessThan(
      goodEdgeCount * 0.1,
    ); // window-poor: a >90% rendered collapse

    // Operator forces a rebuild, but the drain carries an EMPTY corpus event
    // (no timeline visit) → the eligible corpus is 0 while the persisted store is
    // dense. The reset is deferred and the render floor repairs the collapse.
    process.env['SIDETRACK_SIMILARITY_FORCE_REBUILD'] = '1';
    await eventLog.importPeerEvent(emptyCorpusDrainEvent(30));
    await runDrain();

    const floor = await readFloorDiagnostics(vaultRoot);
    // The deferred reset did NOT wipe the served signal — the render was repaired
    // (or otherwise kept non-empty). Read back current.db (doctrine rule 10).
    expect(resemblesEdgeCount((await store.readCurrent())?.edges)).toBeGreaterThan(0);
    expect(floor.servedEdgeCount).toBeGreaterThan(0);
  });
});
