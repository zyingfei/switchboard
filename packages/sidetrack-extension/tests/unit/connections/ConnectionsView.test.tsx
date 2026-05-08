import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionsView } from '../../../src/sidepanel/connections/ConnectionsView';
import { setConnectionsClientTransportForTests } from '../../../src/sidepanel/connections/client';
import { messageTypes } from '../../../src/messages';

// Engineering-scaffold tests. These don't lock the UX visual form
// (the designer chooses), but they DO lock the engineering
// acceptance bar:
//   1. Anchor entry kicks off a fetch.
//   2. Empty state renders honestly.
//   3. Companion-unreachable scope renders the right message.
//   4. Provenance drilldown shows when an edge is clicked.

const buildSnapshot = () => ({
  scope: 'companion-extended',
  snapshot: {
    scope: { nodeId: 'thread:thread_a', hops: 1 },
    nodes: [
      {
        id: 'thread:thread_a',
        kind: 'thread',
        label: 'Tax flow',
        originReplicaIds: ['replica-A'],
        metadata: {},
      },
      {
        id: 'workstream:ws_x',
        kind: 'workstream',
        label: 'Tax automation',
        originReplicaIds: ['replica-A', 'replica-B'],
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
    ],
    updatedAt: '2026-05-07T10:00:00.000Z',
    nodeCount: 2,
    edgeCount: 1,
  },
});

describe('ConnectionsView — engineering scaffold', () => {
  beforeEach(() => {
    setConnectionsClientTransportForTests(null);
  });
  afterEach(() => {
    setConnectionsClientTransportForTests(null);
  });

  it('renders empty when no anchor is provided', () => {
    render(<ConnectionsView />);
    expect(screen.queryByTestId('connections-loading')).toBeNull();
    expect(screen.queryByTestId('connections-empty')).toBeNull();
  });

  it('fetches neighbors when anchor is set + groups by kind', async () => {
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return { ok: true, data: buildSnapshot() };
      }
      return { ok: false, error: 'unexpected' };
    });
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    expect(screen.queryByTestId('group-thread')).not.toBeNull();
    expect(screen.queryByTestId('group-workstream')).not.toBeNull();
    // Cross-device indicator: workstream node has 2 replica ids.
    expect(screen.getByText(/2×/u)).toBeDefined();
  });

  it('renders the unreachable-scope message when companion is offline', async () => {
    setConnectionsClientTransportForTests(async () => ({
      ok: true,
      data: {
        scope: 'plugin-active-only-companion-unreachable',
        snapshot: { scope: {}, nodes: [], edges: [], updatedAt: '1970-01-01T00:00:00.000Z', nodeCount: 0, edgeCount: 0 },
      },
    }));
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-empty-companion-offline')).not.toBeNull();
    });
  });

  it('renders empty state when snapshot is empty', async () => {
    setConnectionsClientTransportForTests(async () => ({
      ok: true,
      data: {
        scope: 'companion-extended',
        snapshot: { scope: {}, nodes: [], edges: [], updatedAt: '1970-01-01T00:00:00.000Z', nodeCount: 0, edgeCount: 0 },
      },
    }));
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-empty')).not.toBeNull();
    });
  });

  it('renders provenance panel when an edge is clicked', async () => {
    const edgeFixture = {
      id: 'edge:thread_in_workstream:thread:thread_a:workstream:ws_x',
      kind: 'thread_in_workstream',
      fromNodeId: 'thread:thread_a',
      toNodeId: 'workstream:ws_x',
      observedAt: '2026-05-07T10:00:00.000Z',
      producedBy: { source: 'event-log', eventType: 'thread.upserted' },
      confidence: 'explicit',
    };
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return { ok: true, data: buildSnapshot() };
      }
      if (m.type === messageTypes.loadConnectionsEdge) {
        return { ok: true, data: edgeFixture };
      }
      return { ok: false, error: 'unexpected' };
    });
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId(`edge-${edgeFixture.id}`)).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId(`edge-${edgeFixture.id}`));
    await waitFor(() => {
      expect(screen.queryByTestId('edge-provenance')).not.toBeNull();
    });
    expect(screen.getByText('thread_in_workstream')).toBeDefined();
    expect(screen.getByText('event-log')).toBeDefined();
  });

  it('renders error when client returns ok:false', async () => {
    setConnectionsClientTransportForTests(async () => ({ ok: false, error: 'boom' }));
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-error')).not.toBeNull();
    });
    expect(screen.getByText(/boom/u)).toBeDefined();
  });
});
