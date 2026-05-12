import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot, ConnectionsStore } from '../connections/snapshot.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('tab-session HTTP routes', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let currentConnectionsSnapshot: ConnectionsSnapshot | null = null;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'tabsession-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-tabsession-http-'));
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

  const appendObservedTabSession = async (
    tabSessionId = 'tses_a',
    url = 'https://example.test/a',
  ): Promise<void> => {
    await eventLog.appendClient({
      clientEventId: `observed-${tabSessionId}`,
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: `tl-${tabSessionId}`,
        observedAt: '2026-05-07T10:00:00.000Z',
        url,
        transition: 'updated',
        tabIdHash: `tab-${tabSessionId}`,
        tabSessionId,
      },
      baseVector: {},
    });
  };

  const installStrongCausalSnapshot = (): void => {
    currentConnectionsSnapshot = {
      scope: {},
      nodes: [
        {
          id: 'tab-session:tses_a',
          kind: 'tab-session',
          label: 'tses_a',
          originReplicaIds: [],
          metadata: {},
        },
        {
          id: 'timeline-visit:https://example.test/a',
          kind: 'timeline-visit',
          label: 'A',
          originReplicaIds: [],
          metadata: {},
        },
        {
          id: 'timeline-visit:https://example.test/anchor',
          kind: 'timeline-visit',
          label: 'Anchor',
          originReplicaIds: [],
          metadata: {},
        },
        {
          id: 'workstream:ws_security',
          kind: 'workstream',
          label: 'Security',
          originReplicaIds: [],
          metadata: {},
        },
      ],
      edges: [
        {
          id: 'edge:visit-session',
          kind: 'visit_in_tab_session',
          fromNodeId: 'timeline-visit:https://example.test/a',
          toNodeId: 'tab-session:tses_a',
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'event-log' },
          confidence: 'observed',
        },
        {
          id: 'edge:closest',
          kind: 'closest_visit',
          fromNodeId: 'timeline-visit:https://example.test/a',
          toNodeId: 'timeline-visit:https://example.test/anchor',
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'ranker', revisionId: 'ranker-test' },
          confidence: 'inferred',
        },
        {
          id: 'edge:visit-workstream',
          kind: 'visit_in_workstream',
          fromNodeId: 'timeline-visit:https://example.test/anchor',
          toNodeId: 'workstream:ws_security',
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'event-log' },
          confidence: 'asserted',
        },
      ],
      updatedAt: '2026-05-07T10:00:00.000Z',
      nodeCount: 4,
      edgeCount: 3,
    };
  };

  it('accepts tab-session user.organized.item through the feedback route', async () => {
    const response = await fetch(`${serverUrl}/v1/feedback/events`, {
      method: 'POST',
      headers: headers('tabsession-feedback-a'),
      body: JSON.stringify({
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'tab-session',
          itemId: 'tses_a',
          action: 'move',
          toContainer: null,
        },
      }),
    });

    expect(response.status).toBe(201);
    await expect(eventLog.readMerged()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: USER_ORGANIZED_ITEM,
          aggregateId: 'feedback:tab-session:tses_a',
          payload: expect.objectContaining({ toContainer: null }),
        }),
      ]),
    );
  });

  it('posts an attribution and returns the updated projection in the same request', async () => {
    await eventLog.appendClient({
      clientEventId: 'observed-tses-a',
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: 'tl-1',
        observedAt: '2026-05-07T10:00:00.000Z',
        url: 'https://example.test/a',
        transition: 'updated',
        tabIdHash: 'tab_a',
        tabSessionId: 'tses_a',
      },
      baseVector: {},
    });

    const response = await fetch(`${serverUrl}/v1/tabsessions/tses_a/attribute`, {
      method: 'POST',
      headers: headers('tabsession-attribute-a'),
      body: JSON.stringify({ workstreamId: 'ws_security' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      readonly data?: {
        readonly projection?: {
          readonly bySessionId?: Record<
            string,
            { readonly currentAttribution?: { readonly workstreamId?: string } }
          >;
        };
      };
    };
    expect(body.data?.projection?.bySessionId?.['tses_a']?.currentAttribution).toMatchObject({
      workstreamId: 'ws_security',
    });
    await expect(eventLog.readMerged()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: USER_ORGANIZED_ITEM,
          aggregateId: 'feedback:tab-session:tses_a',
          payload: expect.objectContaining({
            itemKind: 'tab-session',
            itemId: 'tses_a',
            action: 'move',
            toContainer: 'ws_security',
          }),
        }),
      ]),
    );

    const second = await fetch(`${serverUrl}/v1/tabsessions/tses_a/attribute`, {
      method: 'POST',
      headers: headers('tabsession-attribute-b'),
      body: JSON.stringify({ workstreamId: 'ws_research' }),
    });

    expect(second.status).toBe(201);
    await expect(eventLog.readMerged()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: USER_ORGANIZED_ITEM,
          payload: expect.objectContaining({
            itemKind: 'tab-session',
            itemId: 'tses_a',
            action: 'move',
            fromContainer: 'ws_security',
            toContainer: 'ws_research',
          }),
        }),
      ]),
    );
  });

  it('returns only open unattributed sessions in the inbox', async () => {
    await eventLog.appendClient({
      clientEventId: 'observed-tses-a',
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: 'tl-1',
        observedAt: '2026-05-07T10:00:00.000Z',
        url: 'https://example.test/a',
        transition: 'updated',
        tabIdHash: 'tab_a',
        tabSessionId: 'tses_a',
      },
      baseVector: {},
    });
    await fetch(`${serverUrl}/v1/tabsessions/tses_a/attribute`, {
      method: 'POST',
      headers: headers('tabsession-dismiss-a'),
      body: JSON.stringify({ workstreamId: null }),
    });
    await eventLog.appendClient({
      clientEventId: 'observed-tses-b',
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: 'tl-2',
        observedAt: '2026-05-07T10:01:00.000Z',
        url: 'https://example.test/b',
        transition: 'updated',
        tabIdHash: 'tab_b',
        tabSessionId: 'tses_b',
      },
      baseVector: {},
    });

    const response = await fetch(`${serverUrl}/v1/tabsessions/inbox?limit=10&offset=0`, {
      headers: headers(),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly data?: { readonly items?: readonly { readonly tabSessionId: string }[] };
    };
    expect(body.data?.items?.map((item) => item.tabSessionId)).toEqual(['tses_b']);
  });

  it('resolves tab-session attribution candidates through the dry-run endpoint without writes', async () => {
    await eventLog.appendClient({
      clientEventId: 'observed-tses-a',
      aggregateId: '2026-05-07',
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: 'tl-1',
        observedAt: '2026-05-07T10:00:00.000Z',
        url: 'https://example.test/a',
        transition: 'updated',
        tabIdHash: 'tab_a',
        tabSessionId: 'tses_a',
      },
      baseVector: {},
    });
    currentConnectionsSnapshot = {
      scope: {},
      nodes: [
        {
          id: 'tab-session:tses_a',
          kind: 'tab-session',
          label: 'tses_a',
          originReplicaIds: [],
          metadata: {},
        },
        {
          id: 'timeline-visit:https://example.test/a',
          kind: 'timeline-visit',
          label: 'A',
          originReplicaIds: [],
          metadata: {},
        },
        {
          id: 'timeline-visit:https://example.test/anchor',
          kind: 'timeline-visit',
          label: 'Anchor',
          originReplicaIds: [],
          metadata: {},
        },
        {
          id: 'workstream:ws_security',
          kind: 'workstream',
          label: 'Security',
          originReplicaIds: [],
          metadata: {},
        },
      ],
      edges: [
        {
          id: 'edge:visit-session',
          kind: 'visit_in_tab_session',
          fromNodeId: 'timeline-visit:https://example.test/a',
          toNodeId: 'tab-session:tses_a',
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'event-log' },
          confidence: 'observed',
        },
        {
          id: 'edge:closest',
          kind: 'closest_visit',
          fromNodeId: 'timeline-visit:https://example.test/a',
          toNodeId: 'timeline-visit:https://example.test/anchor',
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'ranker', revisionId: 'ranker-test' },
          confidence: 'inferred',
        },
        {
          id: 'edge:visit-workstream',
          kind: 'visit_in_workstream',
          fromNodeId: 'timeline-visit:https://example.test/anchor',
          toNodeId: 'workstream:ws_security',
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'event-log' },
          confidence: 'asserted',
        },
      ],
      updatedAt: '2026-05-07T10:00:00.000Z',
      nodeCount: 4,
      edgeCount: 3,
    };
    const before = await eventLog.readMerged();

    const response = await fetch(`${serverUrl}/v1/tabsessions/tses_a/resolve?dryRun=true`, {
      headers: headers(),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly data?: {
        readonly dryRun?: boolean;
        readonly fusedCandidates?: readonly { readonly workstreamId?: string }[];
      };
    };
    expect(body.data?.dryRun).toBe(true);
    expect(body.data?.fusedCandidates?.[0]?.workstreamId).toBe('ws_security');
    await expect(eventLog.readMerged()).resolves.toEqual(before);
  });

  it('auto-applies a balanced strong-causal resolver decision as a Class E event', async () => {
    await appendObservedTabSession();
    installStrongCausalSnapshot();

    const response = await fetch(`${serverUrl}/v1/tabsessions/tses_a/resolve`, {
      method: 'POST',
      headers: headers('tabsession-auto-apply-a'),
      body: JSON.stringify({ dryRun: false, policyMode: 'balanced' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      readonly data?: {
        readonly status?: string;
        readonly projection?: {
          readonly bySessionId?: Record<
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
    expect(body.data?.projection?.bySessionId?.['tses_a']?.currentAttribution).toMatchObject({
      workstreamId: 'ws_security',
      source: 'inferred',
    });
    await expect(eventLog.readMerged()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: TAB_SESSION_ATTRIBUTION_INFERRED,
          aggregateId: 'tabsession-inferred:tses_a',
          payload: expect.objectContaining({
            payloadVersion: 1,
            tabSessionId: 'tses_a',
            workstreamId: 'ws_security',
            policyMode: 'balanced',
          }),
        }),
      ]),
    );
  });

  it('does not auto-apply over a user-asserted tab-session attribution', async () => {
    await appendObservedTabSession();
    installStrongCausalSnapshot();
    await fetch(`${serverUrl}/v1/tabsessions/tses_a/attribute`, {
      method: 'POST',
      headers: headers('tabsession-manual-a'),
      body: JSON.stringify({ workstreamId: 'ws_manual' }),
    });

    const response = await fetch(`${serverUrl}/v1/tabsessions/tses_a/resolve`, {
      method: 'POST',
      headers: headers('tabsession-auto-apply-blocked-a'),
      body: JSON.stringify({ dryRun: false, policyMode: 'balanced' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly data?: {
        readonly status?: string;
        readonly projection?: {
          readonly bySessionId?: Record<
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
    expect(body.data?.status).toBe('skipped-existing-attribution');
    expect(body.data?.projection?.bySessionId?.['tses_a']?.currentAttribution).toMatchObject({
      workstreamId: 'ws_manual',
      source: 'user_asserted',
    });
    expect(
      (await eventLog.readMerged()).filter((event) => event.type === TAB_SESSION_ATTRIBUTION_INFERRED),
    ).toHaveLength(0);
  });

  it('rejects auto-apply when dependencyKey is stale (Stage 5.2 R4)', async () => {
    await appendObservedTabSession();
    installStrongCausalSnapshot();
    // R4 only engages when the snapshot carries a revision the client
    // could have read; production snapshots always do, but the
    // strong-causal fixture is pre-R1 so we stamp one here.
    if (currentConnectionsSnapshot !== null) {
      currentConnectionsSnapshot = {
        ...currentConnectionsSnapshot,
        snapshotRevision: 'sha256-fresh-abc',
      };
    }
    const response = await fetch(`${serverUrl}/v1/tabsessions/tses_a/resolve`, {
      method: 'POST',
      headers: headers('tabsession-auto-apply-stale-a'),
      body: JSON.stringify({
        dryRun: false,
        policyMode: 'balanced',
        dependencyKey: 'sha256-stale-does-not-match',
      }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe('STALE_SNAPSHOT');
  });

  it('accepts auto-apply when dependencyKey matches the snapshot revision', async () => {
    await appendObservedTabSession();
    installStrongCausalSnapshot();
    if (currentConnectionsSnapshot !== null) {
      currentConnectionsSnapshot = {
        ...currentConnectionsSnapshot,
        snapshotRevision: 'sha256-matching-abc',
      };
    }
    const response = await fetch(`${serverUrl}/v1/tabsessions/tses_a/resolve`, {
      method: 'POST',
      headers: headers('tabsession-auto-apply-match-a'),
      body: JSON.stringify({
        dryRun: false,
        policyMode: 'balanced',
        dependencyKey: 'sha256-matching-abc',
      }),
    });
    expect(response.status).toBe(201);
  });

  it('accepts auto-apply when dependencyKey is omitted (back-compat)', async () => {
    await appendObservedTabSession();
    installStrongCausalSnapshot();
    const response = await fetch(`${serverUrl}/v1/tabsessions/tses_a/resolve`, {
      method: 'POST',
      headers: headers('tabsession-auto-apply-no-key-a'),
      body: JSON.stringify({ dryRun: false, policyMode: 'balanced' }),
    });
    expect(response.status).toBe(201);
  });
});
