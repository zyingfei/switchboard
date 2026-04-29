import { defineBackground } from 'wxt/utils/define-background';

import { captureGenericTab } from '../src/capture/genericFallback';
import { detectProviderFromUrl, isProviderThreadUrl } from '../src/capture/providerDetection';
import { evaluateAutoSendPreflight } from '../src/safety/preflight';
import { createCompanionClient } from '../src/companion/client';
import { createSettingsClient } from '../src/settings/client';
import type {
  CaptureEvent,
  CodingAttachTokenCreate,
  CodingAttachTokenRecord,
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
  createLocalCaptureNote,
  createLocalQueueItem,
  createLocalReminder,
  dismissRemindersForThread,
  setThreadAutoSend,
  createLocalWorkstream,
  deleteLocalCaptureNote,
  markQueueItemsDoneFromTurns,
  readQueueItems,
  readThreads,
  readSettings,
  recordSelectorCanary,
  saveAutoTrack,
  saveCompanionSettings,
  saveCollapsedSections,
  saveVaultPath,
  updateLocalCaptureNote,
  updateLocalQueueItem,
  updateLocalReminder,
  updateLocalWorkstream,
  upsertLocalThread,
  writeCachedCodingSessions,
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

const broadcastWorkboardChanged = async (
  reason:
    | 'capture'
    | 'mutation'
    | 'companion-status'
    | 'reminder'
    | 'queue'
    | 'workstream'
    | 'thread'
    | 'settings',
): Promise<void> => {
  await chrome.runtime
    .sendMessage({ type: messageTypes.workboardChanged, reason })
    .catch(() => undefined);
};

// If the captured DOM exposed a "Branched from <Title>" hint, look it up
// against existing tracked threads. Match by URL first (exact), title
// second (case-insensitive). Returns whatever we have so the new thread
// row can show "↰ from <parentTitle>" even when the parent isn't tracked.
const resolveParentFromForkSource = (
  event: CaptureEvent,
  threads: readonly TrackedThread[],
): { readonly parentThreadId?: string; readonly parentTitle?: string } => {
  if (event.forkedFromUrl !== undefined) {
    const byUrl = threads.find((t) => t.threadUrl === event.forkedFromUrl);
    if (byUrl !== undefined) {
      return { parentThreadId: byUrl.bac_id, parentTitle: byUrl.title };
    }
  }
  if (event.forkedFromTitle !== undefined) {
    const target = event.forkedFromTitle.toLowerCase();
    const byTitle = threads.find((t) => t.title.toLowerCase() === target);
    if (byTitle !== undefined) {
      return { parentThreadId: byTitle.bac_id, parentTitle: byTitle.title };
    }
  }
  return event.forkedFromTitle === undefined ? {} : { parentTitle: event.forkedFromTitle };
};

const sendToCompanion = async (
  event: CaptureEvent,
): Promise<{ readonly bac_id: string; readonly revision: string }> => {
  const settings = await readSettings();
  const allThreads = await readThreads();
  const existingThread = allThreads.find((thread) => thread.threadUrl === event.threadUrl);
  const parentLink = resolveParentFromForkSource(event, allThreads);
  const client = createCompanionClient(settings.companion);
  const eventResult = await client.appendEvent(
    event,
    idempotencyKey('capture', `${event.threadUrl}-${event.capturedAt}`),
  );
  const trackingMode: ThreadUpsert['trackingMode'] =
    event.provider === 'unknown' || !settings.autoTrack ? 'manual' : 'auto';
  const lastTurnRole = event.turns.at(-1)?.role;
  const thread: ThreadUpsert = {
    bac_id: eventResult.bac_id,
    provider: event.provider,
    threadId: event.threadId,
    threadUrl: event.threadUrl,
    title: event.title ?? event.threadUrl,
    lastSeenAt: event.capturedAt,
    status: event.turns.length > 0 ? 'active' : 'needs_organize',
    trackingMode,
    tags: [],
    tabSnapshot: event.tabSnapshot,
    ...parentLink,
    ...(lastTurnRole === undefined ? {} : { lastTurnRole }),
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
  // Auto-resolve queued follow-ups whose text appears in the captured user
  // turns — the user copied + sent them, so the queue item is fulfilled.
  const recentUserTexts = event.turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text);
  await markQueueItemsDoneFromTurns(threadResult.bac_id, recentUserTexts);
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

const storeCaptureEventLocal = async (event: CaptureEvent): Promise<void> => {
  const allThreads = await readThreads();
  const existing = allThreads.find((t) => t.threadUrl === event.threadUrl);
  const settings = await readSettings();
  const parentLink = resolveParentFromForkSource(event, allThreads);
  const trackingMode: ThreadUpsert['trackingMode'] =
    event.provider === 'unknown' || !settings.autoTrack ? 'manual' : 'auto';
  const lastTurnRole = event.turns.at(-1)?.role;
  const upserted = await upsertLocalThread({
    provider: event.provider,
    threadId: event.threadId,
    threadUrl: event.threadUrl,
    title: event.title ?? event.threadUrl,
    lastSeenAt: event.capturedAt,
    status: event.turns.length > 0 ? 'active' : 'needs_organize',
    trackingMode,
    tags: [],
    tabSnapshot: event.tabSnapshot,
    ...parentLink,
    ...(lastTurnRole === undefined ? {} : { lastTurnRole }),
  });
  // Auto-resolve queued follow-ups whose text appears in the captured user
  // turns — same logic as sendToCompanion but for the local-only path.
  const recentUserTexts = event.turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text);
  await markQueueItemsDoneFromTurns(upserted.bac_id, recentUserTexts);
  const lastTurn = event.turns.at(-1);
  if (existing !== undefined && lastTurn?.role === 'assistant') {
    await createLocalReminder({
      threadId: existing.bac_id,
      provider: event.provider,
      detectedAt: event.capturedAt,
      status: 'new',
    });
  }
  await recordSelectorCanary(event);
};

const storeCaptureEvent = async (event: CaptureEvent): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await storeCaptureEventLocal(event);
    return;
  }
  try {
    await sendToCompanion(event);
  } catch {
    await enqueueCapture(event);
    await storeCaptureEventLocal(event);
  }
};

const captureTab = async (): Promise<void> => {
  const tab = await activeTab();
  if (!tab) {
    throw new Error('No active tab is available.');
  }
  // Reject explicit captures of known-provider URLs that aren't a chat
  // thread — e.g. claude.ai/code, chatgpt.com root, gemini.google.com
  // landing. Unknown providers fall through to the generic-fallback
  // path; the user explicitly chose to track those.
  const tabUrl = tab.url ?? '';
  const detectedProvider = detectProviderFromUrl(tabUrl);
  if (detectedProvider !== 'unknown' && !isProviderThreadUrl(detectedProvider, tabUrl)) {
    throw new Error(
      `This ${detectedProvider} page is not a chat thread. Open a specific conversation and try again.`,
    );
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

  // Explicit captureCurrentTab means the user is actively looking at
  // this thread — any pending "Unread reply" reminders for it are
  // stale (the user just read it). Dismiss them so the lifecycle pill
  // doesn't claim "Unread reply" on a thread the user is staring at.
  const allThreads = await readThreads();
  const tabThread = allThreads.find((t) => t.threadUrl === event.threadUrl);
  if (tabThread !== undefined) {
    await dismissRemindersForThread(tabThread.bac_id);
  }
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

const isCompanionConfigured = async (): Promise<boolean> => {
  const settings = await readSettings();
  return settings.companion.bridgeKey.trim().length > 0;
};

const assertCompanionReachable = async (): Promise<'connected' | 'vault-error' | 'local-only'> => {
  const settings = await readSettings();
  if (settings.companion.bridgeKey.length === 0) {
    return 'local-only';
  }
  const status = await createCompanionClient(settings.companion).status();
  return status.vault === 'connected' ? 'connected' : 'vault-error';
};

// Drains pending queue items for `threadId` into the provider chat
// one at a time, gated by the §24.10 preflight. Called after the
// user toggles autoSendEnabled=true on a thread that has pending
// items. Each item:
//
//   1. Runs `evaluateAutoSendPreflight` — drops items that fail any
//      of the four ship-blocking gates (per-thread toggle off,
//      provider not opted in, screen-share-safe on, token-budget
//      exceeded). Failed items are marked 'failed' with the reason.
//   2. Sends the wrapped text to the content script in the chat tab
//      via `messageTypes.autoSendItem`. Content script types it +
//      clicks send and waits for the AI to finish responding.
//   3. On success, the queue item is marked 'done'. On failure,
//      'failed' with the content-script error.
//
// The drain stops if any item fails — the user is signalled to look
// before the next item ships into the chat.
const runAutoSendDrain = async (threadId: string): Promise<void> => {
  const threads = await readThreads();
  const thread = threads.find((t) => t.bac_id === threadId);
  if (thread?.autoSendEnabled !== true) {
    return;
  }
  const localSettings = await readSettings();
  if (localSettings.companion.bridgeKey.trim().length === 0) {
    // Auto-send needs the companion to host the per-provider opt-in
    // settings. Local-only mode → no drain.
    return;
  }
  let companionSettings;
  try {
    companionSettings = await createSettingsClient(localSettings.companion).read();
  } catch (error) {
    console.warn(
      '[autoSend] could not fetch companion settings:',
      error instanceof Error ? error.message : error,
    );
    return;
  }
  const autoSendOptIn = companionSettings.autoSendOptIn;

  // Find the chat tab matching the thread URL — required to
  // chrome.tabs.sendMessage. If the tab isn't open we abort with a
  // failed status on the first pending item.
  const tabs = await chrome.tabs.query({ url: thread.threadUrl }).catch(() => []);
  const tabId = tabs.find((tab) => typeof tab.id === 'number')?.id;

  const pending = (await readQueueItems())
    .filter((item) => item.targetId === threadId && item.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const item of pending) {
    const provider = thread.provider;
    const verdict = evaluateAutoSendPreflight({
      text: item.text,
      provider,
      threadAutoSendEnabled: true,
      autoSendOptIn,
      screenShareSafeMode: companionSettings.screenShareSafeMode,
    });
    if (!verdict.ok) {
      // Preflight blocked — log + stop the drain so the user sees the
      // failure before more items would ship through with the same gate
      // probably failing too. Item stays 'pending' for retry after
      // they fix the underlying setting.
      console.warn(
        `[autoSend] preflight blocked for ${item.bac_id}: ${verdict.blockedBy ?? 'unknown'}`,
      );
      return;
    }
    if (tabId === undefined) {
      console.warn(
        `[autoSend] no chat tab open for ${thread.threadUrl}; user must open it`,
      );
      return;
    }
    let result: { ok: boolean; error?: string };
    try {
      const raw: unknown = await chrome.tabs.sendMessage(tabId, {
        type: messageTypes.autoSendItem,
        text: verdict.text,
        perItemTimeoutMs: 90_000,
      });
      result =
        typeof raw === 'object' && raw !== null && 'ok' in raw
          ? (raw as { ok: boolean; error?: string })
          : { ok: false, error: 'unexpected content-script response shape' };
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : 'content script unreachable',
      };
    }
    if (!result.ok) {
      console.warn(
        `[autoSend] content script send failed for ${item.bac_id}: ${result.error ?? 'unknown'}`,
      );
      return;
    }
    await updateLocalQueueItem(item.bac_id, { status: 'done' });
  }
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

type WorkboardChangeReason =
  | 'capture'
  | 'mutation'
  | 'companion-status'
  | 'reminder'
  | 'queue'
  | 'workstream'
  | 'thread'
  | 'settings';

const refreshCachedCodingSessions = async (): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await writeCachedCodingSessions([]);
    return;
  }
  const settings = await readSettings();
  try {
    const sessions = await createCompanionClient(settings.companion).listCodingSessions({});
    await writeCachedCodingSessions(sessions);
  } catch {
    // Companion unreachable — leave the cache as-is so the side panel keeps
    // showing the last-known list rather than blanking it on transient errors.
  }
};

const withCompanionStatus = async (
  work?: () => Promise<void>,
  reason?: WorkboardChangeReason,
): Promise<RuntimeResponse> => {
  try {
    if (work !== undefined) {
      await work();
    }
    await replayQueuedCaptures();
    const status = await assertCompanionReachable();
    await refreshCachedCodingSessions();
    const state = await buildState(status);
    if (work !== undefined && reason !== undefined) {
      void broadcastWorkboardChanged(reason);
    }
    return { ok: true, state };
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

const createCodingAttachToken = async (
  request: CodingAttachTokenCreate,
): Promise<CodingAttachTokenRecord> => {
  const settings = await readSettings();
  if (settings.companion.bridgeKey.length === 0) {
    throw new Error('Companion is required to create attach tokens; configure it in Settings.');
  }
  return await createCompanionClient(settings.companion).createCodingAttachToken(request);
};

const detachCodingSession = async (codingSessionId: string): Promise<void> => {
  const settings = await readSettings();
  if (settings.companion.bridgeKey.length === 0) {
    throw new Error('Companion is required to detach coding sessions.');
  }
  await createCompanionClient(settings.companion).detachCodingSession(codingSessionId);
};

const createWorkstream = async (input: WorkstreamCreate): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await createLocalWorkstream(input);
    return;
  }
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  try {
    const result = await client.createWorkstream(input);
    await createLocalWorkstream(input, result);
  } catch {
    await createLocalWorkstream(input);
  }
};

const updateWorkstream = async (workstreamId: string, update: WorkstreamUpdate): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await updateLocalWorkstream(workstreamId, update);
    return;
  }
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  try {
    const result = await client.updateWorkstream(workstreamId, update);
    await updateLocalWorkstream(workstreamId, update, result);
  } catch {
    await updateLocalWorkstream(workstreamId, update);
  }
};

const createQueueItem = async (item: QueueCreate): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await createLocalQueueItem(item);
    return;
  }
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  try {
    const result = await client.createQueueItem(
      item,
      idempotencyKey('queue', `${item.scope}-${item.targetId ?? 'global'}-${item.text}`),
    );
    await createLocalQueueItem(item, result);
  } catch {
    await createLocalQueueItem(item);
  }
};

const upsertThreadPersisted = async (input: ThreadUpsert): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await upsertLocalThread(input);
    return;
  }
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  try {
    const result = await client.upsertThread(input);
    await upsertLocalThread(input, result);
  } catch {
    await upsertLocalThread(input);
  }
};

const moveThread = async (threadId: string, workstreamId: string): Promise<void> => {
  const thread = (await readThreads()).find((candidate) => candidate.bac_id === threadId);
  if (!thread) {
    throw new Error('Tracked thread was not found.');
  }

  await upsertThreadPersisted({
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
  });
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
  const archived = trackingMode === 'archived';
  const stopped = trackingMode === 'stopped';
  await upsertThreadPersisted({
    bac_id: thread.bac_id,
    provider: thread.provider,
    threadId: thread.threadId,
    threadUrl: thread.threadUrl,
    title: thread.title,
    lastSeenAt: new Date().toISOString(),
    status: removed ? 'removed' : archived ? 'archived' : stopped ? 'closed' : 'tracked',
    trackingMode,
    primaryWorkstreamId: thread.primaryWorkstreamId,
    tags: thread.tags,
    tabSnapshot: thread.tabSnapshot,
  });
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
  if (!(await isCompanionConfigured())) {
    await createLocalReminder(reminder);
    return;
  }
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  try {
    const result = await client.createReminder(reminder);
    await createLocalReminder(reminder, result);
  } catch {
    await createLocalReminder(reminder);
  }
};

const updateReminder = async (
  reminderId: string,
  update: { readonly status?: 'new' | 'seen' | 'relevant' | 'dismissed' },
): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await updateLocalReminder(reminderId, update);
    return;
  }
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  try {
    const result = await client.updateReminder(reminderId, update);
    await updateLocalReminder(reminderId, update, result);
  } catch {
    await updateLocalReminder(reminderId, update);
  }
};

const handleRequest = async (request: RuntimeRequest): Promise<RuntimeResponse> => {
  if (request.type === messageTypes.selectorCanary) {
    // Drop canary reports for non-chat URLs on a known provider host
    // (claude.ai/code, chatgpt.com landing, etc.) — they trivially fail
    // extraction and would otherwise poison the "Provider extractor:
    // selectors may have drifted" banner with false positives.
    if (
      request.report.provider !== 'unknown' &&
      !isProviderThreadUrl(request.report.provider, request.report.url)
    ) {
      return { ok: true, state: await buildState('connected') };
    }
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
    // Defense-in-depth gate: even if a content script (or test) injects
    // an autoCapture for a non-thread URL on a known provider, drop it
    // silently rather than create a junk thread row.
    if (
      request.capture.provider !== 'unknown' &&
      !isProviderThreadUrl(request.capture.provider, request.capture.threadUrl)
    ) {
      return { ok: true, state: await buildState('connected') };
    }
    const response = await withCompanionStatus(() => storeCaptureEvent(request.capture), 'capture');
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
    return await withCompanionStatus(() => Promise.resolve(), 'settings');
  }

  if (request.type === messageTypes.captureCurrentTab) {
    return await withCompanionStatus(captureTab, 'capture');
  }

  if (request.type === messageTypes.createWorkstream) {
    return await withCompanionStatus(() => createWorkstream(request.workstream), 'workstream');
  }

  if (request.type === messageTypes.updateWorkstream) {
    return await withCompanionStatus(
      () => updateWorkstream(request.workstreamId, request.update),
      'workstream',
    );
  }

  if (request.type === messageTypes.queueFollowUp) {
    return await withCompanionStatus(() => createQueueItem(request.item), 'queue');
  }

  if (request.type === messageTypes.updateQueueItem) {
    return await withCompanionStatus(
      () => updateLocalQueueItem(request.queueItemId, request.update).then(() => undefined),
      'queue',
    );
  }

  if (request.type === messageTypes.moveThread) {
    return await withCompanionStatus(
      () => moveThread(request.threadId, request.workstreamId),
      'thread',
    );
  }

  if (request.type === messageTypes.updateThreadTracking) {
    return await withCompanionStatus(
      () => updateThreadTracking(request.threadId, request.trackingMode),
      'thread',
    );
  }

  if (request.type === messageTypes.setThreadAutoSend) {
    return await withCompanionStatus(async () => {
      await setThreadAutoSend(request.threadId, request.enabled);
      // Auto-fire the drain when the toggle flips ON. We spawn it
      // unawaited so the runtime response returns immediately — the
      // drain itself can take many seconds per item and the side
      // panel polls workboard state to see progress.
      if (request.enabled) {
        void runAutoSendDrain(request.threadId).catch(() => undefined);
      }
    }, 'thread');
  }

  if (request.type === messageTypes.restoreThreadTab) {
    return await withCompanionStatus(() => restoreThreadTab(request.threadId), 'thread');
  }

  if (request.type === messageTypes.createReminder) {
    return await withCompanionStatus(() => createReminder(request.reminder), 'reminder');
  }

  if (request.type === messageTypes.updateReminder) {
    return await withCompanionStatus(
      () => updateReminder(request.reminderId, request.update),
      'reminder',
    );
  }

  if (request.type === messageTypes.createCodingAttachToken) {
    try {
      const attachToken = await createCodingAttachToken(request.request);
      // Refresh state so the side panel sees a current snapshot before
      // it starts polling. The token isn't persisted in the cache; it's
      // returned through the response envelope below.
      await refreshCachedCodingSessions();
      const status = await assertCompanionReachable();
      const state = await buildState(status);
      return { ok: true, state, attachToken };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not create attach token.',
        state: await buildState(
          'disconnected',
          error instanceof Error ? error.message : 'Action failed.',
        ),
      };
    }
  }

  if (request.type === messageTypes.detachCodingSession) {
    return await withCompanionStatus(
      () => detachCodingSession(request.codingSessionId),
      'mutation',
    );
  }

  if (request.type === messageTypes.saveLocalPreferences) {
    return await withCompanionStatus(async () => {
      if (typeof request.preferences.autoTrack === 'boolean') {
        await saveAutoTrack(request.preferences.autoTrack);
      }
      if (typeof request.preferences.vaultPath === 'string') {
        await saveVaultPath(request.preferences.vaultPath);
      }
    }, 'settings');
  }

  if (request.type === messageTypes.createCaptureNote) {
    const note = request.note;
    return await withCompanionStatus(
      () => createLocalCaptureNote(note).then(() => undefined),
      'mutation',
    );
  }

  if (request.type === messageTypes.updateCaptureNote) {
    const { noteId, update } = request;
    return await withCompanionStatus(
      () => updateLocalCaptureNote(noteId, update).then(() => undefined),
      'mutation',
    );
  }

  if (request.type === messageTypes.deleteCaptureNote) {
    const { noteId } = request;
    return await withCompanionStatus(() => deleteLocalCaptureNote(noteId), 'mutation');
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
