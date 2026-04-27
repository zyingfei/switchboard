import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { handleRequest, type CompanionHttpConfig } from './server.js';

const jsonFetch = async (
  context: CompanionHttpConfig,
  url: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await memoryFetch(context, url, init);
  return {
    status: response.status,
    body: JSON.parse(response.bodyText) as unknown,
  };
};

interface MemoryResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
}

class MemoryRequest extends Readable {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  private readonly body: Buffer;
  private consumed = false;

  constructor(url: string, init: RequestInit | undefined) {
    super();
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    if (!headers.has('host')) {
      headers.set('host', parsed.host);
    }

    const incomingHeaders: IncomingHttpHeaders = {};
    headers.forEach((value, key) => {
      incomingHeaders[key] = value;
    });

    this.method = init?.method ?? 'GET';
    this.url = `${parsed.pathname}${parsed.search}`;
    this.headers = incomingHeaders;
    this.body = Buffer.from(typeof init?.body === 'string' ? init.body : '');
  }

  override _read(): void {
    if (this.consumed) {
      return;
    }
    this.consumed = true;
    if (this.body.length > 0) {
      this.push(this.body);
    }
    this.push(null);
  }
}

class MemoryServerResponse {
  readonly headers = new Headers();
  statusCode = 200;
  private body = '';

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    for (const [key, value] of Object.entries(headers)) {
      this.headers.set(key, value);
    }
    return this;
  }

  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) {
      this.body += chunk.toString();
    }
  }

  text(): string {
    return this.body;
  }
}

const memoryFetch = async (
  context: CompanionHttpConfig,
  url: string,
  init?: RequestInit,
): Promise<MemoryResponse> => {
  const request = new MemoryRequest(url, init);
  const response = new MemoryServerResponse();

  await handleRequest(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    context,
  );

  return { status: response.statusCode, headers: response.headers, bodyText: response.text() };
};

describe('companion HTTP server', () => {
  let vaultPath: string;
  let bridgeKey: string;
  let context: CompanionHttpConfig;
  const baseUrl = 'http://127.0.0.1';

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-companion-test-'));
    bridgeKey = await ensureBridgeKey(vaultPath);
    context = {
      bridgeKey,
      vaultWriter: createVaultWriter(vaultPath),
      idempotencyStore: createIdempotencyStore(vaultPath),
    };
  });

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true });
  });

  it('serves unauthenticated health', async () => {
    const result = await jsonFetch(context, `${baseUrl}/v1/health`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'ok' });
  });

  it('rejects state routes without bridge key auth', async () => {
    const result = await jsonFetch(context, `${baseUrl}/v1/status`);

    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('surfaces vault-unreachable status without accepting writes', async () => {
    await rm(vaultPath, { recursive: true, force: true });

    const status = await jsonFetch(context, `${baseUrl}/v1/status`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    const capturedAt = '2026-04-26T21:29:00.000Z';
    const write = await jsonFetch(context, `${baseUrl}/v1/events`, {
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
    const response = await memoryFetch(context, `${baseUrl}/v1/events`, {
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
    const result = await jsonFetch(context, `${baseUrl}/v1/events`, {
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

    const first = await jsonFetch(context, `${baseUrl}/v1/events`, init);
    const second = await jsonFetch(context, `${baseUrl}/v1/events`, init);

    expect(first).toEqual(second);
    const eventLog = await readFile(join(vaultPath, '_BAC', 'events', '2026-04-26.jsonl'), 'utf8');
    expect(eventLog.match(/Only once/g)).toHaveLength(1);
  });

  it('records redacted dispatches and lists recent dispatches', async () => {
    const createdAt = '2026-04-26T22:00:00.000Z';
    const githubToken = `ghp_${'a'.repeat(36)}`;
    const result = await jsonFetch(context, `${baseUrl}/v1/dispatches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'dispatch-test-001',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        kind: 'research',
        target: { provider: 'chatgpt', mode: 'paste' },
        title: 'Dispatch packet',
        body: `Email owner@example.com and token ${githubToken}`,
        createdAt,
      }),
    });
    const list = await jsonFetch(
      context,
      `${baseUrl}/v1/dispatches?limit=10&since=2026-04-26T00:00:00.000Z`,
      { headers: { 'x-bac-bridge-key': bridgeKey } },
    );

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      data: { bac_id: expect.stringMatching(/^disp_/u), status: 'recorded' },
    });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      data: [
        {
          kind: 'research',
          target: { provider: 'chatgpt', mode: 'paste' },
          body: 'Email [email] and token [github-token]',
          redactionSummary: { matched: 2, categories: ['github-token', 'email'] },
          tokenEstimate: 10,
          status: 'sent',
        },
      ],
    });
    const dispatchLog = await readFile(
      join(vaultPath, '_BAC', 'dispatches', '2026-04-26.jsonl'),
      'utf8',
    );
    expect(dispatchLog).not.toContain(githubToken);
    expect(dispatchLog).not.toContain('owner@example.com');
  });

  it('replays idempotent dispatch responses without duplicating dispatch lines', async () => {
    const createdAt = '2026-04-26T22:01:00.000Z';
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'dispatch-test-duplicate',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        kind: 'coding',
        target: { provider: 'codex', mode: 'paste' },
        title: 'Idempotent dispatch',
        body: 'Only one dispatch line.',
        createdAt,
      }),
    } satisfies RequestInit;

    const first = await jsonFetch(context, `${baseUrl}/v1/dispatches`, init);
    const second = await jsonFetch(context, `${baseUrl}/v1/dispatches`, init);

    expect(first).toEqual(second);
    const dispatchLog = await readFile(
      join(vaultPath, '_BAC', 'dispatches', '2026-04-26.jsonl'),
      'utf8',
    );
    expect(dispatchLog.match(/Only one dispatch line/g)).toHaveLength(1);
  });

  it('returns a token budget warning for oversized dispatches', async () => {
    const result = await jsonFetch(context, `${baseUrl}/v1/dispatches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'dispatch-test-token-budget',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        kind: 'other',
        target: { provider: 'other', mode: 'paste' },
        title: 'Large dispatch',
        body: 'a'.repeat(32_001),
      }),
    });

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ warnings: ['token-budget-exceeded'] });
  });

  it('returns vault-unreachable for dispatch writes when the vault is missing', async () => {
    await rm(vaultPath, { recursive: true, force: true });

    const result = await jsonFetch(context, `${baseUrl}/v1/dispatches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'dispatch-vault-missing',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        kind: 'note',
        target: { provider: 'claude', mode: 'paste' },
        title: 'Missing vault dispatch',
        body: 'Record this later.',
      }),
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'VAULT_UNAVAILABLE' });
  });

  it('rejects invalid dispatch schemas', async () => {
    const result = await jsonFetch(context, `${baseUrl}/v1/dispatches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'dispatch-schema-invalid',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        kind: 'research',
        target: { provider: 'chatgpt', mode: 'paste' },
        title: 'Invalid dispatch',
      }),
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('writes thread, workstream, queue, and reminder indexes', async () => {
    const now = '2026-04-26T21:32:00.000Z';
    const threadResult = await jsonFetch(context, `${baseUrl}/v1/threads`, {
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
    const workstreamResult = await jsonFetch(context, `${baseUrl}/v1/workstreams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ title: 'Sidetrack', privacy: 'private', tags: ['m1'] }),
    });
    const queueResult = await jsonFetch(context, `${baseUrl}/v1/queue`, {
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
    const reminderResult = await jsonFetch(context, `${baseUrl}/v1/reminders`, {
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

  it('updates workstream checklist fields and reminder status', async () => {
    const now = '2026-04-26T21:33:00.000Z';
    const workstreamResult = await jsonFetch(context, `${baseUrl}/v1/workstreams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ title: 'Sidetrack', privacy: 'private' }),
    });
    const workstreamId = (workstreamResult.body as { readonly data: { readonly bac_id: string } })
      .data.bac_id;
    const revision = (workstreamResult.body as { readonly data: { readonly revision: string } })
      .data.revision;
    const checklistUpdate = await jsonFetch(context, `${baseUrl}/v1/workstreams/${workstreamId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        revision,
        checklist: [
          {
            id: 'check_1',
            text: 'Verify side panel wiring',
            checked: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    });
    const reminderResult = await jsonFetch(context, `${baseUrl}/v1/reminders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ threadId: 'bac_thread_test', provider: 'claude', detectedAt: now }),
    });
    const reminderId = (reminderResult.body as { readonly data: { readonly bac_id: string } }).data
      .bac_id;
    const reminderUpdate = await jsonFetch(context, `${baseUrl}/v1/reminders/${reminderId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ status: 'relevant' }),
    });

    expect(checklistUpdate.status).toBe(200);
    expect(reminderUpdate.status).toBe(200);
    await expect(
      readFile(join(vaultPath, '_BAC', 'workstreams', `${workstreamId}.json`), 'utf8'),
    ).resolves.toContain('Verify side panel wiring');
    await expect(
      readFile(join(vaultPath, '_BAC', 'reminders', `${reminderId}.json`), 'utf8'),
    ).resolves.toContain('relevant');
  });
});
