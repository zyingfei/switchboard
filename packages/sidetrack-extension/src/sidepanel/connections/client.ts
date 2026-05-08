import { messageTypes } from '../../messages';
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
