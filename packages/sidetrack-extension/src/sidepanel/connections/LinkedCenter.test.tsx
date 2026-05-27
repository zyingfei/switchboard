import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import type { EntityDisplayCtx } from '../entityDisplay/format';
import {
  LINKED_FILTERING_DEFAULTS,
  LinkedCenter,
  pickVisibleCount,
} from './LinkedCenter';
import type {
  ConnectionEdge,
  ConnectionNode,
  ConnectionNodeKind,
  ConnectionsScopedResult,
} from './types';

const ctx: EntityDisplayCtx = {
  resolveWorkstreamPath: () => null,
  replicaAlias: (replicaId) => replicaId,
};

const node = (
  id: string,
  label: string,
  kind: ConnectionNodeKind = 'timeline-visit',
): ConnectionNode => ({
  id,
  kind,
  label,
  originReplicaIds: [],
  metadata: {},
});

const edge = (
  id: string,
  kind: string,
  fromNodeId: string,
  toNodeId: string,
  score?: number,
): ConnectionEdge => ({
  id,
  kind,
  fromNodeId,
  toNodeId,
  observedAt: '2026-05-20T10:00:00.000Z',
  producedBy: { source: 'test' },
  confidence: kind === 'closest_visit' ? 'inferred' : 'observed',
  ...(score === undefined ? {} : { metadata: { score } }),
});

const resultFor = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
): ConnectionsScopedResult => ({
  scope: 'companion-extended',
  snapshot: {
    scope: { nodeId: 'timeline-visit:anchor', hops: 1 },
    nodes,
    edges,
    updatedAt: '2026-05-20T10:00:00.000Z',
    nodeCount: nodes.length,
    edgeCount: edges.length,
  },
});

const memoryLocalStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(String(key));
    },
    setItem: (key, value) => {
      values.set(String(key), String(value));
    },
  } as Storage;
};

const ensureLocalStorage = (): void => {
  if (globalThis.localStorage === undefined || typeof globalThis.localStorage.clear !== 'function') {
    Object.defineProperty(globalThis, 'localStorage', {
      value: memoryLocalStorage(),
      configurable: true,
    });
  }
  globalThis.localStorage.clear();
};

describe('pickVisibleCount', () => {
  it('caps a high-confidence tail at MAX_VISIBLE_PER_GROUP', () => {
    const scores = Array.from(
      { length: LINKED_FILTERING_DEFAULTS.MAX_VISIBLE_PER_GROUP + 5 },
      (_, index) => 0.95 - index * 0.001,
    );

    expect(pickVisibleCount(scores)).toBe(LINKED_FILTERING_DEFAULTS.MAX_VISIBLE_PER_GROUP);
  });

  it('keeps the minimum floor when every score is weak', () => {
    expect(pickVisibleCount([0.2, 0.19, 0.18, 0.17])).toBe(
      LINKED_FILTERING_DEFAULTS.MIN_VISIBLE_PER_GROUP,
    );
  });

  it('cuts at the first large adjacent score gap', () => {
    expect(pickVisibleCount([0.91, 0.87, 0.74, 0.32, 0.21])).toBe(4);
  });
});

describe('LinkedCenter filtering', () => {
  beforeEach(() => {
    ensureLocalStorage();
  });

  it('renders edge-kind groups, sorts by score, and expands hidden edges', () => {
    globalThis.localStorage.setItem('sidetrack-debug', 'linked-filtering');
    const anchor = node('timeline-visit:anchor', 'Anchor page');
    const nodes = [
      anchor,
      node('timeline-visit:weak', 'Weak related page'),
      node('timeline-visit:strong', 'Strong related page'),
      node('timeline-visit:mid', 'Mid related page'),
      node('timeline-visit:cut', 'Cut related page'),
      node('timeline-visit:hidden', 'Hidden related page'),
      node('timeline-visit:opened', 'Opened page'),
    ];
    const edges = [
      edge('closest-weak', 'closest_visit', anchor.id, 'timeline-visit:weak', 0.21),
      edge('closest-strong', 'closest_visit', anchor.id, 'timeline-visit:strong', 0.91),
      edge('opener', 'opener_visit', anchor.id, 'timeline-visit:opened'),
      edge('closest-mid', 'closest_visit', anchor.id, 'timeline-visit:mid', 0.87),
      edge('closest-cut', 'closest_visit', anchor.id, 'timeline-visit:cut', 0.74),
      edge('closest-hidden', 'closest_visit', anchor.id, 'timeline-visit:hidden', 0.32),
    ];

    render(
      <LinkedCenter
        result={resultFor(nodes, edges)}
        anchorId={anchor.id}
        selectedEdge={null}
        onSelectEdge={() => undefined}
        onUseNodeAsAnchor={() => undefined}
        onPromoteSnippet={() => Promise.resolve()}
        ctx={ctx}
      />,
    );

    const closestGroup = screen.getByTestId('group-closest_visit');
    expect(screen.getByTestId('group-opener_visit')).toBeDefined();
    expect(within(closestGroup).getAllByText('closest visit').length).toBeGreaterThan(0);
    expect(within(closestGroup).getByTestId('linked-scores-closest_visit').textContent).toBe(
      'scores: [0.91, 0.87, 0.74, 0.32 ↓CUT, 0.21]',
    );
    expect(
      within(closestGroup)
        .getAllByTestId(/^edge-/u)
        .map((element) => element.getAttribute('data-testid')),
    ).toEqual(['edge-closest-strong', 'edge-closest-mid', 'edge-closest-cut', 'edge-closest-hidden']);
    expect(within(closestGroup).queryByTestId('edge-closest-weak')).toBeNull();

    fireEvent.click(within(closestGroup).getByTestId('linked-show-more-closest_visit'));

    expect(within(closestGroup).queryByTestId('edge-closest-weak')).not.toBeNull();
  });
});
