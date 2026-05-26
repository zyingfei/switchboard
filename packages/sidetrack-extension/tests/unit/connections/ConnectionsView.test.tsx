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

const flowAnchorId = 'timeline-visit:https://example.test/start';
const flowNextId = 'timeline-visit:https://example.test/next';

const buildFlowSnapshot = () => ({
  scope: 'companion-extended',
  snapshot: {
    scope: { nodeId: flowAnchorId, hops: 1 },
    nodes: [
      {
        id: flowAnchorId,
        kind: 'timeline-visit',
        label: 'Start page',
        originReplicaIds: ['replica-A'],
        metadata: {
          canonicalUrl: 'https://example.test/start',
          focusedWindowMs: 8_000,
          tabSessionId: 'tab-a',
        },
        firstSeenAt: '2026-05-07T10:00:00.000Z',
        lastSeenAt: '2026-05-07T10:00:00.000Z',
      },
      {
        id: flowNextId,
        kind: 'timeline-visit',
        label: 'Next page',
        originReplicaIds: ['replica-A'],
        metadata: {
          canonicalUrl: 'https://example.test/next',
          focusedWindowMs: 4_000,
          tabSessionId: 'tab-a',
        },
        firstSeenAt: '2026-05-07T10:01:00.000Z',
        lastSeenAt: '2026-05-07T10:01:00.000Z',
      },
    ],
    edges: [
      {
        id: 'edge:previous_visit_in_tab_session:next:start',
        kind: 'previous_visit_in_tab_session',
        fromNodeId: flowNextId,
        toNodeId: flowAnchorId,
        observedAt: '2026-05-07T10:01:00.000Z',
        producedBy: { source: 'timeline' },
        confidence: 'observed',
      },
    ],
    updatedAt: '2026-05-07T10:01:00.000Z',
    nodeCount: 2,
    edgeCount: 1,
  },
});

const deferred = <T,>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

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

  it('shows a requested URL anchor even before the graph contains that node', async () => {
    const requestedNodeIds: string[] = [];
    const anchorId = 'timeline-visit:https://example.test/research';
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        requestedNodeIds.push(m.nodeId ?? '');
        return {
          ok: true,
          data: {
            scope: 'companion-extended',
            snapshot: {
              scope: { nodeId: m.nodeId, hops: 1 },
              nodes: [],
              edges: [],
              updatedAt: '2026-05-14T09:00:00.000Z',
              nodeCount: 0,
              edgeCount: 0,
            },
          },
        };
      }
      return { ok: false, error: 'unexpected' };
    });

    render(<ConnectionsView requestAnchor={anchorId} onOpenInInbox={() => undefined} />);

    await waitFor(() => {
      expect(requestedNodeIds).toContain(anchorId);
      expect(screen.queryAllByTestId(`node-${anchorId}`).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText('no anchor selected')).toBeNull();
    expect(screen.getByTitle('Find in Inbox · https://example.test/research')).toBeDefined();
  });

  it('renders edge labels with readable endpoints instead of raw edge kinds only', async () => {
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return { ok: true, data: buildSnapshot() };
      }
      return { ok: false, error: 'unexpected' };
    });
    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });

    expect(screen.getByTitle('Tax flow → Tax automation · in workstream')).toBeDefined();
    expect(screen.getByText('Tax flow → Tax automation')).toBeDefined();
  });

  it('uses a workstream selector as the primary anchor control', async () => {
    const requestedNodeIds: string[] = [];
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        requestedNodeIds.push(m.nodeId ?? '');
        return { ok: true, data: buildSnapshot() };
      }
      return { ok: false, error: 'unexpected' };
    });
    render(
      <ConnectionsView
        workstreamAnchors={[
          { id: 'workstream:ws_x', label: 'Tax automation' },
          { id: 'workstream:ws_y', label: 'Research queue' },
        ]}
      />,
    );

    const selector = screen.getByTestId('connections-workstream-select') as HTMLSelectElement;
    expect(selector.value).toBe('');
    fireEvent.change(selector, { target: { value: 'workstream:ws_x' } });

    await waitFor(() => {
      expect(requestedNodeIds).toContain('workstream:ws_x');
    });
    expect(selector.value).toBe('workstream:ws_x');
  });

  it('opens a full Search mode and anchors picked results', async () => {
    const requestedNodeIds: string[] = [];
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        requestedNodeIds.push(m.nodeId ?? '');
        return { ok: true, data: buildSnapshot() };
      }
      if (m.type === messageTypes.loadConnectionsSnapshot) {
        return {
          ok: true,
          data: {
            scope: 'companion-extended',
            snapshot: {
              scope: {},
              nodes: [
                ...buildSnapshot().snapshot.nodes,
                {
                  id: 'thread:oracle',
                  kind: 'thread',
                  label: 'Oracle Cloud Infrastructure Cloud Adoption Framework',
                  originReplicaIds: ['replica-A'],
                  metadata: { title: 'Oracle Cloud Infrastructure Cloud Adoption Framework' },
                },
              ],
              edges: buildSnapshot().snapshot.edges,
              updatedAt: '2026-05-07T10:00:00.000Z',
              nodeCount: 3,
              edgeCount: 1,
            },
          },
        };
      }
      return { ok: false, error: 'unexpected' };
    });

    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-search')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-search'));
    expect(screen.getByTestId('connections-search-tab')).toBeDefined();
    expect(screen.queryByTestId('connections-rail-toggle')).toBeNull();
    expect(screen.queryByTestId('connections-rightpanel-toggle')).toBeNull();
    expect(screen.queryByTestId('connections-filterbar')).toBeNull();
    expect(screen.queryByTestId('connections-advanced-anchor')).toBeNull();
    fireEvent.change(screen.getByTestId('connections-search-tab-input'), {
      target: { value: 'or' },
    });
    await waitFor(() => {
      expect(screen.queryByTestId('connections-search-tab-hit-thread:oracle')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-search-tab-hit-thread:oracle'));
    await waitFor(() => {
      expect(requestedNodeIds).toContain('thread:oracle');
    });
    expect(screen.getByTestId('connections-mode-linked')).toHaveAttribute('aria-selected', 'true');
  });

  it('filters Linked results by object kind', async () => {
    setConnectionsClientTransportForTests((msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return Promise.resolve({ ok: true, data: buildSnapshot() });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    });

    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('group-workstream')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('connections-object-filter-workstream'));

    expect(screen.queryByTestId('group-workstream')).toBeNull();
    expect(
      screen.queryByTestId('edge-edge:thread_in_workstream:thread:thread_a:workstream:ws_x'),
    ).toBeNull();
  });

  it('filters Linked results by edge family', async () => {
    setConnectionsClientTransportForTests((msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return Promise.resolve({ ok: true, data: buildSnapshot() });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    });

    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(
        screen.queryByTestId('edge-edge:thread_in_workstream:thread:thread_a:workstream:ws_x'),
      ).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('connections-family-filter-contain'));

    expect(screen.queryByTestId('group-workstream')).toBeNull();
    expect(
      screen.queryByTestId('edge-edge:thread_in_workstream:thread:thread_a:workstream:ws_x'),
    ).toBeNull();
  });

  it('filters Orbital results by object kind', async () => {
    setConnectionsClientTransportForTests((msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return Promise.resolve({ ok: true, data: buildSnapshot() });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    });

    render(<ConnectionsView initialAnchor="thread:thread_a" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-orbital')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('connections-mode-orbital'));
    await waitFor(() => {
      expect(screen.queryByTestId('orbit-node-workstream:ws_x')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('connections-object-filter-workstream'));

    expect(screen.queryByTestId('orbit-node-workstream:ws_x')).toBeNull();
  });

  it('filters Flow Path results by edge family', async () => {
    setConnectionsClientTransportForTests((msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return Promise.resolve({ ok: true, data: buildFlowSnapshot() });
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    });

    render(<ConnectionsView initialAnchor={flowAnchorId} />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-flow')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('connections-mode-flow'));
    await waitFor(() => {
      expect(screen.queryByTestId(`flow-visit-${flowNextId}`)).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('connections-family-filter-flow'));

    expect(screen.queryByTestId(`flow-visit-${flowNextId}`)).toBeNull();
    expect(screen.queryByTestId(`flow-visit-${flowAnchorId}`)).not.toBeNull();
  });

  it('scopes shadow focus suggestions to the selected workstream', async () => {
    const collapsedSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: { nodeId: 'workstream:ws_db', hops: 1 },
        nodes: [
          {
            id: 'workstream:ws_db',
            kind: 'workstream',
            label: 'DB',
            originReplicaIds: ['replica-A'],
            metadata: {},
          },
          {
            id: 'visit-instance:tab-a:2026-05-14T10:00:00.000Z:https://db.example/oracle',
            kind: 'visit-instance',
            label: 'Oracle 26ai',
            originReplicaIds: ['replica-A'],
            metadata: {
              canonicalUrl: 'https://db.example/oracle',
              timelineVisitId: 'timeline-visit:https://db.example/oracle',
              focusedWindowMs: 8_000,
              engagement: { class: 'engaged_read' },
            },
          },
          {
            id: 'topic:collapsed',
            kind: 'topic',
            label: 'ChatGPT',
            originReplicaIds: [],
            metadata: { memberCount: 294, cohesion: 0.72 },
          },
        ],
        edges: [
          {
            id: 'edge:visit-workstream',
            kind: 'visit_instance_in_workstream',
            fromNodeId: 'visit-instance:tab-a:2026-05-14T10:00:00.000Z:https://db.example/oracle',
            toNodeId: 'workstream:ws_db',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'timeline' },
            confidence: 'observed',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 3,
        edgeCount: 1,
      },
    };
    const shadowSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: {},
        nodes: [
          {
            id: 'workstream:ws_db',
            kind: 'workstream',
            label: 'DB',
            originReplicaIds: ['replica-A'],
            metadata: {},
          },
          {
            id: 'timeline-visit:https://db.example/oracle',
            kind: 'timeline-visit',
            label: 'Oracle 26ai',
            originReplicaIds: ['replica-A'],
            metadata: {
              canonicalUrl: 'https://db.example/oracle',
              focusedWindowMs: 8_000,
              engagement: { class: 'engaged_read' },
            },
          },
          {
            id: 'timeline-visit:https://news.example/story',
            kind: 'timeline-visit',
            label: 'Unrelated HN',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://news.example/story', focusedWindowMs: 9_000 },
          },
          {
            id: 'topic:db',
            kind: 'topic',
            label: 'Oracle',
            originReplicaIds: [],
            metadata: { memberCount: 6, cohesion: 0.91 },
          },
          {
            id: 'topic:hn',
            kind: 'topic',
            label: 'Hacker News',
            originReplicaIds: [],
            metadata: { memberCount: 8, cohesion: 0.89 },
          },
        ],
        edges: [
          {
            id: 'edge:shadow-db',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://db.example/oracle',
            toNodeId: 'topic:db',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-shadow' },
            confidence: 'inferred',
          },
          {
            id: 'edge:shadow-hn',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://news.example/story',
            toNodeId: 'topic:hn',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-shadow' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 5,
        edgeCount: 2,
      },
    };

    const requestedNodeIds: string[] = [];
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string; filters?: { topicVariant?: string } };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        if (m.nodeId !== undefined) requestedNodeIds.push(m.nodeId);
        return { ok: true, data: collapsedSnapshot };
      }
      if (m.type === messageTypes.loadConnectionsSnapshot) {
        return {
          ok: true,
          data: m.filters?.topicVariant === 'shadow' ? shadowSnapshot : collapsedSnapshot,
        };
      }
      return { ok: false, error: 'unexpected' };
    });

    render(<ConnectionsView initialAnchor="workstream:ws_db" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-focus')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-focus'));

    await waitFor(() => {
      expect(screen.queryByTestId('focus-topic-topic:db')).not.toBeNull();
    });
    expect(screen.queryByTestId('focus-topic-topic:hn')).toBeNull();
    expect(screen.getByText('1 page shown here, 6 pages total')).toBeDefined();
    fireEvent.click(screen.getByText('Oracle'));
    expect(
      screen.getByTestId('focus-visit-timeline-visit:https://db.example/oracle'),
    ).toBeDefined();
    expect(
      screen.queryByTestId('focus-visit-timeline-visit:https://news.example/story'),
    ).toBeNull();
    fireEvent.click(screen.getByTestId('focus-topic-anchor-topic:db'));
    await waitFor(() => {
      expect(requestedNodeIds).toContain('topic:db');
    });
    expect(screen.queryByText('(topic cluster)')).toBeNull();
    expect(screen.queryByTestId('focus-empty')).toBeNull();
    expect(screen.getByTestId('focus-topic-topic:db')).toBeDefined();
  });

  it('scopes a topic anchor against the SERVED snapshot even when the shadow snapshot is empty', async () => {
    // Post-W2 the served clustering is leiden-cpm; the idf-rkn shadow
    // snapshot has unrelated ids (or is empty/unavailable). A topic
    // anchor must resolve in the served graph it was clicked in, not
    // the shadow — otherwise every topic anchor → "No scoped focus
    // group".
    const servedSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: { nodeId: 'topic:served', hops: 2 },
        nodes: [
          {
            id: 'topic:served',
            kind: 'topic',
            label: 'Statistical Learning',
            originReplicaIds: [],
            metadata: { memberCount: 2, representativeTitles: ['Statistical Learning'] },
          },
          {
            id: 'timeline-visit:https://hx.example/knn',
            kind: 'timeline-visit',
            label: 'kNN chapter',
            originReplicaIds: ['replica-A'],
            metadata: {
              canonicalUrl: 'https://hx.example/knn',
              focusedWindowMs: 9_000,
              engagement: { class: 'engaged_read' },
            },
          },
          {
            id: 'timeline-visit:https://hx.example/montecarlo',
            kind: 'timeline-visit',
            label: 'Monte Carlo chapter',
            originReplicaIds: ['replica-A'],
            metadata: {
              canonicalUrl: 'https://hx.example/montecarlo',
              focusedWindowMs: 8_000,
              engagement: { class: 'engaged_read' },
            },
          },
        ],
        edges: [
          {
            id: 'edge:served-knn',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://hx.example/knn',
            toNodeId: 'topic:served',
            observedAt: '2026-05-18T10:00:00.000Z',
            producedBy: { source: 'topic-clusterer' },
            confidence: 'inferred',
          },
          {
            id: 'edge:served-mc',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://hx.example/montecarlo',
            toNodeId: 'topic:served',
            observedAt: '2026-05-18T10:00:00.000Z',
            producedBy: { source: 'topic-clusterer' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-18T10:00:00.000Z',
        nodeCount: 3,
        edgeCount: 2,
      },
    };
    const emptyShadow = {
      scope: 'companion-extended',
      snapshot: {
        scope: { topicVariant: 'shadow' },
        nodes: [],
        edges: [],
        updatedAt: '2026-05-18T10:00:00.000Z',
        nodeCount: 0,
        edgeCount: 0,
      },
    };
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string; filters?: { topicVariant?: string } };
      if (m.type === messageTypes.loadConnectionsNeighbors) return { ok: true, data: servedSnapshot };
      if (m.type === messageTypes.loadConnectionsSnapshot) {
        return {
          ok: true,
          data: m.filters?.topicVariant === 'shadow' ? emptyShadow : servedSnapshot,
        };
      }
      return { ok: false, error: 'unexpected' };
    });

    render(<ConnectionsView requestAnchor="topic:served" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-focus')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-focus'));

    await waitFor(() => {
      expect(screen.getByTestId('focus-topic-topic:served')).toBeDefined();
    });
    // The scoped focus group resolved from the served snapshot, NOT the
    // dead "No scoped focus group" empty state.
    expect(screen.queryByTestId('focus-empty')).toBeNull();
    expect(screen.queryByText('No scoped focus group')).toBeNull();
  });

  it('does not broaden thread-anchor shadow focus through a collapsed topic scope', async () => {
    const collapsedSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: { nodeId: 'thread:db_oracle', hops: 3 },
        nodes: [
          {
            id: 'thread:db_oracle',
            kind: 'thread',
            label: 'DB - Oracle 26ai Innovation and Competitors',
            originReplicaIds: ['replica-A'],
            metadata: {
              canonicalUrl: 'https://db.example/oracle',
              url: 'https://db.example/oracle',
            },
          },
          {
            id: 'timeline-visit:https://db.example/oracle',
            kind: 'timeline-visit',
            label: 'Oracle 26ai',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://db.example/oracle', focusedWindowMs: 8_000 },
          },
          {
            id: 'timeline-visit:https://news.example/story',
            kind: 'timeline-visit',
            label: 'Unrelated HN',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://news.example/story', focusedWindowMs: 9_000 },
          },
          {
            id: 'topic:collapsed',
            kind: 'topic',
            label: 'ChatGPT',
            originReplicaIds: [],
            metadata: { memberCount: 294, cohesion: 0.72 },
          },
        ],
        edges: [
          {
            id: 'edge:same-url',
            kind: 'timeline_same_url_as_thread',
            fromNodeId: 'timeline-visit:https://db.example/oracle',
            toNodeId: 'thread:db_oracle',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'snapshot' },
            confidence: 'observed',
          },
          {
            id: 'edge:collapsed-db',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://db.example/oracle',
            toNodeId: 'topic:collapsed',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-current' },
            confidence: 'inferred',
          },
          {
            id: 'edge:collapsed-hn',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://news.example/story',
            toNodeId: 'topic:collapsed',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-current' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 4,
        edgeCount: 3,
      },
    };
    const shadowSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: {},
        nodes: [
          {
            id: 'timeline-visit:https://db.example/oracle',
            kind: 'timeline-visit',
            label: 'Oracle 26ai',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://db.example/oracle', focusedWindowMs: 8_000 },
          },
          {
            id: 'timeline-visit:https://news.example/story',
            kind: 'timeline-visit',
            label: 'Unrelated HN',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://news.example/story', focusedWindowMs: 9_000 },
          },
          {
            id: 'topic:db',
            kind: 'topic',
            label: 'Oracle',
            originReplicaIds: [],
            metadata: { memberCount: 6, cohesion: 0.91 },
          },
          {
            id: 'topic:hn',
            kind: 'topic',
            label: 'Hacker News',
            originReplicaIds: [],
            metadata: { memberCount: 8, cohesion: 0.89 },
          },
        ],
        edges: [
          {
            id: 'edge:shadow-db',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://db.example/oracle',
            toNodeId: 'topic:db',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-shadow' },
            confidence: 'inferred',
          },
          {
            id: 'edge:shadow-hn',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://news.example/story',
            toNodeId: 'topic:hn',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-shadow' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 4,
        edgeCount: 2,
      },
    };

    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; filters?: { topicVariant?: string } };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return { ok: true, data: collapsedSnapshot };
      }
      if (m.type === messageTypes.loadConnectionsSnapshot) {
        return {
          ok: true,
          data: m.filters?.topicVariant === 'shadow' ? shadowSnapshot : collapsedSnapshot,
        };
      }
      return { ok: false, error: 'unexpected' };
    });

    render(<ConnectionsView initialAnchor="thread:db_oracle" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-focus')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-focus'));

    await waitFor(() => {
      expect(screen.queryByTestId('focus-topic-topic:db')).not.toBeNull();
    });
    expect(screen.queryByTestId('focus-topic-topic:hn')).toBeNull();
    expect(screen.getByText('1 page shown here, 6 pages total')).toBeDefined();
  });

  it('renders shadow topic members when the topic itself is the anchor', async () => {
    const activeSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: { nodeId: 'topic:ai_race', hops: 1 },
        nodes: [],
        edges: [],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 0,
        edgeCount: 0,
      },
    };
    const shadowSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: {},
        nodes: [
          {
            id: 'timeline-visit:https://example.test/ai-race-a',
            kind: 'timeline-visit',
            label: 'The US Is Winning the AI Race',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://example.test/ai-race-a', focusedWindowMs: 8_000 },
          },
          {
            id: 'timeline-visit:https://example.test/ai-race-b',
            kind: 'timeline-visit',
            label: 'AI Race Policy Brief',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://example.test/ai-race-b', focusedWindowMs: 6_000 },
          },
          {
            id: 'topic:ai_race',
            kind: 'topic',
            label: 'The US Is Winning the AI Race',
            originReplicaIds: [],
            metadata: { memberCount: 2, cohesion: 0.92 },
          },
        ],
        edges: [
          {
            id: 'edge:shadow-ai-a',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://example.test/ai-race-a',
            toNodeId: 'topic:ai_race',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-shadow' },
            confidence: 'inferred',
          },
          {
            id: 'edge:shadow-ai-b',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://example.test/ai-race-b',
            toNodeId: 'topic:ai_race',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-shadow' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 3,
        edgeCount: 2,
      },
    };

    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; filters?: { topicVariant?: string } };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return { ok: true, data: activeSnapshot };
      }
      if (m.type === messageTypes.loadConnectionsSnapshot) {
        return {
          ok: true,
          data: m.filters?.topicVariant === 'shadow' ? shadowSnapshot : activeSnapshot,
        };
      }
      return { ok: false, error: 'unexpected' };
    });

    render(<ConnectionsView initialAnchor="topic:ai_race" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-focus')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-focus'));

    await waitFor(() => {
      expect(screen.queryByTestId('focus-topic-topic:ai_race')).not.toBeNull();
    });
    expect(screen.queryByTestId('focus-empty')).toBeNull();
    expect(screen.getByText('2 pages')).toBeDefined();
    fireEvent.click(screen.getByText('The US Is Winning the AI Race'));
    expect(
      screen.getByTestId('focus-visit-timeline-visit:https://example.test/ai-race-a'),
    ).toBeDefined();
    expect(
      screen.getByTestId('focus-visit-timeline-visit:https://example.test/ai-race-b'),
    ).toBeDefined();
    expect(
      screen
        .getByTestId('focus-visit-open-timeline-visit:https://example.test/ai-race-a')
        .getAttribute('href'),
    ).toBe('https://example.test/ai-race-a');
    fireEvent.click(
      screen.getByTestId('focus-visit-timeline-visit:https://example.test/ai-race-a'),
    );
    await waitFor(() => {
      expect(screen.getByText('Same topic (cohesion 0.92)')).toBeDefined();
    });
    expect(screen.queryByText(/Shared terms:/u)).toBeNull();
  });

  it('resolves a cold topic anchor from shadow without rendering baseline focus', async () => {
    const activeSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: { nodeId: 'topic:ai_race', hops: 1 },
        nodes: [
          {
            id: 'topic:collapsed',
            kind: 'topic',
            label: 'ChatGPT',
            originReplicaIds: [],
            metadata: { memberCount: 301, cohesion: 0.72 },
          },
          {
            id: 'timeline-visit:https://example.test/noise',
            kind: 'timeline-visit',
            label: 'Collapsed baseline member',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://example.test/noise', focusedWindowMs: 9_000 },
          },
        ],
        edges: [
          {
            id: 'edge:collapsed-noise',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://example.test/noise',
            toNodeId: 'topic:collapsed',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-current' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 2,
        edgeCount: 1,
      },
    };
    const shadowSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: {},
        nodes: [
          {
            id: 'timeline-visit:https://example.test/ai-race-a',
            kind: 'timeline-visit',
            label: 'The US Is Winning the AI Race',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://example.test/ai-race-a', focusedWindowMs: 8_000 },
          },
          {
            id: 'topic:ai_race',
            kind: 'topic',
            label: 'The US Is Winning the AI Race',
            originReplicaIds: [],
            metadata: { memberCount: 1, cohesion: 0.92 },
          },
        ],
        edges: [
          {
            id: 'edge:shadow-ai-a',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://example.test/ai-race-a',
            toNodeId: 'topic:ai_race',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-shadow' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 2,
        edgeCount: 1,
      },
    };
    const shadowResponse = deferred<{
      readonly ok: true;
      readonly data: typeof shadowSnapshot;
    }>();
    let shadowRequested = false;

    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; filters?: { topicVariant?: string } };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return { ok: true, data: activeSnapshot };
      }
      if (m.type === messageTypes.loadConnectionsSnapshot) {
        if (m.filters?.topicVariant === 'shadow') {
          shadowRequested = true;
          return shadowResponse.promise;
        }
        return { ok: true, data: activeSnapshot };
      }
      return { ok: false, error: 'unexpected' };
    });

    render(<ConnectionsView initialAnchor="topic:ai_race" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-focus')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-focus'));

    await waitFor(() => {
      expect(shadowRequested).toBe(true);
      expect(screen.queryByTestId('focus-resolving')).not.toBeNull();
    });
    expect(screen.queryByText('ChatGPT')).toBeNull();
    expect(screen.queryByTestId('focus-empty')).toBeNull();

    shadowResponse.resolve({ ok: true, data: shadowSnapshot });
    await waitFor(() => {
      expect(screen.queryByTestId('focus-topic-topic:ai_race')).not.toBeNull();
    });
    expect(screen.queryByTestId('focus-resolving')).toBeNull();
    expect(screen.queryByText('ChatGPT')).toBeNull();
  });

  it('does not fall back to the global collapsed topic when scoped shadow has no topic', async () => {
    const collapsedSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: { nodeId: 'timeline-visit:https://github.com/microsoft/tokenweave', hops: 1 },
        nodes: [
          {
            id: 'timeline-visit:https://github.com/microsoft/tokenweave',
            kind: 'timeline-visit',
            label: 'microsoft/tokenweave',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://github.com/microsoft/tokenweave' },
          },
          {
            id: 'topic:collapsed',
            kind: 'topic',
            label: 'ChatGPT',
            originReplicaIds: [],
            metadata: { memberCount: 301, cohesion: 0.72 },
          },
        ],
        edges: [
          {
            id: 'edge:collapsed-tokenweave',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://github.com/microsoft/tokenweave',
            toNodeId: 'topic:collapsed',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-current' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 2,
        edgeCount: 1,
      },
    };
    const shadowSnapshot = {
      scope: 'companion-extended',
      snapshot: {
        scope: {},
        nodes: [
          {
            id: 'timeline-visit:https://github.com/microsoft/tokenweave',
            kind: 'timeline-visit',
            label: 'microsoft/tokenweave',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://github.com/microsoft/tokenweave' },
          },
          {
            id: 'timeline-visit:https://db.example/oracle',
            kind: 'timeline-visit',
            label: 'Oracle 26ai',
            originReplicaIds: ['replica-A'],
            metadata: { canonicalUrl: 'https://db.example/oracle', focusedWindowMs: 8_000 },
          },
          {
            id: 'topic:db',
            kind: 'topic',
            label: 'Oracle',
            originReplicaIds: [],
            metadata: { memberCount: 5, cohesion: 0.91 },
          },
        ],
        edges: [
          {
            id: 'edge:shadow-db',
            kind: 'visit_in_topic',
            fromNodeId: 'timeline-visit:https://db.example/oracle',
            toNodeId: 'topic:db',
            observedAt: '2026-05-14T10:00:00.000Z',
            producedBy: { source: 'topic-shadow' },
            confidence: 'inferred',
          },
        ],
        updatedAt: '2026-05-14T10:00:00.000Z',
        nodeCount: 3,
        edgeCount: 1,
      },
    };
    let shadowRequested = false;

    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; filters?: { topicVariant?: string } };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return { ok: true, data: collapsedSnapshot };
      }
      if (m.type === messageTypes.loadConnectionsSnapshot) {
        if (m.filters?.topicVariant === 'shadow') shadowRequested = true;
        return {
          ok: true,
          data: m.filters?.topicVariant === 'shadow' ? shadowSnapshot : collapsedSnapshot,
        };
      }
      return { ok: false, error: 'unexpected' };
    });

    render(
      <ConnectionsView initialAnchor="timeline-visit:https://github.com/microsoft/tokenweave" />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-focus')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-focus'));

    await waitFor(() => {
      expect(shadowRequested).toBe(true);
      expect(screen.queryByTestId('focus-collapse-guard')).toBeNull();
    });
    expect(screen.queryByText('ChatGPT')).toBeNull();
    expect(screen.queryByTestId('focus-topic-topic:db')).toBeNull();
  });

  it('can re-anchor from a visible neighbor row', async () => {
    const requestedNodeIds: string[] = [];
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        const nodeId = m.nodeId ?? 'thread:thread_a';
        requestedNodeIds.push(nodeId);
        return {
          ok: true,
          data: {
            scope: 'companion-extended',
            snapshot: {
              scope: { nodeId, hops: 1 },
              nodes: [
                {
                  id: nodeId,
                  kind: nodeId.startsWith('workstream:') ? 'workstream' : 'thread',
                  label: nodeId.startsWith('workstream:') ? 'Tax automation' : 'Tax flow',
                  originReplicaIds: ['replica-A'],
                  metadata: {},
                },
                {
                  id: nodeId === 'workstream:ws_x' ? 'thread:thread_a' : 'workstream:ws_x',
                  kind: nodeId === 'workstream:ws_x' ? 'thread' : 'workstream',
                  label: nodeId === 'workstream:ws_x' ? 'Tax flow' : 'Tax automation',
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
                  confidence: 'asserted',
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
      expect(screen.queryByTestId('node-anchor-workstream:ws_x')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('node-anchor-workstream:ws_x'));

    await waitFor(() => {
      expect(requestedNodeIds).toContain('workstream:ws_x');
    });
    expect((screen.getByTestId('connections-workstream-select') as HTMLSelectElement).value).toBe(
      'workstream:ws_x',
    );
  });

  it('renders the unreachable-scope message when companion is offline', async () => {
    setConnectionsClientTransportForTests(async () => ({
      ok: true,
      data: {
        scope: 'plugin-active-only-companion-unreachable',
        snapshot: {
          scope: {},
          nodes: [],
          edges: [],
          updatedAt: '1970-01-01T00:00:00.000Z',
          nodeCount: 0,
          edgeCount: 0,
        },
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
        snapshot: {
          scope: {},
          nodes: [],
          edges: [],
          updatedAt: '1970-01-01T00:00:00.000Z',
          nodeCount: 0,
          edgeCount: 0,
        },
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

  it('renders shortcut quick-pick (separate from history) that sets the anchor on click', async () => {
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
    // The thread/workstream prop now renders as a distinct "Shortcuts"
    // section, separate from the real navigation-history "Recent
    // anchors" list (empty until the user actually navigates).
    expect(screen.queryByTestId('connections-anchor-shortcuts')).not.toBeNull();
    expect(screen.queryByTestId('connections-recent-anchors')).toBeNull();
    fireEvent.click(screen.getByTestId('shortcut-anchor-thread:thread_recent'));
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

  // T1-F — full-snapshot sweep: render a snapshot that exercises every
  // kind whose raw id is forbidden as visible text (tab-session,
  // visit-instance, replica, workstream without path), then assert the
  // rendered text content carries none of the forbidden id patterns.
  // Excludes attribute strings (data-testid carries raw ids by design)
  // by sampling only `textContent` of the rendered tree.
  it('never leaks raw entity ids into visible text', async () => {
    const sweepAnchor = 'tab-session:tses_01KSWEEP00000000000000ANCH';
    const sweepOpener = 'tab-session:tses_01KSWEEP00000000000000OPEN';
    const sweepVisit =
      'visit-instance:tses_01KSWEEP00000000000000ANCH:2026-05-20T10:00:00.000Z:https://example.test/article';
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return {
          ok: true,
          data: {
            scope: 'companion-extended',
            snapshot: {
              scope: { nodeId: sweepAnchor, hops: 1 },
              nodes: [
                {
                  id: sweepAnchor,
                  kind: 'tab-session',
                  label: 'Mullvad VPN blog',
                  originReplicaIds: ['replica-A'],
                  firstSeenAt: '2026-05-20T09:55:00.000Z',
                  lastSeenAt: '2026-05-20T10:30:00.000Z',
                  metadata: {
                    latestTitle: 'Mullvad VPN blog',
                    latestUrl: 'https://mullvad.net/en/blog/exit-ip-fingerprinting',
                    canonicalUrl: 'https://mullvad.net/en/blog/exit-ip-fingerprinting',
                    lastActivityAt: '2026-05-20T10:30:00.000Z',
                  },
                },
                {
                  id: sweepOpener,
                  kind: 'tab-session',
                  label: 'Hacker News',
                  originReplicaIds: ['replica-A'],
                  metadata: {
                    latestTitle: 'Hacker News',
                    latestUrl: 'https://news.ycombinator.com/',
                  },
                },
                {
                  id: sweepVisit,
                  kind: 'visit-instance',
                  label: 'Mullvad article',
                  originReplicaIds: ['replica-A'],
                  metadata: {
                    title: 'Mullvad article',
                    canonicalUrl: 'https://example.test/article',
                  },
                },
                {
                  id: 'timeline-visit:https://example.test/article',
                  kind: 'timeline-visit',
                  label: 'Mullvad article',
                  originReplicaIds: ['replica-A'],
                  metadata: {
                    title: 'Mullvad article',
                    canonicalUrl: 'https://example.test/article',
                    visitCount: 3,
                  },
                },
                {
                  id: 'workstream:bac_sweep_research',
                  kind: 'workstream',
                  label: 'bac_sweep_research',
                  originReplicaIds: ['replica-A'],
                  metadata: {},
                },
                {
                  id: 'replica:replica-A',
                  kind: 'replica',
                  label: 'replica-A',
                  originReplicaIds: ['replica-A'],
                  metadata: {},
                },
                // Codex round-3 fixture — queue-item whose title field
                // carries a raw bac_id (companion snapshot.ts stuffs
                // p.bac_id into title when the user-typed text is
                // empty). The formatter's annotation/queue-item branch
                // must clean this out, otherwise PathFinder /
                // NodeRow's tooltip + primary would leak.
                {
                  id: 'queue-item:bac_sweep_queue_x',
                  kind: 'queue-item',
                  label: 'bac_sweep_queue_x',
                  originReplicaIds: ['replica-A'],
                  metadata: { title: 'bac_sweep_queue_x' },
                },
              ],
              edges: [
                {
                  id: 'edge:tab_session_opener_chain:opener',
                  kind: 'tab_session_opener_chain',
                  fromNodeId: sweepAnchor,
                  toNodeId: sweepOpener,
                  observedAt: '2026-05-20T09:55:00.000Z',
                  producedBy: { source: 'timeline-projection' },
                  confidence: 'observed',
                },
                {
                  id: 'edge:visit_in_tab:visit',
                  kind: 'visit_instance_in_tab_session',
                  fromNodeId: sweepVisit,
                  toNodeId: sweepAnchor,
                  observedAt: '2026-05-20T10:00:00.000Z',
                  producedBy: { source: 'timeline-projection' },
                  confidence: 'observed',
                },
              ],
              updatedAt: '2026-05-20T10:30:00.000Z',
              nodeCount: 6,
              edgeCount: 2,
            },
          },
        };
      }
      return { ok: false, error: 'unexpected' };
    });
    const { container } = render(<ConnectionsView initialAnchor={sweepAnchor} />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    // Both visible textContent AND user-visible attributes (title, aria-
    // label) must stay clean — tooltips are visible-on-hover and the
    // formatter's `display.tooltip` reaches users through NodeChip /
    // NodeRow / PathFinder.
    const forbidden: readonly { readonly name: string; readonly re: RegExp }[] = [
      { name: 'tses_*', re: /tses_[A-Z0-9]/ },
      { name: 'visit-instance:', re: /visit-instance:/ },
      { name: 'tab-session:', re: /tab-session:/ },
      // Replica ids may contain dots, colons, slashes; widen past the
      // narrower [A-Za-z0-9_-] character class so we catch real shapes.
      { name: 'replica:<id>', re: /\breplica:[^\s"'<>]+/ },
      // Bare or prefix-stripped replica ids ("replica-A", "replica-foo")
      // — TimelineRail used to fall back to the trimmed form in its
      // visible label, and that's exactly the shape we want to catch.
      { name: 'replica-<id>', re: /\breplica-[A-Za-z0-9_]+\b/ },
      // Any bare workstream bac_id leaking through (more general than
      // the single fixture id), and the specific fixture for belt-and-
      // suspenders coverage.
      { name: 'bac_*', re: /\bbac_[A-Za-z0-9_-]+\b/ },
    ];
    const visible = container.textContent ?? '';
    for (const { name, re } of forbidden) {
      expect(visible, `visible text leaks ${name}`).not.toMatch(re);
    }
    // Attribute sweep — only check the attributes the user actually
    // sees: `title` (hover tooltip) and `aria-label` (screen readers).
    // `<option value>`, `data-testid`, `class`, `id`, `href` and similar
    // functional attributes legitimately carry raw ids (action keys,
    // form values, navigation targets) and are not surfaced as visible
    // text.
    const USER_VISIBLE_ATTRS: readonly string[] = ['title', 'aria-label'];
    const all = container.querySelectorAll('*');
    for (const el of all) {
      for (const attrName of USER_VISIBLE_ATTRS) {
        const value = el.getAttribute(attrName);
        if (value === null || value.length === 0) continue;
        for (const { name, re } of forbidden) {
          expect(value, `<${el.tagName.toLowerCase()} ${attrName}> leaks ${name}`).not.toMatch(re);
        }
      }
    }
  });

  // T1-F-loading — the loading row used to render `<code>{anchor}</code>`
  // which leaks the raw nodeId for tab-session / visit-instance anchors.
  // Capture the snapshot fetch in a never-resolving promise so the
  // loading row stays visible, then assert the visible text contains
  // no forbidden id patterns.
  it('never leaks the anchor id in the loading row', async () => {
    const loadingAnchor = 'tab-session:tses_01KSWEEPLOAD0000000000ANCH';
    let neverResolve!: () => void;
    const stuck = new Promise<{ readonly ok: boolean }>((resolve) => {
      neverResolve = () => resolve({ ok: false });
    });
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return stuck as unknown as { ok: boolean; data: unknown };
      }
      return { ok: false, error: 'unexpected' };
    });
    const { container } = render(<ConnectionsView initialAnchor={loadingAnchor} />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-loading')).not.toBeNull();
    });
    const loadingRow = container.querySelector('[data-testid="connections-loading"]');
    const text = loadingRow?.textContent ?? '';
    expect(text).not.toMatch(/tses_[A-Z0-9]/);
    expect(text).not.toMatch(/tab-session:/);
    expect(text).not.toMatch(/visit-instance:/);
    expect(text).toMatch(/Fetching neighbors of/u);
    neverResolve();
  });
});
