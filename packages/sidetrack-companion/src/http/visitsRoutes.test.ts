import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionsSnapshot, ConnectionsStore } from '../connections/snapshot.js';
import { SqliteConnectionsStore } from '../connections/snapshot.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import {
  lanePrequentialPath,
  lanePrequentialSummary,
  resetLanePrequentialMemoForTest,
} from '../tabsession/lanePrequential.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { __resetResolverCacheDeferQueue, flushResolverCacheWrites } from './resolverCacheDefer.js';
import { eventCandidateCacheRevision } from './routes/visitsRoutes.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('per-URL HTTP routes', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let currentConnectionsSnapshot: ConnectionsSnapshot | null = null;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'visits-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-visits-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    const connectionsStore: ConnectionsStore = {
      putCurrent: async (snapshot) => {
        currentConnectionsSnapshot = snapshot;
      },
      readCurrent: async () => currentConnectionsSnapshot,
      putDay: async () => undefined,
      readDay: async () => null,
      listDays: async () => [],
    };
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      connectionsStore,
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const headers = (idempotencyKey?: string): Record<string, string> => ({
    'content-type': 'application/json',
    'x-bac-bridge-key': bridgeKey,
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
  });

  const appendObservation = async (input: {
    seq: number;
    url: string;
    title?: string;
    tabSessionId?: string;
  }): Promise<void> => {
    await eventLog.appendClient({
      clientEventId: `observed-${String(input.seq)}`,
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: `tl-${String(input.seq)}`,
        observedAt: '2026-05-07T10:00:00.000Z',
        url: input.url,
        canonicalUrl: input.url,
        transition: 'updated',
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.tabSessionId === undefined ? {} : { tabSessionId: input.tabSessionId }),
      },
      baseVector: {},
    });
  };

  const installStrongUrlSnapshot = (canonicalUrl: string): void => {
    currentConnectionsSnapshot = {
      scope: {},
      nodes: [
        {
          id: `timeline-visit:${canonicalUrl}`,
          kind: 'timeline-visit',
          label: 'Target URL',
          originReplicaIds: [],
          metadata: { canonicalUrl },
        },
        {
          id: 'workstream:ws_security',
          kind: 'workstream',
          label: 'Security workstream',
          originReplicaIds: [],
          metadata: {},
        },
        {
          id: 'timeline-visit:https://example.test/anchor',
          kind: 'timeline-visit',
          label: 'Anchor URL',
          originReplicaIds: [],
          metadata: { canonicalUrl: 'https://example.test/anchor' },
        },
      ],
      edges: [
        {
          id: 'edge:target-anchor',
          kind: 'closest_visit',
          fromNodeId: `timeline-visit:${canonicalUrl}`,
          toNodeId: 'timeline-visit:https://example.test/anchor',
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'ranker', revisionId: 'ranker-test' },
          confidence: 'inferred',
        },
        {
          id: 'edge:anchor-workstream',
          kind: 'visit_in_workstream',
          fromNodeId: 'timeline-visit:https://example.test/anchor',
          toNodeId: 'workstream:ws_security',
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'event-log' },
          confidence: 'asserted',
        },
      ],
      updatedAt: '2026-05-07T10:00:00.000Z',
      nodeCount: 3,
      edgeCount: 2,
    };
  };

  it('GET /v1/visits/inbox lists unattributed URLs newest-first', async () => {
    await appendObservation({
      seq: 1,
      url: 'https://news.ycombinator.com/item?id=1',
      title: 'A',
      tabSessionId: 'tses_a',
    });
    await appendObservation({
      seq: 2,
      url: 'https://news.ycombinator.com/item?id=2',
      title: 'B',
      tabSessionId: 'tses_b',
    });

    const response = await fetch(`${serverUrl}/v1/visits/inbox`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        items: { canonicalUrl: string; latestTitle?: string }[];
        total: number;
      };
    };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items.map((item) => item.canonicalUrl).sort()).toEqual([
      'https://news.ycombinator.com/item?id=1',
      'https://news.ycombinator.com/item?id=2',
    ]);
    expect(body.data.total).toBe(2);
  });

  it('POST /v1/visits/{url}/attribute records explicit attribution', async () => {
    const canonicalUrl = 'https://github.com/zyingfei/switchboard/pulls';
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_a' });

    const attribute = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/attribute`,
      {
        method: 'POST',
        headers: headers('idem-attr-1'),
        body: JSON.stringify({ workstreamId: 'ws_switchboard' }),
      },
    );
    expect(attribute.status).toBe(201);

    const inbox = await fetch(`${serverUrl}/v1/visits/inbox`, { headers: headers() });
    const body = (await inbox.json()) as { data: { items: unknown[]; total: number } };
    // Attributed URL no longer surfaces in the Inbox.
    expect(body.data.total).toBe(0);
    expect(body.data.items).toHaveLength(0);

    const projection = await fetch(`${serverUrl}/v1/visits/projection`, { headers: headers() });
    const projBody = (await projection.json()) as {
      data: {
        byCanonicalUrl: Record<string, { currentAttribution?: { workstreamId: string | null } }>;
      };
    };
    expect(projBody.data.byCanonicalUrl[canonicalUrl]?.currentAttribution?.workstreamId).toBe(
      'ws_switchboard',
    );
  });

  it('serves a durable opportunity id, stores the explicit outcome, and reads back a joined score', async () => {
    const canonicalUrl = 'https://coverage.test/served-page';
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_coverage' });
    installStrongUrlSnapshot(canonicalUrl);

    const served = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ canonicalUrls: [canonicalUrl] }),
    });
    expect(served.status).toBe(200);
    const servedBody = (await served.json()) as {
      data: {
        results: Record<string, { readonly servedOpportunityId?: unknown }>;
      };
    };
    const opportunityId = servedBody.data.results[canonicalUrl]?.servedOpportunityId;
    expect(opportunityId).toMatch(/^laneopp_[0-9a-f]{32}$/u);
    if (typeof opportunityId !== 'string') throw new Error('missing served opportunity id');

    // The prediction append is deliberately off the response path. Read the
    // served artifact back before answering so this acceptance test enforces
    // the same predict-then-observe ordering required in production.
    const predictionDeadline = Date.now() + 2_000;
    let predictionText = '';
    while (!predictionText.includes(opportunityId) && Date.now() < predictionDeadline) {
      predictionText = await readFile(lanePrequentialPath(vaultRoot), 'utf8').catch(() => '');
      if (!predictionText.includes(opportunityId)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(predictionText).toContain(opportunityId);

    const outcome = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/attribute`,
      {
        method: 'POST',
        headers: headers('idem-coverage-outcome'),
        body: JSON.stringify({ workstreamId: 'ws_security', servedOpportunityId: opportunityId }),
      },
    );
    expect(outcome.status).toBe(201);

    const accepted = (await eventLog.readMerged()).find(
      (event) => event.clientEventId === 'idem-coverage-outcome',
    );
    expect(accepted?.payload).toMatchObject({
      itemKind: 'canonical-url',
      itemId: canonicalUrl,
      toContainer: 'ws_security',
      details: { servedOpportunityId: opportunityId },
    });

    resetLanePrequentialMemoForTest();
    const summary = await lanePrequentialSummary(vaultRoot, 5_000);
    expect(summary.rawPredictionRows).toBeGreaterThan(0);
    expect(summary.eligibleOpportunities).toBe(1);
    expect(summary.outcomesObserved).toBe(1);
    expect(summary.outcomesJoined).toBe(1);
    expect(summary.outcomeJoinCoverage).toBe(1);
    expect(summary.scored).toBeGreaterThan(0);
    expect(summary.unscored).toBe(0);
  });

  it('rejects a malformed servedOpportunityId instead of storing an unjoinable value', async () => {
    const canonicalUrl = 'https://coverage.test/invalid-id';
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_invalid' });
    const response = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/attribute`,
      {
        method: 'POST',
        headers: headers('idem-invalid-opportunity'),
        body: JSON.stringify({ workstreamId: 'ws_security', servedOpportunityId: '' }),
      },
    );
    expect(response.status).toBe(400);
    expect(
      (await eventLog.readMerged()).some(
        (event) => event.clientEventId === 'idem-invalid-opportunity',
      ),
    ).toBe(false);
  });

  it('POST attribute with workstreamId:null dismisses the URL back to Inbox', async () => {
    const canonicalUrl = 'https://example.test/article';
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_a' });
    await fetch(`${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/attribute`, {
      method: 'POST',
      headers: headers('idem-attr-set'),
      body: JSON.stringify({ workstreamId: 'ws' }),
    });
    const dismiss = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/attribute`,
      {
        method: 'POST',
        headers: headers('idem-attr-null'),
        body: JSON.stringify({ workstreamId: null }),
      },
    );
    expect(dismiss.status).toBe(201);

    const projection = await fetch(`${serverUrl}/v1/visits/projection`, { headers: headers() });
    const body = (await projection.json()) as {
      data: {
        byCanonicalUrl: Record<string, { currentAttribution?: { workstreamId: string | null } }>;
      };
    };
    expect(body.data.byCanonicalUrl[canonicalUrl]?.currentAttribution?.workstreamId).toBeNull();
  });

  it('POST /v1/visits/{url}/ignore writes urls.ignored event and hides URL from Inbox', async () => {
    const canonicalUrl = 'https://example.test/admin-panel';
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_a' });
    const ignore = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/ignore`,
      {
        method: 'POST',
        headers: headers('idem-ignore-1'),
        body: JSON.stringify({ reason: 'noise' }),
      },
    );
    expect(ignore.status).toBe(201);
    const inbox = await fetch(`${serverUrl}/v1/visits/inbox`, { headers: headers() });
    const body = (await inbox.json()) as { data: { items: unknown[]; total: number } };
    expect(body.data.total).toBe(0);
    expect(body.data.items).toHaveLength(0);
  });

  it('POST /v1/visits/{url}/ignore defaults reason to "noise" when omitted', async () => {
    const canonicalUrl = 'https://example.test/some-page';
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_a' });
    const ignore = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/ignore`,
      {
        method: 'POST',
        headers: headers('idem-ignore-default'),
        body: JSON.stringify({}),
      },
    );
    expect(ignore.status).toBe(201);
    const body = (await ignore.json()) as {
      data: {
        projection: {
          byCanonicalUrl: Record<string, { currentIgnored?: { reason?: string } }>;
        };
      };
    };
    expect(body.data.projection.byCanonicalUrl[canonicalUrl]?.currentIgnored?.reason).toBe('noise');
  });

  it('POST /v1/visits/{url}/resolve returns `skipped-disabled` when env opts out', async () => {
    const canonicalUrl = 'https://example.test/opt-out-url';
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_a' });
    installStrongUrlSnapshot(canonicalUrl);
    const priorEnv = process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'];
    process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'] = '0';
    const response = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve`,
      {
        method: 'POST',
        headers: headers('url-auto-apply-optout'),
        body: JSON.stringify({ dryRun: false, policyMode: 'balanced' }),
      },
    );
    if (priorEnv === undefined) delete process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'];
    else process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'] = priorEnv;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly data?: { readonly status?: string } };
    expect(body.data?.status).toBe('skipped-disabled');
  });

  it('POST /v1/visits/{url}/resolve auto-applies a strong URL resolver decision on revisit', async () => {
    const canonicalUrl = 'https://example.test/strong-url';
    // Grace window: a freshly-captured URL stays a triageable Inbox row
    // on its FIRST observation. Auto-apply only assists once revisited
    // (visitCount >= 2) — so observe it twice here.
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_a' });
    await appendObservation({ seq: 2, url: canonicalUrl, tabSessionId: 'tses_a' });
    installStrongUrlSnapshot(canonicalUrl);
    // URL auto-apply is ON by default; the env opts OUT (no setup needed
    // for this test, the resolver will commit).

    const response = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve`,
      {
        method: 'POST',
        headers: headers('url-auto-apply-a'),
        body: JSON.stringify({ dryRun: false, policyMode: 'balanced' }),
      },
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      readonly data?: {
        readonly status?: string;
        readonly projection?: unknown;
      };
    };
    expect(body.data?.status).toBe('applied');
    expect(body.data?.projection).toBeUndefined();
    await expect(eventLog.readMerged()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: URL_ATTRIBUTION_INFERRED,
          aggregateId: `url-inferred:${canonicalUrl}`,
          payload: expect.objectContaining({
            payloadVersion: 1,
            canonicalUrl,
            workstreamId: 'ws_security',
            policyMode: 'balanced',
          }),
        }),
      ]),
    );
  });

  it('POST /v1/visits/{url}/resolve keeps a first-observation URL triageable (grace window)', async () => {
    const canonicalUrl = 'https://example.test/fresh-url';
    // Observed exactly once (visitCount 1) → even a strong decision must
    // NOT auto-file it; it stays a normal Inbox row until the user
    // triages it (or revisits it).
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_a' });
    installStrongUrlSnapshot(canonicalUrl);

    const response = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve`,
      {
        method: 'POST',
        headers: headers('url-grace-window-a'),
        body: JSON.stringify({ dryRun: false, policyMode: 'balanced' }),
      },
    );

    // Skipped (no event appended) → 200, not 201.
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly data?: {
        readonly status?: string;
        readonly projection?: unknown;
      };
    };
    expect(body.data?.status).toBe('skipped-grace-window');
    expect(body.data?.projection).toBeUndefined();
    await expect(eventLog.readMerged()).resolves.not.toContainEqual(
      expect.objectContaining({ type: URL_ATTRIBUTION_INFERRED }),
    );
  });

  it('POST attribute rejects malformed body', async () => {
    const canonicalUrl = 'https://example.test/article';
    await appendObservation({ seq: 1, url: canonicalUrl });
    const response = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/attribute`,
      {
        method: 'POST',
        headers: headers('idem-attr-malformed'),
        body: JSON.stringify({ workstreamId: 42 }),
      },
    );
    expect(response.status).toBe(400);
  });
});

// Stage 5.2 R2 — when the companion has a connectionsStore wired and a
// snapshot with urlProjection embedded, GET /v1/visits/projection serves
// the projection from the snapshot (no event-log re-derivation) and
// returns snapshotRevision in the response envelope.
describe('per-URL HTTP routes — Stage 5.2 R2 snapshot-first read path', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'visits-snapshot-bridge-key';

  const buildFakeStore = (snapshot: ConnectionsSnapshot | null): ConnectionsStore => ({
    putCurrent: () => Promise.resolve(),
    readCurrent: () => Promise.resolve(snapshot),
    putDay: () => Promise.resolve(),
    readDay: () => Promise.resolve(null),
    listDays: () => Promise.resolve([]),
  });

  const snapshotWithProjection: ConnectionsSnapshot = {
    scope: {},
    nodes: [],
    edges: [],
    updatedAt: '2026-05-07T10:00:00.000Z',
    nodeCount: 0,
    edgeCount: 0,
    urlProjection: {
      schemaVersion: 1,
      byCanonicalUrl: {
        'https://snapshot.test/a': {
          canonicalUrl: 'https://snapshot.test/a',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:00.000Z',
          latestTitle: 'From snapshot',
          host: 'snapshot.test',
          visitCount: 1,
          tabSessionIds: ['tses_snap'],
          attributionHistory: [],
        },
      },
    },
    tabSessionProjection: {
      schemaVersion: 1,
      bySessionId: {},
      openSessionsByTabId: {},
    },
    snapshotRevision: 'rev-test-abc',
  };

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-visits-snapshot-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      connectionsStore: buildFakeStore(snapshotWithProjection),
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const reqHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    'x-bac-bridge-key': bridgeKey,
  });

  it('GET /v1/visits/projection returns urlProjection from the snapshot (no event-log work)', async () => {
    const response = await fetch(`${serverUrl}/v1/visits/projection`, { headers: reqHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { byCanonicalUrl: Record<string, { latestTitle?: string }> };
      snapshotRevision?: string;
    };
    expect(Object.keys(body.data.byCanonicalUrl)).toEqual(['https://snapshot.test/a']);
    expect(body.data.byCanonicalUrl['https://snapshot.test/a']?.latestTitle).toBe('From snapshot');
    expect(body.snapshotRevision).toBe('rev-test-abc');
  });

  it('GET /v1/visits/inbox reads from the snapshot and emits snapshotRevision', async () => {
    const response = await fetch(`${serverUrl}/v1/visits/inbox`, { headers: reqHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { items: { canonicalUrl: string }[]; total: number };
      snapshotRevision?: string;
    };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]?.canonicalUrl).toBe('https://snapshot.test/a');
    expect(body.snapshotRevision).toBe('rev-test-abc');
  });
});

describe('per-URL HTTP routes — resolver cache and batch resolve', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let connectionsStore: SqliteConnectionsStore;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'visits-resolver-cache-bridge-key';

  const snapshotForUrls = (urls: readonly string[], revision: string): ConnectionsSnapshot => ({
    scope: {},
    nodes: urls.map((canonicalUrl) => ({
      id: `timeline-visit:${canonicalUrl}`,
      kind: 'timeline-visit',
      label: canonicalUrl,
      originReplicaIds: [],
      metadata: { canonicalUrl },
    })),
    edges: [],
    updatedAt: '2026-05-07T10:00:00.000Z',
    nodeCount: urls.length,
    edgeCount: 0,
    snapshotRevision: revision,
  });

  const snapshotForEventCandidateUrl = (
    targetUrl: string,
    anchorUrl: string,
    revision: string,
  ): ConnectionsSnapshot => ({
    scope: {},
    nodes: [
      {
        id: `timeline-visit:${targetUrl}`,
        kind: 'timeline-visit',
        label: 'Target URL',
        originReplicaIds: [],
        metadata: { canonicalUrl: targetUrl },
      },
      {
        id: `timeline-visit:${anchorUrl}`,
        kind: 'timeline-visit',
        label: 'Anchor URL',
        originReplicaIds: [],
        metadata: { canonicalUrl: anchorUrl },
      },
      {
        id: 'workstream:ws_security',
        kind: 'workstream',
        label: 'Security workstream',
        originReplicaIds: [],
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'edge:anchor-workstream',
        kind: 'visit_in_workstream',
        fromNodeId: `timeline-visit:${anchorUrl}`,
        toNodeId: 'workstream:ws_security',
        observedAt: '2026-05-07T10:00:00.000Z',
        producedBy: { source: 'event-log' },
        confidence: 'asserted',
      },
    ],
    updatedAt: '2026-05-07T10:00:00.000Z',
    nodeCount: 3,
    edgeCount: 1,
    snapshotRevision: revision,
  });

  const appendObservation = async (input: {
    seq: number;
    url: string;
    title?: string;
  }): Promise<void> => {
    await eventLog.appendClient({
      clientEventId: `observed-resolver-${String(input.seq)}`,
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: `tl-resolver-${String(input.seq)}`,
        observedAt: '2026-05-07T10:00:00.000Z',
        url: input.url,
        canonicalUrl: input.url,
        transition: 'updated',
        ...(input.title === undefined ? {} : { title: input.title }),
      },
      baseVector: {},
    });
  };

  const createResolverCacheStore = (): SqliteConnectionsStore => {
    let current: ConnectionsSnapshot | null = null;
    const cache = new Map<string, unknown>();
    return Object.assign(Object.create(SqliteConnectionsStore.prototype), {
      putCurrent: vi.fn(async (snapshot: ConnectionsSnapshot) => {
        current = snapshot;
      }),
      readCurrent: vi.fn(async () => current),
      readResolverSubgraphForUrl: vi.fn(async () => current),
      readResolverSubgraphForUrls: vi.fn(async () => current),
      readSnapshotMetadata: vi.fn(async () =>
        current === null
          ? null
          : {
              scope: current.scope,
              updatedAt: current.updatedAt,
              nodeCount: current.nodeCount,
              edgeCount: current.edgeCount,
              ...(current.snapshotRevision === undefined
                ? {}
                : { snapshotRevision: current.snapshotRevision }),
            },
      ),
      cacheResolverResult: vi.fn(
        async (visitId: string, snapshotRevision: string, result: unknown) => {
          cache.set(`${visitId}\0${snapshotRevision}`, result);
        },
      ),
      getCachedResolverResult: vi.fn(async (visitId: string, snapshotRevision: string) =>
        cache.get(`${visitId}\0${snapshotRevision}`) ?? null,
      ),
      writeSnapshotAndProgress: vi.fn(async (snapshot: ConnectionsSnapshot) => {
        current = snapshot;
      }),
      readMaterializerProgress: vi.fn(async () => null),
      putDay: vi.fn(async () => undefined),
      readDay: vi.fn(async () => null),
      listDays: vi.fn(async () => []),
      close: vi.fn(() => undefined),
    }) as unknown as SqliteConnectionsStore;
  };

  beforeEach(async () => {
    // The deferred resolver-cache write queue is MODULE-LEVEL, process-
    // lifetime state (resolverCacheDefer.ts) — reset it per test so a write
    // still pending from a PRIOR test (this file's or another's, sharing the
    // one bun:test process) can never be mistaken for THIS test's write when
    // it is later flushed and its mock call recorded.
    __resetResolverCacheDeferQueue();
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-visits-resolver-cache-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    connectionsStore = createResolverCacheStore();
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      connectionsStore,
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    // Drain (or drop) anything still queued for THIS test's now-closing store
    // before resetting — an unflushed write left in the queue would otherwise
    // carry into the next test's flush/assertions.
    __resetResolverCacheDeferQueue();
    connectionsStore.close();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const reqHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    'x-bac-bridge-key': bridgeKey,
  });

  // bun:test's vitest-compat shim does not implement `vi.mocked` — every
  // fake store method here is already a `vi.fn(...)`, just typed as its
  // plain function signature (the fakes are cast to SqliteConnectionsStore),
  // so `.mock.calls` exists at runtime but not in the type. This narrows
  // just enough to read it back without an `any` leaking into a call site.
  const mockCallsOf = (fn: unknown): readonly (readonly unknown[])[] =>
    (fn as { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }).mock.calls;

  // Last (not first) matching call for a URL. The per-URL resolver-cache
  // WRITE is deferred off the request path (resolverCacheDefer.ts, default
  // ON) and queued in a MODULE-LEVEL, process-lifetime map keyed on
  // (visitId, revision) — a DIFFERENT revision for the same URL (e.g. an
  // earlier request in the same test, before a candidate-set change) queues
  // a SEPARATE entry rather than overwriting it. `await
  // flushResolverCacheWrites()` (called at each checkpoint below) drains
  // whatever is pending AT THAT MOMENT in insertion order, so if more than
  // one entry for the same URL is still pending it is because more than one
  // genuinely distinct write is in flight — picking the LAST one keeps these
  // assertions correct even when an earlier request's write in the SAME test
  // has not been individually flushed+cleared before this checkpoint.
  const lastMockCallFor = (
    fn: unknown,
    url: string,
  ): readonly unknown[] | undefined => {
    const calls = mockCallsOf(fn).filter(([callUrl]) => callUrl === url);
    return calls[calls.length - 1];
  };

  // Structural check for a folded event-candidate resolver-cache revision —
  // deliberately NOT an exact-string match against a second, independent
  // `resolverCacheRevision(...)` call. That would re-read `attributionArm()`
  // (env-backed) at ASSERTION time, which only needs to disagree with
  // whatever the SERVER read at REQUEST time (e.g. a differently-ordered
  // full suite run leaving a different arm active) to make this fragile in
  // a way that has nothing to do with the behavior under test. The `|ec:`
  // suffix is a pure function of `foldedUrls` (stableHash has no env
  // dependency at all) and is asserted exactly; the `|arm=`-prefixed base
  // revision is asserted only by shape.
  const expectFoldedEventCandidateRevision = (
    actualRevision: unknown,
    plainRevisionPrefix: string,
    foldedUrls: readonly string[],
  ): void => {
    expect(typeof actualRevision).toBe('string');
    const revision = actualRevision as string;
    expect(revision.startsWith(`${plainRevisionPrefix}|arm=`)).toBe(true);
    // Neutral placeholder base -- eventCandidateCacheRevision has no env
    // dependency at all (pure sort + stableHash), so its `|ec:<hash>`
    // suffix for a given URL set is identical no matter what base revision
    // it is folded onto. Deriving the expected suffix THIS way (rather than
    // recomputing the hash inline) can never drift from the real
    // implementation, including its internal join separator.
    const expectedSuffix = eventCandidateCacheRevision('placeholder', foldedUrls).slice(
      'placeholder'.length,
    );
    expect(revision.endsWith(expectedSuffix)).toBe(true);
  };

  it('memoizes GET /v1/visits/{url}/resolve by snapshotRevision', async () => {
    const canonicalUrl = 'https://cache.test/a';
    await connectionsStore.putCurrent(snapshotForUrls([canonicalUrl], 'rev-cache-a'));
    const readMerged = vi.spyOn(eventLog, 'readMerged');

    const first = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
      { headers: reqHeaders() },
    );
    const second = await fetch(
      `${serverUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
      { headers: reqHeaders() },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as { data?: { lanes?: readonly unknown[] } };
    const secondBody = (await second.json()) as { data?: { lanes?: readonly unknown[] } };
    expect(secondBody).toEqual(firstBody);
    // The guess lanes ride the resolver-cache seam: the SECOND response is
    // served from the persisted (JSON.stringify → JSON.parse) cache entry, and
    // it still carries the six lanes just like the freshly-computed first. (The
    // content lane, lane 7, is a batch-resolve-only addition; the single-URL GET
    // resolve route is unchanged and stays six.)
    expect(secondBody.data?.lanes).toHaveLength(6);
    expect(readMerged).toHaveBeenCalledTimes(1);
  });

  it('POST /v1/visits/batch-resolve returns one result per URL', async () => {
    const urls = Array.from(
      { length: 10 },
      (_value, index) => `https://batch.test/${String(index)}`,
    );
    await connectionsStore.putCurrent(snapshotForUrls(urls, 'rev-batch-a'));
    const readCurrent = vi.spyOn(connectionsStore, 'readCurrent');
    const readResolverSubgraphForUrls = vi.spyOn(connectionsStore, 'readResolverSubgraphForUrls');
    const readMerged = vi.spyOn(eventLog, 'readMerged');

    const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({ canonicalUrls: urls }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        results: Record<
          string,
          {
            canonicalUrl: string;
            lanes?: readonly { readonly lane: string; readonly emptyReason?: string }[];
          }
        >;
      };
    };
    expect(Object.keys(body.data.results).sort()).toEqual([...urls].sort());
    expect(
      Object.values(body.data.results)
        .map((result) => result.canonicalUrl)
        .sort(),
    ).toEqual([...urls].sort());
    // Guess lanes (SIDETRACK_GUESS_LANES, default ON) ride each per-URL result:
    // all six base lanes in fixed order PLUS the query-time content lane (lane 7,
    // SIDETRACK_CONTENT_LANE default ON) appended after 'recency'. This batch has
    // no graph path, no v1 state artifact, and the recall store was never opened,
    // so every lane is empty WITH a reason (typed emptiness).
    const oneResult = body.data.results[urls[0]!]!;
    expect(oneResult.lanes?.map((lane) => lane.lane)).toEqual([
      'graph',
      'similarity',
      'topic',
      'title',
      'domain',
      'recency',
      'content',
      'ai',
    ]);
    const contentLane = oneResult.lanes?.find((lane) => lane.lane === 'content');
    expect(contentLane?.emptyReason).toBe('recall store unavailable');
    for (const lane of oneResult.lanes ?? []) {
      expect(lane.emptyReason, `empty lane ${lane.lane} must carry a reason`).toBeDefined();
    }
    expect(readResolverSubgraphForUrls).toHaveBeenCalledTimes(1);
    expect(readResolverSubgraphForUrls).toHaveBeenCalledWith(urls);
    expect(readCurrent).not.toHaveBeenCalled();
    expect(readMerged).toHaveBeenCalledTimes(1);
  });

  it('POST /v1/visits/batch-resolve can expand focused URL event candidates', async () => {
    // Two pages on the SAME single-topic domain so the same_repo_or_domain
    // candidate source (domain:docs.kernel.org) links the focused URL to the
    // workstream-bearing anchor. Deliberately NOT an aggregator domain
    // (news.ycombinator.com / reddit.com / …): those are suppressed by the
    // COARSE_MULTI_TOPIC_DOMAINS guard in ranker/candidates.ts, which drops
    // bare-domain + title/path grouping precisely because two same-domain
    // items there are NOT topically related. This test exercises the
    // event-candidate-expansion path, not that guard.
    const targetUrl = 'https://docs.kernel.org/security/self-protection.html';
    const anchorUrl = 'https://docs.kernel.org/security/lsm.html';
    await connectionsStore.putCurrent(
      snapshotForEventCandidateUrl(targetUrl, anchorUrl, 'rev-event-candidates'),
    );
    await appendObservation({
      seq: 1,
      url: targetUrl,
      title: 'Kernel Self-Protection',
    });
    await appendObservation({
      seq: 2,
      url: anchorUrl,
      title: 'Linux Security Module framework',
    });

    const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({ canonicalUrls: [targetUrl], eventCandidateUrls: [targetUrl] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        results: Record<
          string,
          { readonly fusedCandidates: readonly { readonly workstreamId: string }[] }
        >;
      };
    };
    expect(body.data.results[targetUrl]?.fusedCandidates[0]?.workstreamId).toBe('ws_security');
    // The PLAIN revision is never used for an event-candidate target — a
    // collision there would let an event-candidate-expanded resolve shadow
    // (or be shadowed by) the six-lane plain result. It is cached, but only
    // under the FOLDED revision (perf/event-candidate-resolve) — see the
    // next test for the folded key's cache-hit behavior.
    expect(connectionsStore.getCachedResolverResult).not.toHaveBeenCalledWith(
      targetUrl,
      'rev-event-candidates',
    );
    expect(connectionsStore.cacheResolverResult).not.toHaveBeenCalledWith(
      targetUrl,
      'rev-event-candidates',
      expect.anything(),
    );
    // Deterministic, not a poll: the write is queued but drains on a
    // `setImmediate` AFTER this response was already sent, so it can still
    // be in flight at this point — awaiting the SAME drain function the
    // dispatch itself calls (resolverCacheDefer.ts) settles it exactly,
    // with no sleep/backoff involved.
    await flushResolverCacheWrites();
    const cacheWriteCall = lastMockCallFor(connectionsStore.cacheResolverResult, targetUrl);
    expect(cacheWriteCall).toBeDefined();
    expectFoldedEventCandidateRevision(cacheWriteCall?.[1], 'rev-event-candidates', [targetUrl]);
    expect(cacheWriteCall?.[2]).toEqual(
      expect.objectContaining({
        fusedCandidates: expect.arrayContaining([
          expect.objectContaining({ workstreamId: 'ws_security' }),
        ]),
      }),
    );
  });

  it('POST /v1/visits/batch-resolve serves a repeated event-candidate set from cache', async () => {
    const targetUrl = 'https://docs.kernel.org/security/self-protection.html';
    const anchorUrl = 'https://docs.kernel.org/security/lsm.html';
    await connectionsStore.putCurrent(
      snapshotForEventCandidateUrl(targetUrl, anchorUrl, 'rev-event-candidates-repeat'),
    );
    await appendObservation({ seq: 1, url: targetUrl, title: 'Kernel Self-Protection' });
    await appendObservation({ seq: 2, url: anchorUrl, title: 'Linux Security Module framework' });

    const requestBody = JSON.stringify({
      canonicalUrls: [targetUrl],
      eventCandidateUrls: [targetUrl],
    });
    const first = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: requestBody,
    });
    expect(first.status).toBe(200);
    // Deterministically settle the FIRST request's deferred write before the
    // second request starts — otherwise whether the second request observes
    // a cache hit depends on incidental scheduling (the write drains on a
    // `setImmediate` after the response, which is not guaranteed to have run
    // before the next `fetch` starts).
    await flushResolverCacheWrites();

    const readResolverSubgraphForUrls = vi.spyOn(connectionsStore, 'readResolverSubgraphForUrls');
    readResolverSubgraphForUrls.mockClear();

    const second = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: requestBody,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      data: {
        results: Record<
          string,
          { readonly fusedCandidates: readonly { readonly workstreamId: string }[] }
        >;
      };
    };
    // Second identical request hits the folded-key cache — same served
    // answer, and no fresh subgraph read for the miss path (item 4: an
    // all-cache-hit batch pays no subgraph read for attribution).
    expect(secondBody.data.results[targetUrl]?.fusedCandidates[0]?.workstreamId).toBe(
      'ws_security',
    );
    const cacheReadCall = lastMockCallFor(connectionsStore.getCachedResolverResult, targetUrl);
    expect(cacheReadCall).toBeDefined();
    expectFoldedEventCandidateRevision(cacheReadCall?.[1], 'rev-event-candidates-repeat', [
      targetUrl,
    ]);
  });

  it('POST /v1/visits/batch-resolve misses the event-candidate cache when the candidate set changes', async () => {
    const targetUrl = 'https://docs.kernel.org/security/self-protection.html';
    const anchorUrl = 'https://docs.kernel.org/security/lsm.html';
    await connectionsStore.putCurrent(
      snapshotForEventCandidateUrl(targetUrl, anchorUrl, 'rev-event-candidates-set-change'),
    );
    await appendObservation({ seq: 1, url: targetUrl, title: 'Kernel Self-Protection' });
    await appendObservation({ seq: 2, url: anchorUrl, title: 'Linux Security Module framework' });

    const first = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({ canonicalUrls: [targetUrl], eventCandidateUrls: [targetUrl] }),
    });
    expect(first.status).toBe(200);
    // Fully settle the FIRST request's deferred write (queued under the
    // {targetUrl}-only folded key) BEFORE spying/clearing below — otherwise
    // it can still be pending when the SECOND request's write is queued, and
    // one flush would drain both entries together, leaving the mock with two
    // calls for targetUrl under two different keys at once.
    await flushResolverCacheWrites();

    const cacheWrite = vi.spyOn(connectionsStore, 'cacheResolverResult');
    cacheWrite.mockClear();

    // Same target URL, but this batch ALSO flags anchorUrl as an event
    // candidate. eventCandidateTargetSet (the intersection with
    // canonicalUrls that actually drives the fold — see server.ts) is
    // therefore genuinely different from the first request's {targetUrl},
    // so this MUST miss the first request's folded cache entry and
    // recompute (caching under its OWN, differently-folded key). Note:
    // eventCandidateUrls entries NOT also present in canonicalUrls are
    // dropped by that intersection, so anchorUrl must be requested too —
    // an eventCandidateUrls-only change would be a no-op on the fold.
    const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({
        canonicalUrls: [targetUrl, anchorUrl],
        eventCandidateUrls: [targetUrl, anchorUrl],
      }),
    });
    expect(response.status).toBe(200);
    await flushResolverCacheWrites();
    const changedCacheWriteCall = lastMockCallFor(cacheWrite, targetUrl);
    expect(changedCacheWriteCall).toBeDefined();
    expectFoldedEventCandidateRevision(changedCacheWriteCall?.[1], 'rev-event-candidates-set-change', [
      targetUrl,
      anchorUrl,
    ]);
  });

  it('POST /v1/visits/batch-resolve accepts titleHints and appends the content lane', async () => {
    const url = 'https://titlehint.test/page';
    await connectionsStore.putCurrent(snapshotForUrls([url], 'rev-title-hint'));

    const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({
        canonicalUrls: [url],
        // Valid hint for the resolved URL + assorted invalid shapes that must be
        // ignored silently (never a 400): oversize (>500), wrong type, empty.
        titleHints: {
          [url]: 'Live Panel Title',
          'https://titlehint.test/other': 'x'.repeat(600),
          'https://titlehint.test/wrongtype': 42,
          'https://titlehint.test/empty': '',
        },
      }),
    });

    // Invalid titleHint shapes are dropped silently — the request still succeeds.
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        results: Record<
          string,
          { lanes?: readonly { readonly lane: string; readonly emptyReason?: string }[] }
        >;
      };
    };
    const lanes = body.data.results[url]?.lanes;
    // Lane 7 'content' is appended after 'recency'. The recall store was never
    // opened in this harness, so it is typed-empty 'recall store unavailable'.
    expect(lanes?.map((lane) => lane.lane)).toEqual([
      'graph',
      'similarity',
      'topic',
      'title',
      'domain',
      'recency',
      'content',
      'ai',
    ]);
    expect(lanes?.find((lane) => lane.lane === 'content')?.emptyReason).toBe(
      'recall store unavailable',
    );
  });

  it('POST /v1/visits/batch-resolve omits the content lane when SIDETRACK_CONTENT_LANE=0', async () => {
    const prior = process.env['SIDETRACK_CONTENT_LANE'];
    process.env['SIDETRACK_CONTENT_LANE'] = '0';
    try {
      const url = 'https://contentoff.test/page';
      await connectionsStore.putCurrent(snapshotForUrls([url], 'rev-content-off'));
      const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
        method: 'POST',
        headers: reqHeaders(),
        body: JSON.stringify({ canonicalUrls: [url] }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: { results: Record<string, { lanes?: readonly { readonly lane: string }[] }> };
      };
      // Content lane disabled ⇒ the six base lanes only, no 'content' entry.
      expect(body.data.results[url]?.lanes?.map((lane) => lane.lane)).toEqual([
        'graph',
        'similarity',
        'topic',
        'title',
        'domain',
        'recency',
      ]);
    } finally {
      if (prior === undefined) delete process.env['SIDETRACK_CONTENT_LANE'];
      else process.env['SIDETRACK_CONTENT_LANE'] = prior;
    }
  });

  // ---- deferred resolver-cache write (SIDETRACK_RESOLVER_CACHE_DEFER) ----
  //
  // The per-URL `cacheResolverResult` upsert is the sqlite3BtreeInsert frame
  // that showed up in a native `sample` of a live batch-resolve — a WRITE on
  // the request path, once per resolved URL, synchronous because bun:sqlite has
  // no async API. It is now queued during the request and drained by the HTTP
  // dispatch AFTER the response is written. These two tests pin the end-to-end
  // behaviour of both switch positions; the queue's own semantics (last-wins,
  // single-flight, failure containment, overflow) live in
  // http/resolverCacheDefer.test.ts.

  it('POST /v1/visits/batch-resolve persists the resolver cache AFTER responding', async () => {
    const urls = ['https://defer.test/a', 'https://defer.test/b'];
    await connectionsStore.putCurrent(snapshotForUrls(urls, 'rev-defer-on'));
    const cacheWrite = vi.spyOn(connectionsStore, 'cacheResolverResult');

    const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({ canonicalUrls: urls }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { results: Record<string, { canonicalUrl: string }> };
    };
    // The response is complete and correct without the write having to land:
    // the request serves from its own in-memory results, so deferring the
    // upsert cannot change what the panel sees.
    expect(Object.keys(body.data.results).sort()).toEqual([...urls].sort());

    // ...and the write is NOT lost — it drains on the dispatch `finally`.
    // Polled rather than asserted immediately because "after the response" is
    // a scheduling guarantee (setImmediate), not a wall-clock one; the client
    // may observe the body before the drain tick has run.
    const deadline = Date.now() + 2_000;
    while (cacheWrite.mock.calls.length < urls.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(cacheWrite.mock.calls.length).toBe(urls.length);
    for (const url of urls) {
      expect(cacheWrite).toHaveBeenCalledWith(
        url,
        expect.stringContaining('rev-defer-on'),
        expect.anything(),
      );
    }
    // The deferred entry is really in the cache: a second batch on the same
    // revision is served from it (a lost write would just recompute, so this
    // is the assertion that proves the queue actually reached sqlite).
    const cacheRead = vi.spyOn(connectionsStore, 'getCachedResolverResult');
    const second = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({ canonicalUrls: urls }),
    });
    expect(second.status).toBe(200);
    expect(cacheRead.mock.results.every((result) => result.type === 'return')).toBe(true);
    // No NEW computes ⇒ no new writes queued for the same (url, revision).
    expect(cacheWrite.mock.calls.length).toBe(urls.length);
  });

  it('SIDETRACK_RESOLVER_CACHE_DEFER=0 writes the resolver cache inline', async () => {
    const prior = process.env['SIDETRACK_RESOLVER_CACHE_DEFER'];
    process.env['SIDETRACK_RESOLVER_CACHE_DEFER'] = '0';
    try {
      const url = 'https://defer-off.test/a';
      await connectionsStore.putCurrent(snapshotForUrls([url], 'rev-defer-off'));
      const cacheWrite = vi.spyOn(connectionsStore, 'cacheResolverResult');
      const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
        method: 'POST',
        headers: reqHeaders(),
        body: JSON.stringify({ canonicalUrls: [url] }),
      });
      expect(response.status).toBe(200);
      await response.json();
      // No polling: with the switch off the write is awaited inside the handler,
      // so it has necessarily happened before the response could be sent.
      expect(cacheWrite).toHaveBeenCalledWith(
        url,
        expect.stringContaining('rev-defer-off'),
        expect.anything(),
      );
    } finally {
      if (prior === undefined) delete process.env['SIDETRACK_RESOLVER_CACHE_DEFER'];
      else process.env['SIDETRACK_RESOLVER_CACHE_DEFER'] = prior;
    }
  });

  // Attribution v1 SHADOW parity: the served resolve response must be
  // byte-identical whether the shadow lane runs (flag ON, default) or is
  // disabled (SIDETRACK_ATTRIBUTION_V1_SHADOW=0). The scorer runs in shadow
  // only; nothing it produces may change what serves.
  it('GET /v1/visits/{url}/resolve response is identical with the v1 shadow flag on vs off', async () => {
    // Materialize a v1 state artifact so the shadow lane actually fires
    // (otherwise the emit is a no-op and the parity is trivial).
    const { writeAttributionV1Artifact } = await import('../attribution-v1/artifact.js');
    await eventLog.appendClient({
      clientEventId: 'shadow-label-1',
      aggregateId: 'shadow-agg',
      type: 'user.organized.item',
      payload: {
        payloadVersion: 1,
        itemKind: 'canonical-url',
        itemId: 'https://shadow.test/on',
        action: 'move',
        toContainer: 'ws_shadow',
      },
      baseVector: {},
    });
    await writeAttributionV1Artifact({ vaultRoot, eventLog });

    const prior = process.env['SIDETRACK_ATTRIBUTION_V1_SHADOW'];
    const priorMemo = await import('../attribution-v1/emit.js');
    try {
      // Flag ON (default): distinct url + revision so the route cache does
      // not short-circuit the second request below.
      const onUrl = 'https://shadow.test/on';
      await connectionsStore.putCurrent(snapshotForUrls([onUrl], 'rev-shadow-on'));
      priorMemo.resetShadowStateMemoForTest();
      delete process.env['SIDETRACK_ATTRIBUTION_V1_SHADOW'];
      const onResponse = await fetch(
        `${serverUrl}/v1/visits/${encodeURIComponent(onUrl)}/resolve?dryRun=true`,
        { headers: reqHeaders() },
      );
      expect(onResponse.status).toBe(200);
      const onBody = (await onResponse.json()) as { data: { canonicalUrl: string } };

      // Flag OFF: same logical input, different url+revision to force a
      // fresh resolve (not a cache hit).
      const offUrl = 'https://shadow.test/off';
      await connectionsStore.putCurrent(snapshotForUrls([offUrl], 'rev-shadow-off'));
      priorMemo.resetShadowStateMemoForTest();
      process.env['SIDETRACK_ATTRIBUTION_V1_SHADOW'] = '0';
      const offResponse = await fetch(
        `${serverUrl}/v1/visits/${encodeURIComponent(offUrl)}/resolve?dryRun=true`,
        { headers: reqHeaders() },
      );
      expect(offResponse.status).toBe(200);
      const offBody = (await offResponse.json()) as { data: { canonicalUrl: string } };

      // The two requests deliberately use different url+revision to force a
      // fresh resolve on each (the route cache is keyed on the snapshot).
      // The resolver legitimately embeds the url/revision in url-derived
      // fields (canonicalUrl, dependencyKey, evidenceHash, anchors,
      // snapshotRevision) — none of which the shadow lane touches. Normalize
      // those url/revision strings out and assert everything else is
      // identical: the shadow lane changed nothing about the served shape.
      const scrub = (value: unknown): unknown =>
        JSON.parse(
          JSON.stringify(value)
            .replaceAll('shadow.test/on', 'URL')
            .replaceAll('shadow.test/off', 'URL')
            .replaceAll('rev-shadow-on', 'REV')
            .replaceAll('rev-shadow-off', 'REV'),
        );
      const scrubbedOn = scrub(onBody) as { data: Record<string, unknown> };
      const scrubbedOff = scrub(offBody) as { data: Record<string, unknown> };
      // evidenceHash is a sha256 of the (now-normalized) inputs; it stays
      // url-dependent through hashing, so drop it after confirming both
      // sides still carry one.
      const stripHash = (b: { data: Record<string, unknown> }): unknown => {
        const reasons = b.data['reasons'] as Record<string, unknown> | undefined;
        if (reasons !== undefined) {
          expect(typeof reasons['evidenceHash']).toBe('string');
          delete reasons['evidenceHash'];
        }
        return b;
      };
      expect(stripHash(scrubbedOff)).toEqual(stripHash(scrubbedOn));
    } finally {
      if (prior === undefined) delete process.env['SIDETRACK_ATTRIBUTION_V1_SHADOW'];
      else process.env['SIDETRACK_ATTRIBUTION_V1_SHADOW'] = prior;
    }
  });
});
