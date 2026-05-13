import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { ContextPackComposer } from './ContextPackComposer';
import {
  feedbackRelationKindForEdgeKind,
  postUserEngagementRelabeled,
  postUserFlowConfirmed,
  postUserFlowRejected,
  postUserSnippetPromoted,
  postUserTopicRenamed,
  type UserFlowRelationKind,
} from './client';
import { nodeKindDisplayFor } from './edgeKinds';
import { FamilyLegend } from './FamilyLegend';
import {
  FlowPathView,
  type CrossReplicaEdge,
  type FlowSummary,
  type NavigationEdge,
  type TabSessionInfo,
  type TimelineVisit,
} from './FlowPathView';
import {
  ENGAGEMENT_CLASSES,
  FocusView,
  type EngagementClass,
  type TopicNode,
  type TopicVisit,
} from './FocusView';
import { HopToggle } from './HopToggle';
import { KindIcons, SearchIcon } from './icons';
import { LinkedCenter } from './LinkedCenter';
import { NodeChip } from './NodeChip';
import { NodeSearchBox, type SearchableAnchor } from './NodeSearchBox';
import {
  ALL_RANGE,
  TimeRangePicker,
  filterByTimeRange,
  type TimeRangeValue,
} from './TimeRangePicker';
import { OrbitalCenter } from './OrbitalCenter';
import { PathFinder } from './PathFinder';
import { ProvenanceCard, ProvenanceEmpty } from './ProvenancePanel';
import { TimelineRail } from './TimelineRail';
import { computeTimelineRail, type TimelineRailData } from './timelineWindows';
import type {
  ConnectionEdge,
  ConnectionNode,
  ConnectionNodeKind,
  ConnectionsScopedResult,
} from './types';
import { useAnchorHistory } from './useAnchorHistory';
import { useConnectionsEdge, useConnectionsSnapshot } from './useConnectionsSnapshot';
import { useConnectionsFullSnapshot } from './useConnectionsFullSnapshot';
import { useRecallSearch } from './useRecallSearch';
import {
  formatEntityDisplay,
  formatNodeIdDisplay,
  hostOf,
  type EntityDisplayCtx,
} from '../entityDisplay/format';
import type { FeedbackChoice } from '../feedback/FeedbackButtons';
import { WhyRelatedPanel } from './WhyRelatedPanel';
import type { Reason } from './why-related/reasons';

// Connections side-panel view — anchor + 3-col shell (left rail,
// center subMode, right provenance). All subcomponents
// (NodeChip / NodeRow / TimelineRail / LinkedCenter / OrbitalCenter
// / ProvenancePanel / HopToggle / FamilyLegend / ReplicaDots) live
// in sibling files so this root stays focused on:
//   - anchor + draft + subMode state
//   - HTTP fetch effects (neighbors + edge detail)
//   - cross-mode derived data (timeline, focus, why-related)
//   - center-pane subMode switch
//
// Visible text never contains a raw internal id — every render path
// goes through `formatEntityDisplay` / `formatNodeIdDisplay` from
// the unified entity display layer.

export interface ConnectionsViewRecentAnchor {
  readonly id: string;
  readonly kind: ConnectionNodeKind;
  readonly label: string;
  readonly meta?: string;
}

export interface ConnectionsViewWorkstreamAnchor {
  readonly id: string;
  readonly label: string;
  readonly meta?: string;
}

type Props = {
  readonly initialAnchor?: string;
  readonly recentAnchors?: readonly ConnectionsViewRecentAnchor[];
  readonly workstreamAnchors?: readonly ConnectionsViewWorkstreamAnchor[];
  // Switch to (or open) a browser tab at the given URL when the user
  // clicks "Go to tab" on a URL-bearing node. When omitted, the
  // Go-to-tab button is not rendered for any node.
  readonly onOpenUrl?: (url: string) => void;
  // Unified entity display context. When omitted, falls back to a
  // safe ctx that returns null for workstream paths (helper degrades
  // to metadata.title or "Unknown workstream") and "Browser" for
  // replica aliases. Production callers pass a real ctx from App.tsx.
  readonly displayCtx?: EntityDisplayCtx;
  // Stage 5 polish — cross-surface anchor request from outside the
  // view (Inbox card "Graph" button). When this prop changes to a
  // non-empty value the view auto-navigates to that anchor as if
  // the user had typed it. Internal history.navigate is used so
  // back/forward semantics still work afterward. `onRequestConsumed`
  // clears the parent's request state so the same target can be
  // re-jumped after the user navigated elsewhere.
  readonly requestAnchor?: string;
  readonly onRequestConsumed?: () => void;
  // Cross-surface jump from Connections back to the Inbox. Fired
  // when the user clicks "Find in Inbox" on a URL-bearing anchor.
  // Receives the canonical URL; the parent decides whether to
  // switch viewMode + pre-fill the Inbox search.
  readonly onOpenInInbox?: (canonicalUrl: string) => void;
};

const DEFAULT_DISPLAY_CTX: EntityDisplayCtx = {
  resolveWorkstreamPath: () => null,
  replicaAlias: () => 'Browser',
};

type SubMode = 'linked' | 'orbital' | 'flow' | 'focus' | 'context';

const normalizeWorkstreamAnchorId = (id: string): string =>
  id.startsWith('workstream:') ? id : `workstream:${id}`;

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

// Stage 5 polish — Flow Path now sources its visits from
// `visit-instance` nodes too, not just `timeline-visit`. The
// navigation chain (`previous_visit_in_tab_session`,
// `opener_visit`) connects visit-instance nodes — without
// surfacing them here, the chain "HN front page → article →
// comments" was invisible even at hops=2. Tab grouping uses
// `metadata.tabSessionId` from visit-instances so each browser tab
// becomes its own row in the Flow Path view.
// Parse the canonical URL out of a visit node id when the node's
// metadata is missing it (common when the snapshot is anchor-scoped
// and didn't hydrate every neighbor). Node id formats:
//   timeline-visit:<url>
//   visit-instance:<tabSessionId>:<isoTimestamp>:<url>
// URLs contain colons (`http://…`) so reassemble after the last `:`
// separator that begins the URL — for visit-instance that's after
// the 3rd colon; for timeline-visit it's after the 1st.
const urlFromNodeId = (node: ConnectionNode): string | undefined => {
  const idx = node.id.indexOf(':');
  if (idx < 0) return undefined;
  if (node.kind === 'timeline-visit') {
    return node.id.slice(idx + 1);
  }
  if (node.kind === 'visit-instance') {
    const parts = node.id.split(':');
    if (parts.length < 4) return undefined;
    return parts.slice(3).join(':');
  }
  return undefined;
};

const deriveFlowVisits = (
  nodes: readonly ConnectionNode[],
  ctx: EntityDisplayCtx,
  anchorId: string,
): readonly TimelineVisit[] => {
  // Resolve the anchor URL so visit-instances whose URL matches can
  // be marked `isAnchor` even though their node ids differ.
  const anchorUrl = (() => {
    const anchorNode = nodes.find((n) => n.id === anchorId);
    if (anchorNode === undefined) {
      // Anchor not in scope (yet) — try parsing the id directly so
      // matching still works on first render.
      if (anchorId.startsWith('timeline-visit:')) {
        return anchorId.replace(/^timeline-visit:/u, '');
      }
      if (anchorId.startsWith('visit-instance:')) {
        const parts = anchorId.split(':');
        if (parts.length >= 4) return parts.slice(3).join(':');
      }
      return undefined;
    }
    return (
      metadataString(anchorNode.metadata, ['canonicalUrl', 'url', 'latestUrl']) ??
      urlFromNodeId(anchorNode)
    );
  })();

  const out: TimelineVisit[] = [];
  for (const node of nodes) {
    if (node.kind !== 'visit-instance' && node.kind !== 'timeline-visit') continue;
    const tabSessionIdHash =
      metadataString(node.metadata, ['tabSessionId', 'tabSessionIdHash', 'tabIdHash']) ??
      (node.kind === 'timeline-visit' ? 'all-tabs' : 'unknown-tab');
    const engagementClass = engagementClassForNode(node);
    const canonicalUrl =
      metadataString(node.metadata, ['canonicalUrl', 'url', 'latestUrl']) ??
      urlFromNodeId(node);
    const host = hostOf(canonicalUrl);
    // Prefer the nested engagement.focusedWindowMs (companion writes it
    // alongside engagement.class); fall back to a flat key for
    // backward compatibility with older snapshots.
    const engagementMeta = node.metadata['engagement'];
    const engagementFocusedMs =
      typeof engagementMeta === 'object' &&
      engagementMeta !== null &&
      !Array.isArray(engagementMeta) &&
      typeof (engagementMeta as Record<string, unknown>)['focusedWindowMs'] === 'number'
        ? ((engagementMeta as Record<string, unknown>)['focusedWindowMs'] as number)
        : undefined;
    const focusedWindowMs =
      engagementFocusedMs ?? metadataNumber(node.metadata, 'focusedWindowMs', 0);
    const provider = metadataString(node.metadata, ['provider']);
    const visitCount = metadataNumber(node.metadata, 'visitCount', 0);
    const searchQuery = metadataString(node.metadata, ['searchQuery']);
    const isAnchor =
      node.id === anchorId ||
      (anchorUrl !== undefined && canonicalUrl === anchorUrl);
    out.push({
      id: node.id,
      label: formatEntityDisplay(node, ctx).primary,
      commitTimestamp:
        node.lastSeenAt ??
        metadataString(node.metadata, ['commitTimestamp', 'lastSeenAt', 'observedAt']) ??
        '1970-01-01T00:00:00.000Z',
      tabSessionIdHash,
      ...(engagementClass === undefined ? {} : { engagementClass }),
      ...(host === undefined ? {} : { host }),
      ...(canonicalUrl === undefined ? {} : { url: canonicalUrl }),
      ...(focusedWindowMs > 0 ? { focusedWindowMs } : {}),
      ...(isAnchor ? { isAnchor: true } : {}),
      ...(provider === undefined ? {} : { provider }),
      ...(visitCount > 0 ? { visitCount } : {}),
      ...(searchQuery === undefined ? {} : { searchQuery }),
      ...(node.firstSeenAt === undefined ? {} : { firstSeenAt: node.firstSeenAt }),
    });
  }
  return out;
};

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

// Build tab-session info keyed by the same hash the visits use for
// grouping (visit-instance's `metadata.tabSessionId`). Flow Path
// renders this as the tab column header (title + host + lifespan).
const deriveTabSessions = (
  nodes: readonly ConnectionNode[],
  ctx: EntityDisplayCtx,
): ReadonlyMap<string, TabSessionInfo> => {
  const out = new Map<string, TabSessionInfo>();
  for (const node of nodes) {
    if (node.kind !== 'tab-session') continue;
    const tabSessionId = node.id.replace(/^tab-session:/u, '');
    const lastActivityAt =
      metadataString(node.metadata, ['lastActivityAt']) ?? node.lastSeenAt;
    const firstSeenAt = node.firstSeenAt;
    const lifespanMs =
      lastActivityAt !== undefined && firstSeenAt !== undefined
        ? Math.max(0, Date.parse(lastActivityAt) - Date.parse(firstSeenAt))
        : undefined;
    const latestUrl = metadataString(node.metadata, ['latestUrl', 'canonicalUrl']);
    const host = hostOf(latestUrl);
    out.set(tabSessionId, {
      label: formatEntityDisplay(node, ctx).primary,
      ...(host === undefined ? {} : { host }),
      ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
      ...(firstSeenAt === undefined ? {} : { firstSeenAt }),
      ...(lifespanMs === undefined ? {} : { lifespanMs }),
    });
  }
  return out;
};

// Cross-tab opener map from `tab_session_opener_chain` edges. The
// visit-level `opener_visit` map handled in FlowPathView is more
// specific (knows WHICH visit opened the new tab); this fills the
// gap when the source visit isn't loaded in scope.
const deriveTabOpenerMap = (
  edges: readonly ConnectionEdge[],
): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind !== 'tab_session_opener_chain') continue;
    const dest = edge.fromNodeId.replace(/^tab-session:/u, '');
    const src = edge.toNodeId.replace(/^tab-session:/u, '');
    if (dest.length > 0 && src.length > 0) out.set(dest, src);
  }
  return out;
};

// Lifecycle stats for the strip above the Flow Path rows. Aggregates
// across every TimelineVisit that matches the anchor URL — that's
// how the user sees "Visited 3 times across 3 tabs · first 5 min ago".
const deriveFlowSummary = (
  visits: readonly TimelineVisit[],
  crossReplicaEdges: readonly CrossReplicaEdge[],
  replicaAlias: (id: string) => string,
): FlowSummary => {
  const anchorVisits = visits.filter((v) => v.isAnchor === true);
  const tabHashes = new Set<string>();
  for (const v of anchorVisits) tabHashes.add(v.tabSessionIdHash);
  let earliestMs: number | undefined;
  for (const v of anchorVisits) {
    const seed = v.firstSeenAt ?? v.commitTimestamp;
    const ms = Date.parse(seed);
    if (Number.isFinite(ms) && (earliestMs === undefined || ms < earliestMs)) {
      earliestMs = ms;
    }
  }
  const replicaIds = new Set<string>();
  for (const edge of crossReplicaEdges) replicaIds.add(edge.replicaId);
  const replicaAliases = [...replicaIds].map((id) => replicaAlias(id)).sort();
  return {
    visitCount: anchorVisits.length,
    tabCount: tabHashes.size,
    ...(earliestMs === undefined ? {} : { firstSeenAt: new Date(earliestMs).toISOString() }),
    replicaAliases,
  };
};

// Stage 5 polish — the anchor-scoped subgraph only carries 1-2 hops
// from the anchor. Navigation chains (previous_visit_in_tab_session,
// opener_visit) often run 5-10 visits deep, so when the user
// anchors on a single visit-instance the prev visit (the page they
// arrived from) lives outside scope and never appears on Flow Path.
//
// Generic fix: when the full snapshot is loaded, BFS from the
// in-scope visits over the navigation-edge kinds and pull in any
// visits transitively reachable. Caps at 64 nodes / 8 iterations to
// keep the panel responsive for hub visits with very wide chains.
const NAV_EDGE_KINDS = new Set<string>([
  'previous_visit_in_tab_session',
  'opener_visit',
  'visit_instance_same_url_as_timeline_visit',
  'visit_in_tab_session',
  'visit_instance_in_tab_session',
]);

const expandFlowSubgraph = (
  scopeNodes: readonly ConnectionNode[],
  fullNodes: readonly ConnectionNode[],
  fullEdges: readonly ConnectionEdge[],
): { readonly nodes: readonly ConnectionNode[]; readonly edges: readonly ConnectionEdge[] } => {
  if (fullNodes.length === 0 || fullEdges.length === 0) {
    return { nodes: scopeNodes, edges: [] };
  }
  const reachable = new Set<string>();
  for (const node of scopeNodes) {
    if (node.kind === 'visit-instance' || node.kind === 'timeline-visit') {
      reachable.add(node.id);
    }
  }
  const navEdges = fullEdges.filter((edge) => NAV_EDGE_KINDS.has(edge.kind));
  const MAX_ITERATIONS = 8;
  const MAX_NODES = 64;
  for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
    let grew = false;
    for (const edge of navEdges) {
      if (reachable.size >= MAX_NODES) break;
      const fromIn = reachable.has(edge.fromNodeId);
      const toIn = reachable.has(edge.toNodeId);
      if (fromIn && !toIn) {
        reachable.add(edge.toNodeId);
        grew = true;
      } else if (toIn && !fromIn) {
        reachable.add(edge.fromNodeId);
        grew = true;
      }
    }
    if (!grew) break;
  }
  const fullNodeById = new Map(fullNodes.map((node) => [node.id, node] as const));
  const nodes: ConnectionNode[] = [];
  for (const id of reachable) {
    const node = fullNodeById.get(id);
    if (node !== undefined) nodes.push(node);
  }
  const edges = fullEdges.filter(
    (edge) => reachable.has(edge.fromNodeId) && reachable.has(edge.toNodeId),
  );
  return { nodes, edges };
};

// Stage 5 polish — Focus view sources visitsByTopic from the FULL
// snapshot, not just the anchor's loaded neighborhood. The earlier
// scope-bound derivation produced the "8 members listed but only 1
// shown" gap users hit on screenshot #34: `topic.memberCount` is
// from the topic-revision producer (global truth), while the
// `visit_in_topic` edges only landed in scope when the anchor
// reached them in 1-2 hops. Generic fix: derive from the full
// snapshot when it's been primed; fall back to anchor-scope when
// not yet loaded.
const deriveFocusData = (
  scopeNodes: readonly ConnectionNode[],
  scopeEdges: readonly ConnectionEdge[],
  fullNodes: readonly ConnectionNode[],
  fullEdges: readonly ConnectionEdge[],
  ctx: EntityDisplayCtx,
): {
  readonly topics: readonly TopicNode[];
  readonly visitsByTopic: Record<string, readonly TopicVisit[]>;
  readonly engagementClassesByVisit: Record<string, EngagementClass>;
} => {
  // Topics come from the scope so we render only the topics
  // reachable from the anchor — pulling every topic across the
  // whole vault would drown the panel.
  const topics: TopicNode[] = scopeNodes
    .filter((node) => node.kind === 'topic')
    .map((node) => ({
      id: node.id,
      label: formatEntityDisplay(node, ctx).primary,
      memberCount: metadataNumber(node.metadata, 'memberCount', 0),
      cohesion: metadataNumber(node.metadata, 'cohesion', 0),
      ...(metadataString(node.metadata, ['dominantWorkstreamId']) === undefined
        ? {}
        : { dominantWorkstreamId: metadataString(node.metadata, ['dominantWorkstreamId']) }),
    }));

  // Build visitsByTopic from full-snapshot edges so the member
  // list matches `memberCount`. Falls back to scope edges when
  // the full snapshot isn't loaded yet (degrades to old behavior,
  // just with a count mismatch the user might notice).
  const hasFull = fullNodes.length > 0 && fullEdges.length > 0;
  const sourceNodes = hasFull ? fullNodes : scopeNodes;
  const sourceEdges = hasFull ? fullEdges : scopeEdges;
  const nodeById = new Map(sourceNodes.map((node) => [node.id, node] as const));

  const visitsByTopic: Record<string, TopicVisit[]> = {};
  for (const edge of sourceEdges) {
    if (edge.kind !== 'visit_in_topic') continue;
    const visit = nodeById.get(edge.fromNodeId);
    if (visit === undefined) continue;
    const list = visitsByTopic[edge.toNodeId] ?? [];
    visitsByTopic[edge.toNodeId] = [
      ...list,
      {
        id: visit.id,
        label: formatEntityDisplay(visit, ctx).primary,
        focusedWindowMs: metadataNumber(visit.metadata, 'focusedWindowMs', 0),
      },
    ];
  }

  // Engagement classes — keep using scope nodes (the
  // user's recent activity tends to be in scope already).
  const engagementClassesByVisit: Record<string, EngagementClass> = {};
  for (const node of scopeNodes) {
    const engagementClass = engagementClassForNode(node);
    if (node.kind === 'timeline-visit' && engagementClass !== undefined) {
      engagementClassesByVisit[node.id] = engagementClass;
    }
  }
  return { topics, visitsByTopic, engagementClassesByVisit };
};

const reasonsForVisit = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  visitId: string,
  ctx: EntityDisplayCtx,
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
        threadName: thread === undefined ? 'Unknown thread' : formatEntityDisplay(thread, ctx).primary,
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
      const fallback =
        visit === undefined ? '(visit)' : formatEntityDisplay(visit, ctx).primary;
      reasons.push({
        code: 'LEXICAL_OVERLAP',
        topTokens: query === undefined ? [fallback] : query.split(/\s+/u),
      });
    }
  }
  const fallbackVisitLabel = (() => {
    const node = nodeById.get(visitId);
    return node === undefined
      ? formatNodeIdDisplay(visitId, nodeById, ctx).primary
      : formatEntityDisplay(node, ctx).primary;
  })();
  return reasons.length > 0
    ? reasons
    : [{ code: 'LEXICAL_OVERLAP', topTokens: [fallbackVisitLabel] }];
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

const hasRevisionProducer = (edge: ConnectionEdge): boolean =>
  'revisionId' in edge.producedBy &&
  typeof edge.producedBy.revisionId === 'string' &&
  edge.producedBy.revisionId.length > 0;

const findRevisionEdgeForVisit = (
  edges: readonly ConnectionEdge[],
  visitId: string,
): ConnectionEdge | null =>
  edges.find(
    (edge) =>
      hasRevisionProducer(edge) && (edge.fromNodeId === visitId || edge.toNodeId === visitId),
  ) ?? null;

const requireFeedbackRelationKind = (edge: ConnectionEdge): UserFlowRelationKind => {
  const relationKind = feedbackRelationKindForEdgeKind(edge.kind);
  if (relationKind === null) {
    throw new Error(`Unsupported feedback edge kind: ${edge.kind}`);
  }
  return relationKind;
};

export const ConnectionsView = ({
  initialAnchor = '',
  recentAnchors = [],
  workstreamAnchors = [],
  onOpenUrl,
  displayCtx,
  requestAnchor,
  onRequestConsumed,
  onOpenInInbox,
}: Props): ReactElement => {
  const baseCtx: EntityDisplayCtx = displayCtx ?? DEFAULT_DISPLAY_CTX;
  // Anchor history — back/forward stack so drilling into a neighbor
  // and returning is one click. `history.current` is the anchor the
  // hook is currently focused on; `history.navigate(next)` pushes
  // onto the past stack.
  const history = useAnchorHistory(initialAnchor);
  const anchor = history.current;
  // Advanced-anchor input. Starts empty so the field isn't pre-loaded
  // with a raw id like `visit-instance:tses_…:<iso>:<URL>` that nobody
  // would type by hand. Submission reads from this draft only; click
  // navigation never writes to it (see navigateToAnchor).
  const [draftAnchor, setDraftAnchor] = useState<string>('');
  const [hops, setHops] = useState<number>(1);
  const [subMode, setSubMode] = useState<SubMode>('linked');
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(ALL_RANGE);
  const [selectedEdge, setSelectedEdge] = useState<ConnectionEdge | null>(null);
  const [whyVisitId, setWhyVisitId] = useState<string | null>(null);
  const [whyAssertedOnly, setWhyAssertedOnly] = useState<boolean>(false);

  // Snapshot fetching: cached by (anchor, hops), revalidated in the
  // background when revisited so the user gets instant flips through
  // history with no perceptible loading state.
  const { snapshot: rawSnapshot, loading, error, refresh } = useConnectionsSnapshot(anchor, hops);
  // Edge detail enrichment — companion serves extra metadata (ranker
  // contributions, etc.) the neighbor scope strips for size.
  const edgeDetail = useConnectionsEdge(selectedEdge);
  // Stage 5 polish — full-snapshot pool for the search box, primed
  // lazily when the input gains focus. Lets the user find any
  // node in the vault, not just whatever the anchor's neighborhood
  // happens to have loaded.
  const fullSnapshot = useConnectionsFullSnapshot();
  // Recall-index full-text search. Debounced; fires on the
  // controlled search-box query. Below 3 chars the hook returns
  // an empty list so the panel doesn't spam the embedder.
  const [searchQuery, setSearchQuery] = useState<string>('');
  const recallResults = useRecallSearch(searchQuery);
  // Local in-memory mutation of the cached snapshot (topic rename,
  // engagement relabel) — the snapshot is owned by the cache, so we
  // keep a transient override map until the next fetch refreshes the
  // canonical labels.
  const [labelOverrides, setLabelOverrides] = useState<Record<string, string>>({});
  const [engagementOverrides, setEngagementOverrides] = useState<Record<string, EngagementClass>>(
    {},
  );
  // Apply override maps + time-range filter to the raw snapshot.
  // Downstream consumers see the same shape as a raw
  // `ConnectionsScopedResult`, so they don't need to know about
  // overrides or the time filter at all.
  const result = useMemo(() => {
    if (rawSnapshot === null) return null;
    // Step 1 — apply label / engagement overrides (topic rename,
    // engagement relabel) so optimistic UI lands before the next
    // companion fetch revalidates.
    let nodes = rawSnapshot.snapshot.nodes;
    if (
      Object.keys(labelOverrides).length > 0 ||
      Object.keys(engagementOverrides).length > 0
    ) {
      nodes = nodes.map((node) => {
        const labelOverride = labelOverrides[node.id];
        const engagementOverride = engagementOverrides[node.id];
        if (labelOverride === undefined && engagementOverride === undefined) return node;
        const nextMetadata =
          engagementOverride === undefined
            ? node.metadata
            : {
                ...node.metadata,
                engagement: {
                  ...((isRecord(node.metadata['engagement'])
                    ? node.metadata['engagement']
                    : {}) as Record<string, unknown>),
                  class: engagementOverride,
                },
              };
        return {
          ...node,
          ...(labelOverride === undefined ? {} : { label: labelOverride }),
          metadata: nextMetadata,
        };
      });
    }
    // Step 2 — apply the time-range filter. Anchor is kept
    // unconditionally so the anchor chip never disappears under the
    // user's feet.
    const filtered = filterByTimeRange(nodes, rawSnapshot.snapshot.edges, timeRange, {
      anchorId: anchor,
    });
    return {
      ...rawSnapshot,
      snapshot: {
        ...rawSnapshot.snapshot,
        nodes: filtered.nodes,
        edges: filtered.edges,
        nodeCount: filtered.nodes.length,
        edgeCount: filtered.edges.length,
      },
    };
  }, [anchor, engagementOverrides, labelOverrides, rawSnapshot, timeRange]);

  // For the time-range pill bar — how many nodes are hidden by the
  // current filter. Computed cheaply from the difference between
  // the raw snapshot and the filtered result.
  const hiddenByTime = useMemo(() => {
    if (rawSnapshot === null || result === null) return 0;
    return Math.max(0, rawSnapshot.snapshot.nodes.length - result.snapshot.nodes.length);
  }, [rawSnapshot, result]);

  // Stage 5 polish — derived ctx that carries the current snapshot's
  // node map so kinds like `inbound-reminder` (which surfaces its
  // thread's title in `formatEntityDisplay`) can resolve cross-node
  // references without per-callsite plumbing.
  const snapshotNodeById = useMemo(() => {
    if (result === null) return new Map<string, ConnectionNode>();
    return new Map(result.snapshot.nodes.map((node) => [node.id, node] as const));
  }, [result]);
  const ctx: EntityDisplayCtx = useMemo(
    () => ({ ...baseCtx, nodeById: snapshotNodeById }),
    [baseCtx, snapshotNodeById],
  );

  const anchorNode = useMemo<ConnectionNode | null>(() => {
    if (result === null) return null;
    return result.snapshot.nodes.find((n) => n.id === anchor) ?? null;
  }, [result, anchor]);

  const timeline = useMemo<TimelineRailData | null>(() => {
    if (result === null) return null;
    return computeTimelineRail(result.snapshot, anchor);
  }, [result, anchor]);

  const workstreamOptions = useMemo<readonly ConnectionsViewWorkstreamAnchor[]>(() => {
    const byId = new Map<string, ConnectionsViewWorkstreamAnchor>();
    const add = (input: ConnectionsViewWorkstreamAnchor): void => {
      const id = normalizeWorkstreamAnchorId(input.id);
      if (byId.has(id)) return;
      byId.set(id, { ...input, id });
    };
    for (const input of workstreamAnchors) add(input);
    for (const recent of recentAnchors) {
      if (recent.kind === 'workstream') {
        add({
          id: recent.id,
          label: recent.label,
          ...(recent.meta === undefined ? {} : { meta: recent.meta }),
        });
      }
    }
    for (const node of result?.snapshot.nodes ?? []) {
      if (node.kind !== 'workstream') continue;
      add({
        id: node.id,
        label: formatEntityDisplay(node, ctx).primary,
        ...(node.lastSeenAt === undefined ? {} : { meta: node.lastSeenAt.slice(0, 10) }),
      });
    }
    if (anchor.startsWith('workstream:')) {
      const fallbackNodeById = new Map<string, ConnectionNode>();
      if (anchorNode !== null) fallbackNodeById.set(anchorNode.id, anchorNode);
      add({
        id: anchor,
        label: formatNodeIdDisplay(anchor, fallbackNodeById, ctx).primary,
      });
    }
    return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [anchor, anchorNode, ctx, recentAnchors, result, workstreamAnchors]);

  // Stage 5 polish — separate two anchor-navigation paths so click
  // navigation NEVER pollutes the advanced-anchor input:
  //   - `submitAdvancedAnchor()` reads `draftAnchor` (only the
  //     advanced-anchor input + the workstream dropdown call this
  //     with `next` so the input value matches).
  //   - `navigateToAnchor(id)` is what every click handler (search
  //     hit, recent anchor, empty-state quickpick, path-finder
  //     pill, Inbox jump) should call. Never touches draftAnchor.
  //
  // Root cause of "advanced anchor shows visit-instance:tses_…":
  // the previous `submitAnchor(next?)` set draftAnchor whenever
  // `next` was provided, so EVERY click handler that passed an id
  // dumped that id into the visible input field.
  const submitAdvancedAnchor = (): void => {
    const value = draftAnchor.trim();
    if (value.length === 0) return;
    setSelectedEdge(null);
    setWhyVisitId(null);
    history.navigate(value);
  };
  const navigateToAnchor = (nextAnchorId: string): void => {
    const value = nextAnchorId.trim();
    if (value.length === 0) return;
    setSelectedEdge(null);
    setWhyVisitId(null);
    history.navigate(value);
  };

  const selectedWorkstreamAnchor = anchor.startsWith('workstream:') ? anchor : '';

  // Search pool — node candidates merged from (a) the current
  // anchor's neighborhood (small, always fresh) + (b) the full
  // snapshot (large, primed on search-box focus). Anchor scope
  // takes precedence so labels updated via topic-rename / engagement-
  // relabel still reflect immediately.
  const searchNodes = useMemo<readonly ConnectionNode[]>(() => {
    const byId = new Map<string, ConnectionNode>();
    for (const n of fullSnapshot.nodes) byId.set(n.id, n);
    for (const n of result?.snapshot.nodes ?? []) byId.set(n.id, n);
    return [...byId.values()];
  }, [fullSnapshot.nodes, result]);

  // Search pool — combines the user's named workstreams + recent
  // anchors so the search box catches things even when they aren't
  // in the current snapshot's neighbor scope. Deduped by id.
  const searchExtras = useMemo<readonly SearchableAnchor[]>(() => {
    const out: SearchableAnchor[] = [];
    const seen = new Set<string>();
    for (const w of workstreamAnchors) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      out.push({
        id: w.id,
        label: w.label,
        kind: 'workstream',
        ...(w.meta === undefined ? {} : { meta: w.meta }),
      });
    }
    for (const r of recentAnchors) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({
        id: r.id,
        label: r.label,
        kind: r.kind,
        ...(r.meta === undefined ? {} : { meta: r.meta }),
      });
    }
    return out;
  }, [recentAnchors, workstreamAnchors]);

  const useNodeAsAnchor = (nodeId: string): void => {
    setSelectedEdge(null);
    setWhyVisitId(null);
    // Stage 5 polish — DO NOT overwrite draftAnchor with the raw
    // node id. Users complained that clicking a visit-instance
    // populated the advanced-anchor input with the gibberish
    // `visit-instance:tses_*:<iso>:<URL>` string. The advanced
    // input is for user-typed input only; clicks navigate through
    // history without leaking the raw id into a visible field.
    history.navigate(nodeId);
  };

  // Stage 5 polish — cross-surface anchor request from outside the
  // view (Inbox "Graph" button). Re-anchors when the prop changes
  // to a non-empty value; uses history.navigate so back/forward
  // semantics still apply after the jump. `onRequestConsumed` clears
  // the parent's state so the same target can be re-requested later.
  useEffect(() => {
    if (requestAnchor === undefined || requestAnchor.length === 0) return;
    if (requestAnchor !== anchor) {
      useNodeAsAnchor(requestAnchor);
    }
    onRequestConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- useNodeAsAnchor closes over
    // history; the effect only needs to fire when the request itself changes.
  }, [requestAnchor]);

  // Stage 5 polish — derive a canonical URL from the current anchor
  // so the "Find in Inbox" button can pass it back to App.tsx. Three
  // anchor kinds carry a URL signal: timeline-visit (id is the URL),
  // visit-instance (id is `visit-instance:tses_*:<iso>:<URL>`), and
  // tab-session / thread (metadata.canonicalUrl). Returns null when
  // the anchor doesn't carry a URL (workstreams, topics, snippets).
  const anchorCanonicalUrl = useMemo<string | null>(() => {
    if (anchor.length === 0) return null;
    if (anchor.startsWith('timeline-visit:')) {
      return anchor.slice('timeline-visit:'.length);
    }
    if (anchor.startsWith('visit-instance:')) {
      const tail = anchor.slice('visit-instance:'.length);
      const httpIdx = tail.indexOf(':http');
      if (httpIdx >= 0) return tail.slice(httpIdx + 1);
    }
    if (anchorNode !== null) {
      const meta = anchorNode.metadata as Record<string, unknown>;
      const fromMeta = ['canonicalUrl', 'latestUrl', 'url']
        .map((k) => meta[k])
        .find((v): v is string => typeof v === 'string' && v.length > 0);
      if (fromMeta !== undefined) return fromMeta;
    }
    return null;
  }, [anchor, anchorNode]);

  // Stage 5 polish — Connections refactor (Phase C usability).
  // Browser-style Alt+← / Alt+→ keyboard shortcuts for anchor
  // history. Cmd/Ctrl-modified keys are left alone so the browser's
  // own back / forward still works at the top level.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.key === 'ArrowLeft' && history.canBack) {
        event.preventDefault();
        setSelectedEdge(null);
        setWhyVisitId(null);
        history.back();
      } else if (event.key === 'ArrowRight' && history.canForward) {
        event.preventDefault();
        setSelectedEdge(null);
        setWhyVisitId(null);
        history.forward();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [history]);

  const selectEdge = (edge: ConnectionEdge): void => {
    setWhyVisitId(null);
    setSelectedEdge(edge);
  };

  // Local overrides for topic-rename + engagement-relabel optimistic
  // UI. The next snapshot fetch refreshes canonical labels; until
  // then, the override map applied in `resultWithOverrides` shows
  // the user their just-renamed value without a round-trip.
  const replaceNodeLabel = (nodeId: string, label: string): void => {
    setLabelOverrides((current) => ({ ...current, [nodeId]: label }));
  };
  const replaceNodeEngagementClass = (
    nodeId: string,
    engagementClass: EngagementClass,
  ): void => {
    setEngagementOverrides((current) => ({ ...current, [nodeId]: engagementClass }));
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
  // Stage 5 polish — sub-mode availability gates. Each gated mode
  // surfaces a specific node kind, so when that kind isn't in the
  // current subgraph the user gets a blank panel with no idea why.
  // Pre-compute availability + a one-line reason so the tabs can
  // disable themselves (and explain the gating) instead of silently
  // rendering empty.
  const modeAvailability = useMemo(() => {
    const nodes = result?.snapshot.nodes ?? [];
    const hasVisits = nodes.some((n) => n.kind === 'timeline-visit');
    const hasTopics = nodes.some((n) => n.kind === 'topic');
    const isWorkstream = anchor.startsWith('workstream:');
    return {
      flow: {
        enabled: hasVisits,
        reason: hasVisits
          ? undefined
          : 'No timeline-visits in scope. Anchor on a workstream + ↑ Hops to 2, or pick a topic.',
      },
      focus: {
        enabled: hasTopics,
        reason: hasTopics
          ? undefined
          : 'No topic clusters in scope. Topics appear at higher hop counts on workstream anchors.',
      },
      context: {
        enabled: isWorkstream,
        reason: isWorkstream
          ? undefined
          : 'Context Pack composer only works for workstream anchors. Pick a workstream first.',
      },
    };
  }, [anchor, result]);

  // 2026-05 cleanup: the auto-recovery used to bounce the user back
  // to 'linked' the instant they clicked a mode tab whose data
  // wasn't ready. That conflicted with the tabs being clickable —
  // every click would flicker → bounce. The child views now render
  // informative empty states for the "no visits / no topics / not a
  // workstream" cases, so it's safe to land on a mode tab even
  // without data; the user reads the empty state and learns what's
  // needed. Auto-recovery removed entirely.

  // Stage 5 polish — auto-prime the full snapshot when Focus mode
  // is selected. The Focus derivation needs all `visit_in_topic`
  // edges (global) so the per-topic member list matches the topic's
  // metadata.memberCount; without the full snapshot we'd show a
  // truncated list. Also primes for path-finding which benefits
  // from the same global pool.
  useEffect(() => {
    // Flow Path also needs the global snapshot — navigation chains
    // run beyond 1-2 hops, so anchoring on a single visit-instance
    // would otherwise hide its parent page (the "URL_A → URL_B"
    // arrow the user expects).
    if (subMode === 'focus' || subMode === 'flow') fullSnapshot.prime();
    // Intentionally not depending on fullSnapshot itself — prime()
    // is internally idempotent and the no-op guard handles repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subMode]);
  const whyFeedbackEdge = useMemo(() => {
    if (result === null || whyVisitId === null) return null;
    return findFeedbackEdge(result.snapshot.edges, anchor, whyVisitId);
  }, [result, anchor, whyVisitId]);
  const whyRevisionEdge = useMemo(() => {
    if (result === null || whyVisitId === null) return null;
    return findRevisionEdgeForVisit(result.snapshot.edges, whyVisitId);
  }, [result, whyVisitId]);
  const focusData = useMemo(
    () =>
      result === null
        ? { topics: [], visitsByTopic: {}, engagementClassesByVisit: {} }
        : deriveFocusData(
            result.snapshot.nodes,
            result.snapshot.edges,
            fullSnapshot.nodes,
            fullSnapshot.edges,
            ctx,
          ),
    [ctx, fullSnapshot.edges, fullSnapshot.nodes, result],
  );
  // Flow Path subgraph — expand the anchor scope with the full
  // snapshot's navigation-edge transitive closure (capped). Keeps
  // the chain compact for hub visits while still surfacing the
  // parent page when the user lands on a leaf visit-instance.
  const flowSubgraph = useMemo(() => {
    if (result === null) return { nodes: [], edges: [] } as const;
    return expandFlowSubgraph(
      result.snapshot.nodes,
      fullSnapshot.nodes,
      fullSnapshot.edges,
    );
  }, [result, fullSnapshot.nodes, fullSnapshot.edges]);
  const contextWorkstreamId = useMemo(() => {
    if (anchor.startsWith('workstream:')) return anchor.replace(/^workstream:/u, '');
    const workstream = result?.snapshot.nodes.find((node) => node.kind === 'workstream');
    return workstream?.id.replace(/^workstream:/u, '') ?? anchor;
  }, [anchor, result]);

  return (
    <div className="cx-shell-host bac-connections-view" data-testid="connections-view">
      <div className="cx-anchorbar">
        <div className="cx-anchorbar-nav">
          <button
            type="button"
            className="cx-anchor-nav-btn"
            onClick={() => {
              setSelectedEdge(null);
              setWhyVisitId(null);
              history.back();
            }}
            disabled={!history.canBack}
            aria-label="Previous anchor"
            data-testid="connections-anchor-back"
            title="Previous anchor (browser-back style)"
          >
            ←
          </button>
          <button
            type="button"
            className="cx-anchor-nav-btn"
            onClick={() => {
              setSelectedEdge(null);
              setWhyVisitId(null);
              history.forward();
            }}
            disabled={!history.canForward}
            aria-label="Next anchor"
            data-testid="connections-anchor-forward"
            title="Next anchor (redo)"
          >
            →
          </button>
        </div>
        <span className="cx-anchor-label">Anchor</span>
        {anchorNode !== null ? (
          <NodeChip node={anchorNode} state="anchor" ctx={ctx} />
        ) : anchor.length > 0 && loading ? (
          <span className="cx-mono cx-dim">resolving anchor…</span>
        ) : (
          <span className="cx-mono cx-dim">no anchor selected</span>
        )}
        {onOpenInInbox !== undefined && anchorCanonicalUrl !== null ? (
          // Inline icon next to the anchor chip — only when the
          // anchor carries a canonical URL. Keeps the anchor row
          // single-line at the cost of one extra glyph.
          <button
            type="button"
            className="cx-anchor-nav-btn cx-anchor-inline-btn"
            onClick={() => {
              onOpenInInbox(anchorCanonicalUrl);
            }}
            aria-label="Find this URL in Inbox"
            title={`Find in Inbox · ${anchorCanonicalUrl}`}
            data-testid="connections-anchor-open-inbox"
          >
            ⇄
          </button>
        ) : null}
        <span className="cx-spacer" />
        <button
          type="button"
          className="cx-anchor-nav-btn"
          onClick={refresh}
          disabled={anchor.length === 0 || loading}
          aria-label="Refresh snapshot"
          data-testid="connections-anchor-refresh"
          title="Refresh — drop the cache and re-fetch from companion"
        >
          ↻
        </button>
        <HopToggle value={hops} onChange={setHops} />
      </div>
      <div className="cx-modes" role="tablist" aria-label="View mode">
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'linked'}
          className={'cx-mode' + (subMode === 'linked' ? ' is-active' : '')}
          onClick={() => {
            setSubMode('linked');
          }}
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
          onClick={() => {
            setSubMode('orbital');
          }}
          data-testid="connections-mode-orbital"
        >
          Orbital
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'flow'}
          // 2026-05 cleanup: the tabs were previously `disabled` when
          // their data wasn't in scope, with a tooltip explaining
          // why. Disabled tabs hide the affordance behind a hover —
          // most users never see it. Each child view (FlowPathView,
          // FocusView, ContextPackComposer) already renders an
          // informative empty state when there's no data, so allow
          // the click and let the panel teach by example. The
          // `is-dim` class subtle-dims the label so power users
          // still see "there's not much here" at a glance.
          className={
            'cx-mode' +
            (subMode === 'flow' ? ' is-active' : '') +
            (modeAvailability.flow.enabled ? '' : ' is-dim')
          }
          onClick={() => setSubMode('flow')}
          title={modeAvailability.flow.reason}
          data-testid="connections-mode-flow"
        >
          Flow Path
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'focus'}
          className={
            'cx-mode' +
            (subMode === 'focus' ? ' is-active' : '') +
            (modeAvailability.focus.enabled ? '' : ' is-dim')
          }
          onClick={() => setSubMode('focus')}
          title={modeAvailability.focus.reason}
          data-testid="connections-mode-focus"
        >
          Focus
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'context'}
          className={
            'cx-mode' +
            (subMode === 'context' ? ' is-active' : '') +
            (modeAvailability.context.enabled ? '' : ' is-dim')
          }
          onClick={() => setSubMode('context')}
          title={modeAvailability.context.reason}
          data-testid="connections-mode-context"
        >
          Context Pack
        </button>
      </div>
      <PathFinder
        anchorId={anchor}
        anchorLabel={anchorNode === null ? null : formatEntityDisplay(anchorNode, ctx).primary}
        nodes={searchNodes}
        extras={searchExtras}
        ctx={ctx}
        onNodeClick={(nodeId) => {
          useNodeAsAnchor(nodeId);
        }}
      />
      {result !== null ? (
        // Thin filter strip — only renders when there's a loaded
        // result so empty states don't carry an unusable control.
        <div className="cx-filterbar" data-testid="connections-filterbar">
          <span className="cx-filterbar-label mono">Window</span>
          <TimeRangePicker
            value={timeRange}
            onChange={setTimeRange}
            hiddenNodeCount={hiddenByTime}
          />
        </div>
      ) : null}
      {timeline !== null ? <TimelineRail data={timeline} ctx={ctx} /> : null}
      <div className="cx-cols">
        <aside className="cx-col-l">
          <div className="cx-section">
            <h4>Find</h4>
            <NodeSearchBox
              nodes={searchNodes}
              extras={searchExtras}
              ctx={ctx}
              onPick={(id) => {
                navigateToAnchor(id);
              }}
              onQueryChange={setSearchQuery}
              onPrime={fullSnapshot.prime}
              loading={fullSnapshot.loading}
              recallHits={recallResults.items.map((item) => ({
                threadId: item.threadId,
                ...(item.title === undefined ? {} : { title: item.title }),
                ...(item.threadUrl === undefined ? {} : { threadUrl: item.threadUrl }),
                ...(item.snippet === undefined ? {} : { snippet: item.snippet }),
                score: item.score,
              }))}
              recallLoading={recallResults.loading}
              recallError={recallResults.error}
            />
          </div>
          <div className="cx-section">
            <h4>Workstream</h4>
            <label className="cx-select">
              <span className="cx-select-label">Show connections around</span>
              <select
                value={selectedWorkstreamAnchor}
                onChange={(event) => {
                  if (event.currentTarget.value.length > 0)
                    navigateToAnchor(event.currentTarget.value);
                }}
                aria-label="Connections workstream"
                data-testid="connections-workstream-select"
                disabled={workstreamOptions.length === 0}
              >
                <option value="">
                  {workstreamOptions.length === 0 ? 'No workstreams in view' : 'Choose workstream'}
                </option>
                {workstreamOptions.map((workstream) => (
                  <option key={workstream.id} value={workstream.id}>
                    {workstream.label}
                    {workstream.meta === undefined ? '' : ` · ${workstream.meta}`}
                  </option>
                ))}
              </select>
            </label>
            <details
              className="cx-advanced-anchor"
              data-testid="connections-advanced-anchor"
              // Always open by default. The earlier behavior auto-
              // opened only for non-workstream anchors and leaked a
              // raw `visit-instance:tses_*:<iso>:<URL>` id into the
              // input via `value={initialAnchor}`. That root cause
              // is gone now (draftAnchor defaults to '' and the
              // placeholder is the friendly "Paste a node id"), so
              // keeping the section open is safe and matches what
              // every e2e spec + power-user workflow expects:
              // a directly-clickable anchor input is always present.
              open
            >
              <summary data-testid="connections-advanced-anchor-summary">
                Advanced node anchor
              </summary>
              <label className="cx-input">
                <span aria-hidden className="cx-input-icon">
                  {SearchIcon}
                </span>
                <input
                  type="text"
                  placeholder="Paste a node id"
                  value={draftAnchor}
                  onChange={(e) => {
                    setDraftAnchor(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitAdvancedAnchor();
                  }}
                  onBlur={() => {
                    submitAdvancedAnchor();
                  }}
                  aria-label="Connections anchor"
                  data-testid="connections-anchor-input"
                />
              </label>
            </details>
          </div>
          {recentAnchors.length > 0 ? (
            <div className="cx-section" data-testid="connections-recent-anchors">
              <h4>Recent anchors</h4>
              <div className="cx-recent-anchor-list">
                {recentAnchors.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="cx-recent-anchor"
                    onClick={() => {
                      navigateToAnchor(r.id);
                    }}
                    data-testid={`recent-anchor-${r.id}`}
                  >
                    <span
                      className={`cx-node-icon ${nodeKindDisplayFor(r.kind).tintClass}`}
                      aria-hidden
                    >
                      {KindIcons[r.kind]}
                    </span>
                    <span className="cx-recent-anchor-label">{r.label}</span>
                    <span className="cx-recent-meta">{nodeKindDisplayFor(r.kind).label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="cx-section">
            <h4>Hops</h4>
            <label className="cx-hops-range">
              <span>Range</span>
              <select
                value={hops}
                onChange={(e) => {
                  setHops(Number.parseInt(e.target.value, 10) || 1);
                }}
                data-testid="connections-hops-select"
              >
                {[1, 2, 3, 4].map((h) => (
                  <option key={h} value={h}>
                    {h}-hop
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="cx-section cx-section-last">
            <h4>Edge family</h4>
            <FamilyLegend />
          </div>
        </aside>
        <main className="cx-col-c">
          {loading && result === null ? (
            <div className="cx-loading-row" data-testid="connections-loading">
              <span className="cx-spinner-dot" aria-hidden />
              <span className="cx-mono cx-dim">
                Fetching neighbors of <code>{anchor}</code>…
              </span>
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
              <LinkedCenter
                result={result}
                anchorId={anchor}
                selectedEdge={selectedEdge}
                onSelectEdge={selectEdge}
                onUseNodeAsAnchor={useNodeAsAnchor}
                onPromoteSnippet={submitSnippetPromotion}
                ctx={ctx}
                {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
              />
            ) : subMode === 'orbital' ? (
              <OrbitalCenter
                result={result}
                anchorId={anchor}
                hops={hops}
                selectedEdge={selectedEdge}
                onSelectEdge={selectEdge}
                onUseNodeAsAnchor={useNodeAsAnchor}
                ctx={ctx}
              />
            ) : subMode === 'flow' ? (
              (() => {
                const flowNodes =
                  flowSubgraph.nodes.length > 0 ? flowSubgraph.nodes : result.snapshot.nodes;
                const flowEdges =
                  flowSubgraph.edges.length > 0 ? flowSubgraph.edges : result.snapshot.edges;
                const flowVisits = deriveFlowVisits(flowNodes, ctx, anchor);
                const crossReplica = deriveCrossReplicaEdges(flowEdges);
                return (
                  <FlowPathView
                    visits={flowVisits}
                    navigationEdges={deriveNavigationEdges(flowEdges)}
                    crossReplicaEdges={crossReplica}
                    replicaAlias={ctx.replicaAlias}
                    tabSessions={deriveTabSessions(flowNodes, ctx)}
                    tabOpenerByDest={deriveTabOpenerMap(flowEdges)}
                    summary={deriveFlowSummary(flowVisits, crossReplica, ctx.replicaAlias)}
                    onNodeClick={(visitId) => {
                      setSelectedEdge(null);
                      setWhyVisitId(visitId);
                    }}
                  />
                );
              })()
            ) : subMode === 'focus' ? (
              <FocusView
                topics={focusData.topics}
                visitsByTopic={focusData.visitsByTopic}
                engagementClassesByVisit={focusData.engagementClassesByVisit}
                onTopicRename={submitTopicRename}
                onEngagementRelabel={submitEngagementRelabel}
                onTopicClick={(topicId) => {
                  // Same rationale as useNodeAsAnchor — don't dump
                  // the raw topic id into the advanced anchor input.
                  history.navigate(topicId);
                }}
                onVisitClick={(visitId) => {
                  setWhyVisitId(visitId);
                }}
              />
            ) : (
              <ContextPackComposer
                workstreamId={contextWorkstreamId}
                onClose={() => {
                  setSubMode('linked');
                }}
              />
            )
          ) : (
            !loading &&
            error === null && (
              <div className="cx-empty" data-testid="connections-pick-anchor">
                <h4>Pick an anchor to begin</h4>
                <p>
                  Choose a workstream on the left, click a recent anchor, or paste a node id —
                  the graph around it appears here. Press <kbd>Alt</kbd>+<kbd>←</kbd> /{' '}
                  <kbd>Alt</kbd>+<kbd>→</kbd> to navigate anchor history.
                </p>
                {recentAnchors.length > 0 ? (
                  <div className="cx-empty-quickpick">
                    <span className="cx-mono cx-dim">Try one:</span>
                    {recentAnchors.slice(0, 4).map((r) => (
                      <button
                        type="button"
                        key={r.id}
                        className="cx-empty-quickpick-btn"
                        onClick={() => {
                          navigateToAnchor(r.id);
                        }}
                        data-testid={`connections-empty-quickpick-${r.id}`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          )}
        </main>
        <aside className="cx-col-r">
          <div className="cx-section cx-section-last cx-section-padded">
            {whyVisitId !== null && result !== null ? (
              <WhyRelatedPanel
                fromVisitId={whyVisitId}
                reasons={reasonsForVisit(result.snapshot.nodes, result.snapshot.edges, whyVisitId, ctx)}
                showOnlyUserAsserted={whyAssertedOnly}
                feedback={
                  whyFeedbackEdge === null
                    ? undefined
                    : {
                        label: 'relation',
                        onFeedback: (choice) => submitFlowFeedback(whyFeedbackEdge, choice),
                      }
                }
                producedBy={whyRevisionEdge?.producedBy}
                producerLabel={whyRevisionEdge?.kind}
                onToggleAssertedOnly={() => {
                  setWhyAssertedOnly((value) => !value);
                }}
                onClose={() => {
                  setWhyVisitId(null);
                }}
              />
            ) : edgeDetail !== null ? (
              <ProvenanceCard
                edge={edgeDetail}
                allNodes={result?.snapshot.nodes ?? []}
                onFlowFeedback={(edge, choice) => submitFlowFeedback(edge, choice)}
                onClose={() => {
                  setSelectedEdge(null);
                }}
                ctx={ctx}
              />
            ) : (
              <ProvenanceEmpty anchor={anchorNode} ctx={ctx} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};
