import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionsView } from '../../../src/sidepanel/connections/ConnectionsView';
import { setConnectionsClientTransportForTests } from '../../../src/sidepanel/connections/client';
import { messageTypes } from '../../../src/messages';

import wsSecuritySubgraph from './__fixtures__/subgraph_ws_security.json';
import wsPostgresSubgraph from './__fixtures__/subgraph_ws_postgres.json';
import wsSidetrackSubgraph from './__fixtures__/subgraph_ws_sidetrack.json';
import hnPgMergeSubgraph from './__fixtures__/subgraph_hn_pgmerge.json';

// Layer-2 multi-flow render integration test.
//
// Reads the precomputed per-anchor subgraphs the companion's
// Layer-1 test dumps when MULTI_FLOW_DUMP=1 is set. The transport
// mock routes each `loadConnectionsNeighbors` call to the matching
// subgraph by anchor node id.
//
// What this proves at the panel level:
//   - Anchoring on a workstream renders ONLY that flow's nodes
//     (separation of parallel research flows).
//   - The orbital sub-mode places every neighbor on the canvas.
//   - The cross-flow HN URL anchor reveals threads from both
//     workstreams it bridges (Flows B and C in the fixture).

const SUBGRAPHS_BY_ANCHOR: Record<string, unknown> = {
  'workstream:ws_security': wsSecuritySubgraph,
  'workstream:ws_postgres': wsPostgresSubgraph,
  'workstream:ws_sidetrack': wsSidetrackSubgraph,
  'timeline-visit:https://news.ycombinator.com/item?id=42_pgmerge': hnPgMergeSubgraph,
};

interface SubgraphEnvelope {
  scope: string;
  snapshot: {
    nodes: Array<{ id: string; kind: string; label: string }>;
    edges: Array<{ id: string; kind: string; fromNodeId: string; toNodeId: string }>;
  };
}

const subgraphFor = (anchor: string): SubgraphEnvelope =>
  SUBGRAPHS_BY_ANCHOR[anchor] as SubgraphEnvelope;

const nodeIdsIn = (envelope: SubgraphEnvelope): Set<string> =>
  new Set(envelope.snapshot.nodes.map((n) => n.id));

describe('connections — multi-flow render integration', () => {
  beforeEach(() => {
    setConnectionsClientTransportForTests(async (msg) => {
      const m = msg as { type: string; nodeId?: string; edgeId?: string };
      if (m.type === messageTypes.loadConnectionsNeighbors) {
        const sub = SUBGRAPHS_BY_ANCHOR[m.nodeId ?? ''];
        if (sub === undefined) return { ok: false, error: `no fixture for ${String(m.nodeId)}` };
        return { ok: true, data: sub };
      }
      if (m.type === messageTypes.loadConnectionsEdge) {
        // Find the edge across all subgraphs.
        for (const sub of Object.values(SUBGRAPHS_BY_ANCHOR) as SubgraphEnvelope[]) {
          const edge = sub.snapshot.edges.find((e) => e.id === m.edgeId);
          if (edge !== undefined) return { ok: true, data: edge };
        }
        return { ok: false, error: 'edge not found' };
      }
      return { ok: false, error: 'unexpected' };
    });
  });
  afterEach(() => {
    setConnectionsClientTransportForTests(null);
  });

  it('Flow A anchor (ws_security): linked panel renders only Flow A nodes', async () => {
    const sub = subgraphFor('workstream:ws_security');
    const expected = nodeIdsIn(sub);
    render(<ConnectionsView initialAnchor="workstream:ws_security" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    // Every neighbor node in the subgraph (excluding the anchor
    // itself) renders at least one row with data-testid="node-{id}".
    // Post-"card-everywhere" (6e661770) a node that participates in
    // several edge kinds renders once per kind group, so a node id can
    // legitimately appear multiple times — assert presence via
    // queryAllByTestId, not the singular query which throws on >1.
    for (const id of expected) {
      if (id === 'workstream:ws_security') continue;
      expect(
        screen.queryAllByTestId(`node-${id}`).length,
        `expected ${id} to render in Flow A panel`,
      ).toBeGreaterThan(0);
    }
    // No Flow B or Flow C exclusive thread leaks in.
    expect(screen.queryAllByTestId('node-thread:t_pg_claude')).toHaveLength(0);
    expect(screen.queryAllByTestId('node-thread:t_sb_claude')).toHaveLength(0);
  });

  it('Flow B anchor (ws_postgres): linked panel renders only Flow B nodes', async () => {
    const sub = subgraphFor('workstream:ws_postgres');
    const expected = nodeIdsIn(sub);
    render(<ConnectionsView initialAnchor="workstream:ws_postgres" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    for (const id of expected) {
      if (id === 'workstream:ws_postgres') continue;
      expect(
        screen.queryAllByTestId(`node-${id}`).length,
        `expected ${id} to render in Flow B panel`,
      ).toBeGreaterThan(0);
    }
    expect(screen.queryAllByTestId('node-thread:t_cve_claude')).toHaveLength(0);
    expect(screen.queryAllByTestId('node-thread:t_sb_claude')).toHaveLength(0);
  });

  it('Flow C anchor (ws_sidetrack): linked panel renders only Flow C nodes', async () => {
    const sub = subgraphFor('workstream:ws_sidetrack');
    const expected = nodeIdsIn(sub);
    render(<ConnectionsView initialAnchor="workstream:ws_sidetrack" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    for (const id of expected) {
      if (id === 'workstream:ws_sidetrack') continue;
      expect(
        screen.queryAllByTestId(`node-${id}`).length,
        `expected ${id} to render in Flow C panel`,
      ).toBeGreaterThan(0);
    }
    expect(screen.queryAllByTestId('node-thread:t_cve_claude')).toHaveLength(0);
    expect(screen.queryAllByTestId('node-thread:t_pg_claude')).toHaveLength(0);
  });

  it('cross-flow HN URL anchor reveals both Postgres and Sidetrack Claude threads', async () => {
    render(
      <ConnectionsView initialAnchor="timeline-visit:https://news.ycombinator.com/item?id=42_pgmerge" />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    expect(screen.queryAllByTestId('node-thread:t_pg_claude').length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId('node-thread:t_sb_claude').length).toBeGreaterThan(0);
  });

  it('Orbital sub-mode places every Flow A neighbor on the canvas at 2-hop', async () => {
    const sub = subgraphFor('workstream:ws_security');
    render(<ConnectionsView initialAnchor="workstream:ws_security" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    // Switch to 2-hop so the outer-ring placement runs (annotation
    // and reminder nodes are at ring=2 from the workstream anchor).
    fireEvent.click(screen.getByRole('button', { name: '2-hop' }));
    fireEvent.click(screen.getByTestId('connections-mode-orbital'));
    await waitFor(() => {
      expect(screen.queryByTestId('connections-orbital')).not.toBeNull();
    });
    // Every node in the fixture's 2-hop subgraph (which is exactly
    // what the panel fetches for hops=2) lands on the canvas.
    for (const id of nodeIdsIn(sub)) {
      expect(
        screen.queryByTestId(`orbit-node-${id}`),
        `orbital missing ${id} for Flow A`,
      ).not.toBeNull();
    }
  });

  it('clicking a thread_quotes_thread edge surfaces provenance with the recordId hash prefix', async () => {
    render(<ConnectionsView initialAnchor="workstream:ws_security" />);
    await waitFor(() => {
      expect(screen.queryByTestId('connections-groups')).not.toBeNull();
    });
    const sub = subgraphFor('workstream:ws_security');
    const quoteEdge = sub.snapshot.edges.find((e) => e.kind === 'thread_quotes_thread');
    expect(quoteEdge, 'fixture should contain a thread_quotes_thread edge').toBeDefined();
    fireEvent.click(screen.getByTestId(`edge-${quoteEdge!.id}`));
    await waitFor(() => {
      expect(screen.queryByTestId('edge-provenance')).not.toBeNull();
    });
    const prov = screen.getByTestId('edge-provenance');
    expect(within(prov).queryByTestId('edge-record-id')).not.toBeNull();
  });
});
