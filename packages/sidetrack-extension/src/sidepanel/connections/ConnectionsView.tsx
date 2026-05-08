import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { ContextPackComposer } from './ContextPackComposer';
import {
  feedbackRelationKindForEdgeKind,
  fetchConnectionsEdge,
  fetchConnectionsNeighbors,
  postUserEngagementRelabeled,
  postUserFlowConfirmed,
  postUserFlowRejected,
  postUserSnippetPromoted,
  postUserTopicRenamed,
  type UserFlowRelationKind,
} from './client';
import {
  EDGE_KINDS,
  FAMILIES,
  NODE_KIND_DISPLAY,
  NODE_KIND_GROUP_ORDER,
  contentDerivedHint,
  type EdgeFamily,
} from './edgeKinds';
import {
  FlowPathView,
  type CrossReplicaEdge,
  type NavigationEdge,
  type TimelineVisit,
} from './FlowPathView';
import {
  ENGAGEMENT_CLASSES,
  FocusView,
  type EngagementClass,
  type TopicNode,
  type TopicVisit,
} from './FocusView';
import { CloseIcon, KindIcons, SearchIcon } from './icons';
import { computeOrbitalLayout, type OrbitalLayoutResult } from './orbitalLayout';
import { computeTimelineRail, type TimelineRailData } from './timelineWindows';
import type {
  ConnectionEdge,
  ConnectionNode,
  ConnectionNodeKind,
  ConnectionsScopedResult,
} from './types';
import { FeedbackButtons, type FeedbackChoice } from '../feedback/FeedbackButtons';
import { WhyRelatedPanel } from './WhyRelatedPanel';
import type { Reason } from './why-related/reasons';

// Connections side-panel view — Concept A (linked panels) + Concept B
// (orbital graph) ports of the Claude Design switchboard bundle.
//
// Layout:
//   AnchorBar          — anchor + hop pills
//   ModeToggle         — Linked / Orbital sub-modes
//   TimelineRail       — per-replica observation windows + anchor /
//                        neighbor markers (only when the snapshot has
//                        event-log timestamps)
//   3-col shell
//     Left   — anchor input, recent-anchor quick-pick, family legend
//     Center — linked-panels group list  OR  orbital SVG graph
//     Right  — provenance card or anchor summary
//
// Tokens live in entrypoints/sidepanel/style.css (cx-* prefix).

export interface ConnectionsViewRecentAnchor {
  readonly id: string;
  readonly kind: ConnectionNodeKind;
  readonly label: string;
  readonly meta?: string;
}

type Props = {
  readonly initialAnchor?: string;
  readonly recentAnchors?: readonly ConnectionsViewRecentAnchor[];
};

type SubMode = 'linked' | 'orbital' | 'flow' | 'focus' | 'context';

const KIND_RANK = new Map<ConnectionNodeKind, number>(
  NODE_KIND_GROUP_ORDER.map((k, i) => [k, i] as const),
);

const edgeConfidenceClass = (confidence: ConnectionEdge['confidence']): string => {
  return confidence === 'inferred' ? 'confidence-inferred' : '';
};

const metadataString = (
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const metadataNumber = (
  metadata: Record<string, unknown>,
  key: string,
  fallback: number,
): number => {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rankerContributionFromUnknown = (
  value: unknown,
): { readonly feature: string; readonly weight: number } | null => {
  if (!isRecord(value)) return null;
  const feature = value.feature;
  const weight = value.weight;
  if (typeof feature !== 'string' || feature.length === 0) return null;
  if (typeof weight !== 'number' || !Number.isFinite(weight)) return null;
  return { feature, weight };
};

const rankerReasonForEdge = (edge: ConnectionEdge): Reason | null => {
  if (edge.kind !== 'closest_visit' || edge.metadata === undefined) return null;
  const rawContributions = edge.metadata.topContributions;
  const topContributions = Array.isArray(rawContributions)
    ? rawContributions
        .map(rankerContributionFromUnknown)
        .filter(
          (contribution): contribution is { readonly feature: string; readonly weight: number } =>
            contribution !== null,
        )
    : [];
  return {
    code: 'RANKER_SCORE',
    score: metadataNumber(edge.metadata, 'score', 0),
    topContributions,
  };
};

const isEngagementClass = (value: unknown): value is EngagementClass =>
  typeof value === 'string' && (ENGAGEMENT_CLASSES as readonly string[]).includes(value);

const engagementClassForNode = (node: ConnectionNode): EngagementClass | undefined => {
  const engagement = node.metadata['engagement'];
  if (typeof engagement !== 'object' || engagement === null || Array.isArray(engagement)) {
    return undefined;
  }
  const value = (engagement as Record<string, unknown>)['class'];
  return isEngagementClass(value) ? value : undefined;
};

const deriveFlowVisits = (nodes: readonly ConnectionNode[]): readonly TimelineVisit[] =>
  nodes
    .filter((node) => node.kind === 'timeline-visit')
    .map((node) => ({
      id: node.id,
      label: node.label,
      commitTimestamp:
        node.lastSeenAt ??
        metadataString(node.metadata, ['commitTimestamp', 'lastSeenAt', 'observedAt']) ??
        '1970-01-01T00:00:00.000Z',
      tabSessionIdHash:
        metadataString(node.metadata, ['tabSessionIdHash', 'tabIdHash']) ?? 'unknown-tab',
      ...(engagementClassForNode(node) === undefined
        ? {}
        : { engagementClass: engagementClassForNode(node) }),
    }));

const deriveNavigationEdges = (edges: readonly ConnectionEdge[]): readonly NavigationEdge[] =>
  edges
    .filter((edge) => edge.kind === 'previous_visit_in_tab_session' || edge.kind === 'opener_visit')
    .map((edge) => ({
      id: edge.id,
      fromVisitId: edge.fromNodeId,
      toVisitId: edge.toNodeId,
      kind: edge.kind === 'opener_visit' ? 'openerVisitId' : 'previousVisitId',
    }));

const deriveCrossReplicaEdges = (edges: readonly ConnectionEdge[]): readonly CrossReplicaEdge[] =>
  edges
    .filter((edge) => edge.kind === 'visit_observed_on_replica')
    .map((edge) => ({
      id: edge.id,
      fromVisitId: edge.fromNodeId,
      replicaId: edge.toNodeId.replace(/^replica:/u, ''),
    }));

const deriveFocusData = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
): {
  readonly topics: readonly TopicNode[];
  readonly visitsByTopic: Record<string, readonly TopicVisit[]>;
  readonly engagementClassesByVisit: Record<string, EngagementClass>;
} => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const topics: TopicNode[] = nodes
    .filter((node) => node.kind === 'topic')
    .map((node) => ({
      id: node.id,
      label: node.label,
      memberCount: metadataNumber(node.metadata, 'memberCount', 0),
      cohesion: metadataNumber(node.metadata, 'cohesion', 0),
      ...(metadataString(node.metadata, ['dominantWorkstreamId']) === undefined
        ? {}
        : { dominantWorkstreamId: metadataString(node.metadata, ['dominantWorkstreamId']) }),
    }));
  const visitsByTopic: Record<string, TopicVisit[]> = {};
  const engagementClassesByVisit: Record<string, EngagementClass> = {};
  for (const node of nodes) {
    const engagementClass = engagementClassForNode(node);
    if (node.kind === 'timeline-visit' && engagementClass !== undefined) {
      engagementClassesByVisit[node.id] = engagementClass;
    }
  }
  for (const edge of edges) {
    if (edge.kind !== 'visit_in_topic') continue;
    const visit = nodeById.get(edge.fromNodeId);
    if (visit === undefined) continue;
    const list = visitsByTopic[edge.toNodeId] ?? [];
    visitsByTopic[edge.toNodeId] = [
      ...list,
      {
        id: visit.id,
        label: visit.label,
        focusedWindowMs: metadataNumber(visit.metadata, 'focusedWindowMs', 0),
      },
    ];
  }
  return { topics, visitsByTopic, engagementClassesByVisit };
};

const reasonsForVisit = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  visitId: string,
): readonly Reason[] => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const reasons: Reason[] = [];
  for (const edge of edges) {
    if (edge.fromNodeId !== visitId && edge.toNodeId !== visitId) continue;
    if (edge.kind === 'timeline_same_url_as_thread') {
      const thread = nodeById.get(edge.fromNodeId === visitId ? edge.toNodeId : edge.fromNodeId);
      reasons.push({
        code: 'SAME_THREAD',
        threadId: thread?.id ?? 'thread:unknown',
        threadName: thread?.label ?? 'Unknown thread',
      });
    } else if (edge.kind === 'visit_resembles_visit') {
      reasons.push({ code: 'COSINE_ABOVE_THRESHOLD', cosine: 0.85, threshold: 0.85 });
    } else if (edge.kind === 'closest_visit') {
      const reason = rankerReasonForEdge(edge);
      if (reason !== null) reasons.push(reason);
    } else if (edge.kind === 'visit_in_topic') {
      const topic = nodeById.get(edge.toNodeId);
      reasons.push({
        code: 'SAME_TOPIC',
        topicId: edge.toNodeId,
        cohesion: topic === undefined ? 0 : metadataNumber(topic.metadata, 'cohesion', 0),
      });
    } else if (edge.kind === 'visit_observed_on_replica') {
      reasons.push({
        code: 'OBSERVED_ON_OTHER_REPLICA',
        replicaId: edge.toNodeId.replace(/^replica:/u, ''),
      });
    } else if (edge.kind === 'snippet_copied_from_visit') {
      reasons.push({ code: 'COPIED_FROM', snippetId: edge.fromNodeId });
    } else if (edge.kind.startsWith('snippet_pasted_into_')) {
      reasons.push({
        code: 'PASTED_INTO',
        snippetId: edge.fromNodeId,
        destinationKind: edge.kind.replace(/^snippet_pasted_into_/u, ''),
      });
    } else if (edge.kind === 'thread_text_mentions_search_query') {
      const visit = nodeById.get(visitId);
      const query = metadataString(visit?.metadata ?? {}, ['searchQuery']);
      reasons.push({
        code: 'LEXICAL_OVERLAP',
        topTokens: query === undefined ? [visit?.label ?? visitId] : query.split(/\s+/u),
      });
    }
  }
  return reasons.length > 0
    ? reasons
    : [{ code: 'LEXICAL_OVERLAP', topTokens: [nodeById.get(visitId)?.label ?? visitId] }];
};

const edgeConnects = (edge: ConnectionEdge, leftId: string, rightId: string): boolean =>
  (edge.fromNodeId === leftId && edge.toNodeId === rightId) ||
  (edge.fromNodeId === rightId && edge.toNodeId === leftId);

const findFeedbackEdge = (
  edges: readonly ConnectionEdge[],
  leftId: string,
  rightId: string,
): ConnectionEdge | null =>
  edges.find(
    (edge) =>
      edgeConnects(edge, leftId, rightId) && feedbackRelationKindForEdgeKind(edge.kind) !== null,
  ) ?? null;

const snippetSourceVisitId = (node: ConnectionNode, edge: ConnectionEdge | null): string | null => {
  if (node.kind !== 'snippet' || edge === null) return null;
  if (edge.kind === 'snippet_copied_from_visit' && edge.fromNodeId === node.id) {
    return edge.toNodeId;
  }
  return null;
};

const requireFeedbackRelationKind = (edge: ConnectionEdge): UserFlowRelationKind => {
  const relationKind = feedbackRelationKindForEdgeKind(edge.kind);
  if (relationKind === null) {
    throw new Error(`Unsupported feedback edge kind: ${edge.kind}`);
  }
  return relationKind;
};

const groupByKind = (
  nodes: readonly ConnectionNode[],
): Map<ConnectionNodeKind, ConnectionNode[]> => {
  const groups = new Map<ConnectionNodeKind, ConnectionNode[]>();
  for (const n of nodes) {
    const list = groups.get(n.kind) ?? [];
    list.push(n);
    groups.set(n.kind, list);
  }
  return groups;
};

const sortGroupKeys = (kinds: readonly ConnectionNodeKind[]): ConnectionNodeKind[] => {
  return [...kinds].sort((a, b) => {
    const ra = KIND_RANK.get(a) ?? 99;
    const rb = KIND_RANK.get(b) ?? 99;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
};

export const ConnectionsView = ({
  initialAnchor = '',
  recentAnchors = [],
}: Props): ReactElement => {
  const [anchor, setAnchor] = useState<string>(initialAnchor);
  const [draftAnchor, setDraftAnchor] = useState<string>(initialAnchor);
  const [hops, setHops] = useState<number>(1);
  const [subMode, setSubMode] = useState<SubMode>('linked');
  const [result, setResult] = useState<ConnectionsScopedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [selectedEdge, setSelectedEdge] = useState<ConnectionEdge | null>(null);
  const [edgeDetail, setEdgeDetail] = useState<ConnectionEdge | null>(null);
  const [whyVisitId, setWhyVisitId] = useState<string | null>(null);
  const [whyAssertedOnly, setWhyAssertedOnly] = useState<boolean>(false);

  useEffect(() => {
    if (anchor.trim().length === 0) {
      setResult(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchConnectionsNeighbors({ nodeId: anchor, hops }).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (r.ok && r.data !== undefined) {
        setResult(r.data);
      } else {
        setError(r.error ?? 'unknown error');
        setResult(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [anchor, hops]);

  useEffect(() => {
    if (selectedEdge === null) {
      setEdgeDetail(null);
      return;
    }
    let cancelled = false;
    fetchConnectionsEdge(selectedEdge.id).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data !== undefined) setEdgeDetail(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedEdge]);

  const anchorNode = useMemo<ConnectionNode | null>(() => {
    if (result === null) return null;
    return result.snapshot.nodes.find((n) => n.id === anchor) ?? null;
  }, [result, anchor]);

  const timeline = useMemo<TimelineRailData | null>(() => {
    if (result === null) return null;
    return computeTimelineRail(result.snapshot, anchor);
  }, [result, anchor]);

  const submitAnchor = (next?: string): void => {
    const value = (next ?? draftAnchor).trim();
    if (next !== undefined) setDraftAnchor(value);
    setSelectedEdge(null);
    setWhyVisitId(null);
    setAnchor(value);
  };

  const replaceNodeLabel = (nodeId: string, label: string): void => {
    setResult((current) => {
      if (current === null) return null;
      return {
        ...current,
        snapshot: {
          ...current.snapshot,
          nodes: current.snapshot.nodes.map((node) =>
            node.id === nodeId ? { ...node, label } : node,
          ),
        },
      };
    });
  };

  const replaceNodeEngagementClass = (nodeId: string, engagementClass: EngagementClass): void => {
    setResult((current) => {
      if (current === null) return null;
      return {
        ...current,
        snapshot: {
          ...current.snapshot,
          nodes: current.snapshot.nodes.map((node) => {
            if (node.id !== nodeId) return node;
            const currentEngagement = node.metadata['engagement'];
            const engagement =
              typeof currentEngagement === 'object' &&
              currentEngagement !== null &&
              !Array.isArray(currentEngagement)
                ? currentEngagement
                : {};
            return {
              ...node,
              metadata: {
                ...node.metadata,
                engagement: { ...engagement, class: engagementClass },
              },
            };
          }),
        },
      };
    });
  };

  const submitFlowFeedback = async (
    edge: ConnectionEdge,
    choice: FeedbackChoice,
  ): Promise<void> => {
    const relationKind = requireFeedbackRelationKind(edge);
    const response =
      choice === 'confirm'
        ? await postUserFlowConfirmed({
            relationKind,
            fromId: edge.fromNodeId,
            toId: edge.toNodeId,
          })
        : await postUserFlowRejected({
            relationKind,
            fromId: edge.fromNodeId,
            toId: edge.toNodeId,
            reason: 'not-related',
          });
    if (!response.ok) {
      throw new Error(response.error ?? 'feedback failed');
    }
  };

  const submitTopicRename = async (input: {
    readonly topicId: string;
    readonly previousName: string;
    readonly newName: string;
  }): Promise<void> => {
    const response = await postUserTopicRenamed(input);
    if (!response.ok) {
      throw new Error(response.error ?? 'topic rename feedback failed');
    }
    replaceNodeLabel(input.topicId, input.newName);
  };

  const submitEngagementRelabel = async (input: {
    readonly visitId: string;
    readonly fromClass: EngagementClass;
    readonly toClass: EngagementClass;
  }): Promise<void> => {
    const response = await postUserEngagementRelabeled(input);
    if (!response.ok) {
      throw new Error(response.error ?? 'engagement relabel feedback failed');
    }
    replaceNodeEngagementClass(input.visitId, input.toClass);
  };

  const submitSnippetPromotion = async (input: {
    readonly snippetId: string;
    readonly sourceVisitId: string;
  }): Promise<void> => {
    const response = await postUserSnippetPromoted({
      snippetId: input.snippetId,
      targetId: input.sourceVisitId,
      sourceVisitId: input.sourceVisitId,
    });
    if (!response.ok) {
      throw new Error(response.error ?? 'snippet promotion feedback failed');
    }
  };

  const totalEdges = result?.snapshot.edgeCount ?? 0;
  const whyFeedbackEdge = useMemo(() => {
    if (result === null || whyVisitId === null) return null;
    return findFeedbackEdge(result.snapshot.edges, anchor, whyVisitId);
  }, [result, anchor, whyVisitId]);
  const focusData = useMemo(
    () =>
      result === null
        ? { topics: [], visitsByTopic: {}, engagementClassesByVisit: {} }
        : deriveFocusData(result.snapshot.nodes, result.snapshot.edges),
    [result],
  );
  const contextWorkstreamId = useMemo(() => {
    if (anchor.startsWith('workstream:')) return anchor.replace(/^workstream:/u, '');
    const workstream = result?.snapshot.nodes.find((node) => node.kind === 'workstream');
    return workstream?.id.replace(/^workstream:/u, '') ?? anchor;
  }, [anchor, result]);

  return (
    <div className="cx-shell-host bac-connections-view" data-testid="connections-view">
      <div className="cx-anchorbar">
        <span className="cx-anchor-label">Anchor</span>
        {anchorNode !== null ? (
          <NodeChip node={anchorNode} state="anchor" />
        ) : (
          <span className="cx-mono cx-dim">no anchor selected</span>
        )}
        <span className="cx-spacer" />
        <HopToggle value={hops} onChange={setHops} />
      </div>
      <div className="cx-modes" role="tablist" aria-label="View mode">
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'linked'}
          className={'cx-mode' + (subMode === 'linked' ? ' is-active' : '')}
          onClick={() => setSubMode('linked')}
          data-testid="connections-mode-linked"
        >
          Linked
          <span className="cx-count">{totalEdges}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'orbital'}
          className={'cx-mode' + (subMode === 'orbital' ? ' is-active' : '')}
          onClick={() => setSubMode('orbital')}
          data-testid="connections-mode-orbital"
        >
          Orbital
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'flow'}
          className={'cx-mode' + (subMode === 'flow' ? ' is-active' : '')}
          onClick={() => setSubMode('flow')}
          data-testid="connections-mode-flow"
        >
          Flow Path
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'focus'}
          className={'cx-mode' + (subMode === 'focus' ? ' is-active' : '')}
          onClick={() => setSubMode('focus')}
          data-testid="connections-mode-focus"
        >
          Focus
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'context'}
          className={'cx-mode' + (subMode === 'context' ? ' is-active' : '')}
          onClick={() => setSubMode('context')}
          data-testid="connections-mode-context"
        >
          Context Pack
        </button>
      </div>
      {timeline !== null ? <TimelineRail data={timeline} /> : null}
      <div className="cx-cols">
        <aside className="cx-col-l">
          <div className="cx-section">
            <h4>Anchor</h4>
            <label className="cx-input">
              <span
                aria-hidden
                style={{ color: 'var(--ink-3)', display: 'grid', placeItems: 'center' }}
              >
                {SearchIcon}
              </span>
              <input
                type="text"
                placeholder="thread:bac_…  workstream:bac_…"
                value={draftAnchor}
                onChange={(e) => setDraftAnchor(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAnchor();
                }}
                onBlur={() => submitAnchor()}
                aria-label="Connections anchor"
                data-testid="connections-anchor-input"
              />
            </label>
          </div>
          {recentAnchors.length > 0 ? (
            <div className="cx-section" data-testid="connections-recent-anchors">
              <h4>Recent anchors</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {recentAnchors.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="cx-recent-anchor"
                    onClick={() => submitAnchor(r.id)}
                    data-testid={`recent-anchor-${r.id}`}
                  >
                    <span
                      className={`cx-node-icon ${NODE_KIND_DISPLAY[r.kind].tintClass}`}
                      aria-hidden
                    >
                      {KindIcons[r.kind]}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.label}
                    </span>
                    <span className="cx-recent-meta">{NODE_KIND_DISPLAY[r.kind].label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="cx-section">
            <h4>Hops</h4>
            <label
              className="cx-mono cx-dim"
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}
            >
              <span>Range</span>
              <select
                value={hops}
                onChange={(e) => setHops(Number.parseInt(e.target.value, 10) || 1)}
                data-testid="connections-hops-select"
                style={{ font: 'inherit', color: 'inherit', background: 'transparent', border: 0 }}
              >
                {[1, 2, 3, 4].map((h) => (
                  <option key={h} value={h}>
                    {h}-hop
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="cx-section" style={{ borderBottom: 0 }}>
            <h4>Edge family</h4>
            <FamilyLegend />
          </div>
        </aside>
        <main className="cx-col-c" style={{ overflow: 'auto' }}>
          {loading ? (
            <div
              className="cx-mono cx-dim"
              data-testid="connections-loading"
              style={{ padding: 16 }}
            >
              Loading…
            </div>
          ) : null}
          {error !== null ? (
            <div className="cx-empty" role="alert" data-testid="connections-error">
              <h4>Couldn't load</h4>
              <p>{error}</p>
            </div>
          ) : null}
          {result !== null ? (
            subMode === 'linked' ? (
              <ConnectionsLinkedCenter
                result={result}
                anchorId={anchor}
                selectedEdge={selectedEdge}
                onSelectEdge={(e) => setSelectedEdge(e)}
                onPromoteSnippet={submitSnippetPromotion}
              />
            ) : subMode === 'orbital' ? (
              <ConnectionsOrbitalCenter
                result={result}
                anchorId={anchor}
                hops={hops}
                selectedEdge={selectedEdge}
                onSelectEdge={(e) => setSelectedEdge(e)}
              />
            ) : subMode === 'flow' ? (
              <FlowPathView
                visits={deriveFlowVisits(result.snapshot.nodes)}
                navigationEdges={deriveNavigationEdges(result.snapshot.edges)}
                crossReplicaEdges={deriveCrossReplicaEdges(result.snapshot.edges)}
                onNodeClick={(visitId) => {
                  setSelectedEdge(null);
                  setWhyVisitId(visitId);
                }}
              />
            ) : subMode === 'focus' ? (
              <FocusView
                topics={focusData.topics}
                visitsByTopic={focusData.visitsByTopic}
                engagementClassesByVisit={focusData.engagementClassesByVisit}
                onTopicRename={submitTopicRename}
                onEngagementRelabel={submitEngagementRelabel}
                onTopicClick={(topicId) => {
                  setAnchor(topicId);
                  setDraftAnchor(topicId);
                }}
                onVisitClick={(visitId) => setWhyVisitId(visitId)}
              />
            ) : (
              <ContextPackComposer
                workstreamId={contextWorkstreamId}
                onClose={() => setSubMode('linked')}
              />
            )
          ) : (
            !loading &&
            error === null && (
              <div className="cx-empty">
                <h4>Pick an anchor to begin</h4>
                <p>
                  Type a node id on the left or click a recent anchor — the graph around it appears
                  here.
                </p>
              </div>
            )
          )}
        </main>
        <aside className="cx-col-r" style={{ overflow: 'auto' }}>
          <div className="cx-section" style={{ borderBottom: 0, padding: 14 }}>
            {whyVisitId !== null && result !== null ? (
              <WhyRelatedPanel
                fromVisitId={whyVisitId}
                reasons={reasonsForVisit(result.snapshot.nodes, result.snapshot.edges, whyVisitId)}
                showOnlyUserAsserted={whyAssertedOnly}
                feedback={
                  whyFeedbackEdge === null
                    ? undefined
                    : {
                        label: 'relation',
                        onFeedback: (choice) => submitFlowFeedback(whyFeedbackEdge, choice),
                      }
                }
                onToggleAssertedOnly={() => setWhyAssertedOnly((value) => !value)}
                onClose={() => setWhyVisitId(null)}
              />
            ) : edgeDetail !== null ? (
              <ProvenanceCard
                edge={edgeDetail}
                allNodes={result?.snapshot.nodes ?? []}
                onFlowFeedback={(edge, choice) => submitFlowFeedback(edge, choice)}
                onClose={() => setSelectedEdge(null)}
              />
            ) : (
              <ProvenanceEmpty anchor={anchorNode} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

const ConnectionsLinkedCenter = ({
  result,
  anchorId,
  selectedEdge,
  onSelectEdge,
  onPromoteSnippet,
}: {
  readonly result: ConnectionsScopedResult;
  readonly anchorId: string;
  readonly selectedEdge: ConnectionEdge | null;
  readonly onSelectEdge: (edge: ConnectionEdge) => void;
  readonly onPromoteSnippet: (input: {
    readonly snippetId: string;
    readonly sourceVisitId: string;
  }) => Promise<void>;
}): ReactElement => {
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
  const neighbors = result.snapshot.nodes.filter((n) => n.id !== anchorId);
  const groups = groupByKind(neighbors);
  const orderedKinds = sortGroupKeys([...groups.keys()]);
  const edgesByOtherEnd = new Map<string, ConnectionEdge>();
  for (const e of result.snapshot.edges) {
    if (e.fromNodeId === anchorId && !edgesByOtherEnd.has(e.toNodeId)) {
      edgesByOtherEnd.set(e.toNodeId, e);
    }
    if (e.toNodeId === anchorId && !edgesByOtherEnd.has(e.fromNodeId)) {
      edgesByOtherEnd.set(e.fromNodeId, e);
    }
  }
  return (
    <div data-testid="connections-groups">
      {result.note !== undefined ? (
        <div className="cx-mono cx-dim" style={{ padding: '14px 16px 0' }}>
          {result.note}
        </div>
      ) : null}
      {orderedKinds.map((kind) => {
        const display = NODE_KIND_DISPLAY[kind];
        const nodes = groups.get(kind) ?? [];
        const plural = nodes.length === 1 ? display.label : `${display.label}s`;
        return (
          <section key={kind} data-testid={`group-${kind}`}>
            <header className="cx-group-head">
              <span className={`cx-node-icon ${display.tintClass}`} aria-hidden>
                {KindIcons[kind]}
              </span>
              <h3>{plural}</h3>
              <span className="cx-count">{nodes.length}</span>
            </header>
            <div className="cx-grouplist">
              {nodes.map((n) => {
                const edge = edgesByOtherEnd.get(n.id);
                return (
                  <NodeRow
                    key={n.id}
                    node={n}
                    edge={edge ?? null}
                    direction={edge?.fromNodeId === anchorId ? 'out' : 'in'}
                    selected={selectedEdge?.id === edge?.id && edge !== undefined}
                    onPromoteSnippet={onPromoteSnippet}
                    onClick={() => {
                      if (edge !== undefined) onSelectEdge(edge);
                    }}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
      <section className="cx-section" data-testid="connections-edges">
        <h4>All edges (click for provenance)</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {result.snapshot.edges.map((edge) => {
            const meta = EDGE_KINDS[edge.kind];
            const fam: EdgeFamily = meta?.family ?? 'urlmatch';
            const hint = contentDerivedHint(edge.kind);
            const isSelected = selectedEdge?.id === edge.id;
            return (
              <button
                key={edge.id}
                type="button"
                onClick={() => onSelectEdge(edge)}
                data-testid={`edge-${edge.id}`}
                className={`cx-edgelabel ${isSelected ? 'is-selected' : ''}`}
                style={{ cursor: 'pointer', justifyContent: 'flex-start', padding: '4px 8px' }}
              >
                <span
                  className={`cx-edge fam-${fam} ${edgeConfidenceClass(edge.confidence)}`.trim()}
                  aria-hidden
                >
                  <span className="cx-edge-line" />
                </span>
                <span style={{ color: 'var(--ink)' }}>{edge.kind}</span>
                {hint !== null ? (
                  <span className="bac-connections-edge-hint" data-testid={`edge-hint-${edge.id}`}>
                    {hint}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
};

const ORBIT_W = 720;
const ORBIT_H = 480;

const ConnectionsOrbitalCenter = ({
  result,
  anchorId,
  hops,
  selectedEdge,
  onSelectEdge,
}: {
  readonly result: ConnectionsScopedResult;
  readonly anchorId: string;
  readonly hops: number;
  readonly selectedEdge: ConnectionEdge | null;
  readonly onSelectEdge: (edge: ConnectionEdge) => void;
}): ReactElement => {
  // Hooks must run on every render — keep the layout call before
  // any early returns.
  const layout: OrbitalLayoutResult = useMemo(
    () =>
      computeOrbitalLayout({
        snapshot: result.snapshot,
        anchorId,
        width: ORBIT_W,
        height: ORBIT_H,
        hops,
      }),
    [result.snapshot, anchorId, hops],
  );
  if (result.snapshot.nodeCount === 0) {
    return (
      <div className="cx-empty" data-testid="connections-empty">
        <h4>Nothing to graph</h4>
        <p>Pick an anchor with at least one neighbor.</p>
      </div>
    );
  }
  const nodeById = new Map<string, ConnectionNode>();
  for (const n of result.snapshot.nodes) nodeById.set(n.id, n);

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      data-testid="connections-orbital"
    >
      <div className="cx-orbit" style={{ minHeight: ORBIT_H }}>
        <div className="cx-orbit-ring" style={{ width: layout.r1 * 2, height: layout.r1 * 2 }} />
        {hops >= 2 ? (
          <div className="cx-orbit-ring" style={{ width: layout.r2 * 2, height: layout.r2 * 2 }} />
        ) : null}
        <div
          className="cx-orbit-sector-label"
          style={{ left: '50%', top: 12, transform: 'translateX(-50%)' }}
        >
          ↑ Containment
        </div>
        <div
          className="cx-orbit-sector-label"
          style={{ right: 12, top: '50%', transform: 'translateY(-50%)' }}
        >
          Flow →
        </div>
        <div
          className="cx-orbit-sector-label"
          style={{ left: '50%', bottom: 12, transform: 'translateX(-50%)' }}
        >
          ↓ Queue · Reminder
        </div>
        <div
          className="cx-orbit-sector-label"
          style={{ left: 12, top: '50%', transform: 'translateY(-50%)' }}
        >
          ← URL match
        </div>
        <svg
          className="cx-orbit-svg"
          viewBox={`0 0 ${String(ORBIT_W)} ${String(ORBIT_H)}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          {layout.edges.map((edge) => {
            const meta = EDGE_KINDS[edge.kind];
            const fam: EdgeFamily = meta?.family ?? 'urlmatch';
            const ps = layout.positions.get(edge.fromNodeId)!;
            const pt = layout.positions.get(edge.toNodeId)!;
            const isSel = selectedEdge?.id === edge.id;
            const isDim = selectedEdge !== null && !isSel;
            const cls = [
              'edge',
              `fam-${fam}`,
              edgeConfidenceClass(edge.confidence),
              isSel && 'is-selected',
              isDim && 'is-dim',
            ]
              .filter(Boolean)
              .join(' ');
            return <line key={edge.id} className={cls} x1={ps.x} y1={ps.y} x2={pt.x} y2={pt.y} />;
          })}
        </svg>
        {[...layout.positions.values()].map((p) => {
          const node = nodeById.get(p.id);
          if (node === undefined) return null;
          const isAnchor = p.ring === 0;
          const isDim =
            selectedEdge !== null &&
            !isAnchor &&
            !(selectedEdge.fromNodeId === p.id || selectedEdge.toNodeId === p.id);
          return (
            <div
              key={p.id}
              className="cx-orbit-node"
              style={{
                left: `${String((p.x / ORBIT_W) * 100)}%`,
                top: `${String((p.y / ORBIT_H) * 100)}%`,
              }}
              data-testid={`orbit-node-${p.id}`}
            >
              <NodeChip
                node={node}
                size={isAnchor ? 'lg' : 'md'}
                state={isAnchor ? 'anchor' : isDim ? undefined : undefined}
              />
            </div>
          );
        })}
      </div>
      <div className="cx-orbit-edges-strip" data-testid="connections-edges">
        <span className="label">Edges</span>
        {layout.edges.map((edge) => {
          const meta = EDGE_KINDS[edge.kind];
          const fam: EdgeFamily = meta?.family ?? 'urlmatch';
          const isSelected = selectedEdge?.id === edge.id;
          const hint = contentDerivedHint(edge.kind);
          return (
            <button
              key={edge.id}
              type="button"
              className={`cx-edgelabel ${isSelected ? 'is-selected' : ''}`}
              onClick={() => onSelectEdge(edge)}
              data-testid={`edge-${edge.id}`}
              style={{ cursor: 'pointer' }}
            >
              <span
                className={`cx-edge fam-${fam} ${edgeConfidenceClass(edge.confidence)}`.trim()}
                aria-hidden
              >
                <span className="cx-edge-line" />
              </span>
              <span>{meta?.label ?? edge.kind}</span>
              {hint !== null ? (
                <span className="bac-connections-edge-hint" data-testid={`edge-hint-${edge.id}`}>
                  {hint}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const TimelineRail = ({ data }: { readonly data: TimelineRailData }): ReactElement => {
  const pct = (h: number): number => (h / 24) * 100;
  return (
    <div className="cx-timeline" data-testid="connections-timeline">
      <div className="cx-timeline-head">
        <span className="cx-timeline-title">Observed activity</span>
        <span className="cx-timeline-sub">Plugin presence — not time tracking</span>
        <span className="cx-grow" />
        <span className="cx-mono cx-dim">{data.date}</span>
      </div>
      <div className="cx-timeline-axis">
        <span />
        <div className="ticks">
          {['12 AM', '3 AM', '6 AM', '9 AM', '12 PM', '3 PM', '6 PM', '9 PM'].map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>
      <div className="cx-timeline-rows">
        {data.rows.map((row, i) => (
          <div key={row.replicaId} className="cx-timeline-row">
            <div className="device" title={row.replicaId}>
              <span className="cx-replica-dot" />
              <span>{row.replicaId}</span>
            </div>
            <div className="lane">
              {row.windows.map(([a, b], j) => (
                <span
                  key={j}
                  className="obs"
                  style={{ left: `${String(pct(a))}%`, width: `${String(pct(b - a))}%` }}
                />
              ))}
              {/* Anchor marker — only on the first row to avoid noise */}
              {i === 0 && data.anchorTime !== null ? (
                <span
                  className="marker"
                  style={{ left: `${String(pct(data.anchorTime))}%` }}
                  title="Anchor"
                />
              ) : null}
              {i === 0
                ? data.neighborTimes.map((h, k) => (
                    <span
                      key={`n${String(k)}`}
                      className="marker ghost"
                      style={{ left: `${String(pct(h))}%` }}
                      title="Neighbor"
                    />
                  ))
                : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const NodeChip = ({
  node,
  state,
  size = 'md',
}: {
  readonly node: ConnectionNode;
  readonly state?: 'anchor' | 'selected';
  readonly size?: 'md' | 'lg';
}): ReactElement => {
  const display = NODE_KIND_DISPLAY[node.kind];
  const cls =
    `cx-node ${display.tintClass}` +
    (size === 'lg' ? ' lg' : '') +
    (state === 'anchor' ? ' is-anchor' : '') +
    (state === 'selected' ? ' is-selected' : '');
  return (
    <div className={cls} data-testid={`node-${node.id}`}>
      <span className="cx-node-icon" aria-hidden>
        {KindIcons[node.kind]}
      </span>
      <span className="cx-node-body">
        <span className="cx-node-kind">{display.label}</span>
        <span className="cx-node-title">{node.label}</span>
      </span>
    </div>
  );
};

const NodeRow = ({
  node,
  edge,
  direction,
  selected,
  onPromoteSnippet,
  onClick,
}: {
  readonly node: ConnectionNode;
  readonly edge: ConnectionEdge | null;
  readonly direction: 'in' | 'out';
  readonly selected: boolean;
  readonly onPromoteSnippet?: (input: {
    readonly snippetId: string;
    readonly sourceVisitId: string;
  }) => Promise<void>;
  readonly onClick: () => void;
}): ReactElement => {
  const [promoting, setPromoting] = useState<boolean>(false);
  const [promoteStatus, setPromoteStatus] = useState<'saved' | 'error' | null>(null);
  const display = NODE_KIND_DISPLAY[node.kind];
  const meta = edge !== null ? EDGE_KINDS[edge.kind] : null;
  const cls = `cx-row ${display.tintClass} ${selected ? 'is-selected' : ''}`;
  const sourceVisitId = snippetSourceVisitId(node, edge);
  const canPromote =
    onPromoteSnippet !== undefined && node.kind === 'snippet' && sourceVisitId !== null;
  const promote = (): void => {
    if (!canPromote || sourceVisitId === null) return;
    setPromoting(true);
    setPromoteStatus(null);
    void onPromoteSnippet({ snippetId: node.id, sourceVisitId })
      .then(() => {
        setPromoteStatus('saved');
      })
      .catch(() => {
        setPromoteStatus('error');
      })
      .finally(() => {
        setPromoting(false);
      });
  };
  return (
    <div className={cls} data-testid={`node-${node.id}`}>
      <button
        type="button"
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          padding: 0,
          border: 0,
          background: 'transparent',
          color: 'inherit',
          textAlign: 'left',
        }}
      >
        <span className={`cx-node-icon ${display.tintClass}`} aria-hidden>
          {KindIcons[node.kind]}
        </span>
        <span className="cx-row-body">
          <span className="cx-row-title">{node.label}</span>
          <span className="cx-row-meta">
            <span>{display.label}</span>
            {node.lastSeenAt !== undefined ? (
              <>
                <span>·</span>
                <span>{node.lastSeenAt.slice(0, 10)}</span>
              </>
            ) : null}
            {node.originReplicaIds.length > 0 ? (
              <>
                <span>·</span>
                <ReplicaDots replicaIds={node.originReplicaIds} />
              </>
            ) : null}
          </span>
        </span>
        {meta !== null ? (
          <span className="cx-row-edge">
            {direction === 'out' ? `→ ${meta.label}` : meta.label}
          </span>
        ) : null}
      </button>
      {canPromote ? (
        <button
          type="button"
          className="cx-focus-expand"
          disabled={promoting}
          onClick={promote}
          data-testid={`snippet-promote-${node.id}`}
        >
          {promoteStatus === 'saved' ? 'Promoted' : promoteStatus === 'error' ? 'Retry' : 'Promote'}
        </button>
      ) : null}
    </div>
  );
};

const HopToggle = ({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (v: number) => void;
}): ReactElement => (
  <div className="cx-pill-group" role="group" aria-label="Hops">
    {[1, 2].map((h) => (
      <button
        key={h}
        type="button"
        className={`cx-pill ${value === h ? 'is-active' : ''}`}
        onClick={() => onChange(h)}
      >
        {h}-hop
      </button>
    ))}
  </div>
);

const FamilyLegend = (): ReactElement => (
  <div className="cx-legend">
    {(Object.keys(FAMILIES) as EdgeFamily[]).map((fam) => {
      const f = FAMILIES[fam];
      return (
        <div key={fam} className="cx-legend-row">
          <span className={`cx-edge fam-${fam}`} aria-hidden>
            <span className="cx-edge-line" />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="cx-legend-label">{f.label}</span>
            <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>{f.description}</span>
          </span>
        </div>
      );
    })}
  </div>
);

const ReplicaDots = ({ replicaIds }: { readonly replicaIds: readonly string[] }): ReactElement => {
  const count = replicaIds.length;
  return (
    <span
      className="cx-replicas"
      title={count === 1 ? 'Seen on 1 device' : `Seen on ${String(count)} devices`}
    >
      {Array.from({ length: Math.min(count, 3) }).map((_, i) => (
        <span key={i} className="cx-replica-dot" />
      ))}
      {count > 1 ? <span className="cx-dim">{`${String(count)}×`}</span> : null}
    </span>
  );
};

const ProvenanceCard = ({
  edge,
  allNodes,
  onFlowFeedback,
  onClose,
}: {
  readonly edge: ConnectionEdge;
  readonly allNodes: readonly ConnectionNode[];
  readonly onFlowFeedback: (edge: ConnectionEdge, choice: FeedbackChoice) => Promise<void>;
  readonly onClose: () => void;
}): ReactElement => {
  const meta = EDGE_KINDS[edge.kind];
  const family: EdgeFamily = meta?.family ?? 'urlmatch';
  const fromNode = allNodes.find((n) => n.id === edge.fromNodeId);
  const toNode = allNodes.find((n) => n.id === edge.toNodeId);
  const reason = meta?.description ?? edge.kind;
  const supportsFlowFeedback = feedbackRelationKindForEdgeKind(edge.kind) !== null;
  return (
    <aside className="cx-prov" data-testid="edge-provenance">
      <header className="cx-prov-head">
        <span className="cx-prov-kind">{edge.kind}</span>
        <span className="cx-stamp">{edge.confidence}</span>
        <span className="cx-grow" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            background: 'transparent',
            border: 0,
            color: 'var(--ink-3)',
            cursor: 'pointer',
            display: 'grid',
            placeItems: 'center',
            width: 24,
            height: 24,
          }}
        >
          {CloseIcon}
        </button>
      </header>
      <div className="cx-prov-pair">
        {fromNode !== undefined ? (
          <NodeChip node={fromNode} />
        ) : (
          <span className="cx-mono cx-dim">{edge.fromNodeId}</span>
        )}
        <div className="cx-prov-arrow">
          <span
            className={`cx-edge fam-${family} ${edgeConfidenceClass(edge.confidence)}`.trim()}
            aria-hidden
          >
            <span className="cx-edge-line" />
          </span>
          <span style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {meta?.label ?? edge.kind}
          </span>
        </div>
        {toNode !== undefined ? (
          <NodeChip node={toNode} />
        ) : (
          <span className="cx-mono cx-dim">{edge.toNodeId}</span>
        )}
      </div>
      <div className="cx-prov-reason">
        Reason: <code>{reason}</code>
      </div>
      {supportsFlowFeedback ? (
        <div style={{ paddingTop: 10 }}>
          <FeedbackButtons
            label="relation"
            onFeedback={async (choice) => {
              await onFlowFeedback(edge, choice);
              return { ok: true };
            }}
          />
        </div>
      ) : null}
      <dl className="cx-prov-rows">
        <ProvRow label="Edge kind" value={edge.kind} mono />
        <ProvRow label="Family" value={FAMILIES[family].label} />
        <ProvRow label="Source" value={edge.producedBy.source} />
        {edge.producedBy.eventType !== undefined ? (
          <ProvRow label="Event type" value={edge.producedBy.eventType} mono />
        ) : null}
        {edge.producedBy.dot !== undefined ? (
          <ProvRow
            label="Origin replica"
            value={`${edge.producedBy.dot.replicaId} · seq ${String(edge.producedBy.dot.seq)}`}
            mono
          />
        ) : null}
        {edge.producedBy.recordId !== undefined ? (
          <ProvRow
            label="Record id"
            value={edge.producedBy.recordId}
            mono
            testId="edge-record-id"
          />
        ) : null}
        <ProvRow label="Observed at" value={edge.observedAt} mono />
        <ProvRow label="Confidence" value={edge.confidence} />
      </dl>
    </aside>
  );
};

const ProvRow = ({
  label,
  value,
  mono,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly testId?: string;
}): ReactElement => (
  <div className="cx-prov-row">
    <dt>{label}</dt>
    <dd className={mono === true ? 'mono' : ''} data-testid={testId}>
      {value}
    </dd>
  </div>
);

const ProvenanceEmpty = ({ anchor }: { readonly anchor: ConnectionNode | null }): ReactElement => (
  <div>
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 9.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--ink-3)',
        marginBottom: 8,
      }}
    >
      {anchor !== null ? 'Anchor summary' : 'No anchor'}
    </div>
    {anchor !== null ? <NodeChip node={anchor} state="anchor" size="lg" /> : null}
    <div
      style={{
        marginTop: 14,
        fontFamily: 'var(--body)',
        fontSize: 13,
        color: 'var(--ink-3)',
        lineHeight: 1.55,
      }}
    >
      {anchor !== null
        ? 'Click an edge or neighbor row to see why each connection exists.'
        : 'Pick a node on the left to anchor the graph.'}
    </div>
  </div>
);
