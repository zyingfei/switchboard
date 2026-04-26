import { describe, expect, it } from 'vitest';
import { buildContextPack } from '../../src/context/contextPack';
import type { WorkstreamEvent, WorkstreamNode } from '../../src/graph/model';
import {
  BAC_MCP_TOOL_DEFINITIONS,
  type BacContextPackResponse,
  type BacRecentThreadsResponse,
  type BacSearchResponse,
  type BacToolCallParams,
  type BacWorkstreamResponse,
  type McpJsonToolResult,
  type McpTextToolResult,
} from '../../src/mcp/contract';
import { handleMcpRequest } from '../../src/mcp/server';
import { findDejaVuHits } from '../../src/recall/dejaVu';
import { classifyThreadTab } from '../../src/registry/threadRegistry';
import { buildVaultProjection } from '../../src/vault/projection';

const at = '2026-04-25T12:00:00.000Z';

const readJsonResult = <TValue>(result: unknown): TValue => {
  const content = (result as McpJsonToolResult<TValue>).content;
  expect(content[0]?.type).toBe('json');
  const first = content[0];
  if (!first || first.type !== 'json') {
    throw new Error('Expected JSON MCP tool result');
  }
  return first.json;
};

const readTextResult = <TValue>(result: unknown): McpTextToolResult<TValue> => {
  const toolResult = result as McpTextToolResult<TValue>;
  expect(toolResult.content[0]?.type).toBe('text');
  return toolResult;
};

describe('thread registry, vault projection, context pack, recall, and MCP POCs', () => {
  it('classifies fixture thread tabs for Where Was I', () => {
    const entry = classifyThreadTab(
      {
        id: 7,
        title: 'Fixture',
        url: 'chrome-extension://abc/thread-fixture.html?provider=claude&title=Auth+refactor&status=waiting_on_ai&lastSpeaker=user',
        status: 'complete',
      },
      at,
    );

    expect(entry).toMatchObject({
      provider: 'claude',
      title: 'Auth refactor',
      status: 'waiting_on_ai',
      lastSpeaker: 'user',
      selectorCanary: 'passed',
      tabId: 7,
    });
  });

  it('builds canonical vault projection files', () => {
    const note = {
      id: 'note_1',
      type: 'note',
      title: 'Local markdown note',
      content: '# Plan\nShip the switchboard.',
      createdAt: at,
      updatedAt: at,
    } satisfies WorkstreamNode;
    const event = {
      id: 'event_1',
      type: 'note.created',
      entityId: note.id,
      createdAt: at,
    } satisfies WorkstreamEvent;

    const projection = buildVaultProjection({
      nodes: [note],
      edges: [],
      promptRuns: [],
      events: [event],
      threadRegistry: [],
      generatedAt: at,
    });

    expect(projection.files.map((file) => file.path)).toEqual([
      '_BAC/events/2026-04-25.jsonl',
      '_BAC/workstreams/current.md',
      '_BAC/where-was-i.base',
    ]);
    expect(projection.files[0]?.content).toContain('"note.created"');
    expect(projection.files[1]?.content).toContain('bac_type: workstream');
  });

  it('builds a Context Pack with an event-log slice', () => {
    const pack = buildContextPack({
      note: {
        id: 'note_1',
        type: 'note',
        title: 'Local markdown note',
        content: '# Context Pack\nHandoff this work.',
        createdAt: at,
        updatedAt: at,
      },
      responses: [],
      sources: [],
      promptRuns: [],
      events: [{ id: 'event_1', type: 'note.created', createdAt: at }],
      threadRegistry: [],
      generatedAt: at,
    });

    expect(pack.markdown).toContain('# BAC Context Pack');
    expect(pack.markdown).toContain('Signed Event Log Slice');
    expect(pack.eventLogSlice).toContain('"note.created"');
  });

  it('includes adopted sources in Context Packs', () => {
    const pack = buildContextPack({
      note: null,
      responses: [],
      sources: [
        {
          id: 'source_1',
          type: 'source',
          title: 'Existing tab',
          url: 'https://example.com/research',
          createdAt: at,
          updatedAt: at,
        },
      ],
      promptRuns: [],
      events: [],
      threadRegistry: [],
      generatedAt: at,
    });

    expect(pack.markdown).toContain('Adopted Sources');
    expect(pack.markdown).toContain('https://example.com/research');
  });

  it('finds calibrated déjà-vu hits with lexical similarity', () => {
    const hits = findDejaVuHits(
      'local-first workstream switchboard memory',
      [
        {
          id: 'response_1',
          type: 'chat_response',
          title: 'Claude response',
          content: 'A local-first workstream switchboard should remember research context.',
          provider: 'claude',
          createdAt: '2026-04-14T12:00:00.000Z',
          updatedAt: '2026-04-14T12:00:00.000Z',
        },
      ],
      new Date(at),
    );

    expect(hits[0]).toMatchObject({
      nodeId: 'response_1',
      provider: 'claude',
      ageDays: 11,
    });
    expect(hits[0]?.score).toBeGreaterThan(0.3);
  });

  it('serves read-only MCP tools over JSON-RPC core from the typed contract', () => {
    const thread = {
      id: 'claude:7',
      provider: 'claude',
      title: 'Auth refactor',
      url: 'chrome-extension://abc/thread-fixture.html',
      tabId: 7,
      lastSpeaker: 'user',
      status: 'waiting_on_ai',
      selectorCanary: 'passed',
      updatedAt: at,
    } as const;
    const note = {
      id: 'note_1',
      type: 'note',
      title: 'Local markdown note',
      content: '# Local-first workstream switchboard\nRemember research context.',
      createdAt: '2026-04-14T12:00:00.000Z',
      updatedAt: '2026-04-14T12:00:00.000Z',
    } satisfies WorkstreamNode;
    const runtimeData = {
      nodes: [note],
      promptRuns: [],
      events: [{ id: 'event_1', type: 'note.created', createdAt: at }],
      threadRegistry: [thread],
      generatedAt: at,
    };
    const list = handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      runtimeData,
    );
    const recentThreadsParams = {
      name: 'bac.recent_threads',
      arguments: { limit: 1 },
    } satisfies BacToolCallParams<'bac.recent_threads'>;
    const recentThreads = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: recentThreadsParams,
      },
      runtimeData,
    );
    const workstreamParams = {
      name: 'bac.workstream',
      arguments: { includeEvents: true },
    } satisfies BacToolCallParams<'bac.workstream'>;
    const workstream = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: workstreamParams,
      },
      runtimeData,
    );
    const contextPackParams = {
      name: 'bac.context_pack',
      arguments: {},
    } satisfies BacToolCallParams<'bac.context_pack'>;
    const contextPack = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: contextPackParams,
      },
      runtimeData,
    );
    const searchParams = {
      name: 'bac.search',
      arguments: {
        query: 'local-first workstream switchboard memory',
        minAgeDays: 3,
        maxAgeDays: 21,
      },
    } satisfies BacToolCallParams<'bac.search'>;
    const search = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: searchParams,
      },
      runtimeData,
    );
    const recallParams = {
      name: 'bac.recall',
      arguments: {
        query: 'calibrated freshness memory',
        recencyWindow: '3w',
        topK: 3,
      },
    } satisfies BacToolCallParams<'bac.recall'>;
    const recall = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: recallParams,
      },
      runtimeData,
    );

    expect((list.result as { tools: typeof BAC_MCP_TOOL_DEFINITIONS }).tools.map((tool) => tool.name)).toEqual(
      BAC_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
    expect(readJsonResult<BacRecentThreadsResponse>(recentThreads.result).threads[0]?.title).toBe('Auth refactor');
    expect(readJsonResult<BacWorkstreamResponse>(workstream.result).events).toHaveLength(1);
    expect(readTextResult<BacContextPackResponse>(contextPack.result).structuredContent.pack.markdown).toContain(
      '# BAC Context Pack',
    );
    expect(readJsonResult<BacSearchResponse>(search.result).hits[0]?.nodeId).toBe('note_1');
    expect(recall.error?.message).toContain('poc/recall-vector');
  });
});
