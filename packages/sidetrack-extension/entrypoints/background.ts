import { defineBackground } from 'wxt/utils/define-background';

import { captureGenericTab } from '../src/capture/genericFallback';
import { detectProviderFromUrl } from '../src/capture/providerDetection';
import { createCompanionClient } from '../src/companion/client';
import type {
  CaptureEvent,
  QueueCreate,
  ReminderCreate,
  ThreadUpsert,
  WorkstreamCreate,
  WorkstreamUpdate,
} from '../src/companion/model';
import { drainQueue, enqueueCapture } from '../src/companion/queue';
import {
  isContentResponse,
  isRuntimeRequest,
  messageTypes,
  type RuntimeRequest,
  type RuntimeResponse,
} from '../src/messages';
import type { TrackedThread, WorkboardState } from '../src/workboard';
import {
  buildWorkboardState,
  createLocalQueueItem,
  createLocalReminder,
  createLocalWorkstream,
  readThreads,
  readSettings,
  recordSelectorCanary,
  saveCompanionSettings,
  saveCollapsedSections,
  updateLocalReminder,
  updateLocalWorkstream,
  upsertLocalThread,
} from '../src/background/state';

const activeTab = async (): Promise<chrome.tabs.Tab | undefined> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const snapshotFromTab = (tab: chrome.tabs.Tab, capturedAt: string) => {
  const url = tab.url ?? '';
  return {
    ...(typeof tab.id === 'number' ? { tabId: tab.id } : {}),
    ...(typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {}),
    url,
    title: tab.title ?? url,
    ...(tab.favIconUrl === undefined ? {} : { favIconUrl: tab.favIconUrl }),
    capturedAt,
  };
};

const idempotencyKey = (prefix: string, value: string): string =>
  `${prefix}-${value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)}`;

const hostFromUrl = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'current tab';
  }
};

const notifyCaptureSuccess = async (event: CaptureEvent): Promise<void> => {
  await chrome.runtime
    .sendMessage({
      type: messageTypes.captureFeedback,
      host: hostFromUrl(event.threadUrl),
    })
    .catch(() => undefined);
};

const sendToCompanion = async (
  event: CaptureEvent,
): Promise<{ readonly bac_id: string; readonly revision: string }> => {
  const settings = await readSettings();
  const existingThread = (await readThreads()).find(
    (thread) => thread.threadUrl === event.threadUrl,
  );
  const client = createCompanionClient(settings.companion);
  const eventResult = await client.appendEvent(
    event,
    idempotencyKey('capture', `${event.threadUrl}-${event.capturedAt}`),
  );
  const thread: ThreadUpsert = {
    bac_id: eventResult.bac_id,
    provider: event.provider,
    threadId: event.threadId,
    threadUrl: event.threadUrl,
    title: event.title ?? event.threadUrl,
    lastSeenAt: event.capturedAt,
    status: event.turns.length > 0 ? 'active' : 'needs_organize',
    trackingMode: event.provider === 'unknown' ? 'manual' : 'auto',
    tags: [],
    tabSnapshot: event.tabSnapshot,
  };
  const threadResult = await client.upsertThread(thread);
  await upsertLocalThread(thread, threadResult);
  const lastTurn = event.turns.at(-1);
  if (existingThread !== undefined && lastTurn?.role === 'assistant') {
    const reminder: ReminderCreate = {
      threadId: threadResult.bac_id,
      provider: event.provider,
      detectedAt: event.capturedAt,
      status: 'new',
    };
    const reminderResult = await client.createReminder(reminder);
    await createLocalReminder(reminder, reminderResult);
  }
  await recordSelectorCanary(event);
  return threadResult;
};

const captureFromContentScript = async (tab: chrome.tabs.Tab): Promise<CaptureEvent> => {
  if (typeof tab.id !== 'number') {
    throw new Error('Current tab has no tab id.');
  }

  const response = (await chrome.tabs.sendMessage(tab.id, {
    type: messageTypes.captureVisibleThread,
  })) as unknown;

  if (!isContentResponse(response)) {
    throw new Error('Content script returned an invalid capture response.');
  }

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.capture;
};

const storeCaptureEvent = async (event: CaptureEvent): Promise<void> => {
  try {
    await sendToCompanion(event);
  } catch {
    await enqueueCapture(event);
    await upsertLocalThread({
      provider: event.provider,
      threadId: event.threadId,
      threadUrl: event.threadUrl,
      title: event.title ?? event.threadUrl,
      lastSeenAt: event.capturedAt,
      status: 'needs_organize',
      trackingMode: event.provider === 'unknown' ? 'manual' : 'auto',
      tags: [],
      tabSnapshot: event.tabSnapshot,
    });
  }
};

const captureTab = async (): Promise<void> => {
  const tab = await activeTab();
  if (!tab) {
    throw new Error('No active tab is available.');
  }

  const capturedAt = new Date().toISOString();
  const baseCapture = await captureFromContentScript(tab).catch(() =>
    captureGenericTab(
      {
        url: tab.url,
        title: tab.title,
        favIconUrl: tab.favIconUrl,
      },
      capturedAt,
    ),
  );
  const event: CaptureEvent = {
    ...baseCapture,
    tabSnapshot: snapshotFromTab(tab, baseCapture.capturedAt),
  };

  await storeCaptureEvent(event);
};

const replayQueuedCaptures = async (): Promise<void> => {
  const settings = await readSettings();
  if (settings.companion.bridgeKey.length === 0) {
    return;
  }

  await drainQueue(async (event) => {
    await sendToCompanion(event);
  });
};

const assertCompanionReachable = async (): Promise<'connected' | 'vault-error'> => {
  const settings = await readSettings();
  if (settings.companion.bridgeKey.length === 0) {
    throw new Error('Paste the companion bridge key to connect.');
  }
  const status = await createCompanionClient(settings.companion).status();
  return status.vault === 'connected' ? 'connected' : 'vault-error';
};

const currentTabThread = async (): Promise<TrackedThread | undefined> => {
  const tab = await activeTab();
  const url = tab?.url;
  if (url === undefined || url.startsWith('chrome://')) {
    return undefined;
  }

  const existing = (await readThreads()).find((thread) => thread.threadUrl === url);
  if (existing !== undefined) {
    return existing;
  }

  const capturedAt = new Date().toISOString();
  return {
    bac_id: 'current_tab_preview',
    provider: detectProviderFromUrl(url),
    threadUrl: url,
    title: tab?.title ?? url,
    lastSeenAt: capturedAt,
    status: 'needs_organize',
    trackingMode: 'manual',
    tags: [],
    ...(tab === undefined ? {} : { tabSnapshot: snapshotFromTab(tab, capturedAt) }),
  };
};

const buildState = async (
  companionStatus: WorkboardState['companionStatus'],
  lastError?: string,
): Promise<WorkboardState> => ({
  ...(await buildWorkboardState(companionStatus, lastError)),
  currentTab: await currentTabThread(),
});

const withCompanionStatus = async (
  work: () => Promise<void> = () => Promise.resolve(),
): Promise<RuntimeResponse> => {
  try {
    await work();
    await replayQueuedCaptures();
    const status = await assertCompanionReachable();
    return { ok: true, state: await buildState(status) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Sidetrack background action failed.',
      state: await buildState(
        'disconnected',
        error instanceof Error ? error.message : 'Action failed.',
      ),
    };
  }
};

const createWorkstream = async (input: WorkstreamCreate): Promise<void> => {
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  const result = await client.createWorkstream(input);
  await createLocalWorkstream(input, result);
};

const updateWorkstream = async (workstreamId: string, update: WorkstreamUpdate): Promise<void> => {
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  const result = await client.updateWorkstream(workstreamId, update);
  await updateLocalWorkstream(workstreamId, update, result);
};

const createQueueItem = async (item: QueueCreate): Promise<void> => {
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  const result = await client.createQueueItem(
    item,
    idempotencyKey('queue', `${item.scope}-${item.targetId ?? 'global'}-${item.text}`),
  );
  await createLocalQueueItem(item, result);
};

const moveThread = async (threadId: string, workstreamId: string): Promise<void> => {
  const thread = (await readThreads()).find((candidate) => candidate.bac_id === threadId);
  if (!thread) {
    throw new Error('Tracked thread was not found.');
  }

  const input: ThreadUpsert = {
    bac_id: thread.bac_id,
    provider: thread.provider,
    threadId: thread.threadId,
    threadUrl: thread.threadUrl,
    title: thread.title,
    lastSeenAt: new Date().toISOString(),
    status: 'tracked',
    trackingMode: thread.trackingMode,
    primaryWorkstreamId: workstreamId,
    tags: thread.tags,
    tabSnapshot: thread.tabSnapshot,
  };
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  const result = await client.upsertThread(input);
  await upsertLocalThread(input, result);
};

const updateThreadTracking = async (
  threadId: string,
  trackingMode: ThreadUpsert['trackingMode'],
): Promise<void> => {
  const thread = (await readThreads()).find((candidate) => candidate.bac_id === threadId);
  if (!thread) {
    throw new Error('Tracked thread was not found.');
  }

  const removed = trackingMode === 'removed';
  const stopped = trackingMode === 'stopped';
  const input: ThreadUpsert = {
    bac_id: thread.bac_id,
    provider: thread.provider,
    threadId: thread.threadId,
    threadUrl: thread.threadUrl,
    title: thread.title,
    lastSeenAt: new Date().toISOString(),
    status: removed ? 'removed' : stopped ? 'closed' : 'tracked',
    trackingMode,
    primaryWorkstreamId: thread.primaryWorkstreamId,
    tags: thread.tags,
    tabSnapshot: thread.tabSnapshot,
  };
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  const result = await client.upsertThread(input);
  await upsertLocalThread(input, result);
};

const markClosedTabRestorable = async (tabId: number): Promise<void> => {
  const thread = (await readThreads()).find((candidate) => candidate.tabSnapshot?.tabId === tabId);
  if (!thread) {
    return;
  }

  await upsertLocalThread({
    bac_id: thread.bac_id,
    provider: thread.provider,
    threadId: thread.threadId,
    threadUrl: thread.threadUrl,
    title: thread.title,
    lastSeenAt: new Date().toISOString(),
    status: 'restorable',
    trackingMode: thread.trackingMode,
    primaryWorkstreamId: thread.primaryWorkstreamId,
    tags: thread.tags,
    tabSnapshot: thread.tabSnapshot,
  });
};

const restoreThreadTab = async (threadId: string): Promise<void> => {
  const thread = (await readThreads()).find((candidate) => candidate.bac_id === threadId);
  if (!thread) {
    throw new Error('Tracked thread was not found.');
  }
  await chrome.tabs.create({ url: thread.threadUrl });
};

const createReminder = async (reminder: ReminderCreate): Promise<void> => {
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  const result = await client.createReminder(reminder);
  await createLocalReminder(reminder, result);
};

const updateReminder = async (
  reminderId: string,
  update: { readonly status?: 'new' | 'seen' | 'relevant' | 'dismissed' },
): Promise<void> => {
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  const result = await client.updateReminder(reminderId, update);
  await updateLocalReminder(reminderId, update, result);
};

const handleRequest = async (request: RuntimeRequest): Promise<RuntimeResponse> => {
  if (request.type === messageTypes.selectorCanary) {
    await recordSelectorCanary({
      provider: request.report.provider,
      threadUrl: request.report.url,
      title: request.report.title,
      capturedAt: request.report.checkedAt,
      selectorCanary: request.report.selectorCanary,
      turns: [],
    });
    return { ok: true, state: await buildState('connected') };
  }

  if (request.type === messageTypes.autoCapture) {
    const response = await withCompanionStatus(() => storeCaptureEvent(request.capture));
    if (response.ok) {
      void notifyCaptureSuccess(request.capture);
    }
    return response;
  }

  if (request.type === messageTypes.getWorkboardState) {
    return await withCompanionStatus();
  }

  if (request.type === messageTypes.saveCompanionSettings) {
    await saveCompanionSettings(request.settings);
    return await withCompanionStatus();
  }

  if (request.type === messageTypes.captureCurrentTab) {
    return await withCompanionStatus(captureTab);
  }

  if (request.type === messageTypes.createWorkstream) {
    return await withCompanionStatus(() => createWorkstream(request.workstream));
  }

  if (request.type === messageTypes.updateWorkstream) {
    return await withCompanionStatus(() => updateWorkstream(request.workstreamId, request.update));
  }

  if (request.type === messageTypes.queueFollowUp) {
    return await withCompanionStatus(() => createQueueItem(request.item));
  }

  if (request.type === messageTypes.moveThread) {
    return await withCompanionStatus(() => moveThread(request.threadId, request.workstreamId));
  }

  if (request.type === messageTypes.updateThreadTracking) {
    return await withCompanionStatus(() =>
      updateThreadTracking(request.threadId, request.trackingMode),
    );
  }

  if (request.type === messageTypes.restoreThreadTab) {
    return await withCompanionStatus(() => restoreThreadTab(request.threadId));
  }

  if (request.type === messageTypes.createReminder) {
    return await withCompanionStatus(() => createReminder(request.reminder));
  }

  if (request.type === messageTypes.updateReminder) {
    return await withCompanionStatus(() => updateReminder(request.reminderId, request.update));
  }

  await saveCollapsedSections(request.collapsedSections);
  return await withCompanionStatus();
};

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void markClosedTabRestorable(tabId).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: RuntimeResponse) => void) => {
      if (!isRuntimeRequest(message)) {
        return undefined;
      }

      void handleRequest(message)
        .then(sendResponse)
        .catch(async (error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Sidetrack request failed.',
            state: await buildState(
              'disconnected',
              error instanceof Error ? error.message : 'Request failed.',
            ),
          });
        });
      return true;
    },
  );

  void replayQueuedCaptures().catch(() => undefined);

  return { name: 'sidetrack-background' };
});
