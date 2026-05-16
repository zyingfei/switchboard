import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SearchTab } from '../../../src/sidepanel/connections/SearchTab';
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

describe('SearchTab', () => {
  it('anchors a title result and keeps the query controlled by the parent', () => {
    const onQueryChange = vi.fn();
    const onPick = vi.fn();
    render(
      <SearchTab
        nodes={[
          node({
            id: 'thread:oracle',
            kind: 'thread',
            metadata: { title: 'Oracle Cloud Infrastructure Cloud Adoption Framework' },
          }),
        ]}
        extras={[]}
        ctx={ctx}
        query="oracle"
        onQueryChange={onQueryChange}
        onPick={onPick}
      />,
    );

    fireEvent.click(screen.getByTestId('connections-search-tab-hit-thread:oracle'));
    expect(onPick).toHaveBeenCalledWith(
      'thread:oracle',
      'Oracle Cloud Infrastructure Cloud Adoption Framework',
    );
    fireEvent.change(screen.getByTestId('connections-search-tab-input'), {
      target: { value: 'oci' },
    });
    expect(onQueryChange).toHaveBeenCalledWith('oci');
  });

  it('opens a URL result without changing the anchor', () => {
    const onOpenUrl = vi.fn();
    const onPick = vi.fn();
    const visitId = 'timeline-visit:https://docs.oracle.example/cloud';
    render(
      <SearchTab
        nodes={[
          node({
            id: visitId,
            kind: 'timeline-visit',
            metadata: {
              title: 'Oracle Cloud Infrastructure docs',
              canonicalUrl: 'https://docs.oracle.example/cloud',
            },
          }),
        ]}
        extras={[]}
        ctx={ctx}
        query="oracle"
        onQueryChange={vi.fn()}
        onPick={onPick}
        onOpenUrl={onOpenUrl}
      />,
    );

    fireEvent.click(screen.getByTestId(`connections-search-tab-open-${visitId}`));
    expect(onOpenUrl).toHaveBeenCalledWith('https://docs.oracle.example/cloud');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('filters title and content results by object kind', () => {
    const visitId = 'timeline-visit:https://docs.oracle.example/cloud';
    render(
      <SearchTab
        nodes={[
          node({
            id: 'thread:oracle',
            kind: 'thread',
            metadata: { title: 'Oracle Cloud Infrastructure thread' },
          }),
          node({
            id: visitId,
            kind: 'timeline-visit',
            metadata: {
              title: 'Oracle Cloud Infrastructure docs',
              canonicalUrl: 'https://docs.oracle.example/cloud',
            },
          }),
        ]}
        extras={[]}
        ctx={ctx}
        query="oracle"
        onQueryChange={vi.fn()}
        onPick={vi.fn()}
        recallHits={[
          {
            sourceKind: 'chat-turn',
            threadId: 'oracle',
            title: 'Oracle chat transcript',
            score: 0.91,
          },
          {
            sourceKind: 'page-content',
            anchorNodeId: visitId,
            canonicalUrl: 'https://docs.oracle.example/cloud',
            title: 'Oracle docs page',
            score: 0.88,
          },
        ]}
      />,
    );

    expect(screen.queryByTestId('connections-search-tab-hit-thread:oracle')).not.toBeNull();
    expect(screen.queryByTestId('connections-search-tab-recall-thread:oracle')).not.toBeNull();
    expect(screen.queryByTestId(`connections-search-tab-recall-${visitId}`)).not.toBeNull();

    fireEvent.click(screen.getByTestId('connections-search-kind-filter-thread'));

    expect(screen.queryByTestId('connections-search-tab-hit-thread:oracle')).toBeNull();
    expect(screen.queryByTestId('connections-search-tab-recall-thread:oracle')).toBeNull();
    expect(screen.queryByTestId(`connections-search-tab-recall-${visitId}`)).not.toBeNull();
  });

  it('browses topics on an empty query after kind filtering', () => {
    render(
      <SearchTab
        nodes={[
          ...Array.from({ length: 8 }, (_, index) =>
            node({
              id: `thread:thread_${String(index)}`,
              kind: 'thread' as const,
              metadata: { title: `Thread ${String(index)}` },
            }),
          ),
          node({
            id: 'topic:transformers',
            kind: 'topic',
            metadata: {
              representativeTitles: ['huggingface/transformers'],
              memberCount: 12,
            },
          }),
        ]}
        extras={[]}
        ctx={ctx}
        query=""
        onQueryChange={vi.fn()}
        onPick={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('connections-search-kind-filter-thread'));

    expect(screen.queryByTestId('connections-search-tab-hit-topic:transformers')).not.toBeNull();
    expect(screen.getByText('huggingface/transformers')).toBeDefined();
  });
});
