import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    bridgeKey = (await ensureBridgeKey(vaultPath)).key;
    context = {
      bridgeKey,
      vaultWriter: createVaultWriter(vaultPath),
      vaultRoot: vaultPath,
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

  it('returns default settings for a fresh vault', async () => {
    const result = await jsonFetch(context, `${baseUrl}/v1/settings`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      data: {
        // New installs default to ON for all three providers per
        // post-PR1.4 direction. The §24.10 quartet still requires
        // a per-thread toggle and not-screen-sharing before any
        // auto-send actually fires.
        autoSendOptIn: { chatgpt: true, claude: true, gemini: true },
        defaultPacketKind: 'research',
        defaultDispatchTarget: 'claude',
        screenShareSafeMode: false,
        revision: '0',
      },
    });
  });

  it('patches settings with the current revision and bumps the revision', async () => {
    const result = await jsonFetch(context, `${baseUrl}/v1/settings`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        revision: '0',
        defaultPacketKind: 'coding',
        screenShareSafeMode: true,
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      data: {
        // PATCH that doesn't touch autoSendOptIn keeps the new
        // (default-ON) baseline for any unspecified provider.
        autoSendOptIn: { chatgpt: true, claude: true, gemini: true },
        defaultPacketKind: 'coding',
        defaultDispatchTarget: 'claude',
        screenShareSafeMode: true,
        revision: '1',
      },
    });
    await expect(
      readFile(join(vaultPath, '_BAC', '.config', 'settings.json'), 'utf8'),
    ).resolves.toContain('"revision": "1"');
  });

  it('rejects stale settings revisions', async () => {
    await jsonFetch(context, `${baseUrl}/v1/settings`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ revision: '0', defaultPacketKind: 'review' }),
    });
    const stale = await jsonFetch(context, `${baseUrl}/v1/settings`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ revision: '0', defaultPacketKind: 'note' }),
    });

    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('patches one settings field without changing other defaults', async () => {
    const result = await jsonFetch(context, `${baseUrl}/v1/settings`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ revision: '0', autoSendOptIn: { chatgpt: true } }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      data: {
        // Patch only specified chatgpt: true; claude/gemini stay at
        // the new (post-PR1.4) default-ON baseline.
        autoSendOptIn: { chatgpt: true, claude: true, gemini: true },
        defaultPacketKind: 'research',
        defaultDispatchTarget: 'claude',
        screenShareSafeMode: false,
        revision: '1',
      },
    });
  });

  it('returns vault-unreachable for settings when the vault is missing', async () => {
    await rm(vaultPath, { recursive: true, force: true });

    const result = await jsonFetch(context, `${baseUrl}/v1/settings`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'VAULT_UNAVAILABLE' });
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

  it('returns recent turns for a threadUrl, deduped by ordinal newest-wins', async () => {
    const earlier = '2026-04-26T20:00:00.000Z';
    const later = '2026-04-26T22:00:00.000Z';
    const threadUrl = 'https://claude.ai/chat/turns-test';

    const post = async (capturedAt: string, idem: string, text: string, ordinal = 0) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'idempotency-key': idem,
        'x-bac-bridge-key': bridgeKey,
      };
      return jsonFetch(context, `${baseUrl}/v1/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: 'claude',
          threadUrl,
          title: 'Turns test',
          capturedAt,
          turns: [{ role: 'assistant', text, ordinal, capturedAt }],
        }),
      });
    };

    const p1 = await post(earlier, 'turns-test-001', 'first capture v1');
    const p2 = await post(later, 'turns-test-002', 'first capture v2');
    const p3 = await post(later, 'turns-test-003', 'second turn', 1);
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(201);
    expect(p3.status).toBe(201);

    const list = await jsonFetch(
      context,
      `${baseUrl}/v1/turns?threadUrl=${encodeURIComponent(threadUrl)}&limit=10`,
      { headers: { 'x-bac-bridge-key': bridgeKey } },
    );
    expect(list.status).toBe(200);
    const data = (
      list.body as { readonly data: readonly { readonly text: string; readonly ordinal: number }[] }
    ).data;
    expect(data).toHaveLength(2);
    // Both have the same capturedAt; order across ties is unspecified, but
    // dedupe semantics MUST keep the newest write for ordinal 0 (v2, not v1).
    const byOrdinal = new Map(data.map((turn) => [turn.ordinal, turn.text]));
    expect(byOrdinal.get(0)).toBe('first capture v2');
    expect(byOrdinal.get(1)).toBe('second turn');
  });

  it('rejects /v1/turns without a threadUrl query param', async () => {
    const result = await jsonFetch(context, `${baseUrl}/v1/turns`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'MISSING_PARAMETER' });
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

  it('lists audit events with limit and since filters', async () => {
    const createdAt = '2026-04-26T22:00:00.000Z';
    await jsonFetch(context, `${baseUrl}/v1/dispatches`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'dispatch-audit-list',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        kind: 'research',
        target: { provider: 'chatgpt', mode: 'paste' },
        title: 'Dispatch packet',
        body: 'Audit me',
        createdAt,
      }),
    });

    const result = await jsonFetch(
      context,
      `${baseUrl}/v1/audit?limit=1&since=2026-04-26T00:00:00.000Z`,
      { headers: { 'x-bac-bridge-key': bridgeKey } },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      data: [
        {
          route: 'recordDispatch',
          outcome: 'success',
        },
      ],
    });
  });

  it('creates and lists annotations', async () => {
    const anchor = {
      textQuote: { exact: 'hello', prefix: '', suffix: '' },
      textPosition: { start: 0, end: 5 },
      cssSelector: 'body',
    };
    const create = await jsonFetch(context, `${baseUrl}/v1/annotations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'annotation-create-001',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        url: 'https://example.test/page',
        pageTitle: 'Page',
        anchor,
        note: 'Remember this',
      }),
    });
    const list = await jsonFetch(
      context,
      `${baseUrl}/v1/annotations?url=${encodeURIComponent('https://example.test/page')}`,
      { headers: { 'x-bac-bridge-key': bridgeKey } },
    );

    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({ data: { url: 'https://example.test/page', anchor } });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      data: [{ url: 'https://example.test/page', note: 'Remember this' }],
    });
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
    // ~9000 distinct lowercase ASCII words — each is ≈1 cl100k token,
    // putting us comfortably above the 8000 warning threshold without
    // depending on the heuristic's quirks.
    const body = Array.from({ length: 9_000 }, (_, i) => `tok${String(i)}`).join(' ');
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
        body,
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

  it('records review events and lists them from the vault', async () => {
    const createdAt = '2026-04-26T23:00:00.000Z';
    const result = await jsonFetch(context, `${baseUrl}/v1/reviews`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'review-test-001',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        sourceThreadId: 'bac_thread_review_001',
        sourceTurnOrdinal: 2,
        provider: 'chatgpt',
        verdict: 'partial',
        reviewerNote: 'Needs a citation before reuse.',
        spans: [
          {
            id: 'span_001',
            text: 'The claim needs support.',
            comment: 'Ask for a primary source.',
            capturedAt: createdAt,
          },
        ],
        outcome: 'save',
        createdAt,
      }),
    });
    const list = await jsonFetch(
      context,
      `${baseUrl}/v1/reviews?limit=10&since=2026-04-26T00:00:00.000Z`,
      { headers: { 'x-bac-bridge-key': bridgeKey } },
    );

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      data: { bac_id: expect.stringMatching(/^rev_/u), status: 'recorded' },
    });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      data: [
        {
          sourceThreadId: 'bac_thread_review_001',
          sourceTurnOrdinal: 2,
          provider: 'chatgpt',
          verdict: 'partial',
          reviewerNote: 'Needs a citation before reuse.',
          outcome: 'save',
        },
      ],
    });
    const reviewLog = await readFile(
      join(vaultPath, '_BAC', 'reviews', '2026-04-26.jsonl'),
      'utf8',
    );
    expect(reviewLog).toContain('Needs a citation before reuse.');
  });

  it('replays idempotent review responses without duplicating review lines', async () => {
    const createdAt = '2026-04-26T23:01:00.000Z';
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'review-test-duplicate',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        sourceThreadId: 'bac_thread_review_002',
        sourceTurnOrdinal: 3,
        provider: 'claude',
        verdict: 'agree',
        reviewerNote: 'Only one review line.',
        spans: [],
        outcome: 'submit_back',
        createdAt,
      }),
    } satisfies RequestInit;

    const first = await jsonFetch(context, `${baseUrl}/v1/reviews`, init);
    const second = await jsonFetch(context, `${baseUrl}/v1/reviews`, init);

    expect(first).toEqual(second);
    const reviewLog = await readFile(
      join(vaultPath, '_BAC', 'reviews', '2026-04-26.jsonl'),
      'utf8',
    );
    expect(reviewLog.match(/Only one review line/g)).toHaveLength(1);
  });

  it('returns vault-unreachable for review writes when the vault is missing', async () => {
    await rm(vaultPath, { recursive: true, force: true });

    const result = await jsonFetch(context, `${baseUrl}/v1/reviews`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'review-vault-missing',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        sourceThreadId: 'bac_thread_review_003',
        sourceTurnOrdinal: 1,
        provider: 'gemini',
        verdict: 'open',
        reviewerNote: 'Record once the vault returns.',
        spans: [],
        outcome: 'dispatch_out',
      }),
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'VAULT_UNAVAILABLE' });
  });

  it('rejects invalid review schemas', async () => {
    const missingRequired = await jsonFetch(context, `${baseUrl}/v1/reviews`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'review-schema-missing',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        sourceTurnOrdinal: 1,
        provider: 'unknown',
        verdict: 'open',
        reviewerNote: 'Missing source thread.',
        spans: [],
        outcome: 'save',
      }),
    });
    const badVerdict = await jsonFetch(context, `${baseUrl}/v1/reviews`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'review-schema-bad-verdict',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        sourceThreadId: 'bac_thread_review_004',
        sourceTurnOrdinal: 1,
        provider: 'unknown',
        verdict: 'unsupported',
        reviewerNote: 'Bad verdict enum.',
        spans: [],
        outcome: 'save',
      }),
    });

    expect(missingRequired.status).toBe(400);
    expect(missingRequired.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(badVerdict.status).toBe(400);
    expect(badVerdict.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('filters review listings by source thread id', async () => {
    const first = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'review-filter-001',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        sourceThreadId: 'bac_thread_filter_a',
        sourceTurnOrdinal: 1,
        provider: 'chatgpt',
        verdict: 'needs_source',
        reviewerNote: 'Filter A',
        spans: [],
        outcome: 'save',
        createdAt: '2026-04-26T23:02:00.000Z',
      }),
    } satisfies RequestInit;
    const second = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'review-filter-002',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        sourceThreadId: 'bac_thread_filter_b',
        sourceTurnOrdinal: 1,
        provider: 'chatgpt',
        verdict: 'open',
        reviewerNote: 'Filter B',
        spans: [],
        outcome: 'save',
        createdAt: '2026-04-26T23:03:00.000Z',
      }),
    } satisfies RequestInit;

    await jsonFetch(context, `${baseUrl}/v1/reviews`, first);
    await jsonFetch(context, `${baseUrl}/v1/reviews`, second);
    const list = await jsonFetch(context, `${baseUrl}/v1/reviews?threadId=bac_thread_filter_a`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });

    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      data: [{ sourceThreadId: 'bac_thread_filter_a', reviewerNote: 'Filter A' }],
    });
    expect(JSON.stringify(list.body)).not.toContain('Filter B');
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

  it('defaults new workstreams to shared and supports screenshare-sensitive metadata', async () => {
    const workstreamResult = await jsonFetch(context, `${baseUrl}/v1/workstreams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ title: 'Default shared' }),
    });
    expect(workstreamResult.status).toBe(201);
    const workstreamId = (workstreamResult.body as { readonly data: { readonly bac_id: string } })
      .data.bac_id;
    const json = JSON.parse(
      await readFile(join(vaultPath, '_BAC', 'workstreams', `${workstreamId}.json`), 'utf8'),
    ) as { readonly privacy?: string; readonly screenShareSensitive?: boolean };
    expect(json.privacy).toBe('shared');
    expect(json.screenShareSensitive).toBe(false);

    const updateResult = await jsonFetch(context, `${baseUrl}/v1/workstreams/${workstreamId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        revision: (workstreamResult.body as { readonly data: { readonly revision: string } }).data
          .revision,
        screenShareSensitive: true,
      }),
    });
    expect(updateResult.status).toBe(200);
    const updated = JSON.parse(
      await readFile(join(vaultPath, '_BAC', 'workstreams', `${workstreamId}.json`), 'utf8'),
    ) as { readonly privacy?: string; readonly screenShareSensitive?: boolean };
    expect(updated.privacy).toBe('shared');
    expect(updated.screenShareSensitive).toBe(true);
  });

  it('lists human-authored notes linked to a workstream', async () => {
    const workstreamResult = await jsonFetch(context, `${baseUrl}/v1/workstreams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ title: 'Linked notes' }),
    });
    const workstreamId = (workstreamResult.body as { readonly data: { readonly bac_id: string } })
      .data.bac_id;
    await writeFile(
      join(vaultPath, 'research.md'),
      `---\ntitle: Human note\nbac_workstream: ${workstreamId}\n---\n\nThe body is not parsed.`,
      'utf8',
    );

    const result = await jsonFetch(
      context,
      `${baseUrl}/v1/workstreams/${workstreamId}/linked-notes`,
      { headers: { 'x-bac-bridge-key': bridgeKey } },
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      items: [{ workstreamId, notePath: 'research.md', title: 'Human note' }],
    });
  });

  it('writes rich promoted-thread Markdown once and preserves later projections', async () => {
    const now = '2026-04-30T21:32:00.000Z';
    await jsonFetch(context, `${baseUrl}/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'promote-capture-001',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        provider: 'claude',
        threadUrl: 'https://claude.ai/chat/promote-test',
        title: 'Promote me',
        capturedAt: now,
        turns: [
          { role: 'user', text: 'Please make a plan.', ordinal: 0, capturedAt: now },
          { role: 'assistant', text: 'First, write the projection.', ordinal: 1, capturedAt: now },
        ],
      }),
    });
    await jsonFetch(context, `${baseUrl}/v1/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        bac_id: 'bac_thread_promote',
        provider: 'claude',
        threadUrl: 'https://claude.ai/chat/promote-test',
        title: 'Promote me',
        lastSeenAt: now,
      }),
    });
    const workstreamResult = await jsonFetch(context, `${baseUrl}/v1/workstreams`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({ title: 'M2 polish', privacy: 'private' }),
    });
    const workstreamId = (workstreamResult.body as { readonly data: { readonly bac_id: string } })
      .data.bac_id;

    await jsonFetch(context, `${baseUrl}/v1/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        bac_id: 'bac_thread_promote',
        provider: 'claude',
        threadUrl: 'https://claude.ai/chat/promote-test',
        title: 'Promote me',
        lastSeenAt: now,
        primaryWorkstreamId: workstreamId,
      }),
    });

    const markdownPath = join(vaultPath, '_BAC', 'threads', 'bac_thread_promote.md');
    const promoted = await readFile(markdownPath, 'utf8');
    expect(promoted).toContain('Promoted to M2 polish on');
    expect(promoted).toContain('### User');
    expect(promoted).toContain('Please make a plan.');
    expect(promoted).toContain('### Assistant');
    expect(promoted).toContain('First, write the projection.');

    await jsonFetch(context, `${baseUrl}/v1/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        bac_id: 'bac_thread_promote',
        provider: 'claude',
        threadUrl: 'https://claude.ai/chat/promote-test',
        title: 'Promote me again',
        lastSeenAt: now,
        primaryWorkstreamId: workstreamId,
      }),
    });
    await expect(readFile(markdownPath, 'utf8')).resolves.toBe(promoted);
  });

  it('does not overwrite locked thread Markdown sidecars', async () => {
    const now = '2026-04-30T21:40:00.000Z';
    const markdownPath = join(vaultPath, '_BAC', 'threads', 'bac_thread_locked.md');
    await mkdir(join(vaultPath, '_BAC', 'threads'), { recursive: true });
    await writeFile(
      markdownPath,
      '---\nbac_id: bac_thread_locked\nbac_locked: true\n---\n# Hand edited\n',
      'utf8',
    );

    const result = await jsonFetch(context, `${baseUrl}/v1/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        bac_id: 'bac_thread_locked',
        provider: 'claude',
        threadUrl: 'https://claude.ai/chat/locked',
        title: 'Machine update',
        lastSeenAt: now,
      }),
    });

    expect(result.status).toBe(200);
    await expect(readFile(markdownPath, 'utf8')).resolves.toContain('# Hand edited');
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

  it('mints an attach token, registers a coding session, lists, then detaches', async () => {
    const tokenResponse = await jsonFetch(context, `${baseUrl}/v1/coding-sessions/attach-tokens`, {
      method: 'POST',
      headers: { 'x-bac-bridge-key': bridgeKey, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(tokenResponse.status).toBe(201);
    const token = (
      tokenResponse.body as {
        readonly data: { readonly token: string; readonly expiresAt: string };
      }
    ).data.token;
    expect(token.length).toBeGreaterThan(0);

    // Listing while the token is unused returns []; the token survives to be
    // matched by the agent's register call.
    const listWhilePending = await jsonFetch(
      context,
      `${baseUrl}/v1/coding-sessions?token=${encodeURIComponent(token)}`,
      { headers: { 'x-bac-bridge-key': bridgeKey } },
    );
    expect(listWhilePending.status).toBe(200);
    expect((listWhilePending.body as { readonly data: unknown[] }).data).toHaveLength(0);

    const registerResponse = await jsonFetch(context, `${baseUrl}/v1/coding-sessions`, {
      method: 'POST',
      headers: { 'x-bac-bridge-key': bridgeKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        tool: 'claude_code',
        cwd: '/Users/test/repo',
        branch: 'main',
        sessionId: 'session-abc-123',
        name: 'claude-code · main',
      }),
    });
    expect(registerResponse.status).toBe(201);
    const registered = (registerResponse.body as { readonly data: { readonly bac_id: string } })
      .data;
    expect(registered.bac_id).toMatch(/^[A-Za-z0-9_-]+$/u);

    // Reusing the token must fail since it was consumed by the register call.
    const reuseResponse = await jsonFetch(context, `${baseUrl}/v1/coding-sessions`, {
      method: 'POST',
      headers: { 'x-bac-bridge-key': bridgeKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        tool: 'claude_code',
        cwd: '/Users/test/repo',
        branch: 'main',
        sessionId: 'session-abc-456',
        name: 'duplicate',
      }),
    });
    expect(reuseResponse.status).toBe(410);

    const list = await jsonFetch(context, `${baseUrl}/v1/coding-sessions`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(list.status).toBe(200);
    const sessions = (list.body as { readonly data: { readonly bac_id: string }[] }).data;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.bac_id).toBe(registered.bac_id);

    const detach = await jsonFetch(context, `${baseUrl}/v1/coding-sessions/${registered.bac_id}`, {
      method: 'DELETE',
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(detach.status).toBe(200);
    expect((detach.body as { readonly data: { readonly status: string } }).data.status).toBe(
      'detached',
    );
  });
});
