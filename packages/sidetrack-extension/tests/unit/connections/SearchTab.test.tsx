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

  it('matches a topic by any representative title, not just the first', () => {
    const onPick = vi.fn();
    render(
      <SearchTab
        nodes={[
          node({
            id: 'topic:cartesian',
            kind: 'topic',
            label: 'Cartesian product - Wikipedia',
            metadata: {
              // primary = representativeTitles[0]; the query term lives
              // in a later member title only.
              representativeTitles: [
                'Cartesian product - Wikipedia',
                'PostgreSQL - Wikipedia',
                'How to understand the Cartesian product? - Math SE',
              ],
              memberCount: 3,
            },
          }),
        ]}
        extras={[]}
        ctx={ctx}
        query="postgres"
        onQueryChange={vi.fn()}
        onPick={onPick}
      />,
    );

    const hit = screen.queryByTestId('connections-search-tab-hit-topic:cartesian');
    expect(hit).not.toBeNull();
    fireEvent.click(hit as HTMLElement);
    // Displayed/anchored label stays the topic's primary (first title) —
    // only what we MATCH against widened, not what we show.
    expect(onPick).toHaveBeenCalledWith('topic:cartesian', 'Cartesian product - Wikipedia');
  });

  it('selects and deselects every object kind at once', () => {
    const visitId = 'timeline-visit:https://docs.oracle.example/cloud';
    render(
      <SearchTab
        nodes={[
          node({
            id: 'thread:oracle',
            kind: 'thread',
            metadata: { title: 'Oracle Cloud thread' },
          }),
          node({
            id: visitId,
            kind: 'timeline-visit',
            metadata: {
              title: 'Oracle Cloud docs',
              canonicalUrl: 'https://docs.oracle.example/cloud',
            },
          }),
        ]}
        extras={[]}
        ctx={ctx}
        query="oracle"
        onQueryChange={vi.fn()}
        onPick={vi.fn()}
      />,
    );

    const selectAll = screen.getByTestId('connections-search-kind-select-all');
    const deselectAll = screen.getByTestId('connections-search-kind-deselect-all');

    // Everything visible by default → "Select all" is a no-op (disabled).
    expect(selectAll).toBeDisabled();
    expect(deselectAll).not.toBeDisabled();
    expect(screen.queryByTestId('connections-search-tab-hit-thread:oracle')).not.toBeNull();
    expect(screen.queryByTestId(`connections-search-tab-hit-${visitId}`)).not.toBeNull();

    fireEvent.click(deselectAll);

    expect(screen.queryByTestId('connections-search-tab-hit-thread:oracle')).toBeNull();
    expect(screen.queryByTestId(`connections-search-tab-hit-${visitId}`)).toBeNull();
    expect(selectAll).not.toBeDisabled();
    expect(deselectAll).toBeDisabled();

    fireEvent.click(selectAll);

    expect(screen.queryByTestId('connections-search-tab-hit-thread:oracle')).not.toBeNull();
    expect(screen.queryByTestId(`connections-search-tab-hit-${visitId}`)).not.toBeNull();
    expect(selectAll).toBeDisabled();
  });

  it('browses every object of a narrowed kind on an empty query, paginated', () => {
    const topics = Array.from({ length: 60 }, (_, i) =>
      node({
        id: `topic:t${String(i).padStart(2, '0')}`,
        kind: 'topic',
        metadata: { representativeTitles: [`Topic ${String(i).padStart(2, '0')}`], memberCount: 2 },
      }),
    );
    const { container } = render(
      <SearchTab
        nodes={[
          ...topics,
          node({ id: 'thread:a', kind: 'thread', metadata: { title: 'A thread' } }),
        ]}
        extras={[]}
        ctx={ctx}
        query=""
        onQueryChange={vi.fn()}
        onPick={vi.fn()}
      />,
    );
    const hitCount = (): number =>
      container.querySelectorAll('[data-testid^="connections-search-tab-hit-topic:"]').length;

    // Empty query, all kinds shown → small "Quick picks" teaser, no
    // browse list (don't dump the whole snapshot).
    expect(screen.queryByTestId('connections-search-tab-show-more')).toBeNull();
    expect(hitCount()).toBeLessThanOrEqual(8);

    // Narrow to topic only: deselect all, then re-check topic.
    fireEvent.click(screen.getByTestId('connections-search-kind-deselect-all'));
    fireEvent.click(screen.getByTestId('connections-search-kind-filter-topic'));

    // Now browsing all 60 topics, first page of 50 + a "Show more".
    expect(screen.getByText('Browsing · 60')).toBeInTheDocument();
    expect(hitCount()).toBe(50);
    const more = screen.getByTestId('connections-search-tab-show-more');
    expect(more.textContent).toMatch(/Show 10 more · 10 remaining/);

    fireEvent.click(more);
    expect(hitCount()).toBe(60);
    expect(screen.queryByTestId('connections-search-tab-show-more')).toBeNull();
  });
});
