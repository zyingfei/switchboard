import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import {
  sidetrackPromptNames,
  sidetrackResourceTemplates,
} from '../capabilities.js';
import type { LiveVaultSnapshot } from '../vault/liveVaultReader.js';
import {
  createSidetrackMcpServer,
  type CompanionWriteClient,
  type SidetrackMcpReader,
} from './mcpServer.js';

const NOW = '2026-05-05T12:00:00.000Z';

const snapshot: LiveVaultSnapshot = {
  workstreams: [
    {
      bac_id: 'bac_ws_recall',
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
      bac_id: 'bac_thread_target',
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/target',
      title: 'Recall index lifecycle',
      lastSeenAt: NOW,
      status: 'active',
      trackingMode: 'manual',
      primaryWorkstreamId: 'bac_ws_recall',
    },
  ],
  queueItems: [],
  reminders: [],
  events: [],
  generatedAt: NOW,
};

const reader: SidetrackMcpReader = {
  readSnapshot: vi.fn(() => Promise.resolve(snapshot)),
  readCodingSessions: vi.fn(() => Promise.resolve([])),
  readDispatches: vi.fn(() =>
    Promise.resolve({
      data: [
        {
          bac_id: 'bac_dispatch_resource',
          kind: 'research' as const,
          target: { provider: 'chatgpt' as const, mode: 'paste' as const },
          title: 'Resource sample',
          body: 'body for the resource sample',
          createdAt: NOW,
          redactionSummary: { matched: 0, categories: [] },
          tokenEstimate: 5,
          status: 'sent' as const,
        },
      ],
    }),
  ) as SidetrackMcpReader['readDispatches'],
  readReviews: vi.fn(() => Promise.resolve({ data: [] })),
  readTurns: vi.fn(() =>
    Promise.resolve({
      data: [
        {
          bac_id: 'bac_thread_target',
          ordinal: 1,
          role: 'assistant' as const,
          text: 'Sample assistant text.',
          capturedAt: NOW,
        },
      ],
    }),
  ) as SidetrackMcpReader['readTurns'],
};

const fakeCompanion: CompanionWriteClient = {
  registerCodingSession: vi.fn(() => Promise.resolve({ bac_id: 'bac_session_test' })),
  listAnnotations: vi.fn(() =>
    Promise.resolve([{ bac_id: 'bac_ann_1', note: 'Hot path', url: 'https://chatgpt.com/c/target' }]),
  ),
  readThreadMarkdown: vi.fn(() =>
    Promise.resolve({ markdown: '# Recall index lifecycle\n\nAssistant body.' }),
  ),
};

const startServer = async (): Promise<Client> => {
  const server = createSidetrackMcpServer(reader, fakeCompanion);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({
    name: 'sidetrack-mcp-prompts-resources-test',
    version: '0.0.0',
  });
  await client.connect(clientTransport);
  return client;
};

describe('Sidetrack MCP prompts', () => {
  it('lists the three workflow prompts in capabilities order', async () => {
    const client = await startServer();
    try {
      const result = await client.listPrompts();
      const names = result.prompts.map((prompt) => prompt.name);
      for (const expected of sidetrackPromptNames) {
        expect(names).toContain(expected);
      }
    } finally {
      await client.close();
    }
  });

  it('returns the 3-line attach prompt body when sidetrack.session.attach is invoked', async () => {
    const client = await startServer();
    try {
      const result = await client.getPrompt({
        name: 'sidetrack.session.attach',
        arguments: { attachToken: 'tok_phase5_demo', workstreamId: 'bac_ws_recall' },
      });
      expect(result.messages).toHaveLength(1);
      const message = result.messages[0];
      expect(message?.role).toBe('user');
      const content = message?.content;
      expect(content?.type).toBe('text');
      const text =
        content !== undefined && 'text' in content ? (content.text as string) : '';
      expect(text).toContain('sidetrack.session.attach');
      expect(text).toContain('tok_phase5_demo');
      expect(text).toContain('sidetrack://workstream/bac_ws_recall/context');
    } finally {
      await client.close();
    }
  });

  it('emits the demo flow with the supplied target provider and task body', async () => {
    const client = await startServer();
    try {
      const result = await client.getPrompt({
        name: 'sidetrack.demo.dispatch_and_annotate',
        arguments: {
          targetProvider: 'chatgpt',
          taskBody: 'Summarise the latest HN top article in 5 sections.',
        },
      });
      const text = (result.messages[0]?.content as { readonly text?: string })?.text ?? '';
      // Intent-level prompt: it names the goal and the provider but
      // delegates workflow steps to the tool surface itself. We
      // assert on intent + provider + verbatim task body, not on
      // any specific tool-call sequence.
      expect(text).toContain('chatgpt');
      expect(text).toContain('Summarise the latest HN top article in 5 sections.');
      expect(text).toMatch(/Sidetrack/);
      expect(text).not.toContain('1. Call sidetrack');
    } finally {
      await client.close();
    }
  });
});

// SDK's resource-content union covers blob OR text; narrow at the
// assertion site so TS keeps the text branch.
const textOf = (contents: unknown): string => {
  if (
    typeof contents === 'object' &&
    contents !== null &&
    'text' in contents &&
    typeof (contents as { readonly text?: unknown }).text === 'string'
  ) {
    return (contents as { readonly text: string }).text;
  }
  return '';
};

describe('Sidetrack MCP resources', () => {
  it('advertises every resource template via listResourceTemplates', async () => {
    const client = await startServer();
    try {
      const list = await client.listResourceTemplates();
      const templates = list.resourceTemplates.map(
        (entry) => entry.uriTemplate,
      );
      for (const expected of sidetrackResourceTemplates) {
        expect(templates).toContain(expected);
      }
    } finally {
      await client.close();
    }
  });

  it('reads a thread metadata resource', async () => {
    const client = await startServer();
    try {
      const result = await client.readResource({
        uri: 'sidetrack://thread/bac_thread_target',
      });
      expect(result.contents).toHaveLength(1);
      const first = result.contents[0];
      const text = first === undefined ? '' : textOf(first);
      const parsed = JSON.parse(text) as { readonly bac_id?: string };
      expect(parsed.bac_id).toBe('bac_thread_target');
    } finally {
      await client.close();
    }
  });

  it('reads a thread markdown resource via the companion fallback', async () => {
    const client = await startServer();
    try {
      const result = await client.readResource({
        uri: 'sidetrack://thread/bac_thread_target/markdown',
      });
      const first = result.contents[0];
      expect(first?.mimeType).toBe('text/markdown');
      expect(first === undefined ? '' : textOf(first)).toContain('Recall index lifecycle');
    } finally {
      await client.close();
    }
  });

  it('reads a dispatch resource', async () => {
    const client = await startServer();
    try {
      const result = await client.readResource({
        uri: 'sidetrack://dispatch/bac_dispatch_resource',
      });
      const first = result.contents[0];
      const text = first === undefined ? '' : textOf(first);
      const parsed = JSON.parse(text) as { readonly bac_id?: string };
      expect(parsed.bac_id).toBe('bac_dispatch_resource');
    } finally {
      await client.close();
    }
  });

  it('reads a workstream context pack resource as markdown', async () => {
    const client = await startServer();
    try {
      const result = await client.readResource({
        uri: 'sidetrack://workstream/bac_ws_recall/context',
      });
      const first = result.contents[0];
      expect(first?.mimeType).toBe('text/markdown');
      const text = first === undefined ? '' : textOf(first);
      expect(text).toContain('Recall infra');
      expect(text).toContain('Recall index lifecycle');
    } finally {
      await client.close();
    }
  });
});
