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
      status: 'created' as const,
      annotationId: 'bac_annotation_fake',
      occurrenceCount: 1,
      annotation: {
        bac_id: 'bac_annotation_fake',
        url: 'https://chatgpt.com/c/thread',
        pageTitle: 'ChatGPT',
        note: 'Architect note',
      },
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
      createAnnotation: vi.fn((input) => {
        counter += 1;
        return Promise.resolve({
          status: 'created' as const,
          annotationId: `bac_annotation_${String(counter)}`,
          occurrenceCount: 1,
          annotation: {
            bac_id: `bac_annotation_${String(counter)}`,
            url: input.url,
            pageTitle: input.pageTitle,
            term: input.term,
            note: input.note,
          },
        });
      }),
    });
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.annotations.create_batch',
        arguments: {
          threadId: 'bac_thread_target',
          items: [
            { term: 'WebGPU', note: 'WebGPU defines browser GPU compute and rendering.' },
            {
              term: 'eBPF',
              selectionHint: 'kernel without rebuild — namely',
              note: 'eBPF runs verified bytecode in the kernel.',
            },
          ],
        },
      });
      expect(writeClient.createAnnotation).toHaveBeenCalledTimes(2);
      expect(writeClient.createAnnotation).toHaveBeenNthCalledWith(2, {
        threadId: 'bac_thread_target',
        term: 'eBPF',
        note: 'eBPF runs verified bytecode in the kernel.',
        selectionHint: 'kernel without rebuild — namely',
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured['threadId']).toBe('bac_thread_target');
      expect(structured['attemptedCount']).toBe(2);
      expect(structured['createdCount']).toBe(2);
      expect(structured['anchorFailedCount']).toBe(0);
      const items = structured['items'] as readonly Record<string, unknown>[];
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        term: 'WebGPU',
        status: 'created',
        annotationId: 'bac_annotation_1',
      });
      expect(items[1]).toMatchObject({
        term: 'eBPF',
        status: 'created',
        annotationId: 'bac_annotation_2',
      });
    } finally {
      await client.close();
    }
  });

  it('surfaces structured anchor_failed reasons with suggestedSelectionHints', async () => {
    // The companion now returns structured per-item failures; the
    // tool maps anchor_failed → status:'anchor_failed' and exposes
    // the suggested selection hints so the model can retry once.
    const writeClient = buildFakeWriteClient({
      createAnnotation: vi.fn((input) => {
        if (input.term === 'WebGPU' && input.selectionHint === undefined) {
          return Promise.resolve({
            status: 'anchor_failed' as const,
            reason: 'ambiguous_term_requires_selection_hint' as const,
            message: "Term 'WebGPU' appears 3 times; provide selectionHint.",
            occurrenceCount: 3,
            suggestedSelectionHints: ['ordinal:1', 'ordinal:2', 'ordinal:3'] as const,
          });
        }
        return Promise.resolve({
          status: 'created' as const,
          annotationId: 'bac_annotation_ok',
          occurrenceCount: 1,
          annotation: {
            bac_id: 'bac_annotation_ok',
            url: input.url,
            pageTitle: input.pageTitle,
            term: input.term,
            note: input.note,
          },
        });
      }),
    });
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.annotations.create_batch',
        arguments: {
          threadId: 'bac_thread_target',
          items: [
            { term: 'WebGPU', note: 'Repeated; should require hint.' },
            { term: 'eBPF', note: 'Single occurrence; should succeed.' },
          ],
        },
      });
      expect(writeClient.createAnnotation).toHaveBeenCalledTimes(2);
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured['createdCount']).toBe(1);
      expect(structured['anchorFailedCount']).toBe(1);
      const items = structured['items'] as readonly Record<string, unknown>[];
      expect(items[0]).toMatchObject({
        term: 'WebGPU',
        status: 'anchor_failed',
        reason: 'ambiguous_term_requires_selection_hint',
        occurrenceCount: 3,
        suggestedSelectionHints: ['ordinal:1', 'ordinal:2', 'ordinal:3'],
      });
      expect(items[1]).toMatchObject({
        term: 'eBPF',
        status: 'created',
      });
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

  it('prepends a captureProfile formatting block to the body', async () => {
    const writeClient = buildFakeWriteClient();
    const reader: SidetrackMcpReader = {
      ...fakeReader,
      readCodingSessions: () => Promise.resolve([attachedSession()]),
    };
    const client = await startInProcessServer(writeClient, reader);
    try {
      await client.callTool({
        name: 'sidetrack.dispatch.create',
        arguments: {
          codingSessionId: 'bac_session_attached',
          targetProvider: 'gemini',
          title: 'B+ tree deep dive',
          body: 'Please explain B+ trees from first principles.',
          captureProfile: 'annotation_friendly',
        },
      });
      expect(writeClient.requestDispatch).toHaveBeenCalledTimes(1);
      const call = (writeClient.requestDispatch as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]?.[0] as { readonly body: string };
      // Profile-derived formatting prefix is at the top; the
      // user's intent stays verbatim below it.
      expect(call.body).toMatch(/respond in plain text/i);
      expect(call.body).toMatch(/ASCII for diagrams/i);
      expect(call.body).toContain('Please explain B+ trees from first principles.');
      // Order matters — the user's message should be the LAST line
      // so target-AI attention bias still favours intent over
      // formatting.
      expect(call.body.indexOf('Please explain B+ trees')).toBeGreaterThan(
        call.body.indexOf('respond in plain text'),
      );
    } finally {
      await client.close();
    }
  });

  it('emits a resource_link content block for the dispatch record', async () => {
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
      const blocks = result.content as readonly { readonly type: string; readonly uri?: string }[];
      const link = blocks.find((block) => block.type === 'resource_link');
      expect(link).toBeDefined();
      expect(link?.uri).toBe('sidetrack://dispatch/bac_dispatch_fake');
    } finally {
      await client.close();
    }
  });
});

describe('sidetrack.dispatch.await_capture', () => {
  it('reports unavailable when no companion client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.dispatch.await_capture',
        arguments: { dispatchId: 'bac_dispatch_pending' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.dispatch\.await_capture is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('forwards to companion awaitCaptureForDispatch and surfaces the matched payload', async () => {
    const writeClient = buildFakeWriteClient({
      awaitCaptureForDispatch: vi.fn(() =>
        Promise.resolve({
          dispatchId: 'bac_dispatch_pending',
          matched: true,
          linkedAt: '2026-05-05T12:00:00.000Z',
          thread: {
            threadId: 'bac_thread_linked',
            threadUrl: 'https://chatgpt.com/c/linked',
            title: 'Captured chat',
            provider: 'chatgpt' as const,
          },
          resources: {
            dispatch: 'sidetrack://dispatch/bac_dispatch_pending',
            thread: 'sidetrack://thread/bac_thread_linked',
            turns: 'sidetrack://thread/bac_thread_linked/turns',
            markdown: 'sidetrack://thread/bac_thread_linked/markdown',
            annotations: 'sidetrack://thread/bac_thread_linked/annotations',
          },
          latestAssistantTurn: {
            ordinal: 0,
            text: 'Captured assistant body.',
            capturedAt: '2026-05-05T12:00:00.000Z',
          },
          reason: 'matched' as const,
        }),
      ),
    });
    const client = await startInProcessServer(writeClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.dispatch.await_capture',
        arguments: { dispatchId: 'bac_dispatch_pending', timeoutMs: 5000 },
      });
      expect(writeClient.awaitCaptureForDispatch).toHaveBeenCalledWith({
        dispatchId: 'bac_dispatch_pending',
        timeoutMs: 5000,
      });
      expect(result.structuredContent).toMatchObject({
        dispatchId: 'bac_dispatch_pending',
        matched: true,
        linkedAt: '2026-05-05T12:00:00.000Z',
        thread: {
          threadId: 'bac_thread_linked',
          threadUrl: 'https://chatgpt.com/c/linked',
          title: 'Captured chat',
          provider: 'chatgpt',
        },
        resources: {
          turns: 'sidetrack://thread/bac_thread_linked/turns',
          markdown: 'sidetrack://thread/bac_thread_linked/markdown',
        },
        latestAssistantTurn: {
          ordinal: 0,
          text: 'Captured assistant body.',
        },
        reason: 'matched',
      });
    } finally {
      await client.close();
    }
  });
});

// `bac.create_annotation` was deleted in Phase 1.4a. The typed
// replacement `sidetrack.annotations.create_batch` (covered above)
// supersedes both single-create and the four-call-per-page pattern.
