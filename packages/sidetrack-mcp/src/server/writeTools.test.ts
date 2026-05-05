import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import type { CodingSessionRecord, LiveVaultSnapshot } from '../vault/liveVaultReader.js';
import {
  createSidetrackMcpServer,
  type CompanionWriteClient,
  type SidetrackMcpReader,
} from './mcpServer.js';

const emptySnapshot: LiveVaultSnapshot = {
  workstreams: [],
  threads: [],
  queueItems: [],
  reminders: [],
  events: [],
  generatedAt: '2026-04-30T00:00:00.000Z',
};

const fakeReader: SidetrackMcpReader = {
  readSnapshot: () => Promise.resolve(emptySnapshot),
  readCodingSessions: () => Promise.resolve([]),
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
  requestDispatch: vi.fn(() =>
    Promise.resolve({
      dispatchId: 'bac_dispatch_fake',
      approval: 'auto-approved' as const,
      status: 'recorded',
      requestedAt: '2026-05-05T12:00:00.000Z',
    }),
  ),
  ...overrides,
});

const startInProcessServer = async (
  writeClient?: CompanionWriteClient,
  reader: SidetrackMcpReader = fakeReader,
): Promise<Client> => {
  const server = createSidetrackMcpServer(reader, writeClient);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'sidetrack-mcp-write-tools-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
};

// MCP SDK surfaces tool-thrown errors as `{ isError: true, content: [{ text }] }`
// instead of rejecting the promise. Helper keeps the tests readable.
const errorText = (result: unknown): string => {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    return '';
  }
  const content = result.content;
  if (!Array.isArray(content)) {
    return '';
  }
  const first = content[0] as unknown;
  if (typeof first !== 'object' || first === null || !('text' in first)) {
    return '';
  }
  return typeof first.text === 'string' ? first.text : '';
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

const attachedSession = (overrides: Partial<CodingSessionRecord> = {}): CodingSessionRecord => ({
  bac_id: 'bac_session_attached',
  workstreamId: 'bac_ws_attached',
  tool: 'codex',
  cwd: '/tmp/sidetrack',
  branch: 'codex/mcp-inbound-dispatch',
  sessionId: 'codex-session',
  name: 'codex · inbound',
  attachedAt: '2026-05-05T12:00:00.000Z',
  lastSeenAt: '2026-05-05T12:00:00.000Z',
  status: 'attached',
  ...overrides,
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

describe('bac.request_dispatch', () => {
  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'bac.request_dispatch',
        arguments: {
          codingSessionId: 'bac_session_attached',
          targetProvider: 'chatgpt',
          title: 'Ask ChatGPT',
          body: 'Please review this context.',
        },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/bac\.request_dispatch is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('rejects calls for sessions that are not attached', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'bac.request_dispatch',
        arguments: {
          codingSessionId: 'bac_session_missing',
          targetProvider: 'chatgpt',
          title: 'Ask ChatGPT',
          body: 'Please review this context.',
        },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/requires an attached coding session/);
      expect(writeClient.requestDispatch).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('auto-approves and records dispatch requests for attached sessions', async () => {
    const writeClient = buildFakeWriteClient();
    const reader: SidetrackMcpReader = {
      ...fakeReader,
      readCodingSessions: () => Promise.resolve([attachedSession()]),
    };
    const client = await startInProcessServer(writeClient, reader);
    try {
      const result = await client.callTool({
        name: 'bac.request_dispatch',
        arguments: {
          codingSessionId: 'bac_session_attached',
          targetProvider: 'chatgpt',
          title: 'Ask ChatGPT',
          body: 'Please review this context.',
        },
      });
      expect(writeClient.requestDispatch).toHaveBeenCalledWith({
        codingSessionId: 'bac_session_attached',
        targetProvider: 'chatgpt',
        title: 'Ask ChatGPT',
        body: 'Please review this context.',
        mode: 'auto-send',
        workstreamId: 'bac_ws_attached',
      });
      expect(result.structuredContent).toMatchObject({
        dispatchId: 'bac_dispatch_fake',
        approval: 'auto-approved',
        status: 'recorded',
        targetProvider: 'chatgpt',
        mode: 'auto-send',
        workstreamId: 'bac_ws_attached',
      });
    } finally {
      await client.close();
    }
  });
});
