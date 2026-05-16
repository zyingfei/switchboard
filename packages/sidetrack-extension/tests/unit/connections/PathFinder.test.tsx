import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PathFinder } from '../../../src/sidepanel/connections/PathFinder';
import type { ConnectionNode } from '../../../src/sidepanel/connections/types';

vi.mock('../../../src/sidepanel/connections/client', () => ({
  fetchConnectionsPath: vi.fn(),
}));

import { fetchConnectionsPath } from '../../../src/sidepanel/connections/client';

const ctx = { resolveWorkstreamPath: () => null, replicaAlias: () => 'Browser' };

const node = (
  input: Partial<ConnectionNode> & { id: string; kind: ConnectionNode['kind'] },
): ConnectionNode => ({
  label: '',
  originReplicaIds: [],
  metadata: {},
  ...input,
});

describe('PathFinder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('renders nothing for an empty anchor', () => {
    const { container } = render(
      <PathFinder
        anchorId=""
        anchorLabel={null}
        nodes={[]}
        extras={[]}
        ctx={ctx}
        onNodeClick={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('opens the body when the toggle is clicked', () => {
    render(
      <PathFinder
        anchorId="workstream:A"
        anchorLabel="linux-security"
        nodes={[]}
        extras={[]}
        ctx={ctx}
        onNodeClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('connections-pathfinder-toggle'));
    expect(screen.getByLabelText('Find an anchor by title')).toBeInTheDocument();
  });

  it('renders the BFS chain when a path is found', async () => {
    (fetchConnectionsPath as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        found: true,
        nodes: [
          node({ id: 'workstream:A', kind: 'workstream', metadata: { title: 'linux-security' } }),
          node({ id: 'thread:T1', kind: 'thread', metadata: { title: 'Copy Fail analysis' } }),
          node({
            id: 'visit-instance:V1',
            kind: 'visit-instance',
            metadata: { title: 'Copy Fail | Hacker News' },
          }),
        ],
        edges: [
          {
            id: 'e1',
            kind: 'thread_in_workstream',
            fromNodeId: 'thread:T1',
            toNodeId: 'workstream:A',
            observedAt: '2026-05-12T00:00:00.000Z',
            producedBy: { source: 'event-log' },
            confidence: 'asserted',
          },
          {
            id: 'e2',
            kind: 'thread_references_url',
            fromNodeId: 'thread:T1',
            toNodeId: 'visit-instance:V1',
            observedAt: '2026-05-12T00:01:00.000Z',
            producedBy: { source: 'event-log' },
            confidence: 'observed',
          },
        ],
      },
    });
    render(
      <PathFinder
        anchorId="workstream:A"
        anchorLabel="linux-security"
        nodes={[
          node({ id: 'workstream:A', kind: 'workstream', metadata: { title: 'linux-security' } }),
          node({ id: 'thread:T1', kind: 'thread', metadata: { title: 'Copy Fail analysis' } }),
        ]}
        extras={[]}
        ctx={ctx}
        onNodeClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('connections-pathfinder-toggle'));
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'copy fail' },
    });
    fireEvent.keyDown(screen.getByLabelText('Find an anchor by title'), { key: 'Enter' });

    // Path search isn't tied to the search box hit; the box picks
    // a real node id, then the test mocks fetchConnectionsPath to
    // return the 3-node chain.
    await waitFor(() => {
      expect(screen.getByTestId('connections-pathfinder-chain')).toBeInTheDocument();
    });
    expect(screen.getByTestId('connections-pathfinder-pill-workstream:A')).toBeInTheDocument();
    expect(screen.getByTestId('connections-pathfinder-pill-thread:T1')).toBeInTheDocument();
    expect(screen.getByTestId('connections-pathfinder-pill-visit-instance:V1')).toBeInTheDocument();
    expect(screen.getByText(/2 edges/)).toBeInTheDocument();
  });

  it('shows a "no path" message when companion returns found=false', async () => {
    (fetchConnectionsPath as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: { found: false },
    });
    render(
      <PathFinder
        anchorId="workstream:A"
        anchorLabel="linux-security"
        nodes={[
          node({ id: 'workstream:A', kind: 'workstream', metadata: { title: 'linux-security' } }),
          node({ id: 'thread:X', kind: 'thread', metadata: { title: 'Unrelated' } }),
        ]}
        extras={[]}
        ctx={ctx}
        onNodeClick={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('connections-pathfinder-toggle'));
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'unrel' },
    });
    fireEvent.keyDown(screen.getByLabelText('Find an anchor by title'), { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('connections-pathfinder-empty')).toBeInTheDocument();
    });
  });
});
