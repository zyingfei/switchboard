// Cross-package CI spine — extension -> companion -> materializer.
//
// WHY THIS FILE EXISTS (task #31 / issue #143). #143's own evidence: PR
// #141 shipped with `/v1/edge/events` effectively unreachable from CI and
// nothing caught it — `connections-full-browser-sync-user-story.spec.ts`'s
// `drainEdgeEvents` helper WOULD have caught a missing/renamed companion
// endpoint, but that spec only runs with a live Chrome + CfT and is not
// wired to any PR check (`gh api .../actions/workflows` returned
// `total_count: 0` at the time #143 was filed; there was no `.github/`
// directory in the repo at all). This file is the "smaller deterministic
// e2e/smoke" #143 explicitly asks for as an alternative: same canonical
// loop (edge events -> page-content extracted -> drain -> read back), but
// over a REAL in-process HTTP server (createCompanionHttpServer /
// startHttpServer — the same harness batchResolveShape.characterization
// .test.ts and prototypeLaneWiring.test.ts already use) instead of a
// browser. No sleeps: every wait is on the companion's own readiness
// signal (SyncContractRunner.awaitIdle(), the same "resolve when every
// materializer reports pending=false" primitive runner.ts documents as
// "Used by tests").
//
// WIRE-SHAPE PROVENANCE (do not hand-roll payloads that could silently
// drift from what the extension actually sends):
//   - Edge-event BATCH ORDERING: imported verbatim from the extension's
//     real `packages/sidetrack-extension/src/background/storage/
//     edge-event-drain.ts` (PRIORITY_STREAMS + partitionEdgeEventDrainBatch)
//     via a cross-package relative import. That module is a dependency-free
//     leaf (its only import is `import type { BufferedEvent } from
//     './in-memory-event-buffer'`, fully erased at runtime), so importing
//     it here pulls zero chrome/DOM/wxt machinery — verified by running it
//     standalone under `bun run` before wiring it into this test. This is
//     the SAME module the production background service worker's edge-
//     event drain cycle runs (see that file's header: "the COMPANION is
//     the sole gatekeeper for what its `/v1/edge/events` route accepts").
//   - Page-content POST: uses the extension's real, shipped
//     `PageContentClient.index()` (companion/pageContentClient.ts),
//     imported the same way. It is also a dependency-free leaf (its only
//     import is `import type {...} from './model'`, itself import-free) —
//     so this test performs the literal fetch + idempotency-key hashing +
//     header construction the extension ships, not a re-implementation.
//   - Payload SHAPES (NavigationCommittedPayload, EngagementSessionAggregated
//     Payload, BrowserTimelineObservedPayload): built to satisfy the
//     companion's own runtime validators (navigation/events.ts,
//     engagement/events.ts, timeline/events.ts) — those validators are the
//     sole authority the real `/v1/edge/events` and `/v1/timeline/events`
//     routes enforce, per those routes' own header comments. There is no
//     separate BufferedEvent -> AcceptedEvent (sync-contract envelope)
//     serializer exported by the extension to import here (searched;
//     confirmed absent) — `toAcceptedEvent` below is that one seam, and it
//     targets sync/causal.ts's AcceptedEvent shape, the single wire
//     contract both sides already target (same idiom timelineModeIntegration
//     .test.ts's `buildEdgeEvent` uses).
//
// THE CANONICAL LOOP asserted here:
//   1. POST /v1/edge/events with a REAL extension-ordered batch
//      (engagement.session.aggregated + navigation.committed) — this is
//      exactly #143's "companion accepts POST /v1/edge/events" ask, and a
//      renamed/missing route fails this assertion immediately (503/404
//      instead of 200 with both dots imported).
//   2. POST /v1/timeline/events with a browser.timeline.observed event —
//      the plugin-originated "edge event" (per timelineRoutes.ts's own
//      terminology) that actually feeds the URL projection fold
//      (urls/projection.ts only folds browser.timeline.observed /
//      user.organized.item / url.attribution.inferred / url.ignored — NOT
//      the /v1/edge/events types), so this is the second half of "edge
//      events POST" in the canonical loop, not an extra unrelated step.
//   3. POST /v1/page-content/extracted via the extension's real
//      PageContentClient — a second, independent companion surface; would
//      also catch a renamed/missing page-content route.
//   4. Drain/materialize: runner.awaitIdle() — the companion's own
//      readiness signal, not a sleep.
//   5. GET /v1/timeline and GET /v1/visits/inbox both show the visit;
//      GET /v1/page-content/coverage shows the extracted content indexed.
//      A stage that silently mis-reads another stage's data (e.g. a field
//      rename between the timeline event and the projection fold) shows up
//      here as a missing/empty item, not a thrown error — the sharpest
//      version of the regression #143 describes.
//   6. Re-POST the same edge-event batch (idempotent replay) and read the
//      event log back directly — proves the durable substrate every
//      materializer (including the ones this harness does not wire, e.g.
//      the Class B connections materializer this file deliberately does
//      NOT import or touch) catches up from actually recorded
//      engagement.session.aggregated, not just that the HTTP call
//      returned 200.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGAGEMENT_SESSION_AGGREGATED, isEngagementSessionAggregatedPayload } from '../engagement/events.js';
import type { EngagementSessionAggregatedPayload } from '../engagement/events.js';
import { createIdempotencyStore } from '../http/idempotency.js';
import { createCompanionHttpServer, startHttpServer } from '../http/server.js';
import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../navigation/events.js';
import type { NavigationCommittedPayload } from '../navigation/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createSyncContractRunner } from '../sync/contract/runner.js';
import { createTimelineMaterializer } from '../sync/contract/timelineMaterializer.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../timeline/events.js';
import type { BrowserTimelineObservedPayload } from '../timeline/events.js';
import { createTimelineStore } from '../timeline/projection.js';
import { createVaultWriter } from '../vault/writer.js';

// Extension's REAL wire-adjacent code — see the provenance note above.
import {
  PRIORITY_STREAMS,
  partitionEdgeEventDrainBatch,
} from '../../../sidetrack-extension/src/background/storage/edge-event-drain.ts';
import type { BufferedEvent } from '../../../sidetrack-extension/src/background/storage/in-memory-event-buffer.ts';
import { createPageContentClient } from '../../../sidetrack-extension/src/companion/pageContentClient.ts';
import type { PageContentExtractedPayload } from '../../../sidetrack-extension/src/companion/pageContentClient.ts';

const CANONICAL_URL = 'https://spine.test/article';
const PAGE_TITLE = 'Cross-package CI spine fixture article';
const VISIT_ID = 'visit-spine-1';
const SESSION_ID = 'session-spine-1';
const EDGE_REPLICA_ID = 'edge-replica-spine-1';

const engagementDims = (): EngagementSessionAggregatedPayload['dimensions']['engagement'] => ({
  activeMs: 42_000,
  visibleMs: 60_000,
  focusedWindowMs: 55_000,
  idleMs: 5_000,
  foregroundBursts: 3,
  returnCount: 1,
  scrollEvents: 12,
  maxScrollRatio: 0.8,
  copyCount: 0,
  pasteCount: 0,
});

const engagementSessionAggregatedPayload = (): EngagementSessionAggregatedPayload => ({
  payloadVersion: 1,
  visitId: VISIT_ID,
  sessionId: SESSION_ID,
  dimensions: { engagement: engagementDims() },
});

const navigationCommittedPayload = (): NavigationCommittedPayload => ({
  payloadVersion: 1,
  visitId: VISIT_ID,
  url: CANONICAL_URL,
  canonicalUrl: CANONICAL_URL,
  documentId: 'doc-spine-1',
  parentDocumentId: null,
  tabSessionIdHash: 'tab-hash-spine-1',
  windowSessionIdHash: 'window-hash-spine-1',
  openerVisitId: null,
  previousVisitId: null,
  navigationSequence: 1,
  transitionType: 'typed',
  transitionQualifiers: [],
  commitTimestamp: Date.parse('2026-08-17T10:00:00.000Z'),
});

// Sanity — these fixtures must satisfy the SAME runtime validators the
// real /v1/edge/events route enforces (EDGE_EVENT_VALIDATORS in
// timelineRoutes.ts), not a hand-rolled shape that happens to compile.
if (!isEngagementSessionAggregatedPayload(engagementSessionAggregatedPayload())) {
  throw new Error('fixture drift: engagementSessionAggregatedPayload() fails the real validator');
}
if (!isNavigationCommittedPayload(navigationCommittedPayload())) {
  throw new Error('fixture drift: navigationCommittedPayload() fails the real validator');
}

const timelineObservedPayload = (): BrowserTimelineObservedPayload => ({
  eventId: `evt-spine-${CANONICAL_URL}`,
  observedAt: '2026-08-17T10:00:01.000Z',
  url: CANONICAL_URL,
  canonicalUrl: CANONICAL_URL,
  title: PAGE_TITLE,
  provider: 'generic',
  transition: 'activated',
});
if (!isBrowserTimelineObservedPayload(timelineObservedPayload())) {
  throw new Error('fixture drift: timelineObservedPayload() fails the real validator');
}

const pageContentExtractedPayload = (): PageContentExtractedPayload => ({
  payloadVersion: 1,
  canonicalUrl: CANONICAL_URL,
  url: CANONICAL_URL,
  title: PAGE_TITLE,
  extractedAt: '2026-08-17T10:00:02.000Z',
  extractionSource: 'reader-mode',
  extractionPolicy: { trigger: 'auto-observed' },
  quality: 'high',
  qualitySignals: {
    // Thresholds match page-content/quality.ts's classifyPageContentQuality
    // 'indexed'/'high' branch exactly, so the spine exercises the real
    // success path (not the metadata_only_error/low-quality branches).
    extractedWordCount: 320,
    contentToDomRatio: 0.6,
    boilerplateFraction: 0.05,
    extractionStrategy: 'reader-mode',
  },
  content: {
    text: 'spine content evidence word '.repeat(80).trim(),
    contentHash: 'spine-fixture-content-hash-1',
    charCount: 'spine content evidence word '.repeat(80).trim().length,
  },
});

// The extension's real drain path: build the BufferedEvent batch, run it
// through the SAME priority-ordering logic production runs, then convert
// the resulting (real-order) routeBatch into the sync-contract wire
// envelope. See the file header for why this conversion (not the
// ordering) is hand-written.
const buildEdgeEventRouteBatch = (): readonly AcceptedEvent[] => {
  const buffered: readonly BufferedEvent[] = [
    {
      streamName: 'navigation.committed',
      lamport: 1,
      replicaId: EDGE_REPLICA_ID,
      payload: navigationCommittedPayload(),
      observedAt: '2026-08-17T10:00:00.500Z',
    },
    {
      streamName: 'engagement.session.aggregated',
      lamport: 2,
      replicaId: EDGE_REPLICA_ID,
      payload: engagementSessionAggregatedPayload(),
      observedAt: '2026-08-17T10:00:03.000Z',
    },
  ];
  const { routeBatch } = partitionEdgeEventDrainBatch(buffered, 10);
  // Prove the real extension logic actually ran (not a passthrough):
  // PRIORITY_STREAMS puts engagement.session.aggregated ahead of
  // navigation.committed even though it has the LATER lamport — this is
  // the exact fix the "1.2M-event ext buffer starved aggregates" incident
  // shipped (edge-event-drain.ts's PRIORITY_STREAMS header comment).
  expect(routeBatch.map((e) => e.streamName)).toEqual([
    'engagement.session.aggregated',
    'navigation.committed',
  ]);
  expect(PRIORITY_STREAMS[0]).toBe('engagement.session.aggregated');

  return routeBatch.map((event, index) => ({
    clientEventId: `${event.streamName}:${event.replicaId}:${String(event.lamport)}`,
    dot: { replicaId: event.replicaId, seq: index + 1 },
    deps: {},
    aggregateId: `${event.streamName}:${VISIT_ID}`,
    type: event.streamName === 'engagement.session.aggregated' ? ENGAGEMENT_SESSION_AGGREGATED : NAVIGATION_COMMITTED,
    payload: event.payload,
    acceptedAtMs: Date.parse(event.observedAt),
  }));
};

describe('extension -> companion -> materializer spine (task #31 / issue #143)', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let close: (() => Promise<void>) | null = null;
  let runnerRef: ReturnType<typeof createSyncContractRunner> | undefined;
  const BRIDGE = 'spine-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-extension-companion-spine-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const runner = createSyncContractRunner();
    runner.register(createTimelineMaterializer({ store: timelineStore, eventLog }));
    const server = createCompanionHttpServer({
      bridgeKey: BRIDGE,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      timelineStore,
      // Same wiring idiom as timelineModeIntegration.test.ts: durable
      // import first, THEN dispatch to the contract runner. Feeds BOTH
      // /v1/edge/events and /v1/timeline/events (both routes gate on
      // context.importEdgeEvent).
      importEdgeEvent: async (event) => {
        const result = await eventLog.importPeerEvent(event);
        if (result.imported) runner.onAcceptedEvent(event, { origin: 'peer' });
        return { imported: result.imported };
      },
      syncMaterializerHealth: () => runner.health(),
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
    runnerRef = runner;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    runnerRef = undefined;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('edge events -> page-content extracted -> drain -> GET reflects the visit end to end', async () => {
    // ---- Step 1: POST /v1/edge/events with the extension's real,
    // priority-ordered batch. This is #143's core ask: a missing or
    // renamed route fails right here (503 EDGE_EVENTS_NOT_WIRED or a
    // fetch 404), not silently. ----
    const edgeEventsRes = await fetch(`${serverUrl}/v1/edge/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': BRIDGE },
      body: JSON.stringify({ events: buildEdgeEventRouteBatch() }),
    });
    expect(edgeEventsRes.status).toBe(200);
    const edgeEventsBody = (await edgeEventsRes.json()) as {
      data: {
        imported: { replicaId: string; seq: number }[];
        skipped: { replicaId: string; seq: number; reason: string }[];
      };
    };
    expect(edgeEventsBody.data.imported).toHaveLength(2);
    expect(edgeEventsBody.data.skipped).toHaveLength(0);

    // ---- Step 2: POST /v1/timeline/events — the browser.timeline.observed
    // "edge event" that actually feeds the URL projection (see file
    // header). ----
    const timelineEvent: AcceptedEvent = {
      clientEventId: timelineObservedPayload().eventId,
      dot: { replicaId: EDGE_REPLICA_ID, seq: 3 },
      deps: {},
      aggregateId: timelineObservedPayload().observedAt.slice(0, 10),
      type: BROWSER_TIMELINE_OBSERVED,
      payload: timelineObservedPayload(),
      acceptedAtMs: Date.parse(timelineObservedPayload().observedAt),
    };
    const timelineRes = await fetch(`${serverUrl}/v1/timeline/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': BRIDGE },
      body: JSON.stringify({ events: [timelineEvent] }),
    });
    expect(timelineRes.status).toBe(200);
    const timelineImportBody = (await timelineRes.json()) as {
      data: { imported: { replicaId: string; seq: number }[] };
    };
    expect(timelineImportBody.data.imported).toHaveLength(1);

    // ---- Step 3: POST /v1/page-content/extracted via the extension's
    // REAL shipped client (not a re-implementation of its fetch/headers/
    // idempotency-key logic). A renamed/missing route surfaces as a
    // thrown Error here (PageContentClient.parseOrThrow). ----
    const pageContentClient = createPageContentClient({
      port: Number(new URL(serverUrl).port),
      bridgeKey: BRIDGE,
    });
    const coverage = await pageContentClient.index(pageContentExtractedPayload());
    expect(coverage.canonicalUrl).toBe(CANONICAL_URL);
    expect(coverage.state).toBe('indexed');
    expect(coverage.quality).toBe('high');

    // ---- Step 4: drain/materialize via the companion's OWN readiness
    // signal — no sleeps. Same primitive runner.ts documents as
    // "Used by tests" for exactly this purpose. ----
    if (runnerRef === undefined) throw new Error('unreachable — set in beforeEach');
    await runnerRef.awaitIdle();

    // ---- Step 5a: GET /v1/timeline reflects the visit (timeline
    // materializer's projection). ----
    const timelineGetRes = await fetch(`${serverUrl}/v1/timeline`, {
      headers: { 'x-bac-bridge-key': BRIDGE },
    });
    expect(timelineGetRes.status).toBe(200);
    const timelineGetBody = (await timelineGetRes.json()) as {
      data: { scope: string; items: { id: string; url: string; title?: string; visitCount: number }[] };
    };
    expect(timelineGetBody.data.scope).toBe('companion-extended');
    const timelineItem = timelineGetBody.data.items.find((item) => item.id === CANONICAL_URL);
    expect(timelineItem).toBeDefined();
    expect(timelineItem?.title).toBe(PAGE_TITLE);

    // ---- Step 5b: GET /v1/visits/inbox — the "inbox/projection shows the
    // visit" assertion the task specifies. This is a DIFFERENT read path
    // (urls/projection.ts's direct log fold) than 5a's timeline-day
    // projection — a stage silently mis-reading another stage's data
    // (e.g. a canonicalUrl mismatch between the timeline event and the
    // projection fold) would pass 5a but fail here, or vice versa. ----
    const inboxRes = await fetch(`${serverUrl}/v1/visits/inbox`, {
      headers: { 'x-bac-bridge-key': BRIDGE },
    });
    expect(inboxRes.status).toBe(200);
    const inboxBody = (await inboxRes.json()) as {
      data: { items: { canonicalUrl: string; latestTitle?: string; visitCount: number }[] };
    };
    const inboxItem = inboxBody.data.items.find((item) => item.canonicalUrl === CANONICAL_URL);
    expect(inboxItem).toBeDefined();
    expect(inboxItem?.visitCount).toBeGreaterThanOrEqual(1);
    expect(inboxItem?.latestTitle).toBe(PAGE_TITLE);

    // ---- Step 5c: GET /v1/page-content/coverage — the page-content POST's
    // own effect is independently readable back. ----
    const coverageGetRes = await pageContentClient.coverage(CANONICAL_URL);
    expect(coverageGetRes.state).toBe('indexed');
    expect(coverageGetRes.chunkCount).toBeGreaterThan(0);

    // ---- Step 6: re-POST the same edge-event batch (idempotent replay)
    // AND read the durable event log back directly. This is the
    // "materializer sees at least one engagement.session.aggregated after
    // drain" proof #143 asks for, generalized to the substrate every
    // materializer (including ones this harness intentionally does not
    // wire, e.g. the Class B connections materializer this file never
    // imports) catches up from — not just that one HTTP call returned
    // 200. ----
    const replayRes = await fetch(`${serverUrl}/v1/edge/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': BRIDGE },
      body: JSON.stringify({ events: buildEdgeEventRouteBatch() }),
    });
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      data: {
        imported: { replicaId: string; seq: number }[];
        skipped: { replicaId: string; seq: number; reason: string }[];
      };
    };
    expect(replayBody.data.imported).toHaveLength(0);
    expect(replayBody.data.skipped).toHaveLength(2);
    for (const skip of replayBody.data.skipped) expect(skip.reason).toBe('already-imported');

    const merged = await eventLog.readMerged();
    const aggregated = merged.find(
      (event) =>
        event.type === ENGAGEMENT_SESSION_AGGREGATED &&
        (event.payload as EngagementSessionAggregatedPayload).sessionId === SESSION_ID,
    );
    expect(aggregated).toBeDefined();
    expect((aggregated?.payload as EngagementSessionAggregatedPayload).visitId).toBe(VISIT_ID);
  });
});
