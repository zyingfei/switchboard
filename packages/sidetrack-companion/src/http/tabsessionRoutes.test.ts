import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
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
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'tabsession-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-tabsession-http-'));
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

  const headers = (idempotencyKey?: string): Record<string, string> => ({
    'content-type': 'application/json',
    'x-bac-bridge-key': bridgeKey,
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
  });

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

  it('returns unattributed and null-attributed sessions in the inbox', async () => {
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

    const response = await fetch(`${serverUrl}/v1/tabsessions/inbox?limit=10&offset=0`, {
      headers: headers(),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly data?: { readonly items?: readonly { readonly tabSessionId: string }[] };
    };
    expect(body.data?.items?.map((item) => item.tabSessionId)).toEqual(['tses_a']);
  });
});
