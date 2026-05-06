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
  createAnnotation: vi.fn(() =>
    Promise.resolve({
      bac_id: 'bac_annotation_fake',
      url: 'https://chatgpt.com/c/thread',
      pageTitle: 'ChatGPT',
      note: 'Architect note',
    }),
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

describe('sidetrack.threads.move', () => {
  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.threads.move',
        arguments: { threadId: 'bac_thread_test', workstreamId: 'bac_ws_a' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.threads\.move is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes workstreamId through to the companion when provided', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.threads.move',
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
        name: 'sidetrack.threads.move',
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
        name: 'sidetrack.threads.move',
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

describe('sidetrack.queue.create', () => {
  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.queue.create',
        arguments: { text: 'follow up Q', scope: 'global' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.queue\.create is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('reports an error when scope=thread is missing targetId', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.queue.create',
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
        name: 'sidetrack.queue.create',
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
        name: 'sidetrack.queue.create',
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
        name: 'sidetrack.queue.create',
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

// `bac.request_dispatch` was removed in Phase 1.4a; the typed
// replacement `sidetrack.dispatch.create` is covered above.
// `bac.request_dispatch` was deleted in Phase 1.4a. The typed
// replacement `sidetrack.dispatch.create` is covered below in its own
// describe block.

describe('sidetrack.annotations.create_batch', () => {
  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.annotations.create_batch',
        arguments: {
          url: 'https://chatgpt.com/c/thread',
          pageTitle: 'ChatGPT',
          items: [{ term: 'WebGPU', note: 'GPU API.' }],
        },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.annotations\.create_batch is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('persists each item in order, surfaces per-item status', async () => {
    let counter = 0;
    const writeClient = buildFakeWriteClient({
      createAnnotation: vi.fn(() => {
        counter += 1;
        return Promise.resolve({
          bac_id: `bac_annotation_${String(counter)}`,
          url: 'https://chatgpt.com/c/thread',
          pageTitle: 'HN',
          note: 'note',
        });
      }),
    });
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.annotations.create_batch',
        arguments: {
          url: 'https://chatgpt.com/c/thread',
          pageTitle: 'HN',
          items: [
            {
              term: 'WebGPU',
              prefix: 'l than N websites each bundling ',
              suffix: '/WASM inference stacks, ONNX Run',
              note: 'WebGPU defines browser GPU compute and rendering.',
            },
            {
              term: 'eBPF',
              prefix: 'kernel without rebuild — namely ',
              suffix: ' programs verified before load',
              note: 'eBPF runs verified bytecode in the kernel.',
            },
          ],
        },
      });
      expect(writeClient.createAnnotation).toHaveBeenCalledTimes(2);
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured['countForThread']).toBe(2);
      const annotations = structured['annotations'] as readonly Record<string, unknown>[];
      expect(annotations).toHaveLength(2);
      expect(annotations[0]).toMatchObject({
        term: 'WebGPU',
        status: 'created',
        annotationId: 'bac_annotation_1',
      });
      expect(annotations[1]).toMatchObject({
        term: 'eBPF',
        status: 'created',
        annotationId: 'bac_annotation_2',
      });
    } finally {
      await client.close();
    }
  });

  it('rejects short terms without context per-item, but lets the rest of the batch succeed', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.annotations.create_batch',
        arguments: {
          url: 'https://chatgpt.com/c/thread',
          pageTitle: 'HN',
          items: [
            { term: 'AI', note: 'Too generic without context.' },
            {
              term: 'WebGPU',
              prefix: 'each bundling ',
              suffix: '/WASM inference',
              note: 'Defines browser GPU access.',
            },
          ],
        },
      });
      expect(writeClient.createAnnotation).toHaveBeenCalledTimes(1);
      const annotations = (result.structuredContent as Record<string, unknown>)[
        'annotations'
      ] as readonly Record<string, unknown>[];
      expect(annotations[0]).toMatchObject({ term: 'AI', status: 'rejected' });
      expect(annotations[1]).toMatchObject({ term: 'WebGPU', status: 'created' });
    } finally {
      await client.close();
    }
  });
});

describe('sidetrack.session.attach', () => {
  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.session.attach',
        arguments: {
          attachToken: 'tok_abcdefgh',
          tool: 'codex',
          cwd: '/repo',
          branch: 'main',
          sessionId: 'sess-1',
          name: 'codex · main',
        },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.session\.attach is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('forwards attach token + runtime metadata to the companion writer', async () => {
    const writeClient = buildFakeWriteClient({
      registerCodingSession: vi.fn(() =>
        Promise.resolve({ bac_id: 'bac_session_typed', workstreamId: 'bac_ws_typed' }),
      ),
    });
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.session.attach',
        arguments: {
          attachToken: 'tok_abcdefgh',
          tool: 'codex',
          cwd: '/Users/me/repo',
          branch: 'main',
          sessionId: 'sess-7',
          name: 'codex · main',
          resumeCommand: 'codex resume sess-7',
        },
      });
      expect(writeClient.registerCodingSession).toHaveBeenCalledWith({
        token: 'tok_abcdefgh',
        tool: 'codex',
        cwd: '/Users/me/repo',
        branch: 'main',
        sessionId: 'sess-7',
        name: 'codex · main',
        resumeCommand: 'codex resume sess-7',
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        codingSessionId: 'bac_session_typed',
        workstreamId: 'bac_ws_typed',
        tool: 'codex',
      });
    } finally {
      await client.close();
    }
  });
});

describe('sidetrack.dispatch.create', () => {
  it('mirrors bac.request_dispatch behavior under the typed name', async () => {
    const writeClient = buildFakeWriteClient();
    const reader: SidetrackMcpReader = {
      ...fakeReader,
      readCodingSessions: () => Promise.resolve([attachedSession()]),
    };
    const client = await startInProcessServer(writeClient, reader);
    try {
      const result = await client.callTool({
        name: 'sidetrack.dispatch.create',
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
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        dispatchId: 'bac_dispatch_fake',
        approval: 'auto-approved',
        status: 'recorded',
        targetProvider: 'chatgpt',
        mode: 'auto-send',
        workstreamId: 'bac_ws_attached',
      });
      // Resource URI surfaced for Phase-5 consumers; today it's just a
      // stable string the agent can store and re-read after Phase 3
      // fills in the link.
      expect(structured['statusResource']).toBe('sidetrack://dispatch/bac_dispatch_fake');
    } finally {
      await client.close();
    }
  });

  it('rejects calls for sessions that are not attached', async () => {
    const writeClient = buildFakeWriteClient();
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.dispatch.create',
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

  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.dispatch.create',
        arguments: {
          codingSessionId: 'bac_session_attached',
          targetProvider: 'chatgpt',
          title: 'Ask ChatGPT',
          body: 'Please review this context.',
        },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.dispatch\.create is unavailable/);
    } finally {
      await client.close();
    }
  });
});

describe('sidetrack.dispatch.await_capture', () => {
  it('returns the Phase-1 stub sentinel until server-side correlation lands in Phase 3', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.dispatch.await_capture',
        arguments: { dispatchId: 'bac_dispatch_pending' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        dispatchId: 'bac_dispatch_pending',
        matched: false,
        reason: 'unsupported-in-phase-1',
      });
    } finally {
      await client.close();
    }
  });
});

// `bac.create_annotation` was deleted in Phase 1.4a. The typed
// replacement `sidetrack.annotations.create_batch` (covered above)
// supersedes both single-create and the four-call-per-page pattern.
