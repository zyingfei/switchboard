import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { USER_REJECTED_RELATION } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { handleRequest, type CompanionHttpConfig } from './server.js';

// Self-contained in-memory HTTP harness (no vi.* mocks — vi.mock leaks
// process-globally under bun test). Mirrors mcpTrustAndExport.test.ts.
class MemoryRequest extends Readable {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  private readonly body: Buffer;
  private consumed = false;

  constructor(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } | undefined,
  ) {
    super();
    const parsed = new URL(url);
    const headers: IncomingHttpHeaders = { host: parsed.host };
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    this.method = init?.method ?? 'GET';
    this.url = `${parsed.pathname}${parsed.search}`;
    this.headers = headers;
    this.body = Buffer.from(init?.body ?? '');
  }

  override _read(): void {
    if (this.consumed) return;
    this.consumed = true;
    if (this.body.length > 0) this.push(this.body);
    this.push(null);
  }
}

class MemoryResponse {
  statusCode = 200;
  private body = '';

  writeHead(status: number, _headers: Record<string, string>): this {
    this.statusCode = status;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.body += chunk.toString();
    return true;
  }

  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.body += chunk.toString();
  }

  text(): string {
    return this.body;
  }
}

const baseUrl = 'http://127.0.0.1';

const call = async (
  context: CompanionHttpConfig,
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: unknown }> => {
  const request = new MemoryRequest(`${baseUrl}${path}`, init);
  const response = new MemoryResponse();
  await handleRequest(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    context,
  );
  const text = response.text();
  return {
    status: response.statusCode,
    body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined,
  };
};

describe('USER_REJECTED_RELATION channel (Move 2b)', () => {
  let vaultRoot: string;
  let bridgeKey: string;
  const mcpBridgeKey = 'mcp-test-key-bbbbbbbbbbbbbbbbbbbbbbbb';
  let context: CompanionHttpConfig;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-rejrel-'));
    bridgeKey = (await ensureBridgeKey(vaultRoot)).key;
    const replica = await loadOrCreateReplica(vaultRoot);
    context = {
      bridgeKey,
      mcpBridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      eventLog: createEventLog(vaultRoot, replica),
    };
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const body = JSON.stringify({
    type: USER_REJECTED_RELATION,
    payload: {
      payloadVersion: 1,
      fromRef: 'https://example.test/a',
      toRef: 'https://example.test/b',
      surface: 'connections',
      reason: 'not-related',
    },
  });

  it('persists a rejected-relation event through the feedback writer (extension key)', async () => {
    const result = await call(context, '/v1/feedback/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'reject-relation-1',
        'x-bac-bridge-key': bridgeKey,
      },
      body,
    });
    expect(result.status).toBe(201);

    // The event is durably in the log with its payload intact.
    const merged = (await context.eventLog!.readMerged()) as readonly AcceptedEvent[];
    const stored = merged.filter((event) => event.type === USER_REJECTED_RELATION);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload).toMatchObject({
      fromRef: 'https://example.test/a',
      toRef: 'https://example.test/b',
      surface: 'connections',
      reason: 'not-related',
    });
    // Aggregate is keyed on the unordered page pair.
    expect(stored[0]?.aggregateId).toBe(
      'feedback:rejected-relation:https://example.test/a:https://example.test/b',
    );
  });

  it('rejects a structurally invalid payload with 400', async () => {
    const result = await call(context, '/v1/feedback/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'reject-relation-bad',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify({
        type: USER_REJECTED_RELATION,
        payload: { payloadVersion: 1, fromRef: 'x', toRef: 'y', surface: 'nowhere' },
      }),
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('is MCP-denied by default (not a sanctioned mutating route)', async () => {
    const denied = await call(context, '/v1/feedback/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'reject-relation-mcp',
        'x-bac-bridge-key': mcpBridgeKey,
      },
      body,
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'MCP_OPERATION_NOT_ALLOWED' });

    // And nothing was written — the deny is at the dispatch layer, pre-handler.
    const merged = (await context.eventLog!.readMerged()) as readonly AcceptedEvent[];
    expect(merged.filter((event) => event.type === USER_REJECTED_RELATION)).toHaveLength(0);
  });
});
