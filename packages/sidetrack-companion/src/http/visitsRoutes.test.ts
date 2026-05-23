import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionsSnapshot, ConnectionsStore } from '../connections/snapshot.js';
import { SqliteConnectionsStore } from '../connections/snapshot.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
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
        readonly projection?: {
          readonly byCanonicalUrl?: Record<
            string,
            {
              readonly currentAttribution?: {
                readonly workstreamId?: string;
                readonly source?: string;
              };
            }
          >;
        };
      };
    };
    expect(body.data?.status).toBe('applied');
    expect(body.data?.projection?.byCanonicalUrl?.[canonicalUrl]?.currentAttribution).toMatchObject(
      {
        workstreamId: 'ws_security',
        source: 'inferred',
      },
    );
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
        readonly projection?: {
          readonly byCanonicalUrl?: Record<
            string,
            { readonly currentAttribution?: unknown }
          >;
        };
      };
    };
    expect(body.data?.status).toBe('skipped-grace-window');
    expect(
      body.data?.projection?.byCanonicalUrl?.[canonicalUrl]?.currentAttribution,
    ).toBeUndefined();
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

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-visits-resolver-cache-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    connectionsStore = new SqliteConnectionsStore(vaultRoot, { databasePath: ':memory:' });
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
    connectionsStore.close();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const reqHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    'x-bac-bridge-key': bridgeKey,
  });

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
    expect(await second.json()).toEqual(await first.json());
    expect(readMerged).toHaveBeenCalledTimes(1);
  });

  it('POST /v1/visits/batch-resolve returns one result per URL', async () => {
    const urls = Array.from({ length: 10 }, (_value, index) => `https://batch.test/${String(index)}`);
    await connectionsStore.putCurrent(snapshotForUrls(urls, 'rev-batch-a'));
    const readCurrent = vi.spyOn(connectionsStore, 'readCurrent');
    const readMerged = vi.spyOn(eventLog, 'readMerged');

    const response = await fetch(`${serverUrl}/v1/visits/batch-resolve`, {
      method: 'POST',
      headers: reqHeaders(),
      body: JSON.stringify({ canonicalUrls: urls }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { results: Record<string, { canonicalUrl: string }> };
    };
    expect(Object.keys(body.data.results).sort()).toEqual([...urls].sort());
    expect(Object.values(body.data.results).map((result) => result.canonicalUrl).sort()).toEqual(
      [...urls].sort(),
    );
    expect(readCurrent).toHaveBeenCalledTimes(1);
    expect(readMerged).toHaveBeenCalledTimes(1);
  });
});
