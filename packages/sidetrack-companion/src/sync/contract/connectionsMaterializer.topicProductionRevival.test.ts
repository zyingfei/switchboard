// W5 — topic production revival, end-to-end against the real materializer.
//
// Reproduces the exact class of bug diagnosed against two live vault
// copies (see topicProductionRevival.ts's header): a topic-cadence-due
// drain whose OWN delta window holds no fresh BROWSER_TIMELINE_OBSERVED
// entries (because the similarity layer's own window-poverty fix already
// lets a LATE signal — e.g. a requalifying ENGAGEMENT_SESSION_AGGREGATED —
// change `visitSimilarity.revisionId` without a fresh timeline entry in
// this drain's window) drives `buildLeidenCpmTopicRevision` with an empty
// visits list, wiping every existing topic to 'death'.
//
// Two things are exercised:
//   1. `SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE` (the pre-existing,
//      previously-default-off remedy inside connectionsMaterializer.ts)
//      genuinely prevents the collapse when set — proving the root-cause
//      diagnosis, not just patching a symptom.
//   2. The collapse-guard wrapper (topicProductionRevival.ts) is an
//      effective backstop even when that flag is left off — the served
//      topic revision never regresses to zero once it was healthy.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import {
  ensureTopicFullTimelineSourceDefault,
  wrapTopicRevisionStoreForProduction,
} from '../../connections/topicProductionRevival.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { createTopicRevisionStore } from '../../producers/topic-revision.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const acceptedAt = (seq: number): number => Date.parse('2026-08-15T10:00:00.000Z') + seq * 1000;

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: acceptedAt(input.seq),
});

// Dense identical vectors so cosine=1.0 between every pair — well above
// the leiden-cpm serving threshold (0.9) — so any eligible pair of visits
// clusters into one topic.
const fullDim = RECALL_MODEL.embeddingDim;
const unitFullDim = (): Float32Array => {
  const v = new Float32Array(fullDim);
  v[0] = 1;
  return v;
};
const embedFullDim = (): VisitSimilarityEmbedder => (texts) =>
  Promise.resolve().then(() => texts.map(() => unitFullDim()));

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

// A late engagement aggregate for an OLD visit whose original timeline
// entry is NOT part of the drain window this fires on — the window-poverty
// trigger this repo has already fixed for the similarity layer.
const engagementAggregated = (input: { seq: number; key: string; focusedWindowMs: number }): AcceptedEvent =>
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

describe('connections materializer — W5 topic production revival (e2e)', () => {
  let vaultRoot: string;
  let priorEventStore: string | undefined;
  let priorFullCorpus: string | undefined;
  let priorTopicFullTimeline: string | undefined;
  let priorTopicEveryDrains: string | undefined;

  beforeEach(async () => {
    priorEventStore = process.env['SIDETRACK_EVENT_STORE'];
    priorFullCorpus = process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'];
    priorTopicFullTimeline = process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE'];
    priorTopicEveryDrains = process.env['SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'] = '1';
    // Cadence due from the drain right after the first successful topic
    // build — the test drives the scenario, not a 50-drain or 5-minute wait.
    process.env['SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS'] = '1';
    delete process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE'];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-topic-revival-'));
  });

  afterEach(async () => {
    if (priorEventStore === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = priorEventStore;
    if (priorFullCorpus === undefined) delete process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'];
    else process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'] = priorFullCorpus;
    if (priorTopicFullTimeline === undefined) {
      delete process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE'];
    } else {
      process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE'] = priorTopicFullTimeline;
    }
    if (priorTopicEveryDrains === undefined) {
      delete process.env['SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS'];
    } else {
      process.env['SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS'] = priorTopicEveryDrains;
    }
    await rm(vaultRoot, { recursive: true, force: true });
  });

  /** Drives the shared repro setup; returns the materializer + eventLog so
   *  each test can apply its own trigger drain. `guarded` controls whether
   *  the collapse-guard wrapper is injected (off for the raw-bug repro). */
  const seedHealthyTopic = async (
    options: { readonly guarded: boolean } = { guarded: false },
  ): Promise<{
    readonly eventLog: ReturnType<typeof createEventLog>;
    readonly m: ReturnType<typeof createConnectionsMaterializer>;
  }> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const embed = embedFullDim();
    const rawTopicStore = createTopicRevisionStore(vaultRoot);
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      topicRevisionStore: options.guarded
        ? wrapTopicRevisionStoreForProduction(rawTopicStore)
        : rawTopicStore,
    });

    // Drain 1 — two ABOVE-gate visits (alpha, bravo) form one leiden topic;
    // charlie is observed but sub-gate (0ms), so it stays out of the topic
    // for now (leiden-cpm's own eligibility gate is focusedWindowMs > 0).
    await eventLog.importPeerEvent(
      timelineObserved({ seq: 1, key: 'alpha', focusedWindowMs: 10_000, observedAt: '2026-08-15T10:00:01.000Z' }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({ seq: 2, key: 'bravo', focusedWindowMs: 10_000, observedAt: '2026-08-15T10:00:02.000Z' }),
    );
    await eventLog.importPeerEvent(
      timelineObserved({ seq: 3, key: 'charlie', focusedWindowMs: 0, observedAt: '2026-08-15T10:00:03.000Z' }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const topicStore = createTopicRevisionStore(vaultRoot);
    const seeded = await topicStore.readActiveRevision();
    expect(seeded).not.toBeNull();
    expect(seeded!.topics.length).toBe(1);
    expect(seeded!.topics[0]!.memberCanonicalUrls.sort()).toEqual([
      'https://example.test/alpha',
      'https://example.test/bravo',
    ]);

    return { eventLog, m };
  };

  it('WITHOUT the full-timeline fix, a window-poor cadence-due drain collapses the served topic to zero (reproduces the diagnosed bug)', async () => {
    process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE'] = '0';
    const { eventLog, m } = await seedHealthyTopic({ guarded: false });

    // Drain 2 — a LATE engagement aggregate for charlie (already known from
    // drain 1, but its own timeline entry is NOT part of this drain's
    // delta window). This changes visitSimilarity.revisionId (charlie
    // requalifies and gains an edge to alpha/bravo) without adding any
    // fresh BROWSER_TIMELINE_OBSERVED entry to the window — the exact
    // window-poverty shape the similarity layer already tolerates but the
    // topic builder (pre-fix) does not.
    await eventLog.importPeerEvent(engagementAggregated({ seq: 10, key: 'charlie', focusedWindowMs: 8_000 }));
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const topicStore = createTopicRevisionStore(vaultRoot);
    const after = await topicStore.readActiveRevision();
    expect(after).not.toBeNull();
    // This IS the bug: the previously-healthy 2-member topic is wiped.
    expect(after!.topics.length).toBe(0);
    expect(after!.lineage.length).toBeGreaterThan(0);
    expect(after!.lineage.every((l) => l.kind === 'death')).toBe(true);
  });

  it('WITH the full-timeline default applied, the same window-poor cadence-due drain does NOT collapse — topics stay populated and pick up the requalified visit', async () => {
    ensureTopicFullTimelineSourceDefault();
    expect(process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE']).toBe('1');
    const { eventLog, m } = await seedHealthyTopic({ guarded: false });

    await eventLog.importPeerEvent(engagementAggregated({ seq: 10, key: 'charlie', focusedWindowMs: 8_000 }));
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const topicStore = createTopicRevisionStore(vaultRoot);
    const after = await topicStore.readActiveRevision();
    expect(after).not.toBeNull();
    expect(after!.topics.length).toBeGreaterThan(0);
    const allMembers = after!.topics.flatMap((t) => t.memberCanonicalUrls);
    expect(allMembers).toContain('https://example.test/alpha');
    expect(allMembers).toContain('https://example.test/bravo');
    expect(m.health().status).toBe('healthy');
  });

  it('with the flag left off but the collapse-guard store injected, the served topic revision never regresses to zero (backstop)', async () => {
    process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE'] = '0';
    const { eventLog, m } = await seedHealthyTopic({ guarded: true });

    await eventLog.importPeerEvent(engagementAggregated({ seq: 10, key: 'charlie', focusedWindowMs: 8_000 }));
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const topicStore = createTopicRevisionStore(vaultRoot);
    const after = await topicStore.readActiveRevision();
    expect(after).not.toBeNull();
    // The guard (wired into seedHealthyTopic's materializer via
    // wrapTopicRevisionStoreForProduction) refused the collapse — the
    // ORIGINAL healthy 2-member revision is still served.
    expect(after!.topics.length).toBe(1);
    expect(after!.topics[0]!.memberCanonicalUrls.sort()).toEqual([
      'https://example.test/alpha',
      'https://example.test/bravo',
    ]);

    // And it self-heals on the next successful (non-window-poor) cadence
    // cycle — no manual reset needed, proving the guard is stateless.
    await eventLog.importPeerEvent(
      timelineObserved({ seq: 11, key: 'delta', focusedWindowMs: 10_000, observedAt: '2026-08-15T10:05:00.000Z' }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const healed = await topicStore.readActiveRevision();
    expect(healed).not.toBeNull();
    expect(healed!.topics.length).toBeGreaterThan(0);
  });
});
