import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { writeTrust } from '../auth/workstreamTrust.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { handleRequest, type CompanionHttpConfig } from './server.js';

// Self-contained in-memory HTTP harness so this suite runs under `bun
// test` without vi.* mocks (the shared server.test.ts harness mocks the
// embedder via vi.mock, which is incompatible with bun test).
class MemoryRequest extends Readable {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  private readonly body: Buffer;
  private consumed = false;

  constructor(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } | undefined) {
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
  private readonly headers = new Map<string, string>();

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    for (const [key, value] of Object.entries(headers)) this.headers.set(key, value);
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
  return { status: response.statusCode, body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined };
};

const readAuditLines = async (vaultRoot: string): Promise<Record<string, unknown>[]> => {
  const auditRoot = join(vaultRoot, '_BAC', 'audit');
  const names = await readdir(auditRoot).catch(() => [] as string[]);
  const lines: Record<string, unknown>[] = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
    const raw = await readFile(join(auditRoot, name), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) lines.push(JSON.parse(trimmed) as Record<string, unknown>);
    }
  }
  return lines;
};

describe('F02 MCP trust identity + audit provenance', () => {
  let vaultRoot: string;
  let bridgeKey: string;
  const mcpBridgeKey = 'mcp-test-key-aaaaaaaaaaaaaaaaaaaaaaaa';
  let context: CompanionHttpConfig;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-mcptrust-'));
    bridgeKey = (await ensureBridgeKey(vaultRoot)).key;
    context = {
      bridgeKey,
      mcpBridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
    };
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const createWorkstream = async (key: string, title: string): Promise<string> => {
    const result = await call(context, '/v1/workstreams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': key },
      body: JSON.stringify({ title }),
    });
    expect(result.status).toBe(201);
    return (result.body as { data: { bac_id: string } }).data.bac_id;
  };

  it('MCP-key caller WITHOUT a trust record is denied 403 even when the tool header is dropped', async () => {
    // Extension creates the workstream + a thread IN it (extension is exempt).
    const workstreamId = await createWorkstream(bridgeKey, 'WS');
    const thread = await call(context, '/v1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ bac_id: 'bac_th_1', provider: 'chatgpt', threadUrl: 'https://x/1', title: 'T', primaryWorkstreamId: workstreamId, lastSeenAt: '2026-07-11T00:00:00.000Z' }),
    });
    expect(thread.status).toBe(200);

    // MCP-key caller archives WITHOUT the x-sidetrack-mcp-tool header. No
    // trust record grants archive on this workstream. Pre-F02 the missing
    // header would bypass the gate; now enforcement is key-derived.
    const denied = await call(context, '/v1/threads/bac_th_1/archive', {
      method: 'POST',
      headers: { 'x-bac-bridge-key': mcpBridgeKey },
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'WORKSTREAM_NOT_TRUSTED' });
    // The 403 tells the caller HOW to grant trust (P2 modal note included).
    const detail = (denied.body as { detail?: string }).detail ?? '';
    expect(detail).toContain('/trust');
    expect(detail).toContain('P2');
  });

  it('extension-key caller is exempt from the trust gate (no record needed)', async () => {
    await createWorkstream(bridgeKey, 'WS');
    await call(context, '/v1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ bac_id: 'bac_th_x', provider: 'chatgpt', threadUrl: 'https://x/2', title: 'T2', lastSeenAt: '2026-07-11T00:00:00.000Z' }),
    });
    const archived = await call(context, '/v1/threads/bac_th_x/archive', {
      method: 'POST',
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(archived.status).toBe(200);
  });

  it('MCP-key caller passes once the workstream grants the tool', async () => {
    const workstreamId = await createWorkstream(bridgeKey, 'Trusted WS');
    await call(context, '/v1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ bac_id: 'bac_th_t', provider: 'chatgpt', threadUrl: 'https://x/3', title: 'T3', primaryWorkstreamId: workstreamId, lastSeenAt: '2026-07-11T00:00:00.000Z' }),
    });
    await writeTrust(vaultRoot, [
      { workstreamId, allowedTools: new Set(['sidetrack.threads.archive']) },
    ]);
    const archived = await call(context, '/v1/threads/bac_th_t/archive', {
      method: 'POST',
      headers: { 'x-bac-bridge-key': mcpBridgeKey },
    });
    expect(archived.status).toBe(200);
  });

  it('audit lines carry agent/tool/argsSummary/trustModeActive; extension writes record agent=extension', async () => {
    // Extension write (create).
    const workstreamId = await createWorkstream(bridgeKey, 'Audit WS');
    let lines = await readAuditLines(vaultRoot);
    const createLine = lines.find((l) => l['route'] === 'createWorkstream');
    expect(createLine).toBeDefined();
    expect(createLine?.['agent']).toBe('extension');
    expect(createLine?.['trustModeActive']).toBe(false);
    expect(typeof createLine?.['argsSummary']).toBe('string');

    // MCP-key trusted archive → agent=mcp, tool + scope + trustModeActive set.
    await call(context, '/v1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ bac_id: 'bac_th_a', provider: 'chatgpt', threadUrl: 'https://x/4', title: 'T4', primaryWorkstreamId: workstreamId, lastSeenAt: '2026-07-11T00:00:00.000Z' }),
    });
    await writeTrust(vaultRoot, [
      { workstreamId, allowedTools: new Set(['sidetrack.threads.archive']) },
    ]);
    await call(context, '/v1/threads/bac_th_a/archive', {
      method: 'POST',
      headers: { 'x-bac-bridge-key': mcpBridgeKey, 'x-sidetrack-mcp-client': 'codex' },
    });
    lines = await readAuditLines(vaultRoot);
    const archiveLine = lines.find((l) => l['route'] === 'archiveThread');
    expect(archiveLine).toBeDefined();
    expect(archiveLine?.['agent']).toBe('mcp:codex');
    expect(archiveLine?.['tool']).toBe('sidetrack.threads.archive');
    expect(archiveLine?.['scope']).toBe(workstreamId);
    expect(archiveLine?.['trustModeActive']).toBe(true);
  });

  it('old audit JSONL lines without the new fields still parse', async () => {
    // Read back via the audit route (which uses auditEventSchema). Seed a
    // legacy line lacking the F02 fields.
    const { appendFile, mkdir } = await import('node:fs/promises');
    const auditRoot = join(vaultRoot, '_BAC', 'audit');
    await mkdir(auditRoot, { recursive: true });
    const day = '2026-07-11';
    await appendFile(
      join(auditRoot, `${day}.jsonl`),
      `${JSON.stringify({ requestId: 'legacy-1', route: 'appendEvent', outcome: 'success', bac_id: 'bac_x', timestamp: `${day}T00:00:00.000Z` })}\n`,
      'utf8',
    );
    const result = await call(context, '/v1/audit?limit=50', {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(result.status).toBe(200);
    const events = (result.body as { data: Record<string, unknown>[] }).data;
    expect(events.some((e) => e['requestId'] === 'legacy-1')).toBe(true);
  });

  it('F32 new_cluster: create route works and is audited; child create is trust-gated for MCP', async () => {
    const parentId = await createWorkstream(bridgeKey, 'Parent');
    // MCP child create without trust on the parent → 403.
    const denied = await call(context, '/v1/workstreams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': mcpBridgeKey },
      body: JSON.stringify({ title: 'Child', parentId }),
    });
    expect(denied.status).toBe(403);

    // Grant create on the parent → MCP child create succeeds + audited.
    await writeTrust(vaultRoot, [
      { workstreamId: parentId, allowedTools: new Set(['sidetrack.workstreams.create']) },
    ]);
    const created = await call(context, '/v1/workstreams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': mcpBridgeKey },
      body: JSON.stringify({ title: 'Child', parentId }),
    });
    expect(created.status).toBe(201);
    const lines = await readAuditLines(vaultRoot);
    const childCreate = lines.filter((l) => l['route'] === 'createWorkstream' && l['agent'] === 'mcp');
    expect(childCreate.length).toBeGreaterThanOrEqual(1);
    expect(childCreate[0]?.['trustModeActive']).toBe(true);
  });
});

describe('§13 export route', () => {
  let vaultRoot: string;
  let bridgeKey: string;
  let context: CompanionHttpConfig;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-export-'));
    bridgeKey = (await ensureBridgeKey(vaultRoot)).key;
    context = {
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
    };
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('writes a tree-path report file OUTSIDE _BAC and returns its path; report-N increments', async () => {
    const created = await call(context, '/v1/workstreams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ title: 'My Report' }),
    });
    const workstreamId = (created.body as { data: { bac_id: string } }).data.bac_id;

    const first = await call(context, `/v1/workstreams/${workstreamId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    const firstFiles = (first.body as { data: { files: { path: string }[] } }).data.files;
    expect(firstFiles).toHaveLength(1);
    expect(firstFiles[0]?.path).toBe('My Report/My Report-report1.md');
    // Path is OUTSIDE _BAC/.
    expect(firstFiles[0]?.path.startsWith('_BAC/')).toBe(false);
    const written = await readFile(join(vaultRoot, firstFiles[0]!.path), 'utf8');
    expect(written).toContain(`bac_id: ${workstreamId}`);

    // Second export never overwrites — increments to report2.
    const second = await call(context, `/v1/workstreams/${workstreamId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({}),
    });
    const secondFiles = (second.body as { data: { files: { path: string }[] } }).data.files;
    expect(secondFiles[0]?.path).toBe('My Report/My Report-report2.md');
  });

  it('includeThreads projects the workstream threads too', async () => {
    const created = await call(context, '/v1/workstreams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ title: 'Bundle' }),
    });
    const workstreamId = (created.body as { data: { bac_id: string } }).data.bac_id;
    await call(context, '/v1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ bac_id: 'bac_th_e', provider: 'chatgpt', threadUrl: 'https://x/e', title: 'Chat One', primaryWorkstreamId: workstreamId, lastSeenAt: '2026-07-11T00:00:00.000Z' }),
    });
    const result = await call(context, `/v1/workstreams/${workstreamId}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ includeThreads: true }),
    });
    const files = (result.body as { data: { files: { path: string }[] } }).data.files;
    expect(files.length).toBe(2);
    expect(files.some((f) => f.path.includes('Chat One'))).toBe(true);
  });

  it('unreachable vault surfaces the unchanged VaultUnavailableError wire shape (503)', async () => {
    // Point the writer at a path that does not exist so ensureVaultPresent
    // throws VaultUnavailableError. The wire response must stay a 503 with
    // code VAULT_UNAVAILABLE and the legacy detail message — byte-identical
    // to the pre-typed-error behaviour.
    const missing = join(vaultRoot, 'does', 'not', 'exist');
    const brokenContext: CompanionHttpConfig = {
      bridgeKey,
      vaultWriter: createVaultWriter(missing),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
    };
    const result = await call(brokenContext, '/v1/threads/bac_missing/export', {
      method: 'POST',
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      code: 'VAULT_UNAVAILABLE',
      title: 'Vault path is unavailable.',
      detail: 'Vault path is unavailable.',
    });
  });

  it('POST /v1/threads/:id/export returns the same shape', async () => {
    await call(context, '/v1/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify({ bac_id: 'bac_th_solo', provider: 'chatgpt', threadUrl: 'https://x/solo', title: 'Solo Thread', lastSeenAt: '2026-07-11T00:00:00.000Z' }),
    });
    const result = await call(context, '/v1/threads/bac_th_solo/export', {
      method: 'POST',
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(result.status).toBe(200);
    const files = (result.body as { data: { files: { path: string }[] } }).data.files;
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe('Solo Thread-report1.md');
  });
});
