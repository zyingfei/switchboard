import { defineBackground } from 'wxt/utils/define-background';

import { captureGenericTab } from '../src/capture/genericFallback';
import {
  canonicalThreadUrl,
  detectProviderFromUrl,
  isProviderThreadUrl,
} from '../src/capture/providerDetection';
import {
  DEFAULT_LOCAL_CONFIG,
  runAutoSendDrain as driveAutoSendImpl,
} from '../src/companion/autoSendDrain';
import {
  bridgeKeyValidationCopy,
  validateBridgeKeyCandidate,
} from '../src/companion/bridgeKeyValidation';
import { createCompanionClient } from '../src/companion/client';
import { listPendingOffers, markStatus, upsertOffer } from '../src/codingAttach/state';
import type { CodingSurface } from '../src/codingAttach/detection';
import { createSettingsClient } from '../src/settings/client';
import type {
  CaptureEvent,
  CompanionSettings,
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
  postReviewDraftEvents,
  fetchReviewDraft,
  fetchReviewDraftChanges,
  type ReviewDraftClientConfig,
} from '../src/review/draftClient';
import { drainReviewDraftOutbox } from '../src/review/outbox';
import { createVaultChangesClient } from '../src/companion/vaultChanges';
import { createRecallClient } from '../src/companion/recallClient';
import { buildReviewFollowUpText } from '../src/review/draft';
import type { ReviewDraft } from '../src/review/types';
import {
  isContentResponse,
  isRuntimeRequest,
  messageTypes,
  type AnnotateTurnResponse,
  type ListAnnotationsByUrlResponse,
  type PublishAnnotationToChatResponse,
  type RecallQueryResponse,
  type RuntimeRequest,
  type RuntimeResponse,
} from '../src/messages';
import { createAnnotationClient } from '../src/annotation/client';
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
  markDispatchesRepliedForThread,
  markMcpAutoDispatchStarted,
  markQueueItemsDoneFromTurns,
  readCachedDispatches,
  readDispatchLinks,
  readMcpAutoDispatched,
  readQueueItems,
  readWorkstreams,
  readThreads,
  readSettings,
  recordSelectorCanary,
  saveAutoTrack,
  saveCompanionSettings,
  saveCollapsedBuckets,
  saveCollapsedSections,
  readScreenShareMode,
  saveScreenShareMode,
  saveVaultPath,
  pruneDispatchLinks,
  pruneReminders,
  reorderLocalQueueItems,
  saveNotifyOnQueueComplete,
  updateLocalCaptureNote,
  updateLocalQueueItem,
  updateLocalReminder,
  updateLocalWorkstream,
  deleteLocalWorkstream,
  upsertLocalThread,
  writeCachedCodingSessions,
  readDispatchOriginals,
  writeCachedDispatches,
  writeDispatchDiagnostic,
  writeDispatchLink,
  writeDispatchOriginal,
  writeLastDispatchTargetByThread,
  appendReviewDraftSpan as persistReviewDraftSpan,
  dropReviewDraftSpan,
  updateReviewDraft,
  setReviewDraftSpanComment,
  discardReviewDraft,
  readReviewDrafts,
  setDispatchArchived,
} from '../src/background/state';
import { createDispatchClient } from '../src/dispatch/client';
import type { DispatchEventRecord } from '../src/dispatch/types';
import { tryLinkCapturedThread } from '../src/companion/dispatchLinking';

const activeTab = async (): Promise<chrome.tabs.Tab | undefined> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

// True when the captured thread is the active tab in the currently
// focused browser window. Auto-capture should NOT create an
// "Unread reply" reminder in this case — the user is staring at
// the chat, the new turn is by definition not unread. Pre-existing
// reminders for the same thread are also dismissed so a stale pill
// doesn't linger after the user catches up.
// Try to link a freshly captured thread to a recent un-linked
// dispatch by matching the dispatch body prefix against any user
// turn. Idempotent — re-running on the same thread doesn't move an
// existing self-link. No-op if no recent dispatches.
const tryAutoLinkCapturedThread = async (
  threadId: string,
  threadProvider: CaptureEvent['provider'],
  userTurnTexts: readonly string[],
  capturedAtMs: number,
): Promise<void> => {
  const [recentDispatches, existingLinks, originalBodiesById, allThreads] = await Promise.all([
    readCachedDispatches(),
    readDispatchLinks(),
    readDispatchOriginals(),
    readThreads(),
  ]);
  if (recentDispatches.length === 0) {
    return;
  }
  // Pass the live set so the matcher can ignore "already-linked"
  // entries that point at threads no longer in storage. Without
  // this, a wiped/reassigned destination thread leaves the dispatch
  // permanently linked to a dead bac_id — exactly the symptom the
  // CDP storage dump showed: 5 of 7 dispatches with linkedTo
  // bac_ids absent from sidetrack.threads.
  const liveThreadIds = new Set(allThreads.map((t) => t.bac_id));
  const result = tryLinkCapturedThread({
    threadId,
    threadProvider,
    userTurnTexts,
    capturedAtMs,
    recentDispatches,
    existingLinks,
    originalBodiesById,
    liveThreadIds,
  });
  await writeDispatchDiagnostic({
    capturedAt: new Date(capturedAtMs).toISOString(),
    provider: threadProvider,
    matched: result.matched,
    ...(result.matched ? { dispatchId: result.dispatchId } : { reason: result.reason }),
    candidatesConsidered: result.candidatesConsidered,
    bestPrefixMatchLen: result.bestPrefixMatchLen,
  });
  if (!result.matched) {
    return;
  }
  await writeDispatchLink(result.dispatchId, threadId);
  // Forward the link into the companion vault (Phase 3). The local
  // chrome.storage map keeps rendering Recent Dispatches without a
  // round trip; the companion is the source of truth for cross-process
  // consumers (MCP `sidetrack.dispatch.await_capture`, side-panel
  // mirrors). Failures are non-fatal so a flaky companion can't break
  // capture.
  try {
    const settings = await readSettings();
    if (settings.companion.bridgeKey.trim().length > 0) {
      await createDispatchClient(settings.companion).linkDispatchToThread(
        result.dispatchId,
        threadId,
      );
    }
  } catch {
    // best-effort
  }
};

// Compare canonical forms so SPA URL drift on the active tab
// (e.g. Gemini /app/<id>?session=…) doesn't cause an exact-match
// miss against the canonical form stored on the thread record. The
// previous strict-equality check caused "Unread reply" reminders to
// keep firing on every assistant turn even when the user was
// actively reading the chat.
const userIsViewingThreadUrl = async (threadUrl: string): Promise<boolean> => {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const activeUrl = tabs[0]?.url;
    if (activeUrl === undefined) return false;
    return canonicalThreadUrl(activeUrl) === canonicalThreadUrl(threadUrl);
  } catch {
    return false;
  }
};

// Look at the currently-active tab in the focused window — if it
// matches a tracked thread that has any non-dismissed reminder,
// dismiss them. Called on tab activation/URL-change AND every
// time the side panel polls workboard state, so an idle chat
// doesn't leave a stale "Unread reply" pill behind. Returns true
// if anything changed (caller can broadcast).
const dismissRemindersForActiveTab = async (): Promise<boolean> => {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const url = tabs[0]?.url;
    if (url === undefined) {
      return false;
    }
    const thread = (await readThreads()).find((t) => t.threadUrl === url);
    if (thread === undefined) {
      return false;
    }
    const dismissed = await dismissRemindersForThread(thread.bac_id);
    return dismissed > 0;
  } catch {
    return false;
  }
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
  // Find existing thread by canonical URL — companion's
  // writeCaptureEvent always issues a fresh event-id and the old
  // exact-string match against event.threadUrl missed Gemini's SPA
  // drift (`/app/<id>` vs `/app/<id>?session=…`). Without this,
  // every capture spawned a new thread record with a new bac_id,
  // and reminders kept piling up against orphan threadIds.
  const canonicalUrl = canonicalThreadUrl(event.threadUrl);
  const existingThread = allThreads.find(
    (thread) =>
      thread.threadUrl === canonicalUrl || canonicalThreadUrl(thread.threadUrl) === canonicalUrl,
  );
  const parentLink = resolveParentFromForkSource(event, allThreads);
  const client = createCompanionClient(settings.companion);
  const eventResult = await client.appendEvent(
    event,
    idempotencyKey('capture', `${event.threadUrl}-${event.capturedAt}`),
  );
  // Tracking mode follows the GLOBAL settings.autoTrack mode.
  // When autoTrack=true, known-provider captures default to
  // 'auto' (Sidetrack auto-refreshes on every new turn). When
  // autoTrack=false, captures default to 'manual' so the row
  // exposes a Capture-now button. Unknown providers always
  // start manual — we can't auto-refresh what we don't know
  // how to scrape. Existing threads keep their mode (so an
  // operator can stop a single thread without flipping the
  // global mode).
  const trackingMode: ThreadUpsert['trackingMode'] =
    existingThread?.trackingMode ??
    (event.provider === 'unknown' || !settings.autoTrack ? 'manual' : 'auto');
  const lastTurnRole = event.turns.at(-1)?.role;
  // Prefer the per-turn modelName the enricher scraped from the
  // assistant's last response (more accurate than event-level
  // selectedModel which reflects the picker label at submit time).
  // Falls back to the event-level value when the enricher didn't
  // capture one (turn missing or non-assistant role).
  const lastTurnModel =
    event.turns
      .slice()
      .reverse()
      .find((turn) => turn.role === 'assistant' && turn.modelName !== undefined)?.modelName ??
    event.selectedModel;
  // Most recent assistant turn that flagged a research surface
  // (Deep Research on ChatGPT, Gemini Deep Research). The enricher
  // attaches `researchReport.mode` per-turn; here we hoist it to
  // the thread record so list views + the md sidecar can show
  // "Deep Research" without re-walking captured turns.
  const lastResearchMode = event.turns
    .slice()
    .reverse()
    .find((turn) => turn.role === 'assistant' && turn.researchReport !== undefined)
    ?.researchReport?.mode;
  // Reuse the existing thread's bac_id — the event-result bac_id
  // is the per-event record id, NOT a thread id. Sending it as
  // thread.bac_id was forcing the companion's upsertThread to
  // create a brand-new thread record on every capture.
  const threadBacId = existingThread?.bac_id ?? eventResult.bac_id;
  const thread: ThreadUpsert = {
    bac_id: threadBacId,
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
    ...(lastTurnModel === undefined ? {} : { selectedModel: lastTurnModel }),
    ...(lastResearchMode === undefined ? {} : { lastResearchMode }),
  };
  const threadResult = await client.upsertThread(thread);
  // Index EVERY turn of the capture event, not just the last. The
  // earlier path (only `event.turns.at(-1)`) created a slow drift
  // where the recall index trailed the event log by ~90 entries
  // until the next full rebuild — a "+ Capture" of a fresh thread
  // appeared to add only the most-recent assistant turn to recall.
  // Skip blank-text turns to mirror the rebuilder's behaviour.
  const indexableTurns = event.turns.filter(
    (turn) => typeof turn.text === 'string' && turn.text.trim().length > 0,
  );
  if (indexableTurns.length > 0) {
    void createRecallClient(settings.companion)
      .indexTurns(
        indexableTurns.map((turn) => ({
          id: `${threadResult.bac_id}:${String(turn.ordinal)}`,
          threadId: threadResult.bac_id,
          capturedAt: turn.capturedAt,
          text: turn.text,
        })),
      )
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.debug(
          '[recall] best-effort indexing failed:',
          error instanceof Error ? error.message : error,
        );
      });
  }
  await upsertLocalThread(thread, threadResult);
  const lastTurn = event.turns.at(-1);
  if (existingThread !== undefined && lastTurn?.role === 'assistant') {
    if (await userIsViewingThreadUrl(event.threadUrl)) {
      // User is staring at the chat — the new turn isn't unread.
      // Also clear any pending pill the user has already caught up on.
      await dismissRemindersForThread(threadResult.bac_id);
    } else {
      // Pin the reminder to this assistant turn's ordinal so re-
      // captures (extension reload re-injection, page refresh) of
      // the same reply get deduped instead of spawning fresh
      // "Unread reply" pills the user has already dismissed.
      const lastAssistantOrdinal = [...event.turns]
        .reverse()
        .find((t) => t.role === 'assistant')?.ordinal;
      const reminder: ReminderCreate = {
        threadId: threadResult.bac_id,
        provider: event.provider,
        detectedAt: event.capturedAt,
        status: 'new',
        ...(lastAssistantOrdinal === undefined
          ? {}
          : { lastAssistantTurnOrdinal: lastAssistantOrdinal }),
      };
      const reminderResult = await client.createReminder(reminder);
      await createLocalReminder(reminder, reminderResult);
    }
  }
  // Auto-resolve queued follow-ups whose text appears in the captured user
  // turns — the user copied + sent them, so the queue item is fulfilled.
  const recentUserTexts = event.turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text);
  await markQueueItemsDoneFromTurns(threadResult.bac_id, recentUserTexts);
  // Try to link this captured thread to a recent un-linked dispatch.
  // If the user pasted a packet body into a fresh chat on the target
  // provider, this turns "sent · pending" into "linked → <thread>"
  // on the Recent Dispatches row.
  await tryAutoLinkCapturedThread(
    threadResult.bac_id,
    event.provider,
    recentUserTexts,
    Date.parse(event.capturedAt),
  );
  // Flip 'sent' / 'pending' / 'queued' dispatches sourced from this
  // thread to 'replied' once a fresh assistant turn lands. The user
  // sees the pill update on the next side-panel poll.
  if (lastTurn?.role === 'assistant') {
    await markDispatchesRepliedForThread(threadResult.bac_id);
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

const storeCaptureEventLocal = async (event: CaptureEvent): Promise<void> => {
  const allThreads = await readThreads();
  const existing = allThreads.find((t) => t.threadUrl === event.threadUrl);
  const settings = await readSettings();
  const parentLink = resolveParentFromForkSource(event, allThreads);
  const trackingMode: ThreadUpsert['trackingMode'] =
    existing?.trackingMode ??
    (event.provider === 'unknown' || !settings.autoTrack ? 'manual' : 'auto');
  const lastTurnRole = event.turns.at(-1)?.role;
  const lastResearchMode = event.turns
    .slice()
    .reverse()
    .find((turn) => turn.role === 'assistant' && turn.researchReport !== undefined)
    ?.researchReport?.mode;
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
    ...(event.selectedModel === undefined ? {} : { selectedModel: event.selectedModel }),
    ...(lastResearchMode === undefined ? {} : { lastResearchMode }),
  });
  // Auto-resolve queued follow-ups whose text appears in the captured user
  // turns — same logic as sendToCompanion but for the local-only path.
  const recentUserTexts = event.turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => turn.text);
  await markQueueItemsDoneFromTurns(upserted.bac_id, recentUserTexts);
  await tryAutoLinkCapturedThread(
    upserted.bac_id,
    event.provider,
    recentUserTexts,
    Date.parse(event.capturedAt),
  );
  const lastTurn = event.turns.at(-1);
  if (existing !== undefined && lastTurn?.role === 'assistant') {
    if (await userIsViewingThreadUrl(event.threadUrl)) {
      await dismissRemindersForThread(existing.bac_id);
    } else {
      const lastAssistantOrdinal = lastTurn.ordinal;
      await createLocalReminder({
        threadId: existing.bac_id,
        provider: event.provider,
        detectedAt: event.capturedAt,
        status: 'new',
        lastAssistantTurnOrdinal: lastAssistantOrdinal,
      });
    }
    await markDispatchesRepliedForThread(existing.bac_id);
  }
  await recordSelectorCanary(event);
};

const storeCaptureEvent = async (
  event: CaptureEvent,
  intent: 'explicit' | 'passive' = 'passive',
): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await storeCaptureEventLocal(event);
    return;
  }
  try {
    await sendToCompanion(event);
  } catch {
    // No-data-loss policy: explicit captures get protective queue
    // handling (drop-passive on overflow, reject when fully
    // explicit). Passive captures keep drop-oldest semantics.
    const result = await enqueueCapture(event, undefined, undefined, intent);
    if (!result.accepted) {
      // The side panel surfaces this via lastQueueRejection in
      // workboard state; we still write the event into local
      // chrome.storage so the UI can show the optimistic span/turn,
      // but the user gets a clear "queue full — companion offline"
      // banner.
      await chrome.storage.local.set({
        'sidetrack.captureQueue.lastRejection': {
          reason: result.reason,
          at: new Date().toISOString(),
          threadUrl: event.threadUrl,
        },
      });
    }
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
  // Known-provider chat URL but the extractor produced zero turns —
  // the conversation hasn't mounted yet (Gemini's Angular shell can
  // lag a few seconds on a fresh nav). Refuse rather than create a
  // junk thread row; the previous behavior captured sidebar nav text
  // as an "unknown" turn and polluted the vault.
  if (baseCapture.provider !== 'unknown' && baseCapture.turns.length === 0) {
    throw new Error(
      `The ${baseCapture.provider} conversation hasn't finished loading. Wait a moment and try again.`,
    );
  }
  const event: CaptureEvent = {
    ...baseCapture,
    tabSnapshot: snapshotFromTab(tab, baseCapture.capturedAt),
  };

  // Explicit gesture — captureTab is wired to the + Capture button.
  // Drop-on-overflow becomes reject-on-overflow with a banner in
  // the side panel.
  await storeCaptureEvent(event, 'explicit');

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

const draftClientFromSettings = (settings: {
  companion: CompanionSettings;
}): ReviewDraftClientConfig | null => {
  const bridgeKey = settings.companion.bridgeKey.trim();
  if (bridgeKey.length === 0) return null;
  return {
    companionUrl: `http://127.0.0.1:${String(settings.companion.port)}`,
    bridgeKey,
  };
};

const drainReviewDraftQueue = async (): Promise<void> => {
  const settings = await readSettings();
  const config = draftClientFromSettings(settings);
  if (config === null) return;
  await drainReviewDraftOutbox(
    async (queued, idempotencyKey) => {
      const response = await postReviewDraftEvents(config, queued.threadId, [queued.event], {
        threadUrl: queued.threadUrl,
        idempotencyKey,
      });
      // Companion accepted the event — drop it from the per-thread
      // pending list so subsequent ClientEvents stop chaining `deps`
      // through it. Then mirror the server-stamped projection so the
      // next event's `baseVector` is up to date.
      const state = await import('../src/background/state');
      await state.markReviewDraftEventAccepted(queued.threadId, queued.event.clientEventId);
      await state.mirrorRemoteReviewDraft({
        threadId: response.projection.threadId,
        threadUrl: response.projection.threadUrl,
        vector: response.projection.vector,
        spans: response.projection.spans.map((span) => ({
          spanId: span.spanId,
          anchor: span.anchor,
          quote: span.quote,
          comment: span.comment,
          capturedAt: span.capturedAt,
        })),
        overall: response.projection.overall,
        verdict: response.projection.verdict,
        discarded: response.projection.discarded,
        updatedAtMs: response.projection.updatedAtMs,
      });
    },
    { ignoreBackoff: true },
  );
};

const replayQueuedCaptures = async (): Promise<void> => {
  const settings = await readSettings();
  if (settings.companion.bridgeKey.length === 0) {
    return;
  }

  // Trigger came from withCompanionStatus — the user just touched the
  // panel and we're about to verify companion reachability. Treat this
  // as a positive reconnect signal: bypass the per-item backoff so any
  // queued items from a prior offline window drain on the first try.
  // If send still fails here, the catch path resets attempts via
  // computeNextAttempt, restoring the backoff.
  await drainQueue(
    async (event) => {
      await sendToCompanion(event);
    },
    undefined,
    undefined,
    undefined,
    { ignoreBackoff: true },
  );
  // Same reconnect signal — drain queued review-draft mutations.
  await drainReviewDraftQueue().catch(() => undefined);
};

const isCompanionConfigured = async (): Promise<boolean> => {
  const settings = await readSettings();
  return settings.companion.bridgeKey.trim().length > 0;
};

const isBridgeKeyRejection = (message: string): boolean =>
  /bridge key|unauthorized|401/iu.test(message);

const normalizeCompanionSettings = (settings: CompanionSettings): CompanionSettings => ({
  bridgeKey: settings.bridgeKey.trim(),
  port: settings.port,
});

const verifyCompanionSettingsBeforeSave = async (
  settings: CompanionSettings,
): Promise<CompanionSettings> => {
  const normalized = normalizeCompanionSettings(settings);
  if (normalized.bridgeKey.length === 0) {
    return normalized;
  }

  const failure = validateBridgeKeyCandidate(normalized.bridgeKey);
  if (failure !== null) {
    throw new Error(bridgeKeyValidationCopy[failure]);
  }

  try {
    await createCompanionClient(normalized).status();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isBridgeKeyRejection(message)) {
      throw new Error(bridgeKeyValidationCopy.rejected);
    }
    throw new Error(
      `Cannot reach the companion on port ${String(
        normalized.port,
      )}. Start the companion for this vault, then try again.`,
    );
  }
  return normalized;
};

const assertCompanionReachable = async (): Promise<'connected' | 'vault-error' | 'local-only'> => {
  const settings = await readSettings();
  if (settings.companion.bridgeKey.length === 0) {
    return 'local-only';
  }
  const status = await createCompanionClient(settings.companion).status();
  return status.vault === 'connected' ? 'connected' : 'vault-error';
};

// Find the live tab that hosts a tracked thread. Try the snapshot's
// tabId first (covers the common case where the user keeps the tab
// open), then fall back to a URL match. chrome.tabs.query treats
// `url` as a match pattern, so plain literal URLs may fail to match
// when the live URL has hash/query fragments. The tabSnapshot path
// avoids that entirely.
const findTabForThread = async (thread: {
  tabSnapshot?: { tabId?: number };
  threadUrl: string;
}): Promise<{ tabId?: number; reason?: string }> => {
  const snapshotId = thread.tabSnapshot?.tabId;
  if (typeof snapshotId === 'number') {
    try {
      const tab = await chrome.tabs.get(snapshotId);
      if (typeof tab.id === 'number') {
        return { tabId: tab.id };
      }
    } catch {
      // Tab was closed; fall through to URL match.
    }
  }
  try {
    const tabs = await chrome.tabs.query({ url: thread.threadUrl });
    const found = tabs.find((tab) => typeof tab.id === 'number');
    if (found?.id !== undefined) {
      return { tabId: found.id };
    }
  } catch {
    // chrome.tabs.query rejects on invalid match patterns — fall through.
  }
  return { reason: 'Open the chat tab; auto-send needs the conversation visible to type into.' };
};

// Chrome's exact error string when sendMessage targets a tab with
// no live content script — happens when the user reloaded the
// extension but didn't reload the chat tab, so the new content
// script never injected itself into the existing page. We catch
// this specifically and recover with chrome.scripting.executeScript.
const RECEIVER_MISSING = /Receiving end does not exist/i;

const ensureContentScriptInTab = async (
  tabId: number,
): Promise<{ ok: boolean; error?: string }> => {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not inject content script.',
    };
  }
};

// One-shot auto-send into a freshly-opened tab. Used by the
// dispatchAutoSendInNewTab handler: open URL → wait for `complete` →
// inject content script → autoSendItem. The listener removes itself
// after the first matching update so we don't accumulate handlers.
//
// We give the page a 30s grace period; provider chats sometimes load
// quickly but their composer/Stop button lights up later. The
// content-script driver has its own per-item timeout (90s) which
// covers the AI's reply window.
const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const isAutoSendResult = (
  value: unknown,
): value is { readonly ok: boolean; readonly error?: string } =>
  typeof value === 'object' &&
  value !== null &&
  'ok' in value &&
  typeof (value as { readonly ok?: unknown }).ok === 'boolean';

const autoSendOnceTabReady = (tabId: number, body: string): void => {
  let cleared = false;
  const fire = (): void => {
    if (cleared) {
      return;
    }
    cleared = true;
    chrome.tabs.onUpdated.removeListener(listener);
    void (async () => {
      // Small extra delay so SPA shells finish hydrating their
      // composer (Quill / ProseMirror / Tiptap) before we type.
      await delay(1500);
      const deadline = Date.now() + 45_000;
      let lastSendError = 'unknown';
      for (;;) {
        const dispatch = await sendToContentScriptWithRecovery(tabId, {
          type: messageTypes.autoSendItem,
          text: body,
          perItemTimeoutMs: 90_000,
        });
        if (!dispatch.ok) {
          lastSendError = dispatch.error ?? 'content script transport failed';
        } else if (isAutoSendResult(dispatch.data)) {
          if (dispatch.data.ok) {
            break;
          }
          lastSendError = dispatch.data.error ?? 'provider auto-send failed';
        } else {
          lastSendError = 'content script returned an unexpected auto-send response';
        }
        if (Date.now() >= deadline) {
          console.warn('[dispatchAutoSendInNewTab] content-script send failed:', lastSendError);
          return;
        }
        await delay(750);
      }
      if (lastSendError !== 'unknown') {
        console.warn(
          '[dispatchAutoSendInNewTab] content-script send recovered after:',
          lastSendError,
        );
      }
      // Auto-capture the destination chat after auto-send completes.
      // Without this, the freshly-created chat at /app/<id> is never
      // tracked (autoTrack is off by default), the matcher in
      // dispatchLinking.ts never fires for it, and the source row in
      // Recent Dispatches stays "send to new thread" forever — even
      // across reloads. The user's report image #7 is exactly this
      // symptom. Best-effort; failures don't block.
      try {
        const tab = await chrome.tabs.get(tabId);
        const captureResp: unknown = await chrome.tabs.sendMessage(tabId, {
          type: messageTypes.captureVisibleThread,
        });
        if (isContentResponse(captureResp) && captureResp.ok) {
          await storeCaptureEvent(captureResp.capture);
          void broadcastWorkboardChanged('capture');
        } else if (isContentResponse(captureResp) && !captureResp.ok) {
          console.warn('[dispatchAutoSendInNewTab] post-send capture failed:', captureResp.error);
        }
        void tab; // noop; reserved for future tab-state checks
      } catch (error) {
        console.warn(
          '[dispatchAutoSendInNewTab] post-send capture threw:',
          error instanceof Error ? error.message : error,
        );
      }
    })();
  };
  const listener = (updatedTabId: number, changeInfo: { readonly status?: string }): void => {
    if (updatedTabId !== tabId) {
      return;
    }
    if (changeInfo.status === 'complete') {
      fire();
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
  // Safety net — if the load event never fires (cross-origin redirect,
  // service worker quirks), fall back to firing after 30s anyway. The
  // content-script driver will report a clear error to the side panel
  // if the composer isn't ready.
  setTimeout(() => {
    fire();
  }, 30_000);
};

// Send `message` to the tab's content script, recovering once from
// the receiver-missing condition by injecting content.js then
// retrying. Any other error is returned as-is.
const sendToContentScriptWithRecovery = async (
  tabId: number,
  message: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
  const attempt = async (): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    try {
      const data: unknown = await chrome.tabs.sendMessage(tabId, message);
      return { ok: true, data };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Content script is not reachable.',
      };
    }
  };

  const first = await attempt();
  if (first.ok || !RECEIVER_MISSING.test(first.error ?? '')) {
    return first;
  }
  const inject = await ensureContentScriptInTab(tabId);
  if (!inject.ok) {
    return {
      ok: false,
      error: `${first.error ?? 'Receiving end does not exist.'} Tried to recover but: ${inject.error ?? 'inject failed'}.`,
    };
  }
  return await attempt();
};

const findTabByCanonicalThreadUrl = async (
  threadUrl: string,
): Promise<chrome.tabs.Tab | undefined> => {
  const targetCanonical = canonicalThreadUrl(threadUrl);
  const allTabs = await chrome.tabs.query({});
  return allTabs.find(
    (tab) =>
      typeof tab.url === 'string' &&
      tab.id !== undefined &&
      canonicalThreadUrl(tab.url) === targetCanonical,
  );
};

const focusTabForUserVisibleSend = async (tab: chrome.tabs.Tab): Promise<void> => {
  if (typeof tab.id === 'number') {
    await chrome.tabs.update(tab.id, { active: true });
  }
  if (typeof tab.windowId === 'number') {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
};

const quoteForChat = (input: string): string =>
  input
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const buildAnnotationChatMessage = (input: {
  readonly turnText: string;
  readonly turnRole: string;
  readonly anchorText?: string;
  readonly note: string;
  readonly capturedAt: string;
}): string => {
  const quote = input.turnText.trim().slice(0, 900);
  return [
    `Sidetrack annotation on a captured ${input.turnRole} turn:`,
    '',
    quoteForChat(quote.length > 0 ? quote : '(turn text unavailable)'),
    '',
    ...(input.anchorText === undefined || input.anchorText.trim().length === 0
      ? []
      : ['Keyword / quote:', input.anchorText.trim(), '']),
    'Annotation:',
    input.note.trim(),
    '',
    `Captured by Sidetrack at ${input.capturedAt}.`,
  ].join('\n');
};

// Wires real chrome.* / network ports to the pure orchestrator in
// src/companion/autoSendDrain.ts. The orchestrator handles the
// per-item §24.10 preflight, sequencing, stop-on-failure, and the
// status / lastError transitions. See that file for flow + reasoning.
interface AutoSendDrainOutcome {
  readonly mutated: boolean;
  readonly itemsSent: number;
  readonly completed: boolean;
}

const runAutoSendDrain = async (threadId: string): Promise<AutoSendDrainOutcome> => {
  const outcome = await driveAutoSendImpl(threadId, {
    readThread: async (id) => {
      const t = (await readThreads()).find((x) => x.bac_id === id);
      if (t === undefined) {
        return undefined;
      }
      return {
        bac_id: t.bac_id,
        provider: t.provider,
        threadUrl: t.threadUrl,
        ...(t.autoSendEnabled === undefined ? {} : { autoSendEnabled: t.autoSendEnabled }),
      };
    },
    readPendingItemsForThread: async (id) => {
      return (await readQueueItems()).filter((item) => item.targetId === id);
    },
    readCompanionConfig: async () => {
      const localSettings = await readSettings();
      // The top-bar screenshare toggle (local screenShareMode) is the
      // canonical source — UNION it with the companion's settings-only
      // screenShareSafeMode so the user's expectation that "the
      // top-bar toggle controls everything" actually holds. Without
      // this, the user could disable the top-bar toggle and still see
      // "Screen-share-safe mode is on; auto-send is paused" because
      // the companion's separate setting was independently true.
      const localScreenShareOn = await readScreenShareMode();
      if (localSettings.companion.bridgeKey.trim().length === 0) {
        return {
          ...DEFAULT_LOCAL_CONFIG,
          screenShareSafeMode: DEFAULT_LOCAL_CONFIG.screenShareSafeMode || localScreenShareOn,
        };
      }
      try {
        const companionSettings = await createSettingsClient(localSettings.companion).read();
        return {
          autoSendOptIn: companionSettings.autoSendOptIn,
          screenShareSafeMode: companionSettings.screenShareSafeMode || localScreenShareOn,
        };
      } catch (error) {
        console.warn(
          '[autoSend] could not fetch companion settings; falling back to local defaults:',
          error instanceof Error ? error.message : error,
        );
        return {
          ...DEFAULT_LOCAL_CONFIG,
          screenShareSafeMode: DEFAULT_LOCAL_CONFIG.screenShareSafeMode || localScreenShareOn,
        };
      }
    },
    findTabForThread: async (t) => await findTabForThread(t),
    sendItemToTab: async (tabId, text, itemId) => {
      const dispatch = await sendToContentScriptWithRecovery(tabId, {
        type: messageTypes.autoSendItem,
        itemId,
        text,
        perItemTimeoutMs: 90_000,
      });
      if (!dispatch.ok) {
        return { ok: false, error: dispatch.error ?? 'Content script is not reachable.' };
      }
      const raw = dispatch.data;
      if (typeof raw !== 'object' || raw === null || !('ok' in raw)) {
        return { ok: false, error: 'Content script returned an unexpected response.' };
      }
      return raw as { ok: boolean; error?: string };
    },
    updateQueueItem: async (itemId, update) => {
      await updateLocalQueueItem(itemId, update);
    },
    logWarning: (message: string) => {
      console.warn(message);
    },
  });
  return {
    mutated: outcome.mutated,
    itemsSent: outcome.itemsSent,
    completed: outcome.stoppedReason === 'completed',
  };
};

// Fire-and-forget wrapper: spawns the drain unawaited and broadcasts
// the workboard once it lands so the side panel re-reads the queue.
// When the drain ships the last pending item for a thread, surface
// a system notification so the user can context-switch away while
// auto-send works through the queue (gated by notifyOnQueueComplete).
const triggerAutoSendDrain = (threadId: string): void => {
  void runAutoSendDrain(threadId)
    .then((outcome) => {
      if (outcome.mutated) {
        void broadcastWorkboardChanged('queue');
      }
      if (outcome.completed && outcome.itemsSent > 0) {
        void notifyQueueDrained(threadId, outcome.itemsSent).catch((error: unknown) => {
          console.warn('[autoSend] notify failed:', error);
        });
      }
    })
    .catch((error: unknown) => {
      console.warn('[autoSend] drain crashed:', error);
    });
};

// 1x1 transparent PNG. Chrome.notifications.create requires iconUrl
// for type 'basic'; we ship a tiny inline placeholder so the
// notification renders without an asset dependency.
const NOTIFY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const notifyQueueDrained = async (threadId: string, itemsSent: number): Promise<void> => {
  const settings = await readSettings();
  if (!settings.notifyOnQueueComplete) {
    return;
  }
  if (typeof chrome.notifications.create !== 'function') {
    return;
  }
  const thread = (await readThreads()).find((t) => t.bac_id === threadId);
  const title = thread?.title ?? 'thread';
  await new Promise<void>((resolve) => {
    chrome.notifications.create(
      `sidetrack.queue.complete.${threadId}.${String(Date.now())}`,
      {
        type: 'basic',
        iconUrl: NOTIFY_ICON_DATA_URL,
        title: 'Auto-send queue complete',
        message: `Sidetrack finished sending ${String(itemsSent)} follow-up${itemsSent === 1 ? '' : 's'} into "${title}".`,
        priority: 0,
      },
      () => {
        resolve();
      },
    );
  });
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
): Promise<WorkboardState> => {
  const tab = await activeTab();
  return {
    ...(await buildWorkboardState(companionStatus, lastError)),
    ...(tab?.url === undefined ? {} : { activeTabUrl: tab.url }),
    currentTab: await currentTabThread(),
  };
};

// Per-provider URL the auto-approved MCP dispatch flow opens to seed
// a fresh thread. ChatGPT's bare / lands on a clean composer that
// pushState's to /c/<id> on submit (the agent's body becomes the
// first user turn). If the user has been redirected to an existing
// chat, the content-script driver clicks the
// data-testid="create-new-chat-button" sidebar link first to reset.
// Probed against live chatgpt.com 2026-05; the data-testid is
// long-standing and consistent across signed-in views.
const MCP_AUTO_DISPATCH_URL: Partial<Record<DispatchEventRecord['target']['provider'], string>> = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/app',
};

const shouldAutoDispatchMcpRequest = (dispatch: DispatchEventRecord): boolean =>
  dispatch.mcpRequest?.approval === 'auto-approved' &&
  dispatch.target.mode === 'auto-send' &&
  (dispatch.status === 'sent' || dispatch.status === 'pending' || dispatch.status === 'queued') &&
  MCP_AUTO_DISPATCH_URL[dispatch.target.provider] !== undefined;

// How long an unlinked auto-dispatch can stay marked "started"
// before we retry. Generous: 5 minutes covers a slow ChatGPT
// response, the capture round-trip, and a margin for the
// tryAutoLinkCapturedThread match window (which itself runs only
// when a new capture event lands). We'd rather wait too long than
// open the same chat tab repeatedly and hammer the user's account.
const MCP_DISPATCH_STALE_RETRY_MS = 5 * 60 * 1000;

// Hard ceiling on tabs the alarm opens per tick. Even if multiple
// dispatches are eligible at once, fan out one at a time. Avoids the
// "alarm fires, two stuck dispatches retry simultaneously, two tabs
// pop, ChatGPT auto-send runs in parallel against the same account"
// failure mode that crashed the user's test browser. The remaining
// dispatches are picked up on the next tick.
const MCP_DISPATCH_MAX_PER_TICK = 1;

// Minimum gap between any two dispatch tab-opens. Even when the
// MAX_PER_TICK cap is in force, multiple call sites can invoke
// openAutoApprovedMcpDispatches in rapid succession (the alarm + the
// side panel's workboard polling + the codingAttach flow all hit
// refreshCachedDispatches). Without a cross-call cooldown, three
// pollers in one second produced one chatgpt + one claude + one
// gemini tab in one second — exactly the storm that crashed the
// developer's test browser. 30s is an arbitrary "no human-driven
// scenario should need a faster fan-out" gate.
const MCP_DISPATCH_GLOBAL_COOLDOWN_MS = 30_000;
const LAST_MCP_DISPATCH_OPENED_AT_KEY = 'sidetrack.lastMcpDispatchOpenedAt';
// In-memory single-flight is fine: it only needs to hold during one
// `openAutoApprovedMcpDispatches` invocation. The cooldown timestamp,
// in contrast, MUST persist across SW restarts (Chrome MV3 service
// workers are evicted on idle, sometimes within seconds of the
// alarm firing) — otherwise three SW restarts in 30s would defeat
// the cooldown completely.
let mcpDispatchInFlight = false;

const readLastMcpDispatchOpenedMs = async (): Promise<number> => {
  const result = await chrome.storage.local.get({ [LAST_MCP_DISPATCH_OPENED_AT_KEY]: '' });
  const value = result[LAST_MCP_DISPATCH_OPENED_AT_KEY];
  if (typeof value !== 'string' || value.length === 0) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};

const writeLastMcpDispatchOpenedMs = async (ms: number): Promise<void> => {
  await chrome.storage.local.set({
    [LAST_MCP_DISPATCH_OPENED_AT_KEY]: new Date(ms).toISOString(),
  });
};

const tabAlreadyOpenForDispatch = async (dispatchId: string): Promise<boolean> => {
  const tabs = await readMcpDispatchTabs();
  for (const [tabIdStr, owner] of Object.entries(tabs)) {
    if (owner !== dispatchId) continue;
    const tabId = Number.parseInt(tabIdStr, 10);
    if (!Number.isInteger(tabId)) continue;
    try {
      await chrome.tabs.get(tabId);
      return true; // tab still exists
    } catch {
      // Stale entry — tab was closed without firing onRemoved.
      // Drop it so a future retry can proceed.
      await dropMcpDispatchTab(tabId);
    }
  }
  return false;
};

const openAutoApprovedMcpDispatches = async (
  dispatches: readonly DispatchEventRecord[],
): Promise<void> => {
  // Single in-flight + cooldown gate. The alarm and the side panel
  // both call into this on overlapping schedules; without these
  // gates a brief flurry of polls can fan out N tabs in N seconds.
  if (mcpDispatchInFlight) {
    return;
  }
  const lastOpenedMs = await readLastMcpDispatchOpenedMs();
  if (Date.now() - lastOpenedMs < MCP_DISPATCH_GLOBAL_COOLDOWN_MS) {
    return;
  }
  mcpDispatchInFlight = true;
  try {
    await openAutoApprovedMcpDispatchesInner(dispatches);
  } finally {
    mcpDispatchInFlight = false;
  }
};

const openAutoApprovedMcpDispatchesInner = async (
  dispatches: readonly DispatchEventRecord[],
): Promise<void> => {
  const alreadyStarted = await readMcpAutoDispatched();
  const links = await readDispatchLinks();
  const nowMs = Date.now();
  let openedThisTick = 0;
  for (const dispatch of dispatches) {
    if (openedThisTick >= MCP_DISPATCH_MAX_PER_TICK) break;
    if (!shouldAutoDispatchMcpRequest(dispatch)) {
      continue;
    }
    // Defense against tab-spawn explosions: if a tab is already
    // associated with this dispatch (whether the auto-send is still
    // in flight or the user just hasn't closed it), don't open
    // another. The existing tab is either making progress or was
    // abandoned — either way, doubling up doesn't help.
    if (await tabAlreadyOpenForDispatch(dispatch.bac_id)) {
      continue;
    }
    const startedAt = alreadyStarted[dispatch.bac_id];
    if (startedAt !== undefined) {
      // Linked → handled, skip.
      if (links[dispatch.bac_id] !== undefined) continue;
      // Unlinked: was the first attempt recent enough that we should
      // wait? If yes, skip; otherwise fall through to retry.
      const startedMs = Date.parse(startedAt);
      if (Number.isFinite(startedMs) && nowMs - startedMs < MCP_DISPATCH_STALE_RETRY_MS) {
        continue;
      }
      console.warn(
        `[mcp.request_dispatch] retrying stuck dispatch ${dispatch.bac_id} (started ${startedAt}, no thread link).`,
      );
    }
    const url = MCP_AUTO_DISPATCH_URL[dispatch.target.provider];
    if (url === undefined) {
      continue;
    }
    await markMcpAutoDispatchStarted(dispatch.bac_id);
    try {
      const created = await chrome.tabs.create({ url, active: true });
      if (typeof created.id === 'number') {
        await writeMcpDispatchTab(created.id, dispatch.bac_id);
        autoSendOnceTabReady(created.id, dispatch.body);
        openedThisTick += 1;
        await writeLastMcpDispatchOpenedMs(Date.now());
      }
    } catch (error) {
      console.warn(
        '[mcp.request_dispatch] auto-approved dispatch open failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }
};

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

const refreshCachedDispatches = async (): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await writeCachedDispatches([]);
    return;
  }
  const settings = await readSettings();
  try {
    const dispatches = await createDispatchClient(settings.companion).listRecent({ limit: 20 });
    // Keep the side-panel cache merged with any local status overrides
    // already on it. Two local-only flips: 'replied' (from
    // markDispatchesRepliedForThread on capture) and 'archived' (from
    // the user's UI action via setDispatchArchived). Without this
    // merge, the next companion refresh would revert both back to
    // 'sent' on every action.
    const local = await readCachedDispatches();
    const localOverrides = new Map(
      local
        .filter((d) => d.status === 'replied' || d.status === 'archived')
        .map((d) => [d.bac_id, d.status]),
    );
    const merged = dispatches.map((d) => {
      const override = localOverrides.get(d.bac_id);
      return override === undefined ? d : { ...d, status: override };
    });
    await writeCachedDispatches(merged);
    await openAutoApprovedMcpDispatches(merged);
  } catch {
    // Companion unreachable — keep the existing cache.
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
    await refreshCachedDispatches();
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

const deleteWorkstream = async (workstreamId: string): Promise<void> => {
  // Companion-first: it owns the cascade decision (refuse on
  // children, detach threads on disk). Mirror locally on success or
  // on companion absence so the side panel reflects the state
  // immediately.
  if (!(await isCompanionConfigured())) {
    await deleteLocalWorkstream(workstreamId);
    return;
  }
  const settings = await readSettings();
  const client = createCompanionClient(settings.companion);
  await client.deleteWorkstream(workstreamId);
  await deleteLocalWorkstream(workstreamId);
};

const bulkUpdateWorkstreamPrivacy = async (
  from: WorkstreamUpdate['privacy'],
  to: WorkstreamUpdate['privacy'],
): Promise<void> => {
  if (from === undefined || to === undefined || from === to) {
    return;
  }
  const workstreams = await readWorkstreams();
  await Promise.all(
    workstreams
      .filter((workstream) => workstream.privacy === from)
      .map(async (workstream) => {
        await updateWorkstream(workstream.bac_id, {
          revision: workstream.revision,
          privacy: to,
        });
      }),
  );
};

const createQueueItem = async (item: QueueCreate): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    await createLocalQueueItem(item);
  } else {
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
  }
  // If this item targets a thread that already has Auto-send: on, the
  // user expects it to ship immediately — they don't need to flip the
  // toggle off and back on. Drain runs unawaited; the side panel sees
  // the result via the queue broadcast in triggerAutoSendDrain.
  if (item.scope === 'thread' && typeof item.targetId === 'string') {
    const targetThread = (await readThreads()).find((t) => t.bac_id === item.targetId);
    if (targetThread?.autoSendEnabled === true) {
      triggerAutoSendDrain(targetThread.bac_id);
    }
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

// Tabs opened by the auto-approved MCP dispatch flow. The first
// auto-capture that arrives from one of these tabs bypasses the
// autoTrack gate (the dispatch is an explicit user/agent action;
// requiring the user to manually flip auto-track defeats the point).
// Entries are removed once the resulting thread is tracked, so a
// later un-dispatched capture from the same tab can't piggy-back.
const MCP_DISPATCH_TABS_KEY = 'sidetrack.mcpDispatchTabs';

const readMcpDispatchTabs = async (): Promise<Readonly<Partial<Record<string, string>>>> => {
  const result = await chrome.storage.local.get({ [MCP_DISPATCH_TABS_KEY]: {} });
  const value = result[MCP_DISPATCH_TABS_KEY];
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Partial<Record<string, string>>>)
    : {};
};

const writeMcpDispatchTab = async (tabId: number, dispatchId: string): Promise<void> => {
  const current = { ...(await readMcpDispatchTabs()) };
  current[String(tabId)] = dispatchId;
  await chrome.storage.local.set({ [MCP_DISPATCH_TABS_KEY]: current });
};

const dropMcpDispatchTab = async (tabId: number): Promise<void> => {
  const current = { ...(await readMcpDispatchTabs()) };
  if (current[String(tabId)] === undefined) return;
  delete current[String(tabId)];
  await chrome.storage.local.set({ [MCP_DISPATCH_TABS_KEY]: current });
};

const handleRequest = async (
  request: RuntimeRequest,
  senderTabId?: number,
): Promise<RuntimeResponse> => {
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
    // Auto-capture gate (global + per-thread).
    //   - Global autoTrack=false: don't spawn brand-new thread
    //     records from a content-script capture. Refresh-captures
    //     for already-tracked threads still flow through.
    //   - autoTrack=true OR an existing thread is matched: still
    //     skip the refresh when that thread's mode is 'manual' or
    //     'stopped'. 'manual' means "capture only when I press the
    //     row's Capture button"; 'stopped' is the paused state.
    // Both rules carve out an exception for MCP-auto-approved
    // dispatch tabs — those represent explicit agent-driven
    // actions and the resulting thread IS the whole point.
    const settings = await readSettings();
    const dispatchTabs = await readMcpDispatchTabs();
    const isDispatchTab =
      senderTabId !== undefined && dispatchTabs[String(senderTabId)] !== undefined;
    if (!isDispatchTab) {
      const known = (await readThreads()).find((t) => t.threadUrl === request.capture.threadUrl);
      if (known === undefined) {
        if (!settings.autoTrack) {
          return { ok: true, state: await buildState('connected') };
        }
      } else if (known.trackingMode === 'manual' || known.trackingMode === 'stopped') {
        return { ok: true, state: await buildState('connected') };
      }
    }
    const response = await withCompanionStatus(() => storeCaptureEvent(request.capture), 'capture');
    if (response.ok) {
      void notifyCaptureSuccess(request.capture);
      if (isDispatchTab && senderTabId !== undefined) {
        await dropMcpDispatchTab(senderTabId);
      }
    }
    return response;
  }

  if (request.type === messageTypes.autoSendInterimReport) {
    await updateLocalQueueItem(request.itemId, { progress: request.phase });
    void broadcastWorkboardChanged('queue');
    return { ok: true, state: await buildState('connected') };
  }

  if (request.type === messageTypes.getWorkboardState) {
    // Side panel just polled for state — if the user is currently
    // staring at a tracked thread, drop any "Unread reply" pill for
    // it before we return so the panel doesn't render the stale
    // signal. Cheap; runs in parallel with the rest of the build.
    await dismissRemindersForActiveTab();
    return await withCompanionStatus();
  }

  if (request.type === messageTypes.saveCompanionSettings) {
    await saveCompanionSettings(await verifyCompanionSettingsBeforeSave(request.settings));
    return await withCompanionStatus(() => Promise.resolve(), 'settings');
  }

  if (request.type === messageTypes.captureCurrentTab) {
    return await withCompanionStatus(captureTab, 'capture');
  }

  if (request.type === messageTypes.retryFailedCaptures) {
    return await withCompanionStatus(async () => {
      const { retryFailedCaptures } = await import('../src/companion/queue');
      await retryFailedCaptures();
      // Clear the latest rejection signal — the user has acknowledged
      // the banner. Banner re-shows if the next drain produces fresh
      // failures or rejections.
      await chrome.storage.local.remove('sidetrack.captureQueue.lastRejection');
      // Drain immediately so the user sees the banner clear instead
      // of waiting for the next workboard tick.
      await replayQueuedCaptures();
    }, 'capture');
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

  if (request.type === messageTypes.deleteWorkstream) {
    return await withCompanionStatus(
      () => deleteWorkstream(request.workstreamId),
      'workstream',
    );
  }

  if (request.type === messageTypes.bulkUpdateWorkstreamPrivacy) {
    return await withCompanionStatus(
      () => bulkUpdateWorkstreamPrivacy(request.from, request.to),
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

  if (request.type === messageTypes.reorderQueueItems) {
    return await withCompanionStatus(() => reorderLocalQueueItems(request.queueItemIds), 'queue');
  }

  if (request.type === messageTypes.retryAutoSend) {
    return await withCompanionStatus(async () => {
      // Clear lastError so the row stops showing the failure note
      // immediately (the side panel re-renders before the drain
      // finishes), then re-fire the drain for the item's thread.
      const item = (await readQueueItems()).find((i) => i.bac_id === request.queueItemId);
      await updateLocalQueueItem(request.queueItemId, { lastError: null });
      if (item?.scope === 'thread' && typeof item.targetId === 'string') {
        triggerAutoSendDrain(item.targetId);
      }
    }, 'queue');
  }

  if (request.type === messageTypes.cacheDispatchOriginal) {
    // Side panel just successfully submitted a dispatch and got back
    // a bac_id. Stash the unredacted body locally so the auto-link
    // matcher can use it on the next captured user turn.
    return await withCompanionStatus(async () => {
      await writeDispatchOriginal(request.dispatchId, request.body);
    }, 'queue');
  }

  if (request.type === messageTypes.cacheLastDispatchTarget) {
    // Side panel just fired a Send-to dispatch — record the target
    // so the dropdown's "Recent" row can pre-select it next time.
    return await withCompanionStatus(async () => {
      await writeLastDispatchTargetByThread(request.threadId, request.target);
    }, 'queue');
  }

  if (request.type === messageTypes.recallQuery) {
    // Content scripts on HTTPS chat pages can't fetch http://127.0.0.1
    // directly — Chrome's mixed-content policy blocks the connection
    // even with host_permissions. The service worker (chrome-extension://
    // origin) is the one place fetches to localhost succeed reliably,
    // so we proxy the recall query through here. Returns the parsed
    // RankedItem[] (with title/snippet attached server-side) so the
    // popover can render them. On any failure we return an empty list
    // and surface the error in `error` for diagnostics.
    //
    // The cast to `unknown` and back through RecallQueryResponse keeps
    // the per-handler return type local — RuntimeResponse stays the
    // WorkboardState-bearing union for every other consumer.
    const buildRecallResponse = async (): Promise<RecallQueryResponse> => {
      try {
        const settings = await readSettings();
        const companion = settings.companion;
        if (companion.bridgeKey.trim().length === 0 || companion.port <= 0) {
          return { ok: false, items: [], error: 'Companion not configured.' };
        }
        const requestedLimit = request.limit ?? 5;
        const client = createRecallClient(companion);
        // Over-fetch so the post-filter (drop current thread + dedup
        // by threadId) still has enough rows to fill `requestedLimit`.
        // The companion clamps to 50 internally, so cap at 50.
        const fetchLimit = Math.min(50, Math.max(requestedLimit * 4, 12));
        const raw = await client.query(request.q, {
          limit: fetchLimit,
          ...(request.workstreamId === undefined ? {} : { workstreamId: request.workstreamId }),
        });
        // Cache local threads once for both the current-page filter
        // and bac_id → threadUrl fallback (older companions that
        // didn't enrich threadUrl).
        const localThreads = await readThreads();
        const threadUrlByBacId = new Map(
          localThreads.map((thread) => [thread.bac_id, thread.threadUrl]),
        );
        const currentCanonical =
          request.currentUrl !== undefined && request.currentUrl.length > 0
            ? canonicalThreadUrl(request.currentUrl)
            : '';
        const dedupKey = (item: (typeof raw)[number]): string => {
          // Prefer the server-provided threadUrl; fall back to the
          // local thread record's URL; last resort, the bac_id (so
          // stale results without any URL still dedup against
          // themselves rather than collapsing across threads).
          const url = item.threadUrl ?? threadUrlByBacId.get(item.threadId) ?? '';
          return url.length > 0 ? canonicalThreadUrl(url) : `bac:${item.threadId}`;
        };
        // Dedup by canonical URL, keeping the highest-scoring row per
        // thread. URL-based dedup catches the case where the same
        // chat got captured under multiple bac_ids before the
        // bac_id-stability fix landed (5 rows of "Hacker News
        // Summary" all from the same Gemini conversation).
        const bestPerUrl = new Map<string, (typeof raw)[number]>();
        for (const item of raw) {
          const key = dedupKey(item);
          if (key === currentCanonical) continue; // skip current page
          const existing = bestPerUrl.get(key);
          if (existing === undefined || item.score > existing.score) {
            bestPerUrl.set(key, item);
          }
        }
        const items = Array.from(bestPerUrl.values())
          .sort((left, right) => right.score - left.score)
          .slice(0, requestedLimit);
        return { ok: true, items };
      } catch (error) {
        return {
          ok: false,
          items: [],
          error: error instanceof Error ? error.message : 'recall query failed',
        };
      }
    };
    return (await buildRecallResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.annotateTurn) {
    // Side-panel-driven turn annotation. We identify the chat tab by
    // canonical URL match — provider SPAs add ?session=… and other
    // drift to the live URL that's not on the captured threadUrl, so
    // strict equality misses. The tab's content script does the
    // actual work (locate the turn, anchor, persist, mount marker)
    // and returns AnnotateTurnResponse, which we tunnel through
    // RuntimeResponse the same way recallQuery does.
    const buildAnnotateResponse = async (): Promise<AnnotateTurnResponse> => {
      try {
        const match = await findTabByCanonicalThreadUrl(request.threadUrl);
        if (match?.id === undefined) {
          return {
            ok: false,
            error:
              'Open the chat tab in this window first — the annotation marker has to land on a live page.',
          };
        }
        const result = await sendToContentScriptWithRecovery(match.id, {
          type: messageTypes.annotateTurn,
          threadUrl: request.threadUrl,
          turnText: request.turnText,
          ...(request.sourceSelector === undefined
            ? {}
            : { sourceSelector: request.sourceSelector }),
          ...(request.anchorText === undefined ? {} : { anchorText: request.anchorText }),
          note: request.note,
          capturedAt: request.capturedAt,
        });
        if (!result.ok) {
          return { ok: false, error: result.error ?? 'Tab is not reachable.' };
        }
        const data = result.data;
        if (
          data !== null &&
          typeof data === 'object' &&
          'ok' in data &&
          typeof data.ok === 'boolean'
        ) {
          return data as AnnotateTurnResponse;
        }
        return { ok: false, error: 'Content script returned an unexpected shape.' };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'annotateTurn relay failed.',
        };
      }
    };
    return (await buildAnnotateResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.listAnnotationsByUrl) {
    // Content scripts on https://chatgpt.com hit the companion's
    // loopback-only origin gate (403 LOOPBACK_ONLY). The SW's
    // chrome-extension:// origin is on the allowlist, so we proxy
    // the read here and return a plain JSON envelope. Tunneled
    // through RuntimeResponse the same way recallQuery does.
    const buildListResponse = async (): Promise<ListAnnotationsByUrlResponse> => {
      try {
        const client = await createAnnotationClient();
        if (client === undefined) {
          return { ok: false, error: 'Companion not configured.' };
        }
        const annotations = await client.listAnnotationsForUrl(request.url);
        return { ok: true, annotations };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'listAnnotationsByUrl failed.',
        };
      }
    };
    return (await buildListResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.publishAnnotationToChat) {
    // Side-panel publish action for a turn annotation. This deliberately
    // reuses the existing provider auto-send driver instead of adding
    // another composer implementation path.
    const buildPublishResponse = async (): Promise<PublishAnnotationToChatResponse> => {
      try {
        const match = await findTabByCanonicalThreadUrl(request.threadUrl);
        if (match?.id === undefined) {
          return {
            ok: false,
            error: 'Open the chat tab in this window first — Sidetrack needs a live composer.',
          };
        }
        await focusTabForUserVisibleSend(match);
        const result = await sendToContentScriptWithRecovery(match.id, {
          type: messageTypes.autoSendItem,
          text: buildAnnotationChatMessage({
            turnText: request.turnText,
            turnRole: request.turnRole,
            ...(request.anchorText === undefined ? {} : { anchorText: request.anchorText }),
            note: request.note,
            capturedAt: request.capturedAt,
          }),
          perItemTimeoutMs: 120_000,
          waitForCompletion: false,
        });
        if (!result.ok) {
          return { ok: false, error: result.error ?? 'Tab is not reachable.' };
        }
        const data = result.data;
        if (
          data !== null &&
          typeof data === 'object' &&
          'ok' in data &&
          typeof data.ok === 'boolean'
        ) {
          return data as PublishAnnotationToChatResponse;
        }
        return { ok: false, error: 'Content script returned an unexpected shape.' };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'publishAnnotationToChat relay failed.',
        };
      }
    };
    return (await buildPublishResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.focusThreadInSidePanel) {
    // Content-script focus button → broadcast to the side panel so
    // it can scroll + flash the matching thread row. We re-broadcast
    // verbatim because the side panel listens on chrome.runtime
    // already (no need for a sticky storage hand-off — the side
    // panel is always-on once opened).
    void chrome.runtime
      .sendMessage({
        type: messageTypes.focusThreadInSidePanel,
        threadUrl: request.threadUrl,
      })
      .catch(() => undefined);
    return await withCompanionStatus();
  }

  if (request.type === messageTypes.dispatchAutoSendInNewTab) {
    return await withCompanionStatus(async () => {
      const { url, body } = request;
      // Open the target chat URL in a new tab and let the
      // tabs.onUpdated listener below auto-send into it once it
      // finishes loading. Returns immediately — the side panel
      // already showed a "opening + auto-sending…" banner.
      try {
        const created = await chrome.tabs.create({ url, active: true });
        const tabId = created.id;
        if (typeof tabId !== 'number') {
          console.warn('[dispatchAutoSendInNewTab] tab create returned no tabId');
          return;
        }
        autoSendOnceTabReady(tabId, body);
      } catch (error) {
        console.warn('[dispatchAutoSendInNewTab] open failed:', error);
      }
    }, 'queue');
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
      // Auto-fire the drain when the toggle flips ON. The trigger
      // helper spawns it unawaited so the runtime response returns
      // immediately — the drain can take many seconds per item, and
      // the side panel re-reads workboard state on the queue
      // broadcast that fires when the drain completes.
      if (request.enabled) {
        triggerAutoSendDrain(request.threadId);
      }
    }, 'thread');
  }

  if (request.type === messageTypes.setScreenShareMode) {
    await saveScreenShareMode(request.enabled);
    return await withCompanionStatus();
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
      await refreshCachedDispatches();
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

  if (request.type === messageTypes.codingAttachListOffers) {
    return {
      ok: true,
      state: await buildState('connected'),
      codingAttachOffers: await listPendingOffers(),
    };
  }

  if (request.type === messageTypes.codingAttachMarkStatus) {
    await markStatus(request.tabId, request.status);
    return {
      ok: true,
      state: await buildState('connected'),
      codingAttachOffers: await listPendingOffers(),
    };
  }

  if (request.type === messageTypes.saveLocalPreferences) {
    return await withCompanionStatus(async () => {
      if (typeof request.preferences.autoTrack === 'boolean') {
        await saveAutoTrack(request.preferences.autoTrack);
      }
      if (typeof request.preferences.vaultPath === 'string') {
        await saveVaultPath(request.preferences.vaultPath);
      }
      if (typeof request.preferences.notifyOnQueueComplete === 'boolean') {
        await saveNotifyOnQueueComplete(request.preferences.notifyOnQueueComplete);
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

  if (request.type === messageTypes.appendReviewDraftSpan) {
    return await withCompanionStatus(async () => {
      // Resolve the threadUrl back to a tracked thread so the draft is
      // keyed by bac_id (stable across URL re-resolution). If no thread
      // exists yet, drop the span — there's no row in the side panel
      // to surface it on. Capture should run before review.
      const threads = await readThreads();
      const thread = threads.find((t) => t.threadUrl === request.threadUrl);
      if (thread === undefined) {
        return;
      }
      await persistReviewDraftSpan(thread.bac_id, request.threadUrl, {
        threadUrl: request.threadUrl,
        anchor: request.anchor,
        quote: request.quote,
        comment: request.comment,
        capturedAt: request.capturedAt,
      });
    }, 'mutation');
  }

  if (request.type === messageTypes.dropReviewDraftSpan) {
    return await withCompanionStatus(async () => {
      await dropReviewDraftSpan(request.threadId, request.spanId);
    }, 'mutation');
  }

  if (request.type === messageTypes.updateReviewDraft) {
    return await withCompanionStatus(async () => {
      const patch: { overall?: string; verdict?: ReviewDraft['verdict'] } = {};
      if (request.overall !== undefined) patch.overall = request.overall;
      if (request.verdict !== undefined) patch.verdict = request.verdict;
      await updateReviewDraft(request.threadId, patch);
    }, 'mutation');
  }

  if (request.type === messageTypes.setReviewDraftSpanComment) {
    return await withCompanionStatus(async () => {
      await setReviewDraftSpanComment(request.threadId, request.spanId, request.comment);
    }, 'mutation');
  }

  if (request.type === messageTypes.discardReviewDraft) {
    return await withCompanionStatus(async () => {
      await discardReviewDraft(request.threadId);
    }, 'mutation');
  }

  if (request.type === messageTypes.sendReviewDraftAsFollowUp) {
    return await withCompanionStatus(async () => {
      const drafts = await readReviewDrafts();
      const draft = drafts[request.threadId];
      if (draft === undefined || draft.spans.length === 0) {
        return;
      }
      const text = buildReviewFollowUpText(draft);
      // Two flavors:
      //   autoSend=true  → "Send now": ensure the per-thread auto-send
      //                    chip is on so createQueueItem's auto-drain
      //                    path fires immediately.
      //   autoSend=false → "Add to queue": queue the item but don't
      //                    touch the thread's auto-send state. If it
      //                    was already on, the existing drain will
      //                    pick it up; if it was off, the item just
      //                    waits for the user to flip auto-send.
      if (request.autoSend) {
        await setThreadAutoSend(request.threadId, true);
      }
      await createQueueItem({
        text,
        scope: 'thread',
        targetId: request.threadId,
      });
      await discardReviewDraft(request.threadId);
    }, 'queue');
  }

  if (
    request.type === messageTypes.archiveDispatch ||
    request.type === messageTypes.unarchiveDispatch
  ) {
    return await withCompanionStatus(async () => {
      await setDispatchArchived(request.dispatchId, request.type === messageTypes.archiveDispatch);
    }, 'mutation');
  }

  if (request.type === messageTypes.setCollapsedSections) {
    await saveCollapsedSections(request.collapsedSections);
    return await withCompanionStatus();
  }

  await saveCollapsedBuckets(request.collapsedBuckets);
  return await withCompanionStatus();
};

// URL match patterns the content script wants to live in. Kept in
// sync with the `matches` field on entrypoints/content.ts (and the
// generated manifest's content_scripts[].matches). Used by the
// startup re-injection loop below — Chrome MV3 doesn't replay
// content_scripts into pre-existing tabs after an extension reload,
// so we have to do it ourselves.
const CONTENT_SCRIPT_MATCH_PATTERNS = [
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'http://127.0.0.1/*',
  'http://localhost/*',
];

const reinjectContentScriptIntoOpenTabs = async (): Promise<void> => {
  try {
    const tabs = await chrome.tabs.query({ url: CONTENT_SCRIPT_MATCH_PATTERNS });
    await Promise.all(
      tabs.map(async (tab) => {
        if (typeof tab.id !== 'number') {
          return;
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content-scripts/content.js'],
          });
        } catch {
          // Restricted pages (chrome://, the Web Store, etc.) reject the
          // injection. That's expected — skip them quietly.
        }
      }),
    );
  } catch {
    // chrome.tabs.query / scripting unavailable — nothing useful to log.
  }
};

const detectCodingAttachForTab = async (tabId: number, url: string): Promise<void> => {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (currentUrl: string): CodingSurface | null => {
        const bodyText = document.body.textContent;
        const confidenceFor = (urlMatch: boolean, domHint: boolean): CodingSurface['confidence'] =>
          urlMatch && domHint ? 'high' : urlMatch ? 'medium' : 'low';
        const codexUrl = /^https:\/\/chatgpt\.com\/codex(?:\/|$)/u.test(currentUrl);
        const codexDom = /\b(Codex|workspace|diff|branch)\b/iu.test(bodyText);
        if (codexUrl || codexDom) {
          return {
            id: 'codex',
            signals: { urlMatch: codexUrl, domHint: codexDom },
            confidence: confidenceFor(codexUrl, codexDom),
          };
        }
        const claudeUrl = /^https:\/\/claude\.ai\/code(?:\/|$)/u.test(currentUrl);
        const claudeDom = /\b(Claude Code|repository|terminal)\b/iu.test(bodyText);
        if (claudeUrl || claudeDom) {
          return {
            id: 'claude_code',
            signals: { urlMatch: claudeUrl, domHint: claudeDom },
            confidence: confidenceFor(claudeUrl, claudeDom),
          };
        }
        const cursorUrl = /^https:\/\/(?:www\.)?cursor\.com\//u.test(currentUrl);
        const cursorDom = /\b(Cursor|agent|workspace)\b/iu.test(bodyText);
        if (cursorUrl || cursorDom) {
          return {
            id: 'cursor',
            signals: { urlMatch: cursorUrl, domHint: cursorDom },
            confidence: confidenceFor(cursorUrl, cursorDom),
          };
        }
        return null;
      },
      args: [url],
    });
    if (result.result !== null && result.result !== undefined) {
      // Only emit offers when the URL actually matches the coding-
      // surface pattern (medium / high confidence). DOM-only matches
      // (low confidence) are too noisy: a regular ChatGPT chat that
      // happens to mention "workspace", "diff", or "branch" trips the
      // codex DOM regex and surfaces a false-positive Codex offer.
      // The detection function still returns the low-confidence
      // surface for diagnostics; we just don't act on it here.
      if (result.result.confidence !== 'low') {
        await upsertOffer({ tabId, url, surface: result.result });
      }
    }
  } catch {
    // Restricted tabs or pages without the content script surface are ignored.
  }
};

export default defineBackground(() => {
  // Drop reminders bound to thread bac_ids that no longer exist.
  // Cleanup pass for the historical mess caused by the pre-fix
  // sendToCompanion bug (every capture reissued a thread bac_id;
  // reminders accumulated against orphans). Idempotent — runs on
  // every service-worker boot, no-op when storage is already clean.
  const DISPATCH_POLL_ALARM = 'sidetrack.dispatch.poll';
  // 1-minute cadence: Chrome's MV3 minimum. Latency from
  // bac.request_dispatch to the chat tab opening is bounded by this
  // alarm in the worst case (no side panel open, no incoming
  // workboard request). Earlier this was 5 min in an effort to be
  // conservative — but the 30s cooldown gate, single-flight mutex,
  // and MAX_PER_TICK=1 already cap the blast radius of a
  // misconfigured retry loop. Slow polling didn't reduce risk; it
  // just made the autonomous flow feel broken. Idempotent: same
  // alarm name replaces any existing.
  const ensureDispatchPollAlarm = async (): Promise<void> => {
    try {
      await chrome.alarms.create(DISPATCH_POLL_ALARM, { periodInMinutes: 1 });
    } catch (error) {
      console.warn('[dispatch.poll] alarm create failed:', error);
    }
  };

  const pruneOrphanRemindersAndLinks = async (): Promise<void> => {
    try {
      const knownThreadIds = new Set((await readThreads()).map((t) => t.bac_id));
      const remindersDropped = await pruneReminders(knownThreadIds);
      if (remindersDropped > 0) {
        console.warn(
          `[startup] pruned ${String(remindersDropped)} reminders bound to dead thread bac_ids`,
        );
        void broadcastWorkboardChanged('reminder');
      }
      await pruneDispatchLinks(knownThreadIds);
    } catch (error) {
      console.warn('[startup] orphan prune failed:', error);
    }
  };

  chrome.runtime.onInstalled.addListener((details) => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
    void pruneOrphanRemindersAndLinks();
    void ensureDispatchPollAlarm();
    // Heal pre-existing tabs after an install/update/reload so the
    // user doesn't have to refresh each chat tab manually. The first
    // install case is harmless: matching tabs that already had no
    // script get one; tabs that have one shrug it off.
    if (
      details.reason === 'install' ||
      details.reason === 'update' ||
      details.reason === 'chrome_update'
    ) {
      void reinjectContentScriptIntoOpenTabs();
    }
  });

  // Service workers can be restarted by Chrome on idle — onStartup
  // fires when the browser launches. Re-inject is cheap and idempotent
  // so we can always do it.
  chrome.runtime.onStartup.addListener(() => {
    void pruneOrphanRemindersAndLinks();
    void reinjectContentScriptIntoOpenTabs();
    void ensureDispatchPollAlarm();
  });

  // Periodic background poll for new MCP-auto-approved dispatches.
  // Without this, refreshCachedDispatches only fires when the side
  // panel makes a workboard request — meaning agent-initiated
  // dispatches sit unconsumed if the side panel is closed. Chrome's
  // alarm minimum is 1 minute, so the worst-case latency from
  // bac.request_dispatch to "tab opens" is ~1 minute. The alarm is
  // additive; explicit side-panel actions still trigger immediately.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== DISPATCH_POLL_ALARM) return;
    void (async () => {
      try {
        if (!(await isCompanionConfigured())) return;
        await refreshCachedDispatches();
      } catch (error) {
        console.warn('[dispatch.poll] failed:', error);
      }
    })();
  });
  void ensureDispatchPollAlarm();

  chrome.tabs.onRemoved.addListener((tabId) => {
    void markClosedTabRestorable(tabId).catch(() => undefined);
    // Clean up MCP-dispatch markers on tab close so the storage map
    // doesn't accumulate dead entries.
    void dropMcpDispatchTab(tabId).catch(() => undefined);
  });

  // Whenever the user activates a different tab or a tab's URL
  // changes (SPA nav, browser back/forward), check if they landed
  // on a tracked thread that has unread-reply reminders waiting.
  // Dismiss them — they're looking at it now, the pill is wrong.
  // Broadcast on success so the side panel re-renders without a
  // poll round-trip.
  const dismissAndBroadcast = (): void => {
    void dismissRemindersForActiveTab()
      .then((changed) => {
        void broadcastWorkboardChanged(changed ? 'reminder' : 'thread');
      })
      .catch(() => undefined);
  };
  chrome.tabs.onActivated.addListener(() => {
    dismissAndBroadcast();
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // Only react when the URL actually changed — ignore title/favicon
    // updates that fire on every page mutation.
    if (changeInfo.url === undefined) {
      return;
    }
    void detectCodingAttachForTab(tabId, changeInfo.url);
    dismissAndBroadcast();
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      return;
    }
    dismissAndBroadcast();
  });

  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse: (response: RuntimeResponse) => void) => {
      if (!isRuntimeRequest(message)) {
        return undefined;
      }

      void handleRequest(message, sender.tab?.id)
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

  // Long-lived SSE consumer for /v1/vault/changes. Lazy: subscribers
  // (review-drafts here, more in future phases) drive the connection
  // open/close lifecycle. The client retries with backoff so a brief
  // companion downtime self-heals on reconnect.
  let cachedReviewDraftCompanion: ReviewDraftClientConfig | null = null;
  const refreshCompanionCache = async (): Promise<ReviewDraftClientConfig | null> => {
    const settings = await readSettings();
    cachedReviewDraftCompanion = draftClientFromSettings(settings);
    return cachedReviewDraftCompanion;
  };
  const reviewDraftsSse = createVaultChangesClient({
    resolveCompanion: () =>
      cachedReviewDraftCompanion === null
        ? null
        : {
            url: cachedReviewDraftCompanion.companionUrl,
            bridgeKey: cachedReviewDraftCompanion.bridgeKey,
          },
  });
  void refreshCompanionCache();
  chrome.storage.onChanged.addListener(() => {
    void refreshCompanionCache();
  });
  reviewDraftsSse.subscribe({
    prefix: '_BAC/review-drafts/',
    onEvent: (event) => {
      // relPath shape: `_BAC/review-drafts/<threadId>.json`.
      const match = /^_BAC\/review-drafts\/(?<threadId>[^/]+?)\.json$/.exec(event.relPath);
      const threadId = match?.groups?.threadId;
      if (threadId === undefined) return;
      void (async () => {
        const cached = await refreshCompanionCache();
        if (cached === null) return;
        if (event.type === 'deleted') {
          const { removeRemoteReviewDraft } = await import('../src/background/state');
          await removeRemoteReviewDraft(threadId);
          return;
        }
        const projection = await fetchReviewDraft(cached, threadId).catch(() => null);
        if (projection === null) return;
        const { mirrorRemoteReviewDraft } = await import('../src/background/state');
        await mirrorRemoteReviewDraft({
          threadId: projection.threadId,
          threadUrl: projection.threadUrl,
          vector: projection.vector,
          spans: projection.spans.map((span) => ({
            spanId: span.spanId,
            anchor: span.anchor,
            quote: span.quote,
            comment: span.comment,
            capturedAt: span.capturedAt,
          })),
          overall: projection.overall,
          verdict: projection.verdict,
          discarded: projection.discarded,
          updatedAtMs: projection.updatedAtMs,
        });
      })().catch(() => undefined);
    },
    onReconcile: () => {
      // After a reconnect, walk the cursor feed so any peer event
      // that landed while we were disconnected is reflected in the
      // local projection cache. The SSE stream covers events after
      // reconnect; this fills the gap before reconnect.
      void (async () => {
        const cached = await refreshCompanionCache();
        void drainReviewDraftQueue().catch(() => undefined);
        if (cached === null) return;
        try {
          const response = await fetchReviewDraftChanges(cached, null);
          for (const change of response.changed) {
            const projection = await fetchReviewDraft(cached, change.threadId).catch(() => null);
            if (projection === null) continue;
            const { mirrorRemoteReviewDraft } = await import('../src/background/state');
            await mirrorRemoteReviewDraft({
              threadId: projection.threadId,
              threadUrl: projection.threadUrl,
              vector: projection.vector,
              spans: projection.spans.map((span) => ({
                spanId: span.spanId,
                anchor: span.anchor,
                quote: span.quote,
                comment: span.comment,
                capturedAt: span.capturedAt,
              })),
              overall: projection.overall,
              verdict: projection.verdict,
              discarded: projection.discarded,
              updatedAtMs: projection.updatedAtMs,
            });
          }
        } catch {
          // Swallowed — reconnect retry will pick up if companion
          // settings changed. The SSE loop continues.
        }
      })().catch(() => undefined);
    },
  });

  return { name: 'sidetrack-background' };
});
