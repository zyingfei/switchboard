import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot, ConnectionsStore } from '../connections/snapshot.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('§15 falsifiability HTTP routes', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let currentConnectionsSnapshot: ConnectionsSnapshot | null = null;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'section15-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-section15-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    const connectionsStore = {
      putCurrent: async (snapshot: ConnectionsSnapshot) => {
        currentConnectionsSnapshot = snapshot;
      },
      readCurrent: async () => currentConnectionsSnapshot,
      putDay: async () => undefined,
      readDay: async () => null,
      listDays: async () => [],
    } as unknown as ConnectionsStore;
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

  it('GET /v1/system/section15 serves the six-criterion table (live fallback)', async () => {
    const response = await fetch(`${serverUrl}/v1/system/section15`, { headers: headers() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly data: {
        readonly availability: string;
        readonly report: {
          readonly criteria: readonly { readonly id: string; readonly met: boolean }[];
          readonly freezeLiftEligible: boolean;
        };
      };
    };
    expect(body.data.availability).toBe('live');
    expect(body.data.report.criteria.map((c) => c.id).sort()).toEqual(
      [
        'consecutiveCleanDays',
        'losslessReorgs',
        'mcpContextPackSessions',
        'packetsDispatched',
        'tabRecoveries',
        'trackedSessionsFraction',
      ].sort(),
    );
    // Empty vault ⇒ nothing met, not eligible.
    expect(body.data.report.freezeLiftEligible).toBe(false);
    expect(body.data.report.criteria.find((c) => c.id === 'tabRecoveries')?.met).toBe(false);
  });

  it('POST /v1/system/tab-recovery persists a restore that the counter then reads', async () => {
    const post = await fetch(`${serverUrl}/v1/system/tab-recovery`, {
      method: 'POST',
      headers: headers('recovery-1'),
      body: JSON.stringify({
        payloadVersion: 1,
        sessionId: 'chrome-sess-1',
        matchedOn: 'url+title',
        threadId: 'thread-1',
      }),
    });
    expect(post.status).toBe(201);

    const get = await fetch(`${serverUrl}/v1/system/section15`, { headers: headers() });
    const body = (await get.json()) as {
      readonly data: {
        readonly report: {
          readonly criteria: readonly { readonly id: string; readonly value: number; readonly met: boolean }[];
        };
      };
    };
    const recovery = body.data.report.criteria.find((c) => c.id === 'tabRecoveries');
    expect(recovery?.value).toBe(1);
    expect(recovery?.met).toBe(true);
  });

  it('POST /v1/system/tab-recovery rejects a malformed payload', async () => {
    const post = await fetch(`${serverUrl}/v1/system/tab-recovery`, {
      method: 'POST',
      headers: headers('recovery-bad'),
      body: JSON.stringify({ payloadVersion: 1, matchedOn: 'nonsense' }),
    });
    expect(post.status).toBe(400);
  });

  it('GET /v1/system/section15 requires auth', async () => {
    const response = await fetch(`${serverUrl}/v1/system/section15`);
    expect(response.status).toBe(401);
  });
});
