/**
 * End-to-end: a coding agent (Codex / Claude Code / etc.) receives
 * a lean Sidetrack handoff prompt — `sidetrack_thread_id` + an MCP
 * endpoint — and pulls every piece of context it needs over the
 * tool channel. The test simulates that agent: it parses the prompt,
 * connects an MCP SDK client to the WebSocket transport, and walks
 * the canonical sequence of tool calls.
 *
 * Why this exists:
 *   - The previous handoff packet duplicated thread URL, provider,
 *     full HTTP fallback, tools list, and a frozen turn snapshot
 *     into the prompt. That's redundant — everything is reachable
 *     over MCP — and it leaks the chat URL into anyone the user
 *     shares the prompt with. The new packet ships only the
 *     thread_id + MCP endpoint; this test proves an agent can
 *     fully act on that.
 *   - "Walk the agent flow" is the contract the prompt promises
 *     ("call tools/list to see what's available; bac.read_thread_md
 *     returns the conversation body"). The test asserts each step
 *     of that contract behaves end-to-end.
 *
 * The test is fully automated: no live browser, no live companion
 * binary. It uses an in-memory CompanionWriteClient + an in-memory
 * SidetrackMcpReader against a seeded LiveVaultSnapshot, plus the
 * real WebSocket MCP transport so the wire-level protocol is
 * exercised.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSidetrackMcpServer,
  type CompanionWriteClient,
  type SidetrackMcpReader,
} from '../server/mcpServer.js';
import {
  startWebSocketMcpServer,
  type StartedWebSocketMcpServer,
} from '../server/websocketServer.js';
import type { LiveVaultSnapshot } from '../vault/liveVaultReader.js';

// ────────────────── Seed data ──────────────────
//
// One workstream ("Recall infra"), two threads (the agent's target
// + a related neighbour), one prior dispatch from the user, one
// pinned annotation, one captured turn. Tiny but covers every
// surface a Codex agent would care about on first connect.

const NOW = '2026-05-05T12:00:00.000Z';
const TARGET_THREAD_ID = 'bac_thread_target';
const NEIGHBOUR_THREAD_ID = 'bac_thread_neighbour';
const WORKSTREAM_ID = 'bac_ws_recall_infra';

const snapshot: LiveVaultSnapshot = {
  workstreams: [
    {
      bac_id: WORKSTREAM_ID,
      revision: 'rev_ws_1',
      title: 'Recall infra',
      children: [],
      tags: [],
      checklist: [],
      privacy: 'private',
      updatedAt: NOW,
    },
  ],
  threads: [
    {
      bac_id: TARGET_THREAD_ID,
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/target-thread',
      title: 'Recall index lifecycle',
      lastSeenAt: NOW,
      status: 'active',
      trackingMode: 'manual',
      primaryWorkstreamId: WORKSTREAM_ID,
    },
    {
      bac_id: NEIGHBOUR_THREAD_ID,
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/neighbour-thread',
      title: 'Recall query path',
      lastSeenAt: NOW,
      status: 'active',
      trackingMode: 'manual',
      primaryWorkstreamId: WORKSTREAM_ID,
    },
  ],
  queueItems: [],
  reminders: [],
  events: [],
  generatedAt: NOW,
};

// Strict readDispatches / readTurns types want fully-fleshed records;
// for this end-to-end we only care that the MCP wire surface returns
// non-empty, so we cast through `unknown` rather than fabricate every
// nested field. Production paths read from the real vault and don't
// hit this codepath.
const reader: SidetrackMcpReader = {
  readSnapshot: vi.fn(() => Promise.resolve(snapshot)),
  readCodingSessions: vi.fn(() => Promise.resolve([])),
  readDispatches: vi.fn(
    () =>
      Promise.resolve({
        data: [
          {
            bac_id: 'disp_prior',
            sourceThreadId: TARGET_THREAD_ID,
            target: 'codex',
            createdAt: NOW,
            title: 'Recall index lifecycle',
            body: 'Earlier dispatch summarising the lifecycle problem.',
          },
        ],
      }) as unknown as ReturnType<SidetrackMcpReader['readDispatches']>,
  ),
  readReviews: vi.fn(() => Promise.resolve({ data: [] })),
  readTurns: vi.fn(
    () =>
      Promise.resolve({
        data: [
          {
            bac_id: TARGET_THREAD_ID,
            ordinal: 0,
            role: 'user' as const,
            text: 'How do we keep the recall index in sync after captures?',
            capturedAt: NOW,
          },
          {
            bac_id: TARGET_THREAD_ID,
            ordinal: 1,
            role: 'assistant' as const,
            text: 'Background indexing per turn + a periodic GC sweep.',
            capturedAt: NOW,
          },
        ],
      }) as unknown as ReturnType<SidetrackMcpReader['readTurns']>,
  ),
};

// ────────────────── Fake companion write client ──────────────────
//
// The agent doesn't usually write back, but the test covers
// `bac.queue_item` so we know the round trip works for write tools
// too. Recorded calls let us assert what the agent sent.

const writeClient: CompanionWriteClient & {
  readonly recordedCalls: { readonly tool: string; readonly input: unknown }[];
} = (() => {
  const recordedCalls: { readonly tool: string; readonly input: unknown }[] = [];
  return {
    recordedCalls,
    registerCodingSession: () =>
      Promise.reject(new Error('not exercised in this test')),
    moveThread: () =>
      Promise.reject(new Error('not exercised in this test')),
    createQueueItem: (input) => {
      recordedCalls.push({ tool: 'createQueueItem', input });
      return Promise.resolve({ bac_id: 'bac_queue_followup', revision: 'rev_q_1' });
    },
    bumpWorkstream: () =>
      Promise.reject(new Error('not exercised in this test')),
    archiveThread: () =>
      Promise.reject(new Error('not exercised in this test')),
    unarchiveThread: () =>
      Promise.reject(new Error('not exercised in this test')),
    updateAnnotation: () => Promise.resolve({}),
    deleteAnnotation: () => Promise.resolve({}),
    listDispatches: () =>
      Promise.resolve([
        {
          bac_id: 'disp_prior',
          sourceThreadId: TARGET_THREAD_ID,
          target: 'codex',
          createdAt: NOW,
          title: 'Recall index lifecycle',
          body: 'Earlier dispatch summarising the lifecycle problem.',
        },
      ]),
    listAuditEvents: () =>
      Promise.resolve([
        {
          bac_id: 'audit_1',
          eventType: 'thread.move',
          timestamp: NOW,
          summary: 'Thread filed into Recall infra workstream.',
        },
      ]),
    listAnnotations: () =>
      Promise.resolve([
        {
          bac_id: 'ann_1',
          threadId: TARGET_THREAD_ID,
          quote: 'Background indexing per turn',
          note: 'Hot path — make sure this stays under 50ms.',
          createdAt: NOW,
        },
      ]),
    readThreadMarkdown: (input) =>
      Promise.resolve({
        bac_id: input.bac_id,
        markdown: [
          '---',
          'title: Recall index lifecycle',
          'workstream: Recall infra',
          '---',
          '',
          '## User',
          'How do we keep the recall index in sync after captures?',
          '',
          '## Assistant',
          'Background indexing per turn + a periodic GC sweep.',
          '',
        ].join('\n'),
      }),
    readWorkstreamMarkdown: (input) =>
      Promise.resolve({
        bac_id: input.bac_id,
        markdown: '# Recall infra\n\nWorkstream notes.\n',
      }),
    recall: (input) => {
      // Simple match: return the neighbour thread when query
      // contains "recall". Tests the "find related context"
      // step of the Codex flow.
      if (/recall/i.test(input.query)) {
        return Promise.resolve([
          {
            id: `${NEIGHBOUR_THREAD_ID}:0`,
            threadId: NEIGHBOUR_THREAD_ID,
            score: 0.62,
            title: 'Recall query path',
            threadUrl: 'https://chatgpt.com/c/neighbour-thread',
            capturedAt: NOW,
          },
        ]);
      }
      return Promise.resolve([]);
    },
    suggestWorkstream: () => Promise.resolve([]),
    exportSettings: () => Promise.resolve({}),
    listBuckets: () => Promise.resolve([]),
    systemHealth: () => Promise.resolve({ status: 'ok' }),
    systemUpdateCheck: () => Promise.resolve({ status: 'current' }),
    listWorkstreamNotes: () => Promise.resolve([]),
  };
})();

// ────────────────── Lean handoff prompt ──────────────────
//
// Mirrors what extension's PacketComposer / App.tsx produces. The
// agent parses just two fields out: `sidetrack_thread_id` and
// `sidetrack_mcp`. Anything else is intentionally absent — the
// agent must reach for it via MCP.

const buildLeanHandoff = (
  threadId: string,
  mcpEndpoint: string,
  ask: string,
): string =>
  [
    '# Coding handoff: Recall index lifecycle',
    '',
    `sidetrack_thread_id: ${threadId}`,
    `sidetrack_mcp: ${mcpEndpoint}`,
    '',
    'The Sidetrack companion is running locally and exposes the thread\'s',
    'full context (markdown, dispatches, annotations, recall) over MCP.',
    'Connect to the endpoint above and call `tools/list` to see what\'s',
    'available; `bac.read_thread_md` returns the conversation body.',
    '',
    '## User\'s ask',
    ask,
  ].join('\n');

const parseHandoffPrompt = (prompt: string): {
  readonly threadId: string;
  readonly mcpEndpoint: string;
  readonly ask: string;
} => {
  const threadIdMatch = /sidetrack_thread_id:\s*(\S+)/.exec(prompt);
  const mcpMatch = /sidetrack_mcp:\s*(\S+)/.exec(prompt);
  const askMatch = /## User's ask\n([\s\S]+)$/m.exec(prompt);
  if (threadIdMatch === null || mcpMatch === null) {
    throw new Error('handoff prompt missing required fields');
  }
  return {
    threadId: threadIdMatch[1] ?? '',
    mcpEndpoint: mcpMatch[1] ?? '',
    ask: askMatch?.[1]?.trim() ?? '',
  };
};

// ────────────────── Test harness ──────────────────

const startedServers: StartedWebSocketMcpServer[] = [];

afterEach(async () => {
  await Promise.all(startedServers.splice(0).map((server) => server.close()));
});

const startServer = async (): Promise<StartedWebSocketMcpServer> => {
  const started = await startWebSocketMcpServer({
    port: 0,
    createServer: () => createSidetrackMcpServer(reader, writeClient),
  });
  startedServers.push(started);
  return started;
};

// Helper: extract the structured payload from a tools/call response.
// MCP's CallToolResult is a discriminated union; we just need the
// `structuredContent` field on success. Returns unknown so the
// caller casts at the assertion site.
const structured = (result: unknown): unknown => {
  if (
    typeof result === 'object' &&
    result !== null &&
    'structuredContent' in result
  ) {
    return (result as { readonly structuredContent: unknown }).structuredContent;
  }
  throw new Error('tools/call response missing structuredContent');
};

// ────────────────── The E2E ──────────────────

describe('codex handoff over MCP', () => {
  it('lean prompt carries only thread_id + mcp endpoint + ask (nothing else)', () => {
    const prompt = buildLeanHandoff(
      TARGET_THREAD_ID,
      'ws://127.0.0.1:8721/mcp?token=local',
      'Reduce the recall drift to under 10 turns.',
    );
    // Negative assertions: the prompt must not leak provider URL,
    // chat URL, full turn snapshots, or the verbose tools list that
    // the older packet shipped with.
    expect(prompt).not.toContain('https://chatgpt.com');
    expect(prompt).not.toContain('threadUrl');
    expect(prompt).not.toContain('Tools you can call');
    expect(prompt).not.toContain('Snapshot of the captured turns');
    expect(prompt).not.toContain('HTTP fallback');
    // Positive assertions: the agent has exactly what it needs.
    expect(prompt).toContain(`sidetrack_thread_id: ${TARGET_THREAD_ID}`);
    expect(prompt).toContain('sidetrack_mcp: ws://127.0.0.1:8721/mcp?token=local');
    expect(prompt).toContain('## User\'s ask');
  });

  it('agent connects to MCP, discovers tools, and walks the canonical handoff flow', async () => {
    const started = await startServer();
    const prompt = buildLeanHandoff(
      TARGET_THREAD_ID,
      started.url,
      'Summarise what we know about the recall lifecycle and queue a follow-up note.',
    );
    // Step 1 — the agent parses the prompt.
    const { threadId, mcpEndpoint, ask } = parseHandoffPrompt(prompt);
    expect(threadId).toBe(TARGET_THREAD_ID);
    expect(mcpEndpoint).toBe(started.url);
    expect(ask).toContain('queue a follow-up');

    const client = new Client({ name: 'codex-handoff-e2e', version: '0.0.0' });
    await client.connect(new WebSocketClientTransport(new URL(mcpEndpoint)));
    try {
      // Step 2 — discover available tools (the prompt says to do this).
      const tools = await client.listTools();
      const advertised = tools.tools.map((t) => t.name);
      expect(advertised).toEqual(
        expect.arrayContaining([
          'bac.read_thread_md',
          'bac.list_dispatches',
          'bac.list_annotations',
          'bac.recall',
          'bac.queue_item',
        ]),
      );

      // Step 3 — fetch the thread body. This is the agent's first
      // real "what am I working on?" call.
      const threadMd = await client.callTool({
        name: 'bac.read_thread_md',
        arguments: { bac_id: threadId },
      });
      const threadBody = structured(threadMd) as { readonly markdown?: string };
      expect(threadBody.markdown).toContain('Recall index lifecycle');
      expect(threadBody.markdown).toContain('Background indexing per turn');

      // Step 4 — see what's been shipped before, so the agent
      // doesn't repeat earlier work.
      const dispatches = await client.callTool({
        name: 'bac.list_dispatches',
        arguments: { limit: 5 },
      });
      const dispatchData = structured(dispatches) as {
        readonly data?: readonly { readonly title?: string }[];
      };
      expect(dispatchData.data?.length ?? 0).toBeGreaterThan(0);
      expect(dispatchData.data?.[0]?.title).toContain('Recall index');

      // Step 5 — pull user-pinned annotations on the source URL so
      // the agent's summary respects what the user marked as
      // important. Server returns { data: [...] }.
      const annotations = await client.callTool({
        name: 'bac.list_annotations',
        arguments: { url: snapshot.threads[0]?.threadUrl ?? '' },
      });
      const annData = structured(annotations) as {
        readonly data?: readonly { readonly note?: string }[];
      };
      expect(annData.data?.[0]?.note).toContain('Hot path');

      // Step 6 — find related threads via recall, so the agent can
      // pull cross-thread context if needed. Server returns
      // { data: [...] } where each item has threadId.
      const related = await client.callTool({
        name: 'bac.recall',
        arguments: { query: 'recall index lifecycle drift', limit: 3 },
      });
      const recallData = structured(related) as {
        readonly data?: readonly { readonly threadId?: string }[];
      };
      expect(recallData.data?.[0]?.threadId).toBe(NEIGHBOUR_THREAD_ID);

      // Step 7 — the agent writes back: queue a follow-up that
      // says "I summarised the lifecycle for the user." This is
      // the only write the agent does in this flow.
      const queued = await client.callTool({
        name: 'bac.queue_item',
        arguments: {
          scope: 'thread',
          targetId: threadId,
          text: 'Codex summary: indexing per turn + GC sweep keep drift bounded.',
        },
      });
      const queuedData = structured(queued) as { readonly bac_id?: string };
      expect(queuedData.bac_id).toBe('bac_queue_followup');
      expect(writeClient.recordedCalls).toHaveLength(1);
      expect(writeClient.recordedCalls[0]?.tool).toBe('createQueueItem');
    } finally {
      await client.close();
    }
  });

  it('rejects malformed handoff prompts', () => {
    expect(() => parseHandoffPrompt('garbage')).toThrow(/missing required fields/);
  });
});
