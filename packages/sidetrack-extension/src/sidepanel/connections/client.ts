import { messageTypes } from '../../messages';
import type { ContextPackInput } from './contextPack';
import { topicLabel, type TopicLabelResult } from './topicLabel';
import type { ConnectionEdge, ConnectionsScopedResult } from './types';
import type { Reason } from './why-related/reasons';

// Side-panel client for the Connections HTTP routes. Background.ts
// proxies to the companion (via the bridge key + port settings)
// with a 30 s TTL cache; this client just serializes the
// chrome.runtime.sendMessage and casts the response.
//
// Honest result shape: every call returns either a successful
// envelope or { ok: false, error } so the UI can render
// partial-data states (UC7 from the PRD).

export interface ConnectionsClientResponse<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
}

export const USER_ORGANIZED_ITEM = 'user.organized.item' as const;
export const USER_ENGAGEMENT_RELABELED = 'user.engagement.relabeled' as const;
export const USER_FLOW_CONFIRMED = 'user.flow.confirmed' as const;
export const USER_FLOW_REJECTED = 'user.flow.rejected' as const;
export const USER_TOPIC_RENAMED = 'user.topic.renamed' as const;
export const USER_SNIPPET_PROMOTED = 'user.snippet.promoted' as const;

export type UserOrganizedItemKind = 'thread' | 'workstream' | 'visit' | 'topic' | 'snippet';
export type UserOrganizedItemAction = 'move' | 'merge' | 'split' | 'rename' | 'promote' | 'ignore';
export type UserEngagementClass =
  | 'parked_background'
  | 'glanced'
  | 'skimmed'
  | 'engaged_read'
  | 'worked_on_reference'
  | 'source_extracted'
  | 'execution_source';
export type UserFlowRelationKind =
  | 'closest_visit'
  | 'visit_resembles_visit'
  | 'visit_continues_visit';
export type UserFlowRejectionReason =
  | 'not-related'
  | 'wrong-order'
  | 'stale'
  | 'duplicate'
  | 'other';

export interface UserOrganizedItemPayload {
  readonly payloadVersion: 1;
  readonly itemKind: UserOrganizedItemKind;
  readonly itemId: string;
  readonly action: UserOrganizedItemAction;
  readonly fromContainer?: string;
  readonly toContainer?: string;
  readonly details?: {
    readonly rename?: string;
    readonly mergeMembers?: readonly string[];
    readonly splitInto?: readonly string[];
  };
}

export interface UserEngagementRelabeledPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly fromClass: UserEngagementClass;
  readonly toClass: UserEngagementClass;
}

export interface UserFlowConfirmedPayload {
  readonly payloadVersion: 1;
  readonly relationKind: UserFlowRelationKind;
  readonly fromId: string;
  readonly toId: string;
}

export interface UserFlowRejectedPayload extends UserFlowConfirmedPayload {
  readonly reason?: UserFlowRejectionReason;
}

export interface UserTopicRenamedPayload {
  readonly payloadVersion: 1;
  readonly topicId: string;
  readonly previousName: string;
  readonly newName: string;
  readonly source: 'inline' | 'bulk-edit' | 'import';
}

export interface UserSnippetPromotedPayload {
  readonly payloadVersion: 1;
  readonly snippetId: string;
  readonly targetKind: 'source' | 'note' | 'thread' | 'workstream';
  readonly targetId: string;
  readonly sourceVisitId?: string;
}

export type FeedbackEventEnvelope =
  | { readonly type: typeof USER_ORGANIZED_ITEM; readonly payload: UserOrganizedItemPayload }
  | {
      readonly type: typeof USER_ENGAGEMENT_RELABELED;
      readonly payload: UserEngagementRelabeledPayload;
    }
  | { readonly type: typeof USER_FLOW_CONFIRMED; readonly payload: UserFlowConfirmedPayload }
  | { readonly type: typeof USER_FLOW_REJECTED; readonly payload: UserFlowRejectedPayload }
  | { readonly type: typeof USER_TOPIC_RENAMED; readonly payload: UserTopicRenamedPayload }
  | { readonly type: typeof USER_SNIPPET_PROMOTED; readonly payload: UserSnippetPromotedPayload };

export interface FeedbackPostResult {
  readonly accepted?: unknown;
}

interface SendMessage {
  (message: unknown): Promise<unknown>;
}

const sendMessage = (input: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(input, (response: unknown) => {
        const lastError = chrome.runtime.lastError;
        if (lastError !== undefined && lastError !== null) {
          reject(new Error(lastError.message ?? 'runtime.sendMessage failed'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

let sendMessageImpl: SendMessage = sendMessage;

// Test seam — production code never calls this.
export const setConnectionsClientTransportForTests = (impl: SendMessage | null): void => {
  sendMessageImpl = impl ?? sendMessage;
};

const call = async <T>(
  type: string,
  body: Record<string, unknown>,
): Promise<ConnectionsClientResponse<T>> => {
  try {
    const reply = await sendMessageImpl({ type, ...body });
    if (reply !== null && typeof reply === 'object' && 'ok' in reply) {
      return reply as ConnectionsClientResponse<T>;
    }
    return { ok: false, error: 'malformed response' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const stableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

export const feedbackClientEventId = (event: FeedbackEventEnvelope): string =>
  `feedback-${event.type}-${stableHash(JSON.stringify(event.payload))}`;

export const feedbackRelationKindForEdgeKind = (edgeKind: string): UserFlowRelationKind | null =>
  edgeKind === 'closest_visit' ||
  edgeKind === 'visit_resembles_visit' ||
  edgeKind === 'visit_continues_visit'
    ? edgeKind
    : null;

export const postFeedbackEvent = (
  event: FeedbackEventEnvelope,
): Promise<ConnectionsClientResponse<FeedbackPostResult>> =>
  call(messageTypes.postConnectionsFeedbackEvent, {
    event,
    clientEventId: feedbackClientEventId(event),
  });

export const postUserFlowConfirmed = (
  payload: Omit<UserFlowConfirmedPayload, 'payloadVersion'>,
): Promise<ConnectionsClientResponse<FeedbackPostResult>> =>
  postFeedbackEvent({
    type: USER_FLOW_CONFIRMED,
    payload: { payloadVersion: 1, ...payload },
  });

export const postUserFlowRejected = (
  payload: Omit<UserFlowRejectedPayload, 'payloadVersion'>,
): Promise<ConnectionsClientResponse<FeedbackPostResult>> =>
  postFeedbackEvent({
    type: USER_FLOW_REJECTED,
    payload: { payloadVersion: 1, ...payload },
  });

export const postUserTopicRenamed = (
  payload: Omit<UserTopicRenamedPayload, 'payloadVersion' | 'source'> & {
    readonly source?: UserTopicRenamedPayload['source'];
  },
): Promise<ConnectionsClientResponse<FeedbackPostResult>> =>
  postFeedbackEvent({
    type: USER_TOPIC_RENAMED,
    payload: { payloadVersion: 1, source: 'inline', ...payload },
  });

export const postUserSnippetPromoted = (
  payload: Omit<UserSnippetPromotedPayload, 'payloadVersion' | 'targetKind'> & {
    readonly targetKind?: UserSnippetPromotedPayload['targetKind'];
  },
): Promise<ConnectionsClientResponse<FeedbackPostResult>> =>
  postFeedbackEvent({
    type: USER_SNIPPET_PROMOTED,
    payload: { payloadVersion: 1, targetKind: 'source', ...payload },
  });

export const postUserOrganizedItem = (
  payload: Omit<UserOrganizedItemPayload, 'payloadVersion'>,
): Promise<ConnectionsClientResponse<FeedbackPostResult>> =>
  postFeedbackEvent({
    type: USER_ORGANIZED_ITEM,
    payload: { payloadVersion: 1, ...payload },
  });

export const postUserEngagementRelabeled = (
  payload: Omit<UserEngagementRelabeledPayload, 'payloadVersion'>,
): Promise<ConnectionsClientResponse<FeedbackPostResult>> =>
  postFeedbackEvent({
    type: USER_ENGAGEMENT_RELABELED,
    payload: { payloadVersion: 1, ...payload },
  });

export const fetchConnectionsSnapshot = (
  filters: { workstreamId?: string; nodeKind?: string; edgeKind?: string } = {},
): Promise<ConnectionsClientResponse<ConnectionsScopedResult>> =>
  call(messageTypes.loadConnectionsSnapshot, { filters });

export const fetchConnectionsNeighbors = (input: {
  nodeId: string;
  hops?: number;
}): Promise<ConnectionsClientResponse<ConnectionsScopedResult>> =>
  call(messageTypes.loadConnectionsNeighbors, input);

export const fetchConnectionsEdge = (
  edgeId: string,
): Promise<ConnectionsClientResponse<ConnectionEdge>> =>
  call<ConnectionEdge | { readonly edge?: ConnectionEdge }>(messageTypes.loadConnectionsEdge, {
    edgeId,
  }).then((response) => {
    if (!response.ok || response.data === undefined) {
      return response as ConnectionsClientResponse<ConnectionEdge>;
    }
    if ('edge' in response.data && response.data.edge !== undefined) {
      return { ok: true, data: response.data.edge };
    }
    return response as ConnectionsClientResponse<ConnectionEdge>;
  });

const textFromMetadata = (
  metadata: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const numberFromMetadata = (
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
    score: numberFromMetadata(edge.metadata, 'score', 0),
    topContributions,
  };
};

export const contextPackInputFromConnections = (
  result: ConnectionsScopedResult,
  workstreamId: string,
): ContextPackInput => {
  const nodes = result.snapshot.nodes;
  const topicNode = nodes.find((node) => node.kind === 'topic');
  return {
    topic:
      topicNode === undefined
        ? {
            id: workstreamId,
            label: workstreamId,
            cohesion: 0,
            memberCount: 0,
          }
        : {
            id: topicNode.id,
            label: topicNode.label,
            cohesion:
              typeof topicNode.metadata['cohesion'] === 'number'
                ? topicNode.metadata['cohesion']
                : 0,
            memberCount:
              typeof topicNode.metadata['memberCount'] === 'number'
                ? topicNode.metadata['memberCount']
                : 0,
          },
    threads: nodes
      .filter((node) => node.kind === 'thread')
      .map((node) => ({
        id: node.id,
        title: node.label,
        ...(textFromMetadata(node.metadata, ['url', 'canonicalUrl']) === undefined
          ? {}
          : { url: textFromMetadata(node.metadata, ['url', 'canonicalUrl']) }),
      })),
    dispatches: nodes
      .filter((node) => node.kind === 'dispatch')
      .map((node) => ({
        id: node.id,
        title: node.label,
        ...(textFromMetadata(node.metadata, ['status']) === undefined
          ? {}
          : { status: textFromMetadata(node.metadata, ['status']) }),
      })),
    snippets: nodes
      .filter((node) => node.kind === 'snippet')
      .map((node) => ({
        id: node.id,
        rawTextStored: node.metadata['rawTextStored'] === true,
        ...(textFromMetadata(node.metadata, ['text', 'preview']) === undefined
          ? {}
          : { text: textFromMetadata(node.metadata, ['text', 'preview']) }),
        ...(textFromMetadata(node.metadata, ['hash', 'selectionHash']) === undefined
          ? {}
          : { hash: textFromMetadata(node.metadata, ['hash', 'selectionHash']) }),
      })),
    userNotes: nodes
      .filter((node) => node.kind === 'annotation')
      .map((node) => ({
        id: node.id,
        text: textFromMetadata(node.metadata, ['note', 'text', 'body']) ?? node.label,
        authoredBy: 'user' as const,
      })),
  };
};

export const topicLabelFromConnections = (
  result: ConnectionsScopedResult,
  topicId: string,
): TopicLabelResult => {
  const nodeById = new Map(result.snapshot.nodes.map((node) => [node.id, node] as const));
  const topicNode = nodeById.get(topicId);
  const members = result.snapshot.edges
    .filter((edge) => edge.kind === 'visit_in_topic' && edge.toNodeId === topicId)
    .map((edge) => nodeById.get(edge.fromNodeId))
    .filter((node) => node !== undefined)
    .map((node) => ({
      canonicalUrl: textFromMetadata(node.metadata, ['canonicalUrl', 'url']) ?? node.id,
      title: node.label,
      focusedWindowMs: numberFromMetadata(node.metadata, 'focusedWindowMs', 0),
    }));
  const label = topicLabel({
    members,
    cohesion: topicNode === undefined ? 0 : numberFromMetadata(topicNode.metadata, 'cohesion', 0),
  });
  return topicNode === undefined || members.length > 0
    ? label
    : {
        label: topicNode.label,
        tooltip: `cohesion=${numberFromMetadata(topicNode.metadata, 'cohesion', 0).toFixed(
          2,
        )} · members=${String(numberFromMetadata(topicNode.metadata, 'memberCount', 0))}`,
      };
};

export const whyRelatedReasonsFromConnections = (
  result: ConnectionsScopedResult,
  visitId: string,
): readonly Reason[] => {
  const nodeById = new Map(result.snapshot.nodes.map((node) => [node.id, node] as const));
  const reasons: Reason[] = [];
  for (const edge of result.snapshot.edges) {
    if (edge.fromNodeId !== visitId && edge.toNodeId !== visitId) continue;
    if (edge.kind === 'timeline_same_url_as_thread') {
      const thread = nodeById.get(edge.fromNodeId === visitId ? edge.toNodeId : edge.fromNodeId);
      reasons.push({
        code: 'SAME_THREAD',
        threadId: thread?.id ?? 'thread:unknown',
        threadName: thread?.label ?? 'Unknown thread',
      });
    } else if (edge.kind === 'visit_in_topic') {
      const topic = nodeById.get(edge.toNodeId);
      reasons.push({
        code: 'SAME_TOPIC',
        topicId: edge.toNodeId,
        cohesion: topic === undefined ? 0 : numberFromMetadata(topic.metadata, 'cohesion', 0),
      });
    } else if (edge.kind === 'visit_resembles_visit') {
      reasons.push({ code: 'COSINE_ABOVE_THRESHOLD', cosine: 0.85, threshold: 0.85 });
    } else if (edge.kind === 'closest_visit') {
      const reason = rankerReasonForEdge(edge);
      if (reason !== null) reasons.push(reason);
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
    }
  }
  return reasons;
};

export const fetchConnectionsContextPackInput = async (
  workstreamId: string,
): Promise<ConnectionsClientResponse<ContextPackInput>> => {
  const response = await fetchConnectionsSnapshot({ workstreamId });
  if (!response.ok || response.data === undefined) {
    return { ok: false, error: response.error ?? 'connections snapshot unavailable' };
  }
  return {
    ok: true,
    data: contextPackInputFromConnections(response.data, workstreamId),
  };
};

export const fetchConnectionsTopicLabel = async (
  topicId: string,
): Promise<ConnectionsClientResponse<TopicLabelResult>> => {
  const response = await fetchConnectionsNeighbors({ nodeId: topicId, hops: 1 });
  if (!response.ok || response.data === undefined) {
    return { ok: false, error: response.error ?? 'connections label unavailable' };
  }
  return { ok: true, data: topicLabelFromConnections(response.data, topicId) };
};

export const fetchConnectionsWhyRelated = async (input: {
  readonly fromVisitId: string;
}): Promise<ConnectionsClientResponse<readonly Reason[]>> => {
  const response = await fetchConnectionsNeighbors({ nodeId: input.fromVisitId, hops: 1 });
  if (!response.ok || response.data === undefined) {
    return { ok: false, error: response.error ?? 'why-related unavailable' };
  }
  return { ok: true, data: whyRelatedReasonsFromConnections(response.data, input.fromVisitId) };
};
