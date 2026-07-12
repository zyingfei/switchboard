import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { ContextPackComposer } from './ContextPackComposer';
import {
  feedbackRelationKindForEdgeKind,
  postUserOrganizedItem,
  postUserEngagementRelabeled,
  postUserFlowConfirmed,
  postUserFlowRejected,
  postUserRejectedRelation,
  postUserSnippetPromoted,
  postUserTopicRenamed,
  type UserFlowRelationKind,
} from './client';
import {
  EDGE_KINDS,
  FAMILIES,
  NODE_KIND_GROUP_ORDER,
  nodeKindDisplayFor,
  type EdgeFamily,
} from './edgeKinds';
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
  isCollapsedSuggestionSet,
  type EngagementClass,
  type FocusCandidate,
  type FocusGroupSaveInput,
  type TopicNode,
  type TopicVisit,
  type TopicVisitAffiliation,
} from './FocusView';
import { HopToggle } from './HopToggle';
import { ClockIcon, KindIcons, SearchIcon } from './icons';
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
import { SearchTab } from './SearchTab';
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
import { PageTextPanel } from './PageTextPanel';
import {
  dejaVuFacetLabel,
  dejaVuFacetChipLabel,
} from '../../contentOverlays/dejaVuModel';
import { formatRelative } from '../../util/time';
import {
  messageTypes,
  type PageContentBulkOperationResponse,
  type PageContentOpenTabPreview,
  type PageContentOpenTabsPreviewResponse,
  type PageContentOperationResponse,
} from '../../messages';
import type { PageContentCoverage } from '../../companion/pageContentClient';
import {
  formatEntityDisplay,
  formatNodeIdDisplay,
  hostOf,
  isInternalIdLike,
  kindFromNodeId,
  type EntityDisplayCtx,
} from '../entityDisplay/format';
import type { FeedbackChoice } from '../feedback/FeedbackButtons';
import { WhyRelatedPanel } from './WhyRelatedPanel';
import type { Reason } from './why-related/reasons';

export type { FocusGroupSaveInput } from './FocusView';

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

export interface ConnectionsDejaVuItem {
  readonly id: string;
  readonly providerLabel: string;
  readonly providerKey: 'gpt' | 'claude' | 'gemini' | 'codex' | 'web';
  readonly title: string;
  readonly snippet: string;
  readonly relativeWhen: string;
  readonly score: number;
  // Optional v2 fields — drive chip filtering, similarity badge,
  // and Jump destination. Older payloads (pre-v2) parse without
  // these; rows just lose the badge / Jump target.
  readonly facet?: 'page' | 'chat' | 'similar' | 'thread' | 'visited';
  readonly threadUrl?: string;
  readonly canonicalUrl?: string;
  readonly similarity?: number;
  readonly anchorNodeId?: string;
  // P3 — per-source evidence for the Why? expander. Set when the v2
  // pipeline produced the candidate (server emits `evidence[]`).
  readonly evidence?: readonly {
    readonly retriever: string;
    readonly sourceKind: string;
    readonly rank?: number;
    readonly rawScore?: number;
    readonly vectorDistance?: number;
  }[];
}

// Derive a node kind from an anchor id prefix so history entries get
// the right icon/tint without a snapshot round-trip. Unknown shapes
// fall back to the page kind (still iconed).
const ANCHOR_KIND_BY_PREFIX: Partial<Record<string, ConnectionNodeKind>> = {
  topic: 'topic',
  workstream: 'workstream',
  thread: 'thread',
  'visit-instance': 'visit-instance',
  'timeline-visit': 'timeline-visit',
  page: 'page',
  'tab-session': 'tab-session',
  snippet: 'snippet',
  annotation: 'annotation',
  'coding-session': 'coding-session',
};
const anchorKindFromId = (id: string): ConnectionNodeKind => {
  const sep = id.indexOf(':');
  const prefix = sep >= 0 ? id.slice(0, sep) : id;
  return ANCHOR_KIND_BY_PREFIX[prefix] ?? 'timeline-visit';
};

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
  // Cross-surface "focus the search here" nonce: when this changes to
  // a new non-zero value the view switches to its own SearchTab. Lets
  // the global top-bar search button re-use the Connections search
  // instead of opening a second, separate search panel on this page.
  readonly requestSearch?: number;
  // Reshape for the v2 submode: items + originating selection text +
  // source URL. The submode renders an action bar (Google/Translate/
  // Ask AI) and a "from <host>" header pill that need both pieces of
  // context, so we can't reconstruct them from items alone.
  readonly requestDejaVuMode?: {
    readonly items: readonly ConnectionsDejaVuItem[];
    readonly selectionText: string;
    readonly sourceUrl: string;
  };
  readonly onRequestConsumed?: () => void;
  // Cross-surface jump from Connections back to the Inbox. Fired
  // when the user clicks "Find in Inbox" on a URL-bearing anchor.
  // Receives the canonical URL; the parent decides whether to
  // switch viewMode + pre-fill the Inbox search.
  readonly onOpenInInbox?: (canonicalUrl: string) => void;
  readonly onSaveFocusGroup?: (input: FocusGroupSaveInput) => Promise<void> | void;
  // The browser tab the user is looking at right now, plumbed from
  // App.tsx (state.currentTab). When present, the SearchTab header
  // offers a one-click "Anchor to current tab" affordance that pivots
  // the graph onto this URL without retyping the title.
  readonly currentTabUrl?: string;
};

const DEFAULT_DISPLAY_CTX: EntityDisplayCtx = {
  resolveWorkstreamPath: () => null,
  replicaAlias: () => 'Browser',
};

type SubMode = 'linked' | 'orbital' | 'flow' | 'focus' | 'context' | 'search' | 'dejavu';

const FILTERED_SUBMODES = new Set<SubMode>(['linked', 'orbital', 'flow']);
const CONNECTIONS_NARROW_QUERY = '(max-width: 860px)';
const EMPTY_NODE_MAP: ReadonlyMap<string, ConnectionNode> = new Map();

const isNarrowConnectionsViewport = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(CONNECTIONS_NARROW_QUERY).matches;

const edgeFamilyForKind = (kind: string): EdgeFamily => {
  const meta = (EDGE_KINDS as Partial<Record<string, { readonly family: EdgeFamily }>>)[kind];
  return meta?.family ?? 'urlmatch';
};

const toggleSetValue = <T,>(current: ReadonlySet<T>, value: T): ReadonlySet<T> => {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
};

const filterSnapshotForConnectionModes = (
  result: ConnectionsScopedResult,
  anchorId: string,
  hiddenNodeKinds: ReadonlySet<ConnectionNodeKind>,
  hiddenEdgeFamilies: ReadonlySet<EdgeFamily>,
): ConnectionsScopedResult => {
  if (hiddenNodeKinds.size === 0 && hiddenEdgeFamilies.size === 0) return result;
  const nodeById = new Map(result.snapshot.nodes.map((node) => [node.id, node] as const));
  const allowedNode = (nodeId: string): boolean => {
    if (nodeId === anchorId) return true;
    const node = nodeById.get(nodeId);
    return node === undefined || !hiddenNodeKinds.has(node.kind);
  };
  const edges = result.snapshot.edges.filter(
    (edge) =>
      !hiddenEdgeFamilies.has(edgeFamilyForKind(edge.kind)) &&
      allowedNode(edge.fromNodeId) &&
      allowedNode(edge.toNodeId),
  );
  const includedNodeIds = new Set<string>([anchorId]);
  for (const edge of edges) {
    includedNodeIds.add(edge.fromNodeId);
    includedNodeIds.add(edge.toNodeId);
  }
  const nodes = result.snapshot.nodes.filter(
    (node) => includedNodeIds.has(node.id) && allowedNode(node.id),
  );
  return {
    ...result,
    snapshot: {
      ...result.snapshot,
      nodes,
      edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
  };
};

const filterGraphPartsForConnectionModes = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  anchorId: string,
  hiddenNodeKinds: ReadonlySet<ConnectionNodeKind>,
  hiddenEdgeFamilies: ReadonlySet<EdgeFamily>,
): { readonly nodes: readonly ConnectionNode[]; readonly edges: readonly ConnectionEdge[] } => {
  if (hiddenNodeKinds.size === 0 && hiddenEdgeFamilies.size === 0) return { nodes, edges };
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const allowedNode = (nodeId: string): boolean => {
    if (nodeId === anchorId) return true;
    const node = nodeById.get(nodeId);
    return node === undefined || !hiddenNodeKinds.has(node.kind);
  };
  const filteredEdges = edges.filter(
    (edge) =>
      !hiddenEdgeFamilies.has(edgeFamilyForKind(edge.kind)) &&
      allowedNode(edge.fromNodeId) &&
      allowedNode(edge.toNodeId),
  );
  const includedNodeIds = new Set<string>([anchorId]);
  for (const edge of filteredEdges) {
    includedNodeIds.add(edge.fromNodeId);
    includedNodeIds.add(edge.toNodeId);
  }
  const filteredNodes = nodes.filter(
    (node) => includedNodeIds.has(node.id) && allowedNode(node.id),
  );
  return { nodes: filteredNodes, edges: filteredEdges };
};

const normalizeWorkstreamAnchorId = (id: string): string =>
  id.startsWith('workstream:') ? id : `workstream:${id}`;

const DEFAULT_TOPIC_ENGAGEMENT_GATE_MS = 5_000;

const trimTrailingUrlSlash = (value: string): string =>
  value.length > 0 ? value.replace(/\/+$/u, '') : value;

const pageContentCanonicalUrl = (raw: string): string => {
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/u, '');
  } catch {
    return raw;
  }
};

const urlFromAnchorNodeId = (nodeId: string): string | undefined => {
  if (nodeId.startsWith('timeline-visit:')) {
    const url = nodeId.slice('timeline-visit:'.length);
    return url.length > 0 ? url : undefined;
  }
  if (nodeId.startsWith('visit-instance:')) {
    const tail = nodeId.slice('visit-instance:'.length);
    const httpIdx = tail.indexOf(':http');
    if (httpIdx >= 0) {
      const url = tail.slice(httpIdx + 1);
      return url.length > 0 ? url : undefined;
    }
  }
  return undefined;
};

const humanAnchorLabel = (label: string | undefined): string | undefined => {
  const trimmed = label?.trim();
  if (trimmed === undefined || trimmed.length === 0 || isInternalIdLike(trimmed)) {
    return undefined;
  }
  return trimmed;
};

const applyAnchorLabel = (node: ConnectionNode, label: string | undefined): ConnectionNode => {
  const clean = humanAnchorLabel(label);
  if (clean === undefined) return node;
  return {
    ...node,
    label: clean,
    metadata:
      node.kind === 'topic'
        ? {
            ...node.metadata,
            representativeTitles: [clean],
          }
        : node.metadata,
  };
};

const displayOnlyAnchorNode = (nodeId: string, label?: string): ConnectionNode | null => {
  const kind = kindFromNodeId(nodeId);
  if (kind === undefined) return null;
  const url = urlFromAnchorNodeId(nodeId);
  const cleanLabel = humanAnchorLabel(label);
  return {
    id: nodeId,
    kind,
    label: cleanLabel ?? (url === undefined ? nodeId : (hostOf(url) ?? nodeId)),
    originReplicaIds: [],
    metadata: {
      ...(url === undefined
        ? {}
        : {
            canonicalUrl: url,
            url,
          }),
      ...(kind === 'topic' && cleanLabel !== undefined
        ? { representativeTitles: [cleanLabel] }
        : {}),
    },
  };
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

const metadataStringList = (
  metadata: Record<string, unknown>,
  key: string,
): readonly string[] | undefined => {
  const value = metadata[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length === 0 ? undefined : strings;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pageContentCoverageFromNode = (node: ConnectionNode | null): PageContentCoverage | null => {
  if (node === null) return null;
  const raw = node.metadata['pageContent'];
  if (!isRecord(raw)) return null;
  const canonicalUrl = metadataString(node.metadata, ['canonicalUrl', 'url']);
  const state = raw['state'];
  if (canonicalUrl === undefined || typeof state !== 'string') return null;
  return {
    canonicalUrl,
    state: state as PageContentCoverage['state'],
    ...(typeof raw['quality'] === 'string'
      ? { quality: raw['quality'] as PageContentCoverage['quality'] }
      : {}),
    ...(typeof raw['lastIndexedAt'] === 'string' ? { lastIndexedAt: raw['lastIndexedAt'] } : {}),
    ...(typeof raw['extractionSource'] === 'string'
      ? { extractionSource: raw['extractionSource'] as PageContentCoverage['extractionSource'] }
      : {}),
    ...(typeof raw['chunkCount'] === 'number' ? { chunkCount: raw['chunkCount'] } : {}),
    ...(typeof raw['indexedCharCount'] === 'number'
      ? { indexedCharCount: raw['indexedCharCount'] }
      : {}),
    ...(typeof raw['error'] === 'string' ? { error: raw['error'] } : {}),
  };
};

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

const focusedWindowMsForNode = (node: ConnectionNode): number => {
  const engagement = node.metadata['engagement'];
  if (isRecord(engagement)) {
    const value = engagement['focusedWindowMs'];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return metadataNumber(node.metadata, 'focusedWindowMs', 0);
};

const topicVisitAffiliationForEdge = (edge: ConnectionEdge): TopicVisitAffiliation =>
  edge.metadata?.['affiliation'] === 'secondary' ? 'secondary' : 'primary';

const isSecondaryTopicEdge = (edge: ConnectionEdge): boolean =>
  edge.kind === 'visit_in_topic' && topicVisitAffiliationForEdge(edge) === 'secondary';

const topicVisitFromEdge = (
  edge: ConnectionEdge,
  visit: ConnectionNode,
  ctx: EntityDisplayCtx,
): TopicVisit => {
  const affiliation = topicVisitAffiliationForEdge(edge);
  const metadata = edge.metadata ?? {};
  const secondaryScore = metadataNumber(metadata, 'score', Number.NaN);
  const visitUrl =
    metadataString(visit.metadata, ['canonicalUrl', 'url', 'latestUrl']) ?? urlFromNodeId(visit);
  const pageContent = isRecord(visit.metadata['pageContent'])
    ? visit.metadata['pageContent']
    : undefined;
  const pageContentState =
    pageContent !== undefined && typeof pageContent['state'] === 'string'
      ? pageContent['state']
      : undefined;
  const pageContentQuality =
    pageContent !== undefined && typeof pageContent['quality'] === 'string'
      ? pageContent['quality']
      : undefined;
  const pageEvidence = isRecord(visit.metadata['pageEvidence'])
    ? visit.metadata['pageEvidence']
    : undefined;
  const pageEvidenceTier =
    pageEvidence !== undefined && typeof pageEvidence['tier'] === 'string'
      ? pageEvidence['tier']
      : undefined;
  const pageEvidenceTermCount =
    pageEvidence !== undefined && typeof pageEvidence['termCount'] === 'number'
      ? pageEvidence['termCount']
      : undefined;
  return {
    id: visit.id,
    label: formatEntityDisplay(visit, ctx).primary,
    ...(visitUrl === undefined ? {} : { url: visitUrl }),
    ...(visit.lastSeenAt === undefined ? {} : { lastSeenAt: visit.lastSeenAt }),
    focusedWindowMs: focusedWindowMsForNode(visit),
    affiliation,
    ...(affiliation === 'secondary' && Number.isFinite(secondaryScore) ? { secondaryScore } : {}),
    ...(affiliation === 'secondary'
      ? { secondaryReasons: metadataStringList(metadata, 'reasons') ?? [] }
      : {}),
    ...(pageContentState === undefined ? {} : { pageContentState }),
    ...(pageContentQuality === undefined ? {} : { pageContentQuality }),
    ...(pageEvidenceTier === undefined ? {} : { pageEvidenceTier }),
    ...(pageEvidenceTermCount === undefined ? {} : { pageEvidenceTermCount }),
  };
};

const isBetterTopicVisit = (candidate: TopicVisit, existing: TopicVisit): boolean => {
  if (candidate.affiliation !== existing.affiliation) {
    return candidate.affiliation !== 'secondary';
  }
  if (candidate.affiliation === 'secondary') {
    const candidateScore = candidate.secondaryScore ?? 0;
    const existingScore = existing.secondaryScore ?? 0;
    if (candidateScore !== existingScore) return candidateScore > existingScore;
  }
  if (candidate.focusedWindowMs !== existing.focusedWindowMs) {
    return candidate.focusedWindowMs > existing.focusedWindowMs;
  }
  return candidate.id < existing.id;
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
      metadataString(node.metadata, ['canonicalUrl', 'url', 'latestUrl']) ?? urlFromNodeId(node);
    const host = hostOf(canonicalUrl);
    // Prefer the nested engagement.focusedWindowMs (companion writes it
    // alongside engagement.class); fall back to a flat key for
    // backward compatibility with older snapshots.
    const focusedWindowMs = focusedWindowMsForNode(node);
    const provider = metadataString(node.metadata, ['provider']);
    const visitCount = metadataNumber(node.metadata, 'visitCount', 0);
    const searchQuery = metadataString(node.metadata, ['searchQuery']);
    const isAnchor =
      node.id === anchorId || (anchorUrl !== undefined && canonicalUrl === anchorUrl);
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
    const lastActivityAt = metadataString(node.metadata, ['lastActivityAt']) ?? node.lastSeenAt;
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
const deriveTabOpenerMap = (edges: readonly ConnectionEdge[]): ReadonlyMap<string, string> => {
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
  readonly previousTopicCount: number | undefined;
} => {
  // Topics come from the scope so we render only the topics
  // reachable from the anchor — pulling every topic across the
  // whole vault would drown the panel.
  const topics: TopicNode[] = scopeNodes
    .filter((node) => node.kind === 'topic')
    .map((node) => {
      const memberCount = metadataNumber(node.metadata, 'memberCount', 0);
      const totalMemberCount = Math.max(
        metadataNumber(node.metadata, 'globalMemberCount', 0),
        metadataNumber(node.metadata, 'totalMemberCount', 0),
      );
      return {
        id: node.id,
        label: formatEntityDisplay(node, ctx).primary,
        suggestedLabels: metadataStringList(node.metadata, 'representativeTitles') ?? [],
        memberCount,
        ...(totalMemberCount > memberCount ? { totalMemberCount } : {}),
        ...(metadataNumber(node.metadata, 'secondaryCount', 0) > 0
          ? { secondaryCount: metadataNumber(node.metadata, 'secondaryCount', 0) }
          : {}),
        cohesion: metadataNumber(node.metadata, 'cohesion', 0),
        ...(metadataString(node.metadata, ['dominantWorkstreamId']) === undefined
          ? {}
          : { dominantWorkstreamId: metadataString(node.metadata, ['dominantWorkstreamId']) }),
      };
    });

  // Build visitsByTopic from full-snapshot edges so the member
  // list matches `memberCount`. Falls back to scope edges when
  // the full snapshot isn't loaded yet (degrades to old behavior,
  // just with a count mismatch the user might notice).
  const hasFull = fullNodes.length > 0 && fullEdges.length > 0;
  const sourceNodes = hasFull ? fullNodes : scopeNodes;
  const sourceEdges = hasFull ? fullEdges : scopeEdges;
  const nodeById = new Map(sourceNodes.map((node) => [node.id, node] as const));
  const previousTopicIds = new Set<string>();
  for (const edge of sourceEdges) {
    if (edge.kind === 'topic.lineage') previousTopicIds.add(edge.fromNodeId);
  }

  const visitsByTopicMap = new Map<string, Map<string, TopicVisit>>();
  for (const edge of sourceEdges) {
    if (edge.kind === 'topic.lineage') previousTopicIds.add(edge.fromNodeId);
    if (edge.kind !== 'visit_in_topic') continue;
    const visit = nodeById.get(edge.fromNodeId);
    if (visit === undefined) continue;
    const candidate = topicVisitFromEdge(edge, visit, ctx);
    const topicVisits = visitsByTopicMap.get(edge.toNodeId) ?? new Map<string, TopicVisit>();
    const existing = topicVisits.get(visit.id);
    if (existing === undefined || isBetterTopicVisit(candidate, existing)) {
      topicVisits.set(visit.id, candidate);
    }
    visitsByTopicMap.set(edge.toNodeId, topicVisits);
  }
  const visitsByTopic: Record<string, TopicVisit[]> = {};
  for (const [topicId, topicVisits] of visitsByTopicMap) {
    visitsByTopic[topicId] = [...topicVisits.values()];
  }

  // Engagement classes come from the same node pool as rendered
  // visits so topic anchors can show the current observed judgment
  // even when the anchor-local active graph is empty.
  const engagementClassesByVisit: Record<string, EngagementClass> = {};
  for (const node of sourceNodes) {
    const engagementClass = engagementClassForNode(node);
    if (node.kind === 'timeline-visit' && engagementClass !== undefined) {
      engagementClassesByVisit[node.id] = engagementClass;
    }
  }
  return {
    topics,
    visitsByTopic,
    engagementClassesByVisit,
    previousTopicCount: previousTopicIds.size === 0 ? undefined : previousTopicIds.size,
  };
};

type FocusData = ReturnType<typeof deriveFocusData>;

const emptyFocusData = (): FocusData => ({
  topics: [],
  visitsByTopic: {},
  engagementClassesByVisit: {},
  previousTopicCount: undefined,
});

const WORKSTREAM_FOCUS_EDGE_KINDS = new Set<string>([
  'thread_in_workstream',
  'visit_in_workstream',
  'visit_instance_in_workstream',
]);

const workstreamIdsMatch = (candidate: string | undefined, workstreamAnchorId: string): boolean => {
  if (candidate === undefined) return false;
  const normalized = normalizeWorkstreamAnchorId(candidate);
  return normalized === workstreamAnchorId;
};

const addVisitAliasesForNode = (node: ConnectionNode | undefined, out: Set<string>): void => {
  if (node === undefined) return;
  if (node.kind === 'timeline-visit' || node.kind === 'visit-instance' || node.kind === 'thread') {
    out.add(node.id);
    out.add(trimTrailingUrlSlash(node.id));
  }
  const timelineVisitId = metadataString(node.metadata, ['timelineVisitId']);
  if (timelineVisitId !== undefined) {
    out.add(timelineVisitId);
    out.add(trimTrailingUrlSlash(timelineVisitId));
  }
  const canonicalUrl =
    metadataString(node.metadata, ['canonicalUrl', 'url', 'latestUrl']) ?? urlFromNodeId(node);
  if (canonicalUrl !== undefined) {
    const timelineVisitId = `timeline-visit:${canonicalUrl}`;
    out.add(timelineVisitId);
    out.add(trimTrailingUrlSlash(timelineVisitId));
  }
};

const addVisitAliasesForAnchorId = (anchorId: string, out: Set<string>): void => {
  if (anchorId.startsWith('timeline-visit:')) {
    out.add(anchorId);
    out.add(trimTrailingUrlSlash(anchorId));
    return;
  }
  if (anchorId.startsWith('visit-instance:')) {
    out.add(anchorId);
    out.add(trimTrailingUrlSlash(anchorId));
    const canonicalUrl = urlFromAnchorNodeId(anchorId);
    if (canonicalUrl !== undefined) {
      const timelineVisitId = `timeline-visit:${canonicalUrl}`;
      out.add(timelineVisitId);
      out.add(trimTrailingUrlSlash(timelineVisitId));
    }
  }
};

const addWorkstreamScopedVisitAliases = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  workstreamAnchorId: string,
  out: Set<string>,
): void => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  for (const node of nodes) {
    if (workstreamIdsMatch(metadataString(node.metadata, ['workstreamId']), workstreamAnchorId)) {
      addVisitAliasesForNode(node, out);
    }
  }
  for (const edge of edges) {
    if (!WORKSTREAM_FOCUS_EDGE_KINDS.has(edge.kind)) continue;
    if (edge.toNodeId === workstreamAnchorId) {
      addVisitAliasesForNode(nodeById.get(edge.fromNodeId), out);
    } else if (edge.fromNodeId === workstreamAnchorId) {
      addVisitAliasesForNode(nodeById.get(edge.toNodeId), out);
    }
  }
};

const addAnchorScopedVisitAliases = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  anchorId: string,
  out: Set<string>,
): void => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const anchorNode = nodeById.get(anchorId);
  if (anchorNode === undefined) {
    addVisitAliasesForAnchorId(anchorId, out);
  } else {
    addVisitAliasesForNode(anchorNode, out);
  }

  for (const edge of edges) {
    if (edge.kind !== 'timeline_same_url_as_thread') continue;
    if (edge.fromNodeId === anchorId) {
      addVisitAliasesForNode(nodeById.get(edge.toNodeId), out);
    } else if (edge.toNodeId === anchorId) {
      addVisitAliasesForNode(nodeById.get(edge.fromNodeId), out);
    }
  }
};

const RELATED_FOCUS_EDGE_KINDS = new Set<string>([
  'closest_visit',
  'visit_resembles_visit',
  'visit_continues_visit',
]);

const RELATED_FOCUS_MEMBER_LIMIT = 12;

const relatedFocusScore = (edge: ConnectionEdge): number => {
  const score = metadataNumber(edge.metadata ?? {}, 'score', Number.NaN);
  if (Number.isFinite(score)) return score;
  if (edge.kind === 'closest_visit') return 0.8;
  if (edge.kind === 'visit_continues_visit') return 0.7;
  return 0.5;
};

const isVisitNode = (node: ConnectionNode | undefined): node is ConnectionNode =>
  node !== undefined && (node.kind === 'timeline-visit' || node.kind === 'visit-instance');

const deriveRelatedFocusData = (
  anchorId: string,
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  ctx: EntityDisplayCtx,
): FocusData => {
  const aliases = new Set<string>();
  addAnchorScopedVisitAliases(nodes, edges, anchorId, aliases);
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const byVisitId = new Map<string, { readonly node: ConnectionNode; readonly score: number }>();

  for (const alias of aliases) {
    const anchorNode = nodeById.get(alias);
    if (isVisitNode(anchorNode)) byVisitId.set(anchorNode.id, { node: anchorNode, score: 1 });
  }

  for (const edge of edges) {
    if (!RELATED_FOCUS_EDGE_KINDS.has(edge.kind)) continue;
    const fromIsAnchor = aliases.has(edge.fromNodeId);
    const toIsAnchor = aliases.has(edge.toNodeId);
    if (!fromIsAnchor && !toIsAnchor) continue;
    const relatedNode = nodeById.get(fromIsAnchor ? edge.toNodeId : edge.fromNodeId);
    if (!isVisitNode(relatedNode)) continue;
    const score = relatedFocusScore(edge);
    const existing = byVisitId.get(relatedNode.id);
    if (existing === undefined || score > existing.score) {
      byVisitId.set(relatedNode.id, { node: relatedNode, score });
    }
  }

  const topicId = `topic:related:${anchorId}`;
  const visits = [...byVisitId.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        focusedWindowMsForNode(right.node) - focusedWindowMsForNode(left.node) ||
        left.node.id.localeCompare(right.node.id),
    )
    .slice(0, RELATED_FOCUS_MEMBER_LIMIT)
    .map((entry) =>
      topicVisitFromEdge(
        {
          id: `related-focus:${anchorId}:${entry.node.id}`,
          kind: 'visit_in_topic',
          fromNodeId: entry.node.id,
          toNodeId: topicId,
          observedAt: entry.node.lastSeenAt ?? new Date(0).toISOString(),
          producedBy: { source: 'topic-clusterer', revisionId: 'related-neighborhood' },
          confidence: 'inferred',
          metadata: entry.score < 1 ? { affiliation: 'secondary', score: entry.score } : {},
        },
        entry.node,
        ctx,
      ),
    );
  if (visits.length < 2) return emptyFocusData();

  const anchorLabel =
    visits.find((visit) => aliases.has(visit.id))?.label ?? visits[0]?.label ?? 'this page';
  const finiteScores = [...byVisitId.values()]
    .map((entry) => entry.score)
    .filter((score) => Number.isFinite(score) && score < 1);
  const cohesion =
    finiteScores.length === 0
      ? 0
      : finiteScores.reduce((sum, score) => sum + score, 0) / finiteScores.length;
  const engagementClassesByVisit: Record<string, EngagementClass> = {};
  for (const node of nodes) {
    const engagementClass = engagementClassForNode(node);
    if (isVisitNode(node) && engagementClass !== undefined) {
      engagementClassesByVisit[node.id] = engagementClass;
    }
  }
  return {
    topics: [
      {
        id: topicId,
        label: `Related pages around ${anchorLabel}`,
        suggestedLabels: visits.map((visit) => visit.label),
        source: 'related-neighborhood',
        memberCount: visits.length,
        cohesion,
      },
    ],
    visitsByTopic: { [topicId]: visits },
    engagementClassesByVisit,
    previousTopicCount: undefined,
  };
};

const focusCandidateReasonForEdge = (edge: ConnectionEdge): string => {
  if (edge.kind === 'closest_visit') {
    const score = metadataNumber(edge.metadata ?? {}, 'score', Number.NaN);
    return Number.isFinite(score) ? `Closest visit ${score.toFixed(2)}` : 'Closest visit';
  }
  if (edge.kind === 'visit_resembles_visit') {
    const metadata = edge.metadata ?? {};
    const matchedTerms = metadataStringList(metadata, 'matchedTerms') ?? [];
    if (matchedTerms.length > 0) return `Similar content: ${matchedTerms.slice(0, 3).join(', ')}`;
    const score = metadataNumber(metadata, 'score', metadataNumber(metadata, 'cosine', Number.NaN));
    return Number.isFinite(score) ? `Similar content ${score.toFixed(2)}` : 'Similar content';
  }
  if (edge.kind === 'visit_continues_visit') return 'Visited in sequence';
  if (edge.kind === 'timeline_same_url_as_thread') return 'Same canonical URL';
  if (edge.kind === 'snippet_copied_from_visit') return 'Copied snippet lineage';
  if (edge.kind.startsWith('snippet_pasted_into_')) return 'Pasted snippet lineage';
  return edge.kind;
};

const focusCandidateFromNode = (
  node: ConnectionNode,
  ctx: EntityDisplayCtx,
  input: {
    readonly source: FocusCandidate['source'];
    readonly reasons: readonly string[];
    readonly score?: number;
  },
): FocusCandidate | null => {
  const canonicalUrl =
    metadataString(node.metadata, ['canonicalUrl', 'url', 'latestUrl']) ?? urlFromNodeId(node);
  if (canonicalUrl === undefined) return null;
  const pageEvidence = isRecord(node.metadata['pageEvidence']) ? node.metadata['pageEvidence'] : {};
  const pageEvidenceTier =
    typeof pageEvidence['tier'] === 'string' ? pageEvidence['tier'] : undefined;
  return {
    id: node.id,
    label: formatEntityDisplay(node, ctx).primary,
    url: canonicalUrl,
    canonicalUrl,
    source: input.source,
    reasons: input.reasons,
    ...(input.score === undefined ? {} : { score: input.score }),
    ...(pageEvidenceTier === undefined ? {} : { pageEvidenceTier }),
  };
};

const deriveFocusSuggestedCandidates = (
  focusData: FocusData,
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  ctx: EntityDisplayCtx,
): Record<string, readonly FocusCandidate[]> => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const byTopic: Record<string, FocusCandidate[]> = {};
  for (const topic of focusData.topics) {
    const currentIds = new Set((focusData.visitsByTopic[topic.id] ?? []).map((visit) => visit.id));
    const candidates = new Map<
      string,
      { readonly node: ConnectionNode; readonly score: number; readonly reasons: readonly string[] }
    >();
    for (const edge of edges) {
      if (
        !RELATED_FOCUS_EDGE_KINDS.has(edge.kind) &&
        edge.kind !== 'timeline_same_url_as_thread' &&
        edge.kind !== 'snippet_copied_from_visit' &&
        !edge.kind.startsWith('snippet_pasted_into_')
      ) {
        continue;
      }
      const fromIsMember = currentIds.has(edge.fromNodeId);
      const toIsMember = currentIds.has(edge.toNodeId);
      if (!fromIsMember && !toIsMember) continue;
      const candidateId = fromIsMember ? edge.toNodeId : edge.fromNodeId;
      if (currentIds.has(candidateId)) continue;
      const node = nodeById.get(candidateId);
      if (!isVisitNode(node)) continue;
      const score = relatedFocusScore(edge);
      const reason = focusCandidateReasonForEdge(edge);
      const existing = candidates.get(node.id);
      if (existing === undefined) {
        candidates.set(node.id, { node, score, reasons: [reason] });
      } else {
        candidates.set(node.id, {
          node,
          score: Math.max(existing.score, score),
          reasons: [...new Set([...existing.reasons, reason])],
        });
      }
    }
    byTopic[topic.id] = [...candidates.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          focusedWindowMsForNode(right.node) - focusedWindowMsForNode(left.node) ||
          left.node.id.localeCompare(right.node.id),
      )
      .slice(0, RELATED_FOCUS_MEMBER_LIMIT)
      .map((candidate) =>
        focusCandidateFromNode(candidate.node, ctx, {
          source: 'suggested',
          reasons: candidate.reasons,
          score: candidate.score,
        }),
      )
      .filter((candidate): candidate is FocusCandidate => candidate !== null);
  }
  return byTopic;
};

const deriveRecentFocusCandidates = (
  nodes: readonly ConnectionNode[],
  ctx: EntityDisplayCtx,
): readonly FocusCandidate[] =>
  nodes
    .filter(isVisitNode)
    .sort((left, right) => {
      const leftTime = left.lastSeenAt === undefined ? 0 : Date.parse(left.lastSeenAt);
      const rightTime = right.lastSeenAt === undefined ? 0 : Date.parse(right.lastSeenAt);
      return rightTime - leftTime || focusedWindowMsForNode(right) - focusedWindowMsForNode(left);
    })
    .slice(0, 24)
    .map((node) =>
      focusCandidateFromNode(node, ctx, {
        source: 'recent',
        reasons: ['Recently viewed'],
      }),
    )
    .filter((candidate): candidate is FocusCandidate => candidate !== null);

const maxFocusedWindowMsForAnchor = (
  anchorId: string,
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
): number | undefined => {
  const aliases = new Set<string>();
  addAnchorScopedVisitAliases(nodes, edges, anchorId, aliases);
  let max: number | undefined;
  for (const node of nodes) {
    if (node.kind !== 'timeline-visit' && node.kind !== 'visit-instance') continue;
    if (!aliases.has(node.id)) continue;
    const focusedWindowMs = focusedWindowMsForNode(node);
    max = max === undefined ? focusedWindowMs : Math.max(max, focusedWindowMs);
  }
  return max;
};

const focusEmptyDetailForAnchor = (
  anchorId: string,
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
): string => {
  const focusedWindowMs = maxFocusedWindowMsForAnchor(anchorId, nodes, edges);
  if (focusedWindowMs !== undefined && focusedWindowMs < DEFAULT_TOPIC_ENGAGEMENT_GATE_MS) {
    return `Latest captured focus for this page is ${String(focusedWindowMs)} ms, below the ${String(DEFAULT_TOPIC_ENGAGEMENT_GATE_MS)} ms topic gate.`;
  }
  return 'The candidate marked this page as ungrouped for now.';
};

const deriveShadowFocusScope = (
  anchorId: string,
  activeScopeNodes: readonly ConnectionNode[],
  activeScopeEdges: readonly ConnectionEdge[],
  shadowNodes: readonly ConnectionNode[],
  shadowEdges: readonly ConnectionEdge[],
): { readonly nodes: readonly ConnectionNode[]; readonly edges: readonly ConnectionEdge[] } => {
  if (shadowNodes.length === 0) return { nodes: [], edges: [] };

  const scopedVisitIds = new Set<string>();
  const selectedTopicIds = new Set<string>();
  if (anchorId.startsWith('workstream:')) {
    addWorkstreamScopedVisitAliases(activeScopeNodes, activeScopeEdges, anchorId, scopedVisitIds);
    addWorkstreamScopedVisitAliases(shadowNodes, shadowEdges, anchorId, scopedVisitIds);
  } else if (anchorId.startsWith('topic:')) {
    selectedTopicIds.add(anchorId);
  } else {
    addAnchorScopedVisitAliases(activeScopeNodes, activeScopeEdges, anchorId, scopedVisitIds);
  }
  const anchorIsTopic = anchorId.startsWith('topic:');

  for (const edge of shadowEdges) {
    if (edge.kind === 'visit_in_topic' && scopedVisitIds.has(edge.fromNodeId)) {
      selectedTopicIds.add(edge.toNodeId);
    }
  }

  const visitTopicEdges = shadowEdges.filter(
    (edge) =>
      edge.kind === 'visit_in_topic' &&
      selectedTopicIds.has(edge.toNodeId) &&
      (!isSecondaryTopicEdge(edge) || anchorIsTopic || scopedVisitIds.has(edge.fromNodeId)),
  );
  const scopedTopicMemberCounts = new Map<string, number>();
  const scopedTopicSecondaryCounts = new Map<string, number>();
  const scopedNodeIds = new Set<string>();
  for (const edge of visitTopicEdges) {
    scopedNodeIds.add(edge.fromNodeId);
    scopedNodeIds.add(edge.toNodeId);
    if (topicVisitAffiliationForEdge(edge) === 'secondary') {
      scopedTopicSecondaryCounts.set(
        edge.toNodeId,
        (scopedTopicSecondaryCounts.get(edge.toNodeId) ?? 0) + 1,
      );
    } else {
      scopedTopicMemberCounts.set(
        edge.toNodeId,
        (scopedTopicMemberCounts.get(edge.toNodeId) ?? 0) + 1,
      );
    }
  }

  const fallbackNodeById = new Map(activeScopeNodes.map((node) => [node.id, node] as const));
  const nodes = shadowNodes
    .filter((node) => scopedNodeIds.has(node.id))
    .map((node) => {
      if (node.kind !== 'topic') return node;
      const scopedMemberCount = scopedTopicMemberCounts.get(node.id) ?? 0;
      const scopedSecondaryCount = scopedTopicSecondaryCounts.get(node.id) ?? 0;
      const globalMemberCount = metadataNumber(node.metadata, 'memberCount', scopedMemberCount);
      return {
        ...node,
        metadata: {
          ...node.metadata,
          globalMemberCount,
          memberCount: scopedMemberCount,
          ...(scopedSecondaryCount > 0 ? { secondaryCount: scopedSecondaryCount } : {}),
        },
      };
    });
  const includedNodeIds = new Set(nodes.map((node) => node.id));
  const fallbackNodes: ConnectionNode[] = [];
  for (const nodeId of scopedNodeIds) {
    if (includedNodeIds.has(nodeId)) continue;
    const fallback = fallbackNodeById.get(nodeId);
    if (fallback !== undefined) fallbackNodes.push(fallback);
  }

  return { nodes: [...nodes, ...fallbackNodes], edges: visitTopicEdges };
};

const eligibleVisitCountForFocusData = (focusData: FocusData): number =>
  focusData.topics.reduce((sum, topic) => sum + topic.memberCount, 0);

const reasonsForVisit = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  visitId: string,
  ctx: EntityDisplayCtx,
): readonly Reason[] => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const reasons: Reason[] = [];
  const visitNode = nodeById.get(visitId);
  const pageContent = isRecord(visitNode?.metadata['pageContent'])
    ? visitNode.metadata['pageContent']
    : undefined;
  if (pageContent !== undefined && typeof pageContent['state'] === 'string') {
    reasons.push({
      code: 'PAGE_CONTENT_COVERAGE',
      state: pageContent['state'],
      ...(typeof pageContent['quality'] === 'string' ? { quality: pageContent['quality'] } : {}),
    });
  }
  let similarityReason: {
    readonly code: 'COSINE_ABOVE_THRESHOLD';
    readonly cosine: number;
    readonly threshold: number;
  } | null = null;
  let similarityMatchCount = 0;
  for (const edge of edges) {
    if (edge.fromNodeId !== visitId && edge.toNodeId !== visitId) continue;
    if (edge.kind === 'timeline_same_url_as_thread') {
      const thread = nodeById.get(edge.fromNodeId === visitId ? edge.toNodeId : edge.fromNodeId);
      reasons.push({
        code: 'SAME_THREAD',
        threadId: thread?.id ?? 'thread:unknown',
        threadName:
          thread === undefined ? 'Unknown thread' : formatEntityDisplay(thread, ctx).primary,
      });
    } else if (edge.kind === 'visit_resembles_visit') {
      const cosine = metadataNumber(edge.metadata ?? {}, 'cosine', 0.85);
      const threshold = metadataNumber(edge.metadata ?? {}, 'threshold', 0.85);
      similarityMatchCount += 1;
      if (similarityReason === null || cosine > similarityReason.cosine) {
        similarityReason = { code: 'COSINE_ABOVE_THRESHOLD', cosine, threshold };
      }
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
      const fallback = visit === undefined ? '(visit)' : formatEntityDisplay(visit, ctx).primary;
      reasons.push({
        code: 'LEXICAL_OVERLAP',
        topTokens: query === undefined ? [fallback] : query.split(/\s+/u),
      });
    }
  }
  if (similarityReason !== null) {
    reasons.push(
      similarityMatchCount > 1
        ? { ...similarityReason, matchCount: similarityMatchCount }
        : similarityReason,
    );
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

type DejaVuFilterKey = 'all' | 'page' | 'chat' | 'similar' | 'thread' | 'visited';
const DEJAVU_FACET_KEYS: readonly Exclude<DejaVuFilterKey, 'all'>[] = [
  'page',
  'chat',
  'similar',
  'thread',
  'visited',
];

const hostOfUrl = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

const DejaVuFullView = ({
  items,
  context,
  filter,
  onFilterChange,
  onSearchPivot,
  onWebSearch,
  onTranslate,
  onAskAi,
  onJump,
  onInGraph,
  onInInbox,
}: {
  readonly items: readonly ConnectionsDejaVuItem[];
  readonly context: { readonly selectionText: string; readonly sourceUrl: string } | null;
  readonly filter: DejaVuFilterKey;
  readonly onFilterChange: (next: DejaVuFilterKey) => void;
  readonly onSearchPivot: (text: string) => void;
  readonly onWebSearch: (text: string) => void;
  readonly onTranslate: (text: string) => void;
  readonly onAskAi: (provider: 'chatgpt' | 'claude' | 'gemini', text: string) => void;
  readonly onJump?: (item: ConnectionsDejaVuItem) => void;
  // 1A — pivot to Connections Linked submode anchored on this card.
  // The submode is a staging surface; deep lateral exploration
  // (topics, neighbors, bridges, cross-card edges) all live in the
  // graph, not in the card. Hidden when no anchor is derivable.
  readonly onInGraph?: (item: ConnectionsDejaVuItem) => void;
  // 1B — pivot to Inbox pre-filtered by this card's canonical URL.
  // Symmetric to onInGraph for the workstream/thread surface. Hidden
  // when the card has no URL.
  readonly onInInbox?: (item: ConnectionsDejaVuItem) => void;
}): ReactElement => {
  const selectionText = context?.selectionText.trim() ?? '';
  const hasSelection = selectionText.length > 0;
  const sourceHost = context !== null ? hostOfUrl(context.sourceUrl) : null;
  const facetCounts: Record<DejaVuFilterKey, number> = {
    all: items.length,
    page: 0,
    chat: 0,
    similar: 0,
    thread: 0,
    visited: 0,
  };
  for (const item of items) {
    if (item.facet !== undefined) facetCounts[item.facet] += 1;
  }
  const visibleFacets = DEJAVU_FACET_KEYS.filter((f) => facetCounts[f] > 0);
  const filteredItems =
    filter === 'all' ? items : items.filter((i) => i.facet === filter);
  const selectionPreview =
    selectionText.length > 140 ? `${selectionText.slice(0, 137)}…` : selectionText;
  return (
    <section className="cx-deja-view" data-testid="connections-dejavu-view">
      <div className="cx-deja-view-head">
        <h3>Déjà-vu</h3>
        {sourceHost !== null ? (
          <span
            className="cx-deja-source-pill"
            title={context?.sourceUrl}
            data-testid="connections-dejavu-source"
          >
            from {sourceHost}
          </span>
        ) : null}
        <span className="cx-mono cx-dim">
          {String(items.length)} prior result{items.length === 1 ? '' : 's'}
        </span>
        {hasSelection ? (
          <button
            type="button"
            className="cx-deja-search-pivot"
            data-testid="connections-dejavu-search-pivot"
            onClick={() => onSearchPivot(selectionText)}
            title="Open this query in the Connections Search submode"
          >
            ⇄ Search
          </button>
        ) : null}
      </div>
      {hasSelection ? (
        <blockquote className="cx-deja-selection" data-testid="connections-dejavu-selection">
          “{selectionPreview}”
        </blockquote>
      ) : null}
      {items.length > 0 ? (
        <div className="cx-deja-chips" role="tablist" aria-label="Filter Déjà-vu results">
          <button
            type="button"
            role="tab"
            aria-selected={filter === 'all'}
            className={'cx-deja-chip' + (filter === 'all' ? ' is-active' : '')}
            onClick={() => onFilterChange('all')}
            data-testid="connections-dejavu-chip-all"
          >
            All {items.length}
          </button>
          {visibleFacets.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={'cx-deja-chip' + (filter === f ? ' is-active' : '')}
              onClick={() => onFilterChange(f)}
              data-testid={`connections-dejavu-chip-${f}`}
            >
              {dejaVuFacetChipLabel(f)} {facetCounts[f]}
            </button>
          ))}
        </div>
      ) : null}
      {hasSelection ? (
        <div
          className="cx-deja-actions"
          role="toolbar"
          aria-label="Actions on the highlighted selection"
        >
          <button
            type="button"
            className="cx-deja-action"
            onClick={() => onWebSearch(selectionText)}
          >
            🔍 Google
          </button>
          <button
            type="button"
            className="cx-deja-action"
            onClick={() => onTranslate(selectionText)}
          >
            🌐 Translate
          </button>
          <button
            type="button"
            className="cx-deja-action cx-deja-action-primary"
            onClick={() => onAskAi('chatgpt', selectionText)}
          >
            🤖 Ask GPT
          </button>
          <button
            type="button"
            className="cx-deja-action"
            onClick={() => onAskAi('claude', selectionText)}
          >
            Claude
          </button>
          <button
            type="button"
            className="cx-deja-action"
            onClick={() => onAskAi('gemini', selectionText)}
          >
            Gemini
          </button>
        </div>
      ) : null}
      {filteredItems.length === 0 ? (
        <div className="cx-empty">
          {items.length === 0 ? (
            <>
              <h4>No Déjà-vu results yet</h4>
              <p>
                Select text on any page and use “See all” from the Déjà-vu popover, or
                run a query in the Search submode and click “Déjà-vu this”.
              </p>
            </>
          ) : (
            <p>No results in this filter.</p>
          )}
        </div>
      ) : (
        <div className="cx-deja-list">
          {filteredItems.map((item) => (
            <article className="deja-row cx-deja-row" key={item.id}>
              <div className="r1">
                <span className="title">{item.title.length > 0 ? item.title : '(no title)'}</span>
                <span className="cx-deja-badges">
                  {item.facet !== undefined ? (
                    <span className="cx-deja-pill cx-deja-pill-facet">
                      {dejaVuFacetLabel(item.facet)}
                    </span>
                  ) : null}
                  <span className={`cx-deja-pill cx-deja-pill-provider prov-${item.providerKey}`}>
                    {item.providerLabel}
                  </span>
                  <span className="cx-deja-pill cx-deja-pill-time">
                    {formatRelative(item.relativeWhen)}
                  </span>
                  {item.facet === 'similar' && item.similarity !== undefined ? (
                    <span className="cx-deja-pill cx-deja-pill-similarity">
                      {String(Math.round(item.similarity * 100))}% similar
                    </span>
                  ) : null}
                </span>
              </div>
              {item.snippet.length > 0 && item.facet !== 'similar' ? (
                <div className="r2">{item.snippet}</div>
              ) : null}
              <div className="r3">
                {onInGraph !== undefined && item.anchorNodeId !== undefined ? (
                  <button
                    type="button"
                    className="cx-deja-jump cx-deja-pivot"
                    data-testid="connections-dejavu-in-graph"
                    onClick={() => onInGraph(item)}
                    title="Open this in the Connections graph (Linked submode anchored here)"
                  >
                    ⇄ Graph
                  </button>
                ) : null}
                {onInInbox !== undefined && item.canonicalUrl !== undefined ? (
                  <button
                    type="button"
                    className="cx-deja-jump cx-deja-pivot"
                    data-testid="connections-dejavu-in-inbox"
                    onClick={() => onInInbox(item)}
                    title="Find this in the Inbox (filtered by URL)"
                  >
                    ⇄ Inbox
                  </button>
                ) : null}
                {onJump !== undefined ? (
                  <button
                    type="button"
                    className="cx-deja-jump"
                    onClick={() => onJump(item)}
                    title="Open the source URL in a new tab"
                  >
                    ↗ Open
                  </button>
                ) : null}
                {item.evidence !== undefined && item.evidence.length > 0 ? (
                  <DejaVuWhy evidence={item.evidence} />
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
};

// P3 — per-row Why? expander for the submode. Mirrors the popover's
// expander (contentOverlays/index.ts) but renders in React. Click
// toggles a small details panel showing per-source evidence (retriever,
// rank, raw score, vector distance).
const DejaVuWhy = ({
  evidence,
}: {
  readonly evidence: NonNullable<ConnectionsDejaVuItem['evidence']>;
}): ReactElement => {
  const [open, setOpen] = useState(false);
  const fmt = (n: number | undefined): string => (n === undefined ? '—' : n.toFixed(3));
  return (
    <>
      <button
        type="button"
        className="cx-deja-jump cx-deja-why-btn"
        aria-expanded={open}
        onClick={() => setOpen((p) => !p)}
        title="Show retrieval evidence: which sources matched, with what scores"
      >
        Why?
      </button>
      {open ? (
        <div className="cx-deja-why-panel" role="group" aria-label="Retrieval evidence">
          {evidence.map((e, i) => {
            const src = e.sourceKind.replace('_', '-');
            const rank = e.rank !== undefined ? `rank ${String(e.rank)}` : '';
            const score = e.rawScore !== undefined ? `bm25 ${fmt(e.rawScore)}` : '';
            const vec =
              e.vectorDistance !== undefined ? `cosine ${fmt(1 - e.vectorDistance)}` : '';
            const bits = [e.retriever, src, rank, score, vec].filter((s) => s.length > 0);
            return (
              <div className="cx-deja-why-line" key={i}>
                {bits.join(' · ')}
              </div>
            );
          })}
        </div>
      ) : null}
    </>
  );
};

export const ConnectionsView = ({
  initialAnchor = '',
  recentAnchors = [],
  workstreamAnchors = [],
  onOpenUrl,
  displayCtx,
  requestAnchor,
  requestSearch,
  requestDejaVuMode,
  onRequestConsumed,
  onOpenInInbox,
  onSaveFocusGroup,
  currentTabUrl,
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
  const [anchorLabelOverrides, setAnchorLabelOverrides] = useState<Record<string, string>>({});
  const [hops, setHops] = useState<number>(1);
  const [subMode, setSubMode] = useState<SubMode>('linked');
  const [dejaVuItems, setDejaVuItems] = useState<readonly ConnectionsDejaVuItem[]>([]);
  const [dejaVuContext, setDejaVuContext] = useState<{
    readonly selectionText: string;
    readonly sourceUrl: string;
  } | null>(null);
  // Single-select chip filter for the submode list. 'all' shows
  // everything; otherwise we filter by the facet key. Matches the
  // popover overlay vocabulary so users get consistent behavior.
  const [dejaVuFilter, setDejaVuFilter] = useState<DejaVuFilterKey>('all');
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(ALL_RANGE);
  const [selectedEdge, setSelectedEdge] = useState<ConnectionEdge | null>(null);
  const [whyVisitId, setWhyVisitId] = useState<string | null>(null);
  const [whyAssertedOnly, setWhyAssertedOnly] = useState<boolean>(false);
  const [timelineHoverNodeId, setTimelineHoverNodeId] = useState<string | null>(null);
  const [hiddenNodeKinds, setHiddenNodeKinds] = useState<ReadonlySet<ConnectionNodeKind>>(
    () => new Set<ConnectionNodeKind>(),
  );
  const [hiddenEdgeFamilies, setHiddenEdgeFamilies] = useState<ReadonlySet<EdgeFamily>>(
    () => new Set<EdgeFamily>(),
  );

  // Snapshot fetching: cached by (anchor, hops), revalidated in the
  // background when revisited so the user gets instant flips through
  // history with no perceptible loading state.
  const effectiveSnapshotHops = subMode === 'flow' ? Math.max(hops, 2) : hops;
  const { snapshot: rawSnapshot, loading, error, refresh } = useConnectionsSnapshot(
    anchor,
    effectiveSnapshotHops,
  );
  // Edge detail enrichment — companion serves extra metadata (ranker
  // contributions, etc.) the neighbor scope strips for size.
  const edgeDetail = useConnectionsEdge(selectedEdge);
  // Stage 5 polish — full-snapshot pool for the search box, primed
  // lazily when the input gains focus. Lets the user find any
  // node in the vault, not just whatever the anchor's neighborhood
  // happens to have loaded.
  const fullSnapshot = useConnectionsFullSnapshot();
  const shadowFullSnapshot = useConnectionsFullSnapshot({ topicVariant: 'shadow' });
  // Recall-index full-text search. Debounced; fires on the
  // controlled search-box query. Below 3 chars the hook returns
  // an empty list so the panel doesn't spam the embedder.
  const [searchQuery, setSearchQuery] = useState<string>('');
  const recallResults = useRecallSearch(searchQuery);
  // Local in-memory mutation of the cached snapshot (engagement
  // relabel) — the snapshot is owned by the cache, so we
  // keep a transient override map until the next fetch refreshes the
  // canonical engagement metadata.
  const [engagementOverrides, setEngagementOverrides] = useState<Record<string, EngagementClass>>(
    {},
  );
  // Apply override maps + time-range filter to the raw snapshot.
  // Downstream consumers see the same shape as a raw
  // `ConnectionsScopedResult`, so they don't need to know about
  // overrides or the time filter at all.
  const result = useMemo(() => {
    if (rawSnapshot === null) return null;
    // Step 1 — apply engagement overrides so optimistic UI lands before the next
    // companion fetch revalidates.
    let nodes = rawSnapshot.snapshot.nodes;
    if (Object.keys(engagementOverrides).length > 0) {
      nodes = nodes.map((node) => {
        const engagementOverride = engagementOverrides[node.id];
        if (engagementOverride === undefined) return node;
        return {
          ...node,
          metadata: {
            ...node.metadata,
            engagement: {
              ...((isRecord(node.metadata['engagement'])
                ? node.metadata['engagement']
                : {}) as Record<string, unknown>),
              class: engagementOverride,
            },
          },
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
  }, [anchor, engagementOverrides, rawSnapshot, timeRange]);

  const resolvedAnchorId = useMemo(() => {
    const scopedNodeId = result?.snapshot.scope['nodeId'];
    return typeof scopedNodeId === 'string' && scopedNodeId.length > 0 ? scopedNodeId : anchor;
  }, [anchor, result]);

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
  const anchorNode = useMemo<ConnectionNode | null>(() => {
    if (result === null) return null;
    const node = result.snapshot.nodes.find((n) => n.id === anchor) ?? null;
    return node === null ? null : applyAnchorLabel(node, anchorLabelOverrides[anchor]);
  }, [anchor, anchorLabelOverrides, result]);
  const fallbackAnchorNode = useMemo<ConnectionNode | null>(() => {
    if (anchor.length === 0 || anchorNode !== null) return null;
    return displayOnlyAnchorNode(anchor, anchorLabelOverrides[anchor]);
  }, [anchor, anchorLabelOverrides, anchorNode]);
  const anchorDisplayNode = anchorNode ?? fallbackAnchorNode;
  const snapshotNodeById = useMemo(() => {
    const byId =
      result === null
        ? new Map<string, ConnectionNode>()
        : new Map(result.snapshot.nodes.map((node) => [node.id, node] as const));
    if (fallbackAnchorNode !== null && !byId.has(fallbackAnchorNode.id)) {
      byId.set(fallbackAnchorNode.id, fallbackAnchorNode);
    }
    return byId;
  }, [fallbackAnchorNode, result]);
  const ctx: EntityDisplayCtx = useMemo(
    () => ({ ...baseCtx, nodeById: snapshotNodeById }),
    [baseCtx, snapshotNodeById],
  );
  const shadowSnapshotNodeById = useMemo(
    () => new Map(shadowFullSnapshot.nodes.map((node) => [node.id, node] as const)),
    [shadowFullSnapshot.nodes],
  );
  const shadowCtx: EntityDisplayCtx = useMemo(
    () => ({ ...baseCtx, nodeById: shadowSnapshotNodeById }),
    [baseCtx, shadowSnapshotNodeById],
  );

  const timeline = useMemo<TimelineRailData | null>(() => {
    if (result === null) return null;
    return computeTimelineRail(result.snapshot, anchor, { range: timeRange });
  }, [result, anchor, timeRange]);

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
      if (anchorDisplayNode !== null) fallbackNodeById.set(anchorDisplayNode.id, anchorDisplayNode);
      add({
        id: anchor,
        label: formatNodeIdDisplay(anchor, fallbackNodeById, ctx).primary,
      });
    }
    return [...byId.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [anchor, anchorDisplayNode, ctx, recentAnchors, result, workstreamAnchors]);

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
  const navigateToAnchor = (nextAnchorId: string, label?: string): void => {
    const value = nextAnchorId.trim();
    if (value.length === 0) return;
    const cleanLabel = humanAnchorLabel(label);
    if (cleanLabel !== undefined) {
      setAnchorLabelOverrides((current) => ({ ...current, [value]: cleanLabel }));
    }
    setSelectedEdge(null);
    setWhyVisitId(null);
    history.navigate(value);
  };

  const selectedWorkstreamAnchor = anchor.startsWith('workstream:') ? anchor : '';

  // #5 — collapsible panels. Always-available restrained toggles:
  // left rail (Find/Workstream/Recent/Shortcuts), the right anchor
  // summary (cx-col-r: why-related / provenance), and the page-text
  // card. Collapsing reclaims the fixed column width.
  const [leftRailOpen, setLeftRailOpen] = useState(() => !isNarrowConnectionsViewport());
  const [rightPanelOpen, setRightPanelOpen] = useState(() => !isNarrowConnectionsViewport());
  const [anchorSummaryOpen, setAnchorSummaryOpen] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(CONNECTIONS_NARROW_QUERY);
    const syncRailDefaults = (): void => {
      const openByDefault = !query.matches;
      setLeftRailOpen(openByDefault);
      setRightPanelOpen(openByDefault);
    };
    syncRailDefaults();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', syncRailDefaults);
      return () => {
        query.removeEventListener('change', syncRailDefaults);
      };
    }
    query.addListener(syncRailDefaults);
    return () => {
      query.removeListener(syncRailDefaults);
    };
  }, []);

  // Honest "Recent anchors" — built from real navigation history
  // (clicks/navigation), not the thread/workstream shortcut prop.
  // Label prefers the human override captured on navigate; otherwise
  // resolve against the current snapshot.
  const historyAnchors = useMemo<readonly ConnectionsViewRecentAnchor[]>(() => {
    const nodeById = new Map(
      (result?.snapshot.nodes ?? []).map((node) => [node.id, node] as const),
    );
    return history.recent.map((id) => {
      const override = anchorLabelOverrides[id];
      const label =
        override !== undefined && override.length > 0
          ? override
          : formatNodeIdDisplay(id, nodeById, ctx).primary;
      return { id, kind: anchorKindFromId(id), label };
    });
  }, [history.recent, anchorLabelOverrides, result, ctx]);

  // Search pool — node candidates merged from (a) the current
  // anchor's neighborhood (small, always fresh) + (b) the full
  // snapshot (large, primed on search-box focus). Anchor scope
  // takes precedence so engagement relabels still reflect immediately.
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

  const nodeKindFilterOptions = useMemo(() => {
    const counts = new Map<ConnectionNodeKind, number>();
    for (const node of result?.snapshot.nodes ?? []) {
      if (node.id === anchor) continue;
      counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) => {
      const leftRank = NODE_KIND_GROUP_ORDER.indexOf(left);
      const rightRank = NODE_KIND_GROUP_ORDER.indexOf(right);
      return (
        (leftRank < 0 ? 99 : leftRank) - (rightRank < 0 ? 99 : rightRank) ||
        nodeKindDisplayFor(left).label.localeCompare(nodeKindDisplayFor(right).label)
      );
    });
  }, [anchor, result]);

  const edgeFamilyFilterOptions = useMemo(() => {
    const counts = new Map<EdgeFamily, number>();
    for (const edge of result?.snapshot.edges ?? []) {
      const family = edgeFamilyForKind(edge.kind);
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    return (Object.keys(FAMILIES) as EdgeFamily[]).map(
      (family) => [family, counts.get(family) ?? 0] as const,
    );
  }, [result]);

  const panelFilterActive = FILTERED_SUBMODES.has(subMode);
  const filteredPanelResult = useMemo(() => {
    if (result === null || !panelFilterActive) return result;
    return filterSnapshotForConnectionModes(result, anchor, hiddenNodeKinds, hiddenEdgeFamilies);
  }, [anchor, hiddenEdgeFamilies, hiddenNodeKinds, panelFilterActive, result]);

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

  // The global top-bar search button, when already on Connections,
  // focuses THIS view's SearchTab instead of opening a second search
  // panel over it (the "two search features on one page" complaint).
  useEffect(() => {
    if (requestSearch === undefined || requestSearch === 0) return;
    setSubMode('search');
    fullSnapshot.prime();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new request arrives
  }, [requestSearch]);

  useEffect(() => {
    if (requestDejaVuMode === undefined || requestDejaVuMode.items.length === 0) return;
    setDejaVuItems([...requestDejaVuMode.items]);
    setDejaVuContext({
      selectionText: requestDejaVuMode.selectionText,
      sourceUrl: requestDejaVuMode.sourceUrl,
    });
    // Seed Search query so "Search this" pivots without retyping.
    setSearchQuery(requestDejaVuMode.selectionText);
    setSubMode('dejavu');
  }, [requestDejaVuMode]);

  // Stage 5 polish — derive a canonical URL from the current anchor
  // so the "Find in Inbox" button can pass it back to App.tsx. Three
  // anchor kinds carry a URL signal: timeline-visit (id is the URL),
  // visit-instance (id is `visit-instance:tses_*:<iso>:<URL>`), and
  // tab-session / thread (metadata.canonicalUrl). Returns null when
  // the anchor doesn't carry a URL (workstreams, topics, snippets).
  const anchorCanonicalUrl = useMemo<string | null>(() => {
    if (anchor.length === 0) return null;
    const fromId = urlFromAnchorNodeId(anchor);
    if (fromId !== undefined) return fromId;
    if (anchorNode !== null) {
      const meta = anchorNode.metadata as Record<string, unknown>;
      const fromMeta = ['canonicalUrl', 'latestUrl', 'url']
        .map((k) => meta[k])
        .find((v): v is string => typeof v === 'string' && v.length > 0);
      if (fromMeta !== undefined) return fromMeta;
    }
    return null;
  }, [anchor, anchorNode]);
  const [pageContentCoverageOverride, setPageContentCoverageOverride] =
    useState<PageContentCoverage | null>(null);
  const [pageContentBusy, setPageContentBusy] = useState<'index' | 'selection' | 'delete' | null>(
    null,
  );
  const [pageContentBulkBusy, setPageContentBulkBusy] = useState<'preview' | 'index' | null>(null);
  const [pageContentBulkPreview, setPageContentBulkPreview] = useState<
    readonly PageContentOpenTabPreview[] | null
  >(null);
  const [pageContentError, setPageContentError] = useState<string | null>(null);
  const pageContentCoverageMatchesAnchor =
    pageContentCoverageOverride !== null &&
    anchorCanonicalUrl !== null &&
    pageContentCoverageOverride.canonicalUrl === pageContentCanonicalUrl(anchorCanonicalUrl);
  const anchorPageContentCoverage = pageContentCoverageMatchesAnchor
    ? pageContentCoverageOverride
    : pageContentCoverageFromNode(anchorDisplayNode);

  useEffect(() => {
    if (anchorCanonicalUrl === null) {
      setPageContentCoverageOverride(null);
      setPageContentBulkPreview(null);
      return;
    }
    if (typeof chrome === 'undefined' || chrome.runtime?.sendMessage === undefined) return;
    let active = true;
    chrome.runtime.sendMessage(
      { type: messageTypes.pageContentCoverage, canonicalUrl: anchorCanonicalUrl },
      (response: unknown) => {
        if (!active) return;
        const parsed = response as PageContentOperationResponse;
        if (parsed.ok && parsed.coverage !== undefined) {
          setPageContentCoverageOverride(parsed.coverage);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [anchorCanonicalUrl]);

  const runPageContentAction = (
    type:
      | typeof messageTypes.pageContentIndexCurrent
      | typeof messageTypes.pageContentIndexSelection
      | typeof messageTypes.pageContentDelete,
  ): void => {
    if (type === messageTypes.pageContentDelete && anchorCanonicalUrl === null) return;
    setPageContentBusy(
      type === messageTypes.pageContentDelete
        ? 'delete'
        : type === messageTypes.pageContentIndexSelection
          ? 'selection'
          : 'index',
    );
    setPageContentError(null);
    const message =
      type === messageTypes.pageContentDelete
        ? { type, canonicalUrl: anchorCanonicalUrl }
        : { type };
    chrome.runtime.sendMessage(message, (response: unknown) => {
      setPageContentBusy(null);
      const lastError = chrome.runtime.lastError;
      if (lastError !== undefined) {
        setPageContentError(lastError.message ?? 'Page-content operation failed.');
        return;
      }
      const parsed = response as PageContentOperationResponse;
      if (parsed.ok && parsed.coverage !== undefined) {
        setPageContentCoverageOverride(parsed.coverage);
        refresh();
        return;
      }
      setPageContentError(parsed.error ?? 'Page-content operation failed.');
    });
  };

  const loadPageContentBulkPreview = (): void => {
    setPageContentBulkBusy('preview');
    setPageContentError(null);
    chrome.runtime.sendMessage(
      { type: messageTypes.pageContentOpenTabsPreview },
      (response: unknown) => {
        setPageContentBulkBusy(null);
        const lastError = chrome.runtime.lastError;
        if (lastError !== undefined) {
          setPageContentError(lastError.message ?? 'Open-tab preview failed.');
          return;
        }
        const parsed = response as PageContentOpenTabsPreviewResponse;
        if (!parsed.ok) {
          setPageContentError(parsed.error ?? 'Open-tab preview failed.');
          return;
        }
        setPageContentBulkPreview(parsed.tabs);
      },
    );
  };

  const runPageContentBulkIndex = (): void => {
    setPageContentBulkBusy('index');
    setPageContentError(null);
    chrome.runtime.sendMessage(
      { type: messageTypes.pageContentIndexOpenTabs },
      (response: unknown) => {
        setPageContentBulkBusy(null);
        const lastError = chrome.runtime.lastError;
        if (lastError !== undefined) {
          setPageContentError(lastError.message ?? 'Open-tab indexing failed.');
          return;
        }
        const parsed = response as PageContentBulkOperationResponse;
        if (parsed.coverages.length > 0) {
          const anchorCoverage =
            anchorCanonicalUrl === null
              ? undefined
              : parsed.coverages.find(
                  (coverage) =>
                    coverage.canonicalUrl === pageContentCanonicalUrl(anchorCanonicalUrl),
                );
          if (anchorCoverage !== undefined) setPageContentCoverageOverride(anchorCoverage);
          refresh();
        }
        setPageContentBulkPreview(null);
        if (!parsed.ok && parsed.error !== undefined) {
          setPageContentError(parsed.error);
        }
      },
    );
  };

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

  // Local override for engagement-relabel optimistic UI. The next
  // snapshot fetch refreshes canonical metadata; until then, the
  // override map applied in `result` shows the user's change without
  // a round-trip.
  const replaceNodeEngagementClass = (nodeId: string, engagementClass: EngagementClass): void => {
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
    // Move 2(b) — a reject on a relation edge is also a stand-alone "these two
    // pages are NOT related" assertion. Persist it on its own channel so the
    // pair-rejection survives independent of the flow-relation-kind correction
    // above (collect-store-only; suppression is deferred behind the freeze).
    // Fire-and-forget: a failure here must not fail the primary reject gesture.
    if (choice === 'reject') {
      void postUserRejectedRelation({
        fromRef: edge.fromNodeId,
        toRef: edge.toNodeId,
        surface: 'connections',
        reason: 'not-related',
      });
    }
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

  const submitTopicPromote = async (input: {
    readonly topicId: string;
    readonly targetWorkstreamId: string;
    readonly memberVisitIds: readonly string[];
  }): Promise<void> => {
    const response = await postUserOrganizedItem({
      itemKind: 'topic',
      itemId: input.topicId,
      action: 'promote',
      toContainer: input.targetWorkstreamId,
      details: { memberIds: input.memberVisitIds },
    });
    if (!response.ok) {
      throw new Error(response.error ?? 'topic promote feedback failed');
    }
  };

  const submitFocusGroupSave = async (input: FocusGroupSaveInput): Promise<void> => {
    if (onSaveFocusGroup === undefined) {
      throw new Error('Focus group saving is not available.');
    }
    await Promise.resolve(onSaveFocusGroup(input));
    refresh();
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
  };

  const submitTopicDismiss = async (input: {
    readonly topicId: string;
    readonly memberVisitIds: readonly string[];
  }): Promise<void> => {
    const response = await postUserOrganizedItem({
      itemKind: 'topic',
      itemId: input.topicId,
      action: 'ignore',
      details: {
        reason: 'hidden',
        memberIds: input.memberVisitIds,
      },
    });
    if (!response.ok) {
      throw new Error(response.error ?? 'topic dismiss feedback failed');
    }
  };

  const submitVisitMarkNotRelated = async (input: {
    readonly topicId: string;
    readonly fromVisitId?: string;
    readonly visitId: string;
    readonly memberVisitIds: readonly string[];
  }): Promise<void> => {
    // #193 graft — when removed from a scoped (anchored) focus, the
    // removal is also a rejection of the closest-visit edge that put
    // the page here, not just an "ignore in this topic".
    if (input.fromVisitId !== undefined && input.fromVisitId !== input.visitId) {
      const flowResponse = await postUserFlowRejected({
        relationKind: 'closest_visit',
        fromId: input.fromVisitId,
        toId: input.visitId,
        reason: 'not-related',
      });
      if (!flowResponse.ok) {
        throw new Error(flowResponse.error ?? 'visit-topic rejection feedback failed');
      }
    }

    const response = await postUserOrganizedItem({
      itemKind: 'visit',
      itemId: input.visitId,
      action: 'ignore',
      fromContainer: input.topicId,
      details: {
        splitInto: input.memberVisitIds.filter((memberId) => memberId !== input.visitId),
      },
    });
    if (!response.ok) {
      throw new Error(response.error ?? 'visit-topic feedback failed');
    }
  };

  const submitVisitConfirmRelated = async (input: {
    readonly fromVisitId: string;
    readonly toVisitId: string;
  }): Promise<void> => {
    const response = await postUserFlowConfirmed({
      relationKind: 'closest_visit',
      fromId: input.fromVisitId,
      toId: input.toVisitId,
    });
    if (!response.ok) {
      throw new Error(response.error ?? 'visit-topic confirmation feedback failed');
    }
  };

  const submitVisitRestoreToTopic = async (input: {
    readonly topicId: string;
    readonly visitId: string;
  }): Promise<void> => {
    const response = await postUserOrganizedItem({
      itemKind: 'visit',
      itemId: input.visitId,
      action: 'move',
      toContainer: input.topicId,
    });
    if (!response.ok) {
      throw new Error(response.error ?? 'visit-topic restore feedback failed');
    }
  };

  const totalEdges = result?.snapshot.edgeCount ?? 0;
  // modeAvailability is computed below, AFTER the filtered/scoped
  // render sets — gating on the raw neighbor snapshot let a search/
  // time scope empty the panel while the tab still showed enabled
  // (the "blank panel with no idea why" bug, E).

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
    if (subMode === 'focus') {
      fullSnapshot.prime();
      shadowFullSnapshot.prime();
    } else if (subMode === 'flow' || subMode === 'search') {
      fullSnapshot.prime();
    }
    // Intentionally not depending on fullSnapshot itself — prime()
    // is internally idempotent and the no-op guard handles repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subMode]);
  useEffect(() => {
    if (anchor.startsWith('topic:')) {
      shadowFullSnapshot.prime();
    }
    // Intentionally not depending on shadowFullSnapshot itself — prime()
    // is idempotent and the hook guards in-flight/ready states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
  const whyFeedbackEdge = useMemo(() => {
    if (result === null || whyVisitId === null) return null;
    return findFeedbackEdge(result.snapshot.edges, anchor, whyVisitId);
  }, [result, anchor, whyVisitId]);
  const whyRevisionEdge = useMemo(() => {
    if (result === null || whyVisitId === null) return null;
    return findRevisionEdgeForVisit(result.snapshot.edges, whyVisitId);
  }, [result, whyVisitId]);
  const filteredFullSnapshot = useMemo(() => {
    if (timeRange.kind === 'all') {
      return { nodes: fullSnapshot.nodes, edges: fullSnapshot.edges } as const;
    }
    const filtered = filterByTimeRange(fullSnapshot.nodes, fullSnapshot.edges, timeRange, {
      anchorId: resolvedAnchorId,
    });
    return { nodes: filtered.nodes, edges: filtered.edges } as const;
  }, [fullSnapshot.edges, fullSnapshot.nodes, resolvedAnchorId, timeRange]);
  const filteredShadowSnapshot = useMemo(() => {
    if (timeRange.kind === 'all') {
      return { nodes: shadowFullSnapshot.nodes, edges: shadowFullSnapshot.edges } as const;
    }
    const filtered = filterByTimeRange(
      shadowFullSnapshot.nodes,
      shadowFullSnapshot.edges,
      timeRange,
      {
        anchorId: resolvedAnchorId,
      },
    );
    return { nodes: filtered.nodes, edges: filtered.edges } as const;
  }, [resolvedAnchorId, shadowFullSnapshot.edges, shadowFullSnapshot.nodes, timeRange]);
  const focusData = useMemo(
    () =>
      result === null
        ? emptyFocusData()
        : deriveFocusData(
            result.snapshot.nodes,
            result.snapshot.edges,
            filteredFullSnapshot.nodes,
            filteredFullSnapshot.edges,
            ctx,
          ),
    [ctx, filteredFullSnapshot.edges, filteredFullSnapshot.nodes, result],
  );
  const shadowFocusData = useMemo(() => {
    if (result === null || filteredShadowSnapshot.nodes.length === 0) {
      return emptyFocusData();
    }
    const shadowScope = deriveShadowFocusScope(
      resolvedAnchorId,
      result.snapshot.nodes,
      result.snapshot.edges,
      filteredShadowSnapshot.nodes,
      filteredShadowSnapshot.edges,
    );
    return deriveFocusData(
      shadowScope.nodes,
      shadowScope.edges,
      shadowScope.nodes,
      shadowScope.edges,
      shadowCtx,
    );
  }, [
    filteredShadowSnapshot.edges,
    filteredShadowSnapshot.nodes,
    resolvedAnchorId,
    result,
    shadowCtx,
  ]);
  const focusEligibleVisitCount = eligibleVisitCountForFocusData(focusData);
  const shadowEligibleVisitCount = eligibleVisitCountForFocusData(shadowFocusData);
  const activeFocusCollapsed = isCollapsedSuggestionSet(
    focusData.topics,
    focusEligibleVisitCount,
    focusData.previousTopicCount,
  );
  const scopedEmptyFocusData = useMemo(() => emptyFocusData(), []);
  // A topic anchor must scope against the SERVED graph the user clicked
  // the topic in (post-W2 that is leiden-cpm). The legacy path scoped
  // against the idf-rkn *shadow* snapshot, whose topic ids are a wholly
  // different clustering — the anchored id never matched there, so every
  // topic anchor fell through to "No scoped focus group". Reuse the
  // tested scope derivation but feed it the served snapshot + ctx.
  const servedTopicFocusData = useMemo(() => {
    if (result === null || !resolvedAnchorId.startsWith('topic:')) return emptyFocusData();
    const scope = deriveShadowFocusScope(
      resolvedAnchorId,
      result.snapshot.nodes,
      result.snapshot.edges,
      result.snapshot.nodes,
      result.snapshot.edges,
    );
    return deriveFocusData(scope.nodes, scope.edges, scope.nodes, scope.edges, ctx);
  }, [ctx, resolvedAnchorId, result]);
  const anchorIsTopic = resolvedAnchorId.startsWith('topic:');
  const shadowSnapshotReady = shadowFullSnapshot.ready;
  const topicAnchorShadowResolving =
    anchorIsTopic &&
    servedTopicFocusData.topics.length === 0 &&
    !shadowSnapshotReady &&
    shadowFullSnapshot.error === null;
  const renderedFocusData = anchorIsTopic
    ? servedTopicFocusData.topics.length > 0
      ? servedTopicFocusData
      : shadowSnapshotReady && shadowFocusData.topics.length > 0
        ? shadowFocusData
        : scopedEmptyFocusData
    : activeFocusCollapsed && shadowFocusData.topics.length > 0
      ? shadowFocusData
      : activeFocusCollapsed && shadowSnapshotReady
        ? scopedEmptyFocusData
        : focusData;
  const relatedFocusData = useMemo(() => {
    if (result === null || anchorIsTopic) return emptyFocusData();
    return deriveRelatedFocusData(
      resolvedAnchorId,
      result.snapshot.nodes,
      result.snapshot.edges,
      ctx,
    );
  }, [anchorIsTopic, ctx, resolvedAnchorId, result]);
  const displayedFocusData =
    renderedFocusData.topics.length === 0 && relatedFocusData.topics.length > 0
      ? relatedFocusData
      : renderedFocusData;
  const focusCandidateNodes =
    displayedFocusData === shadowFocusData
      ? filteredShadowSnapshot.nodes
      : filteredFullSnapshot.nodes;
  const focusCandidateEdges =
    displayedFocusData === shadowFocusData
      ? filteredShadowSnapshot.edges
      : filteredFullSnapshot.edges;
  const focusCandidateCtx = displayedFocusData === shadowFocusData ? shadowCtx : ctx;
  // Sub-mode availability gates (E). Gate on what is ACTUALLY rendered
  // after time/search/scope filtering, not the raw neighbor snapshot —
  // otherwise a scope that empties the panel still shows the tab as
  // enabled and the user gets a blank panel with no explanation.
  const modeAvailability = useMemo(() => {
    const renderedNodes = filteredFullSnapshot.nodes;
    const hasVisits = renderedNodes.some((n) => n.kind === 'timeline-visit');
    const hasTopics =
      displayedFocusData.topics.length > 0 || renderedNodes.some((n) => n.kind === 'topic');
    const isWorkstream = anchor.startsWith('workstream:');
    return {
      flow: {
        enabled: hasVisits,
        reason: hasVisits
          ? undefined
          : 'No timeline-visits in this scope. Clear the search/time filter, raise ↑ Hops, or pick a topic.',
      },
      focus: {
        enabled: hasTopics,
        reason: hasTopics
          ? undefined
          : 'No topic clusters in this scope. Clear the search/time filter, or anchor a workstream at higher hops.',
      },
      context: {
        // Hidden until Context Pack is implemented. Set `hidden: false`
        // to restore the dim-when-not-applicable tab.
        enabled: false,
        hidden: true,
        reason: 'Coming soon',
      },
      dejavu: {
        enabled: true,
        reason: undefined,
      },
    };
  }, [anchor, displayedFocusData, filteredFullSnapshot.nodes]);
  const suggestedFocusCandidatesByTopic = useMemo(
    () =>
      deriveFocusSuggestedCandidates(
        displayedFocusData,
        focusCandidateNodes.length > 0 ? focusCandidateNodes : (result?.snapshot.nodes ?? []),
        focusCandidateEdges.length > 0 ? focusCandidateEdges : (result?.snapshot.edges ?? []),
        focusCandidateCtx,
      ),
    [
      displayedFocusData,
      focusCandidateCtx,
      focusCandidateEdges,
      focusCandidateNodes,
      result?.snapshot.edges,
      result?.snapshot.nodes,
    ],
  );
  const recentFocusCandidates = useMemo(
    () =>
      deriveRecentFocusCandidates(
        focusCandidateNodes.length > 0 ? focusCandidateNodes : (result?.snapshot.nodes ?? []),
        focusCandidateCtx,
      ),
    [focusCandidateCtx, focusCandidateNodes, result?.snapshot.nodes],
  );
  const renderedFocusEligibleVisitCount =
    displayedFocusData === relatedFocusData
      ? eligibleVisitCountForFocusData(relatedFocusData)
      : renderedFocusData === shadowFocusData
        ? shadowEligibleVisitCount
        : renderedFocusData === scopedEmptyFocusData
          ? 0
          : focusEligibleVisitCount;
  const renderedFocusEmptyDetail = useMemo(() => {
    if (displayedFocusData !== scopedEmptyFocusData || result === null) return undefined;
    if (topicAnchorShadowResolving) {
      return 'Loading the candidate topic graph for this suggestion.';
    }
    if (anchorIsTopic && shadowFullSnapshot.error !== null) {
      return `Could not load the candidate topic graph: ${shadowFullSnapshot.error}`;
    }
    return focusEmptyDetailForAnchor(
      resolvedAnchorId,
      [...result.snapshot.nodes, ...filteredShadowSnapshot.nodes],
      [...result.snapshot.edges, ...filteredShadowSnapshot.edges],
    );
  }, [
    anchorIsTopic,
    displayedFocusData,
    filteredShadowSnapshot.edges,
    filteredShadowSnapshot.nodes,
    resolvedAnchorId,
    result,
    scopedEmptyFocusData,
    shadowFullSnapshot.error,
    topicAnchorShadowResolving,
  ]);
  const whyUsesShadowFocusGraph =
    subMode === 'focus' && (renderedFocusData === shadowFocusData || anchorIsTopic);
  const whyReasonNodes = whyUsesShadowFocusGraph
    ? filteredShadowSnapshot.nodes
    : (result?.snapshot.nodes ?? []);
  const whyReasonEdges = whyUsesShadowFocusGraph
    ? filteredShadowSnapshot.edges
    : (result?.snapshot.edges ?? []);
  const whyReasonCtx = whyUsesShadowFocusGraph ? shadowCtx : ctx;
  const whyPanelRevisionEdge =
    whyVisitId === null
      ? whyRevisionEdge
      : (findRevisionEdgeForVisit(whyReasonEdges, whyVisitId) ?? whyRevisionEdge);
  // Flow Path subgraph — expand the anchor scope with the full
  // snapshot's navigation-edge transitive closure (capped). Keeps
  // the chain compact for hub visits while still surfacing the
  // parent page when the user lands on a leaf visit-instance.
  const flowSubgraph = useMemo(() => {
    if (result === null) return { nodes: [], edges: [] } as const;
    return expandFlowSubgraph(
      result.snapshot.nodes,
      filteredFullSnapshot.nodes,
      filteredFullSnapshot.edges,
    );
  }, [result, filteredFullSnapshot.nodes, filteredFullSnapshot.edges]);
  const filteredFlowSubgraph = useMemo(
    () =>
      filterGraphPartsForConnectionModes(
        flowSubgraph.nodes,
        flowSubgraph.edges,
        anchor,
        hiddenNodeKinds,
        hiddenEdgeFamilies,
      ),
    [anchor, flowSubgraph.edges, flowSubgraph.nodes, hiddenEdgeFamilies, hiddenNodeKinds],
  );
  const contextWorkstreamId = useMemo(() => {
    if (anchor.startsWith('workstream:')) return anchor.replace(/^workstream:/u, '');
    const workstream = result?.snapshot.nodes.find((node) => node.kind === 'workstream');
    return workstream?.id.replace(/^workstream:/u, '') ?? anchor;
  }, [anchor, result]);
  const searchTab = (
    <SearchTab
      nodes={searchNodes}
      extras={searchExtras}
      ctx={ctx}
      query={searchQuery}
      onQueryChange={setSearchQuery}
      onPrime={fullSnapshot.prime}
      loading={fullSnapshot.loading}
      recallHits={recallResults.items.map((item) => ({
        ...(item.sourceKind === undefined ? {} : { sourceKind: item.sourceKind }),
        ...(item.anchorNodeId === undefined ? {} : { anchorNodeId: item.anchorNodeId }),
        ...(item.threadId === undefined ? {} : { threadId: item.threadId }),
        ...(item.canonicalUrl === undefined ? {} : { canonicalUrl: item.canonicalUrl }),
        ...(item.title === undefined ? {} : { title: item.title }),
        ...(item.threadUrl === undefined ? {} : { threadUrl: item.threadUrl }),
        ...(item.snippet === undefined ? {} : { snippet: item.snippet }),
        score: item.score,
      }))}
      recallLoading={recallResults.loading}
      recallError={recallResults.error}
      onPick={(anchorId, label) => {
        navigateToAnchor(anchorId, label);
        setSubMode('linked');
      }}
      {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
      {...(currentTabUrl === undefined || currentTabUrl.length === 0
        ? {}
        : { currentTabUrl })}
      {...(anchorCanonicalUrl === null ? {} : { currentAnchorUrl: anchorCanonicalUrl })}
      onDejaVuPivot={(text) => {
        // E: Search → Déjà-vu pivot. Hand the query as the selection
        // text into the submode; items come from `recallResults`
        // (threads-only for now — pages come via the overlay popover).
        // The submode itself converts the recall hits when its own
        // items array is empty.
        const synthHits: readonly ConnectionsDejaVuItem[] = recallResults.items.map(
          (h): ConnectionsDejaVuItem => {
            const anchorNodeId =
              h.anchorNodeId ??
              (h.canonicalUrl === undefined
                ? undefined
                : `timeline-visit:${h.canonicalUrl}`);
            return {
              id: h.id,
              providerKey: 'web',
              providerLabel: 'Web',
              title: h.title ?? '(no title)',
              snippet: h.snippet ?? '',
              relativeWhen: h.capturedAt,
              score: h.score,
              facet: h.sourceKind === 'chat-turn' ? 'chat' : 'page',
              ...(h.threadUrl === undefined ? {} : { threadUrl: h.threadUrl }),
              ...(h.canonicalUrl === undefined ? {} : { canonicalUrl: h.canonicalUrl }),
              ...(anchorNodeId === undefined ? {} : { anchorNodeId }),
            };
          },
        );
        setDejaVuItems(synthHits);
        setDejaVuContext({ selectionText: text, sourceUrl: 'about:blank' });
        setDejaVuFilter('all');
        setSubMode('dejavu');
      }}
    />
  );

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
        {anchorDisplayNode !== null ? (
          <NodeChip node={anchorDisplayNode} state="anchor" ctx={ctx} />
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
            ⇄ Inbox
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
      <PageTextPanel
        canonicalUrl={anchorCanonicalUrl}
        open={anchorSummaryOpen}
        onToggleOpen={() => {
          setAnchorSummaryOpen((v) => !v);
        }}
        coverage={anchorPageContentCoverage}
        busy={pageContentBusy}
        bulkBusy={pageContentBulkBusy}
        error={pageContentError}
        bulkPreview={pageContentBulkPreview}
        onIndexPage={() => runPageContentAction(messageTypes.pageContentIndexCurrent)}
        onIndexSelection={() => runPageContentAction(messageTypes.pageContentIndexSelection)}
        onDelete={() => runPageContentAction(messageTypes.pageContentDelete)}
        onBulkPreview={loadPageContentBulkPreview}
        onBulkIndex={runPageContentBulkIndex}
        onBulkCancel={() => {
          setPageContentBulkPreview(null);
        }}
      />
      {dejaVuItems.length > 0 && subMode !== 'dejavu' ? (
        <div
          className="cx-deja-breadcrumb"
          role="status"
          aria-label="Déjà-vu recall session is active"
          data-testid="connections-dejavu-breadcrumb"
        >
          <button
            type="button"
            className="cx-deja-breadcrumb-pill"
            onClick={() => setSubMode('dejavu')}
            title="Return to the Déjà-vu recall result set"
          >
            ⇄ Déjà-vu ({String(dejaVuItems.length)})
          </button>
          {dejaVuContext !== null && dejaVuContext.selectionText.length > 0 ? (
            <span
              className="cx-deja-breadcrumb-quote"
              title={dejaVuContext.selectionText}
            >
              “{dejaVuContext.selectionText.length > 60
                ? `${dejaVuContext.selectionText.slice(0, 57)}…`
                : dejaVuContext.selectionText}”
            </span>
          ) : null}
          <button
            type="button"
            className="cx-deja-breadcrumb-dismiss"
            onClick={() => {
              // Explicit dismiss: clear the recall session so the
              // breadcrumb stops surfacing. The submode itself stays
              // present (still reachable via its tab); only the
              // staged hit set goes away. Mirrors how the popover's
              // × dismisses without breaking future recall.
              setDejaVuItems([]);
              setDejaVuContext(null);
            }}
            aria-label="Dismiss Déjà-vu recall session"
            title="Dismiss the active recall session"
          >
            ×
          </button>
        </div>
      ) : null}
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
          Related
        </button>
        {modeAvailability.context.hidden === true ? null : (
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
        )}
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'search'}
          className={'cx-mode' + (subMode === 'search' ? ' is-active' : '')}
          onClick={() => {
            setSubMode('search');
            fullSnapshot.prime();
          }}
          data-testid="connections-mode-search"
        >
          Search
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subMode === 'dejavu'}
          className={
            'cx-mode' +
            (subMode === 'dejavu' ? ' is-active' : '') +
            (modeAvailability.dejavu.enabled ? '' : ' is-dim')
          }
          onClick={() => setSubMode('dejavu')}
          title={modeAvailability.dejavu.reason}
          data-testid="connections-mode-dejavu"
        >
          <span className="cx-mode-icon" aria-hidden>
            {ClockIcon}
          </span>
          Déjà-vu
        </button>
      </div>
      {subMode === 'search' || subMode === 'dejavu' ? null : (
        <PathFinder
          anchorId={anchor}
          anchorLabel={
            anchorDisplayNode === null ? null : formatEntityDisplay(anchorDisplayNode, ctx).primary
          }
          nodes={searchNodes}
          extras={searchExtras}
          ctx={ctx}
          onNodeClick={(nodeId) => {
            useNodeAsAnchor(nodeId);
          }}
        />
      )}
      {result !== null && subMode !== 'search' && subMode !== 'dejavu' ? (
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
      {timeline !== null && subMode !== 'search' && subMode !== 'dejavu' ? (
        <TimelineRail
          data={timeline}
          ctx={ctx}
          highlightedNodeId={timelineHoverNodeId}
          onHoverNode={setTimelineHoverNodeId}
        />
      ) : null}
      <div
        className={
          'cx-cols' +
          (subMode === 'search' ? ' is-search-mode' : '') +
          (subMode === 'dejavu' ? ' is-dejavu-mode' : '')
        }
      >
        {subMode === 'search' || subMode === 'dejavu' ? null : (
          <aside className={'cx-col-l' + (leftRailOpen ? '' : ' is-collapsed')}>
            <button
              type="button"
              className="cx-rail-toggle cx-mono cx-dim"
              onClick={() => {
                setLeftRailOpen((v) => !v);
              }}
              aria-expanded={leftRailOpen}
              data-testid="connections-rail-toggle"
            >
              <span className="cx-rail-toggle-icon" aria-hidden>
                {leftRailOpen ? '▾' : '▸'}
              </span>
              <span className="cx-rail-toggle-label">Panel</span>
            </button>
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
                  ...(item.sourceKind === undefined ? {} : { sourceKind: item.sourceKind }),
                  ...(item.anchorNodeId === undefined ? {} : { anchorNodeId: item.anchorNodeId }),
                  ...(item.threadId === undefined ? {} : { threadId: item.threadId }),
                  ...(item.canonicalUrl === undefined ? {} : { canonicalUrl: item.canonicalUrl }),
                  ...(item.title === undefined ? {} : { title: item.title }),
                  ...(item.threadUrl === undefined ? {} : { threadUrl: item.threadUrl }),
                  ...(item.snippet === undefined ? {} : { snippet: item.snippet }),
                  score: item.score,
                }))}
                recallLoading={recallResults.loading}
                recallError={recallResults.error}
                onOpenFullSearch={(query) => {
                  setSearchQuery(query);
                  setSubMode('search');
                  fullSnapshot.prime();
                }}
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
                    {workstreamOptions.length === 0
                      ? 'No workstreams in view'
                      : 'Choose workstream'}
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
            {historyAnchors.length > 0 ? (
              <div className="cx-section" data-testid="connections-recent-anchors">
                <h4>Recent anchors</h4>
                <div className="cx-recent-anchor-list">
                  {historyAnchors.map((r) => (
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
            {recentAnchors.length > 0 ? (
              <div className="cx-section" data-testid="connections-anchor-shortcuts">
                <h4>Shortcuts</h4>
                <div className="cx-recent-anchor-list">
                  {recentAnchors.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="cx-recent-anchor"
                      onClick={() => {
                        navigateToAnchor(r.id);
                      }}
                      data-testid={`shortcut-anchor-${r.id}`}
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
            {panelFilterActive ? (
              <div className="cx-section" data-testid="connections-object-filter">
                <h4>Object filter</h4>
                <div className="cx-filter-list">
                  {nodeKindFilterOptions.length === 0 ? (
                    <span className="cx-mono cx-dim">No node kinds in scope</span>
                  ) : null}
                  {nodeKindFilterOptions.map(([kind, count]) => {
                    const display = nodeKindDisplayFor(kind);
                    const checked = !hiddenNodeKinds.has(kind);
                    return (
                      <label className="cx-filter-check" key={kind}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setHiddenNodeKinds((current) => toggleSetValue(current, kind));
                          }}
                          data-testid={`connections-object-filter-${kind}`}
                        />
                        <span className={`cx-node-icon ${display.tintClass}`} aria-hidden>
                          {KindIcons[kind]}
                        </span>
                        <span className="cx-filter-check-label">{display.label}</span>
                        <span className="cx-mono cx-dim">{String(count)}</span>
                      </label>
                    );
                  })}
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
              {panelFilterActive ? (
                <div className="cx-filter-list" data-testid="connections-edge-family-filter">
                  {edgeFamilyFilterOptions.map(([family, count]) => {
                    const familyMeta = FAMILIES[family];
                    const checked = !hiddenEdgeFamilies.has(family);
                    return (
                      <label className="cx-filter-check cx-family-filter-check" key={family}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setHiddenEdgeFamilies((current) => toggleSetValue(current, family));
                          }}
                          data-testid={`connections-family-filter-${family}`}
                        />
                        <span className={`cx-edge fam-${family}`} aria-hidden>
                          <span className="cx-edge-line" />
                        </span>
                        <span className="cx-filter-check-body">
                          <span className="cx-legend-label">{familyMeta.label}</span>
                          <span className="cx-legend-desc">{familyMeta.description}</span>
                        </span>
                        <span className="cx-mono cx-dim">{String(count)}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="cx-legend">
                  {(Object.keys(FAMILIES) as EdgeFamily[]).map((family) => {
                    const familyMeta = FAMILIES[family];
                    return (
                      <div key={family} className="cx-legend-row">
                        <span className={`cx-edge fam-${family}`} aria-hidden>
                          <span className="cx-edge-line" />
                        </span>
                        <span className="cx-legend-text">
                          <span className="cx-legend-label">{familyMeta.label}</span>
                          <span className="cx-legend-desc">{familyMeta.description}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        )}
        <main className="cx-col-c">
          {loading && result === null ? (
            <div className="cx-loading-row" data-testid="connections-loading">
              <span className="cx-spinner-dot" aria-hidden />
              <span className="cx-dim">
                Fetching neighbors of {formatNodeIdDisplay(anchor, EMPTY_NODE_MAP, ctx).primary}…
              </span>
            </div>
          ) : null}
          {error !== null ? (
            <div className="cx-empty" role="alert" data-testid="connections-error">
              <h4>Couldn't load</h4>
              <p>{error}</p>
            </div>
          ) : null}
          {subMode === 'search' ? (
            searchTab
          ) : subMode === 'dejavu' ? (
            <DejaVuFullView
              items={dejaVuItems}
              context={dejaVuContext}
              filter={dejaVuFilter}
              onFilterChange={setDejaVuFilter}
              onSearchPivot={(text) => {
                setSearchQuery(text);
                setSubMode('search');
                fullSnapshot.prime();
              }}
              onWebSearch={(text) => {
                window.open(
                  `https://www.google.com/search?q=${encodeURIComponent(text)}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              }}
              onTranslate={(text) => {
                window.open(
                  `https://translate.google.com/?sl=auto&tl=en&op=translate&text=${encodeURIComponent(text)}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              }}
              onAskAi={(provider, text) => {
                const NEW_CHAT: Record<'chatgpt' | 'claude' | 'gemini', string> = {
                  chatgpt: 'https://chatgpt.com/',
                  claude: 'https://claude.ai/new',
                  gemini: 'https://gemini.google.com/app',
                };
                // Mirror the popover's first-class tracked dispatch
                // flow. Bundle the current submode items + selection
                // text as recallContext so the resulting Recent
                // dispatch row gets the ↩ back-link too — identical
                // semantics to "Ask AI" from the page popover.
                void chrome.runtime.sendMessage({
                  type: messageTypes.submitSelectionDispatch,
                  url: NEW_CHAT[provider],
                  body: text,
                  provider,
                  title: text.slice(0, 80),
                  recallContext:
                    dejaVuContext === null
                      ? undefined
                      : {
                          selectionText: dejaVuContext.selectionText,
                          sourceUrl: dejaVuContext.sourceUrl,
                          hits: dejaVuItems.map((i) => ({
                            id: i.id,
                            providerKey: i.providerKey,
                            providerLabel: i.providerLabel,
                            title: i.title,
                            snippet: i.snippet,
                            relativeWhen: i.relativeWhen,
                            score: i.score,
                            ...(i.facet === undefined ? {} : { facet: i.facet }),
                            ...(i.similarity === undefined
                              ? {}
                              : { similarity: i.similarity }),
                          })),
                        },
                });
              }}
              onJump={(item) => {
                // Prefer canonical/thread URLs (jump out to live web).
                // Falls back to the current tab if neither is set.
                const url = item.canonicalUrl ?? item.threadUrl;
                if (url !== undefined && onOpenUrl !== undefined) {
                  onOpenUrl(url);
                }
              }}
              onInGraph={(item) => {
                // 1A — pivot into the graph. The submode is a recall
                // staging surface; everything else (topics, neighbors,
                // bridges, cross-card edges) lives in Linked submode
                // anchored on the card's node.
                if (item.anchorNodeId === undefined) return;
                navigateToAnchor(item.anchorNodeId, item.title);
                setSubMode('linked');
              }}
              onInInbox={(item) => {
                // 1B — symmetric pivot to Inbox. Parent App.tsx wires
                // requestSwitchToInbox(canonicalUrl) — same flow as
                // "Find in Inbox" elsewhere in this view.
                if (item.canonicalUrl === undefined) return;
                onOpenInInbox?.(item.canonicalUrl);
              }}
            />
          ) : result !== null ? (
            subMode === 'linked' ? (
              <LinkedCenter
                result={filteredPanelResult ?? result}
                anchorId={anchor}
                selectedEdge={selectedEdge}
                highlightedNodeId={timelineHoverNodeId}
                onSelectEdge={selectEdge}
                onUseNodeAsAnchor={useNodeAsAnchor}
                onPromoteSnippet={submitSnippetPromotion}
                ctx={ctx}
                {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
              />
            ) : subMode === 'orbital' ? (
              <OrbitalCenter
                result={filteredPanelResult ?? result}
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
                  filteredFlowSubgraph.nodes.length > 0
                    ? filteredFlowSubgraph.nodes
                    : (filteredPanelResult ?? result).snapshot.nodes;
                const flowEdges =
                  filteredFlowSubgraph.edges.length > 0
                    ? filteredFlowSubgraph.edges
                    : (filteredPanelResult ?? result).snapshot.edges;
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
                    highlightedVisitId={timelineHoverNodeId}
                    onNodeClick={(visitId) => {
                      setSelectedEdge(null);
                      setWhyVisitId(visitId);
                    }}
                  />
                );
              })()
            ) : subMode === 'focus' ? (
              <FocusView
                topics={displayedFocusData.topics}
                visitsByTopic={displayedFocusData.visitsByTopic}
                engagementClassesByVisit={displayedFocusData.engagementClassesByVisit}
                eligibleVisitCount={renderedFocusEligibleVisitCount}
                previousTopicCount={displayedFocusData.previousTopicCount}
                emptyDetail={renderedFocusEmptyDetail}
                workstreamOptions={workstreamOptions}
                suggestedCandidatesByTopic={suggestedFocusCandidatesByTopic}
                recentCandidates={recentFocusCandidates}
                allowTriageTopicCards={resolvedAnchorId.startsWith('topic:')}
                resolving={topicAnchorShadowResolving}
                onTopicPromote={submitTopicPromote}
                onTopicRename={submitTopicRename}
                onTopicDismiss={submitTopicDismiss}
                onFocusGroupSave={onSaveFocusGroup === undefined ? undefined : submitFocusGroupSave}
                {...(resolvedAnchorId.startsWith('timeline-visit:')
                  ? { anchorVisitId: resolvedAnchorId }
                  : {})}
                onVisitMarkNotRelated={submitVisitMarkNotRelated}
                onVisitRestoreToTopic={submitVisitRestoreToTopic}
                onVisitConfirmRelated={submitVisitConfirmRelated}
                onEngagementRelabel={submitEngagementRelabel}
                onTopicClick={(topicId) => {
                  // Same rationale as useNodeAsAnchor — don't dump
                  // the raw topic id into the advanced anchor input.
                  history.navigate(topicId);
                }}
                onTopicAnchor={({ topicId, label }) => {
                  navigateToAnchor(topicId, label);
                }}
                onVisitClick={(visitId) => {
                  setWhyVisitId(visitId);
                }}
                {...(onOpenUrl === undefined ? {} : { onVisitOpen: onOpenUrl })}
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
                  Choose a workstream on the left, click a recent anchor, or paste a node id — the
                  graph around it appears here. Press <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>Alt</kbd>+
                  <kbd>→</kbd> to navigate anchor history.
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
        {subMode === 'search' || subMode === 'dejavu' ? null : (
          <aside className={'cx-col-r' + (rightPanelOpen ? '' : ' is-collapsed')}>
            <button
              type="button"
              className="cx-rightpanel-toggle cx-mono cx-dim"
              onClick={() => {
                setRightPanelOpen((v) => !v);
              }}
              aria-expanded={rightPanelOpen}
              data-testid="connections-rightpanel-toggle"
            >
              <span className="cx-rail-toggle-icon" aria-hidden>
                {rightPanelOpen ? '▸' : '◂'}
              </span>
              <span className="cx-rail-toggle-label">Anchor summary</span>
            </button>
            <div className="cx-section cx-section-last cx-section-padded">
              {whyVisitId !== null && result !== null ? (
                <WhyRelatedPanel
                  fromVisitId={whyVisitId}
                  reasons={reasonsForVisit(
                    whyReasonNodes,
                    whyReasonEdges,
                    whyVisitId,
                    whyReasonCtx,
                  )}
                  showOnlyUserAsserted={whyAssertedOnly}
                  feedback={
                    whyFeedbackEdge === null
                      ? undefined
                      : {
                          label: 'relation',
                          onFeedback: (choice) => submitFlowFeedback(whyFeedbackEdge, choice),
                        }
                  }
                  producedBy={whyPanelRevisionEdge?.producedBy}
                  producerLabel={whyPanelRevisionEdge?.kind}
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
                  {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
                />
              ) : (
                <ProvenanceEmpty
                  anchor={anchorDisplayNode}
                  ctx={ctx}
                  {...(onOpenUrl === undefined ? {} : { onOpenUrl })}
                />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
};
