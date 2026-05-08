import { messageTypes } from '../../messages';
import type { ContextPackInput } from './contextPack';
import type { ConnectionEdge, ConnectionsScopedResult } from './types';

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
