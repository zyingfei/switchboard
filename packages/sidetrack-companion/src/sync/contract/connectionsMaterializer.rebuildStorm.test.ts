// W5 acceptance — M3 rebuild-storm fix (engagement-tick revision churn).
//
// The M3 path-independent corpus (PR #277) made the similarity lane assemble
// the FULL corpus (with full accumulated engagement) on EVERY drain. Under
// ACTIVE browsing that exposed a latent churn: revisionIdFor hashed each
// visit's volatile focusedWindowMs value, so an engagement tick that merely
// raised the focus of an ALREADY-ELIGIBLE visit (no membership change, no
// corpus-text change) minted a NEW visit-similarity revisionId → a new topic
// revision → topicSame=false → the scoped-delta snapshot gate skipped
// (reason=unknown-inner) → a ~20s full base rebuild in the reconcile child, on
// every drain (the "rebuild storm").
//
// These tests run the LIVE store-backed drain (SIDETRACK_EVENT_STORE=1 — the
// path the M3 corpus lane activates on) and read back the SERVED artifacts per
// doctrine rule 10:
//   - the served graph: store.readCurrent() → current.db edge count + revision
//   - the drain forensics: _BAC/connections/diagnostics/latest.json
//     (scopedTimelineDeltaApplied / similarityRevisionChanged / hnswFullRebuild
//     / hnswInsertedCount / guardActivationsPerDrain).
//
//   W5(a) engagement-tick-only window (already-eligible visit gains focus):
//         revisionId UNCHANGED, scoped-delta path APPLIES, no full rebuild,
//         served table unchanged, drain wall-time ms-scale (bounded).
//   W5(b) new-eligible-visit window: HNSW inserts ONLY the delta (== delta
//         size, not corpus size); served table gains the new visit's edges.
//   W5(c) 10-drain active-browsing sim (ticks + 2 new visits): <=1 full
//         rebuild, revisionId changes <=2, guard activations 0.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

const acceptedAt = (seq: number): number => Date.parse('2026-07-25T10:00:00.000Z') + seq * 1000;

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

// An engagement aggregate RAISING an already-eligible visit's focus. This is
// the live rebuild-storm trigger: the corpus lane folds the higher focus back
// onto the (already-eligible) visit, so the pre-fix revision-id hash churned
// even though the eligible SET and the corpus text are unchanged.
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

const resemblesEdgeCount = (edges: readonly { readonly kind: string }[] | undefined): number =>
  (edges ?? []).filter((edge) => edge.kind === 'visit_resembles_visit').length;

interface FloorForensics {
  readonly guardActivationsPerDrain?: number;
  readonly scopedTimelineDeltaApplied?: boolean;
  readonly scopedTimelineDeltaSkipDetail?: string;
  readonly similarityRevisionChanged?: boolean;
  readonly hnswFullRebuild?: boolean;
  readonly hnswInsertedCount?: number;
}

const readFloorForensics = async (vaultRoot: string): Promise<FloorForensics> => {
  const latest = JSON.parse(
    await readFile(join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'), 'utf8'),
  ) as { similarityFloor?: FloorForensics };
  return latest.similarityFloor ?? {};
};

const seedCorpus = async (input: {
  eventLog: ReturnType<typeof createEventLog>;
  m: ReturnType<typeof createConnectionsMaterializer>;
  store: ReturnType<typeof createConnectionsStore>;
}): Promise<{ count: number; revisionId: string | undefined }> => {
  let seq = 1;
  for (const key of KEYS) {
    await input.eventLog.importPeerEvent(
      timelineObserved({
        seq,
        key,
        focusedWindowMs: 10_000,
        observedAt: `2026-07-25T10:0${String(seq)}:00.000Z`,
      }),
    );
    seq += 1;
  }
  await input.m.catchUp(input.eventLog);
  await input.m.awaitIdle();
  const served = await input.store.readCurrent();
  return {
    count: resemblesEdgeCount(served?.edges),
    revisionId: served?.visitSimilarityRevisionId,
  };
};

describe('connections materializer — M3 rebuild-storm fix (W5 acceptance)', () => {
  let vaultRoot: string;
  let priorEventStore: string | undefined;
  let priorFullCorpus: string | undefined;
  let priorCorpusLane: string | undefined;

  beforeEach(async () => {
    priorEventStore = process.env['SIDETRACK_EVENT_STORE'];
    priorFullCorpus = process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'];
    priorCorpusLane = process.env['SIDETRACK_SIMILARITY_CORPUS_LANE'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'] = '1';
    delete process.env['SIDETRACK_SIMILARITY_CORPUS_LANE'];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-rebuild-storm-'));
  });

  afterEach(async () => {
    const restore = (name: string, prior: string | undefined): void => {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    };
    restore('SIDETRACK_EVENT_STORE', priorEventStore);
    restore('SIDETRACK_SIMILARITY_FULL_CORPUS', priorFullCorpus);
    restore('SIDETRACK_SIMILARITY_CORPUS_LANE', priorCorpusLane);
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // W5(a) — engagement-tick-only window on an already-eligible visit:
  // revisionId UNCHANGED, scoped-delta APPLIES, no full rebuild, served table
  // unchanged, drain ms-scale.
  it('W5(a): an engagement tick on an already-eligible visit does NOT churn the revision or force a rebuild', async () => {
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

    const seeded = await seedCorpus({ eventLog, m, store });
    expect(seeded.count).toBeGreaterThan(0);
    expect(seeded.revisionId).toBeDefined();

    // The engagement tick: RAISE alpha's focus from 10s to 25s. alpha is
    // already eligible (>=5s from the seed). Pre-fix this flipped the revision
    // (focusedWindowMs 10000 -> 25000 in the hash); post-fix the eligible SET
    // and corpus text are unchanged, so the revision id is stable.
    await eventLog.importPeerEvent(
      engagementAggregated({ seq: 30, key: 'alpha', focusedWindowMs: 25_000 }),
    );
    const startedAt = performance.now();
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const elapsedMs = performance.now() - startedAt;

    const afterTick = await store.readCurrent();
    // Served signal STABLE.
    expect(resemblesEdgeCount(afterTick?.edges)).toBe(seeded.count);
    // Revision id UNCHANGED — the load-bearing assertion (no churn).
    expect(afterTick?.visitSimilarityRevisionId).toBe(seeded.revisionId);

    const forensics = await readFloorForensics(vaultRoot);
    // Scoped-delta path APPLIED (no fall-through to a full base rebuild).
    expect(forensics.scopedTimelineDeltaApplied).toBe(true);
    // No skip reason recorded (the gate did not fail).
    expect(forensics.scopedTimelineDeltaSkipDetail).toBeUndefined();
    // The served revision did not change vs the previously served snapshot.
    expect(forensics.similarityRevisionChanged).toBe(false);
    // No full HNSW re-embed.
    expect(forensics.hnswFullRebuild).toBe(false);
    // Zero window-poverty / rebuild-storm guard activations.
    expect(forensics.guardActivationsPerDrain).toBe(0);
    // ms-scale (doctrine rule 9) — a tiny fixture drain must be far under the
    // ~20s full rebuild the storm produced.
    expect(elapsedMs).toBeLessThan(1_500);
    expect(m.health().status).toBe('healthy');
  });

  // W5(b) — a NEW eligible visit: the HNSW producer inserts ONLY the delta
  // (one visit), not the whole corpus; the served table gains its edges.
  it('W5(b): a new eligible visit embeds only the delta and grows the served table', async () => {
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

    const seeded = await seedCorpus({ eventLog, m, store });
    expect(seeded.count).toBeGreaterThan(0);

    // A new above-gate visit — the delta is exactly ONE visit.
    await eventLog.importPeerEvent(
      timelineObserved({
        seq: 40,
        key: 'foxtrot',
        focusedWindowMs: 9_000,
        observedAt: '2026-07-25T10:40:00.000Z',
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const afterNew = await store.readCurrent();
    // Served table GAINS the new visit's edges (it resembles the dense corpus).
    expect(resemblesEdgeCount(afterNew?.edges)).toBeGreaterThan(seeded.count);

    const forensics = await readFloorForensics(vaultRoot);
    // Incremental embed of the DELTA ONLY — 1 new visit, not the 5-visit corpus.
    expect(forensics.hnswInsertedCount).toBe(1);
    expect(forensics.hnswInsertedCount).toBeLessThan(KEYS.length);
    // Not a full rebuild.
    expect(forensics.hnswFullRebuild).toBe(false);
    // The revision legitimately changed (a new eligible member joined the set).
    expect(forensics.similarityRevisionChanged).toBe(true);
    // No compensation guards.
    expect(forensics.guardActivationsPerDrain).toBe(0);
    expect(m.health().status).toBe('healthy');
  });

  // W5(c) — a 10-drain active-browsing simulation: 8 engagement ticks + 2 new
  // visits. At most 1 full rebuild, the revision id changes at most twice (once
  // per new visit), and zero guard activations.
  it('W5(c): a 10-drain active-browsing sim takes <=1 rebuild, <=2 revision changes, 0 guards', async () => {
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

    const seeded = await seedCorpus({ eventLog, m, store });
    expect(seeded.count).toBeGreaterThan(0);

    let fullRebuildCount = 0;
    let revisionChangeCount = 0;
    let guardActivationsTotal = 0;
    let prevRevision = seeded.revisionId;

    // 10 drains. Drains 3 and 7 introduce a NEW eligible visit; the rest are
    // engagement ticks raising the focus of an already-eligible visit (the
    // storm trigger). Each tick uses a monotonically increasing focus so the
    // pre-fix hash would churn every drain.
    for (let drain = 0; drain < 10; drain += 1) {
      const evSeq = 100 + drain * 5;
      const at = `2026-07-25T11:${String(drain).padStart(2, '0')}:00.000Z`;
      if (drain === 3 || drain === 7) {
        await eventLog.importPeerEvent(
          timelineObserved({
            seq: evSeq,
            key: `new-${String(drain)}`,
            focusedWindowMs: 9_000,
            observedAt: at,
          }),
        );
      } else {
        const key = KEYS[drain % KEYS.length] as string;
        await eventLog.importPeerEvent(
          engagementAggregated({ seq: evSeq, key, focusedWindowMs: 11_000 + drain * 1_000 }),
        );
      }
      await m.catchUp(eventLog);
      await m.awaitIdle();

      const served = await store.readCurrent();
      const forensics = await readFloorForensics(vaultRoot);
      if (forensics.hnswFullRebuild === true) fullRebuildCount += 1;
      if (served?.visitSimilarityRevisionId !== prevRevision) revisionChangeCount += 1;
      prevRevision = served?.visitSimilarityRevisionId;
      guardActivationsTotal += forensics.guardActivationsPerDrain ?? 0;
    }

    // <=1 full rebuild across the whole active-browsing window (a rebuild storm
    // was 10/10). In steady active browsing there should be zero.
    expect(fullRebuildCount).toBeLessThanOrEqual(1);
    // The revision id changes at most twice — once per genuinely-new eligible
    // visit (drains 3 and 7). Engagement ticks must not change it.
    expect(revisionChangeCount).toBeLessThanOrEqual(2);
    // Zero window-poverty / rebuild-storm compensation guards.
    expect(guardActivationsTotal).toBe(0);
    expect(m.health().status).toBe('healthy');
  });

  // W5(d) — SIDETRACK_SIMILARITY_CORPUS_LANE=0 kill switch reverts the M3
  // corpus lane to legacy window assembly (the documented rollback path). The
  // drain must still complete and serve a snapshot; the lane simply falls back
  // to the caller's window events (byte-unchanged pre-M3 behavior). This pins
  // that the operator has a single-flip escape if the lane ever regresses.
  it('W5(d): SIDETRACK_SIMILARITY_CORPUS_LANE=0 reverts to window assembly and still serves', async () => {
    process.env['SIDETRACK_SIMILARITY_CORPUS_LANE'] = '0';
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

    // With the lane OFF the corpus comes from the drain window. A single cold
    // catch-up over all five seed visits still assembles them (they are all in
    // the window), so the served signal is populated and the drain is healthy.
    const seeded = await seedCorpus({ eventLog, m, store });
    expect(seeded.count).toBeGreaterThan(0);
    expect(seeded.revisionId).toBeDefined();
    expect(m.health().status).toBe('healthy');
  });
});
