import { describe, expect, it } from 'vitest';
import { createMemoryGraphStore } from '../../src/graph/memoryStore';
import { appendEvent } from '../../src/graph/operations';
import type { WorkstreamEdge, WorkstreamNode } from '../../src/graph/model';

describe('graph store', () => {
  it('appends and reads the event log', async () => {
    const store = createMemoryGraphStore();

    await appendEvent(store, 'note.created', 'note_1', { source: 'unit' });
    await appendEvent(store, 'fork.created', 'run_1');

    const events = await store.listEvents();
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.type)).toEqual(['note.created', 'fork.created']);
    expect(events[0]?.payload).toEqual({ source: 'unit' });
  });

  it('creates graph nodes and edges', async () => {
    const store = createMemoryGraphStore();
    const note = {
      id: 'note_1',
      type: 'note',
      title: 'Source note',
      content: '# Test',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } satisfies WorkstreamNode;
    const thread = {
      id: 'thread_1',
      type: 'chat_thread',
      title: 'Mock Chat A',
      provider: 'mock-chat-a',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    } satisfies WorkstreamNode;
    const edge = {
      id: 'edge_1',
      fromNodeId: note.id,
      toNodeId: thread.id,
      type: 'forked_to',
      createdAt: '2026-01-01T00:00:02.000Z',
    } satisfies WorkstreamEdge;

    await store.saveNode(note);
    await store.saveNode(thread);
    await store.saveEdge(edge);

    expect(await store.getNode(note.id)).toEqual(note);
    expect(await store.listNodes()).toHaveLength(2);
    expect(await store.listEdges()).toEqual([edge]);
  });
});
