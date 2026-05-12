import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot, ConnectionsStore } from '../connections/snapshot.js';
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
          metadata: { canonicalUrl },
        },
        {
          id: 'workstream:ws_security',
          kind: 'workstream',
          label: 'Security workstream',
          metadata: {},
        },
        {
          id: 'timeline-visit:https://example.test/anchor',
          kind: 'timeline-visit',
          label: 'Anchor URL',
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

  it('POST /v1/visits/{url}/resolve auto-applies a strong URL resolver decision', async () => {
    const canonicalUrl = 'https://example.test/strong-url';
    await appendObservation({ seq: 1, url: canonicalUrl, tabSessionId: 'tses_a' });
    installStrongUrlSnapshot(canonicalUrl);

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
    expect(body.data?.projection?.byCanonicalUrl?.[canonicalUrl]?.currentAttribution).toMatchObject({
      workstreamId: 'ws_security',
      source: 'inferred',
    });
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
