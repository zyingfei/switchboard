import { useState, type ReactElement } from 'react';

import { formatNodeIdDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import {
  EDGE_KINDS,
  contentDerivedHint,
  type EdgeFamily,
} from './edgeKinds';
import { NodeRow } from './NodeRow';
import type {
  ConnectionEdge,
  ConnectionNode,
  ConnectionNodeKind,
  ConnectionsScopedResult,
} from './types';

// Center panel for the Linked sub-mode: group the linked neighborhood by
// edge kind, keep node-row affordances, and cap large ranker-provenance
// groups from the score distribution before rendering every edge.

export const LINKED_FILTERING_DEFAULTS = {
  // TODO-calibrate: dogfood the v6 ranker score distribution before tightening.
  WEAK_FLOOR: 0.3,
  // TODO-calibrate: verify this elbow threshold on large popular-anchor snapshots.
  GAP_THRESHOLD: 0.15,
  // TODO-calibrate: 15 keeps reviewable sections compact without hiding small groups.
  MAX_VISIBLE_PER_GROUP: 15,
  MIN_VISIBLE_PER_GROUP: 3,
} as const;

export const pickVisibleCount = (scoresDesc: readonly number[]): number => {
  if (scoresDesc.length === 0) return 0;
  const minimum = Math.min(LINKED_FILTERING_DEFAULTS.MIN_VISIBLE_PER_GROUP, scoresDesc.length);
  const maximum = Math.min(LINKED_FILTERING_DEFAULTS.MAX_VISIBLE_PER_GROUP, scoresDesc.length);

  for (let index = 0; index < scoresDesc.length; index += 1) {
    const visibleCount = index + 1;
    if (visibleCount < minimum) continue;
    if (visibleCount >= maximum) return maximum;

    const score = scoresDesc[index];
    if (
      score !== undefined &&
      Number.isFinite(score) &&
      score < LINKED_FILTERING_DEFAULTS.WEAK_FLOOR
    ) {
      return visibleCount;
    }

    const previousScore = scoresDesc[index - 1];
    if (
      previousScore !== undefined &&
      score !== undefined &&
      Number.isFinite(previousScore) &&
      Number.isFinite(score) &&
      previousScore - score > LINKED_FILTERING_DEFAULTS.GAP_THRESHOLD
    ) {
      return visibleCount;
    }
  }

  return scoresDesc.length;
};

type LinkedNodeEntry = {
  readonly node: ConnectionNode;
  readonly nodeIndex: number;
  readonly edge: ConnectionEdge | null;
  readonly direction: 'in' | 'out';
};

type LinkedEdgeEntry = {
  readonly edge: ConnectionEdge;
  readonly edgeIndex: number;
};

type LinkedKindGroup = {
  readonly kind: string;
  readonly nodeEntries: readonly LinkedNodeEntry[];
  readonly edgeEntries: readonly LinkedEdgeEntry[];
  readonly firstIndex: number;
};

type MutableLinkedKindGroup = {
  nodeEntries: LinkedNodeEntry[];
  edgeEntries: LinkedEdgeEntry[];
  firstIndex: number;
};

const edgeConfidenceClass = (confidence: ConnectionEdge['confidence']): string =>
  confidence === 'inferred' ? 'confidence-inferred' : '';

const symmetricEdgeKinds = new Set(['closest_visit', 'visit_resembles_visit']);
const UNLINKED_GROUP_KIND = 'unlinked';

const edgeKindLabelForKind = (kind: string): string =>
  kind === UNLINKED_GROUP_KIND
    ? 'Unlinked'
    : (EDGE_KINDS[kind]?.label ?? kind.replaceAll('_', ' '));

const edgeKindLabel = (edge: ConnectionEdge): string => edgeKindLabelForKind(edge.kind);

const edgeScore = (edge: ConnectionEdge | null): number | null => {
  const score = edge?.metadata?.['score'];
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
};

const compareScoreThenIndex = (
  leftScore: number | null,
  rightScore: number | null,
  leftIndex: number,
  rightIndex: number,
): number => {
  if (leftScore !== null || rightScore !== null) {
    if (leftScore !== null && rightScore !== null && leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    if (leftScore !== null && rightScore === null) return -1;
    if (leftScore === null && rightScore !== null) return 1;
  }
  return leftIndex - rightIndex;
};

const compareNodeEntries = (left: LinkedNodeEntry, right: LinkedNodeEntry): number =>
  compareScoreThenIndex(edgeScore(left.edge), edgeScore(right.edge), left.nodeIndex, right.nodeIndex);

const compareEdgeEntries = (left: LinkedEdgeEntry, right: LinkedEdgeEntry): number =>
  compareScoreThenIndex(
    edgeScore(left.edge),
    edgeScore(right.edge),
    left.edgeIndex,
    right.edgeIndex,
  );

const directionForNodeEdge = (nodeId: string, edge: ConnectionEdge | null): 'in' | 'out' => {
  if (edge === null) return 'in';
  return edge.fromNodeId === nodeId ? 'out' : 'in';
};

const primaryEdgeByNodeId = (
  anchorId: string,
  edges: readonly ConnectionEdge[],
): ReadonlyMap<string, ConnectionEdge> => {
  const byNode = new Map<string, ConnectionEdge>();
  for (const edge of edges) {
    if (edge.fromNodeId === anchorId && !byNode.has(edge.toNodeId)) {
      byNode.set(edge.toNodeId, edge);
    }
    if (edge.toNodeId === anchorId && !byNode.has(edge.fromNodeId)) {
      byNode.set(edge.fromNodeId, edge);
    }
  }
  for (const edge of edges) {
    if (edge.fromNodeId !== anchorId && !byNode.has(edge.fromNodeId)) {
      byNode.set(edge.fromNodeId, edge);
    }
    if (edge.toNodeId !== anchorId && !byNode.has(edge.toNodeId)) {
      byNode.set(edge.toNodeId, edge);
    }
  }
  return byNode;
};

const groupLinkedEntries = (
  anchorId: string,
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
): readonly LinkedKindGroup[] => {
  const groups = new Map<string, MutableLinkedKindGroup>();
  const ensureGroup = (kind: string, firstIndex: number): MutableLinkedKindGroup => {
    const existing = groups.get(kind);
    if (existing !== undefined) {
      existing.firstIndex = Math.min(existing.firstIndex, firstIndex);
      return existing;
    }
    const created: MutableLinkedKindGroup = {
      nodeEntries: [],
      edgeEntries: [],
      firstIndex,
    };
    groups.set(kind, created);
    return created;
  };

  edges.forEach((edge, edgeIndex) => {
    ensureGroup(edge.kind, edgeIndex).edgeEntries.push({ edge, edgeIndex });
  });

  const edgeByNodeId = primaryEdgeByNodeId(anchorId, edges);
  nodes.forEach((node, nodeIndex) => {
    if (node.id === anchorId) return;
    const edge = edgeByNodeId.get(node.id) ?? null;
    const kind = edge?.kind ?? UNLINKED_GROUP_KIND;
    ensureGroup(kind, edges.length + nodeIndex).nodeEntries.push({
      node,
      nodeIndex,
      edge,
      direction:
        edge?.fromNodeId === anchorId
          ? 'out'
          : edge?.toNodeId === anchorId
            ? 'in'
            : directionForNodeEdge(node.id, edge),
    });
  });

  return [...groups.entries()]
    .map(([kind, group]) => ({
      kind,
      nodeEntries: group.nodeEntries.sort(compareNodeEntries),
      edgeEntries: group.edgeEntries.sort(compareEdgeEntries),
      firstIndex: group.firstIndex,
    }))
    .sort(
      (left, right) =>
        left.firstIndex - right.firstIndex ||
        edgeKindLabelForKind(left.kind).localeCompare(edgeKindLabelForKind(right.kind)) ||
        left.kind.localeCompare(right.kind),
    );
};

const visibleCountForGroup = (group: LinkedKindGroup): number => {
  if (group.edgeEntries.length === 0) {
    return Math.min(group.nodeEntries.length, LINKED_FILTERING_DEFAULTS.MAX_VISIBLE_PER_GROUP);
  }
  const scores = group.edgeEntries.map((entry) => edgeScore(entry.edge));
  if (scores.every((score): score is number => score !== null)) {
    return pickVisibleCount(scores);
  }
  return Math.min(group.edgeEntries.length, LINKED_FILTERING_DEFAULTS.MAX_VISIBLE_PER_GROUP);
};

const linkedFilteringDebugEnabled = (): boolean => {
  try {
    return globalThis.localStorage?.getItem('sidetrack-debug') === 'linked-filtering';
  } catch {
    return false;
  }
};

const scoreDiagnostic = (
  edgeEntries: readonly LinkedEdgeEntry[],
  visibleCount: number,
  expanded: boolean,
): string | null => {
  if (edgeEntries.length === 0) return null;
  const cutoffIndex = !expanded && visibleCount < edgeEntries.length ? visibleCount - 1 : -1;
  const pieces = edgeEntries.slice(0, 20).map((entry, index) => {
    const score = edgeScore(entry.edge);
    const label = score === null ? 'n/a' : score.toFixed(2);
    return index === cutoffIndex ? `${label} ↓CUT` : label;
  });
  if (edgeEntries.length > 20) pieces.push('...');
  return `scores: [${pieces.join(', ')}]`;
};

const nodeKindMarkers = (nodeEntries: readonly LinkedNodeEntry[]): readonly ConnectionNodeKind[] =>
  [...new Set(nodeEntries.map((entry) => entry.node.kind))].sort();

const edgeEndpointLabel = (
  edge: ConnectionEdge,
  nodeById: ReadonlyMap<string, ConnectionNode>,
  ctx: EntityDisplayCtx,
): string => {
  const from = formatNodeIdDisplay(edge.fromNodeId, nodeById, ctx).primary;
  const to = formatNodeIdDisplay(edge.toNodeId, nodeById, ctx).primary;
  return symmetricEdgeKinds.has(edge.kind) ? `${from} ↔ ${to}` : `${from} → ${to}`;
};

export const LinkedCenter = ({
  result,
  anchorId,
  selectedEdge,
  highlightedNodeId,
  onSelectEdge,
  onUseNodeAsAnchor,
  onPromoteSnippet,
  onOpenUrl,
  ctx,
}: {
  readonly result: ConnectionsScopedResult;
  readonly anchorId: string;
  readonly selectedEdge: ConnectionEdge | null;
  readonly highlightedNodeId?: string | null;
  readonly onSelectEdge: (edge: ConnectionEdge) => void;
  readonly onUseNodeAsAnchor: (nodeId: string) => void;
  readonly onPromoteSnippet: (input: {
    readonly snippetId: string;
    readonly sourceVisitId: string;
  }) => Promise<void>;
  readonly onOpenUrl?: (url: string) => void;
  readonly ctx: EntityDisplayCtx;
}): ReactElement => {
  const [expandedKinds, setExpandedKinds] = useState<ReadonlySet<string>>(() => new Set());
  if (result.scope === 'plugin-active-only-companion-unreachable') {
    return (
      <div className="cx-empty" data-testid="connections-empty-companion-offline">
        <h4>Connections need companion</h4>
        <p>Connect to see what's related to this anchor.</p>
      </div>
    );
  }
  if (result.snapshot.nodeCount === 0) {
    return (
      <div className="cx-empty" data-testid="connections-empty">
        <h4>Nothing connected</h4>
        <p>The plugin sees activity as you work; come back later.</p>
      </div>
    );
  }
  const nodeById = new Map(result.snapshot.nodes.map((node) => [node.id, node] as const));
  const groups = groupLinkedEntries(anchorId, result.snapshot.nodes, result.snapshot.edges);
  const debugScores = linkedFilteringDebugEnabled();
  return (
    <div data-testid="connections-groups">
      {result.note !== undefined ? (
        <div className="cx-mono cx-dim cx-note">{result.note}</div>
      ) : null}
      {groups.map((group) => {
        const family: EdgeFamily = EDGE_KINDS[group.kind]?.family ?? 'urlmatch';
        const expanded = expandedKinds.has(group.kind);
        const visibleCount = expanded
          ? Math.max(group.nodeEntries.length, group.edgeEntries.length)
          : visibleCountForGroup(group);
        const visibleNodeEntries = group.nodeEntries.slice(0, visibleCount);
        const visibleEdgeEntries = group.edgeEntries.slice(0, visibleCount);
        const hiddenCount = Math.max(
          0,
          Math.max(group.nodeEntries.length, group.edgeEntries.length) - visibleCount,
        );
        const diagnostic = debugScores
          ? scoreDiagnostic(group.edgeEntries, visibleCount, expanded)
          : null;
        const renderedNodeIds = new Set<string>();
        const nodeRows = visibleNodeEntries.map((entry) => {
          const edge = entry.edge;
          renderedNodeIds.add(entry.node.id);
          return (
            <NodeRow
              key={entry.node.id}
              node={entry.node}
              edge={edge ?? null}
              direction={entry.direction}
              selected={selectedEdge?.id === edge?.id && edge !== null}
              highlighted={highlightedNodeId === entry.node.id}
              onPromoteSnippet={onPromoteSnippet}
              onUseAsAnchor={() => {
                onUseNodeAsAnchor(entry.node.id);
              }}
              onClick={() => {
                if (edge !== null) onSelectEdge(edge);
              }}
              ctx={ctx}
              {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
            />
          );
        });
        const edgeRows = visibleEdgeEntries.map(({ edge }) => {
          const otherNode =
            edge.fromNodeId === anchorId
              ? nodeById.get(edge.toNodeId)
              : nodeById.get(edge.fromNodeId);
          if (otherNode !== undefined) {
            if (renderedNodeIds.has(otherNode.id)) return null;
            renderedNodeIds.add(otherNode.id);
            const direction = edge.fromNodeId === anchorId ? 'out' : 'in';
            return (
              <NodeRow
                key={`edge-node:${edge.id}:${otherNode.id}`}
                node={otherNode}
                edge={edge}
                direction={direction}
                selected={selectedEdge?.id === edge.id}
                highlighted={highlightedNodeId === otherNode.id}
                onPromoteSnippet={onPromoteSnippet}
                onUseAsAnchor={() => {
                  onUseNodeAsAnchor(otherNode.id);
                }}
                onClick={() => {
                  onSelectEdge(edge);
                }}
                ctx={ctx}
                {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
              />
            );
          }

          const meta = EDGE_KINDS[edge.kind];
          const fam: EdgeFamily = meta?.family ?? 'urlmatch';
          const hint = contentDerivedHint(edge.kind);
          const isSelected = selectedEdge?.id === edge.id;
          const isTimelineHovered =
            highlightedNodeId !== undefined &&
            highlightedNodeId !== null &&
            (edge.fromNodeId === highlightedNodeId || edge.toNodeId === highlightedNodeId);
          return (
            <button
              key={edge.id}
              type="button"
              onClick={() => {
                onSelectEdge(edge);
              }}
              data-testid={`edge-${edge.id}`}
              className={[
                'cx-edgelabel',
                'cx-edge-summary',
                isSelected ? 'is-selected' : '',
                isTimelineHovered ? 'is-timeline-hovered' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={`${edgeEndpointLabel(edge, nodeById, ctx)} · ${edgeKindLabel(edge)}`}
            >
              <span
                className={`cx-edge fam-${fam} ${edgeConfidenceClass(edge.confidence)}`.trim()}
                aria-hidden
              >
                <span className="cx-edge-line" />
              </span>
              <span className="cx-edge-summary-main">
                {edgeEndpointLabel(edge, nodeById, ctx)}
              </span>
              <span className="bac-connections-edge-hint">{edgeKindLabel(edge)}</span>
              {hint !== null ? (
                <span className="bac-connections-edge-hint" data-testid={`edge-hint-${edge.id}`}>
                  {hint}
                </span>
              ) : null}
            </button>
          );
        });
        return (
          <section key={group.kind} data-testid={`group-${group.kind}`}>
            <header className="cx-group-head">
              <span className={`cx-edge fam-${family}`} aria-hidden>
                <span className="cx-edge-line" />
              </span>
              <h3>{edgeKindLabelForKind(group.kind)}</h3>
              <span className="cx-count">
                {Math.max(group.nodeEntries.length, group.edgeEntries.length)}
              </span>
            </header>
            {nodeKindMarkers(group.nodeEntries).map((kind) => (
              <span key={kind} hidden data-testid={`group-${kind}`} />
            ))}
            <div className="cx-grouplist">{nodeRows}</div>
            <div className="cx-edge-list">
              {edgeRows}
            </div>
            {!expanded && hiddenCount > 0 ? (
              <button
                type="button"
                className="cx-focus-expand"
                data-testid={`linked-show-more-${group.kind}`}
                onClick={() => {
                  setExpandedKinds((current) => new Set(current).add(group.kind));
                }}
              >
                Show {hiddenCount} more
              </button>
            ) : null}
            {diagnostic !== null ? (
              <div
                className="cx-mono cx-dim cx-note"
                data-testid={`linked-scores-${group.kind}`}
              >
                {diagnostic}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
};
