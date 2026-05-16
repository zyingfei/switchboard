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
});
