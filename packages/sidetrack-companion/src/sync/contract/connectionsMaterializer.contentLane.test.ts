// Stage 5.2 W7 — verify the connections materializer accumulates
// Group B events into its dirty-source queue on every accepted event
// and exposes them via getDirtySources(). Wiring-only test; no
// reconciler runs here.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pollUntil } from '../../test-helpers/bunTestTimers.js';

import {
  type ConnectionsSnapshot,
  type ConnectionsStore,
} from '../../connections/snapshot.js';
import { createTimelineStore } from '../../timeline/projection.js';
import {
  TOPIC_UNION_FIND_REVISION_KEY,
  type TopicRevisionStore,
} from '../../producers/topic-revision.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { PAGE_EVIDENCE_EXTRACTED } from '../../page-evidence/events.js';
import { URL_ATTRIBUTION_INFERRED, URL_IGNORED } from '../../urls/events.js';
import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
} from '../../engagement/events.js';
import { NAVIGATION_COMMITTED } from '../../navigation/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import type { AcceptedEvent } from '../causal.js';
import { EMPTY_PROGRESS, type MaterializerProgress } from './materializerProgress.js';
import { createConnectionsMaterializer, MATERIALIZER_VERSION } from './connectionsMaterializer.js';

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: 1_700_000_000_000 + input.seq * 1000,
});

describe('Stage 5.2 W7 — connectionsMaterializer dirty-source queue wiring', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-w7-wiring-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const createMat = (
    input: {
      readonly store?: ConnectionsStore;
      readonly events?: readonly AcceptedEvent[];
      readonly topicRevisionStore?: TopicRevisionStore;
      readonly onReadMerged?: () => void;
    } = {},
  ): ReturnType<typeof createConnectionsMaterializer> => {
    const unusedStore: ConnectionsStore = {
      putCurrent: async () => {},
      writeSnapshotAndProgress: async () => {},
      readMaterializerProgress: async () => null,
      readCurrent: async () => null,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    return createConnectionsMaterializer({
      vaultRoot,
      // The dirty-queue wiring lives in onAccepted before any I/O —
      // tests only need the materializer surface, not a working
      // eventLog / timelineStore / store. Pass minimal stubs that
      // satisfy the type but never get hit.
      eventLog: {
        appendClient: () => {
          throw new Error('unused');
        },
        readMerged: () => {
          input.onReadMerged?.();
          return Promise.resolve([...(input.events ?? [])]);
        },
        readMergedSince: () => Promise.resolve([...(input.events ?? [])]),
        // streamFiltered + logSignature back the trainable-events shard the
        // ranker trainer reads; return empty / a stable signature so the drain
        // succeeds without actual training data in the test stub.
        streamFiltered: () => Promise.resolve([]),
        logSignature: () => Promise.resolve('test-stub-signature'),
        append: () => {
          throw new Error('unused');
        },
      } as any,
      timelineStore: createTimelineStore(vaultRoot),
      store: input.store ?? unusedStore,
      ...(input.topicRevisionStore === undefined
        ? {}
        : { topicRevisionStore: input.topicRevisionStore }),
    });
  };

  it('capture.recorded accumulates the sourceUnitId into the dirty set', () => {
    const mat = createMat();
    mat.onAccepted(
      buildEvent({ seq: 1, type: CAPTURE_RECORDED, payload: { sourceUnitId: 'src-1' } }),
      { origin: 'local' },
    );
    expect(mat.getDirtySources().dirtySourceUnitIds).toEqual(['src-1']);
  });

  it('capture.extraction.produced records the latest extractionRevisionId', () => {
    const mat = createMat();
    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: CAPTURE_EXTRACTION_PRODUCED,
        payload: {
          sourceUnitId: 'src-1',
          extractionRevisionId: 'rev-1',
          extractorId: 'extractor',
          extractorVersion: '1',
          extractionSchemaVersion: 1,
          content: {},
        },
      }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({
        seq: 2,
        type: CAPTURE_EXTRACTION_PRODUCED,
        payload: {
          sourceUnitId: 'src-1',
          extractionRevisionId: 'rev-2',
          extractorId: 'extractor',
          extractorVersion: '1',
          extractionSchemaVersion: 1,
          content: {},
        },
      }),
      { origin: 'local' },
    );
    const snap = mat.getDirtySources();
    expect(snap.dirtySourceUnitIds).toEqual(['src-1']);
    expect(snap.latestExtractionFor.get('src-1')).toBe('rev-2');
  });

  it('content-lane-only events advance progress without scheduling a graph drain', async () => {
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 1] as const] },
      appliedFrontier: { 'replica-A': 1 },
      snapshotRevisionId: 'rev-base',
    };
    let latestProgress: MaterializerProgress = baseProgress;
    const store: ConnectionsStore = {
      putCurrent: async () => {},
      writeSnapshotAndProgress: async () => {},
      writeMaterializerProgress: async (progress) => {
        latestProgress = progress;
      },
      readMaterializerProgress: async () => latestProgress,
      readCurrent: async () => null,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    const mat = createMat({ store });

    mat.onAccepted(
      buildEvent({
        seq: 2,
        type: CAPTURE_EXTRACTION_PRODUCED,
        payload: {
          sourceUnitId: 'src-1',
          extractionRevisionId: 'rev-2',
          extractorId: 'extractor',
          extractorVersion: '1',
          extractionSchemaVersion: 1,
          content: {},
        },
      }),
      { origin: 'local' },
    );

    expect(mat.health().pending).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(latestProgress.appliedDotIntervals['replica-A']).toEqual([[1, 2]]);
    expect(latestProgress.appliedFrontier).toEqual({ 'replica-A': 2 });
    expect(mat.getDirtySources().dirtySourceUnitIds).toEqual(['src-1']);
  });

  it('page.evidence.extracted advances progress without scheduling a graph drain', async () => {
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 1] as const] },
      appliedFrontier: { 'replica-A': 1 },
      snapshotRevisionId: 'rev-base',
    };
    let latestProgress: MaterializerProgress = baseProgress;
    let snapshotWrites = 0;
    const store: ConnectionsStore = {
      putCurrent: async () => {
        snapshotWrites += 1;
      },
      writeSnapshotAndProgress: async () => {
        snapshotWrites += 1;
      },
      writeMaterializerProgress: async (progress) => {
        latestProgress = progress;
      },
      readMaterializerProgress: async () => latestProgress,
      readCurrent: async () => null,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    const mat = createMat({ store });

    mat.onAccepted(
      buildEvent({
        seq: 2,
        type: PAGE_EVIDENCE_EXTRACTED,
        payload: {
          payloadVersion: 1,
          canonicalUrl: 'https://news.ycombinator.com/newest',
          extractedAt: '2026-05-23T23:00:00.000Z',
        },
      }),
      { origin: 'local' },
    );

    expect(mat.health().pending).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(snapshotWrites).toBe(0);
    expect(latestProgress.appliedDotIntervals['replica-A']).toEqual([[1, 2]]);
    expect(latestProgress.appliedFrontier).toEqual({ 'replica-A': 2 });
  });

  it('coalesces idle content-lane progress into one progress write', async () => {
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 1] as const] },
      appliedFrontier: { 'replica-A': 1 },
      snapshotRevisionId: 'rev-base',
    };
    let latestProgress: MaterializerProgress = baseProgress;
    let progressWrites = 0;
    const store: ConnectionsStore = {
      putCurrent: async () => {},
      writeSnapshotAndProgress: async () => {},
      writeMaterializerProgress: async (progress) => {
        progressWrites += 1;
        latestProgress = progress;
      },
      readMaterializerProgress: async () => latestProgress,
      readCurrent: async () => null,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    const mat = createMat({ store });

    for (const seq of [2, 3, 4]) {
      mat.onAccepted(
        buildEvent({
          seq,
          type: PAGE_EVIDENCE_EXTRACTED,
          payload: {
            payloadVersion: 1,
            canonicalUrl: `https://example.test/${String(seq)}`,
            extractedAt: '2026-05-23T23:00:00.000Z',
          },
        }),
        { origin: 'local' },
      );
    }

    expect(mat.health().pending).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(progressWrites).toBe(1);
    expect(latestProgress.appliedDotIntervals['replica-A']).toEqual([[1, 4]]);
    expect(latestProgress.appliedFrontier).toEqual({ 'replica-A': 4 });
  });

  it('defers content-lane progress accepted during a graph drain without a backlog scan', async () => {
    let mat: ReturnType<typeof createConnectionsMaterializer> | null = null;
    let readMergedCalls = 0;
    let latestProgress: MaterializerProgress | null = null;
    const graphEvent = buildEvent({
      seq: 1,
      type: NAVIGATION_COMMITTED,
      payload: {
        payloadVersion: 1,
        tabId: 1,
        windowId: 1,
        url: 'https://example.test/article',
        committedAt: '2026-05-23T23:00:00.000Z',
      },
    });
    const contentEvent = buildEvent({
      seq: 2,
      type: PAGE_EVIDENCE_EXTRACTED,
      payload: {
        payloadVersion: 1,
        canonicalUrl: 'https://example.test/article',
        extractedAt: '2026-05-23T23:00:01.000Z',
      },
    });
    const store: ConnectionsStore = {
      putCurrent: async () => {},
      writeSnapshotAndProgress: async (_snapshot, progress) => {
        latestProgress = progress;
        mat?.onAccepted(contentEvent, { origin: 'local' });
      },
      writeMaterializerProgress: async (progress) => {
        latestProgress = progress;
      },
      readMaterializerProgress: async () => latestProgress,
      readCurrent: async () => null,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    mat = createMat({
      store,
      events: [graphEvent],
      onReadMerged: () => {
        readMergedCalls += 1;
      },
    });

    await mat.catchUp({} as any);
    await mat.awaitIdle();

    // The content-only progress write goes through a 25ms requeue timer
    // (flushContentOnlyProgressEvents backs off when running=true and
    // retries after 25ms). Under load the graph drain itself takes longer
    // than 50ms, so a fixed wait is too tight. Poll until the deferred
    // write lands; 2 s is generous for a 25ms nominal delay.
    await pollUntil(
      () => {
        expect(latestProgress?.appliedDotIntervals['replica-A']).toEqual([[1, 2]]);
      },
      { timeoutMs: 2000, intervalMs: 10 },
    );

    expect(readMergedCalls).toBe(1);
    expect(latestProgress?.appliedDotIntervals['replica-A']).toEqual([[1, 2]]);
    expect(latestProgress?.appliedFrontier).toEqual({ 'replica-A': 2 });
    expect(mat.health().pending).toBe(false);
  });

  it('catchUp advances a content-lane-only backlog without rebuilding graph rows', async () => {
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 1] as const] },
      appliedFrontier: { 'replica-A': 1 },
      snapshotRevisionId: 'rev-base',
    };
    let latestProgress: MaterializerProgress = baseProgress;
    let snapshotWrites = 0;
    const contentEvent = buildEvent({
      seq: 2,
      type: CAPTURE_EXTRACTION_PRODUCED,
      payload: {
        sourceUnitId: 'src-1',
        extractionRevisionId: 'rev-2',
        extractorId: 'extractor',
        extractorVersion: '1',
        extractionSchemaVersion: 1,
        content: {},
      },
    });
    const store: ConnectionsStore = {
      putCurrent: async () => {
        snapshotWrites += 1;
      },
      writeSnapshotAndProgress: async () => {
        snapshotWrites += 1;
      },
      writeMaterializerProgress: async (progress) => {
        latestProgress = progress;
      },
      readMaterializerProgress: async () => latestProgress,
      readCurrent: async () => null,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    const mat = createMat({ store, events: [contentEvent] });

    await mat.catchUp({} as any);

    expect(snapshotWrites).toBe(0);
    expect(latestProgress.appliedDotIntervals['replica-A']).toEqual([[1, 2]]);
    expect(latestProgress.appliedFrontier).toEqual({ 'replica-A': 2 });
    expect(mat.health().pending).toBe(false);
  });

  it('urls.ignored advances projection overlay progress without rebuilding graph rows', async () => {
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 1] as const] },
      appliedFrontier: { 'replica-A': 1 },
      snapshotRevisionId: 'rev-base',
    };
    let latestProgress: MaterializerProgress = baseProgress;
    let snapshotWrites = 0;
    const overlayEvents: AcceptedEvent[] = [];
    const ignoredEvent = buildEvent({
      seq: 2,
      type: URL_IGNORED,
      payload: {
        payloadVersion: 1,
        canonicalUrl: 'https://noise.test/',
        reason: 'noise',
      },
    });
    const store: ConnectionsStore = {
      putCurrent: async () => {
        snapshotWrites += 1;
      },
      writeSnapshotAndProgress: async () => {
        snapshotWrites += 1;
      },
      applyProjectionEventOverlay: async (event) => {
        overlayEvents.push(event);
        return 'rev-ignored';
      },
      writeMaterializerProgress: async (progress) => {
        latestProgress = progress;
      },
      readMaterializerProgress: async () => latestProgress,
      readCurrent: async () => null,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    const mat = createMat({ store, events: [ignoredEvent] });

    mat.onAccepted(ignoredEvent, { origin: 'local' });
    expect(mat.health().pending).toBe(true);

    await mat.catchUp({} as any);

    expect(overlayEvents).toEqual([ignoredEvent]);
    expect(snapshotWrites).toBe(0);
    expect(latestProgress.appliedDotIntervals['replica-A']).toEqual([[1, 2]]);
    expect(latestProgress.appliedFrontier).toEqual({ 'replica-A': 2 });
    expect(latestProgress.snapshotRevisionId).toBe('rev-ignored');
    expect(mat.health().pending).toBe(false);
  });

  it('rowless URL attribution advances projection metadata without a graph rebuild', async () => {
    const previousSnapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [],
      edges: [],
      updatedAt: '2026-05-23T00:00:00.000Z',
      nodeCount: 0,
      edgeCount: 0,
      urlProjection: { schemaVersion: 1, byCanonicalUrl: {} },
      tabSessionProjection: { schemaVersion: 1, bySessionId: {}, openSessionsByTabId: {} },
      snapshotRevision: 'rev-base',
    };
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 1] as const] },
      appliedFrontier: { 'replica-A': 1 },
      snapshotRevisionId: 'rev-base',
    };
    const alreadyApplied = buildEvent({
      seq: 1,
      type: CAPTURE_EXTRACTION_PRODUCED,
      payload: {
        sourceUnitId: 'src-1',
        extractionRevisionId: 'rev-1',
        extractorId: 'extractor',
        extractorVersion: '1',
        extractionSchemaVersion: 1,
        content: {},
      },
    });
    const attributionEvent = buildEvent({
      seq: 2,
      type: URL_ATTRIBUTION_INFERRED,
      payload: {
        payloadVersion: 1,
        canonicalUrl: 'https://new.test/page',
        workstreamId: 'ws-1',
        policyMode: 'balanced',
        dominantSource: 'similarity',
        rawFusionLogit: 1.2,
        margin: 0.7,
        corroborationCount: 1,
        modelRevision: 'model-rev',
        graphRevision: 'graph-rev',
        evidenceHash: 'evidence-hash',
        resolverDependencyKey: 'resolver-key',
        reasonSummary: 'similar page',
      },
    });
    let snapshotWrites = 0;
    const replacements: {
      readonly scopes: readonly { readonly kind: string; readonly id: string }[];
      readonly nodes: readonly unknown[];
      readonly edges: readonly unknown[];
      readonly metadata?: ConnectionsSnapshot;
    }[] = [];
    const store: ConnectionsStore = {
      putCurrent: async () => {
        snapshotWrites += 1;
      },
      writeSnapshotAndProgress: async () => {
        snapshotWrites += 1;
      },
      replaceScopeRows: async (input) => {
        replacements.push({
          scopes: input.scopes,
          nodes: input.nodes,
          edges: input.edges,
          metadata: input.metadata as ConnectionsSnapshot | undefined,
        });
      },
      readMaterializerProgress: async () => baseProgress,
      readCurrent: async () => previousSnapshot,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    const previousTopicRevision = {
      revisionId: 'topic-rev-base',
      visitSimilarityRevisionId: 'visit-sim-rev-base',
      cosineThreshold: 0.85,
      algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
      topics: [],
      lineage: [],
      producedAt: 1_700_000_000_000,
    };
    const topicRevisionStore: TopicRevisionStore = {
      putRevision: async () => {},
      putActiveRevision: async () => {},
      putShadowRevision: async () => {},
      putCandidateShadowRevision: async () => {},
      readShadowRevision: async () => null,
      readCandidateShadowRevision: async () => null,
      readRevision: async () => null,
      readActiveRevision: async () => previousTopicRevision,
      listRevisionIds: async () => [],
    };
    const previousIncrementalSimilarity = process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] = '0';
    try {
      const mat = createMat({
        store,
        events: [alreadyApplied, attributionEvent],
        topicRevisionStore,
      });

      await mat.catchUp({} as any);
    } finally {
      if (previousIncrementalSimilarity === undefined) {
        delete process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
      } else {
        process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] = previousIncrementalSimilarity;
      }
    }

    expect(snapshotWrites).toBe(0);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.scopes).toEqual([
      { kind: 'url', id: 'https://new.test/page' },
    ]);
    expect(replacements[0]?.nodes).toEqual([]);
    expect(replacements[0]?.edges).toEqual([]);
    expect(
      replacements[0]?.metadata?.urlProjection?.byCanonicalUrl['https://new.test/page']
        ?.currentAttribution,
    ).toMatchObject({ workstreamId: 'ws-1', source: 'inferred' });
  });

  it('re-visit / graph-inert window re-asserts owned rows instead of a full rebuild', async () => {
    // P0 fix A regression guard. A drain whose window touches scopes that
    // ALREADY own graph rows but carries no graph-row-affecting event
    // (here: a lone URL_ATTRIBUTION_INFERRED — projection overlay, no
    // NAVIGATION_COMMITTED / thread / new timeline entry) must NOT fall
    // into the ~18s full base rebuild. It must re-assert the owned rows
    // from the previous snapshot via a scoped replaceScopeRows + advance
    // the frontier, while writing the projection overlay (the
    // attribution). Toggling SIDETRACK_SCOPED_REVISIT_NOOP proves the
    // fails-without / passes-with behaviour in one test.
    const ownedUrl = 'https://owned.test/page';
    const ownedNode = {
      id: `timeline-visit:${ownedUrl}`,
      kind: 'timeline-visit' as const,
      label: 'Owned Page',
      originReplicaIds: ['replica-A'],
      metadata: { canonicalUrl: ownedUrl },
    };
    const makePreviousSnapshot = (): ConnectionsSnapshot => ({
      scope: {},
      nodes: [ownedNode],
      edges: [],
      updatedAt: '2026-05-23T00:00:00.000Z',
      nodeCount: 1,
      edgeCount: 0,
      urlProjection: { schemaVersion: 1, byCanonicalUrl: {} },
      tabSessionProjection: { schemaVersion: 1, bySessionId: {}, openSessionsByTabId: {} },
      snapshotRevision: 'rev-base',
    });
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 1] as const] },
      appliedFrontier: { 'replica-A': 1 },
      snapshotRevisionId: 'rev-base',
    };
    const alreadyApplied = buildEvent({
      seq: 1,
      type: CAPTURE_EXTRACTION_PRODUCED,
      payload: {
        sourceUnitId: 'src-1',
        extractionRevisionId: 'rev-1',
        extractorId: 'extractor',
        extractorVersion: '1',
        extractionSchemaVersion: 1,
        content: {},
      },
    });
    const attributionEvent = buildEvent({
      seq: 2,
      type: URL_ATTRIBUTION_INFERRED,
      payload: {
        payloadVersion: 1,
        canonicalUrl: ownedUrl,
        workstreamId: 'ws-1',
        policyMode: 'balanced',
        dominantSource: 'similarity',
        rawFusionLogit: 1.2,
        margin: 0.7,
        corroborationCount: 1,
        modelRevision: 'model-rev',
        graphRevision: 'graph-rev',
        evidenceHash: 'evidence-hash',
        resolverDependencyKey: 'resolver-key',
        reasonSummary: 'similar page',
      },
    });
    const previousTopicRevision = {
      revisionId: 'topic-rev-base',
      visitSimilarityRevisionId: 'visit-sim-rev-base',
      cosineThreshold: 0.85,
      algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
      topics: [],
      lineage: [],
      producedAt: 1_700_000_000_000,
    };
    const topicRevisionStore: TopicRevisionStore = {
      putRevision: async () => {},
      putActiveRevision: async () => {},
      putShadowRevision: async () => {},
      putCandidateShadowRevision: async () => {},
      readShadowRevision: async () => null,
      readCandidateShadowRevision: async () => null,
      readRevision: async () => null,
      readActiveRevision: async () => previousTopicRevision,
      listRevisionIds: async () => [],
    };

    const runDrain = async (
      noOpEnabled: boolean,
    ): Promise<{
      snapshotWrites: number;
      replacements: { scopes: readonly { kind: string; id: string }[]; nodes: readonly unknown[] }[];
    }> => {
      let snapshotWrites = 0;
      const replacements: {
        scopes: readonly { kind: string; id: string }[];
        nodes: readonly unknown[];
        metadata?: ConnectionsSnapshot;
      }[] = [];
      const store: ConnectionsStore = {
        putCurrent: async () => {
          snapshotWrites += 1;
        },
        writeSnapshotAndProgress: async () => {
          snapshotWrites += 1;
        },
        replaceScopeRows: async (input) => {
          replacements.push({
            scopes: input.scopes,
            nodes: input.nodes,
            metadata: input.metadata as ConnectionsSnapshot | undefined,
          });
        },
        readMaterializerProgress: async () => baseProgress,
        readCurrent: async () => makePreviousSnapshot(),
        putDay: async () => {},
        readDay: async () => null,
        listDays: async () => [],
      };
      const prevSim = process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
      const prevNoOp = process.env['SIDETRACK_SCOPED_REVISIT_NOOP'];
      process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] = '0';
      process.env['SIDETRACK_SCOPED_REVISIT_NOOP'] = noOpEnabled ? '1' : '0';
      try {
        const mat = createMat({ store, events: [alreadyApplied, attributionEvent], topicRevisionStore });
        await mat.catchUp({} as any);
      } finally {
        const restore = (key: string, value: string | undefined): void => {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        };
        restore('SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY', prevSim);
        restore('SIDETRACK_SCOPED_REVISIT_NOOP', prevNoOp);
      }
      return { snapshotWrites, replacements };
    };

    // Disabled: the owned-rows + graph-inert window falls into the full
    // base rebuild (the bug) — a whole-snapshot write, no scoped replace.
    const off = await runDrain(false);
    expect(off.snapshotWrites).toBeGreaterThan(0);

    // Enabled (the fix / default): no full rebuild; a scoped replace that
    // re-asserts the owned url's existing node and carries the attribution
    // projection overlay.
    const on = await runDrain(true);
    expect(on.snapshotWrites).toBe(0);
    expect(on.replacements).toHaveLength(1);
    expect(on.replacements[0]?.scopes).toEqual([{ kind: 'url', id: ownedUrl }]);
    expect((on.replacements[0]?.nodes ?? []).map((n) => (n as { id: string }).id)).toContain(
      `timeline-visit:${ownedUrl}`,
    );
    expect(
      on.replacements[0]?.metadata?.urlProjection?.byCanonicalUrl[ownedUrl]?.currentAttribution,
    ).toMatchObject({ workstreamId: 'ws-1' });
  });

  it('mixed timeline navigation and engagement batches use scoped delta', async () => {
    const canonicalUrl = 'https://news.ycombinator.com/newest?sidetrack_probe=test';
    const tabSessionId = 'tses_hn';
    const tabSessionIdHash = 'tab_hash_hn';
    const previousSnapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [],
      edges: [],
      updatedAt: '2026-05-23T00:00:00.000Z',
      nodeCount: 0,
      edgeCount: 0,
      urlProjection: { schemaVersion: 1, byCanonicalUrl: {} },
      tabSessionProjection: { schemaVersion: 1, bySessionId: {}, openSessionsByTabId: {} },
      snapshotRevision: 'rev-base',
    };
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 1] as const] },
      appliedFrontier: { 'replica-A': 1 },
      snapshotRevisionId: 'rev-base',
    };
    const alreadyApplied = buildEvent({
      seq: 1,
      type: CAPTURE_EXTRACTION_PRODUCED,
      payload: {
        sourceUnitId: 'src-1',
        extractionRevisionId: 'rev-1',
        extractorId: 'extractor',
        extractorVersion: '1',
        extractionSchemaVersion: 1,
        content: {},
      },
    });
    const timelineEvent = buildEvent({
      seq: 2,
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        payloadVersion: 1,
        eventId: 'timeline-hn',
        observedAt: '2026-05-23T00:01:00.000Z',
        url: canonicalUrl,
        canonicalUrl,
        title: 'New Links | Hacker News',
        provider: 'generic',
        transition: 'activated',
        tabSessionId,
      },
    });
    const navigationEvent = buildEvent({
      seq: 3,
      type: NAVIGATION_COMMITTED,
      payload: {
        payloadVersion: 1,
        visitId: 'visit_hn_1',
        url: canonicalUrl,
        canonicalUrl,
        documentId: 'doc_hn_1',
        parentDocumentId: null,
        tabSessionIdHash,
        windowSessionIdHash: 'win_hash_hn',
        openerVisitId: null,
        previousVisitId: null,
        navigationSequence: 1,
        transitionType: 'link',
        transitionQualifiers: [],
        commitTimestamp: 1_700_000_001_000,
      },
    });
    const engagementInterval = buildEvent({
      seq: 4,
      type: ENGAGEMENT_INTERVAL_OBSERVED,
      payload: {
        payloadVersion: 1,
        visitId: `visit:${canonicalUrl}`,
        intervalStart: 1_700_000_001_000,
        intervalEnd: 1_700_000_031_000,
        dimensions: {
          engagement: {
            activeMs: 30_000,
            visibleMs: 30_000,
            focusedWindowMs: 30_000,
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
    const engagementAggregate = buildEvent({
      seq: 5,
      type: ENGAGEMENT_SESSION_AGGREGATED,
      payload: {
        payloadVersion: 1,
        visitId: `visit:${canonicalUrl}`,
        sessionId: 'session_hn',
        dimensions: {
          engagement: {
            activeMs: 30_000,
            visibleMs: 30_000,
            focusedWindowMs: 30_000,
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
    let snapshotWrites = 0;
    const replacements: {
      readonly scopes: readonly { readonly kind: string; readonly id: string }[];
      readonly nodes: readonly unknown[];
      readonly edges: readonly unknown[];
    }[] = [];
    const store: ConnectionsStore = {
      putCurrent: async () => {
        snapshotWrites += 1;
      },
      writeSnapshotAndProgress: async () => {
        snapshotWrites += 1;
      },
      replaceScopeRows: async (input) => {
        replacements.push({
          scopes: input.scopes,
          nodes: input.nodes,
          edges: input.edges,
        });
      },
      readMaterializerProgress: async () => baseProgress,
      readCurrent: async () => previousSnapshot,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    const previousTopicRevision = {
      revisionId: 'topic-rev-base',
      visitSimilarityRevisionId: 'visit-sim-rev-base',
      cosineThreshold: 0.85,
      algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
      topics: [],
      lineage: [],
      producedAt: 1_700_000_000_000,
    };
    const topicRevisionStore: TopicRevisionStore = {
      putRevision: async () => {},
      putActiveRevision: async () => {},
      putShadowRevision: async () => {},
      putCandidateShadowRevision: async () => {},
      readShadowRevision: async () => null,
      readCandidateShadowRevision: async () => null,
      readRevision: async () => null,
      readActiveRevision: async () => previousTopicRevision,
      listRevisionIds: async () => [],
    };
    const previousIncrementalSimilarity = process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
    const previousSkipRanker = process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] = '0';
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    try {
      const mat = createMat({
        store,
        events: [
          alreadyApplied,
          timelineEvent,
          navigationEvent,
          engagementInterval,
          engagementAggregate,
        ],
        topicRevisionStore,
      });

      await mat.catchUp({} as any);
    } finally {
      if (previousIncrementalSimilarity === undefined) {
        delete process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
      } else {
        process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] = previousIncrementalSimilarity;
      }
      if (previousSkipRanker === undefined) {
        delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
      } else {
        process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = previousSkipRanker;
      }
    }

    expect(snapshotWrites).toBe(0);
    expect(replacements).toHaveLength(2);
    const foregroundOverlay = replacements[0];
    // The foreground overlay deliberately OMITS scope:url=X — including
    // it would orphan-delete the URL's historical incident edges
    // (closest_visit, visit_resembles_visit, …) which all have
    // primaryScope = scope:url=X. The new visit-instance still gets
    // its URL-membership via INSERT OR IGNORE on the upsert path,
    // and the URL's historical neighbourhood survives until the
    // scoped-delta drain below re-asserts scope:url=X with the full
    // recomputed edge set.
    expect(foregroundOverlay?.scopes).not.toContainEqual({ kind: 'url', id: canonicalUrl });
    expect(foregroundOverlay?.scopes).toContainEqual({
      kind: 'tab-session',
      id: tabSessionIdHash,
    });
    expect(foregroundOverlay?.nodes.length).toBeGreaterThan(0);

    const scopedDelta = replacements[1];
    expect(scopedDelta?.scopes).toContainEqual({ kind: 'url', id: canonicalUrl });
    expect(scopedDelta?.scopes).toContainEqual({ kind: 'tab-session', id: tabSessionId });
  });

  it('does not expand a scoped timeline delta to every historical visit in the tab-session', async () => {
    const tabSessionId = 'tses_hn';
    const historyEvents = Array.from({ length: 12 }, (_, index) => {
      const n = index + 1;
      const canonicalUrl = `https://history.test/${String(n)}`;
      return buildEvent({
        seq: n,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          payloadVersion: 1,
          eventId: `timeline-history-${String(n)}`,
          observedAt: `2026-05-23T00:${String(n).padStart(2, '0')}:00.000Z`,
          url: canonicalUrl,
          canonicalUrl,
          title: `Historical ${String(n)}`,
          provider: 'generic',
          transition: 'activated',
          tabSessionId,
        },
      });
    });
    const freshUrl = 'https://history.test/fresh';
    const freshEvent = buildEvent({
      seq: 13,
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        payloadVersion: 1,
        eventId: 'timeline-fresh',
        observedAt: '2026-05-23T00:13:00.000Z',
        url: freshUrl,
        canonicalUrl: freshUrl,
        title: 'Fresh page',
        provider: 'generic',
        transition: 'activated',
        tabSessionId,
      },
    });
    const previousSnapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [],
      edges: [],
      updatedAt: '2026-05-23T00:12:00.000Z',
      nodeCount: 0,
      edgeCount: 0,
      urlProjection: { schemaVersion: 1, byCanonicalUrl: {} },
      tabSessionProjection: { schemaVersion: 1, bySessionId: {}, openSessionsByTabId: {} },
      snapshotRevision: 'rev-history',
    };
    const baseProgress: MaterializerProgress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: { 'replica-A': [[1, 12] as const] },
      appliedFrontier: { 'replica-A': 12 },
      snapshotRevisionId: 'rev-history',
    };
    const replacements: {
      readonly scopes: readonly { readonly kind: string; readonly id: string }[];
      readonly nodes: readonly unknown[];
    }[] = [];
    const store: ConnectionsStore = {
      putCurrent: async () => {
        throw new Error('expected scoped replacement, not full snapshot write');
      },
      writeSnapshotAndProgress: async () => {
        throw new Error('expected scoped replacement, not full snapshot write');
      },
      replaceScopeRows: async (input) => {
        replacements.push({ scopes: input.scopes, nodes: input.nodes });
      },
      readMaterializerProgress: async () => baseProgress,
      readCurrent: async () => previousSnapshot,
      putDay: async () => {},
      readDay: async () => null,
      listDays: async () => [],
    };
    const topicRevisionStore: TopicRevisionStore = {
      putRevision: async () => {},
      putActiveRevision: async () => {},
      putShadowRevision: async () => {},
      putCandidateShadowRevision: async () => {},
      readShadowRevision: async () => null,
      readCandidateShadowRevision: async () => null,
      readRevision: async () => null,
      readActiveRevision: async () => ({
        revisionId: 'topic-rev-history',
        visitSimilarityRevisionId: 'visit-sim-rev-history',
        cosineThreshold: 0.85,
        algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
        topics: [],
        lineage: [],
        producedAt: 1_700_000_000_000,
      }),
      listRevisionIds: async () => [],
    };
    const previousIncrementalSimilarity = process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
    const previousSkipRanker = process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] = '0';
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    try {
      const mat = createMat({
        store,
        events: [...historyEvents, freshEvent],
        topicRevisionStore,
      });

      await mat.catchUp({} as any);
    } finally {
      if (previousIncrementalSimilarity === undefined) {
        delete process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
      } else {
        process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] = previousIncrementalSimilarity;
      }
      if (previousSkipRanker === undefined) {
        delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
      } else {
        process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = previousSkipRanker;
      }
    }

    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.scopes).toContainEqual({ kind: 'url', id: freshUrl });
    expect(replacements[0]?.scopes).toContainEqual({ kind: 'tab-session', id: tabSessionId });
    expect(replacements[0]?.scopes).not.toContainEqual({ kind: 'url', id: 'https://history.test/1' });
    const nodeIds = (replacements[0]?.nodes ?? []).map(
      (node) => (node as { readonly id?: unknown }).id,
    );
    expect(nodeIds).toContain(`timeline-visit:${freshUrl}`);
    expect(nodeIds).not.toContain('timeline-visit:https://history.test/1');
  });

  it('recall.tombstone.target marks sources tombstoned (and dirty)', () => {
    const mat = createMat();
    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: RECALL_TOMBSTONE_TARGET,
        payload: { sourceUnitId: 'src-tomb' },
      }),
      { origin: 'local' },
    );
    const snap = mat.getDirtySources();
    expect(snap.dirtySourceUnitIds).toEqual(['src-tomb']);
    expect(snap.tombstonedSourceUnitIds).toEqual(['src-tomb']);
  });

  it('clearDirtySources drains specific entries (retains latest revisions)', () => {
    const mat = createMat();
    mat.onAccepted(
      buildEvent({ seq: 1, type: CAPTURE_RECORDED, payload: { sourceUnitId: 'src-1' } }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({
        seq: 2,
        type: CAPTURE_EXTRACTION_PRODUCED,
        payload: {
          sourceUnitId: 'src-1',
          extractionRevisionId: 'rev-1',
          extractorId: 'extractor',
          extractorVersion: '1',
          extractionSchemaVersion: 1,
          content: {},
        },
      }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({ seq: 3, type: CAPTURE_RECORDED, payload: { sourceUnitId: 'src-2' } }),
      { origin: 'local' },
    );
    mat.clearDirtySources(['src-1']);
    const snap = mat.getDirtySources();
    expect(snap.dirtySourceUnitIds).toEqual(['src-2']);
    // latestExtractionFor is intentionally retained across clears so
    // the next dirty cycle for src-1 still has a known revision.
    expect(snap.latestExtractionFor.get('src-1')).toBe('rev-1');
  });

  it('non-Group-B events do not touch the queue', () => {
    const mat = createMat();
    mat.onAccepted(buildEvent({ seq: 1, type: 'unrelated.event', payload: {} }), {
      origin: 'local',
    });
    const snap = mat.getDirtySources();
    expect(snap.dirtySourceUnitIds).toEqual([]);
    expect(snap.tombstonedSourceUnitIds).toEqual([]);
    expect(snap.latestExtractionFor.size).toBe(0);
  });
});
