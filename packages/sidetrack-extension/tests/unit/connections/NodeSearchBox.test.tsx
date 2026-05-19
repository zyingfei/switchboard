import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NodeSearchBox } from '../../../src/sidepanel/connections/NodeSearchBox';
import type { ConnectionNode } from '../../../src/sidepanel/connections/types';

const ctx = {
  resolveWorkstreamPath: () => null,
  replicaAlias: () => 'Browser',
};

const node = (
  input: Partial<ConnectionNode> & { id: string; kind: ConnectionNode['kind'] },
): ConnectionNode => ({
  label: '',
  originReplicaIds: [],
  metadata: {},
  ...input,
});

describe('NodeSearchBox', () => {
  it('shows top hits ranked by prefix + length when the user types', () => {
    const nodes = [
      node({
        id: 'thread:T1',
        kind: 'thread',
        metadata: { title: 'Netflix ArchUnit Scaling' },
      }),
      node({
        id: 'thread:T2',
        kind: 'thread',
        metadata: { title: 'Hacker News May 4 2026' },
      }),
      node({
        id: 'visit-instance:V1',
        kind: 'visit-instance',
        metadata: { title: 'Hacker News', canonicalUrl: 'https://news.ycombinator.com/news' },
      }),
    ];
    const onPick = vi.fn();
    render(<NodeSearchBox nodes={nodes} extras={[]} ctx={ctx} onPick={onPick} />);
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'hacker' },
    });
    // Both Hacker-News titles should appear; the shorter (visit-instance
    // "Hacker News") ranks above the longer threadcard title.
    const hits = screen.getAllByTestId(/connections-search-hit-/u);
    expect(hits).toHaveLength(2);
    expect(hits[0].textContent).toContain('Hacker News');
  });

  it('picks the top hit on Enter', () => {
    const nodes = [
      node({
        id: 'thread:T1',
        kind: 'thread',
        metadata: { title: 'Chicago Visit Plan' },
      }),
    ];
    const onPick = vi.fn();
    render(<NodeSearchBox nodes={nodes} extras={[]} ctx={ctx} onPick={onPick} />);
    const input = screen.getByLabelText('Find an anchor by title');
    fireEvent.change(input, { target: { value: 'chicago' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('thread:T1');
  });

  it('searches across extras (workstream anchors + recents) too', () => {
    const onPick = vi.fn();
    render(
      <NodeSearchBox
        nodes={[]}
        extras={[
          { id: 'workstream:WS1', label: 'linux-security', kind: 'workstream' },
          { id: 'workstream:WS2', label: 'trading', kind: 'workstream' },
        ]}
        ctx={ctx}
        onPick={onPick}
      />,
    );
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'trad' },
    });
    fireEvent.click(screen.getByTestId('connections-search-hit-workstream:WS2'));
    expect(onPick).toHaveBeenCalledWith('workstream:WS2');
  });

  it('shows a "no matches" placeholder when nothing hits', () => {
    render(
      <NodeSearchBox
        nodes={[node({ id: 'thread:T1', kind: 'thread', metadata: { title: 'Chicago' } })]}
        extras={[]}
        ctx={ctx}
        onPick={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'zzzz-no-match' },
    });
    expect(screen.getByText(/No matches across the full snapshot/)).toBeInTheDocument();
  });

  it('primes the full-snapshot fetch on focus when onPrime is provided', () => {
    const onPrime = vi.fn();
    render(<NodeSearchBox nodes={[]} extras={[]} ctx={ctx} onPick={vi.fn()} onPrime={onPrime} />);
    fireEvent.focus(screen.getByLabelText('Find an anchor by title'));
    expect(onPrime).toHaveBeenCalled();
  });

  it('renders a "Content matches" group with recall hits and anchors on thread on click', () => {
    const onPick = vi.fn();
    render(
      <NodeSearchBox
        nodes={[]}
        extras={[]}
        ctx={ctx}
        onPick={onPick}
        recallHits={[
          {
            threadId: 'T1',
            title: 'Pro-Questions - Copy Fail',
            threadUrl: 'https://chatgpt.com/c/abc',
            score: 0.95,
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'copy fail' },
    });
    expect(screen.getByTestId('connections-search-recall-head')).toHaveTextContent(
      /Content matches/i,
    );
    fireEvent.click(screen.getByTestId('connections-search-recall-T1'));
    expect(onPick).toHaveBeenCalledWith('thread:T1');
  });

  it('shows "Content matches · searching…" when recall is loading and no hits yet', () => {
    render(
      <NodeSearchBox
        nodes={[]}
        extras={[]}
        ctx={ctx}
        onPick={vi.fn()}
        recallLoading
        recallHits={[]}
      />,
    );
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'anything' },
    });
    expect(screen.getByTestId('connections-search-recall-head')).toHaveTextContent(/searching…/i);
  });

  it('shows a "searching" hint while loading', () => {
    render(<NodeSearchBox nodes={[]} extras={[]} ctx={ctx} onPick={vi.fn()} loading />);
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'anything' },
    });
    expect(screen.getByTestId('connections-search-loading')).toHaveTextContent(/Searching…/);
  });

  it('clears + closes on Escape', () => {
    const onPick = vi.fn();
    render(
      <NodeSearchBox
        nodes={[node({ id: 'thread:T1', kind: 'thread', metadata: { title: 'Chicago' } })]}
        extras={[]}
        ctx={ctx}
        onPick={onPick}
      />,
    );
    const input = screen.getByLabelText('Find an anchor by title');
    fireEvent.change(input, { target: { value: 'chic' } });
    expect(screen.getAllByTestId(/connections-search-hit-/u).length).toBeGreaterThan(0);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('connections-search-results')).toBeNull();
  });

  it('opens the full Search surface with the current query', () => {
    const onOpenFullSearch = vi.fn();
    render(
      <NodeSearchBox
        nodes={[node({ id: 'thread:T1', kind: 'thread', metadata: { title: 'Chicago' } })]}
        extras={[]}
        ctx={ctx}
        onPick={vi.fn()}
        onOpenFullSearch={onOpenFullSearch}
      />,
    );
    fireEvent.change(screen.getByLabelText('Find an anchor by title'), {
      target: { value: 'chic' },
    });
    fireEvent.click(screen.getByTestId('connections-search-open-tab'));
    expect(onOpenFullSearch).toHaveBeenCalledWith('chic');
  });
});
