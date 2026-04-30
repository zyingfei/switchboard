import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import type { LiveVaultReader, LiveVaultSnapshot } from '../vault/liveVaultReader.js';
import { createSidetrackMcpServer, type CompanionWriteClient } from './mcpServer.js';

const emptySnapshot: LiveVaultSnapshot = {
  workstreams: [],
  threads: [],
  queueItems: [],
  reminders: [],
  generatedAt: '2026-04-30T00:00:00.000Z',
};

const fakeReader: LiveVaultReader = {
  readSnapshot: () => Promise.resolve(emptySnapshot),
  readDispatches: () => Promise.resolve({ data: [] }),
  readReviews: () => Promise.resolve({ data: [] }),
  readTurns: () => Promise.resolve({ data: [] }),
};

const buildFakeWriteClient = (
  overrides: Partial<CompanionWriteClient> = {},
): CompanionWriteClient => ({
  registerCodingSession: vi.fn(() => Promise.resolve({ bac_id: 'bac_session_fake' })),
  moveThread: vi.fn(() =>
    Promise.resolve({ bac_id: 'bac_thread_fake', revision: 'rev_thread_fake' }),
  ),
  createQueueItem: vi.fn(() =>
    Promise.resolve({ bac_id: 'bac_queue_fake', revision: 'rev_queue_fake' }),
  ),
  ...overrides,
});

const startInProcessServer = async (writeClient?: CompanionWriteClient): Promise<Client> => {
  const server = createSidetrackMcpServer(fakeReader, writeClient);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'sidetrack-mcp-write-tools-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
};

// MCP SDK surfaces tool-thrown errors as `{ isError: true, content: [{ text }] }`
// instead of rejecting the promise. Helper keeps the tests readable.
const errorText = (result: { content?: unknown }): string => {
  const content = result.content as { readonly text?: string }[] | undefined;
  return content?.[0]?.text ?? '';
};

describe('bac.move_item', () => {
  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'bac.move_item',
        arguments: { threadId: 'bac_thread_test', workstreamId: 'bac_ws_a' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/bac\.move_item is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes workstreamId through to the companion when provided', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'bac.move_item',
        arguments: { threadId: 'bac_thread_T', workstreamId: 'bac_ws_X' },
      });
      expect(writeClient.moveThread).toHaveBeenCalledWith({
        threadId: 'bac_thread_T',
        workstreamId: 'bac_ws_X',
      });
      const structured = result.structuredContent as { readonly bac_id?: string };
      expect(structured.bac_id).toBe('bac_thread_fake');
    } finally {
      await client.close();
    }
  });

  it('clears the workstream when the empty string is passed', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      await client.callTool({
        name: 'bac.move_item',
        arguments: { threadId: 'bac_thread_T', workstreamId: '' },
      });
      // The empty-string convention is "park at top level" — we should
      // call moveThread WITHOUT a workstreamId.
      expect(writeClient.moveThread).toHaveBeenCalledWith({ threadId: 'bac_thread_T' });
    } finally {
      await client.close();
    }
  });

  it('clears the workstream when workstreamId is omitted', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      await client.callTool({
        name: 'bac.move_item',
        arguments: { threadId: 'bac_thread_T' },
      });
      expect(writeClient.moveThread).toHaveBeenCalledWith({ threadId: 'bac_thread_T' });
    } finally {
      await client.close();
    }
  });
});

describe('bac.queue_item', () => {
  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'bac.queue_item',
        arguments: { text: 'follow up Q', scope: 'global' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/bac\.queue_item is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('reports an error when scope=thread is missing targetId', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'bac.queue_item',
        arguments: { text: 'q', scope: 'thread' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/requires targetId/);
      expect(writeClient.createQueueItem).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('reports an error when scope=workstream is missing targetId', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'bac.queue_item',
        arguments: { text: 'q', scope: 'workstream' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/requires targetId/);
    } finally {
      await client.close();
    }
  });

  it('drops targetId when scope=global (defensive against a chatty caller)', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      await client.callTool({
        name: 'bac.queue_item',
        arguments: { text: 'global q', scope: 'global', targetId: 'bac_should_be_ignored' },
      });
      expect(writeClient.createQueueItem).toHaveBeenCalledWith({
        text: 'global q',
        scope: 'global',
      });
    } finally {
      await client.close();
    }
  });

  it('passes through scope=thread + targetId on the happy path', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'bac.queue_item',
        arguments: { text: 'thread q', scope: 'thread', targetId: 'bac_thread_T' },
      });
      expect(writeClient.createQueueItem).toHaveBeenCalledWith({
        text: 'thread q',
        scope: 'thread',
        targetId: 'bac_thread_T',
      });
      const structured = result.structuredContent as { readonly bac_id?: string };
      expect(structured.bac_id).toBe('bac_queue_fake');
    } finally {
      await client.close();
    }
  });
});
