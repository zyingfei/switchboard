import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createSyncContractRunner } from '../sync/contract/runner.js';
import { createTimelineMaterializer } from '../sync/contract/timelineMaterializer.js';
import { createTimelineStore } from '../timeline/projection.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  type BrowserTimelineObservedPayload,
} from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

// POST /v1/privacy/domain-tombstone — the per-rule "Purge captured
// data" route. Verifies: it persists + hides matching timeline visits
// at the serve boundary, is auth-gated, and is DENIED to mcp-key callers
// (data-lifecycle is not an agent-sanctioned operation).

const buildEvent = (input: {
  edgeReplicaId: string;
  seq: number;
  payload: BrowserTimelineObservedPayload;
}): AcceptedEvent => ({
  clientEventId: input.payload.eventId,
  dot: { replicaId: input.edgeReplicaId, seq: input.seq },
  deps: {},
  aggregateId: input.payload.observedAt.slice(0, 10),
  type: BROWSER_TIMELINE_OBSERVED,
  payload: input.payload,
  acceptedAtMs: Date.parse(input.payload.observedAt),
});

const observe = (
  overrides: Partial<BrowserTimelineObservedPayload> & { observedAt: string; url: string },
): BrowserTimelineObservedPayload => ({
  eventId: overrides.eventId ?? `evt-${overrides.observedAt}-${overrides.url}`,
  observedAt: overrides.observedAt,
  url: overrides.url,
  transition: overrides.transition ?? 'activated',
  ...(overrides.canonicalUrl === undefined ? {} : { canonicalUrl: overrides.canonicalUrl }),
  ...(overrides.title === undefined ? {} : { title: overrides.title }),
  ...(overrides.provider === undefined ? {} : { provider: overrides.provider }),
});

describe('POST /v1/privacy/domain-tombstone', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let close: (() => Promise<void>) | null = null;

  const BRIDGE = 'test-bridge-key';
  const MCP_BRIDGE = 'mcp-test-key-cccccccccccccccccccccccc';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-domain-tombstone-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createTimelineStore(vaultRoot);
    const runner = createSyncContractRunner();
    runner.register(createTimelineMaterializer({ store, eventLog }));
    const server = createCompanionHttpServer({
      bridgeKey: BRIDGE,
      mcpBridgeKey: MCP_BRIDGE,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
      timelineStore: store,
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
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const extHeaders = (idempotencyKey: string): Record<string, string> => ({
    'content-type': 'application/json',
    'x-bac-bridge-key': BRIDGE,
    'idempotency-key': idempotencyKey,
  });

  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<{ status: number; data: unknown }> => {
    const res = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };

  const getTimeline = async (): Promise<{ status: number; ids: string[] }> => {
    const res = await fetch(`${serverUrl}/v1/timeline`, {
      headers: { 'x-bac-bridge-key': BRIDGE },
    });
    const body = (await res.json()) as { data?: { items?: { id: string }[] } };
    return { status: res.status, ids: (body.data?.items ?? []).map((item) => item.id) };
  };

  const seedTimeline = async (): Promise<void> => {
    const events = [
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 1,
        payload: observe({
          observedAt: '2026-07-10T10:00:00.000Z',
          url: 'https://www.pge.com/en/account/billing',
          canonicalUrl: 'https://www.pge.com/en/account/billing',
          title: 'PG&E Billing',
        }),
      }),
      buildEvent({
        edgeReplicaId: 'edge_test',
        seq: 2,
        payload: observe({
          observedAt: '2026-07-10T11:00:00.000Z',
          url: 'https://example.com/docs',
          canonicalUrl: 'https://example.com/docs',
          title: 'Docs',
        }),
      }),
    ];
    await post('/v1/timeline/events', { events }, extHeaders('seed-timeline'));
    await new Promise((r) => setTimeout(r, 60));
  };

  it('hides tombstoned-domain visits from GET /v1/timeline; leaves others', async () => {
    await seedTimeline();
    const before = await getTimeline();
    expect(before.ids).toContain('https://www.pge.com/en/account/billing');
    expect(before.ids).toContain('https://example.com/docs');

    const res = await post(
      '/v1/privacy/domain-tombstone',
      { kind: 'domain', domain: 'pge.com' },
      extHeaders('tombstone-pge'),
    );
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ data: { tombstoned: true, domain: 'pge.com' } });

    const after = await getTimeline();
    expect(after.ids).not.toContain('https://www.pge.com/en/account/billing');
    expect(after.ids).toContain('https://example.com/docs');
  });

  it('normalizes a full URL / hostname to the eTLD+1', async () => {
    await seedTimeline();
    const res = await post(
      '/v1/privacy/domain-tombstone',
      { kind: 'domain', domain: 'https://www.pge.com/account' },
      extHeaders('tombstone-url'),
    );
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ data: { domain: 'pge.com' } });
    const after = await getTimeline();
    expect(after.ids).not.toContain('https://www.pge.com/en/account/billing');
  });

  it('rejects an invalid kind', async () => {
    const res = await post(
      '/v1/privacy/domain-tombstone',
      { kind: 'bogus', domain: 'pge.com' },
      extHeaders('bad-kind'),
    );
    expect(res.status).toBe(400);
  });

  it('requires auth (401 without a bridge key)', async () => {
    const res = await fetch(`${serverUrl}/v1/privacy/domain-tombstone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'noauth' },
      body: JSON.stringify({ kind: 'domain', domain: 'pge.com' }),
    });
    expect(res.status).toBe(401);
  });

  it('DENIES mcp-key callers (MCP_OPERATION_NOT_ALLOWED)', async () => {
    const res = await post(
      '/v1/privacy/domain-tombstone',
      { kind: 'domain', domain: 'pge.com' },
      {
        'content-type': 'application/json',
        'x-bac-bridge-key': MCP_BRIDGE,
        'idempotency-key': 'mcp-attempt',
      },
    );
    expect(res.status).toBe(403);
    expect(res.data).toMatchObject({ code: 'MCP_OPERATION_NOT_ALLOWED' });
  });
});
