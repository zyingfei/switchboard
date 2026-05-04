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
  it('reports bac.list_dispatches unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'bac.list_dispatches',
        arguments: { limit: 5 },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/bac\.list_dispatches is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes limit and since through for bac.list_dispatches', async () => {
    const companionClient = buildFakeCompanionClient({
      listDispatches: vi.fn(() =>
        Promise.resolve([{ bac_id: 'disp_1', createdAt: '2026-04-26T22:00:00.000Z' }]),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'bac.list_dispatches',
        arguments: { limit: 10, since: '2026-04-26T00:00:00.000Z' },
      });
      expect(companionClient.listDispatches).toHaveBeenCalledWith({
        limit: 10,
        since: '2026-04-26T00:00:00.000Z',
      });
      expect(result.structuredContent).toEqual({
        data: [{ bac_id: 'disp_1', createdAt: '2026-04-26T22:00:00.000Z' }],
      });
    } finally {
      await client.close();
    }
  });

  it('reports bac.list_audit_events unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'bac.list_audit_events',
        arguments: { limit: 5 },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/bac\.list_audit_events is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes limit and since through for bac.list_audit_events', async () => {
    const companionClient = buildFakeCompanionClient({
      listAuditEvents: vi.fn(() =>
        Promise.resolve([{ route: 'recordDispatch', timestamp: '2026-04-26T22:00:00.000Z' }]),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'bac.list_audit_events',
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

  it('reports bac.list_workstream_notes unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'bac.list_workstream_notes',
        arguments: { workstreamId: 'bac_ws_1' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/bac\.list_workstream_notes is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes workstreamId through for bac.list_workstream_notes', async () => {
    const companionClient = buildFakeCompanionClient({
      listWorkstreamNotes: vi.fn(() =>
        Promise.resolve([{ workstreamId: 'bac_ws_1', notePath: 'note.md' }]),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'bac.list_workstream_notes',
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

  it('reports bac.list_annotations unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'bac.list_annotations',
        arguments: { url: 'https://example.test/page' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/bac\.list_annotations is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes url and limit through for bac.list_annotations', async () => {
    const companionClient = buildFakeCompanionClient({
      listAnnotations: vi.fn(() =>
        Promise.resolve([{ bac_id: 'bac_ann_1', url: 'https://example.test/page' }]),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'bac.list_annotations',
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

  it('reports bac.recall unavailable when no companion read client is wired', async () => {
    const client = await startInProcessServer();
    try {
      const result = await client.callTool({
        name: 'bac.recall',
        arguments: { query: 'migration plans' },
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/bac\.recall is unavailable/);
    } finally {
      await client.close();
    }
  });

  it('passes query options through for bac.recall', async () => {
    const companionClient = buildFakeCompanionClient({
      recall: vi.fn(() => Promise.resolve([{ id: 'turn_1', score: 0.9 }])),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'bac.recall',
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

  it('passes thread options through for bac.suggest_workstream', async () => {
    const companionClient = buildFakeCompanionClient({
      suggestWorkstream: vi.fn(() => Promise.resolve([{ workstreamId: 'bac_ws_1', score: 0.8 }])),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({
        name: 'bac.suggest_workstream',
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

  it('returns portable settings export via bac.export_settings', async () => {
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
      const result = await client.callTool({ name: 'bac.export_settings', arguments: {} });
      expect(companionClient.exportSettings).toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ schemaVersion: 1 });
    } finally {
      await client.close();
    }
  });

  it('returns update advisory via bac.system_update_check', async () => {
    const companionClient = buildFakeCompanionClient({
      systemUpdateCheck: vi.fn(() =>
        Promise.resolve({ current: '0.0.0', latest: '0.1.0', behind: true }),
      ),
    });
    const client = await startInProcessServer(companionClient);
    try {
      const result = await client.callTool({ name: 'bac.system_update_check', arguments: {} });
      expect(companionClient.systemUpdateCheck).toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({ latest: '0.1.0', behind: true });
    } finally {
      await client.close();
    }
  });
});
