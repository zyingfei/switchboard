import type { ReactElement } from 'react';

import type { ConnectionEdge, ConnectionNode } from './types';

// Stage 5 polish — Connections time-range filter. The companion
// snapshot has 1.6+ days of data with 1219/1249 nodes carrying
// `lastSeenAt`; nothing else exposes a date filter. This pill bar
// is a *client-side* filter over the loaded subgraph — fast and
// scoped to what the user can already see — so we don't need a new
// companion route to ship the affordance.
//
// Ranges:
//   - all : no filter
//   - 30d : nodes with lastSeenAt within the last 30 days
//   - 7d  : ditto, 7 days
//   - 24h : ditto, 24 hours
// Nodes without lastSeenAt (templates, workstream metadata, etc.)
// stay visible in every window — they have no time signal, so
// filtering them out would just hide structural context.

export type TimeRangeKey = 'all' | '30d' | '7d' | '24h';

export interface TimeRangePillsProps {
  readonly value: TimeRangeKey;
  readonly onChange: (next: TimeRangeKey) => void;
  readonly hiddenNodeCount?: number;
}

const LABELS: Record<TimeRangeKey, string> = {
  all: 'All',
  '30d': '30d',
  '7d': '7d',
  '24h': '24h',
};

export const TimeRangePills = ({
  value,
  onChange,
  hiddenNodeCount,
}: TimeRangePillsProps): ReactElement => (
  <div className="cx-pill-group cx-timerange" role="group" aria-label="Time range">
    {(['all', '30d', '7d', '24h'] as readonly TimeRangeKey[]).map((key) => (
      <button
        key={key}
        type="button"
        className={`cx-pill ${value === key ? 'is-active' : ''}`}
        onClick={() => {
          onChange(key);
        }}
        data-testid={`connections-timerange-${key}`}
        title={
          key === 'all'
            ? 'Show everything in the loaded subgraph'
            : `Hide nodes whose last activity is older than ${LABELS[key]}`
        }
      >
        {LABELS[key]}
      </button>
    ))}
    {value !== 'all' && hiddenNodeCount !== undefined && hiddenNodeCount > 0 ? (
      <span className="cx-timerange-hidden mono" data-testid="connections-timerange-hidden">
        −{hiddenNodeCount}
      </span>
    ) : null}
  </div>
);

const MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export interface FilteredSubgraph {
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
  readonly hiddenNodeCount: number;
  readonly hiddenEdgeCount: number;
}

// Apply the time filter to a (nodes, edges) pair. Keeps nodes that
// either lack a `lastSeenAt` (no time signal) or have it inside the
// window. Anchor must stay visible — re-included unconditionally
// when an anchorId is provided, otherwise the anchor pane goes
// blank while the user is staring at it.
export const filterByTimeRange = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  range: TimeRangeKey,
  options: { readonly nowMs?: number; readonly anchorId?: string } = {},
): FilteredSubgraph => {
  if (range === 'all') {
    return { nodes, edges, hiddenNodeCount: 0, hiddenEdgeCount: 0 };
  }
  const now = options.nowMs ?? Date.now();
  const cutoff = now - MS[range];
  const kept = new Set<string>();
  if (options.anchorId !== undefined) kept.add(options.anchorId);
  for (const node of nodes) {
    if (node.id === options.anchorId) {
      continue; // already kept
    }
    const ts = node.lastSeenAt ?? node.firstSeenAt;
    // No time signal → keep. Time signal AND within window → keep.
    if (ts === undefined || ts === null) {
      kept.add(node.id);
      continue;
    }
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed) && parsed >= cutoff) {
      kept.add(node.id);
    }
  }
  const keptNodes = nodes.filter((n) => kept.has(n.id));
  const keptEdges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
  return {
    nodes: keptNodes,
    edges: keptEdges,
    hiddenNodeCount: nodes.length - keptNodes.length,
    hiddenEdgeCount: edges.length - keptEdges.length,
  };
};
