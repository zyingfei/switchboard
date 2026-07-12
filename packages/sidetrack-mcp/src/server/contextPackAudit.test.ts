import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LiveVaultSnapshot } from '../vault/liveVaultReader.js';
import {
  MCP_CONTEXT_PACK_TOOL,
  createFileContextPackAuditSink,
  type ContextPackAuditSink,
} from './contextPackAudit.js';
import { createSidetrackMcpServer, type SidetrackMcpReader } from './mcpServer.js';

const emptySnapshot: LiveVaultSnapshot = {
  workstreams: [],
  threads: [],
  queueItems: [],
  reminders: [],
  events: [],
  generatedAt: '2026-07-12T00:00:00.000Z',
};

const fakeReader: SidetrackMcpReader = {
  readSnapshot: () => Promise.resolve(emptySnapshot),
  readCodingSessions: () => Promise.resolve([]),
  readDispatches: () => Promise.resolve({ data: [] }),
  readReviews: () => Promise.resolve({ data: [] }),
  readTurns: () => Promise.resolve({ data: [] }),
};

const startInProcessServer = async (sink?: ContextPackAuditSink): Promise<Client> => {
  const server = createSidetrackMcpServer(
    fakeReader,
    undefined,
    sink === undefined ? {} : { contextPackAuditSink: sink },
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'sidetrack-mcp-context-pack-audit-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('context_pack §15 audit emit', () => {
  it('invokes the sink with the workstream scope on each context_pack call', async () => {
    const sink = vi.fn<ContextPackAuditSink>(() => Promise.resolve());
    const client = await startInProcessServer(sink);
    cleanups.push(() => client.close());

    const result = await client.callTool({
      name: 'sidetrack.workstreams.context_pack',
      arguments: { workstreamId: 'bac_ws_42' },
    });

    expect(result.isError).not.toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith({ workstreamId: 'bac_ws_42' });
  });

  it('records workstreamId as null for a whole-vault pack', async () => {
    const sink = vi.fn<ContextPackAuditSink>(() => Promise.resolve());
    const client = await startInProcessServer(sink);
    cleanups.push(() => client.close());

    await client.callTool({ name: 'sidetrack.workstreams.context_pack', arguments: {} });

    expect(sink).toHaveBeenCalledWith({ workstreamId: null });
  });

  it('does not emit a sink call when no sink is wired (stdio wiring)', async () => {
    const client = await startInProcessServer();
    cleanups.push(() => client.close());

    const result = await client.callTool({
      name: 'sidetrack.workstreams.context_pack',
      arguments: {},
    });

    // The read still succeeds; the criterion just stays unfalsified for
    // stdio callers (which the PRD does not count).
    expect(result.isError).not.toBe(true);
  });

  it('never fails the read when the sink rejects (best-effort)', async () => {
    const sink = vi.fn<ContextPackAuditSink>(() => Promise.reject(new Error('disk full')));
    const client = await startInProcessServer(sink);
    cleanups.push(() => client.close());

    const result = await client.callTool({
      name: 'sidetrack.workstreams.context_pack',
      arguments: { workstreamId: 'bac_ws_1' },
    });

    expect(result.isError).not.toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe('createFileContextPackAuditSink', () => {
  it('writes a _BAC/audit line the §15 counter can match on tool', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ctxpack-audit-'));
    const now = () => new Date('2026-07-12T09:30:00.000Z');
    const sink = createFileContextPackAuditSink({ vaultRoot, agent: 'mcp:codex', now });

    await sink({ workstreamId: 'bac_ws_7' });

    const auditDir = join(vaultRoot, '_BAC', 'audit');
    const files = await readdir(auditDir);
    expect(files).toContain('2026-07-12.jsonl');

    const body = await readFile(join(auditDir, '2026-07-12.jsonl'), 'utf8');
    const lines = body.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;

    // The load-bearing field: the §15 counter filters on exactly this.
    expect(parsed['tool']).toBe(MCP_CONTEXT_PACK_TOOL);
    expect(parsed['tool']).toBe('sidetrack.workstreams.context_pack');
    expect(parsed['scope']).toBe('bac_ws_7');
    expect(parsed['agent']).toBe('mcp:codex');
    expect(parsed['outcome']).toBe('success');
    expect(typeof parsed['requestId']).toBe('string');
    expect(parsed['timestamp']).toBe('2026-07-12T09:30:00.000Z');
  });

  it('appends (does not clobber) on repeated calls within a day', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ctxpack-audit-'));
    const now = () => new Date('2026-07-12T09:30:00.000Z');
    const sink = createFileContextPackAuditSink({ vaultRoot, now });

    await sink({ workstreamId: null });
    await sink({ workstreamId: 'bac_ws_2' });

    const body = await readFile(join(vaultRoot, '_BAC', 'audit', '2026-07-12.jsonl'), 'utf8');
    const lines = body.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    const tools = lines.map((line) => (JSON.parse(line) as { tool?: unknown }).tool);
    expect(tools).toEqual([MCP_CONTEXT_PACK_TOOL, MCP_CONTEXT_PACK_TOOL]);
  });
});
