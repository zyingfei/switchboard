import { describe, expect, it } from 'vitest';
import { buildContextPack } from '../../src/context/contextPack';
import type { WorkstreamEvent, WorkstreamNode } from '../../src/graph/model';
import { handleMcpRequest } from '../../src/mcp/server';
import { findDejaVuHits } from '../../src/recall/dejaVu';
import { classifyThreadTab } from '../../src/registry/threadRegistry';
import { buildVaultProjection } from '../../src/vault/projection';

const at = '2026-04-25T12:00:00.000Z';

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

  it('serves read-only MCP tools over JSON-RPC core', () => {
    const list = handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        nodes: [],
        promptRuns: [],
        events: [],
        threadRegistry: [],
        generatedAt: at,
      },
    );
    const call = handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'bac.recent_threads' },
      },
      {
        nodes: [],
        promptRuns: [],
        events: [],
        threadRegistry: [
          {
            id: 'claude:7',
            provider: 'claude',
            title: 'Auth refactor',
            url: 'chrome-extension://abc/thread-fixture.html',
            tabId: 7,
            lastSpeaker: 'user',
            status: 'waiting_on_ai',
            selectorCanary: 'passed',
            updatedAt: at,
          },
        ],
        generatedAt: at,
      },
    );

    expect(JSON.stringify(list.result)).toContain('bac.context_pack');
    expect(JSON.stringify(call.result)).toContain('Auth refactor');
  });
});
