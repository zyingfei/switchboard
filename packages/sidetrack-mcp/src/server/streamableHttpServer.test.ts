import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LiveVaultSnapshot } from '../vault/liveVaultReader.js';
import { createSidetrackMcpServer, type SidetrackMcpReader } from './mcpServer.js';
import {
  BRIDGE_KEY_GUIDANCE,
  startStreamableHttpMcpServer,
  type StartedStreamableHttpMcpServer,
} from './streamableHttpServer.js';

const emptySnapshot: LiveVaultSnapshot = {
  workstreams: [],
  threads: [
    {
      bac_id: 'bac_thread_http',
      provider: 'claude',
      threadUrl: 'https://claude.ai/chat/http',
      title: 'Streamable HTTP MCP transport',
      lastSeenAt: '2026-05-04T20:00:00.000Z',
      status: 'active',
      trackingMode: 'manual',
    },
  ],
  queueItems: [],
  reminders: [],
  events: [],
  generatedAt: '2026-05-04T20:00:00.000Z',
};

const fakeReader: SidetrackMcpReader = {
  readSnapshot: vi.fn(() => Promise.resolve(emptySnapshot)),
  readCodingSessions: vi.fn(() => Promise.resolve([])),
  readDispatches: vi.fn(() => Promise.resolve({ data: [] })),
  readReviews: vi.fn(() => Promise.resolve({ data: [] })),
  readTurns: vi.fn(() => Promise.resolve({ data: [] })),
};

const startedServers: StartedStreamableHttpMcpServer[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.close()));
});

const startServer = async (authKey: string): Promise<StartedStreamableHttpMcpServer> => {
  const started = await startStreamableHttpMcpServer({
    port: 0,
    authKey,
    createServer: () => createSidetrackMcpServer(fakeReader),
  });
  startedServers.push(started);
  return started;
};

// The SDK's StreamableHTTPClientTransport types `sessionId` as
// `string | undefined`, but the Transport interface tightens it
// to `string` under exactOptionalPropertyTypes. Cast through unknown
// to silence the structural mismatch — the runtime contract matches.
type ConnectableTransport = Parameters<Client['connect']>[0];

const buildBearerTransport = (url: string, bearer?: string): ConnectableTransport => {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(bearer === undefined
      ? {}
      : { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }),
  });
  return transport as unknown as ConnectableTransport;
};

// Low-level HTTP POST using node:http so we can control the Host header exactly.
// fetch() may silently ignore or override a custom Host.
interface RawHttpResult {
  readonly status: number;
  readonly body: unknown;
}

const rawPost = (
  port: number,
  path: string,
  hostHeader: string,
  authorization: string,
  body: unknown,
): Promise<RawHttpResult> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: hostHeader,
          'content-type': 'application/json',
          // The MCP Streamable HTTP spec requires both types in Accept.
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          authorization,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

describe('Streamable HTTP MCP server transport', () => {
  it('serves tools/list and tools/call over Streamable HTTP', async () => {
    const started = await startServer('test_bridge_key');
    const client = new Client({ name: 'sidetrack-mcp-http-test', version: '0.0.0' });
    await client.connect(buildBearerTransport(started.url, 'test_bridge_key'));

    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'sidetrack.threads.list')).toBe(true);

      const result = await client.callTool({
        name: 'sidetrack.threads.list',
        arguments: { limit: 1 },
      });
      expect(result.structuredContent).toMatchObject({
        threads: [{ bac_id: 'bac_thread_http', title: 'Streamable HTTP MCP transport' }],
      });
    } finally {
      await client.close();
    }
  });

  it('rejects unauthenticated requests when an auth key is configured', async () => {
    const started = await startServer('bridge_secret');
    const client = new Client({ name: 'sidetrack-mcp-http-noauth', version: '0.0.0' });
    await expect(client.connect(buildBearerTransport(started.url, 'wrong'))).rejects.toThrow();
    await client.close().catch(() => undefined);
  });

  it('accepts the bridge key as an Authorization Bearer header', async () => {
    const started = await startServer('bridge_secret');
    const client = new Client({ name: 'sidetrack-mcp-http-auth', version: '0.0.0' });
    await client.connect(buildBearerTransport(started.url, 'bridge_secret'));

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'sidetrack.threads.list' }),
        ]),
      });
    } finally {
      await client.close();
    }
  });

  // F03 (a) — keyless start must throw with guidance message
  it('refuses to start when authKey is empty', async () => {
    await expect(
      startStreamableHttpMcpServer({
        port: 0,
        authKey: '',
        createServer: () => createSidetrackMcpServer(fakeReader),
      }),
    ).rejects.toThrow(BRIDGE_KEY_GUIDANCE);
  });

  it('refuses to start when authKey is whitespace only', async () => {
    await expect(
      startStreamableHttpMcpServer({
        port: 0,
        authKey: '   ',
        createServer: () => createSidetrackMcpServer(fakeReader),
      }),
    ).rejects.toThrow('sidetrack-mcp streamable-HTTP transport requires an auth key');
  });

  // F03 (b) — wrong Host header is rejected with 403 (DNS-rebinding defense)
  it('rejects requests with a non-loopback Host header', async () => {
    const started = await startServer('bridge_secret');
    const port = Number(new URL(started.url).port);

    const result = await rawPost(
      port,
      '/mcp',
      'evil.example.com',
      'Bearer bridge_secret',
      { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} },
    );

    expect(result.status).toBe(403);
    const body = result.body as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/Host not allowed/i);
  });

  // F03 (b) + (c) — correct loopback Host + valid token is accepted
  it('accepts requests with a loopback Host header and valid token', async () => {
    const started = await startServer('correct_key');
    const port = Number(new URL(started.url).port);

    const result = await rawPost(
      port,
      '/mcp',
      `127.0.0.1:${String(port)}`,
      'Bearer correct_key',
      {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      },
    );

    expect(result.status).toBe(200);
  });

  // F03 (c) — invalid token is rejected with 401
  it('rejects requests with an invalid token', async () => {
    const started = await startServer('correct_key');
    const port = Number(new URL(started.url).port);

    const result = await rawPost(
      port,
      '/mcp',
      `127.0.0.1:${String(port)}`,
      'Bearer wrong_key',
      {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.0' },
        },
      },
    );

    expect(result.status).toBe(401);
    const body = result.body as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32001);
  });
});
