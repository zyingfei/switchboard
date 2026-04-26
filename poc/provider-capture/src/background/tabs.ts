import type { ActiveTabSummary } from '../capture/model';
import { detectProviderFromUrl, isLikelyCaptureUrl, isSupportedProvider } from '../capture/providerDetection';

const isExtensionUi = (url: string): boolean =>
  url.startsWith('chrome-extension://') || url.includes('/sidepanel.html');

const isBrowserInternal = (url: string): boolean =>
  url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('about:') || url.startsWith('devtools://');

export const isCaptureCandidateTab = (tab: chrome.tabs.Tab): boolean =>
  typeof tab.id === 'number' &&
  Boolean(tab.url) &&
  !isExtensionUi(tab.url ?? '') &&
  !isBrowserInternal(tab.url ?? '');

export const getCaptureCandidateTab = async (): Promise<chrome.tabs.Tab | null> => {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = activeTabs.find(isCaptureCandidateTab);
  if (active) {
    return active;
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  return (
    tabs
      .filter(isCaptureCandidateTab)
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ?? null
  );
};

export const summarizeTab = (tab: chrome.tabs.Tab | null): ActiveTabSummary | null => {
  if (!tab?.url) {
    return null;
  }

  const provider = detectProviderFromUrl(tab.url);
  const likelyCaptureUrl = isLikelyCaptureUrl(tab.url);
  const supported = isSupportedProvider(provider) || likelyCaptureUrl;
  return {
    id: tab.id,
    provider,
    supported,
    title: tab.title || 'Untitled page',
    url: tab.url,
    reason: supported
      ? undefined
      : 'Open ChatGPT, Claude, Gemini, or a local browser fixture tab.',
  };
};
