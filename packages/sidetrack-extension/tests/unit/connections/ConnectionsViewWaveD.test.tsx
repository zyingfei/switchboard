import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionsView } from '../../../src/sidepanel/connections/ConnectionsView';
import { setConnectionsClientTransportForTests } from '../../../src/sidepanel/connections/client';
import { messageTypes } from '../../../src/messages';

const buildWaveDSnapshot = () => ({
  scope: 'companion-extended',
  snapshot: {
    scope: { nodeId: 'workstream:ws_a', hops: 1 },
    nodes: [
      {
        id: 'workstream:ws_a',
        kind: 'workstream',
        label: 'Workstream A',
        originReplicaIds: ['replica-a'],
        metadata: {},
      },
      {
        id: 'topic:topic_a',
        kind: 'topic',
        label: 'Topic A',
        originReplicaIds: [],
        metadata: { cohesion: 0.91, memberCount: 1, dominantWorkstreamId: 'ws_a' },
      },
      {
        id: 'timeline-visit:https://example.test/a',
        kind: 'timeline-visit',
        label: 'Visit A',
        lastSeenAt: '2026-05-08T10:00:00.000Z',
        originReplicaIds: ['replica-a'],
        metadata: {
          canonicalUrl: 'https://example.test/a',
          tabSessionIdHash: 'tab-a',
          focusedWindowMs: 10_000,
          engagement: { class: 'engaged_read' },
        },
      },
      {
        id: 'replica:replica-b',
        kind: 'replica',
        label: 'replica-b',
        originReplicaIds: ['replica-b'],
        metadata: {},
      },
    ],
    edges: [
      {
        id: 'edge:visit-topic',
        kind: 'visit_in_topic',
        fromNodeId: 'timeline-visit:https://example.test/a',
        toNodeId: 'topic:topic_a',
        observedAt: '2026-05-08T10:00:00.000Z',
        producedBy: { source: 'topic-clusterer' },
        confidence: 'inferred',
      },
      {
        id: 'edge:visit-replica',
        kind: 'visit_observed_on_replica',
        fromNodeId: 'timeline-visit:https://example.test/a',
        toNodeId: 'replica:replica-b',
        observedAt: '2026-05-08T10:00:00.000Z',
        producedBy: { source: 'cross-replica' },
        confidence: 'observed',
      },
    ],
    updatedAt: '2026-05-08T10:00:00.000Z',
    nodeCount: 4,
    edgeCount: 2,
  },
});

describe('ConnectionsView — Wave D modes', () => {
  beforeEach(() => {
    setConnectionsClientTransportForTests((message) => {
      const typed = message as { readonly type?: string };
      if (typed.type === messageTypes.loadConnectionsNeighbors) {
        return Promise.resolve({ ok: true, data: buildWaveDSnapshot() });
      }
      if (typed.type === messageTypes.loadConnectionsSnapshot) {
        return Promise.resolve({ ok: true, data: buildWaveDSnapshot() });
      }
      return Promise.resolve({ ok: false, error: 'unexpected message' });
    });
  });

  afterEach(() => {
    setConnectionsClientTransportForTests(null);
  });

  it('routes Flow Path, Focus, and Why Related inside ConnectionsView', async () => {
    render(<ConnectionsView initialAnchor="workstream:ws_a" />);

    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-flow')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('connections-mode-flow'));
    expect(screen.getByTestId('flow-path-view')).toBeDefined();
    fireEvent.click(screen.getByTestId('flow-visit-timeline-visit:https://example.test/a'));
    expect(screen.getByTestId('why-related-panel')).toBeDefined();

    fireEvent.click(screen.getByTestId('connections-mode-focus'));
    expect(screen.getByTestId('focus-view')).toBeDefined();
    expect(screen.getByTestId('focus-topic-topic:topic_a')).toBeDefined();

    // Context Pack is intentionally gated off (modeAvailability.context
    // .hidden === true — "Hidden until Context Pack is implemented" in
    // ConnectionsView.tsx). The tab must not render; if someone flips
    // the gate without wiring the composer route, this fails loud.
    expect(screen.queryByTestId('connections-mode-context')).toBeNull();
  });

  it('posts engagement relabel feedback from Focus mode', async () => {
    const sent: unknown[] = [];
    setConnectionsClientTransportForTests((message) => {
      sent.push(message);
      const typed = message as { readonly type?: string };
      if (typed.type === messageTypes.loadConnectionsNeighbors) {
        return Promise.resolve({ ok: true, data: buildWaveDSnapshot() });
      }
      if (typed.type === messageTypes.postConnectionsFeedbackEvent) {
        return Promise.resolve({
          ok: true,
          data: { accepted: { dot: { replicaId: 'local', seq: 1 } } },
        });
      }
      return Promise.resolve({ ok: false, error: 'unexpected message' });
    });

    render(<ConnectionsView initialAnchor="workstream:ws_a" />);

    await waitFor(() => {
      expect(screen.queryByTestId('connections-mode-focus')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-focus'));
    fireEvent.click(screen.getByText('Topic A'));
    fireEvent.click(screen.getByTestId('focus-visit-label-timeline-visit:https://example.test/a'));
    fireEvent.change(
      screen.getByTestId('focus-visit-engagement-timeline-visit:https://example.test/a'),
      { target: { value: 'worked_on_reference' } },
    );

    await waitFor(() => {
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: messageTypes.postConnectionsFeedbackEvent,
          event: {
            type: 'user.engagement.relabeled',
            payload: {
              payloadVersion: 1,
              visitId: 'timeline-visit:https://example.test/a',
              fromClass: 'engaged_read',
              toClass: 'worked_on_reference',
            },
          },
        }),
      );
    });
  });
});
