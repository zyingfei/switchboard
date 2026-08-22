// W5 follow-up — incremental-producer STATE CARRY, end-to-end against the
// real materializer (see topicIncrementalStateCarry.ts's header for the
// measured root cause: sticky-empty persisted prior + fork-per-drain
// statelessness made the shadow emit `topics=0 members=0` on every real
// cycle).
//
// The scenario reproduces the REAL broken on-disk shape from both live
// vaults (an EMPTY zero-topic revision persisted in the incremental
// candidate slot) and drives a realistic drain sequence:
//
//   drain 1 — fresh browsing seeds a leiden topic; the shadow must seed
//             its first state from the served leiden revision (a
//             cycle-legit artifact — NOT a backlog scan) instead of
//             refining the sticky-empty slot back to zero forever.
//   drain 2 — a window-poor late-requalify (the classic collapse shape):
//             the carried state must fold the requalified visit in and
//             keep the prior topics; never a silent zero.
//   drain 3 — a FRESH materializer + store instance (the fork-per-drain
//             child shape): the carried state must come back from disk
//             and keep growing.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import { createIncrementalTopicStateCarry, incrementalTopicStatePath } from '../../connections/topicIncrementalStateCarry.js';
import { wrapTopicRevisionStoreForProduction } from '../../connections/topicProductionRevival.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import {
  TOPIC_INCREMENTAL_REVISION_KEY,
  createTopicRevisionStore,
  type TopicRevision,
} from '../../producers/topic-revision.js';
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
          copyCount: 0,
          pasteCount: 0,
          maxScrollRatio: 0,
        },
      },
    },
  });

const ENV_KEYS = [
  'SIDETRACK_EVENT_STORE',
  'SIDETRACK_SIMILARITY_FULL_CORPUS',
  'SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE',
  'SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS',
  'SIDETRACK_TOPIC_INCREMENTAL_SHADOW',
] as const;

describe('connections materializer — incremental topic state carry (e2e)', () => {
  let vaultRoot: string;
  const priorEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const key of ENV_KEYS) priorEnv.set(key, process.env[key]);
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    process.env['SIDETRACK_SIMILARITY_FULL_CORPUS'] = '1';
    process.env['SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS'] = '1';
    process.env['SIDETRACK_TOPIC_INCREMENTAL_SHADOW'] = '1';
    delete process.env['SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE'];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-topic-state-carry-e2e-'));
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const prior = priorEnv.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const stickyEmptyRevision: TopicRevision = {
    revisionId: 'rev-sticky-empty',
    visitSimilarityRevisionId: 'sim-rev-stale',
    cosineThreshold: 0.9,
    algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
    topics: [],
    lineage: [],
    producedAt: Date.parse('2026-08-01T00:00:00.000Z'),
  };

  const createHarness = (logs: string[]) => {
    const log = (line: string): void => {
      logs.push(line);
    };
    return {
      topicRevisionStore: wrapTopicRevisionStoreForProduction(createTopicRevisionStore(vaultRoot), {
        log,
        stateCarry: createIncrementalTopicStateCarry(vaultRoot, { log }),
      }),
    };
  };

  it('recovers from the real sticky-empty slot: seeds off the served leiden build, carries across drains AND across materializer instances, and never silently zeroes', async () => {
    // Reproduce the REAL broken on-disk state: a zero-topic incremental
    // candidate revision persisted during the collapse era.
    await createTopicRevisionStore(vaultRoot).putCandidateShadowRevision(
      TOPIC_INCREMENTAL_REVISION_KEY,
      stickyEmptyRevision,
    );

    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const logs: string[] = [];
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
      ...createHarness(logs),
    });

    // Drain 1 — two above-gate visits form a leiden topic; the shadow
    // must seed from it (not from the sticky-empty slot).
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

    const incMarks = () =>
      logs.filter((l) => l.startsWith('[topic.cycle] producer=incremental'));
    expect(logs.some((l) => l.includes('seed base=active-leiden'))).toBe(true);
    const adoptMark = incMarks().at(-1);
    expect(adoptMark).toBeDefined();
    expect(adoptMark).toContain('action=adopt');
    expect(adoptMark).not.toContain('topics=0');
    expect(adoptMark).toContain('members=2');

    // The state artifact exists, is schema-versioned, and is populated.
    const stateFile = JSON.parse(
      await readFile(incrementalTopicStatePath(vaultRoot), 'utf8'),
    ) as { schemaVersion: number; revision: { topics: unknown[] } };
    expect(stateFile.schemaVersion).toBe(1);
    expect(stateFile.revision.topics.length).toBeGreaterThan(0);

    // Drain 2 — the classic window-poor late-requalify. Pre-state-carry
    // this exact drain shape zeroed the shadow forever; with the carry
    // the prior structure survives verbatim. (The requalified visit
    // itself is NOT folded in on this drain: the protected file's
    // engagement-only dirty scopes carry `visit:`-prefixed ids that
    // don't match the shadow's canonical-url keying — a pre-existing
    // gap; charlie is picked up on the next structural touch, drain 3.)
    await eventLog.importPeerEvent(engagementAggregated({ seq: 10, key: 'charlie', focusedWindowMs: 8_000 }));
    await m.catchUp(eventLog);
    await m.awaitIdle();

    const carryMark = incMarks().at(-1);
    expect(carryMark).toContain('carried=true');
    expect(carryMark).toContain('priorTopics=1');
    expect(carryMark).toContain('priorMembers=2');
    expect(carryMark).toContain('collapse-suspect=false');
    expect(carryMark).not.toContain('topics=0');
    // The carried structure survived the window-poor drain.
    expect(carryMark).toContain('members=2');

    // Drain 3 — a FRESH materializer + fresh wrapped store over the same
    // vault (the fork-per-drain child shape). The carried state must
    // come back from DISK, not process memory.
    m.dispose();
    const logs2: string[] = [];
    const m2 = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed: embedFullDim(),
      ...createHarness(logs2),
    });
    await eventLog.importPeerEvent(
      timelineObserved({ seq: 11, key: 'delta', focusedWindowMs: 10_000, observedAt: '2026-08-15T10:05:00.000Z' }),
    );
    await m2.catchUp(eventLog);
    await m2.awaitIdle();
    m2.dispose();

    expect(logs2.some((l) => l.startsWith('[topic.state] loaded'))).toBe(true);
    const restartMark = logs2
      .filter((l) => l.startsWith('[topic.cycle] producer=incremental'))
      .at(-1);
    expect(restartMark).toBeDefined();
    expect(restartMark).toContain('carried=true');
    expect(restartMark).not.toContain('topics=0');
    // The new visit (delta) is a structural touch: Tier A promotes it
    // into the carried topic, and the 1-hop boundary pulls the
    // previously-requalified charlie in too — the carried state GROWS
    // toward completeness across drains (2 → 4 members).
    const restartMembers = Number(/members=(\d+)/u.exec(restartMark ?? '')?.[1] ?? '0');
    expect(restartMembers).toBeGreaterThanOrEqual(3);

    // Read-back acceptance: the on-disk carried state ends populated,
    // and the legacy candidate slot is no longer the sticky empty.
    const finalState = JSON.parse(
      await readFile(incrementalTopicStatePath(vaultRoot), 'utf8'),
    ) as { revision: { topics: { memberCanonicalUrls: string[] }[] } };
    expect(finalState.revision.topics.length).toBeGreaterThan(0);
    const slot = await createTopicRevisionStore(vaultRoot).readCandidateShadowRevision(
      TOPIC_INCREMENTAL_REVISION_KEY,
    );
    expect(slot).not.toBeNull();
    expect(slot!.topics.length).toBeGreaterThan(0);
  });
});
