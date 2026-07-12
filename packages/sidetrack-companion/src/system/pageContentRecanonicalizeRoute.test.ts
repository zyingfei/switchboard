import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBridgeKey } from '../auth/bridgeKey.js';
import { handleRequest, type CompanionHttpConfig } from '../http/server.js';
import { readPageContentCoverage, writePageContentExtracted } from '../page-content/store.js';
import type { PageContentCoverage, PageContentExtractedPayload } from '../page-content/types.js';
import { createVaultWriter } from '../vault/writer.js';

interface MemoryResponse {
  readonly status: number;
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
    if (!headers.has('host')) headers.set('host', parsed.host);
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
    if (this.consumed) return;
    this.consumed = true;
    if (this.body.length > 0) this.push(this.body);
    this.push(null);
  }
}

class MemoryServerResponse {
  statusCode = 200;
  private body = '';

  writeHead(status: number): this {
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
  return { status: response.statusCode, bodyText: response.text() };
};

const jsonFetch = async (
  context: CompanionHttpConfig,
  url: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await memoryFetch(context, url, init);
  return { status: response.status, body: JSON.parse(response.bodyText) as unknown };
};

describe('page-content recanonicalize route', () => {
  let vaultRoot = '';
  let bridgeKey = '';
  let context: CompanionHttpConfig;
  const baseUrl = 'http://127.0.0.1';

  const extractedPayload = (
    overrides: Partial<PageContentExtractedPayload> = {},
  ): PageContentExtractedPayload => ({
    payloadVersion: 1,
    canonicalUrl: 'https://route.example.test/article?id=123',
    url: 'https://route.example.test/article?id=123&utm_source=test',
    title: 'Route cleanup fixture',
    extractedAt: '2026-05-26T13:00:00.000Z',
    extractionSource: 'reader-mode',
    extractionPolicy: { trigger: 'manual' },
    quality: 'high',
    qualitySignals: {
      extractedWordCount: 160,
      contentToDomRatio: 0.7,
      boilerplateFraction: 0.05,
      extractionStrategy: 'reader-mode',
    },
    content: {
      text: 'route cleanup canonical page content '.repeat(80),
      contentHash: 'hash-route-cleanup',
      charCount: 2880,
    },
    ...overrides,
  });

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-recanonicalize-route-'));
    bridgeKey = (await ensureBridgeKey(vaultRoot)).key;
    context = {
      bridgeKey,
      vaultRoot,
      vaultWriter: createVaultWriter(vaultRoot),
    };
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('tombstones the requested canonical URL and reports tombstoned coverage', async () => {
    const canonicalUrl = 'https://route.example.test/article?id=123';
    await writePageContentExtracted(vaultRoot, extractedPayload({ canonicalUrl }));
    await expect(readPageContentCoverage(vaultRoot, canonicalUrl)).resolves.toMatchObject({
      state: 'indexed',
    });

    const recanonicalize = await jsonFetch(context, `${baseUrl}/v1/page-content/recanonicalize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify(canonicalUrl),
    });
    const body = recanonicalize.body as {
      readonly data?: { readonly tombstoned?: boolean; readonly canonicalUrl?: string };
    };

    expect(recanonicalize.status).toBe(200);
    expect(body.data).toEqual({ tombstoned: true, canonicalUrl });

    const coverageResponse = await jsonFetch(
      context,
      `${baseUrl}/v1/page-content/coverage?canonicalUrl=${encodeURIComponent(canonicalUrl)}`,
      { headers: { 'x-bac-bridge-key': bridgeKey } },
    );
    const coverageBody = coverageResponse.body as { readonly data?: PageContentCoverage };

    expect(coverageResponse.status).toBe(200);
    expect(coverageBody.data).toMatchObject({ canonicalUrl, state: 'tombstoned' });
  });
});
