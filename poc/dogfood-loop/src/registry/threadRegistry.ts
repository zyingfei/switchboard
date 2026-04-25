export type RegistryProvider = 'chatgpt' | 'claude' | 'gemini' | 'mock-chat-a' | 'mock-chat-b';

export type ThreadKnowledgeStatus =
  | 'active'
  | 'waiting_on_user'
  | 'waiting_on_ai'
  | 'stale'
  | 'fallback';

export interface ThreadRegistryEntry {
  id: string;
  provider: RegistryProvider;
  title: string;
  url: string;
  tabId: number;
  lastSpeaker: 'user' | 'assistant' | 'unknown';
  status: ThreadKnowledgeStatus;
  selectorCanary: 'passed' | 'fallback' | 'unsupported';
  updatedAt: string;
}

export interface TabLike {
  id?: number;
  title?: string;
  url?: string;
  status?: string;
}

const toProvider = (value: string | null): RegistryProvider | null => {
  if (
    value === 'chatgpt' ||
    value === 'claude' ||
    value === 'gemini' ||
    value === 'mock-chat-a' ||
    value === 'mock-chat-b'
  ) {
    return value;
  }
  return null;
};

const toStatus = (value: string | null): ThreadKnowledgeStatus => {
  if (
    value === 'active' ||
    value === 'waiting_on_user' ||
    value === 'waiting_on_ai' ||
    value === 'stale'
  ) {
    return value;
  }
  return 'active';
};

const toLastSpeaker = (value: string | null): ThreadRegistryEntry['lastSpeaker'] => {
  if (value === 'user' || value === 'assistant') {
    return value;
  }
  return 'unknown';
};

export const classifyThreadTab = (tab: TabLike, updatedAt: string): ThreadRegistryEntry | null => {
  if (typeof tab.id !== 'number' || !tab.url) {
    return null;
  }
  const url = new URL(tab.url);
  if (url.pathname.endsWith('/thread-fixture.html')) {
    const provider = toProvider(url.searchParams.get('provider'));
    if (!provider) {
      return null;
    }
    return {
      id: `${provider}:${tab.id}`,
      provider,
      title: url.searchParams.get('title') || tab.title || `${provider} thread`,
      url: tab.url,
      tabId: tab.id,
      lastSpeaker: toLastSpeaker(url.searchParams.get('lastSpeaker')),
      status: toStatus(url.searchParams.get('status')),
      selectorCanary: url.searchParams.get('canary') === 'fail' ? 'fallback' : 'passed',
      updatedAt,
    };
  }
  if (url.pathname.endsWith('/mock-chat.html')) {
    const provider = toProvider(url.searchParams.get('provider'));
    if (!provider) {
      return null;
    }
    return {
      id: `${provider}:${tab.id}`,
      provider,
      title: tab.title || (provider === 'mock-chat-a' ? 'Mock Chat A' : 'Mock Chat B'),
      url: tab.url,
      tabId: tab.id,
      lastSpeaker: 'assistant',
      status: tab.status === 'complete' ? 'active' : 'waiting_on_ai',
      selectorCanary: 'passed',
      updatedAt,
    };
  }
  return null;
};

export const sortThreadRegistry = (entries: ThreadRegistryEntry[]): ThreadRegistryEntry[] =>
  [...entries].sort((left, right) => {
    const byProvider = left.provider.localeCompare(right.provider);
    return byProvider === 0 ? left.title.localeCompare(right.title) : byProvider;
  });
