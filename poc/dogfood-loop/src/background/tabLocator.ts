import type { MockChatProvider } from '../adapters/mockChatAdapter';
import type { SearchDispatch } from '../adapters/searchAdapter';
import type { RegistryProvider, ThreadKnowledgeStatus } from '../registry/threadRegistry';

export interface LocatedTab {
  tabId: number;
  url: string;
}

export const buildMockChatUrl = (provider: MockChatProvider, runId: string): string => {
  const params = new URLSearchParams({ provider, runId });
  return chrome.runtime.getURL(`mock-chat.html?${params.toString()}`);
};

export const openMockChatTab = async (
  provider: MockChatProvider,
  runId: string,
): Promise<LocatedTab> => {
  const url = buildMockChatUrl(provider, runId);
  const tab = await chrome.tabs.create({ url, active: false });
  if (typeof tab.id !== 'number') {
    throw new Error(`Could not open tab for ${provider}`);
  }
  return { tabId: tab.id, url };
};

export const focusTab = async (tabId: number): Promise<void> => {
  await chrome.tabs.update(tabId, { active: true });
};

export const getActiveTab = async (): Promise<chrome.tabs.Tab | null> => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
};

export const getDiscussionCandidateTab = async (): Promise<chrome.tabs.Tab | null> => {
  const active = await getActiveTab();
  if (active?.url && !active.url.includes('/sidepanel.html')) {
    return active;
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return (
    tabs
      .filter((tab) => tab.url && !tab.url.includes('/sidepanel.html'))
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ?? null
  );
};

export const buildThreadFixtureUrl = (
  provider: RegistryProvider,
  title: string,
  status: ThreadKnowledgeStatus,
  lastSpeaker: 'user' | 'assistant',
): string => {
  const params = new URLSearchParams({
    provider,
    title,
    status,
    lastSpeaker,
  });
  return chrome.runtime.getURL(`thread-fixture.html?${params.toString()}`);
};

export const openThreadFixtureTabs = async (): Promise<LocatedTab[]> => {
  const fixtures: Array<{
    provider: RegistryProvider;
    title: string;
    status: ThreadKnowledgeStatus;
    lastSpeaker: 'user' | 'assistant';
  }> = [
    {
      provider: 'chatgpt',
      title: 'Pricing experiment thread',
      status: 'waiting_on_user',
      lastSpeaker: 'assistant',
    },
    {
      provider: 'claude',
      title: 'Auth refactor research',
      status: 'waiting_on_ai',
      lastSpeaker: 'user',
    },
    {
      provider: 'gemini',
      title: 'Competitor scan',
      status: 'stale',
      lastSpeaker: 'assistant',
    },
  ];
  const opened: LocatedTab[] = [];
  for (const fixture of fixtures) {
    const url = buildThreadFixtureUrl(
      fixture.provider,
      fixture.title,
      fixture.status,
      fixture.lastSpeaker,
    );
    const tab = await chrome.tabs.create({ url, active: false });
    if (typeof tab.id !== 'number') {
      throw new Error(`Could not open fixture tab for ${fixture.provider}`);
    }
    opened.push({ tabId: tab.id, url });
  }
  return opened;
};

export const openSearchTab = async (dispatch: SearchDispatch): Promise<LocatedTab> => {
  const tab = await chrome.tabs.create({ url: dispatch.url, active: false });
  if (typeof tab.id !== 'number') {
    throw new Error(`Could not open tab for ${dispatch.provider}`);
  }
  return { tabId: tab.id, url: dispatch.url };
};

export const waitForTabComplete = async (
  tabId: number,
  timeoutMs = 12_000,
): Promise<chrome.tabs.Tab> => {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') {
    return current;
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener);
      try {
        resolve(await chrome.tabs.get(tabId));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Timed out waiting for tab completion'));
      }
    }, timeoutMs);

    const listener = (
      updatedTabId: number,
      changeInfo: { status?: string },
      tab: chrome.tabs.Tab,
    ) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
        return;
      }
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
};
