import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { LiveVaultSnapshot } from '../vault/liveVaultReader.js';
import { createSidetrackMcpServer, type SidetrackMcpReader } from './mcpServer.js';

// In-process tests for the four read-only Connections MCP tools.
// We feed a hand-built snapshot through the reader's
// readConnectionsSnapshot hook and assert each tool responds with
// the expected structuredContent.

const emptySnapshot: LiveVaultSnapshot = {
  workstreams: [],
  threads: [],
  queueItems: [],
  reminders: [],
  events: [],
  generatedAt: '2026-05-07T00:00:00.000Z',
};

const fixture = {
  scope: {},
  nodes: [
    {
      id: 'thread:thread_a',
      kind: 'thread',
      label: 'A',
      originReplicaIds: ['replica-A'],
      metadata: {},
    },
    {
      id: 'workstream:ws_x',
      kind: 'workstream',
      label: 'X',
      originReplicaIds: ['replica-A'],
      metadata: {},
    },
    {
      id: 'dispatch:disp_1',
      kind: 'dispatch',
      label: 'd1',
      originReplicaIds: ['replica-A'],
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'edge:thread_in_workstream:thread:thread_a:workstream:ws_x',
      kind: 'thread_in_workstream',
      fromNodeId: 'thread:thread_a',
      toNodeId: 'workstream:ws_x',
      observedAt: '2026-05-07T10:00:00.000Z',
      producedBy: { source: 'event-log', eventType: 'thread.upserted' },
      confidence: 'explicit',
    },
    {
      id: 'edge:dispatch_reply_landed_in_thread:dispatch:disp_1:thread:thread_a',
      kind: 'dispatch_reply_landed_in_thread',
      fromNodeId: 'dispatch:disp_1',
      toNodeId: 'thread:thread_a',
      observedAt: '2026-05-07T11:00:00.000Z',
      producedBy: { source: 'event-log', eventType: 'dispatch.linked' },
      confidence: 'explicit',
    },
  ],
  updatedAt: '2026-05-07T11:00:00.000Z',
  nodeCount: 3,
  edgeCount: 2,
};

const readerWithSnapshot: SidetrackMcpReader = {
  readSnapshot: () => Promise.resolve(emptySnapshot),
  readCodingSessions: () => Promise.resolve([]),
  readDispatches: () => Promise.resolve({ data: [] }),
  readReviews: () => Promise.resolve({ data: [] }),
  readTurns: () => Promise.resolve({ data: [] }),
  readConnectionsSnapshot: () => Promise.resolve(fixture),
};

const readerWithoutSnapshot: SidetrackMcpReader = {
  readSnapshot: () => Promise.resolve(emptySnapshot),
  readCodingSessions: () => Promise.resolve([]),
  readDispatches: () => Promise.resolve({ data: [] }),
  readReviews: () => Promise.resolve({ data: [] }),
  readTurns: () => Promise.resolve({ data: [] }),
  readConnectionsSnapshot: () => Promise.resolve(null),
};

const startInProcess = async (reader: SidetrackMcpReader): Promise<Client> => {
  const server = createSidetrackMcpServer(reader);
  const [s, c] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 'connections-tools-test', version: '0.0.0' });
  await client.connect(c);
  return client;
};

describe('connections MCP tools', () => {
  it('tools/list includes the 4 connections tools', async () => {
    const client = await startInProcess(readerWithSnapshot);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain('sidetrack.connections.snapshot');
      expect(names).toContain('sidetrack.connections.neighbors');
      expect(names).toContain('sidetrack.connections.edge');
      expect(names).toContain('sidetrack.connections.find_path');
    } finally {
      await client.close();
    }
  });

  it('snapshot returns the projected graph', async () => {
    const client = await startInProcess(readerWithSnapshot);
    try {
      const r = await client.callTool({ name: 'sidetrack.connections.snapshot', arguments: {} });
      expect(r.structuredContent).toMatchObject({
        scope: 'companion-extended',
        snapshot: { nodeCount: 3, edgeCount: 2 },
      });
    } finally {
      await client.close();
    }
  });

  it('snapshot with workstreamId filter narrows correctly', async () => {
    const client = await startInProcess(readerWithSnapshot);
    try {
      const r = await client.callTool({
        name: 'sidetrack.connections.snapshot',
        arguments: { workstreamId: 'ws_x' },
      });
      const ids = (
        r.structuredContent as {
          snapshot: { nodes: { id: string }[] };
        }
      ).snapshot.nodes.map((n) => n.id);
      expect(ids).toContain('workstream:ws_x');
      expect(ids).toContain('thread:thread_a');
    } finally {
      await client.close();
    }
  });

  it('snapshot returns empty + note when no current.json', async () => {
    const client = await startInProcess(readerWithoutSnapshot);
    try {
      const r = await client.callTool({ name: 'sidetrack.connections.snapshot', arguments: {} });
      const sc = r.structuredContent as { note?: string; snapshot: { nodeCount: number } };
      expect(sc.note).toContain('No connections snapshot yet');
      expect(sc.snapshot.nodeCount).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('neighbors hops=1 returns the immediate neighbors', async () => {
    const client = await startInProcess(readerWithSnapshot);
    try {
      const r = await client.callTool({
        name: 'sidetrack.connections.neighbors',
        arguments: { nodeId: 'thread:thread_a', hops: 1 },
      });
      const ids = (
        r.structuredContent as {
          snapshot: { nodes: { id: string }[] };
        }
      ).snapshot.nodes
        .map((n) => n.id)
        .sort();
      expect(ids).toEqual(['dispatch:disp_1', 'thread:thread_a', 'workstream:ws_x']);
    } finally {
      await client.close();
    }
  });

  it('edge returns provenance for an existing edge', async () => {
    const client = await startInProcess(readerWithSnapshot);
    try {
      const r = await client.callTool({
        name: 'sidetrack.connections.edge',
        arguments: { edgeId: 'edge:thread_in_workstream:thread:thread_a:workstream:ws_x' },
      });
      const sc = r.structuredContent as {
        found: boolean;
        edge?: { kind: string; producedBy: { source: string; eventType?: string } };
      };
      expect(sc.found).toBe(true);
      expect(sc.edge?.kind).toBe('thread_in_workstream');
      expect(sc.edge?.producedBy.eventType).toBe('thread.upserted');
    } finally {
      await client.close();
    }
  });

  it('edge returns {found:false, reason: edge-not-found} for an unknown edge id', async () => {
    const client = await startInProcess(readerWithSnapshot);
    try {
      const r = await client.callTool({
        name: 'sidetrack.connections.edge',
        arguments: { edgeId: 'edge:does-not-exist' },
      });
      expect(r.structuredContent).toMatchObject({ found: false, reason: 'edge-not-found' });
    } finally {
      await client.close();
    }
  });

  it('find_path finds a path between connected nodes', async () => {
    const client = await startInProcess(readerWithSnapshot);
    try {
      const r = await client.callTool({
        name: 'sidetrack.connections.find_path',
        arguments: { fromNodeId: 'workstream:ws_x', toNodeId: 'dispatch:disp_1' },
      });
      const sc = r.structuredContent as {
        found: boolean;
        nodes?: unknown[];
        edges?: unknown[];
      };
      expect(sc.found).toBe(true);
      expect(sc.nodes?.length).toBeGreaterThanOrEqual(2);
      expect(sc.edges?.length).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
    }
  });

  it('find_path returns {found:false} when nodes are disconnected', async () => {
    const client = await startInProcess(readerWithSnapshot);
    try {
      const r = await client.callTool({
        name: 'sidetrack.connections.find_path',
        arguments: { fromNodeId: 'thread:thread_a', toNodeId: 'thread:nonexistent' },
      });
      expect(r.structuredContent).toMatchObject({ found: false });
    } finally {
      await client.close();
    }
  });
});
