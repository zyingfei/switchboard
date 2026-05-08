import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { USER_FLOW_CONFIRMED } from '../feedback/events.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('feedback HTTP routes', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'feedback-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-feedback-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
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

  const post = async (
    body: unknown,
    idempotencyKey: string,
  ): Promise<{ readonly status: number; readonly body: unknown }> => {
    const response = await fetch(`${serverUrl}/v1/feedback/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  it('appends valid S23 feedback events to the event log', async () => {
    const result = await post(
      {
        type: USER_FLOW_CONFIRMED,
        payload: {
          payloadVersion: 1,
          relationKind: 'visit_resembles_visit',
          fromId: 'visit:a',
          toId: 'visit:b',
        },
      },
      'feedback-route-test',
    );

    expect(result.status).toBe(201);
    await expect(eventLog.readMerged()).resolves.toMatchObject([
      {
        type: USER_FLOW_CONFIRMED,
        aggregateId: 'feedback:flow:visit_resembles_visit:visit:a:visit:b',
        payload: {
          payloadVersion: 1,
          relationKind: 'visit_resembles_visit',
          fromId: 'visit:a',
          toId: 'visit:b',
        },
      },
    ]);
  });

  it('returns the feedback projection with training labels', async () => {
    await post(
      {
        type: USER_FLOW_CONFIRMED,
        payload: {
          payloadVersion: 1,
          relationKind: 'closest_visit',
          fromId: 'timeline-visit:a',
          toId: 'timeline-visit:b',
        },
      },
      'feedback-projection-route-test',
    );

    const response = await fetch(`${serverUrl}/v1/feedback/projection`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        positiveLabels: { fromId: string; toId: string; weight: number }[];
        negativeLabels: { fromId: string; toId: string; weight: number }[];
      };
    };
    expect(body.data.positiveLabels).toEqual([
      { fromId: 'timeline-visit:a', toId: 'timeline-visit:b', weight: 1 },
    ]);
    expect(body.data.negativeLabels).toEqual([]);
  });

  it('rejects malformed feedback event payloads', async () => {
    const result = await post(
      {
        type: USER_FLOW_CONFIRMED,
        payload: { payloadVersion: 1, relationKind: 'visit_resembles_visit' },
      },
      'feedback-route-invalid',
    );

    expect(result.status).toBe(400);
    await expect(eventLog.readMerged()).resolves.toEqual([]);
  });
});
