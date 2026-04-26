import type { ActiveTabSummary, CaptureState, ProviderCapture, TrackedThreadStatus } from '../capture/model';
import { nowIso } from '../shared/time';
import { isProviderRequest, providerMessages, type ProviderRequest, type ProviderResponse } from '../shared/messages';
import { executeInlineCapture } from './inlineCapture';
import { appendCapture, clearCaptures, readCaptures } from './storage';
import { getCaptureCandidateTab, summarizeTab } from './tabs';
import { clearSelectorHealth, getTrackedThreads, readSelectorHealth, recordSelectorCanaryCheck } from '../registry/trackedThreads';

const warningForTrackedStatus = (status: TrackedThreadStatus | undefined): string | undefined => {
  if (status === 'fallback') {
    return 'Extractor used the conservative DOM fallback on the last local canary check. Review the next capture and use clipboard fallback if needed.';
  }
  if (status === 'stale') {
    return 'Extractor may be stale for this tab. Capture and use the clipboard fallback while selectors are refreshed.';
  }
  return undefined;
};

const buildActiveTabSummary = async (tab: chrome.tabs.Tab | null): Promise<ActiveTabSummary | null> => {
  const summary = summarizeTab(tab);
  if (!summary?.supported || !summary.url || summary.provider === 'unknown') {
    return summary;
  }

  const trackedThread = (await getTrackedThreads({
    provider: summary.provider,
    threadUrl: summary.url,
    limit: 1,
  }))[0];

  if (!trackedThread) {
    return summary;
  }

  return {
    ...summary,
    trackedThreadStatus: trackedThread.status,
    captureCount: trackedThread.captureCount,
    lastTurnAt: trackedThread.lastTurnAt,
    warning: warningForTrackedStatus(trackedThread.status),
  };
};

const buildState = async (lastError: string | null = null, tab?: chrome.tabs.Tab | null): Promise<CaptureState> => ({
  captures: await readCaptures(),
  lastActiveTab: await buildActiveTabSummary(tab ?? (await getCaptureCandidateTab())),
  selectorHealth: await readSelectorHealth(),
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
    const capture = await captureWithContentScript(tab.id);

    try {
      const inlineCapture = await executeInlineCapture(tab.id);
      const artifactChars = inlineCapture.artifacts.reduce((sum, artifact) => sum + artifact.text.length, 0);
      return {
        ...capture,
        artifacts: inlineCapture.artifacts,
        visibleTextCharCount: capture.visibleTextCharCount + artifactChars,
      };
    } catch {
      return capture;
    }
  } catch {
    return await executeInlineCapture(tab.id);
  }
};

export const captureActiveTab = async (): Promise<ProviderResponse> => {
  const tab = await getCaptureCandidateTab();
  if (!tab) {
    return { ok: false, error: 'No capture-ready tab is available.', state: await buildState() };
  }

  try {
    const capture = await captureTab(tab);
    const captures = await appendCapture(capture);
    return {
      ok: true,
      capture,
      state: {
        ...(await buildState(null, tab)),
        captures,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Capture failed.',
      state: await buildState(error instanceof Error ? error.message : 'Capture failed.'),
    };
  }
};

const handleRequest = async (request: ProviderRequest): Promise<ProviderResponse> => {
  if (request.type === providerMessages.getState) {
    return { ok: true, state: await buildState() };
  }

  if (request.type === providerMessages.reset || request.type === providerMessages.clearCaptures) {
    await clearCaptures();
    return { ok: true, state: await buildState() };
  }

  if (request.type === providerMessages.clearSelectorHealth) {
    await clearSelectorHealth();
    return { ok: true, state: await buildState() };
  }

  if (request.type === providerMessages.storeCapture) {
    const captures = await appendCapture(request.capture);
    return {
      ok: true,
      capture: request.capture,
      state: {
        ...(await buildState(null, await getCaptureCandidateTab())),
        captures,
      },
    };
  }

  if (request.type === providerMessages.captureActiveTab) {
    return await captureActiveTab();
  }

  if (request.type === providerMessages.reportSelectorCanary) {
    await recordSelectorCanaryCheck(request.report);
    return { ok: true, state: await buildState() };
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
        state: await buildState(error instanceof Error ? error.message : 'Provider capture request failed.'),
      });
    });
    return true;
  };
