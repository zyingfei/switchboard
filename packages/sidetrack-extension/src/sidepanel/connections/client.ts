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
  call(messageTypes.loadConnectionsEdge, { edgeId });

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
