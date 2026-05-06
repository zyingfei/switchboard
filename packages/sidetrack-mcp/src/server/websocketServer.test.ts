import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import type { LiveVaultSnapshot } from '../vault/liveVaultReader.js';
import { createSidetrackMcpServer, type SidetrackMcpReader } from './mcpServer.js';
import {
  mcpAuthenticationRequiredCode,
  startWebSocketMcpServer,
  type StartedWebSocketMcpServer,
} from './websocketServer.js';

const emptySnapshot: LiveVaultSnapshot = {
  workstreams: [],
  threads: [
    {
      bac_id: 'bac_thread_ws',
      provider: 'claude',
      threadUrl: 'https://claude.ai/chat/ws',
      title: 'WebSocket MCP transport',
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

const rawDataToText = (data: RawData): string => {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
};

const startedServers: StartedWebSocketMcpServer[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.close()));
});

const startServer = async (authKey?: string): Promise<StartedWebSocketMcpServer> => {
  const started = await startWebSocketMcpServer({
    port: 0,
    ...(authKey === undefined ? {} : { authKey }),
    createServer: () => createSidetrackMcpServer(fakeReader),
  });
  startedServers.push(started);
  return started;
};

describe('WebSocket MCP server transport', () => {
  it('serves tools/list and tools/call over WebSocket', async () => {
    const started = await startServer();
    const client = new Client({ name: 'sidetrack-mcp-ws-test', version: '0.0.0' });
    await client.connect(new WebSocketClientTransport(new URL(started.url)));

    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'sidetrack.threads.list')).toBe(true);

      const result = await client.callTool({
        name: 'sidetrack.threads.list',
        arguments: { limit: 1 },
      });
      expect(result.structuredContent).toMatchObject({
        threads: [{ bac_id: 'bac_thread_ws', title: 'WebSocket MCP transport' }],
      });
    } finally {
      await client.close();
    }
  });

  it('rejects unauthenticated sockets when an auth key is configured', async () => {
    const started = await startServer('bridge_secret');

    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(`${started.url}?token=wrong`, 'mcp');
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out waiting for authentication error.'));
      }, 5_000);
      socket.once('message', (data) => {
        clearTimeout(timer);
        socket.close();
        resolve(rawDataToText(data));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(JSON.parse(message)).toMatchObject({
      error: {
        code: mcpAuthenticationRequiredCode,
      },
    });
  });

  it('accepts the bridge key as a token query parameter', async () => {
    const started = await startServer('bridge_secret');
    const client = new Client({ name: 'sidetrack-mcp-ws-auth-test', version: '0.0.0' });
    await client.connect(
      new WebSocketClientTransport(new URL(`${started.url}?token=bridge_secret`)),
    );

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: 'sidetrack.threads.list' })]),
      });
    } finally {
      await client.close();
    }
  });
});
