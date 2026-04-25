import type { ObservedChatAdapter, ThreadRef, Turn, Unsubscribe } from './observedChat';

export type MockChatProvider = 'mock-chat-a' | 'mock-chat-b';

export interface MockChatConfig {
  id: MockChatProvider;
  title: string;
}

export const MOCK_CHAT_CONFIGS: Record<MockChatProvider, MockChatConfig> = {
  'mock-chat-a': {
    id: 'mock-chat-a',
    title: 'Mock Chat A',
  },
  'mock-chat-b': {
    id: 'mock-chat-b',
    title: 'Mock Chat B',
  },
};

export interface MockChatState {
  promptText: string;
  responseText: string;
  done: boolean;
}

export type MockChatPageMessage =
  | { type: 'MOCK_CHAT_INJECT'; text: string; send?: boolean }
  | { type: 'MOCK_CHAT_GET_STATE' };

export type MockChatPageResponse =
  | { ok: true; state: MockChatState }
  | { ok: true }
  | { ok: false; reason: string };

export type MockChatRuntimeMessage =
  | { type: 'MOCK_CHAT_TURN'; runId: string; provider: MockChatProvider; turn: Turn }
  | { type: 'MOCK_CHAT_DONE'; runId: string; provider: MockChatProvider; turn: Turn };

export interface MockChatTransport {
  sendMessage(tabId: number, message: MockChatPageMessage): Promise<MockChatPageResponse>;
  getTab(tabId: number): Promise<{ id?: number; url?: string; title?: string }>;
}

const getInput = (doc: Document): HTMLTextAreaElement | HTMLInputElement | HTMLElement | null =>
  doc.querySelector('[data-mock-chat-input]');

const getSendButton = (doc: Document): HTMLElement | null =>
  doc.querySelector('[data-mock-chat-send]');

const getResponse = (doc: Document): HTMLElement | null =>
  doc.querySelector('[data-mock-chat-response]');

export const readMockChatStateFromDom = (doc: Document): MockChatState => ({
  promptText: (getInput(doc) as HTMLTextAreaElement | null)?.value ?? getInput(doc)?.textContent ?? '',
  responseText: getResponse(doc)?.textContent ?? '',
  done: doc.body.dataset.mockChatDone === 'true',
});

export const injectIntoMockChatDom = (
  doc: Document,
  text: string,
  opts: { send?: boolean } = {},
): void => {
  const input = getInput(doc);
  if (!input) {
    throw new Error('Mock chat input not found');
  }
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  if (opts.send) {
    getSendButton(doc)?.click();
  }
};

const createChromeTransport = (): MockChatTransport => ({
  async sendMessage(tabId, message) {
    return await chrome.tabs.sendMessage(tabId, message);
  },
  async getTab(tabId) {
    return await chrome.tabs.get(tabId);
  },
});

export const createMockChatAdapter = (
  config: MockChatConfig,
  transport: MockChatTransport = createChromeTransport(),
): ObservedChatAdapter => ({
  id: config.id,
  hostMatch: ['chrome-extension://*/mock-chat.html*'],
  async detectThread(tabId) {
    const tab = await transport.getTab(tabId);
    const url = tab.url ?? '';
    if (!url.includes('mock-chat.html')) {
      return null;
    }
    return {
      tabId,
      provider: config.id,
      url,
      title: tab.title ?? config.title,
    } satisfies ThreadRef;
  },
  async injectInput(tabId, text, opts) {
    const response = await transport.sendMessage(tabId, {
      type: 'MOCK_CHAT_INJECT',
      text,
      send: opts?.send ?? false,
    });
    if (!response.ok) {
      throw new Error(response.reason);
    }
  },
  observeAssistantTurns() {
    return (() => undefined) satisfies Unsubscribe;
  },
  async detectCompletion(tabId) {
    const response = await transport.sendMessage(tabId, { type: 'MOCK_CHAT_GET_STATE' });
    return response.ok && 'state' in response ? response.state.done : false;
  },
});

export const createDomMockChatAdapter = (
  config: MockChatConfig,
  doc: Document,
): ObservedChatAdapter => ({
  id: config.id,
  hostMatch: ['about:blank'],
  async detectThread(tabId) {
    return {
      tabId,
      provider: config.id,
      url: doc.URL,
      title: config.title,
    };
  },
  async injectInput(_tabId, text, opts) {
    injectIntoMockChatDom(doc, text, opts);
  },
  observeAssistantTurns(_tabId, _cb) {
    return () => undefined;
  },
  async detectCompletion() {
    return readMockChatStateFromDom(doc).done;
  },
});

export const buildFakeAssistantResponse = (provider: MockChatProvider, promptText: string): string => {
  const title = MOCK_CHAT_CONFIGS[provider].title;
  const firstHeading = /^#\s+(.+)$/m.exec(promptText)?.[1]?.trim();
  const subject = firstHeading ? ` on "${firstHeading}"` : '';
  return `${title} response${subject}: keep the scope narrow, name the riskiest assumption, and verify the loop with automation. Prompt length: ${promptText.length}.`;
};
