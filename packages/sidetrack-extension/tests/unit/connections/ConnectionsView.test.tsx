import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
        confidence: 'asserted',
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
    // The anchor (thread:thread_a) is shown in the AnchorBar and
    // excluded from neighbor groups. Only the workstream neighbor
    // should produce a kind group.
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
      confidence: 'asserted',
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
    // Edge kind appears both in the edges list and inside the
    // provenance card (head badge + Edge-kind dl row) — assert that
    // it is rendered in the provenance card at least once.
    const prov = screen.getByTestId('edge-provenance');
    expect(within(prov).getAllByText('thread_in_workstream').length).toBeGreaterThan(0);
    expect(within(prov).getByText('event-log')).toBeDefined();
  });

  it('renders error when client returns ok:false', async () => {
    setConnectionsClientTransportForTests(async () => ({ ok: false, error: 'boom' }));
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-error')).not.toBeNull();
    });
    expect(screen.getByText(/boom/u)).toBeDefined();
  });

  it('renders the "via captured text" hint for *_references_url edges', async () => {
    const refEdgeId =
      'edge:thread_references_url:thread:thread_a:timeline-visit:https://copy.fail/exploit';
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return {
          ok: true,
          data: {
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
                  id: 'timeline-visit:https://copy.fail/exploit',
                  kind: 'timeline-visit',
                  label: 'copy.fail/exploit',
                  originReplicaIds: [],
                  metadata: {},
                },
              ],
              edges: [
                {
                  id: refEdgeId,
                  kind: 'thread_references_url',
                  fromNodeId: 'thread:thread_a',
                  toNodeId: 'timeline-visit:https://copy.fail/exploit',
                  observedAt: '2026-05-07T10:00:00.000Z',
                  producedBy: { source: 'event-log', eventType: 'capture.recorded' },
                  confidence: 'observed',
                },
              ],
              updatedAt: '2026-05-07T10:00:00.000Z',
              nodeCount: 2,
              edgeCount: 1,
            },
          },
        };
      }
      return { ok: false, error: 'unexpected' };
    });
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId(`edge-${refEdgeId}`)).not.toBeNull();
    });
    expect(screen.queryByTestId(`edge-hint-${refEdgeId}`)).not.toBeNull();
    expect(screen.getByText('via captured text')).toBeDefined();
  });

  it('renders the TimelineRail when the snapshot has event-log timestamps', async () => {
    setConnectionsClientTransportForTests(async () => ({
      ok: true,
      data: {
        scope: 'companion-extended',
        snapshot: {
          scope: { nodeId: 'thread:thread_a', hops: 1 },
          nodes: [
            {
              id: 'thread:thread_a',
              kind: 'thread',
              label: 'A',
              lastSeenAt: '2026-05-14T09:30:00.000Z',
              originReplicaIds: ['mac'],
              metadata: {},
            },
            {
              id: 'workstream:ws_x',
              kind: 'workstream',
              label: 'WS',
              lastSeenAt: '2026-05-14T09:45:00.000Z',
              originReplicaIds: ['mac'],
              metadata: {},
            },
          ],
          edges: [
            {
              id: 'e1',
              kind: 'thread_in_workstream',
              fromNodeId: 'thread:thread_a',
              toNodeId: 'workstream:ws_x',
              observedAt: '2026-05-14T09:00:00.000Z',
              producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
              confidence: 'asserted',
            },
          ],
          updatedAt: '2026-05-14T09:45:00.000Z',
          nodeCount: 2,
          edgeCount: 1,
        },
      },
    }));
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-timeline')).not.toBeNull();
    });
    const rail = screen.getByTestId('connections-timeline');
    expect(within(rail).getByText('Observed activity')).toBeDefined();
    expect(within(rail).getByText('2026-05-14')).toBeDefined();
  });

  it('switches to Orbital sub-mode and renders the SVG graph', async () => {
    setConnectionsClientTransportForTests(async () => ({
      ok: true,
      data: {
        scope: 'companion-extended',
        snapshot: {
          scope: { nodeId: 'thread:thread_a', hops: 1 },
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
              label: 'WS',
              originReplicaIds: ['replica-A'],
              metadata: {},
            },
          ],
          edges: [
            {
              id: 'e1',
              kind: 'thread_in_workstream',
              fromNodeId: 'thread:thread_a',
              toNodeId: 'workstream:ws_x',
              observedAt: '2026-05-14T09:00:00.000Z',
              producedBy: { source: 'event-log' },
              confidence: 'asserted',
            },
          ],
          updatedAt: '2026-05-14T09:00:00.000Z',
          nodeCount: 2,
          edgeCount: 1,
        },
      },
    }));
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-orbital'));
    await waitFor(() => {
      expect(screen.queryByTestId('connections-orbital')).not.toBeNull();
    });
    expect(screen.queryByTestId('orbit-node-thread:thread_a')).not.toBeNull();
    expect(screen.queryByTestId('orbit-node-workstream:ws_x')).not.toBeNull();
  });

  it('renders recent-anchor quick-pick that sets the anchor on click', async () => {
    let calls = 0;
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        calls += 1;
        return {
          ok: true,
          data: {
            scope: 'companion-extended',
            snapshot: {
              scope: { nodeId: m.nodeId ?? '', hops: 1 },
              nodes: [
                {
                  id: m.nodeId ?? '',
                  kind: 'thread',
                  label: 'anchor',
                  originReplicaIds: ['replica-A'],
                  metadata: {},
                },
              ],
              edges: [],
              updatedAt: '2026-05-14T09:00:00.000Z',
              nodeCount: 1,
              edgeCount: 0,
            },
          },
        };
      }
      return { ok: false, error: 'unexpected' };
    });
    render(
      <ConnectionsView
        recentAnchors={[
          { id: 'thread:thread_recent', kind: 'thread', label: 'Tax flow research' },
          { id: 'workstream:ws_x', kind: 'workstream', label: 'Tax automation' },
        ]}
      />,
    );
    expect(screen.queryByTestId('connections-recent-anchors')).not.toBeNull();
    fireEvent.click(screen.getByTestId('recent-anchor-thread:thread_recent'));
    await waitFor(() => {
      expect(calls).toBeGreaterThan(0);
    });
  });

  it('renders the "quoted in turn" hint and shows recordId for thread_quotes_thread', async () => {
    const quoteEdgeId = 'edge:thread_quotes_thread:thread:thread_a:thread:thread_b';
    const quoteEdge = {
      id: quoteEdgeId,
      kind: 'thread_quotes_thread',
      fromNodeId: 'thread:thread_a',
      toNodeId: 'thread:thread_b',
      observedAt: '2026-05-07T10:00:00.000Z',
      producedBy: {
        source: 'event-log',
        eventType: 'capture.recorded',
        recordId: '8f0e2a1b3c4d',
        dot: { replicaId: 'replica-A', seq: 5 },
      },
      confidence: 'inferred',
    };
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return {
          ok: true,
          data: {
            scope: 'companion-extended',
            snapshot: {
              scope: { nodeId: 'thread:thread_a', hops: 1 },
              nodes: [
                {
                  id: 'thread:thread_a',
                  kind: 'thread',
                  label: 'Claude — write tax helper',
                  originReplicaIds: ['replica-A'],
                  metadata: {},
                },
                {
                  id: 'thread:thread_b',
                  kind: 'thread',
                  label: 'ChatGPT — review code',
                  originReplicaIds: ['replica-A'],
                  metadata: {},
                },
              ],
              edges: [quoteEdge],
              updatedAt: '2026-05-07T10:00:00.000Z',
              nodeCount: 2,
              edgeCount: 1,
            },
          },
        };
      }
      if (m.type === messageTypes.loadConnectionsEdge) {
        return { ok: true, data: quoteEdge };
      }
      return { ok: false, error: 'unexpected' };
    });
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId(`edge-${quoteEdgeId}`)).not.toBeNull();
    });
    expect(screen.getByText('quoted in turn')).toBeDefined();
    fireEvent.click(screen.getByTestId(`edge-${quoteEdgeId}`));
    await waitFor(() => {
      expect(screen.queryByTestId('edge-record-id')).not.toBeNull();
    });
    expect(screen.getByText('8f0e2a1b3c4d')).toBeDefined();
  });
});
