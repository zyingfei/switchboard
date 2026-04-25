import type {
  MockChatPageMessage,
  MockChatPageResponse,
  MockChatProvider,
} from '../adapters/mockChatAdapter';
import { createId } from '../shared/ids';

type ReadyMessage = {
  type: 'MOCK_CHAT_PORT_READY';
  runId: string;
  provider: MockChatProvider;
  tabId: number;
};

type ResponseMessage = {
  type: 'MOCK_CHAT_PORT_RESPONSE';
  requestId: string;
  response: MockChatPageResponse;
};

type PortMessage = ReadyMessage | ResponseMessage;

interface RegisteredPort {
  port: chrome.runtime.Port;
  runId: string;
  provider: MockChatProvider;
  tabId: number;
}

const isReadyMessage = (value: unknown): value is ReadyMessage =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'MOCK_CHAT_PORT_READY' &&
  typeof (value as { runId?: unknown }).runId === 'string' &&
  typeof (value as { tabId?: unknown }).tabId === 'number';

const isResponseMessage = (value: unknown): value is ResponseMessage =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'MOCK_CHAT_PORT_RESPONSE' &&
  typeof (value as { requestId?: unknown }).requestId === 'string';

export interface MockChatPortRegistry {
  bind(port: chrome.runtime.Port): void;
  waitForTab(tabId: number, timeoutMs?: number): Promise<RegisteredPort>;
  sendMessage(tabId: number, message: MockChatPageMessage, timeoutMs?: number): Promise<MockChatPageResponse>;
}

export const createMockChatPortRegistry = (): MockChatPortRegistry => {
  const portsByTab = new Map<number, RegisteredPort>();
  const waiters = new Map<number, Set<(port: RegisteredPort) => void>>();
  const pendingResponses = new Map<string, (response: MockChatPageResponse) => void>();

  const notifyWaiters = (registered: RegisteredPort) => {
    const tabWaiters = waiters.get(registered.tabId);
    if (!tabWaiters) {
      return;
    }
    for (const resolve of tabWaiters) {
      resolve(registered);
    }
    waiters.delete(registered.tabId);
  };

  return {
    bind(port) {
      port.onMessage.addListener((message: PortMessage) => {
        if (isReadyMessage(message)) {
          const registered = {
            port,
            runId: message.runId,
            provider: message.provider,
            tabId: message.tabId,
          } satisfies RegisteredPort;
          portsByTab.set(message.tabId, registered);
          notifyWaiters(registered);
          return;
        }
        if (isResponseMessage(message)) {
          const resolve = pendingResponses.get(message.requestId);
          if (resolve) {
            pendingResponses.delete(message.requestId);
            resolve(message.response);
          }
        }
      });
      port.onDisconnect.addListener(() => {
        for (const [tabId, registered] of portsByTab.entries()) {
          if (registered.port === port) {
            portsByTab.delete(tabId);
          }
        }
      });
    },
    waitForTab(tabId, timeoutMs = 5_000) {
      const existing = portsByTab.get(tabId);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        let wrappedResolve: ((registered: RegisteredPort) => void) | null = null;
        const timer = setTimeout(() => {
          const tabWaiters = waiters.get(tabId);
          if (wrappedResolve) {
            tabWaiters?.delete(wrappedResolve);
          }
          reject(new Error(`Mock chat tab did not connect: ${tabId}`));
        }, timeoutMs);
        wrappedResolve = (registered: RegisteredPort) => {
          clearTimeout(timer);
          resolve(registered);
        };
        const tabWaiters = waiters.get(tabId) ?? new Set();
        tabWaiters.add(wrappedResolve);
        waiters.set(tabId, tabWaiters);
      });
    },
    async sendMessage(tabId, message, timeoutMs = 5_000) {
      const registered = await this.waitForTab(tabId, timeoutMs);
      const requestId = createId('mockreq');
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResponses.delete(requestId);
          reject(new Error(`Mock chat did not answer ${message.type}`));
        }, timeoutMs);
        pendingResponses.set(requestId, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        registered.port.postMessage({
          type: 'MOCK_CHAT_PORT_REQUEST',
          requestId,
          message,
        });
      });
    },
  };
};
