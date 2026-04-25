import { normalizeProviderCapture, type CaptureState, type ProviderCapture } from '../capture/model';
import { nowIso } from '../shared/time';
import { isProviderRequest, providerMessages, type ProviderRequest, type ProviderResponse } from '../shared/messages';
import { executeInlineCapture } from './inlineCapture';
import { appendCapture, clearCaptures, readCaptures } from './storage';
import { getCaptureCandidateTab, summarizeTab } from './tabs';
import { openWorkspace } from './workspace';

const emptyState = async (lastError: string | null = null): Promise<CaptureState> => ({
  captures: await readCaptures(),
  lastActiveTab: summarizeTab(await getCaptureCandidateTab()),
  lastError,
  updatedAt: nowIso(),
});

const captureWithContentScript = async (tabId: number): Promise<ProviderCapture> => {
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: providerMessages.captureVisibleThread,
  })) as ProviderResponse;

  if (!response.ok || !('capture' in response) || !response.capture) {
    throw new Error(response.ok ? 'Content script did not return a capture.' : response.error);
  }

  return response.capture;
};

const captureTab = async (tab: chrome.tabs.Tab): Promise<ProviderCapture> => {
  if (typeof tab.id !== 'number') {
    throw new Error('Selected tab has no tab id.');
  }

  try {
    return await executeInlineCapture(tab.id);
  } catch {
    return await captureWithContentScript(tab.id);
  }
};

export const captureActiveTab = async (): Promise<ProviderResponse> => {
  const tab = await getCaptureCandidateTab();
  if (!tab) {
    return { ok: false, error: 'No capture-ready tab is available.', state: await emptyState() };
  }

  try {
    const capture = await captureTab(tab);
    const captures = await appendCapture(capture);
    return {
      ok: true,
      capture,
      state: {
        captures,
        lastActiveTab: summarizeTab(tab),
        lastError: null,
        updatedAt: nowIso(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Capture failed.',
      state: await emptyState(error instanceof Error ? error.message : 'Capture failed.'),
    };
  }
};

const handleRequest = async (request: ProviderRequest): Promise<ProviderResponse> => {
  if (request.type === providerMessages.getState) {
    return { ok: true, state: await emptyState() };
  }

  if (request.type === providerMessages.reset || request.type === providerMessages.clearCaptures) {
    await clearCaptures();
    return { ok: true, state: await emptyState() };
  }

  if (request.type === providerMessages.openWorkspace) {
    await openWorkspace();
    return { ok: true, state: await emptyState() };
  }

  if (request.type === providerMessages.storeCapture) {
    const capture = normalizeProviderCapture(request.capture);
    const captures = await appendCapture(capture);
    return {
      ok: true,
      capture,
      state: {
        captures,
        lastActiveTab: summarizeTab(await getCaptureCandidateTab()),
        lastError: null,
        updatedAt: nowIso(),
      },
    };
  }

  if (request.type === providerMessages.captureActiveTab) {
    return await captureActiveTab();
  }

  return { ok: false, error: `Unhandled request: ${request.type}` };
};

export const createMessageRouter =
  () =>
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ProviderResponse) => void,
  ): true | undefined => {
    if (!isProviderRequest(message)) {
      return undefined;
    }

    void handleRequest(message).then(sendResponse).catch(async (error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Provider capture request failed.',
        state: await emptyState(error instanceof Error ? error.message : 'Provider capture request failed.'),
      });
    });
    return true;
  };
