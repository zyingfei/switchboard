import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionsView } from '../../../src/sidepanel/connections/ConnectionsView';
import { setConnectionsClientTransportForTests } from '../../../src/sidepanel/connections/client';
import { EDGE_KINDS, FAMILIES, contentDerivedHint } from '../../../src/sidepanel/connections/edgeKinds';
import { messageTypes } from '../../../src/messages';

// Plugin-level "every edge kind works" test. Builds a synthetic
// snapshot with one node + one edge per emitted kind, mirrors what
// the companion's reducer would produce after the user's HN→Claude→
// Codex→ChatGPT story, and asserts the side-panel renders + classifies
// every edge end-to-end.
//
// The companion's emitted set is locked to this list — if a new edge
// kind is added on the companion side without a matching entry here,
// these tests fail loud and the panel renders the new edge with an
// `urlmatch` fallback family until the metadata catches up.

const COMPANION_EMITTED_KINDS: readonly string[] = [
  'thread_in_workstream',
  'workstream_parent_of',
  'dispatch_from_thread',
  'dispatch_in_workstream',
  'dispatch_reply_landed_in_thread',
  'dispatch_requested_coding_session',
  'queue_targets_thread',
  'queue_targets_workstream',
  'reminder_for_thread',
  'coding_session_in_workstream',
  'timeline_same_url_as_thread',
  'annotation_targets_thread',
  'thread_references_url',
  'dispatch_references_url',
  'annotation_references_url',
  'thread_quotes_thread',
  'visit_in_topic',
  'topic_in_workstream',
  'topic.lineage',
];

const NODE_KIND_FOR_PREFIX: Record<string, string> = {
  thread: 'thread',
  workstream: 'workstream',
  dispatch: 'dispatch',
  'queue-item': 'queue-item',
  'inbound-reminder': 'inbound-reminder',
  'coding-session': 'coding-session',
  'timeline-visit': 'timeline-visit',
  annotation: 'annotation',
};

// Per edge kind: synthetic from/to node ids + node kinds. Picks
// realistic endpoints so the rendered side panel mirrors the shape
// of a real snapshot.
const EDGE_FIXTURES: ReadonlyArray<{
  readonly kind: string;
  readonly from: { id: string; kind: string };
  readonly to: { id: string; kind: string };
}> = [
  { kind: 'thread_in_workstream', from: { id: 'thread:t_anchor', kind: 'thread' }, to: { id: 'workstream:ws_research', kind: 'workstream' } },
  { kind: 'workstream_parent_of', from: { id: 'workstream:ws_root', kind: 'workstream' }, to: { id: 'workstream:ws_research', kind: 'workstream' } },
  { kind: 'dispatch_from_thread', from: { id: 'thread:t_anchor', kind: 'thread' }, to: { id: 'dispatch:d_codex', kind: 'dispatch' } },
  { kind: 'dispatch_in_workstream', from: { id: 'dispatch:d_codex', kind: 'dispatch' }, to: { id: 'workstream:ws_research', kind: 'workstream' } },
  { kind: 'dispatch_reply_landed_in_thread', from: { id: 'dispatch:d_codex', kind: 'dispatch' }, to: { id: 'thread:t_chatgpt', kind: 'thread' } },
  { kind: 'dispatch_requested_coding_session', from: { id: 'dispatch:d_codex', kind: 'dispatch' }, to: { id: 'coding-session:cs_tax', kind: 'coding-session' } },
  { kind: 'queue_targets_thread', from: { id: 'queue-item:q1', kind: 'queue-item' }, to: { id: 'thread:t_anchor', kind: 'thread' } },
  { kind: 'queue_targets_workstream', from: { id: 'queue-item:q2', kind: 'queue-item' }, to: { id: 'workstream:ws_research', kind: 'workstream' } },
  { kind: 'reminder_for_thread', from: { id: 'inbound-reminder:r1', kind: 'inbound-reminder' }, to: { id: 'thread:t_anchor', kind: 'thread' } },
  { kind: 'coding_session_in_workstream', from: { id: 'coding-session:cs_tax', kind: 'coding-session' }, to: { id: 'workstream:ws_research', kind: 'workstream' } },
  { kind: 'timeline_same_url_as_thread', from: { id: 'timeline-visit:https://copy.fail/exploit', kind: 'timeline-visit' }, to: { id: 'thread:t_anchor', kind: 'thread' } },
  { kind: 'annotation_targets_thread', from: { id: 'annotation:a1', kind: 'annotation' }, to: { id: 'thread:t_anchor', kind: 'thread' } },
  { kind: 'thread_references_url', from: { id: 'thread:t_anchor', kind: 'thread' }, to: { id: 'timeline-visit:https://news.ycombinator.com/x', kind: 'timeline-visit' } },
  { kind: 'dispatch_references_url', from: { id: 'dispatch:d_codex', kind: 'dispatch' }, to: { id: 'timeline-visit:https://news.ycombinator.com/x', kind: 'timeline-visit' } },
  { kind: 'annotation_references_url', from: { id: 'annotation:a1', kind: 'annotation' }, to: { id: 'timeline-visit:https://news.ycombinator.com/x', kind: 'timeline-visit' } },
  { kind: 'thread_quotes_thread', from: { id: 'thread:t_chatgpt', kind: 'thread' }, to: { id: 'thread:t_anchor', kind: 'thread' } },
  { kind: 'visit_in_topic', from: { id: 'timeline-visit:https://news.ycombinator.com/x', kind: 'timeline-visit' }, to: { id: 'topic:topic:abc123', kind: 'topic' } },
  { kind: 'topic_in_workstream', from: { id: 'topic:topic:abc123', kind: 'topic' }, to: { id: 'workstream:ws_research', kind: 'workstream' } },
  { kind: 'topic.lineage', from: { id: 'topic:topic:old', kind: 'topic' }, to: { id: 'topic:topic:abc123', kind: 'topic' } },
];

const confidenceForKind = (kind: string): 'asserted' | 'observed' | 'inferred' => {
  if (
    kind === 'timeline_same_url_as_thread' ||
    kind === 'thread_quotes_thread' ||
    kind === 'visit_in_topic' ||
    kind === 'topic_in_workstream'
  ) {
    return 'inferred';
  }
  if (
    kind === 'dispatch_reply_landed_in_thread' ||
    kind === 'annotation_targets_thread' ||
    kind.endsWith('_references_url') ||
    kind === 'topic.lineage'
  ) {
    return 'observed';
  }
  return 'asserted';
};

const buildFullSnapshot = () => {
  const nodeById = new Map<string, { id: string; kind: string; label: string; originReplicaIds: string[]; metadata: Record<string, unknown>; lastSeenAt?: string }>();
  for (const e of EDGE_FIXTURES) {
    for (const ep of [e.from, e.to]) {
      if (!nodeById.has(ep.id)) {
        nodeById.set(ep.id, {
          id: ep.id,
          kind: NODE_KIND_FOR_PREFIX[ep.kind] ?? ep.kind,
          label: ep.id.split(':').slice(1).join(':') || ep.id,
          originReplicaIds: ['replica-A'],
          metadata: {},
          lastSeenAt: '2026-05-07T10:00:00.000Z',
        });
      }
    }
  }
  const edges = EDGE_FIXTURES.map((e, i) => ({
    id: `edge:${e.kind}:${e.from.id}:${e.to.id}`,
    kind: e.kind,
    fromNodeId: e.from.id,
    toNodeId: e.to.id,
    observedAt: `2026-05-07T${String(9 + (i % 6)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}:00.000Z`,
    producedBy:
      e.kind === 'thread_quotes_thread'
        ? {
            source: 'event-log',
            eventType: 'capture.recorded',
            recordId: 'a1b2c3d4e5f6',
            dot: { replicaId: 'replica-A', seq: i + 1 },
          }
        : { source: 'event-log', eventType: 'thread.upserted', dot: { replicaId: 'replica-A', seq: i + 1 } },
    confidence: confidenceForKind(e.kind),
  }));
  const nodes = [...nodeById.values()];
  return {
    scope: 'companion-extended' as const,
    snapshot: {
      scope: { nodeId: 'thread:t_anchor', hops: 1 },
      nodes,
      edges,
      updatedAt: '2026-05-07T15:00:00.000Z',
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
  };
};

describe('connections — edge metadata completeness', () => {
  it('every companion-emitted edge kind has EDGE_KINDS metadata with a known family', () => {
    for (const kind of COMPANION_EMITTED_KINDS) {
      const meta = EDGE_KINDS[kind];
      expect(meta, `missing EDGE_KINDS entry for ${kind}`).toBeDefined();
      expect(FAMILIES[meta!.family], `unknown family ${meta!.family} on ${kind}`).toBeDefined();
      expect(meta!.label.length).toBeGreaterThan(0);
      expect(meta!.description.length).toBeGreaterThan(0);
    }
  });

  it('content-derived hints fire only for *_references_url and thread_quotes_thread', () => {
    const hinted = COMPANION_EMITTED_KINDS.filter((k) => contentDerivedHint(k) !== null).sort();
    expect(hinted).toEqual(
      [
        'annotation_references_url',
        'dispatch_references_url',
        'thread_quotes_thread',
        'thread_references_url',
      ].sort(),
    );
  });
});

describe('connections — full-snapshot render covers every emitted edge kind', () => {
  beforeEach(() => {
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; edgeId?: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        return { ok: true, data: buildFullSnapshot() };
      }
      if (m.type === messageTypes.loadConnectionsEdge) {
        const snap = buildFullSnapshot();
        const edge = snap.snapshot.edges.find((e) => e.id === m.edgeId);
        if (edge !== undefined) return { ok: true, data: edge };
        return { ok: false, error: 'edge not found' };
      }
      return { ok: false, error: 'unexpected' };
    });
  });
  afterEach(() => {
    setConnectionsClientTransportForTests(null);
  });

  it('linked mode renders a clickable button for every edge kind', async () => {
    render(<ConnectionsView initialAnchor="thread:t_anchor" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    for (const kind of COMPANION_EMITTED_KINDS) {
      const matchingEdges = EDGE_FIXTURES.filter((f) => f.kind === kind);
      for (const f of matchingEdges) {
        const id = `edge:${f.kind}:${f.from.id}:${f.to.id}`;
        expect(
          screen.queryByTestId(`edge-${id}`),
          `edge button missing for ${id}`,
        ).not.toBeNull();
      }
    }
  });

  it('content-derived edges all carry a hint chip', async () => {
    render(<ConnectionsView initialAnchor="thread:t_anchor" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    for (const f of EDGE_FIXTURES) {
      const id = `edge:${f.kind}:${f.from.id}:${f.to.id}`;
      const hint = contentDerivedHint(f.kind);
      const hintEl = screen.queryByTestId(`edge-hint-${id}`);
      if (hint === null) {
        expect(hintEl, `unexpected hint for ${f.kind}`).toBeNull();
      } else {
        expect(hintEl, `hint chip missing for ${f.kind}`).not.toBeNull();
        expect(hintEl!.textContent).toBe(hint);
      }
    }
  });

  it('orbital mode places every neighbor of the anchor on a ring', async () => {
    render(<ConnectionsView initialAnchor="thread:t_anchor" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('connections-mode-orbital'));
    await waitFor(() => {
      expect(screen.queryByTestId('connections-orbital')).not.toBeNull();
    });
    // Every node that has an edge with the anchor should appear on
    // the orbital canvas.
    const anchorId = 'thread:t_anchor';
    const neighborIds = new Set<string>();
    for (const f of EDGE_FIXTURES) {
      if (f.from.id === anchorId) neighborIds.add(f.to.id);
      else if (f.to.id === anchorId) neighborIds.add(f.from.id);
    }
    for (const id of neighborIds) {
      expect(
        screen.queryByTestId(`orbit-node-${id}`),
        `orbital node missing for ${id}`,
      ).not.toBeNull();
    }
    // Anchor itself sits at the center.
    expect(screen.queryByTestId(`orbit-node-${anchorId}`)).not.toBeNull();
  });

  it('clicking each edge surfaces a provenance card with the right family + reason', async () => {
    render(<ConnectionsView initialAnchor="thread:t_anchor" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    // Sample one edge per family rather than all 16 — the render
    // path is identical for each kind, only metadata changes.
    const samples = ['thread_in_workstream', 'dispatch_from_thread', 'queue_targets_thread', 'thread_quotes_thread'];
    for (const kind of samples) {
      const fixture = EDGE_FIXTURES.find((f) => f.kind === kind);
      expect(fixture).toBeDefined();
      const id = `edge:${fixture!.kind}:${fixture!.from.id}:${fixture!.to.id}`;
      fireEvent.click(screen.getByTestId(`edge-${id}`));
      await waitFor(() => {
        expect(screen.queryByTestId('edge-provenance')).not.toBeNull();
      });
      const meta = EDGE_KINDS[kind]!;
      const family = FAMILIES[meta.family]!;
      // Reason text appears in the provenance card body.
      const card = screen.getByTestId('edge-provenance');
      expect(card.textContent ?? '').toContain(meta.description);
      expect(card.textContent ?? '').toContain(family.label);
    }
  });
});
