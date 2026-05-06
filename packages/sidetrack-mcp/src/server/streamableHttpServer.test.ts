import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LiveVaultSnapshot } from '../vault/liveVaultReader.js';
import { createSidetrackMcpServer, type SidetrackMcpReader } from './mcpServer.js';
import {
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

const startServer = async (
  authKey?: string,
): Promise<StartedStreamableHttpMcpServer> => {
  const started = await startStreamableHttpMcpServer({
    port: 0,
    ...(authKey === undefined ? {} : { authKey }),
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

describe('Streamable HTTP MCP server transport', () => {
  it('serves tools/list and tools/call over Streamable HTTP', async () => {
    const started = await startServer();
    const client = new Client({ name: 'sidetrack-mcp-http-test', version: '0.0.0' });
    await client.connect(buildBearerTransport(started.url));

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
    await expect(
      client.connect(buildBearerTransport(started.url, 'wrong')),
    ).rejects.toThrow();
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
});
