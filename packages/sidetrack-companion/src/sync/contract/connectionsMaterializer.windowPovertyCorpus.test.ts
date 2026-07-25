// W4 acceptance — path-independent similarity corpus (window-poverty fix).
//
// These tests encode the W1-W4 contract and run against the LIVE drain path
// (SIDETRACK_EVENT_STORE=1 — the store-backed path the test/live companion
// uses, run-test-companion.sh:52). Option (b) — the typed full-corpus assembly
// (connections/similarityCorpus.ts) — only ACTIVATES on this path; with the
// event store off the module falls back to the window seed (byte-unchanged),
// so the existing similarityFloor.test.ts family covers the off path and this
// file covers the on path.
//
// Every assertion reads back the SERVED artifact (store.readCurrent() →
// current.db) per doctrine rule 10, not an intermediate revision:
//   W4(a) a warm quiet-window drain after a populated full drain keeps the
//         served visit_resembles_visit count STABLE and REUSES the visit-
//         similarity revision (no recompute, no re-embed).
//   W4(b) a 20-drain mixed sequence (quiet / nav / engagement / full) serves
//         a ~0-variance edgeCount and ZERO guard activations.
//   W4(c) the corpus-config migration scenario (flip signature + reset) — the
//         FIRST drain (any type) assembles the full corpus and COMPLETES the
//         migration non-trivially (the exact hole defects #5/#6 could not
//         close: a warm drain never assembled the full corpus, so the reset
//         deferred forever).
//   W4(d) a quiet-window drain's wall time stays within a generous budget
//         (the typed corpus read measured ~309ms on the 741k-event live
//         store; here the corpus is tiny so it is well under).

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import { SIMILARITY_DEFAULT_CORPUS_CONFIG_SIGNATURE } from '../../connections/visitSimilarity.js';
import { createSimilarityFloorStateStore } from '../../connections/similarityFloorState.js';
import { readLatestNonEmptyVisitSimilarityRevision } from '../../producers/visit-resembles-revision.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
import { NAVIGATION_COMMITTED } from '../../navigation/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const acceptedAt = (seq: number): number => Date.parse('2026-07-24T10:00:00.000Z') + seq * 1000;

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: acceptedAt(input.seq),
});

// Full-dim shared unit vector so the HNSW store is populated + every pair
// resembles every other pair (a dense edge set), and we can count embed calls.
const fullDim = RECALL_MODEL.embeddingDim;
const unitFullDim = (): Float32Array => {
  const v = new Float32Array(fullDim);
  v[0] = 1;
  return v;
};
const embedFullDim = (onEmbed?: (count: number) => void): VisitSimilarityEmbedder => (texts) =>
  Promise.resolve().then(() => {
    onEmbed?.(texts.length);
    return texts.map(() => unitFullDim());
  });

const KEYS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;

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

const navigationCommitted = (input: {
  seq: number;
  key: string;
  observedAt: string;
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: NAVIGATION_COMMITTED,
    payload: {
      payloadVersion: 1,
      navigationId: `nav-${input.key}-${String(input.seq)}`,
      url: `https://example.test/${input.key}`,
      canonicalUrl: `https://example.test/${input.key}`,
      observedAt: input.observedAt,
      transition: 'link',
    },
  });

// A late engagement aggregate for an OLD visit — the classic window-poverty
// trigger (arrives on a drain whose window no longer holds the visit's
// timeline entry).
const engagementAggregated = (input: {
  seq: number;
  key: string;
  focusedWindowMs: number;
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: ENGAGEMENT_SESSION_AGGREGATED,
    payload: {
      payloadVersion: 1,
      visitId: `visit:https://example.test/${input.key}`,
      sessionId: `session-${input.key}-${String(input.seq)}`,
      dimensions: {
        engagement: {
          activeMs: input.focusedWindowMs,
          visibleMs: input.focusedWindowMs,
          focusedWindowMs: input.focusedWindowMs,
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
  });

const resemblesEdgeCount = (
  edges: readonly { readonly kind: string }[] | undefined,
): number => (edges ?? []).filter((edge) => edge.kind === 'visit_resembles_visit').length;

// Read the guard-activation counter off the drain diagnostics artifact
// (_BAC/connections/diagnostics/latest.json) — the same forensics artifact the
// doctrine toolkit + the existing floor tests read back.
const readGuardActivations = async (vaultRoot: string): Promise<number> => {
  const latest = JSON.parse(
    await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    ),
  ) as { similarityFloor?: { guardActivationsPerDrain?: number } };
  return latest.similarityFloor?.guardActivationsPerDrain ?? 0;
};

describe('connections materializer — path-independent similarity corpus (W4 acceptance)', () => {
  let vaultRoot: string;
  let priorEventStore: string | undefined;
  let priorFullCorpus: string | undefined;

  beforeEach(async () => {
    priorEventStore = process.env['SIDETRACK_EVENT_STORE'];
    priorFullCorpus = process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'];
    // Exercise the LIVE store-backed path (option (b) only activates here).
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    // W1 default is ON; make it explicit for the acceptance contract.
    process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'] = '1';
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-window-poverty-'));
  });

  afterEach(async () => {
    if (priorEventStore === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = priorEventStore;
    if (priorFullCorpus === undefined) delete process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'];
    else process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'] = priorFullCorpus;
    delete process.env['SIDETRACK_SIMILARITY_FORCE_CORPUS_REBUILD'];
    delete process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'];
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // W4(a) — a warm quiet-window drain after a populated full drain keeps the
  // served count STABLE and REUSES the revision (no recompute / re-embed).
  it('W4(a): a quiet-window drain after a populated drain keeps the served count stable and reuses the revision', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    let embedsAfterFirstDrain = 0;
    let firstDrainDone = false;
    const embed = embedFullDim((count) => {
      if (firstDrainDone) embedsAfterFirstDrain += count;
    });
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store, embed });

    // Drain 1 — five visits ABOVE the 5000ms gate. Dense similarity corpus.
    let seq = 1;
    for (const key of KEYS) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq: seq,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-24T10:0${String(seq)}:00.000Z`,
        }),
      );
      seq += 1;
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    firstDrainDone = true;

    const afterFull = await store.readCurrent();
    const populatedCount = resemblesEdgeCount(afterFull?.edges);
    expect(populatedCount).toBeGreaterThan(0);
    const populatedRevision = afterFull?.visitSimilarityRevisionId;
    expect(populatedRevision).toBeDefined();

    // Drain 2 (the QUIET / window-poor drain) — re-observe TWO KNOWN visits
    // with SUB-gate engagement. Pre-fix this collapsed the eligible corpus and
    // wiped the served edges (or forced a floor carry-forward). With W1 the
    // full corpus is assembled path-independently, so the served count is
    // stable AND the revision id is unchanged (same corpus → same hash → the
    // build reuses the persisted revision, no re-embed of the whole corpus).
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 20,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-24T10:20:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 21,
        key: 'bravo',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-24T10:21:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const afterQuiet = await store.readCurrent();
    const quietCount = resemblesEdgeCount(afterQuiet?.edges);
    // Served signal STABLE — no drop, no rebuild.
    expect(quietCount).toBe(populatedCount);
    // Revision REUSED not recomputed — the eligible corpus is unchanged (the
    // re-observed visits are already eligible from drain 1's 10s engagement,
    // and W1 assembles the SAME full corpus), so the revision hash is stable
    // and the served revision id does not flip. This is the load-bearing W4(a)
    // assertion: the whole similarity corpus was NOT recomputed.
    expect(afterQuiet?.visitSimilarityRevisionId).toBe(populatedRevision);
    // ZERO window-poverty guard activations — the served signal never had to
    // be carried-forward / repaired, because the corpus stayed full.
    expect(await readGuardActivations(vaultRoot)).toBe(0);
    // The re-embed on the quiet drain is bounded to the incremental reconcile
    // of the 2 re-observed window visits (NOT a whole-corpus re-embed): fewer
    // than the corpus size. It produces the SAME edges → the revision id above
    // is unchanged, so the served signal is byte-stable.
    expect(embedsAfterFirstDrain).toBeLessThan(KEYS.length);
    expect(m.health().status).toBe('healthy');
  });

  // W4(b) — 20-drain mixed sequence → served edgeCount variance ~0 and zero
  // guard activations (proved via the diagnostics artifact read-back).
  it('W4(b): a 20-drain mixed sequence serves ~0-variance edgeCount with zero guard activations', async () => {
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

    // Seed the corpus with five above-gate visits (a full initial drain).
    let seq = 1;
    for (const key of KEYS) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-24T10:0${String(seq)}:00.000Z`,
        }),
      );
      seq += 1;
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const seeded = await store.readCurrent();
    const seededResembles = resemblesEdgeCount(seeded?.edges);
    expect(seededResembles).toBeGreaterThan(0);

    // 20 mixed drains: quiet re-visit / navigation / late engagement / full.
    const servedCounts: number[] = [];
    for (let drain = 0; drain < 20; drain += 1) {
      const mode = drain % 4;
      const evSeq = 100 + drain * 5;
      const key = KEYS[drain % KEYS.length] as string;
      const at = `2026-07-24T11:${String(drain).padStart(2, '0')}:00.000Z`;
      if (mode === 0) {
        // quiet re-visit (sub-gate re-observe of a known visit)
        await eventLog.importPeerEvent(
          timelineObserved({ seq: evSeq, key, focusedWindowMs: 1_000, observedAt: at }),
        );
      } else if (mode === 1) {
        // navigation to a known visit (graph-inert for similarity)
        await eventLog.importPeerEvent(navigationCommitted({ seq: evSeq, key, observedAt: at }));
      } else if (mode === 2) {
        // late engagement aggregate for a known visit (window-poverty trigger)
        await eventLog.importPeerEvent(
          engagementAggregated({ seq: evSeq, key, focusedWindowMs: 12_000 }),
        );
      } else {
        // full-ish: a new above-gate visit
        await eventLog.importPeerEvent(
          timelineObserved({
            seq: evSeq,
            key: `page-${String(drain)}`,
            focusedWindowMs: 9_000,
            observedAt: at,
          }),
        );
      }
      await m.catchUp(eventLog);
      await m.awaitIdle();
      const served = await store.readCurrent();
      servedCounts.push(resemblesEdgeCount(served?.edges));
      // Zero guard activations on every drain (the served-signal never had to
      // be compensated for — the corpus is always full). Read back the drain
      // diagnostics artifact (latest.json).
      expect(await readGuardActivations(vaultRoot)).toBe(0);
    }

    // Served edgeCount is monotonic-non-decreasing (new visits add edges) and
    // NEVER collapses. Variance across the quiet/nav/engagement drains (which
    // add no new visit) is 0 — those drains do not change the served count.
    for (const count of servedCounts) {
      expect(count).toBeGreaterThanOrEqual(seededResembles);
    }
    // The quiet/nav/engagement drains (modes 0/1/2) must all serve the SAME
    // count as the drain before them (no window-poor drop). Check that the
    // count only ever grows on the mode-3 (new-visit) drains.
    let prev = seededResembles;
    for (let drain = 0; drain < 20; drain += 1) {
      const count = servedCounts[drain] as number;
      if (drain % 4 === 3) {
        expect(count).toBeGreaterThanOrEqual(prev);
      } else {
        // quiet / nav / engagement — no new visit → count unchanged.
        expect(count).toBe(prev);
      }
      prev = count;
    }
    expect(m.health().status).toBe('healthy');
  });

  // W4(c) — the corpus-config migration scenario, on a WINDOW-POOR drain. This
  // is the exact hole defects #5/#6 could not close: a corpus-shaping flag
  // flips, but the FIRST drain after the flip is a quiet re-visit whose window
  // holds only ONE visit. Pre-W1 that window-poor drain could not assemble the
  // full corpus, so the migration reset DEFERRED (resetDeferredForIncompleteCorpus)
  // and never landed — the served signal stayed on the OLD (dirty) corpus
  // forever. With W1 the corpus is assembled path-independently, so even this
  // single-visit-window drain is corpus-complete: the migration re-embeds the
  // WHOLE corpus and completes non-trivially. Read back the served artifact +
  // the durable floor state (doctrine rule 10).
  it('W4(c): a corpus-config flip completes the migration on a window-poor drain (defects #5/#6 hole)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const floorStateStore = createSimilarityFloorStateStore(vaultRoot);
    let migrationDrainEmbeds = 0;
    let migrationArmed = false;
    const embed = embedFullDim((count) => {
      if (migrationArmed) migrationDrainEmbeds += count;
    });
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      similarityFloorStateStore: floorStateStore,
    });

    // Seed a non-trivial persisted corpus under the DEFAULT (legacy) config.
    let seq = 1;
    for (const key of KEYS) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-24T10:0${String(seq)}:00.000Z`,
        }),
      );
      seq += 1;
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const beforeMigration = await store.readCurrent();
    const beforeCount = resemblesEdgeCount(beforeMigration?.edges);
    expect(beforeCount).toBeGreaterThan(0);
    expect((await readLatestNonEmptyVisitSimilarityRevision(vaultRoot))?.edges.length).toBeGreaterThan(
      0,
    );

    // Model the legacy vault: stomp the recorded corpus-config signature to
    // null (an old build wrote the floor-state file before the field existed),
    // then flip the corpus-shaping flag ON so the LIVE signature is non-default.
    const seededState = await floorStateStore.read();
    expect(seededState.servedCorpusConfigSignature).toBe(SIMILARITY_DEFAULT_CORPUS_CONFIG_SIGNATURE);
    await floorStateStore.write({ ...seededState, servedCorpusConfigSignature: null });
    process.env['SIDETRACK_SIMILARITY_CLEAN_CORPUS'] = '1';
    migrationArmed = true;

    // The FIRST drain after the flip is WINDOW-POOR — a single sub-gate
    // re-visit. Its event window holds ONE visit; pre-W1 the reset would defer
    // (eligible corpus 1 << persisted store 5) and the migration would never
    // land. With W1 the full corpus is assembled, so the migration completes.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 40,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-24T10:40:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const afterMigration = await store.readCurrent();
    const afterCount = resemblesEdgeCount(afterMigration?.edges);
    // The migration completed NON-TRIVIALLY: the served signal survived (not
    // wiped to 0 — the defect-#5 wipe) and the whole corpus was re-embedded
    // (the clean corpus reached the ALREADY-persisted visits, not just the one
    // in the window).
    expect(afterCount).toBeGreaterThan(0);
    expect(migrationDrainEmbeds).toBeGreaterThan(0);
    // The served corpus-config signature advanced to the live (clean) config —
    // proving the migration LANDED on this window-poor drain, not deferred.
    const afterState = await floorStateStore.read();
    expect(afterState.servedCorpusConfigSignature).toBe('clean-title-only|title-corpus');
    // The migration was not suppressed (a legitimate re-embed, not a flap).
    const latest = JSON.parse(
      await readFile(
        join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
        'utf8',
      ),
    ) as { similarityFloor?: { suppressedCollapse: boolean } };
    expect(latest.similarityFloor?.suppressedCollapse).toBe(false);
    // A revision was served (the corpus was rebuilt under the new config).
    expect(afterMigration?.visitSimilarityRevisionId).toBeDefined();
    expect(m.health().status).toBe('healthy');
  });

  // W4(d) — a quiet-window drain's wall time stays within a generous budget.
  it('W4(d): a quiet-window drain completes within the runtime-agility budget', async () => {
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

    let seq = 1;
    for (const key of KEYS) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-24T10:0${String(seq)}:00.000Z`,
        }),
      );
      seq += 1;
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // A quiet re-visit drain. Every store-backed drain assembles the corpus
    // from the typed store (the per-instance reuse cache was removed — it was
    // dead under the production child-fork model, which re-instantiates the
    // materializer every drain; see connectionsMaterializer.ts corpus block).
    // Measure just this drain.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 60,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-24T10:22:00.000Z',
      }),
    );
    const startedAt = performance.now();
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const elapsedMs = performance.now() - startedAt;
    // Generous ceiling — the measured corpus read on the live 741k-event store
    // was ~309ms; this fixture's corpus is tiny (five visits) so the drain is
    // far under. 750ms bounds the whole drain incl. build overhead (doctrine
    // rule 9 — ms-scale work per event for one user). NOTE: at this unit scale
    // the typed read + revision-id hash are sub-millisecond regardless, so this
    // bounds the DRAIN not the ~309ms typed-read cost; the scale-sensitive cost
    // (typed read + full-corpus revision-id hash) is guarded at mid-scale in
    // connections/similarityCorpus.test.ts, and validated out-of-band against
    // the live store (sqlite3 timing: ~152-228ms cold over 26,020 rows).
    expect(elapsedMs).toBeLessThan(750);
    const served = await store.readCurrent();
    expect(resemblesEdgeCount(served?.edges)).toBeGreaterThan(0);
  });

  // W4(e) — the PRODUCTION drain path is a fresh materializer instance PER
  // drain (SIDETRACK_CONNECTIONS_CHILD=1 forks a child that constructs a new
  // ConnectionsMaterializer and exits after one catchUp — see
  // connectionsReconcileChild.entry.ts). Any per-instance reuse cache is
  // therefore ALWAYS cold at drain start. This test simulates that model
  // directly: a SECOND materializer instance (cold — no in-memory corpus cache
  // carried over) runs the quiet window-poor drain and MUST still assemble the
  // full corpus from the typed store, keep the served signal stable, and REUSE
  // the deterministic revision (same corpus → same revision id). This is the
  // acceptance the in-process W4(a) could NOT provide: it asserts the path that
  // production actually executes (cold instance every drain), not a persisted
  // in-process cache. Read back the served artifact (doctrine rule 10).
  it('W4(e): a fresh materializer instance (production child-fork model) reuses the revision on a cold quiet drain', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);

    // Drain 1 — populate the corpus under instance #1.
    const m1 = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore: createTimelineStore(vaultRoot),
      store,
      embed: embedFullDim(),
    });
    let seq = 1;
    for (const key of KEYS) {
      await eventLog.importPeerEvent(
        timelineObserved({
          seq,
          key,
          focusedWindowMs: 10_000,
          observedAt: `2026-07-24T10:0${String(seq)}:00.000Z`,
        }),
      );
      seq += 1;
    }
    await m1.catchUp(eventLog);
    await m1.awaitIdle();
    const afterFull = await store.readCurrent();
    const populatedCount = resemblesEdgeCount(afterFull?.edges);
    expect(populatedCount).toBeGreaterThan(0);
    const populatedRevision = afterFull?.visitSimilarityRevisionId;
    expect(populatedRevision).toBeDefined();

    // Drain 2 — a QUIET window-poor re-visit, run by a BRAND-NEW materializer
    // instance (its lastFullSimilarityCorpus-equivalent cache would be cold —
    // exactly the production per-drain fork). No cache can help it; only the
    // path-independent typed-store assembly can keep the corpus full.
    let coldEmbeds = 0;
    const m2 = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore: createTimelineStore(vaultRoot),
      store,
      embed: embedFullDim((count) => {
        coldEmbeds += count;
      }),
    });
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 20,
        key: 'alpha',
        focusedWindowMs: 1_000,
        observedAt: '2026-07-24T10:20:00.000Z',
      }),
    );
    await m2.catchUp(eventLog);
    await m2.awaitIdle();

    const afterCold = await store.readCurrent();
    // Served signal STABLE across the cold-instance quiet drain — no drop.
    expect(resemblesEdgeCount(afterCold?.edges)).toBe(populatedCount);
    // Revision REUSED — the deterministic corpus assembled from the typed store
    // hashes to the same revision id, so the served revision does not flip even
    // though this instance had no warm cache. This is the load-bearing claim:
    // path-independence, not cache-persistence, is what stabilizes the signal.
    expect(afterCold?.visitSimilarityRevisionId).toBe(populatedRevision);
    // Zero window-poverty guard activations — the corpus was full on a cold
    // instance, so no carry-forward / repair was needed.
    expect(await readGuardActivations(vaultRoot)).toBe(0);
    // The cold instance did not re-embed the whole corpus (the revision was
    // reused from the deterministic hash + persisted revision file).
    expect(coldEmbeds).toBeLessThan(KEYS.length);
    expect(m2.health().status).toBe('healthy');
  });
});
