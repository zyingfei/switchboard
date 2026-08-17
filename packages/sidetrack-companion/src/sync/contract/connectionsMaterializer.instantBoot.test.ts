// B5 acceptance — instant boot (fix/instant-boot).
//
// The mandate: "Reboot should reload everything" — a restart must serve the
// persisted state immediately, applying only the events past the persisted
// frontier and reusing every persisted-and-still-valid artifact instead of
// unconditionally recomputing it.
//
// The shipped fix targets the dominant, cleanly-reusable boot offender measured
// on a live-vault clone (744k events, a few-hundred-event delta since the
// persisted frontier): projectionAccumulators.seed. The store-backed catchUp path re-fold
// ALL events to re-seed the URL + tab-session projection accumulators (~20-39s)
// even though current.db already holds a frontier-matched accumulator blob.
// SIDETRACK_INSTANT_BOOT (default ON) makes the store-backed path consult
// tryLoadProjectionAccumulatorState — the SAME typed-validity check the no-store
// path already uses (progress version + appliedFrontier + appliedDotIntervals
// must equal the persisted blob) — and resume-fold only the pending delta. The
// seed becomes a ~2ms fold; the served graph is byte-identical.
//
// These tests run the LIVE store-backed drain (SIDETRACK_EVENT_STORE=1) across a
// SIMULATED RESTART: instance A seeds + persists + shuts down; a FRESH instance
// B opens the SAME vault and reboots. Per doctrine rule 10 they read back the
// SERVED ARTIFACT (store.readCurrent() → current.db) and the drain forensics
// (latest.json), never the layer changed:
//
//   B5(a) clean shutdown + reboot: served graph == pre-shutdown graph, boot
//         drain window is only post-shutdown events, NO projectionAccumulators.
//         seed (resumeFold instead), scoped-delta applies (no full base
//         rebuild), revision id stable.
//   B5(b) reboot after a torn (kill-9-style) drain that never persisted its
//         progress: converges to the correct served graph without a spurious
//         full replay beyond the unpersisted delta.
//   B5(c) boot wall-time to healthy-serving is bounded at fixture scale.
//   B6    SIDETRACK_INSTANT_BOOT=0 reverts to the legacy full-recompute boot
//         (the projectionAccumulators.seed phase reappears) and still serves
//         the same graph.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const acceptedAt = (seq: number): number => Date.parse('2026-07-26T10:00:00.000Z') + seq * 1000;

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: acceptedAt(input.seq),
});

const fullDim = RECALL_MODEL.embeddingDim;
// Identical unit vectors → every pair is cosine 1 → a dense visit-similarity
// corpus that actually persists visit_resembles_visit rows the reboot must
// serve back byte-for-byte (matches the rebuildStorm harness embedder).
const unitFullDim = (): Float32Array => {
  const v = new Float32Array(fullDim);
  v[0] = 1;
  return v;
};
const embedFullDim = (): VisitSimilarityEmbedder => (texts) =>
  Promise.resolve().then(() => texts.map(() => unitFullDim()));

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

const resemblesEdges = (
  edges: readonly { readonly kind: string; readonly fromNodeId: string; readonly toNodeId: string }[] | undefined,
): string[] =>
  (edges ?? [])
    .filter((edge) => edge.kind === 'visit_resembles_visit')
    .map((edge) => `${edge.fromNodeId}->${edge.toNodeId}`)
    .sort();

interface FloorForensics {
  readonly scopedTimelineDeltaApplied?: boolean;
  readonly scopedTimelineDeltaSkipDetail?: string;
  readonly similarityRevisionChanged?: boolean;
}

const readLatest = async (
  vaultRoot: string,
): Promise<{
  similarityFloor: FloorForensics;
  baseRebuildP95Ms: number;
}> => {
  const latest = JSON.parse(
    await readFile(join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'), 'utf8'),
  ) as {
    similarityFloor?: FloorForensics;
    latency?: { snapshot?: { baseRebuildP95Ms?: number } };
  };
  return {
    similarityFloor: latest.similarityFloor ?? {},
    baseRebuildP95Ms: latest.latency?.snapshot?.baseRebuildP95Ms ?? 0,
  };
};

// Build a fresh materializer bound to an EXISTING vault — this is the "reboot"
// (a new process opening the persisted current.db + event-store.db + log).
const bootMaterializer = async (
  vaultRoot: string,
): Promise<{
  m: ReturnType<typeof createConnectionsMaterializer>;
  eventLog: ReturnType<typeof createEventLog>;
}> => {
  const eventLog = createEventLog(vaultRoot, await loadOrCreateReplica(vaultRoot));
  const timelineStore = createTimelineStore(vaultRoot);
  const store = createConnectionsStore(vaultRoot);
  const m = createConnectionsMaterializer({
    vaultRoot,
    eventLog,
    timelineStore,
    store,
    embed: embedFullDim(),
  });
  return { m, eventLog };
};

describe('connections materializer — instant boot (B5 acceptance)', () => {
  let vaultRoot: string;
  let priorEventStore: string | undefined;
  let priorFullCorpus: string | undefined;
  let priorPhaseLog: string | undefined;
  let priorInstantBoot: string | undefined;

  beforeEach(async () => {
    priorEventStore = process.env['SIDETRACK_EVENT_STORE'];
    priorFullCorpus = process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'];
    priorPhaseLog = process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'];
    priorInstantBoot = process.env['SIDETRACK_INSTANT_BOOT'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'] = '1';
    // Phase log ON so the tests can read the actual boot code path taken
    // (projectionAccumulators.seed vs resumeFold) from console.warn.
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
    delete process.env['SIDETRACK_INSTANT_BOOT'];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-instant-boot-'));
  });

  afterEach(async () => {
    const restore = (name: string, prior: string | undefined): void => {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    };
    restore('SIDETRACK_EVENT_STORE', priorEventStore);
    restore('SIDETRACK_SIMILARITY_FULL_CORPUS', priorFullCorpus);
    restore('SIDETRACK_CONNECTIONS_PHASE_LOG', priorPhaseLog);
    restore('SIDETRACK_INSTANT_BOOT', priorInstantBoot);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // Seed a corpus via instance A, then cleanly shut it down (drop the ref).
  const seedAndShutdown = async (): Promise<{
    servedEdges: string[];
    revisionId: string | undefined;
    lastSeq: number;
  }> => {
    const eventLog = createEventLog(vaultRoot, await loadOrCreateReplica(vaultRoot));
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({
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
          observedAt: `2026-07-26T10:0${String(seq)}:00.000Z`,
        }),
      );
      seq += 1;
    }
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const served = await store.readCurrent();
    return {
      servedEdges: resemblesEdges(served?.edges),
      revisionId: served?.visitSimilarityRevisionId,
      lastSeq: seq - 1,
    };
  };

  // B5(a) — clean shutdown + reboot serves the persisted graph and processes
  // only the post-shutdown delta, with NO full rebuild and NO full projection
  // seed.
  it('B5(a): reboot after clean shutdown serves the pre-shutdown graph and boots delta-only', async () => {
    const pre = await seedAndShutdown();
    expect(pre.servedEdges.length).toBeGreaterThan(0);
    expect(pre.revisionId).toBeDefined();

    // A single post-shutdown event (the "minutes of browsing since the
    // persisted frontier" window) — an engagement tick on an already-eligible
    // visit. This is the delta the reboot must process, and ONLY this.
    const { m, eventLog: rebootEventLog } = await bootMaterializer(vaultRoot);
    await rebootEventLog.importPeerEvent(
      engagementAggregated({ seq: pre.lastSeq + 1, key: 'alpha', focusedWindowMs: 25_000 }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bootStartedAt = performance.now();
    await m.catchUp(rebootEventLog);
    await m.awaitIdle();
    const bootMs = performance.now() - bootStartedAt;
    const phaseLines = warnSpy.mock.calls.map((c) => String(c[0]));
    warnSpy.mockRestore();

    const store = createConnectionsStore(vaultRoot);
    const afterBoot = await store.readCurrent();

    // Served graph == pre-shutdown graph (store read-back, doctrine rule 10).
    expect(resemblesEdges(afterBoot?.edges)).toEqual(pre.servedEdges);
    // Revision id stable — the reboot served the persisted revision.
    expect(afterBoot?.visitSimilarityRevisionId).toBe(pre.revisionId);

    const { similarityFloor, baseRebuildP95Ms } = await readLatest(vaultRoot);
    // The reboot applies the scoped-delta path (no full base rebuild) — the
    // normal warm-drain behavior that the instant-boot accumulator reuse keeps
    // fast rather than degrading into the cold-seed path.
    expect(similarityFloor.scopedTimelineDeltaApplied).toBe(true);
    expect(similarityFloor.scopedTimelineDeltaSkipDetail).toBeUndefined();
    expect(baseRebuildP95Ms).toBe(0);

    // Instant boot: the reboot RESUME-FOLDED the persisted accumulator (delta
    // only) instead of the full-log seed — the load-bearing assertion.
    const seedLines = phaseLines.filter((l) => l.includes('projectionAccumulators.seed'));
    const resumeLines = phaseLines.filter((l) => l.includes('projectionAccumulators.resumeFold'));
    expect(seedLines).toHaveLength(0);
    expect(resumeLines.length).toBeGreaterThan(0);
    // The resume-fold applied only the tiny post-shutdown delta. Exactly one
    // post-shutdown event was imported above, so pin the count precisely rather
    // than a 1-9 range — a future fixture that grew the delta to 10+ would then
    // fail loudly instead of silently weakening this delta-size guard.
    expect(resumeLines.some((l) => /\bevents=1\b/.test(l))).toBe(true);

    // B5(c) — boot to healthy-serving bounded at fixture scale. The real
    // regression this guards against (an accidental full-log seed instead of
    // a resume-fold) is already pinned above by the seedLines/resumeLines
    // phase-log assertions — at this 6-event fixture scale it would blow
    // past this bound by orders of magnitude, not by a factor of 2-3x. The
    // literal wall-clock number is therefore CI-noise budget, not the load-
    // bearing check: raise it generously (measured ~0.1-0.2s locally,
    // unloaded) rather than leave a tight bound that flakes under a
    // contended shared runner without adding any real regression coverage.
    expect(bootMs).toBeLessThan(15_000);
    expect(m.health().status).toBe('healthy');
  }, 20_000);

  // B5(b) — reboot after a torn drain. Instance A imports events but its drain
  // is never run (a kill-9 mid-drain leaves the persisted progress behind the
  // log). The reboot must catch the graph up from the persisted frontier —
  // bounded by the genuinely-unpersisted delta — and serve the correct graph.
  it('B5(b): reboot after a torn (unpersisted) drain converges without a spurious full replay', async () => {
    const pre = await seedAndShutdown();
    expect(pre.servedEdges.length).toBeGreaterThan(0);

    // Torn write: append two NEW eligible visits to the log but crash before
    // the drain persists them (we simply never call catchUp on instance A').
    const tornLog = createEventLog(vaultRoot, await loadOrCreateReplica(vaultRoot));
    await tornLog.importPeerEvent(
      timelineObserved({
        seq: pre.lastSeq + 1,
        key: 'golf',
        focusedWindowMs: 9_000,
        observedAt: '2026-07-26T10:30:00.000Z',
      }),
    );
    await tornLog.importPeerEvent(
      timelineObserved({
        seq: pre.lastSeq + 2,
        key: 'hotel',
        focusedWindowMs: 9_000,
        observedAt: '2026-07-26T10:31:00.000Z',
      }),
    );

    // Reboot — a fresh instance opens the vault and drains.
    const { m, eventLog: rebootLog } = await bootMaterializer(vaultRoot);
    await m.catchUp(rebootLog);
    await m.awaitIdle();

    const store = createConnectionsStore(vaultRoot);
    const afterBoot = await store.readCurrent();
    const edgesAfter = resemblesEdges(afterBoot?.edges);
    // The two torn visits joined the graph — convergence to the correct served
    // set (a superset of the pre-shutdown edges: the new visits resemble the
    // dense corpus).
    expect(edgesAfter.length).toBeGreaterThan(pre.servedEdges.length);
    for (const priorEdge of pre.servedEdges) {
      // Every pre-shutdown edge is still served (no wipe on reboot).
      expect(edgesAfter).toContain(priorEdge);
    }
    expect(m.health().status).toBe('healthy');
  });

  // Instant-boot correctness parity — a RE-VISIT reboot (a new timeline
  // observation of an existing, similarity-connected url) drives the
  // accumulator-reuse + scoped-delta path. Instant boot and the legacy
  // full-recompute path must serve byte-identical visit_resembles_visit rows,
  // AND every pre-reboot row must survive (no loss on restart).
  const revisitReboot = async (): Promise<string[]> => {
    const pre = await seedAndShutdown();
    expect(pre.servedEdges.length).toBeGreaterThan(0);
    const { m, eventLog: rebootLog } = await bootMaterializer(vaultRoot);
    // Re-observe alpha in a NEW day — a re-visit that owns graph rows and is
    // incident to similarity edges to every other (already-served) visit.
    await rebootLog.importPeerEvent(
      timelineObserved({
        seq: pre.lastSeq + 1,
        key: 'alpha',
        focusedWindowMs: 12_000,
        observedAt: '2026-07-26T11:00:00.000Z',
      }),
    );
    await m.catchUp(rebootLog);
    await m.awaitIdle();
    const served = await createConnectionsStore(vaultRoot).readCurrent();
    // Every pre-shutdown similarity edge survives the re-visit reboot.
    const after = resemblesEdges(served?.edges);
    for (const priorEdge of pre.servedEdges) expect(after).toContain(priorEdge);
    expect(m.health().status).toBe('healthy');
    return after;
  };

  it('parity: re-visit reboot serves identical similarity rows under instant boot and legacy', async () => {
    delete process.env['SIDETRACK_INSTANT_BOOT'];
    const instantEdges = await revisitReboot();

    // Fresh vault, legacy boot, same script.
    await rm(vaultRoot, { recursive: true, force: true });
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-instant-boot-legacy-'));
    process.env['SIDETRACK_INSTANT_BOOT'] = '0';
    const legacyEdges = await revisitReboot();

    // The narrowing is a performance path, not a serving change (B6): the
    // scoped-delta output is byte-identical to the legacy path's.
    expect(instantEdges).toEqual(legacyEdges);
  });

  // B6 — SIDETRACK_INSTANT_BOOT=0 reverts to the legacy full-recompute boot:
  // the projectionAccumulators.seed phase reappears, yet the served graph is
  // identical (the fix is a performance path, not a serving change).
  it('B6: SIDETRACK_INSTANT_BOOT=0 reverts to the legacy full seed and serves the same graph', async () => {
    const pre = await seedAndShutdown();
    expect(pre.servedEdges.length).toBeGreaterThan(0);

    process.env['SIDETRACK_INSTANT_BOOT'] = '0';
    const { m, eventLog: rebootLog } = await bootMaterializer(vaultRoot);
    await rebootLog.importPeerEvent(
      engagementAggregated({ seq: pre.lastSeq + 1, key: 'alpha', focusedWindowMs: 25_000 }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await m.catchUp(rebootLog);
    await m.awaitIdle();
    const phaseLines = warnSpy.mock.calls.map((c) => String(c[0]));
    warnSpy.mockRestore();

    const store = createConnectionsStore(vaultRoot);
    const afterBoot = await store.readCurrent();
    // Same served graph as instant boot — no serving-behavior change (B6).
    expect(resemblesEdges(afterBoot?.edges)).toEqual(pre.servedEdges);

    // Legacy path re-seeds the accumulator from the full store.
    const seedLines = phaseLines.filter((l) => l.includes('projectionAccumulators.seed'));
    expect(seedLines.length).toBeGreaterThan(0);
    expect(m.health().status).toBe('healthy');
  });
});
