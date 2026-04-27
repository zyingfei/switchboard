import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer, type StartedHttpServer } from './server.js';

const jsonFetch = async (
  url: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await fetch(url, init);
  const body = (await response.json()) as unknown;
  return { status: response.status, body };
};

describe('companion HTTP server', () => {
  let vaultPath: string;
  let bridgeKey: string;
  let server: StartedHttpServer;

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-companion-test-'));
    bridgeKey = await ensureBridgeKey(vaultPath);
    server = await startHttpServer(
      createCompanionHttpServer({
        bridgeKey,
        vaultWriter: createVaultWriter(vaultPath),
        idempotencyStore: createIdempotencyStore(vaultPath),
      }),
      0,
    );
  });

  afterEach(async () => {
    await server.close();
  });

  it('serves unauthenticated health', async () => {
    const result = await jsonFetch(`${server.url}/v1/health`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'ok' });
  });

  it('rejects state routes without bridge key auth', async () => {
    const result = await jsonFetch(`${server.url}/v1/status`);

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('surfaces vault-unreachable status without accepting writes', async () => {
    await rm(vaultPath, { recursive: true, force: true });

    const status = await jsonFetch(`${server.url}/v1/status`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    const capturedAt = '2026-04-26T21:29:00.000Z';
    const write = await jsonFetch(`${server.url}/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'capture-vault-missing',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        provider: 'unknown',
        threadUrl: 'https://example.com',
        title: 'Missing vault',
        capturedAt,
        turns: [],
      }),
    });

    expect(status.body).toMatchObject({ data: { vault: 'unreachable' } });
    expect(write.status).toBe(503);
    expect(write.body).toMatchObject({ code: 'VAULT_UNAVAILABLE' });
  });

  it('accepts extension CORS preflight requests', async () => {
    const response = await fetch(`${server.url}/v1/events`, {
      method: 'OPTIONS',
      headers: {
        origin: 'chrome-extension://sidetrack-test',
        'access-control-request-headers': 'content-type,x-bac-bridge-key,idempotency-key',
        'access-control-request-method': 'POST',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-headers')).toContain('idempotency-key');
  });

  it('appends capture events and audit records to the vault', async () => {
    const capturedAt = '2026-04-26T21:30:00.000Z';
    const result = await jsonFetch(`${server.url}/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'capture-test-001',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        provider: 'chatgpt',
        threadUrl: 'https://chatgpt.com/c/thread',
        title: 'Test thread',
        capturedAt,
        extractionConfigVersion: 'test-config',
        visibleTextCharCount: 17,
        tabSnapshot: {
          tabId: 10,
          windowId: 20,
          url: 'https://chatgpt.com/c/thread',
          title: 'Test thread',
          capturedAt,
        },
        turns: [
          {
            role: 'assistant',
            text: 'Captured locally.',
            formattedText: '**Captured locally.**',
            ordinal: 0,
            capturedAt,
            sourceSelector: 'main [data-message-author-role]',
          },
        ],
      }),
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ data: { requestId: expect.stringContaining('req_') } });

    const eventLog = await readFile(join(vaultPath, '_BAC', 'events', '2026-04-26.jsonl'), 'utf8');
    expect(eventLog).toContain('Captured locally.');

    // Audit timestamp uses Date.now() (not the input's capturedAt), so the
    // file lives at today's UTC date — compute it here to avoid a flaky
    // test when the local clock is past UTC midnight on the day of the
    // capturedAt fixture.
    const auditDate = new Date().toISOString().slice(0, 10);
    const auditLog = await readFile(join(vaultPath, '_BAC', 'audit', `${auditDate}.jsonl`), 'utf8');
    expect(auditLog).toContain('appendEvent');
  });

  it('replays idempotent event responses without duplicating event lines', async () => {
    const capturedAt = '2026-04-26T21:31:00.000Z';
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'capture-test-duplicate',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        provider: 'claude',
        threadUrl: 'https://claude.ai/chat/thread',
        title: 'Duplicate test',
        capturedAt,
        turns: [{ role: 'assistant', text: 'Only once.', ordinal: 0, capturedAt }],
      }),
    } satisfies RequestInit;

    const first = await jsonFetch(`${server.url}/v1/events`, init);
    const second = await jsonFetch(`${server.url}/v1/events`, init);

    expect(first).toEqual(second);
    const eventLog = await readFile(join(vaultPath, '_BAC', 'events', '2026-04-26.jsonl'), 'utf8');
    expect(eventLog.match(/Only once/g)).toHaveLength(1);
  });

  it('writes thread, workstream, queue, and reminder indexes', async () => {
    const now = '2026-04-26T21:32:00.000Z';
    const threadResult = await jsonFetch(`${server.url}/v1/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        bac_id: 'bac_thread_test',
        provider: 'gemini',
        threadUrl: 'https://gemini.google.com/app/thread',
        title: 'Gemini plan',
        lastSeenAt: now,
        status: 'active',
        trackingMode: 'auto',
        tags: ['architecture'],
      }),
    });
    const workstreamResult = await jsonFetch(`${server.url}/v1/workstreams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ title: 'Sidetrack', privacy: 'private', tags: ['m1'] }),
    });
    const queueResult = await jsonFetch(`${server.url}/v1/queue`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'queue-test-001',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        text: 'Ask Claude to compare with VM live migration',
        scope: 'thread',
        targetId: 'bac_thread_test',
      }),
    });
    const reminderResult = await jsonFetch(`${server.url}/v1/reminders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ threadId: 'bac_thread_test', provider: 'claude', detectedAt: now }),
    });

    expect(threadResult.status).toBe(200);
    expect(workstreamResult.status).toBe(201);
    expect(queueResult.status).toBe(201);
    expect(reminderResult.status).toBe(201);
    await expect(
      readFile(join(vaultPath, '_BAC', 'threads', 'bac_thread_test.json'), 'utf8'),
    ).resolves.toContain('Gemini plan');
    const workstreamId = (workstreamResult.body as { readonly data: { readonly bac_id: string } })
      .data.bac_id;
    await expect(
      readFile(join(vaultPath, '_BAC', 'workstreams', `${workstreamId}.json`), 'utf8'),
    ).resolves.toContain('Sidetrack');
  });
});
