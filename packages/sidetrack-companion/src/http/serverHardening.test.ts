import { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { createVaultWriter } from '../vault/writer.js';
import { VaultUnavailableError } from './errors.js';
import { createIdempotencyStore } from './idempotency.js';
import { handleRequest, type CompanionHttpConfig } from './server.js';

// Minimal in-memory request/response pair mirroring the harness in
// server.test.ts — drives handleRequest directly, no real socket, so
// the live companion on :17374 is never touched.
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
    // The extension always sends an Origin; default to a loopback one so
    // the loopback gate passes and we exercise the auth path, not the
    // origin path (which has its own dedicated case below).
    if (!headers.has('origin')) {
      headers.set('origin', 'http://127.0.0.1');
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

  write(chunk: string | Buffer): boolean {
    this.body += chunk.toString();
    return true;
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

const call = async (
  context: CompanionHttpConfig,
  url: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const request = new MemoryRequest(url, init);
  const response = new MemoryServerResponse();
  await handleRequest(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    context,
  );
  const text = response.text();
  return { status: response.statusCode, body: text.length > 0 ? (JSON.parse(text) as unknown) : {} };
};

describe('companion HTTP server hardening (F30/F29)', () => {
  let vaultPath: string;
  let bridgeKey: string;
  let context: CompanionHttpConfig;
  const baseUrl = 'http://127.0.0.1';

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-hardening-test-'));
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

  it('serves the public allowlist without a bridge key', async () => {
    for (const path of ['/v1/health', '/v1/version']) {
      const result = await call(context, `${baseUrl}${path}`);
      expect(result.status).toBe(200);
    }
  });

  it('rejects an unauthenticated debug/heap-dump route with the auth error, not a 404', async () => {
    // DEBUG_HEAP_SNAPSHOT is unset here, so /debug/heap-snapshot is not
    // even a registered route — an unauthenticated caller must still get
    // the auth error (401), never a 404 that would confirm the route
    // does/doesn't exist, and never reach the handler.
    const result = await call(context, `${baseUrl}/debug/heap-snapshot`, { method: 'POST' });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('returns the auth error (not a 404) for an unknown path when unauthenticated', async () => {
    const result = await call(context, `${baseUrl}/v1/definitely-not-a-real-route`);
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('returns 404 for an unknown path once the caller is authenticated', async () => {
    const result = await call(context, `${baseUrl}/v1/definitely-not-a-real-route`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects an off-loopback host before doing any route/auth work', async () => {
    const result = await call(context, `${baseUrl}/v1/version`, {
      headers: { host: 'evil.example.com' },
    });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ code: 'LOOPBACK_ONLY' });
  });

  it('the SIDETRACK_HTTP_LOG line strips the query string (no PII)', async () => {
    const logPath = '/tmp/sidetrack-http-debug.log';
    // Unique marker path/query so we can find OUR line even if another
    // process shares the file; the query value is the "PII" we assert is
    // absent from the log.
    const markerPath = `/v1/version`;
    const secret = `secret-search-term-${String(Date.now())}`;
    const prev = process.env['SIDETRACK_HTTP_LOG'];
    process.env['SIDETRACK_HTTP_LOG'] = '1';
    try {
      const result = await call(context, `${baseUrl}${markerPath}?q=${secret}`);
      expect(result.status).toBe(200);
      // Give the fire-and-forget append a tick to flush.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const contents = await readFile(logPath, 'utf8').catch(() => '');
      const ourLines = contents.split('\n').filter((line) => line.includes(markerPath));
      expect(ourLines.length).toBeGreaterThan(0);
      for (const line of ourLines) {
        expect(line).not.toContain(secret);
        expect(line).not.toContain('?');
      }
    } finally {
      if (prev === undefined) {
        delete process.env['SIDETRACK_HTTP_LOG'];
      } else {
        process.env['SIDETRACK_HTTP_LOG'] = prev;
      }
    }
  });

  it('VaultUnavailableError round-trips to a 503 with the legacy wire shape', async () => {
    // The vault writer throws the legacy stringly-typed error (via
    // ensureVaultPresent) when the vault path is gone; deleting the temp
    // dir reproduces it through a real write route so we exercise the
    // handler's error mapping end-to-end. bumpWorkstream calls
    // ensureVaultPresent as its first step.
    await rm(vaultPath, { recursive: true, force: true });
    const result = await call(context, `${baseUrl}/v1/workstreams/ws-hardening/bump`, {
      method: 'POST',
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      status: 503,
      code: 'VAULT_UNAVAILABLE',
      title: 'Vault path is unavailable.',
      detail: 'Vault path is unavailable.',
    });
  });

  it('VaultUnavailableError.matches recognises both the typed error and the legacy message', () => {
    expect(VaultUnavailableError.matches(new VaultUnavailableError())).toBe(true);
    expect(VaultUnavailableError.matches(new Error('Vault path is unavailable.'))).toBe(true);
    expect(VaultUnavailableError.matches(new Error('something else'))).toBe(false);
    expect(VaultUnavailableError.matches('not an error')).toBe(false);
    // The typed error's default message matches the legacy detail field,
    // so the wire `detail` stays byte-identical.
    expect(new VaultUnavailableError().message).toBe('Vault path is unavailable.');
  });
});
