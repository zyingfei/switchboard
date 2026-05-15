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
    render(
      <ConnectionsView
        initialAnchor="thread:thread_a"
        displayCtx={{
          resolveWorkstreamPath: () => null,
          replicaAlias: (replicaId) => (replicaId === 'mac' ? 'This browser' : 'Browser'),
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId('connections-timeline')).not.toBeNull();
    });
    const rail = screen.getByTestId('connections-timeline');
    expect(within(rail).getByText('Observed activity')).toBeDefined();
    expect(within(rail).getByText('2026-05-14-2026-05-15')).toBeDefined();
    expect(within(rail).getByText(/scale: hours/)).toBeDefined();
    expect(within(rail).getByText('Presence')).toBeDefined();
    expect(within(rail).getByText('Anchor')).toBeDefined();
    expect(within(rail).getByText('Related')).toBeDefined();
    expect(within(rail).getByText('mac (current)')).toBeDefined();
    expect(within(rail).getByTestId('timeline-marker-anchor')).toBeDefined();
    fireEvent.mouseEnter(within(rail).getByTestId('timeline-marker-related-workstream:ws_x'));
    expect(screen.getByTestId('node-workstream:ws_x').className).toContain('is-timeline-hovered');
    expect(screen.getByTestId('edge-e1').className).toContain('is-timeline-hovered');
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
