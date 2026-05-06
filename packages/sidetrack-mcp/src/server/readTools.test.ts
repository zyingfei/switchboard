import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import type { LiveVaultSnapshot } from '../vault/liveVaultReader.js';
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

const buildFakeCompanionClient = (
  overrides: Partial<CompanionWriteClient> = {},
): CompanionWriteClient => ({
  registerCodingSession: vi.fn(() => Promise.resolve({ bac_id: 'bac_session_fake' })),
  ...overrides,
});

const startInProcessServer = async (companionClient?: CompanionWriteClient): Promise<Client> => {
  const server = createSidetrackMcpServer(fakeReader, companionClient);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'sidetrack-mcp-read-tools-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
};

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

describe('companion-backed read tools', () => {
  // bac.list_dispatches was deleted in Phase 1.4 — sidetrack.dispatches.list
  // (vault-reader-backed) is the canonical replacement and has its own
  // coverage in this file.

  it('reports sidetrack.audit.list unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.audit.list',
        arguments: { limit: 5 },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.audit\.list is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes limit and since through for sidetrack.audit.list', async () => {
    const companionClient = buildFakeCompanionClient({
      listAuditEvents: vi.fn(() =>
        Promise.resolve([{ route: 'recordDispatch', timestamp: '2026-04-26T22:00:00.000Z' }]),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.audit.list',
        arguments: { limit: 7, since: '2026-04-26T00:00:00.000Z' },
      });
      expect(companionClient.listAuditEvents).toHaveBeenCalledWith({
        limit: 7,
        since: '2026-04-26T00:00:00.000Z',
      });
      expect(result.structuredContent).toEqual({
        data: [{ route: 'recordDispatch', timestamp: '2026-04-26T22:00:00.000Z' }],
      });
    } finally {
      await client.close();
    }
  });

  it('reports sidetrack.workstreams.notes unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.workstreams.notes',
        arguments: { workstreamId: 'bac_ws_1' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.workstreams\.notes is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes workstreamId through for sidetrack.workstreams.notes', async () => {
    const companionClient = buildFakeCompanionClient({
      listWorkstreamNotes: vi.fn(() =>
        Promise.resolve([{ workstreamId: 'bac_ws_1', notePath: 'note.md' }]),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.workstreams.notes',
        arguments: { workstreamId: 'bac_ws_1' },
      });
      expect(companionClient.listWorkstreamNotes).toHaveBeenCalledWith({
        workstreamId: 'bac_ws_1',
      });
      expect(result.structuredContent).toEqual({
        items: [{ workstreamId: 'bac_ws_1', notePath: 'note.md' }],
      });
    } finally {
      await client.close();
    }
  });

  it('reports sidetrack.annotations.list unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.annotations.list',
        arguments: { url: 'https://example.test/page' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.annotations\.list is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes url and limit through for sidetrack.annotations.list', async () => {
    const companionClient = buildFakeCompanionClient({
      listAnnotations: vi.fn(() =>
        Promise.resolve([{ bac_id: 'bac_ann_1', url: 'https://example.test/page' }]),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.annotations.list',
        arguments: { url: 'https://example.test/page', limit: 3 },
      });
      expect(companionClient.listAnnotations).toHaveBeenCalledWith({
        url: 'https://example.test/page',
        limit: 3,
      });
      expect(result.structuredContent).toEqual({
        data: [{ bac_id: 'bac_ann_1', url: 'https://example.test/page' }],
      });
    } finally {
      await client.close();
    }
  });

  it('reports sidetrack.recall.query unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'sidetrack.recall.query',
        arguments: { query: 'migration plans' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/sidetrack\.recall\.query is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes query options through for sidetrack.recall.query', async () => {
    const companionClient = buildFakeCompanionClient({
      recall: vi.fn(() => Promise.resolve([{ id: 'turn_1', score: 0.9 }])),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.recall.query',
        arguments: { query: 'migration plans', limit: 5, workstreamId: 'bac_ws_1' },
      });
      expect(companionClient.recall).toHaveBeenCalledWith({
        query: 'migration plans',
        limit: 5,
        workstreamId: 'bac_ws_1',
      });
      expect(result.structuredContent).toEqual({ data: [{ id: 'turn_1', score: 0.9 }] });
    } finally {
      await client.close();
    }
  });

  it('passes thread options through for sidetrack.suggestions.workstream', async () => {
    const companionClient = buildFakeCompanionClient({
      suggestWorkstream: vi.fn(() => Promise.resolve([{ workstreamId: 'bac_ws_1', score: 0.8 }])),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'sidetrack.suggestions.workstream',
        arguments: { threadId: 'bac_thread_1', limit: 2 },
      });
      expect(companionClient.suggestWorkstream).toHaveBeenCalledWith({
        threadId: 'bac_thread_1',
        limit: 2,
      });
      expect(result.structuredContent).toEqual({
        data: [{ workstreamId: 'bac_ws_1', score: 0.8 }],
      });
    } finally {
      await client.close();
    }
  });

  it('returns portable settings export via sidetrack.settings.export', async () => {
    const companionClient = buildFakeCompanionClient({
      exportSettings: vi.fn(() =>
        Promise.resolve({
          schemaVersion: 1,
          exportedAt: '2026-05-03T00:00:00.000Z',
          settings: {},
          workstreams: [],
          templates: [],
        }),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({ name: 'sidetrack.settings.export', arguments: {} });
      expect(companionClient.exportSettings).toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ schemaVersion: 1 });
    } finally {
      await client.close();
    }
  });

  it('returns update advisory via sidetrack.system.update_check', async () => {
    const companionClient = buildFakeCompanionClient({
      systemUpdateCheck: vi.fn(() =>
        Promise.resolve({ current: '0.0.0', latest: '0.1.0', behind: true }),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({ name: 'sidetrack.system.update_check', arguments: {} });
      expect(companionClient.systemUpdateCheck).toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ latest: '0.1.0', behind: true });
    } finally {
      await client.close();
    }
  });

  it('passes annotation write tools through to the companion client', async () => {
    const companionClient = buildFakeCompanionClient({
      updateAnnotation: vi.fn(() => Promise.resolve({ bac_id: 'ann_1', note: 'new' })),
      deleteAnnotation: vi.fn(() => Promise.resolve({ bac_id: 'ann_1', deletedAt: 'now' })),
    });
    const client = await startInProcessServer(companionClient);
    try {
      await expect(
        client.callTool({
          name: 'sidetrack.annotations.update',
          arguments: { bac_id: 'ann_1', note: 'new' },
        }),
      ).resolves.toMatchObject({ structuredContent: { bac_id: 'ann_1', note: 'new' } });
      await expect(
        client.callTool({ name: 'sidetrack.annotations.delete', arguments: { bac_id: 'ann_1' } }),
      ).resolves.toMatchObject({ structuredContent: { bac_id: 'ann_1', deletedAt: 'now' } });
      expect(companionClient.updateAnnotation).toHaveBeenCalledWith({ bac_id: 'ann_1', note: 'new' });
      expect(companionClient.deleteAnnotation).toHaveBeenCalledWith({ bac_id: 'ann_1' });
    } finally {
      await client.close();
    }
  });

  // sidetrack.threads.read_md and sidetrack.workstreams.read_md were
  // deleted in Phase 5. The same content is now read via MCP resources
  // at sidetrack://thread/{threadId}/markdown and
  // sidetrack://workstream/{workstreamId}/context. See
  // promptsResources.test.ts for resource coverage.

  it('passes completed write tools through to the companion client', async () => {
    const companionClient = buildFakeCompanionClient({
      bumpWorkstream: vi.fn(() => Promise.resolve({ bac_id: 'ws_1', revision: '1' })),
      archiveThread: vi.fn(() => Promise.resolve({ bac_id: 'thread_1', revision: '2' })),
      unarchiveThread: vi.fn(() => Promise.resolve({ bac_id: 'thread_1', revision: '3' })),
    });
    const client = await startInProcessServer(companionClient);
    try {
      await client.callTool({ name: 'sidetrack.workstreams.bump', arguments: { bac_id: 'ws_1' } });
      await client.callTool({ name: 'sidetrack.threads.archive', arguments: { bac_id: 'thread_1' } });
      await client.callTool({ name: 'sidetrack.threads.unarchive', arguments: { bac_id: 'thread_1' } });
      expect(companionClient.bumpWorkstream).toHaveBeenCalledWith({ bac_id: 'ws_1' });
      expect(companionClient.archiveThread).toHaveBeenCalledWith({ bac_id: 'thread_1' });
      expect(companionClient.unarchiveThread).toHaveBeenCalledWith({ bac_id: 'thread_1' });
    } finally {
      await client.close();
    }
  });

  it('returns buckets and system health from companion-backed tools', async () => {
    const companionClient = buildFakeCompanionClient({
      listBuckets: vi.fn(() => Promise.resolve([{ id: 'default' }])),
      systemHealth: vi.fn(() => Promise.resolve({ uptimeSec: 1 })),
    });
    const client = await startInProcessServer(companionClient);
    try {
      await expect(client.callTool({ name: 'sidetrack.buckets.list', arguments: {} })).resolves.toMatchObject({
        structuredContent: { items: [{ id: 'default' }] },
      });
      await expect(client.callTool({ name: 'sidetrack.system.health', arguments: {} })).resolves.toMatchObject({
        structuredContent: { uptimeSec: 1 },
      });
    } finally {
      await client.close();
    }
  });
});
