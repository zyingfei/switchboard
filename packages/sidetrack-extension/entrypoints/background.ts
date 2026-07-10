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
import { CompanionRequestError, createCompanionClient } from '../src/companion/client';
import {
  compareCompanionIdentity,
  identityWarningFor,
  type CompanionIdentity,
} from '../src/companion/identity';
import { listPendingOffers, markStatus, upsertOffer } from '../src/codingAttach/state';
import type { CodingSurface } from '../src/codingAttach/detection';
import { createSettingsClient } from '../src/settings/client';
import type {
  CaptureEvent,
  CompanionSettings,
  CompanionStatus,
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
import {
  ACTIVE_WORKSTREAM_KEY,
  initializeTimelineWiring,
  readTimelineReplayDiagnostics,
  recordTitleFromContent,
  refreshActiveWorkstreamFromStorage,
  resetTimelineWiringForTests,
  setActiveWorkstreamCache,
  TIMELINE_ENABLED_KEY,
  TIMELINE_PRIVACY_GATE,
  TIMELINE_REPLAY_DEBUG_KEY,
  triggerTimelineDrain,
} from '../src/timeline/wiring';
import {
  createTabOpenerStore,
  registerTabLifecycleListeners,
} from '../src/background/listeners/tabs';
import { registerDefaultWebNavigationListeners } from '../src/background/listeners/web-navigation';
import {
  createEdgeEventDrainSingleFlight,
  partitionEdgeEventDrainBatch,
  selectEdgeEventDrainScanBatch,
  summarizeEdgeEventDrain,
} from '../src/background/storage/edge-event-drain';
import { IndexedDbEventBuffer } from '../src/background/storage/indexeddb-event-buffer';
import type { BufferedEvent } from '../src/background/storage/in-memory-event-buffer';
import {
  createEngagementCache,
  isEngagementIntervalMessage,
  type EngagementIntervalObservedPayload,
  type EngagementSessionAggregatedPayload,
} from '../src/background/state/engagementCache';
import {
  isSelectionLineageMessage,
  type SelectionCopiedPayload,
  type SelectionPastedPayload,
} from '../src/content/engagement/copy-paste';
import type { EngagementIntervalMessage } from '../src/content/engagement/aggregator';
import {
  VISUAL_FINGERPRINT_OBSERVED,
  VISUAL_FINGERPRINT_PRIVACY_GET,
  isVisualFingerprintObservedMessage,
  type VisualFingerprintObservedPayload,
} from '../src/content/visual/dom-hash';
import { allocateNextSeq, loadOrCreateEdgeReplica } from '../src/sync/edgeReplicaId';
import { idempotencyKey } from '../src/idempotencyKey';
import { createVaultChangesClient } from '../src/companion/vaultChanges';
import { indexTurnsCoalesced } from '../src/companion/recallClient';
import {
  createPageContentClient,
  type PageContentCoverage,
  type PageEvidenceRecord,
} from '../src/companion/pageContentClient';
import { buildReviewFollowUpText } from '../src/review/draft';
import type { ReviewDraft } from '../src/review/types';
import {
  createTabGroupWiring,
  type TabGroupFeedbackEvent,
  type TabGroupWiring,
} from '../src/tabgroups/wiring';
import {
  createChromeTabSessionStorage,
  sealOrphanTabSessionsOnWake,
} from '../src/tabsession/storage';
import {
  isContentResponse,
  isNavigationLinkClickMessage,
  isPageContentExtractContentResponse,
  isRuntimeRequest,
  messageTypes,
  type AnnotateTurnResponse,
  type ListAnnotationsByUrlResponse,
  type PageContentBulkOperationResponse,
  type PageContentOperationResponse,
  type PageContentOpenTabPreview,
  type PageContentOpenTabsPreviewResponse,
  type PublishAnnotationToChatResponse,
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
  mirrorRemoteWorkstream,
  readSettings,
  recordSelectorCanary,
  saveAutoTrack,
  saveCaptureEnabled,
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
  savePageEvidenceAutoExtractEnabled,
  saveRecallEmitTrainableActions,
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
  writeDispatchRecallContext,
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
import { localRecallStore } from '../src/local-recall/store';
import { ingestVisit } from '../src/local-recall/ingestion';

// Phase 10 — OPFS local-recall fallback. Called from the recallV2Query
// handler when the companion is unreachable. Returns null if the local
// store has no matches (caller falls back to its own error path).
const tryLocalFallback = async (
  req: Record<string, unknown>,
  reason: 'no-companion' | 'companion-error',
): Promise<unknown | null> => {
  try {
    const q = typeof req['q'] === 'string' ? req['q'] : '';
    const limit = typeof req['limit'] === 'number' ? req['limit'] : 12;
    if (q.trim().length === 0) return null;
    const hits = await localRecallStore().query({ q, limit });
    if (hits.length === 0) return null;
    const results = hits.map((h, i) => ({
      candidateId: h.entityId,
      entityId: h.entityId,
      sourceKind: 'timeline_visit',
      canonicalUrl: h.canonicalUrl,
      title: h.title ?? h.canonicalUrl,
      fusedScore: 1 / (60 + (i + 1)),
      ...(h.lastSeenAtMs === undefined
        ? {}
        : { lastSeenAt: new Date(h.lastSeenAtMs).toISOString() }),
      evidence: [
        {
          retriever: 'fts5-local',
          sourceKind: 'timeline_visit',
          rawScore: h.bm25,
          rank: i + 1,
        },
      ],
    }));
    return {
      ok: true,
      results,
      meta: {
        fusion: { strategy: 'rrf-local', perSourceCounts: { timeline_visit: hits.length } },
        timingsMs: {},
        flags: { localFallback: true, fallbackReason: reason },
      },
    };
  } catch (err) {
    console.warn('[local-recall] fallback failed:', err);
    return null;
  }
};
import type { DispatchEventRecord } from '../src/dispatch/types';
import { tryLinkCapturedThread } from '../src/companion/dispatchLinking';

const activeTab = async (): Promise<chrome.tabs.Tab | undefined> => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const PAGE_CONTENT_BULK_OPEN_TABS_LIMIT = 50;

let runtimeTabGroupWiring: TabGroupWiring | null = null;

const fnv1a64ForTabGroup = (input: string): string => {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
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
    // Match canonically, like `userIsViewingThreadUrl` — the live tab
    // URL carries provider query/fragment (?model= / ?session= / #…)
    // that the stored `threadUrl` has stripped. A strict `===` here made
    // the dismiss silently miss, so the "Unread reply" pill never
    // cleared even while the user was reading the chat.
    const canonicalActive = canonicalThreadUrl(url);
    const thread = (await readThreads()).find(
      (t) => t.threadUrl === url || canonicalThreadUrl(t.threadUrl) === canonicalActive,
    );
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

const hostFromUrl = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'current tab';
  }
};

const PRIVACY_GATE_FLIPPED = 'privacy.gate.flipped';
const PRIVACY_PERMISSION_GRANTED = 'privacy.permission.granted';
const PRIVACY_PERMISSION_REVOKED = 'privacy.permission.revoked';
const TIMELINE_HOST_PERMISSION = 'timeline.hostAccess';
const TIMELINE_HOST_PERMISSION_SCOPE = { origins: ['https://*/*', 'http://*/*'] } as const;
const ENGAGEMENT_PRIVACY_GATE = 'engagement';
const ENGAGEMENT_CONTENT_SCRIPT_ID = 'sidetrack-engagement';
const ENGAGEMENT_CONTENT_SCRIPT_FILE = 'engagement.js';
const ENGAGEMENT_HOST_ORIGINS = ['https://*/*', 'http://*/*'];
const VISUAL_FINGERPRINT_PRIVACY_GATE = 'visual.fingerprint';
const VISUAL_FINGERPRINT_CONTENT_SCRIPT_ID = 'sidetrack-visual-fingerprint';
const VISUAL_FINGERPRINT_CONTENT_SCRIPT_FILE = 'visual-fingerprint.js';
const VISUAL_FINGERPRINT_HOST_ORIGINS = ['https://*/*', 'http://*/*'];

interface PrivacyProjectionPayload {
  readonly gateStates?: Record<string, 'open' | 'closed'>;
  readonly gateEventCount?: number;
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readTimelineCompanionConfig = async (): Promise<{
  url: string;
  bridgeKey: string;
} | null> => {
  const settings = await readSettings();
  const port = settings.companion.port;
  const bridgeKey = settings.companion.bridgeKey.trim();
  if (typeof port !== 'number' || port <= 0 || bridgeKey.length === 0) return null;
  return { url: `http://127.0.0.1:${String(port)}`, bridgeKey };
};

const companionJson = async (path: string, init: RequestInit = {}): Promise<unknown> => {
  const config = await readTimelineCompanionConfig();
  if (config === null) throw new Error('companion not configured');
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  headers.set('x-bac-bridge-key', config.bridgeKey);
  const response = await fetch(`${config.url}${path}`, { ...init, headers });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      isObjectRecord(body) && typeof body['title'] === 'string'
        ? body['title']
        : `companion HTTP ${String(response.status)}`;
    throw new Error(message);
  }
  return body;
};

const parsePrivacyProjection = (body: unknown): PrivacyProjectionPayload => {
  const data = isObjectRecord(body) ? body['data'] : undefined;
  if (!isObjectRecord(data)) return {};
  const gateStates = isObjectRecord(data['gateStates']) ? data['gateStates'] : undefined;
  return {
    ...(gateStates === undefined
      ? {}
      : { gateStates: gateStates as Record<string, 'open' | 'closed'> }),
    ...(typeof data['gateEventCount'] === 'number'
      ? { gateEventCount: data['gateEventCount'] }
      : {}),
  };
};

// /v1/privacy/projection is read by the timeline gate predicate, the
// collector capability gates, and the workboard-state builder — under
// active navigation that is ~5 reads per page, each a round-trip onto
// the companion's single event loop. Memoize the raw projection with
// a short TTL + in-flight coalescing so those callers share one
// fetch. Invalidated immediately on a gate flip
// (invalidateTimelineGateCache) so a privacy change still propagates
// without waiting out the TTL.
const PRIVACY_PROJECTION_TTL_MS = 5_000;
let cachedPrivacyProjection: { value: PrivacyProjectionPayload; expiresAtMs: number } | null = null;
let privacyProjectionInFlight: Promise<PrivacyProjectionPayload> | null = null;

const readPrivacyProjection = async (): Promise<PrivacyProjectionPayload> => {
  if (cachedPrivacyProjection !== null && cachedPrivacyProjection.expiresAtMs > Date.now()) {
    return cachedPrivacyProjection.value;
  }
  if (privacyProjectionInFlight !== null) return privacyProjectionInFlight;
  privacyProjectionInFlight = (async (): Promise<PrivacyProjectionPayload> => {
    try {
      const value = parsePrivacyProjection(
        await companionJson('/v1/privacy/projection', { method: 'GET' }),
      );
      cachedPrivacyProjection = { value, expiresAtMs: Date.now() + PRIVACY_PROJECTION_TTL_MS };
      return value;
    } finally {
      privacyProjectionInFlight = null;
    }
  })();
  return privacyProjectionInFlight;
};

// chrome.tabs.onUpdated can fire many times per navigation. Every call
// of the gate predicate used to make an HTTP round-trip to the
// companion (`/v1/privacy/projection`), which made the SW slow and
// fragile: under contention the projection fetch could time out, the
// gate would read as closed, and the listener would skip the
// observation entirely. Cache the result for a short window. The cache
// is busted whenever the gate flips via a Class A event handler so the
// spec's `sidetrack.privacy.gateChanged` propagates immediately.
const GATE_CACHE_TTL_MS = 5_000;
let cachedTimelineGateState: { value: boolean; expiresAtMs: number } | null = null;

const invalidateTimelineGateCache = (): void => {
  cachedTimelineGateState = null;
  // A gate flip also stales the raw privacy projection memo — drop
  // it so the new gate state propagates immediately, not after the
  // TTL.
  cachedPrivacyProjection = null;
};

// Master capture kill-switch — the side-panel "eye". Read fresh (not
// cached) so a flip takes effect immediately on every gated path.
// `!== false` treats a missing flag as on, matching readSettings'
// default-merge (captureEnabled defaults to true).
const isCaptureEnabled = async (): Promise<boolean> =>
  (await readSettings()).captureEnabled !== false;

const isTimelinePrivacyGateOpen = async (): Promise<boolean> => {
  // The master switch overrides the per-feature gate: capture off means
  // no ambient timeline ingestion, full stop. Checked before the cache
  // so a flip is honored immediately (the captureEnabled read is cheap
  // and the gate cache only memoizes the companion-side projection).
  if (!(await isCaptureEnabled())) return false;
  const now = Date.now();
  if (cachedTimelineGateState !== null && cachedTimelineGateState.expiresAtMs > now) {
    return cachedTimelineGateState.value;
  }
  try {
    const projection = await readPrivacyProjection();
    const value = projection.gateStates?.[TIMELINE_PRIVACY_GATE] === 'open';
    cachedTimelineGateState = { value, expiresAtMs: now + GATE_CACHE_TTL_MS };
    return value;
  } catch {
    // Don't cache failures — the companion may briefly be unreachable
    // and we want the next call to retry rather than wedge "closed".
    return false;
  }
};

const isTimelineReplayDebugEnabled = async (): Promise<boolean> => {
  try {
    const got = await chrome.storage.local.get(TIMELINE_REPLAY_DEBUG_KEY);
    return got[TIMELINE_REPLAY_DEBUG_KEY] === true;
  } catch {
    return false;
  }
};

const isEngagementPrivacyGateOpen = async (): Promise<boolean> => {
  try {
    const projection = await readPrivacyProjection();
    return projection.gateStates?.[ENGAGEMENT_PRIVACY_GATE] === 'open';
  } catch {
    return false;
  }
};

// Stage 5 follow-up — the engagement subsystem (focus/scroll/copy
// aggregator) needs BOTH a host permission AND an "engagement" privacy
// gate flipped open before its content script registers. Until this
// helper landed, no production code path opened the gate — only e2e
// test scripts wrote `privacy.gate.flipped { gate: 'engagement' }`.
// Production users granted host permission, saw "deeper page access
// granted" green, but the engagement content script never registered,
// so the materializer's engagement counters stayed at zero (which in
// turn starved the similarity ranker and the URL auto-inference path).
//
// Design: engagement is default-on. The privacy gate is kept open
// idempotently; the only thing that actually blocks engagement is the
// host permission, which has its own user-facing grant flow + banner.
const ensureEngagementGateDefaultOpen = async (): Promise<void> => {
  if (await isEngagementPrivacyGateOpen()) return;
  await appendPrivacyEvent(
    PRIVACY_GATE_FLIPPED,
    {
      gate: ENGAGEMENT_PRIVACY_GATE,
      state: 'open',
      actor: 'system',
      reason: 'default-on',
      payloadVersion: 1,
    },
    `${ENGAGEMENT_PRIVACY_GATE}-open-default`,
  );
};

const isVisualFingerprintPrivacyGateOpen = async (): Promise<boolean> => {
  try {
    const projection = await readPrivacyProjection();
    return projection.gateStates?.[VISUAL_FINGERPRINT_PRIVACY_GATE] === 'open';
  } catch {
    return false;
  }
};

const hasEngagementHostPermission = async (): Promise<boolean> => {
  try {
    return await new Promise<boolean>((resolve) => {
      chrome.permissions.contains({ origins: [...ENGAGEMENT_HOST_ORIGINS] }, (granted) => {
        resolve(Boolean(granted));
      });
    });
  } catch {
    return false;
  }
};

// Primary in-memory journal. Survives SW lifetime, no async dependency
// on chrome.storage, no race conditions. Mirrored to chrome.storage.session
// and console.warn as fallbacks for operators who can't read globalThis
// from a non-SW context.
const engagementSyncJournal: Array<Record<string, unknown>> = [];
const ENGAGEMENT_SYNC_JOURNAL_MAX = 50;

const recordEngagementSyncDiag = async (
  step: string,
  detail?: Record<string, unknown>,
): Promise<void> => {
  const entry: Record<string, unknown> = {
    at: new Date().toISOString(),
    step,
  };
  if (detail !== undefined) entry['detail'] = detail;
  // Primary: globalThis array. Read from SW DevTools via:
  //   globalThis.__sidetrackEngagementDiag
  // Or from any extension page DevTools via sidetrack.dev.diag dump
  // (folded into the response below).
  engagementSyncJournal.push(entry);
  if (engagementSyncJournal.length > ENGAGEMENT_SYNC_JOURNAL_MAX) {
    engagementSyncJournal.shift();
  }
  (globalThis as unknown as { __sidetrackEngagementDiag: unknown[] }).__sidetrackEngagementDiag =
    engagementSyncJournal;
  // Console fallback — visible in the SW DevTools console regardless
  // of storage availability.
  console.warn('[engagement.diag]', step, detail ?? '');
  // Best-effort secondary: chrome.storage.session so a side-panel
  // DevTools can probe it. Chrome 148 sometimes loses these writes
  // (we hit this earlier), so it's belt-and-suspenders not primary.
  try {
    const key = 'sidetrack.engagement.diag';
    await chrome.storage.session.set({ [key]: [...engagementSyncJournal] });
  } catch {
    // Storage failed — globalThis still has the data.
  }
};

const syncEngagementContentScriptRegistration = async (): Promise<void> => {
  // Engagement is default-on. The gate stayed closed for production
  // users because nothing wrote the privacy.gate.flipped event; open
  // it idempotently so the only remaining gate is host permission.
  await ensureEngagementGateDefaultOpen().catch(() => undefined);
  const gateOpen = await isEngagementPrivacyGateOpen();
  const hasPermission = await hasEngagementHostPermission();
  // Master capture switch gates engagement observation too — off means
  // the content script unregisters and stops emitting intervals.
  const captureOn = await isCaptureEnabled();
  const shouldRegister = gateOpen && hasPermission && captureOn;
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [ENGAGEMENT_CONTENT_SCRIPT_ID],
  });
  const alreadyRegistered = registered.length > 0;
  await recordEngagementSyncDiag('sync.invoked', {
    gateOpen,
    hasPermission,
    captureOn,
    shouldRegister,
    alreadyRegistered,
  });
  if (shouldRegister && !alreadyRegistered) {
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: ENGAGEMENT_CONTENT_SCRIPT_ID,
          matches: [...ENGAGEMENT_HOST_ORIGINS],
          js: [ENGAGEMENT_CONTENT_SCRIPT_FILE],
          runAt: 'document_idle',
          persistAcrossSessions: true,
        },
      ]);
      await recordEngagementSyncDiag('register.ok');
    } catch (error) {
      await recordEngagementSyncDiag('register.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    // Catch-up: the registration covers future navigations only, so
    // dogfooders staring at already-open tabs see no engagement signal
    // until they manually refresh. Inject into those tabs now.
    await reinjectEngagementScriptIntoOpenTabs();
    return;
  }
  if (!shouldRegister && alreadyRegistered) {
    await chrome.scripting.unregisterContentScripts({ ids: [ENGAGEMENT_CONTENT_SCRIPT_ID] });
    await recordEngagementSyncDiag('unregister.ok');
    return;
  }
  // Already-registered case: still catch up on open tabs in case a prior
  // sync registered but skipped the inject (e.g. SW restart, install).
  if (shouldRegister && alreadyRegistered) {
    await reinjectEngagementScriptIntoOpenTabs();
    await recordEngagementSyncDiag('reinject.ok');
  }
};

const syncVisualFingerprintContentScriptRegistration = async (): Promise<void> => {
  const shouldRegister =
    (await isVisualFingerprintPrivacyGateOpen()) && (await isCaptureEnabled());
  const registered = await chrome.scripting.getRegisteredContentScripts({
    ids: [VISUAL_FINGERPRINT_CONTENT_SCRIPT_ID],
  });
  const alreadyRegistered = registered.length > 0;
  if (shouldRegister && !alreadyRegistered) {
    await chrome.scripting.registerContentScripts([
      {
        id: VISUAL_FINGERPRINT_CONTENT_SCRIPT_ID,
        matches: [...VISUAL_FINGERPRINT_HOST_ORIGINS],
        js: [VISUAL_FINGERPRINT_CONTENT_SCRIPT_FILE],
        runAt: 'document_idle',
        persistAcrossSessions: true,
      },
    ]);
    return;
  }
  if (!shouldRegister && alreadyRegistered) {
    await chrome.scripting.unregisterContentScripts({
      ids: [VISUAL_FINGERPRINT_CONTENT_SCRIPT_ID],
    });
  }
};

const syncPrivacyGatedContentScriptRegistrations = async (): Promise<void> => {
  await Promise.all([
    syncEngagementContentScriptRegistration(),
    syncVisualFingerprintContentScriptRegistration(),
  ]);
};

const appendPrivacyEvent = async (
  type: string,
  payload: Record<string, unknown>,
  idempotencySuffix: string,
): Promise<void> => {
  await companionJson('/v1/privacy/events', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey('privacy', idempotencySuffix) },
    body: JSON.stringify({ type, payload }),
  });
};

const readLegacyTimelineEnabled = async (): Promise<boolean | undefined> => {
  try {
    const got = await chrome.storage.local.get(TIMELINE_ENABLED_KEY);
    const value = got[TIMELINE_ENABLED_KEY];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
};

const bootstrapTimelinePrivacyGate = async (): Promise<void> => {
  const legacyTimelineEnabled = await readLegacyTimelineEnabled();
  if (legacyTimelineEnabled === undefined) return;
  const projection = await readPrivacyProjection();
  if (projection.gateStates?.[TIMELINE_PRIVACY_GATE] !== undefined) return;
  await appendPrivacyEvent(
    PRIVACY_GATE_FLIPPED,
    {
      gate: TIMELINE_PRIVACY_GATE,
      state: legacyTimelineEnabled ? 'open' : 'closed',
      actor: 'system',
      reason: 'migration-shim',
      payloadVersion: 1,
    },
    `migration-${TIMELINE_PRIVACY_GATE}`,
  );
};

const setTimelinePrivacyGate = async (enabled: boolean): Promise<void> => {
  await appendPrivacyEvent(
    PRIVACY_GATE_FLIPPED,
    {
      gate: TIMELINE_PRIVACY_GATE,
      state: enabled ? 'open' : 'closed',
      actor: 'user',
      reason: 'user-toggle',
      payloadVersion: 1,
    },
    `${TIMELINE_PRIVACY_GATE}-${enabled ? 'open' : 'closed'}-${String(Date.now())}`,
  );
};

const recordTimelinePermissionGranted = async (): Promise<void> => {
  await appendPrivacyEvent(
    PRIVACY_PERMISSION_GRANTED,
    {
      permission: TIMELINE_HOST_PERMISSION,
      scope: TIMELINE_HOST_PERMISSION_SCOPE,
      payloadVersion: 1,
    },
    `${TIMELINE_HOST_PERMISSION}-granted-${String(Date.now())}`,
  );
};

const recordTimelinePermissionRevoked = async (): Promise<void> => {
  await appendPrivacyEvent(
    PRIVACY_PERMISSION_REVOKED,
    {
      permission: TIMELINE_HOST_PERMISSION,
      scope: TIMELINE_HOST_PERMISSION_SCOPE,
      retroactiveMask: false,
      payloadVersion: 1,
    },
    `${TIMELINE_HOST_PERMISSION}-revoked-${String(Date.now())}`,
  );
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
    | 'annotation'
    | 'dispatch'
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
    // FU1 — route through the coalescer so multiple capture events
    // firing close together (e.g. several chat-tab onboardings)
    // collapse into one POST instead of N back-to-back requests.
    void indexTurnsCoalesced(
      settings.companion,
      indexableTurns.map((turn) => ({
        id: `${threadResult.bac_id}:${String(turn.ordinal)}`,
        threadId: threadResult.bac_id,
        capturedAt: turn.capturedAt,
        text: turn.text,
      })),
    ).catch((error: unknown) => {
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

const extractPageContentFromTab = async (
  tab: chrome.tabs.Tab,
  mode: 'page' | 'selection',
  trigger: 'manual' | 'bulk-open-tabs' = 'manual',
): Promise<PageContentCoverage> => {
  if (typeof tab.id !== 'number') {
    throw new Error('Current tab has no tab id.');
  }
  if (!(await isCaptureEnabled())) {
    throw new Error('Capture is paused — turn the eye back on to index page content.');
  }
  if (tab.incognito === true) {
    throw new Error('Page-content indexing is disabled in incognito tabs.');
  }
  const tabUrl = tab.url ?? '';
  if (!/^https?:\/\//u.test(tabUrl)) {
    throw new Error('Page-content indexing only supports HTTP(S) pages.');
  }
  const request = {
    type: messageTypes.pageContentExtract,
    mode,
    trigger,
  } as const;
  let result = await sendToContentScriptWithRecovery(tab.id, request);
  if (result.ok && !isPageContentExtractContentResponse(result.data)) {
    const inject = await ensureContentScriptInTab(tab.id);
    if (!inject.ok) {
      throw new Error(
        `Content script returned an invalid page-content response. Tried to recover but: ${inject.error ?? 'inject failed'}.`,
      );
    }
    result = await sendToContentScriptWithRecovery(tab.id, request);
  }
  if (!result.ok) {
    throw new Error(result.error ?? 'Content script is not reachable.');
  }
  if (!isPageContentExtractContentResponse(result.data)) {
    throw new Error('Content script returned an invalid page-content response.');
  }
  if (!result.data.ok) {
    throw new Error(result.data.error);
  }
  const settings = await readSettings();
  if (settings.companion.bridgeKey.trim().length === 0) {
    throw new Error('Companion not configured.');
  }
  return await createPageContentClient(settings.companion).index(result.data.payload);
};

type PageEvidenceTrigger =
  | 'manual'
  | 'workstream-policy'
  | 'save-suggestion'
  | 'allowlist'
  | 'auto-observed'
  | 'attention-gate'
  | 'bulk-open-tabs';

const extractPageEvidenceFromTab = async (
  tab: chrome.tabs.Tab,
  trigger: PageEvidenceTrigger,
): Promise<PageEvidenceRecord> => {
  if (typeof tab.id !== 'number') {
    throw new Error('Current tab has no tab id.');
  }
  if (!(await isCaptureEnabled())) {
    throw new Error('Capture is paused — turn the eye back on to extract page evidence.');
  }
  if (tab.incognito === true) {
    throw new Error('Page-evidence extraction is disabled in incognito tabs.');
  }
  const tabUrl = tab.url ?? '';
  if (!/^https?:\/\//u.test(tabUrl)) {
    throw new Error('Page-evidence extraction only supports HTTP(S) pages.');
  }
  const request = {
    type: messageTypes.pageContentExtract,
    mode: 'page',
    trigger,
  } as const;
  let result = await sendToContentScriptWithRecovery(tab.id, request);
  if (result.ok && !isPageContentExtractContentResponse(result.data)) {
    const inject = await ensureContentScriptInTab(tab.id);
    if (!inject.ok) {
      throw new Error(
        `Content script returned an invalid page-evidence response. Tried to recover but: ${inject.error ?? 'inject failed'}.`,
      );
    }
    result = await sendToContentScriptWithRecovery(tab.id, request);
  }
  if (!result.ok) {
    throw new Error(result.error ?? 'Content script is not reachable.');
  }
  if (!isPageContentExtractContentResponse(result.data)) {
    throw new Error('Content script returned an invalid page-evidence response.');
  }
  if (!result.data.ok) {
    throw new Error(result.data.error);
  }
  const settings = await readSettings();
  if (settings.companion.bridgeKey.trim().length === 0) {
    throw new Error('Companion not configured.');
  }
  return await createPageContentClient(settings.companion).evidence(
    result.data.payload,
    'features_only',
  );
};

const PAGE_EVIDENCE_ATTENTION_GATE_MS = 5_000;
const PAGE_EVIDENCE_EXTRACTION_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const pageEvidenceAutoExtractedAtByCanonical = new Map<string, number>();

const maybeExtractAutoPageEvidence = async (
  tab: chrome.tabs.Tab,
  trigger: PageEvidenceTrigger,
  detail: Record<string, unknown> = {},
): Promise<void> => {
  const settings = await readSettings();
  if (settings.captureEnabled === false) return;
  if (settings.pageEvidenceAutoExtractEnabled !== true) return;
  if (typeof tab.id !== 'number') return;
  if (tab.incognito === true) return;
  const tabUrl = tab.url ?? '';
  if (!/^https?:\/\//u.test(tabUrl)) return;
  const canonicalUrl = canonicalThreadUrl(tabUrl);
  const now = Date.now();
  const previous = pageEvidenceAutoExtractedAtByCanonical.get(canonicalUrl);
  if (previous !== undefined && now - previous < PAGE_EVIDENCE_EXTRACTION_COOLDOWN_MS) return;
  pageEvidenceAutoExtractedAtByCanonical.set(canonicalUrl, now);
  try {
    await extractPageEvidenceFromTab(tab, trigger);
    await recordEngagementSyncDiag('pageEvidence.extracted', {
      ...detail,
      tabId: tab.id,
      trigger,
      canonicalUrl,
    });
    void broadcastWorkboardChanged('thread');
  } catch (error) {
    await recordEngagementSyncDiag('pageEvidence.failed', {
      ...detail,
      tabId: tab.id,
      trigger,
      canonicalUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const maybeExtractObservedPageEvidenceForTabId = async (
  tabId: number,
  detail: Record<string, unknown> = {},
): Promise<void> => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab === null) return;
  await maybeExtractAutoPageEvidence(tab, 'auto-observed', detail);
};

const maybeExtractAttentionGatePageEvidence = async (
  tabId: number,
  message: EngagementIntervalMessage,
): Promise<void> => {
  const focusedWindowMs = message.dimensions.engagement.focusedWindowMs;
  if (focusedWindowMs < PAGE_EVIDENCE_ATTENTION_GATE_MS) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab === null) return;
  await maybeExtractAutoPageEvidence(tab, 'attention-gate', {
    focusedWindowMs,
  });
};

const openTabPreviewForPageContent = (tab: chrome.tabs.Tab): PageContentOpenTabPreview => {
  const title =
    typeof tab.title === 'string' && tab.title.trim().length > 0
      ? tab.title.trim()
      : 'Untitled tab';
  const url = tab.url ?? '';
  const base = {
    tabId: typeof tab.id === 'number' ? tab.id : -1,
    title,
    url,
  };
  if (typeof tab.id !== 'number') {
    return { ...base, eligible: false, reason: 'Missing tab id' };
  }
  if (tab.incognito === true) {
    return { ...base, eligible: false, reason: 'Incognito tab' };
  }
  if (!/^https?:\/\//u.test(url)) {
    return { ...base, eligible: false, reason: 'Not an HTTP(S) page' };
  }
  return { ...base, eligible: true };
};

const pageContentOpenTabsPreview = async (): Promise<readonly PageContentOpenTabPreview[]> => {
  const tabs = await chrome.tabs.query({});
  const previews = tabs
    .map(openTabPreviewForPageContent)
    .sort(
      (left, right) =>
        Number(right.eligible) - Number(left.eligible) || left.title.localeCompare(right.title),
    );
  const seenCanonical = new Set<string>();
  return previews.map((preview) => {
    if (!preview.eligible) return preview;
    const canonicalUrl = canonicalThreadUrl(preview.url);
    if (seenCanonical.has(canonicalUrl)) {
      return { ...preview, eligible: false, reason: 'Duplicate open URL' };
    }
    seenCanonical.add(canonicalUrl);
    return preview;
  });
};

const indexOpenPageContentTabs = async (): Promise<PageContentBulkOperationResponse> => {
  const previews = await pageContentOpenTabsPreview();
  const eligibleIds = new Set(
    previews
      .filter((preview) => preview.eligible)
      .slice(0, PAGE_CONTENT_BULK_OPEN_TABS_LIMIT)
      .map((preview) => preview.tabId),
  );
  const allTabs = await chrome.tabs.query({});
  const eligibleTabs = allTabs.filter(
    (tab) => typeof tab.id === 'number' && eligibleIds.has(tab.id),
  );
  const sortedTabs = eligibleTabs.sort(
    (left, right) =>
      Number(right.active === true) - Number(left.active === true) ||
      (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0),
  );
  const coverages: PageContentCoverage[] = [];
  const failures: PageContentBulkOperationResponse['failures'][number][] = [];
  for (const tab of sortedTabs) {
    try {
      coverages.push(await extractPageContentFromTab(tab, 'page', 'bulk-open-tabs'));
    } catch (error) {
      failures.push({
        ...(typeof tab.title === 'string' ? { title: tab.title } : {}),
        ...(typeof tab.url === 'string' ? { url: tab.url } : {}),
        error: error instanceof Error ? error.message : 'Page-content indexing failed.',
      });
    }
  }
  const eligibleCount = previews.filter((preview) => preview.eligible).length;
  const skippedCount = Math.max(0, eligibleCount - sortedTabs.length) + failures.length;
  return {
    ok: failures.length === 0,
    indexedCount: coverages.length,
    skippedCount,
    coverages,
    failures,
    ...(failures.length === 0 ? {} : { error: `${String(failures.length)} open tab(s) failed.` }),
  };
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
  // Master capture switch off — refuse the explicit "+" capture too.
  // The toolbar disables the button when capture is off, so this is
  // defense-in-depth; the thrown message surfaces in the panel banner.
  if (!(await isCaptureEnabled())) {
    throw new Error('Capture is paused — turn the eye back on to capture this tab.');
  }
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

// Cached relay status from the most recent /v1/status response.
// buildWorkboardState reads this to surface the relay-disconnected
// banner — without caching, every state read would need a separate
// HTTP round-trip. Reset to null when settings change so a stale
// "connected" banner doesn't survive a companion swap.
let cachedRelayStatus: NonNullable<CompanionStatus['sync']>['relay'] | null = null;
// Connections snapshot revision from the last /v1/status response.
// Surfaces to the side panel via WorkboardState.snapshotRevision so
// it can detect when cached resolver suggestions have gone stale.
let cachedSnapshotRevision: string | null = null;

export const peekCachedRelayStatus = (): typeof cachedRelayStatus => cachedRelayStatus;
export const peekCachedSnapshotRevision = (): string | null => cachedSnapshotRevision;

// Connection identity (from /v1/version). Cached from the most
// recent poll like cachedRelayStatus. `cachedIdentityWarning` is set
// only when the live companion's vault diverges from the one pinned
// for this port on first attach — the foot-gun where a test/stale
// companion silently owns the daily port.
let cachedCompanionIdentity: WorkboardState['companionIdentity'] | null = null;
let cachedIdentityWarning: WorkboardState['companionIdentityWarning'] | null = null;

// Per-port pin of the companion identity. Keyed by port: changing
// the port is itself an explicit choice of a different companion,
// so it gets its own fresh pin. The "Trust this companion" action
// overwrites the pin for the current port.
const COMPANION_IDENTITY_PIN_KEY = 'sidetrack.companionIdentityPins';

const toWorkboardIdentity = (
  id: CompanionIdentity,
): NonNullable<WorkboardState['companionIdentity']> => ({
  companionVersion: id.companionVersion,
  ...(id.vaultRoot === undefined ? {} : { vaultRoot: id.vaultRoot }),
  ...(id.codePath === undefined ? {} : { codePath: id.codePath }),
  ...(id.instanceLabel === undefined ? {} : { instanceLabel: id.instanceLabel }),
  ...(id.pid === undefined ? {} : { pid: id.pid }),
});

const readIdentityPins = async (): Promise<Record<string, CompanionIdentity>> => {
  const stored = await chrome.storage.local.get({ [COMPANION_IDENTITY_PIN_KEY]: {} });
  const raw = stored[COMPANION_IDENTITY_PIN_KEY];
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, CompanionIdentity>) : {};
};

const writeIdentityPin = async (port: number, identity: CompanionIdentity): Promise<void> => {
  const pins = await readIdentityPins();
  pins[String(port)] = identity;
  await chrome.storage.local.set({ [COMPANION_IDENTITY_PIN_KEY]: pins });
};

// Fetch /v1/version, compare against the per-port pin, update the
// cached identity + warning. Best-effort: a failed /v1/version (old
// companion, transient error) leaves caches as-is — the /v1/status
// probe already surfaces a true disconnect.
const refreshCompanionIdentity = async (
  client: ReturnType<typeof createCompanionClient>,
  port: number,
): Promise<void> => {
  let identity: CompanionIdentity | null;
  try {
    identity = await client.version();
  } catch {
    return;
  }
  if (identity === null) {
    cachedCompanionIdentity = null;
    cachedIdentityWarning = null;
    return;
  }
  cachedCompanionIdentity = toWorkboardIdentity(identity);
  const pinned = (await readIdentityPins())[String(port)] ?? null;
  const verdict = compareCompanionIdentity(pinned, identity);
  if (verdict.kind === 'first-attach') {
    await writeIdentityPin(port, identity);
    cachedIdentityWarning = null;
    return;
  }
  if (verdict.kind === 'code-changed') {
    // Same vault — safe. Re-pin silently so a routine rebuild from
    // another checkout doesn't nag every poll; the Health panel
    // still shows the live codePath.
    await writeIdentityPin(port, identity);
    cachedIdentityWarning = null;
    return;
  }
  // match → no warning; vault-mismatch → blocking warning, NOT
  // re-pinned (the operator must fix the rogue companion or
  // explicitly Trust the new one).
  cachedIdentityWarning = identityWarningFor(verdict);
};

export const peekCachedCompanionIdentity = (): typeof cachedCompanionIdentity =>
  cachedCompanionIdentity;
export const peekCachedIdentityWarning = (): typeof cachedIdentityWarning => cachedIdentityWarning;

// Single probe body shared by the regular reachability check and the
// post-failure classifier. `quick` swaps the 45 s cold-start-tolerant
// status budget for the 4 s classification budget and skips the
// /v1/version identity refresh (an extra round-trip the classifier
// doesn't need — identity re-verifies on the next healthy poll).
const probeCompanion = async (opts: {
  readonly quick: boolean;
}): Promise<'connected' | 'vault-error' | 'local-only'> => {
  const settings = await readSettings();
  if (settings.companion.bridgeKey.length === 0) {
    cachedRelayStatus = null;
    cachedSnapshotRevision = null;
    cachedCompanionIdentity = null;
    cachedIdentityWarning = null;
    return 'local-only';
  }
  const client = createCompanionClient(settings.companion);
  const status = await (opts.quick ? client.statusQuick() : client.status());
  // Capture the live relay block (if any) so the workboard-state
  // builder can route a relay-disconnected banner without a
  // second round-trip.
  cachedRelayStatus = status.sync?.relay ?? null;
  cachedSnapshotRevision = status.snapshotRevision ?? null;
  if (!opts.quick) {
    // Connection identity check — detects a different companion (test
    // vs daily, stale build) silently owning the configured port.
    await refreshCompanionIdentity(client, settings.companion.port);
  }
  return status.vault === 'connected' ? 'connected' : 'vault-error';
};

const assertCompanionReachable = (): Promise<'connected' | 'vault-error' | 'local-only'> =>
  probeCompanion({ quick: false });

// Post-failure classification. A failed companion call must not, by
// itself, repaint the panel "disconnected — start the companion":
// heavy endpoints time out at their 5 s budget while the companion
// chews (observed live: 46-69 s timeline / page-evidence writes) even
// though the process is up and /v1/status answers in ~40 ms.
//
// Fast path: when the failure is a typed transport error, its kind
// already IS the classification — no probe round-trip:
//   timeout → 'busy' (alive, saturated — soft pill, no red banner)
//   network → 'disconnected' (nothing listening — red banner)
// Anything else (handler/logic errors, HTTP-shaped failures) asks the
// cheap /status probe what's actually true. The probe is single-flight
// and memoized for a few seconds: every failing call while the
// companion is saturated would otherwise spawn its own 4 s probe at
// the exact process that's overloaded.
const CLASSIFY_MEMO_MS = 3_000;
let classifyMemo: {
  readonly at: number;
  readonly status: 'connected' | 'busy' | 'disconnected' | 'vault-error' | 'local-only';
} | null = null;
let classifyInFlight: Promise<
  'connected' | 'busy' | 'disconnected' | 'vault-error' | 'local-only'
> | null = null;

const probeCompanionStatus = async (): Promise<
  'connected' | 'busy' | 'disconnected' | 'vault-error' | 'local-only'
> => {
  try {
    return await probeCompanion({ quick: true });
  } catch (probeError) {
    return probeError instanceof CompanionRequestError && probeError.kind === 'timeout'
      ? 'busy'
      : 'disconnected';
  }
};

const classifyCompanionFailure = async (
  error?: unknown,
): Promise<'connected' | 'busy' | 'disconnected' | 'vault-error' | 'local-only'> => {
  if (error instanceof CompanionRequestError) {
    return error.kind === 'timeout' ? 'busy' : 'disconnected';
  }
  const now = Date.now();
  if (classifyMemo !== null && now - classifyMemo.at < CLASSIFY_MEMO_MS) {
    return classifyMemo.status;
  }
  classifyInFlight ??= probeCompanionStatus()
    .then((status) => {
      classifyMemo = { at: Date.now(), status };
      return status;
    })
    .finally(() => {
      classifyInFlight = null;
    });
  return classifyInFlight;
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

const currentActiveTabSessionId = async (): Promise<string | undefined> => {
  try {
    const tab = await activeTab();
    if (typeof tab?.id !== 'number' || typeof tab.windowId !== 'number') return undefined;
    const replica = await loadOrCreateEdgeReplica();
    const tabIdHash = fnv1a64ForTabGroup(
      `${replica.edgeReplicaId}|tab|${String(tab.id)}|${String(tab.windowId)}`,
    ).slice(0, 16);
    return (await createChromeTabSessionStorage().get(tabIdHash))?.tabSessionId;
  } catch {
    return undefined;
  }
};

const buildState = async (
  companionStatus: WorkboardState['companionStatus'],
  lastError?: string,
): Promise<WorkboardState> => {
  const tab = await activeTab();
  const activeTabSessionId = await currentActiveTabSessionId();
  // Pull the cached relay status set by the most recent
  // assertCompanionReachable. Always fresh on a polling refresh
  // because withCompanionStatus calls assertCompanionReachable
  // before invoking buildState.
  const relayHealth = cachedRelayStatus ?? undefined;
  const snapshotRevision = cachedSnapshotRevision ?? undefined;
  return {
    ...(await buildWorkboardState(companionStatus, lastError, relayHealth, {
      ...(cachedCompanionIdentity === null ? {} : { identity: cachedCompanionIdentity }),
      ...(cachedIdentityWarning === null ? {} : { warning: cachedIdentityWarning }),
    })),
    ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
    ...(tab?.url === undefined ? {} : { activeTabUrl: tab.url }),
    ...(activeTabSessionId === undefined ? {} : { activeTabSessionId }),
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

const refreshCachedWorkstreams = async (): Promise<void> => {
  if (!(await isCompanionConfigured())) {
    return;
  }
  const settings = await readSettings();
  try {
    const projections = await createCompanionClient(settings.companion).listWorkstreamProjections();
    for (const projection of projections) {
      await mirrorRemoteWorkstream(projection);
    }
  } catch {
    // Companion unreachable or too old for the projection-list route.
    // Keep SSE/local state as-is and let the normal status surface
    // report connectivity separately.
  }
};

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
    // F15 — peer-mirrored dispatches arrive via the
    // `_BAC/dispatches/` SSE subscription and land in
    // recentDispatches via mirrorRemoteDispatch. Companion's GET
    // /v1/dispatches sources from the LOCAL JSONL writer only, so
    // peer dispatches aren't in `dispatches` here. Without this
    // merge the periodic poll would clobber every peer-mirrored
    // entry on every refresh; we union by bac_id so peer entries
    // survive.
    const remoteIds = new Set(dispatches.map((d) => d.bac_id));
    const peerOnly = local.filter((d) => !remoteIds.has(d.bac_id));
    const merged = [
      ...dispatches.map((d) => {
        const override = localOverrides.get(d.bac_id);
        return override === undefined ? d : { ...d, status: override };
      }),
      ...peerOnly,
    ];
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
    // Replay failures must not abort the refresh or poison the
    // connection state: the captures stay queued (queuedCaptureCount
    // still surfaces them) and the next poll retries. Before this
    // isolation, one slow replay POST timing out re-painted the panel
    // "disconnected" on every 15 s poll for as long as the companion
    // stayed busy.
    await replayQueuedCaptures().catch(() => undefined);
    const status = await assertCompanionReachable();
    if (status === 'connected') {
      await refreshCachedWorkstreams();
    }
    await refreshCachedCodingSessions();
    await refreshCachedDispatches();
    const state = await buildState(status);
    if (work !== undefined && reason !== undefined) {
      void broadcastWorkboardChanged(reason);
    }
    return { ok: true, state };
  } catch (error) {
    // The side panel needs to learn about a transition to
    // disconnected (or vault-error) the same way it learns about
    // a successful capture. Without this broadcast, the user
    // takes an action while offline, the optimistic local write
    // happens, and the UI silently lies "connected" until the
    // 15s periodic poll at sidepanel/App.tsx:723 catches up.
    if (work !== undefined && reason !== undefined) {
      void broadcastWorkboardChanged(reason);
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Sidetrack background action failed.',
      state: await buildState(
        await classifyCompanionFailure(error),
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
    // Master capture switch (the side-panel eye) is off — drop silently,
    // capture nothing. content.ts is statically registered so we can't
    // unregister it; this handler gate is the stop for AI-thread auto.
    if (!(await isCaptureEnabled())) {
      return { ok: true, state: await buildState('connected') };
    }
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

  if (request.type === messageTypes.trustCurrentCompanion) {
    // Operator confirmed the flagged companion is the intended one
    // — re-pin the identity for the current port to whatever is
    // answering now, clearing the blocking banner.
    return await withCompanionStatus(async () => {
      const settings = await readSettings();
      try {
        const identity = await createCompanionClient(settings.companion).version();
        if (identity !== null) {
          await writeIdentityPin(settings.companion.port, identity);
          cachedCompanionIdentity = toWorkboardIdentity(identity);
        }
      } catch {
        // version() failed — leave the pin; the next poll retries.
      }
      cachedIdentityWarning = null;
    }, 'settings');
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
    return await withCompanionStatus(() => deleteWorkstream(request.workstreamId), 'workstream');
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


  if (
    request.type === messageTypes.pageContentIndexCurrent ||
    request.type === messageTypes.pageContentIndexSelection
  ) {
    const buildPageContentResponse = async (): Promise<PageContentOperationResponse> => {
      try {
        const tab = await activeTab();
        if (tab === undefined) return { ok: false, error: 'No active tab is available.' };
        const coverage = await extractPageContentFromTab(
          tab,
          request.type === messageTypes.pageContentIndexSelection ? 'selection' : 'page',
        );
        return { ok: true, coverage };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Page-content indexing failed.',
        };
      }
    };
    return (await buildPageContentResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.pageContentOpenTabsPreview) {
    const buildPreviewResponse = async (): Promise<PageContentOpenTabsPreviewResponse> => {
      try {
        const tabs = await pageContentOpenTabsPreview();
        return {
          ok: true,
          tabs,
          eligibleCount: tabs.filter((tab) => tab.eligible).length,
        };
      } catch (error) {
        return {
          ok: false,
          tabs: [],
          eligibleCount: 0,
          error: error instanceof Error ? error.message : 'Open-tab preview failed.',
        };
      }
    };
    return (await buildPreviewResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.pageContentIndexOpenTabs) {
    const buildBulkResponse = async (): Promise<PageContentBulkOperationResponse> => {
      try {
        const settings = await readSettings();
        if (settings.companion.bridgeKey.trim().length === 0) {
          return {
            ok: false,
            indexedCount: 0,
            skippedCount: 0,
            coverages: [],
            failures: [],
            error: 'Companion not configured.',
          };
        }
        return await indexOpenPageContentTabs();
      } catch (error) {
        return {
          ok: false,
          indexedCount: 0,
          skippedCount: 0,
          coverages: [],
          failures: [],
          error: error instanceof Error ? error.message : 'Open-tab indexing failed.',
        };
      }
    };
    return (await buildBulkResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.pageContentCoverage) {
    const buildCoverageResponse = async (): Promise<PageContentOperationResponse> => {
      try {
        const settings = await readSettings();
        if (settings.companion.bridgeKey.trim().length === 0) {
          return { ok: false, error: 'Companion not configured.' };
        }
        const coverage = await createPageContentClient(settings.companion).coverage(
          request.canonicalUrl,
        );
        return { ok: true, coverage };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Coverage lookup failed.',
        };
      }
    };
    return (await buildCoverageResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.pageContentDelete) {
    const buildDeleteResponse = async (): Promise<PageContentOperationResponse> => {
      try {
        const settings = await readSettings();
        if (settings.companion.bridgeKey.trim().length === 0) {
          return { ok: false, error: 'Companion not configured.' };
        }
        const coverage = await createPageContentClient(settings.companion).delete(
          request.canonicalUrl,
        );
        return { ok: true, coverage };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Page-content delete failed.',
        };
      }
    };
    return (await buildDeleteResponse()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.recallV2Query) {
    // Recall v2 — POST /v2/recall via the bridge. Returns the
    // RecallResponse opaque to the extension; callers narrow as
    // needed. Companion does fusion/dedupe/suppression server-side.
    //
    // P0 / PR-B — active-session marker contract. The content script
    // only knows `currentUrl`; the background SW knows the recent
    // dispatches (Ask-AI artifacts, very recent thread creations). We
    // ENRICH the request here by injecting:
    //   - activeChatBacIds: every dispatch within the last 10 minutes
    // The server surfaces matching results with
    // meta.activeSessionMarkers instead of hiding them, so rank order
    // stays intact and the UI can render a presentation-only badge.
    const buildRecallV2Response = async (): Promise<unknown> => {
      try {
        const settings = await readSettings();
        if (settings.companion.bridgeKey.trim().length === 0) {
          // Phase 10 — companion not configured → fall back to local
          // OPFS-FTS5 store so the user still gets timeline-visit
          // matches. Best-effort; if local store unavailable, return
          // the empty error response so the UI shows nothing.
          return await tryLocalFallback(request.req as Record<string, unknown>, 'no-companion');
        }
        const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
        const cutoffMs = Date.now() - ACTIVE_WINDOW_MS;
        const dispatches = await readCachedDispatches();
        const activeArtifactBacIds = dispatches
          .filter((d) => {
            const ts = Date.parse(d.createdAt);
            return !Number.isNaN(ts) && ts >= cutoffMs;
          })
          .map((d) => d.bac_id);
        // Merge user-supplied session info with the SW-derived
        // suppression context. User overrides take precedence on
        // currentUrl etc.; we only ADD to activeChatBacIds.
        const req = request.req as Record<string, unknown>;
        const userSession =
          (req['session'] as Record<string, unknown> | undefined) ?? {};
        const userActive =
          (userSession['activeChatBacIds'] as readonly string[] | undefined) ?? [];
        // Scope B — intent dictates the suppression posture. The
        // server's per-intent defaults handle suppressCurrentPage +
        // minHitAgeMs correctly (search/focus = 'never' + 0, dejavu =
        // 'always' + 5min). The background should NOT bulldoze those
        // defaults with dejavu-shaped values for every intent —
        // doing so silently dropped the active page from Search
        // results and silenced fresh chats from focus/Search alike.
        //
        // We still always inject the dispatch-cache derived
        // activeChatBacIds (the SW knows recent dispatches the
        // server can't see in its in-process state), but the rest
        // of the suppression policy is intent-aware.
        const intent = typeof req['intent'] === 'string' ? req['intent'] : 'dejavu';
        const callerSuppression =
          (req['suppression'] as Record<string, unknown> | undefined) ?? {};
        const mergedActiveBacIds = [
          ...new Set([...userActive, ...activeArtifactBacIds]),
        ];
        const suppression: Record<string, unknown> = {
          // activeChatBacIds — always added; harmless for search
          // (callers may pass [] or omit), useful for dejavu.
          suppressActiveChatBacIds: mergedActiveBacIds,
          // For dejavu, keep suppress-current-page since the user
          // just selected text on that page. Do not add the old
          // 10-minute minHitAgeMs floor here: active chats are now
          // marked for presentation, not filtered by age.
          ...(intent === 'dejavu'
            ? {
                suppressCurrentPage: 'always' as const,
              }
            : {}),
          // Caller can still override anything via req.suppression
          // (highest priority).
          ...callerSuppression,
        };
        const enrichedReq = {
          ...req,
          session: {
            ...userSession,
            activeChatBacIds: mergedActiveBacIds,
          },
          suppression,
        };
        try {
          const data = await createPageContentClient(settings.companion).recallV2(enrichedReq);
          return { ok: true, ...data };
        } catch (error) {
          // Companion unreachable / errored — try local before giving up.
          const local = await tryLocalFallback(enrichedReq, 'companion-error');
          if (local !== null) return local;
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Recall v2 query failed.',
            results: [],
            meta: {},
          };
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Recall v2 query failed.',
          results: [],
          meta: {},
        };
      }
    };
    return (await buildRecallV2Response()) as unknown as RuntimeResponse;
  }

  if (request.type === messageTypes.recallActionEmit) {
    // Phase 0 of the recall+ranker v2 hard-replacement.
    // The content script / sidepanel forwards user actions on served
    // recall candidates here. We POST to /v1/recall/action so the
    // companion can append a `recall.action` event joined to its
    // parent `recall.served` by `servedContextId`. Fire-and-forget:
    // emission failures must never block the user's click.
    const emit = async (): Promise<void> => {
      try {
        const settings = await readSettings();
        if (settings.companion.bridgeKey.trim().length === 0) {
          // No companion configured — nothing to log. Silent.
          return;
        }
        const payload = request.payload as {
          readonly payloadVersion: 1;
          readonly servedContextId: string;
          readonly entityId: string;
          readonly actionKind: string;
          readonly actionAt: string;
          readonly referencesEventId?: string;
        };
        await createPageContentClient(settings.companion).recallAction(payload);
      } catch (error) {
        // Logged but never surfaced. The impression-log is best-effort
        // from the extension's perspective; the trainer tolerates
        // missing actions for some served impressions.
        console.warn(
          '[sidetrack] recall.action emit failed',
          error instanceof Error ? error.message : error,
        );
      }
    };
    void emit();
    return { ok: true } as unknown as RuntimeResponse;
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

  if (request.type === messageTypes.openConnectionsDejaVu) {
    // Content-script "See all" → relay payload verbatim so the side
    // panel can switch to Connections → Déjà-vu submode with the
    // popover hit list persisted. selectionText + sourceUrl ride
    // along so the submode can render the same action bar / chip
    // header / "from <host>" pill the popover had.
    void chrome.runtime
      .sendMessage({
        type: messageTypes.openConnectionsDejaVu,
        items: request.items,
        selectionText: request.selectionText,
        sourceUrl: request.sourceUrl,
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

  if (request.type === messageTypes.submitSelectionDispatch) {
    return await withCompanionStatus(async () => {
      const { url, body, provider, title } = request;
      // Make a Déjà-vu selection "Ask AI" a FIRST-CLASS tracked
      // dispatch: record it on the companion so it appears in Recent
      // dispatches and auto-links back when the new chat is captured —
      // exactly like a thread dispatch, just with no source thread /
      // workstream (both optional end-to-end). If the companion isn't
      // configured we still open + auto-send (graceful degrade).
      try {
        const settings = await readSettings();
        if (settings.companion.bridgeKey.trim().length > 0) {
          const client = createDispatchClient(settings.companion);
          const idempotencyKey = `disp_sel_${String(Date.now())}_${Math.random()
            .toString(36)
            .slice(2, 10)}`;
          const result = await client.submit(
            { kind: 'research', target: { provider, mode: 'auto-send' }, title, body },
            idempotencyKey,
          );
          // Feeds the auto-link matcher (it compares the UNREDACTED
          // body against the captured chat's first user turn).
          await writeDispatchOriginal(result.bac_id, body);
          // Persist the Déjà-vu breadcrumb if the caller shipped one
          // (Ask AI from a popover selection). Stays local-only — the
          // companion has nothing to do with this; it just powers the
          // "↩" pill on the Recent dispatches row in the sidepanel.
          if (request.recallContext !== undefined) {
            await writeDispatchRecallContext(result.bac_id, request.recallContext);
          }
          // Optimistic local row so it shows immediately; the next
          // companion poll merge is idempotent by bac_id.
          const record: DispatchEventRecord = {
            bac_id: result.bac_id,
            kind: 'research',
            target: { provider, mode: 'auto-send' },
            title,
            body,
            createdAt: new Date().toISOString(),
            redactionSummary: result.redactionSummary ?? { matched: 0, categories: [] },
            tokenEstimate: result.tokenEstimate ?? 0,
            status: 'sent',
          };
          await writeCachedDispatches([record, ...(await readCachedDispatches())].slice(0, 50));
        }
      } catch (error) {
        console.warn('[submitSelectionDispatch] companion submit failed:', error);
      }
      // Open + auto-send + auto-capture — identical to the
      // dispatchAutoSendInNewTab path (drives the auto-link too).
      try {
        const created = await chrome.tabs.create({ url, active: true });
        const tabId = created.id;
        if (typeof tabId !== 'number') {
          console.warn('[submitSelectionDispatch] tab create returned no tabId');
          return;
        }
        autoSendOnceTabReady(tabId, body);
      } catch (error) {
        console.warn('[submitSelectionDispatch] open failed:', error);
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
          await classifyCompanionFailure(error),
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
      if (typeof request.preferences.captureEnabled === 'boolean') {
        await saveCaptureEnabled(request.preferences.captureEnabled);
        // The master switch gates the dynamically-registered observation
        // scripts (engagement, visual-fingerprint). Re-sync so they
        // unregister immediately when capture is turned off and come
        // back when it's turned on — don't wait for the next nav/poll.
        void syncPrivacyGatedContentScriptRegistrations().catch(() => undefined);
      }
      if (typeof request.preferences.autoTrack === 'boolean') {
        await saveAutoTrack(request.preferences.autoTrack);
      }
      if (typeof request.preferences.vaultPath === 'string') {
        await saveVaultPath(request.preferences.vaultPath);
      }
      if (typeof request.preferences.notifyOnQueueComplete === 'boolean') {
        await saveNotifyOnQueueComplete(request.preferences.notifyOnQueueComplete);
      }
      if (typeof request.preferences.pageEvidenceAutoExtractEnabled === 'boolean') {
        await savePageEvidenceAutoExtractEnabled(
          request.preferences.pageEvidenceAutoExtractEnabled,
        );
        if (request.preferences.pageEvidenceAutoExtractEnabled) {
          const tab = await activeTab();
          if (tab !== undefined) {
            void maybeExtractAutoPageEvidence(tab, 'auto-observed', {
              source: 'settings-enabled',
            });
          }
        }
      }
      if (typeof request.preferences.recallEmitTrainableActions === 'boolean') {
        await saveRecallEmitTrainableActions(request.preferences.recallEmitTrainableActions);
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

// chrome.scripting.registerContentScripts only matches FUTURE navigations.
// Already-open tabs from before the registration won't run the engagement
// script until they refresh. Without this catch-up inject, dogfooders
// see zero engagement counters until they manually reload every tab.
// Run after registration sync — idempotent on tabs that already have it
// because the engagement runtime keys its aggregator by visitId.
const reinjectEngagementScriptIntoOpenTabs = async (): Promise<void> => {
  if (!(await isEngagementPrivacyGateOpen()) || !(await hasEngagementHostPermission())) {
    await recordEngagementSyncDiag('reinject.skipped', { reason: 'gate-or-permission-closed' });
    return;
  }
  try {
    const tabs = await chrome.tabs.query({ url: [...ENGAGEMENT_HOST_ORIGINS] });
    const results = await Promise.all(
      tabs.map(async (tab) => {
        if (typeof tab.id !== 'number') return { tabId: null, ok: false, reason: 'no-id' };
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: [ENGAGEMENT_CONTENT_SCRIPT_FILE],
          });
          return { tabId: tab.id, ok: true, url: tab.url?.slice(0, 80) ?? null };
        } catch (error) {
          return {
            tabId: tab.id,
            ok: false,
            url: tab.url?.slice(0, 80) ?? null,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    await recordEngagementSyncDiag('reinject.attempted', {
      tabsFound: tabs.length,
      injected: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      sample: results.slice(0, 3),
    });
  } catch (error) {
    await recordEngagementSyncDiag('reinject.query-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
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
  // chrome.storage.session is the in-memory backing for our diagnostic
  // journals (engagement.diag, dev.diag). By default session storage
  // from a background SW is only readable from the SAME context, which
  // means side-panel DevTools can't pull it. Bumping the access level
  // to TRUSTED_CONTEXTS lets the side panel + popup read it without
  // affecting content-script access. Best-effort: older Chromes that
  // don't ship session storage just throw, which we swallow.
  try {
    void chrome.storage.session
      .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
      .catch(() => undefined);
  } catch {
    // chrome.storage.session unavailable — leave as default.
  }

  const tabOpenerStore = createTabOpenerStore();
  registerTabLifecycleListeners(chrome.tabs, tabOpenerStore);
  let requestEdgeEventDrain: () => void = () => undefined;
  const webNavigationRuntime = registerDefaultWebNavigationListeners(tabOpenerStore, {
    onNavigationBuffered: () => requestEdgeEventDrain(),
  });

  const engagementEventBuffer = new IndexedDbEventBuffer();
  let engagementRuntimePromise: Promise<{
    readonly edgeReplicaId: string;
    readonly cache: ReturnType<typeof createEngagementCache>;
  }> | null = null;
  const engagementRuntime = async (): Promise<{
    readonly edgeReplicaId: string;
    readonly cache: ReturnType<typeof createEngagementCache>;
  }> => {
    if (engagementRuntimePromise !== null) return engagementRuntimePromise;
    engagementRuntimePromise = (async () => {
      const replica = await loadOrCreateEdgeReplica();
      return {
        edgeReplicaId: replica.edgeReplicaId,
        cache: createEngagementCache({ sessionId: `session:${replica.edgeReplicaId}` }),
      };
    })();
    return engagementRuntimePromise;
  };

  const appendEngagementEvents = async (
    payloads: readonly {
      readonly streamName: 'engagement.interval.observed' | 'engagement.session.aggregated';
      readonly payload: EngagementIntervalObservedPayload | EngagementSessionAggregatedPayload;
    }[],
  ): Promise<void> => {
    if (payloads.length === 0) return;
    const allocated = await allocateNextSeq(payloads.length);
    const observedAt = new Date().toISOString();
    await engagementEventBuffer.appendMany(
      payloads.map((event, index) => ({
        streamName: event.streamName,
        lamport: allocated.fromSeq + index,
        replicaId: allocated.edgeReplicaId,
        payload: event.payload,
        observedAt,
      })),
    );
  };

  const handleEngagementInterval = async (
    message: unknown,
    tabId: number | undefined,
  ): Promise<void> => {
    if (tabId === undefined) {
      await recordEngagementSyncDiag('interval.dropped', { reason: 'no-tabId' });
      return;
    }
    if (!isEngagementIntervalMessage(message)) {
      await recordEngagementSyncDiag('interval.dropped', {
        reason: 'shape-mismatch',
        rawType: typeof message,
      });
      return;
    }
    // Master capture switch off — drop in-flight intervals. The script
    // is unregistered when capture is off, but a message can still be in
    // transit at the instant of the flip; this is belt-and-suspenders.
    if (!(await isCaptureEnabled())) {
      await recordEngagementSyncDiag('interval.dropped', { reason: 'capture-disabled', tabId });
      return;
    }
    const runtime = await engagementRuntime();
    const merged = runtime.cache.mergeInterval(tabId, message);
    const payloads: {
      readonly streamName: 'engagement.interval.observed' | 'engagement.session.aggregated';
      readonly payload: EngagementIntervalObservedPayload | EngagementSessionAggregatedPayload;
    }[] = [{ streamName: 'engagement.interval.observed', payload: merged.interval }];
    if (message.final) {
      payloads.push({ streamName: 'engagement.session.aggregated', payload: merged.aggregate });
    }
    await appendEngagementEvents(payloads);
    await recordEngagementSyncDiag('interval.buffered', {
      tabId,
      final: message.final,
      payloadCount: payloads.length,
    });
    void maybeExtractAttentionGatePageEvidence(tabId, message);
  };

  const finalizeEngagementForTab = async (tabId: number): Promise<void> => {
    const runtime = await engagementRuntime();
    const finalized = runtime.cache.finalizeTab(tabId, Date.now());
    if (finalized === null) return;
    await appendEngagementEvents([
      { streamName: 'engagement.interval.observed', payload: finalized.interval },
      { streamName: 'engagement.session.aggregated', payload: finalized.aggregate },
    ]);
  };

  const handleSelectionLineage = async (message: unknown): Promise<void> => {
    if (!isSelectionLineageMessage(message)) return;
    // Master capture switch off — don't record copy/paste lineage.
    if (!(await isCaptureEnabled())) return;
    const allocated = await allocateNextSeq(1);
    const streamName =
      message.type === 'sidetrack.selection.copied' ? 'selection.copied' : 'selection.pasted';
    await engagementEventBuffer.appendMany([
      {
        streamName,
        lamport: allocated.fromSeq,
        replicaId: allocated.edgeReplicaId,
        payload: message.payload as SelectionCopiedPayload | SelectionPastedPayload,
        observedAt: new Date().toISOString(),
      },
    ]);
  };

  const handleVisualFingerprintObserved = async (message: unknown): Promise<void> => {
    if (!isVisualFingerprintObservedMessage(message)) return;
    if (!(await isVisualFingerprintPrivacyGateOpen())) return;
    const allocated = await allocateNextSeq(1);
    await engagementEventBuffer.appendMany([
      {
        streamName: VISUAL_FINGERPRINT_OBSERVED,
        lamport: allocated.fromSeq,
        replicaId: allocated.edgeReplicaId,
        payload: message.payload as VisualFingerprintObservedPayload,
        observedAt: message.payload.observedAt,
      },
    ]);
  };

  const aggregateIdForBufferedEdgeEvent = (event: BufferedEvent): string => {
    const payload =
      typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    const visitId = payload['visitId'];
    if (typeof visitId === 'string' && visitId.length > 0) {
      return `${event.streamName}:${visitId}`;
    }
    const canonicalUrl = payload['canonicalUrl'];
    if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
      return `${event.streamName}:${canonicalUrl}`;
    }
    const selectionHash = payload['selectionHash'];
    if (typeof selectionHash === 'string' && selectionHash.length > 0) {
      return `${event.streamName}:${selectionHash}`;
    }
    return `${event.streamName}:${event.observedAt.slice(0, 10)}`;
  };

  const EDGE_EVENT_DRAIN_ROUTE_BATCH_SIZE = 10;
  const EDGE_EVENT_DRAIN_SCAN_BATCH_SIZE = 500;
  const EDGE_EVENT_DRAIN_DEFAULT_MAX_BATCHES = 1;
  const EDGE_EVENT_DRAIN_BULK_MAX_BATCHES = 50;

  const mergeCounts = (...counts: readonly Record<string, number>[]): Record<string, number> => {
    const merged: Record<string, number> = {};
    for (const count of counts) {
      for (const [key, value] of Object.entries(count)) {
        merged[key] = (merged[key] ?? 0) + value;
      }
    }
    return merged;
  };

  interface EdgeEventDrainStats {
    readonly uploaded: number;
    readonly evicted: number;
    readonly remaining: number;
    readonly skipped: number;
    readonly uploadedByType: Record<string, number>;
    readonly evictedByType: Record<string, number>;
    readonly skippedByReason: Record<string, number>;
  }

  const emptyEdgeEventDrainStats = (remaining: number): EdgeEventDrainStats => ({
    uploaded: 0,
    evicted: 0,
    remaining,
    skipped: 0,
    uploadedByType: {},
    evictedByType: {},
    skippedByReason: {},
  });

  const mergeEdgeEventDrainStats = (
    left: EdgeEventDrainStats,
    right: EdgeEventDrainStats,
  ): EdgeEventDrainStats => ({
    uploaded: left.uploaded + right.uploaded,
    evicted: left.evicted + right.evicted,
    remaining: right.remaining,
    skipped: left.skipped + right.skipped,
    uploadedByType: mergeCounts(left.uploadedByType, right.uploadedByType),
    evictedByType: mergeCounts(left.evictedByType, right.evictedByType),
    skippedByReason: mergeCounts(left.skippedByReason, right.skippedByReason),
  });

  const drainBufferedEdgeEventsOnce = async (): Promise<EdgeEventDrainStats> => {
    const companion = await readTimelineCompanionConfig();
    if (companion === null || companion.url.trim().length === 0) {
      return emptyEdgeEventDrainStats(await engagementEventBuffer.count());
    }

    const priorityBatch =
      (await engagementEventBuffer.peekByStream?.(
        'navigation.committed',
        EDGE_EVENT_DRAIN_ROUTE_BATCH_SIZE,
      )) ?? [];
    const scannedBatch =
      priorityBatch.length > 0
        ? []
        : await engagementEventBuffer.peek(EDGE_EVENT_DRAIN_SCAN_BATCH_SIZE);
    const batch = selectEdgeEventDrainScanBatch(priorityBatch, scannedBatch);
    if (batch.length === 0) {
      return emptyEdgeEventDrainStats(0);
    }

    const {
      routeBatch,
      locallyRejectedBatch,
      evictedByType: localEvictedByType,
      skippedByReason: localSkippedByReason,
    } = partitionEdgeEventDrainBatch(batch, EDGE_EVENT_DRAIN_ROUTE_BATCH_SIZE);
    const locallyEvicted = 0;
    void locallyRejectedBatch; // always empty post-2026-05; kept for ABI
    if (routeBatch.length === 0) {
      return {
        uploaded: 0,
        evicted: locallyEvicted,
        remaining: await engagementEventBuffer.count(),
        skipped: locallyRejectedBatch.length,
        uploadedByType: {},
        evictedByType: localEvictedByType,
        skippedByReason: localSkippedByReason,
      };
    }

    const events = routeBatch.map((event) => ({
      clientEventId: `edge:${event.streamName}:${event.replicaId}:${String(event.lamport)}`,
      dot: { replicaId: event.replicaId, seq: event.lamport },
      deps: {},
      aggregateId: aggregateIdForBufferedEdgeEvent(event),
      type: event.streamName,
      payload: event.payload,
      acceptedAtMs: Date.parse(event.observedAt) || Date.now(),
    }));

    const res = await fetch(`${companion.url.replace(/\/$/u, '')}/v1/edge/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': companion.bridgeKey,
      },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) {
      throw new Error(`edge-event drain HTTP ${String(res.status)}`);
    }
    const json = (await res.json()) as {
      data?: {
        imported?: { readonly replicaId: string; readonly seq: number }[];
        skipped?: { readonly replicaId: string; readonly seq: number; readonly reason: string }[];
      };
    };
    const imported = json.data?.imported ?? [];
    const skipped = json.data?.skipped ?? [];
    const summary = summarizeEdgeEventDrain(routeBatch, imported, skipped);
    const deleted = await engagementEventBuffer.deleteMany(summary.acceptedEvents);
    const evicted =
      locallyEvicted + (await engagementEventBuffer.deleteMany(summary.permanentlyRejectedEvents));
    return {
      uploaded: deleted,
      evicted,
      remaining: await engagementEventBuffer.count(),
      skipped: skipped.length + locallyRejectedBatch.length,
      uploadedByType: summary.uploadedByType,
      evictedByType: mergeCounts(localEvictedByType, summary.evictedByType),
      skippedByReason: mergeCounts(localSkippedByReason, summary.skippedByReason),
    };
  };

  const drainBufferedEdgeEventsLoop = async (
    maxBatches = EDGE_EVENT_DRAIN_DEFAULT_MAX_BATCHES,
  ): Promise<EdgeEventDrainStats> => {
    let total: EdgeEventDrainStats | null = null;
    const batchLimit = Math.max(1, Math.floor(maxBatches));
    for (let i = 0; i < batchLimit; i += 1) {
      const next = await drainBufferedEdgeEventsOnce();
      total = total === null ? next : mergeEdgeEventDrainStats(total, next);
      if (next.remaining === 0) break;
      if (next.uploaded === 0 && next.evicted === 0) break;
    }
    return total ?? emptyEdgeEventDrainStats(await engagementEventBuffer.count());
  };

  const drainBufferedEdgeEvents = createEdgeEventDrainSingleFlight(() =>
    drainBufferedEdgeEventsLoop(),
  );
  const drainBufferedEdgeEventsBulk = createEdgeEventDrainSingleFlight(() =>
    drainBufferedEdgeEventsLoop(EDGE_EVENT_DRAIN_BULK_MAX_BATCHES),
  );
  requestEdgeEventDrain = () => {
    void drainBufferedEdgeEvents().catch((error: unknown) => {
      console.warn('[edge-events.drain] navigation-triggered drain failed:', error);
    });
  };

  // Drop reminders bound to thread bac_ids that no longer exist.
  // Cleanup pass for the historical mess caused by the pre-fix
  // sendToCompanion bug (every capture reissued a thread bac_id;
  // reminders accumulated against orphans). Idempotent — runs on
  // every service-worker boot, no-op when storage is already clean.
  // Periodic drain for buffered edge events (engagement.interval.observed,
  // engagement.session.aggregated, selection.copied, selection.pasted,
  // visual.fingerprint.observed). Pre-fix, drainBufferedEdgeEvents was
  // only invoked by the test-only `sidetrack.edge-events.force-drain`
  // message, so in production engagement events accumulated in
  // IndexedDB indefinitely and the materializer's engagement counters
  // stayed at zero forever — that's why ranker training had 794
  // positive labels and 0 negatives, the similarity ranker stayed at 0
  // edges, and URL auto-attribution never inferred. 1-minute cadence
  // matches the dispatch poll: Chrome's alarm minimum, and the
  // engagement aggregator's own emit interval is 30 s so the worst-case
  // end-to-end latency is < 90 s.
  const EDGE_EVENTS_DRAIN_ALARM = 'sidetrack.edge-events.drain';
  const ensureEdgeEventsDrainAlarm = async (): Promise<void> => {
    try {
      await chrome.alarms.create(EDGE_EVENTS_DRAIN_ALARM, { periodInMinutes: 1 });
    } catch (error) {
      console.warn('[edge-events.drain] alarm create failed:', error);
    }
  };

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

  const sealTabSessionsOnServiceWorkerWake = async (): Promise<void> => {
    try {
      const result = await sealOrphanTabSessionsOnWake(createChromeTabSessionStorage());
      if (result.sealed > 0) {
        console.warn(`[tabsession.sealed-on-wake] sealed ${String(result.sealed)} orphan sessions`);
      }
    } catch (error) {
      console.warn('[tabsession.sealed-on-wake] failed:', error);
    }
  };

  chrome.runtime.onInstalled.addListener((details) => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
    void pruneOrphanRemindersAndLinks();
    void sealTabSessionsOnServiceWorkerWake();
    void ensureDispatchPollAlarm();
    void syncPrivacyGatedContentScriptRegistrations().catch(() => undefined);
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
    void sealTabSessionsOnServiceWorkerWake();
    void reinjectContentScriptIntoOpenTabs();
    void ensureDispatchPollAlarm();
    void syncPrivacyGatedContentScriptRegistrations().catch(() => undefined);
  });
  void sealTabSessionsOnServiceWorkerWake();
  void syncPrivacyGatedContentScriptRegistrations().catch(() => undefined);

  chrome.permissions.onAdded.addListener(() => {
    void syncPrivacyGatedContentScriptRegistrations().catch(() => undefined);
  });
  chrome.permissions.onRemoved.addListener(() => {
    void syncPrivacyGatedContentScriptRegistrations().catch(() => undefined);
  });
  chrome.idle.onStateChanged.addListener((state) => {
    void (async () => {
      const tabs = await chrome.tabs.query({ url: [...ENGAGEMENT_HOST_ORIGINS] });
      await Promise.all(
        tabs.map(async (tab) => {
          if (typeof tab.id !== 'number') return;
          await chrome.tabs
            .sendMessage(tab.id, {
              type: 'sidetrack.engagement.idle',
              idle: state !== 'active',
            })
            .catch(() => undefined);
        }),
      );
    })().catch(() => undefined);
  });

  // Periodic background poll for new MCP-auto-approved dispatches.
  // Without this, refreshCachedDispatches only fires when the side
  // panel makes a workboard request — meaning agent-initiated
  // dispatches sit unconsumed if the side panel is closed. Chrome's
  // alarm minimum is 1 minute, so the worst-case latency from
  // bac.request_dispatch to "tab opens" is ~1 minute. The alarm is
  // additive; explicit side-panel actions still trigger immediately.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === DISPATCH_POLL_ALARM) {
      void (async () => {
        try {
          if (!(await isCompanionConfigured())) return;
          await refreshCachedDispatches();
        } catch (error) {
          console.warn('[dispatch.poll] failed:', error);
        }
      })();
      return;
    }
    if (alarm.name === EDGE_EVENTS_DRAIN_ALARM) {
      void drainBufferedEdgeEvents().catch((error: unknown) => {
        console.warn('[edge-events.drain] periodic drain failed:', error);
      });
      return;
    }
  });
  void ensureDispatchPollAlarm();
  void ensureEdgeEventsDrainAlarm();
  // Eager first drain on SW boot — picks up anything buffered across a
  // service-worker restart so the first drain doesn't wait a full minute.
  void drainBufferedEdgeEvents().catch(() => undefined);

  // Debug hook for the SW DevTools console. `chrome.runtime.sendMessage`
  // from the SW itself never reaches the SW's own onMessage listener
  // (Chrome routes those only to OTHER extension contexts) — so the
  // `sidetrack.dev.ping` + `.edge-events.force-drain` messages always
  // returned `undefined` when invoked from chrome://extensions ->
  // service worker -> Inspect. Exposing these on globalThis lets the
  // operator call them directly without crossing the message bus.
  //
  // Usage from the SW DevTools console:
  //   sidetrackDebug.build           — version/sha/dirty/builtAt
  //   await sidetrackDebug.drainEdgeEvents()      — one quick capped batch
  //   await sidetrackDebug.drainEdgeEventsBulk()  — deliberate catch-up
  //   await sidetrackDebug.engagementBufferCount()
  //   await sidetrackDebug.engagementGate()
  //   await sidetrackDebug.engagementHostPermission()
  //   await sidetrackDebug.engagementRegistrations()
  (globalThis as unknown as { sidetrackDebug?: unknown }).sidetrackDebug = {
    build: __BUILD_INFO__,
    drainEdgeEvents: drainBufferedEdgeEvents,
    drainEdgeEventsBulk: drainBufferedEdgeEventsBulk,
    engagementBufferCount: () => engagementEventBuffer.count(),
    engagementGate: isEngagementPrivacyGateOpen,
    engagementHostPermission: hasEngagementHostPermission,
    engagementRegistrations: () =>
      chrome.scripting.getRegisteredContentScripts({ ids: [ENGAGEMENT_CONTENT_SCRIPT_ID] }),
    syncRegistrations: syncPrivacyGatedContentScriptRegistrations,
    reinjectEngagementIntoOpenTabs: reinjectEngagementScriptIntoOpenTabs,
  };

  chrome.tabs.onRemoved.addListener((tabId) => {
    void markClosedTabRestorable(tabId).catch(() => undefined);
    // Clean up MCP-dispatch markers on tab close so the storage map
    // doesn't accumulate dead entries.
    void dropMcpDispatchTab(tabId).catch(() => undefined);
    // Finalize emits a `.session.aggregated` final-snapshot event into
    // the buffer; pipe it straight to the companion so the
    // materializer's lateral lookup (engagement → similarity) sees the
    // session within ~1 s of tab close instead of waiting for the
    // 1-min periodic drain.
    void finalizeEngagementForTab(tabId)
      .then(() => drainBufferedEdgeEvents())
      .catch(() => undefined);
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
        // Only broadcast when a reminder was ACTUALLY dismissed.
        // Previously this fired a 'thread' workboard-changed on EVERY
        // tab activation / URL change / window focus even when nothing
        // changed — a refresh firehose that (especially now the
        // content script injects on all pages) drove the side panel's
        // full resolve fan-out on every ambient navigation, a primary
        // feeder of the CPU resolve-flood. Real content changes are
        // still surfaced by the snapshot-revision watcher and the
        // explicit url-change handlers.
        if (changed) void broadcastWorkboardChanged('reminder');
      })
      .catch(() => undefined);
  };
  chrome.tabs.onActivated.addListener((info) => {
    dismissAndBroadcast();
    void maybeExtractObservedPageEvidenceForTabId(info.tabId, {
      source: 'tab-activated',
    });
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only react when the URL actually changed — ignore title/favicon
    // updates that fire on every page mutation.
    if (changeInfo.url !== undefined) {
      void detectCodingAttachForTab(tabId, changeInfo.url);
      dismissAndBroadcast();
    }
    if (changeInfo.status === 'complete') {
      void maybeExtractAutoPageEvidence(tab, 'auto-observed', {
        source: 'tab-complete',
      });
      // Phase 10 — also ingest into OPFS local recall so the visit is
      // findable offline. Cheap upsert; fire-and-forget; never blocks.
      // Gated by the master capture switch (off = no ambient visits).
      if (typeof tab.url === 'string' && /^https?:\/\//u.test(tab.url)) {
        const visitUrl = tab.url;
        const visitTitle =
          typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : undefined;
        void (async () => {
          if (!(await isCaptureEnabled())) return;
          await ingestVisit({
            canonicalUrl: visitUrl,
            ...(visitTitle !== undefined ? { title: visitTitle } : {}),
            seenAtMs: Date.now(),
          });
        })();
      }
    }
  });
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      return;
    }
    dismissAndBroadcast();
  });

  // Sync Contract v1 / Class F — bind chrome.tabs to the timeline
  // observer + materializer + drainer. Idempotent on repeated boots
  // (chrome.alarms.create replaces; the wiring guards init).
  void (async () => {
    await bootstrapTimelinePrivacyGate().catch(() => undefined);
    await initializeTimelineWiring({
      readCompanion: readTimelineCompanionConfig,
      readTimelineGateState: isTimelinePrivacyGateOpen,
    });
  })().catch((error: unknown) => {
    console.warn('[timeline] init failed:', error);
  });

  void (async () => {
    if (chrome.tabGroups === undefined) return;
    const replica = await loadOrCreateEdgeReplica();
    const tabSessionStorage = createChromeTabSessionStorage();
    const hashTabId = (tabId: number, windowId: number): string =>
      fnv1a64ForTabGroup(`${replica.edgeReplicaId}|tab|${String(tabId)}|${String(windowId)}`).slice(
        0,
        16,
      );
    const postFeedbackEvent = async (event: TabGroupFeedbackEvent): Promise<void> => {
      if (!(await isTimelinePrivacyGateOpen())) return;
      await companionJson('/v1/feedback/events', {
        method: 'POST',
        headers: {
          'idempotency-key': idempotencyKey(
            'tabgroup-feedback',
            `${event.type}-${JSON.stringify(event.payload)}`,
          ),
        },
        body: JSON.stringify(event),
      });
    };
    runtimeTabGroupWiring = createTabGroupWiring({
      runtime: {
        tabGroups: chrome.tabGroups,
        tabs: {
          onUpdated: chrome.tabs.onUpdated,
          group: (options) => chrome.tabs.group(options),
          get: (tabId) => chrome.tabs.get(tabId),
        },
      },
      postFeedbackEvent,
      tabSessionIdForTab: async (tab) => {
        if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return null;
        const record = await tabSessionStorage.get(hashTabId(tab.id, tab.windowId));
        return record?.tabSessionId ?? null;
      },
      canonicalUrlsForTabs: async (tabIds) => {
        const tabs = await Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId)));
        return tabs
          .map((tab) => (typeof tab.url === 'string' ? canonicalThreadUrl(tab.url) : null))
          .filter((url): url is string => url !== null);
      },
    });
  })().catch((error: unknown) => {
    console.warn('[tabgroups] init failed:', error);
  });

  // Connections graph messages — proxied to /v1/connections* with
  // a 30 s TTL cache. Sits BEFORE the main RuntimeRequest handler
  // because these messages have a different response shape and
  // shouldn't go through buildState() / WorkboardState.
  const connectionsCache = new Map<string, { value: unknown; expiresAtMs: number }>();
  const CONNECTIONS_CACHE_TTL_MS = 30_000;

  const fetchConnectionsHttp = async (
    path: string,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    const settings = await readSettings();
    const port = settings.companion.port;
    const bridgeKey = settings.companion.bridgeKey.trim();
    if (typeof port !== 'number' || port <= 0 || bridgeKey.length === 0) {
      return { ok: false, error: 'companion not configured' };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
        headers: { 'x-bac-bridge-key': bridgeKey },
      });
      if (!res.ok) {
        return { ok: false, error: `connections HTTP ${String(res.status)}` };
      }
      const body = (await res.json()) as { data?: unknown };
      return { ok: true, data: body.data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const postConnectionsFeedbackHttp = async (
    event: unknown,
    clientEventId: string,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
    try {
      const body = await companionJson('/v1/feedback/events', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey('feedback', clientEventId) },
        body: JSON.stringify(event),
      });
      return { ok: true, data: isObjectRecord(body) ? body['data'] : undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const handleConnectionsMessage = async (
    message: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string } | null> => {
    if (message['type'] === messageTypes.postConnectionsFeedbackEvent) {
      const event = message['event'];
      const clientEventId =
        typeof message['clientEventId'] === 'string' && message['clientEventId'].length > 0
          ? message['clientEventId']
          : `feedback-${String(Date.now())}`;
      const result = await postConnectionsFeedbackHttp(event, clientEventId);
      if (result.ok) connectionsCache.clear();
      return result;
    }

    const cacheKey = JSON.stringify(message);
    const now = Date.now();
    const cached = connectionsCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAtMs > now) {
      return cached.value as { ok: boolean; data?: unknown };
    }
    let result: { ok: boolean; data?: unknown; error?: string } | null = null;
    if (message['type'] === messageTypes.loadConnectionsSnapshot) {
      const filters = (message['filters'] as Record<string, string> | undefined) ?? {};
      const params = new URLSearchParams();
      if (typeof filters['workstreamId'] === 'string')
        params.set('workstreamId', filters['workstreamId']);
      if (typeof filters['nodeKind'] === 'string') params.set('nodeKind', filters['nodeKind']);
      if (typeof filters['edgeKind'] === 'string') params.set('edgeKind', filters['edgeKind']);
      if (filters['topicVariant'] === 'shadow') params.set('topicVariant', 'shadow');
      const search = params.toString();
      result = await fetchConnectionsHttp(
        `/v1/connections${search.length > 0 ? `?${search}` : ''}`,
      );
    } else if (message['type'] === messageTypes.loadConnectionsNeighbors) {
      const nodeId = String(message['nodeId'] ?? '');
      const hops = typeof message['hops'] === 'number' ? message['hops'] : 1;
      result = await fetchConnectionsHttp(
        `/v1/connections/nodes/${encodeURIComponent(nodeId)}/neighbors?hops=${String(hops)}`,
      );
    } else if (message['type'] === messageTypes.loadConnectionsEdge) {
      const edgeId = String(message['edgeId'] ?? '');
      result = await fetchConnectionsHttp(`/v1/connections/edges/${encodeURIComponent(edgeId)}`);
    } else if (message['type'] === messageTypes.loadConnectionsPath) {
      // Stage 5 polish — BFS path between two nodes via the
      // companion's /v1/connections/path route. Companion bounds
      // maxHops to a safe ceiling internally; we pass through
      // whatever the panel requested.
      const fromNodeId = String(message['fromNodeId'] ?? '');
      const toNodeId = String(message['toNodeId'] ?? '');
      const maxHops = typeof message['maxHops'] === 'number' ? message['maxHops'] : 4;
      const params = new URLSearchParams({
        fromNodeId,
        toNodeId,
        maxHops: String(maxHops),
      });
      result = await fetchConnectionsHttp(`/v1/connections/path?${params.toString()}`);
    }
    if (result !== null) {
      connectionsCache.set(cacheKey, {
        value: result,
        expiresAtMs: now + CONNECTIONS_CACHE_TTL_MS,
      });
    }
    return result;
  };

  const runtimeMessageListener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: RuntimeResponse) => void,
  ): boolean | undefined => {
    // Build-verification ping from any extension page (side panel,
    // any extension HTML). Returns the build sha + dirty flag + builtAt
    // so operators can confirm which bundle is loaded.
    // NOTE: invoking this from the SW DevTools console returns
    // `undefined` — Chrome routes chrome.runtime.sendMessage to all
    // extension contexts EXCEPT the sender, so the SW never receives
    // its own messages. Use the side panel's DevTools instead, or read
    // the footer banner.
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.dev.ping'
    ) {
      sendResponse({
        ok: true,
        build: __BUILD_INFO__,
        listenerReached: true,
      } as unknown as RuntimeResponse);
      return true;
    }
    if (isVisualFingerprintObservedMessage(message)) {
      void handleVisualFingerprintObserved(message)
        .then(() => {
          sendResponse({ ok: true } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'visual fingerprint failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (isSelectionLineageMessage(message)) {
      void handleSelectionLineage(message)
        .then(() => {
          sendResponse({ ok: true } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'selection lineage failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (isEngagementIntervalMessage(message)) {
      void handleEngagementInterval(message, sender.tab?.id)
        .then(() => {
          sendResponse({ ok: true } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'engagement interval failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (isNavigationLinkClickMessage(message)) {
      const tabId = sender.tab?.id;
      void (async () => {
        if (typeof tabId !== 'number') {
          throw new Error('navigation link click has no sender tab');
        }
        // Master capture switch off — drop the link-click signal.
        if (!(await isCaptureEnabled())) return;
        await webNavigationRuntime.recordLinkClick({
          tabId,
          sourceUrl: message.sourceUrl,
          targetUrl: message.targetUrl,
          timeStamp: message.clickedAtMs,
        });
      })()
        .then(() => {
          sendResponse({ ok: true } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'navigation link click failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.privacy.gateChanged'
    ) {
      invalidateTimelineGateCache();
      void syncPrivacyGatedContentScriptRegistrations()
        .then(() => {
          sendResponse({ ok: true } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error:
              error instanceof Error ? error.message : 'privacy-gated registration refresh failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === VISUAL_FINGERPRINT_PRIVACY_GET
    ) {
      void isVisualFingerprintPrivacyGateOpen()
        .then((enabled) => {
          sendResponse({ ok: true, enabled } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'visual privacy gate read failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.privacy.get'
    ) {
      void isTimelinePrivacyGateOpen()
        .then((enabled) => {
          sendResponse({ ok: true, enabled } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'privacy gate read failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.privacy.set'
    ) {
      const enabled = (message as { enabled?: unknown }).enabled === true;
      void (async () => {
        await setTimelinePrivacyGate(enabled);
        invalidateTimelineGateCache();
        resetTimelineWiringForTests();
        await initializeTimelineWiring({
          readCompanion: readTimelineCompanionConfig,
          readTimelineGateState: isTimelinePrivacyGateOpen,
        });
      })()
        .then(() => {
          sendResponse({ ok: true, enabled } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'privacy gate write failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.permission.granted'
    ) {
      // Stage 5 follow-up — record the grant event AND re-sync the
      // privacy-gated content scripts. Pre-fix, the grant flowed
      // into the vault but `syncPrivacyGatedContentScriptRegistrations`
      // never ran, so the engagement content script stayed
      // unregistered (its second gate, `hasEngagementHostPermission`,
      // had just flipped to true but nothing rechecked it). Engagement
      // events only flowed after a full SW restart.
      void recordTimelinePermissionGranted()
        .then(() => syncPrivacyGatedContentScriptRegistrations())
        .then(() => {
          sendResponse({ ok: true } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'permission grant event failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.permission.revoked'
    ) {
      // Same as above — revoke flow must unregister the now-gated-out
      // scripts so they stop injecting on subsequent navigations.
      void recordTimelinePermissionRevoked()
        .then(() => syncPrivacyGatedContentScriptRegistrations())
        .then(() => {
          sendResponse({ ok: true } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'permission revoke event failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

    // Re-init timeline wiring. After a legacy sidetrack.timeline.enabled
    // seed or a privacy.gate.flipped write, this resets the init guard
    // and re-runs initializeTimelineWiring so chrome.tabs listeners
    // register without a SW reload.
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.reinit'
    ) {
      // Optional: callers (the replay-from-pack driver, the test's
      // seedTimelineRuntime helper) may pass an `activeWorkstreamId`
      // to atomically seed it from the SW context. The previous
      // pattern of writing chrome.storage.local from the panel
      // context (panel.evaluate) and then sending reinit was racy:
      // refreshActiveWorkstreamCache (called from init below) could
      // read chrome.storage BEFORE the panel→SW propagation
      // completed, leaving the cache null until the next message.
      // Writing from the SW context here resolves before init runs,
      // so the refresh inside init sees the just-written value.
      const explicitWorkstreamRaw = (message as { activeWorkstreamId?: unknown })
        .activeWorkstreamId;
      const explicitWorkstreamId =
        typeof explicitWorkstreamRaw === 'string'
          ? explicitWorkstreamRaw
          : explicitWorkstreamRaw === null
            ? null
            : undefined;
      void (async () => {
        await bootstrapTimelinePrivacyGate().catch(() => undefined);
        invalidateTimelineGateCache();
        if (explicitWorkstreamId !== undefined) {
          // Strings of length 0 are normalised to "remove the key"
          // so the cache returns to the unfocused state.
          if (typeof explicitWorkstreamId === 'string' && explicitWorkstreamId.length > 0) {
            await chrome.storage.local.set({
              [ACTIVE_WORKSTREAM_KEY]: explicitWorkstreamId,
            });
          } else {
            await chrome.storage.local.remove(ACTIVE_WORKSTREAM_KEY);
          }
        }
        resetTimelineWiringForTests();
        await initializeTimelineWiring({
          readCompanion: readTimelineCompanionConfig,
          readTimelineGateState: isTimelinePrivacyGateOpen,
        });
      })()
        .then(() => {
          sendResponse({ ok: true } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'reinit failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.diagnostics'
    ) {
      void (async () => {
        if (!(await isTimelineReplayDebugEnabled())) {
          return { ok: false, error: 'timeline replay diagnostics disabled' };
        }
        const diagnostics = await readTimelineReplayDiagnostics();
        return { ok: true, diagnostics };
      })()
        .then((response) => {
          sendResponse(response as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'timeline diagnostics failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }
    // Always-available diagnostic for the title-push pipeline.
    //
    // Stealth Chromium suspends the SW aggressively; the async
    // sendMessage response sometimes drops with
    //   "The message port closed before a response was received".
    // Workaround: also stash the result in chrome.storage.session
    // under 'sidetrack.dev.diag' so the caller can read it back even
    // if the response message channel died.
    //
    // From any extension DevTools console:
    //   chrome.runtime.sendMessage({type:'sidetrack.dev.diag'});
    //   // ... then a moment later:
    //   chrome.storage.session.get('sidetrack.dev.diag').then(console.log);
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.dev.diag'
    ) {
      void readTimelineReplayDiagnostics()
        .then(async (diagnostics) => {
          // Fold the engagement journal into the diag response so the
          // recorder's existing periodic SW-diag dump captures it
          // automatically — no separate plumbing needed.
          const fullDiagnostics = {
            ...diagnostics,
            engagement: {
              journal: [...engagementSyncJournal],
              journalLength: engagementSyncJournal.length,
            },
          };
          try {
            await chrome.storage.session.set({
              'sidetrack.dev.diag': {
                capturedAt: new Date().toISOString(),
                diagnostics: fullDiagnostics,
              },
            });
          } catch {
            // session storage may not be available in some test harnesses
          }
          sendResponse({
            ok: true,
            diagnostics: fullDiagnostics,
          } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'diag failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }
    // Content-script title push (entrypoints/title-watcher.content.ts).
    // Bypasses tab.title's stealth-Chromium blind spots by reading
    // document.title directly from the page DOM. Fire-and-forget;
    // no response needed.
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.titleObserved'
    ) {
      const payload = message as { url?: unknown; title?: unknown };
      const senderTab = sender.tab;
      console.log(
        '[sidetrack:title-handler] received',
        typeof payload.title === 'string' ? payload.title : '<no-title>',
        'tabId:',
        senderTab?.id,
        'url:',
        typeof payload.url === 'string' ? payload.url : '<no-url>',
      );
      if (
        typeof payload.url === 'string' &&
        payload.url.length > 0 &&
        typeof payload.title === 'string' &&
        payload.title.length > 0 &&
        senderTab !== undefined &&
        typeof senderTab.id === 'number' &&
        typeof senderTab.windowId === 'number'
      ) {
        void recordTitleFromContent({
          tabId: senderTab.id,
          windowId: senderTab.windowId,
          url: payload.url,
          title: payload.title,
        })
          .then(() => {
            console.log('[sidetrack:title-handler] recorded', payload.title);
          })
          .catch((err: unknown) => {
            console.warn('[sidetrack:title-handler] record failed', err);
          });
      } else {
        console.warn('[sidetrack:title-handler] rejected payload — missing/invalid fields', {
          hasUrl: typeof payload.url === 'string',
          hasTitle: typeof payload.title === 'string',
          hasTab: senderTab !== undefined,
        });
      }
      sendResponse({ ok: true } as unknown as RuntimeResponse);
      return true;
    }
    // Force-drain the timeline spool. Used by e2e tests + the
    // side-panel "drain now" affordance. No-op when timeline wiring
    // hasn't initialized (gate off or pre-boot).
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.force-drain'
    ) {
      void triggerTimelineDrain()
        .then((result) => {
          sendResponse({ ok: true, drain: result } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'force-drain failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }
    // Synchronously refresh the active-workstream cache from
    // chrome.storage.local. Used by the replay-from-pack driver
    // after each workstreamSwitch event so the next navigation's
    // emit reads a fresh workstream id rather than the stale
    // value the chrome.storage.onChanged listener hasn't yet
    // propagated. Returns the resolved id (or null when no
    // workstream is focused) so callers can sanity-check.
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.refresh-workstream-cache'
    ) {
      void refreshActiveWorkstreamFromStorage()
        .then((workstreamId) => {
          sendResponse({
            ok: true,
            workstreamId: workstreamId ?? null,
          } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'workstream-cache refresh failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }
    // Set the active workstream — atomic version of seedStorage +
    // refresh-workstream-cache. Updates the SW's in-memory cache
    // first (sync), then writes chrome.storage.local. The cache
    // update is what observer.observe reads on the emit hot path;
    // doing it sync first guarantees that any chrome.tabs event
    // arriving after this message-response sees the new workstream
    // even if the storage write hasn't yet propagated to other
    // consumers. The SAS race the previous refresh-workstream-cache
    // path narrowed (storage write + cache read both async) is
    // closed here because the cache is no longer derived from a
    // separate storage read.
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.timeline.set-active-workstream'
    ) {
      const value = (message as { workstreamId?: unknown }).workstreamId;
      const next = typeof value === 'string' && value.length > 0 ? value : null;
      void (async () => {
        setActiveWorkstreamCache(next);
        try {
          if (next === null) {
            await chrome.storage.local.remove(ACTIVE_WORKSTREAM_KEY);
          } else {
            await chrome.storage.local.set({ [ACTIVE_WORKSTREAM_KEY]: next });
          }
          sendResponse({ ok: true, workstreamId: next } as unknown as RuntimeResponse);
        } catch (error: unknown) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error ? error.message : 'set-active-workstream storage write failed',
          } as unknown as RuntimeResponse);
        }
      })();
      return true;
    }
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.tabgroups.test.pull-in-out'
    ) {
      const raw = message as {
        seedUrl?: unknown;
        targetUrl?: unknown;
        workstreamId?: unknown;
      };
      void (async () => {
        if (runtimeTabGroupWiring === null || chrome.tabGroups === undefined) {
          throw new Error('tab-group wiring is unavailable');
        }
        const seedUrl = typeof raw.seedUrl === 'string' ? raw.seedUrl : '';
        const targetUrl = typeof raw.targetUrl === 'string' ? raw.targetUrl : '';
        const workstreamId = typeof raw.workstreamId === 'string' ? raw.workstreamId : '';
        if (seedUrl.length === 0 || targetUrl.length === 0 || workstreamId.length === 0) {
          throw new Error('seedUrl, targetUrl, and workstreamId are required');
        }
        const normalize = (input: string): string =>
          canonicalThreadUrl(input).replace(/#.*$/u, '').replace(/\/+$/u, '');
        const tabs = await chrome.tabs.query({});
        const seedTab = tabs.find(
          (tab) => typeof tab.url === 'string' && normalize(tab.url) === normalize(seedUrl),
        );
        const targetTab = tabs.find(
          (tab) => typeof tab.url === 'string' && normalize(tab.url) === normalize(targetUrl),
        );
        if (typeof seedTab?.id !== 'number' || typeof targetTab?.id !== 'number') {
          throw new Error('could not find seed and target tabs for tab-group replay');
        }
        const groupId = await chrome.tabs.group({ tabIds: seedTab.id });
        await chrome.tabGroups.update(groupId, {
          title: 'Sidetrack T1',
          color: 'blue',
        });
        await delay(100);
        await runtimeTabGroupWiring.linkGroupToWorkstream(groupId, workstreamId);
        await chrome.tabs.group({ groupId, tabIds: targetTab.id });
        await delay(100);
        await chrome.tabs.ungroup(targetTab.id);
        sendResponse({ ok: true, groupId } as unknown as RuntimeResponse);
      })().catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'tab-group test hook failed',
        } as unknown as RuntimeResponse);
      });
      return true;
    }
    if (
      message !== null &&
      typeof message === 'object' &&
      (message as { type?: unknown }).type === 'sidetrack.edge-events.force-drain'
    ) {
      void drainBufferedEdgeEvents()
        .then((result) => {
          sendResponse({ ok: true, drain: result } as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'edge-event drain failed',
          } as unknown as RuntimeResponse);
        });
      return true;
    }
    // Try the connections handler first — it has its own response shape.
    if (
      message !== null &&
      typeof message === 'object' &&
      'type' in message &&
      ((message as { type?: unknown }).type === messageTypes.loadConnectionsSnapshot ||
        (message as { type?: unknown }).type === messageTypes.loadConnectionsNeighbors ||
        (message as { type?: unknown }).type === messageTypes.loadConnectionsEdge ||
        (message as { type?: unknown }).type === messageTypes.loadConnectionsPath ||
        (message as { type?: unknown }).type === messageTypes.postConnectionsFeedbackEvent)
    ) {
      void handleConnectionsMessage(message as Record<string, unknown>)
        .then((result) => {
          // Cast: the connections response shape is intentionally
          // different from RuntimeResponse; the side-panel client
          // re-casts on receipt.
          sendResponse(result as unknown as RuntimeResponse);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Connections request failed.',
          } as unknown as RuntimeResponse);
        });
      return true;
    }

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
            await classifyCompanionFailure(error),
            error instanceof Error ? error.message : 'Request failed.',
          ),
        });
      });
    return true;
  };

  chrome.runtime.onMessage.addListener(runtimeMessageListener);

  // Test-only loopback for the e2e harness. Chrome doesn't deliver
  // chrome.runtime.sendMessage back to the sender's own context, so
  // when the Patchright stealth e2e routes through worker.evaluate
  // (the only way to reach chrome.* from a stripped main world), the
  // SW's own listeners never fire. Stash the listener fn on globalThis
  // so the test runtime helper can invoke it directly with a fake
  // sender and capture sendResponse. No production caller uses this —
  // production messages flow through chrome.runtime.sendMessage from
  // non-SW contexts, which works normally.
  (
    globalThis as unknown as {
      __sidetrackTestDispatchMessage?: (message: unknown) => Promise<unknown>;
    }
  ).__sidetrackTestDispatchMessage = (message: unknown): Promise<unknown> =>
    new Promise<unknown>((resolve) => {
      let responded = false;
      const sendResponse = (response: unknown): void => {
        if (responded) return;
        responded = true;
        resolve(response);
      };
      const fakeSender = { id: chrome.runtime.id } as chrome.runtime.MessageSender;
      const isAsync = runtimeMessageListener(
        message,
        fakeSender,
        sendResponse as (response: RuntimeResponse) => void,
      );
      if (isAsync !== true && !responded) {
        // Synchronous handler that didn't respond — match Chrome's
        // "no responder" behaviour and resolve with undefined.
        resolve(undefined);
      }
    });

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
  // F9 — thread state SSE subscription. Same vaultChangesClient
  // is reused for both prefixes (its dispatch filters by prefix
  // client-side at vaultChanges.ts:128); no second connection.
  // Drives cross-browser real-time propagation: a peer's
  // capture.recorded → projector updates threads.json → vault-
  // changes SSE fires → mirrorRemoteThread updates the local
  // chrome.storage.sidetrack.threads → side panel re-renders via
  // its existing chrome.runtime.onMessage listener (the SSE
  // event itself doesn't trigger a refresh, so the next periodic
  // poll picks up the storage change). Without this, T6.1 fails.
  const fetchThreadProjection = async (
    cfg: { url: string; bridgeKey: string },
    bacId: string,
  ): Promise<{
    bac_id: string;
    record: import('../src/background/state').RemoteThreadProjection['record'];
    status: import('../src/background/state').RemoteThreadProjection['status'];
    deleted: boolean;
  } | null> => {
    try {
      const r = await fetch(
        `${cfg.url.replace(/\/$/, '')}/v1/threads/${encodeURIComponent(bacId)}/projection`,
        { headers: { 'x-bac-bridge-key': cfg.bridgeKey } },
      );
      if (!r.ok) return null;
      const body = (await r.json()) as { data?: unknown };
      if (typeof body.data !== 'object' || body.data === null) return null;
      const d = body.data as {
        bac_id?: unknown;
        record?: unknown;
        status?: unknown;
        deleted?: unknown;
      };
      if (typeof d.bac_id !== 'string') return null;
      return {
        bac_id: d.bac_id,
        record: d.record as import('../src/background/state').RemoteThreadProjection['record'],
        status: d.status as import('../src/background/state').RemoteThreadProjection['status'],
        deleted: d.deleted === true,
      };
    } catch {
      return null;
    }
  };
  reviewDraftsSse.subscribe({
    prefix: '_BAC/threads/projections/',
    onEvent: (event) => {
      // relPath shape: `_BAC/threads/<bac_id>.json`.
      const m = /^_BAC\/threads\/projections\/(?<id>[^/]+?)\.json$/.exec(event.relPath);
      const bacId = m?.groups?.id;
      if (bacId === undefined) return;
      void (async () => {
        const cached = await refreshCompanionCache();
        if (cached === null) return;
        const cfg = { url: cached.companionUrl, bridgeKey: cached.bridgeKey };
        const projection = await fetchThreadProjection(cfg, bacId);
        if (projection === null) return;
        const { mirrorRemoteThread } = await import('../src/background/state');
        await mirrorRemoteThread(projection);
        // Broadcast so any open side panel refreshes its state
        // and renders the new thread row immediately. Without
        // this, the storage write happens but the side panel
        // doesn't re-read until the 15 s periodic poll.
        void broadcastWorkboardChanged('thread');
      })().catch(() => undefined);
    },
  });

  // F10 — workstream state SSE subscription. Same pattern as F9
  // for threads. A peer creating a workstream + moving threads
  // into it triggers `_BAC/workstreams/<id>.json` writes via the
  // companion's import projector; without this subscription the
  // moved thread lands with a primaryWorkstreamId the local
  // extension's chrome.storage doesn't know, so the side panel
  // renders the row under "Ungrouped" instead of the workstream.
  const fetchWorkstreamProjection = async (
    cfg: { url: string; bridgeKey: string },
    bacId: string,
  ): Promise<{
    bac_id: string;
    record: import('../src/background/state').RemoteWorkstreamProjection['record'];
    deleted: boolean;
  } | null> => {
    try {
      const r = await fetch(
        `${cfg.url.replace(/\/$/, '')}/v1/workstreams/${encodeURIComponent(bacId)}/projection`,
        { headers: { 'x-bac-bridge-key': cfg.bridgeKey } },
      );
      if (!r.ok) return null;
      const body = (await r.json()) as { data?: unknown };
      if (typeof body.data !== 'object' || body.data === null) return null;
      const d = body.data as { bac_id?: unknown; record?: unknown; deleted?: unknown };
      if (typeof d.bac_id !== 'string') return null;
      return {
        bac_id: d.bac_id,
        record: d.record as import('../src/background/state').RemoteWorkstreamProjection['record'],
        deleted: d.deleted === true,
      };
    } catch {
      return null;
    }
  };
  reviewDraftsSse.subscribe({
    prefix: '_BAC/workstreams/projections/',
    onEvent: (event) => {
      const m = /^_BAC\/workstreams\/projections\/(?<id>[^/]+?)\.json$/.exec(event.relPath);
      const bacId = m?.groups?.id;
      if (bacId === undefined) return;
      void (async () => {
        const cached = await refreshCompanionCache();
        if (cached === null) return;
        const cfg = { url: cached.companionUrl, bridgeKey: cached.bridgeKey };
        const projection = await fetchWorkstreamProjection(cfg, bacId);
        if (projection === null) return;
        const { mirrorRemoteWorkstream } = await import('../src/background/state');
        await mirrorRemoteWorkstream(projection);
        void broadcastWorkboardChanged('workstream');
      })().catch(() => undefined);
    },
  });

  // F13 — annotation state SSE subscription. A peer's
  // annotation.{created,noteSet,deleted} → projector writes
  // `_BAC/annotations/<id>.json` → SSE fires here. We don't
  // mirror into chrome.storage (annotations don't live there;
  // the content script fetches them on page load via
  // listAnnotationsByUrl). Instead, we forward a refresh signal
  // to all matching tabs so any open AnnotationOverlay re-fetches
  // and re-renders without a page reload.
  const fetchAnnotationProjection = async (
    cfg: { url: string; bridgeKey: string },
    bacId: string,
  ): Promise<{ entry?: { url?: string; deleted?: boolean } } | null> => {
    try {
      const r = await fetch(
        `${cfg.url.replace(/\/$/, '')}/v1/annotations/${encodeURIComponent(bacId)}/projection`,
        { headers: { 'x-bac-bridge-key': cfg.bridgeKey } },
      );
      if (!r.ok) return null;
      const body = (await r.json()) as { data?: unknown };
      if (typeof body.data !== 'object' || body.data === null) return null;
      return body.data as { entry?: { url?: string; deleted?: boolean } };
    } catch {
      return null;
    }
  };
  reviewDraftsSse.subscribe({
    prefix: '_BAC/annotations/projections/',
    onEvent: (event) => {
      const m = /^_BAC\/annotations\/projections\/(?<id>[^/]+?)\.json$/.exec(event.relPath);
      const bacId = m?.groups?.id;
      if (bacId === undefined) return;
      void (async () => {
        const cached = await refreshCompanionCache();
        if (cached === null) return;
        const cfg = { url: cached.companionUrl, bridgeKey: cached.bridgeKey };
        const projection = await fetchAnnotationProjection(cfg, bacId);
        const url = projection?.entry?.url;
        if (typeof url !== 'string' || url.length === 0) return;
        // Tell every tab whose URL matches the annotation's URL
        // to re-fetch its annotation set. The content script
        // listens on a known message type and calls
        // restoreAnnotations() which re-mounts the overlay.
        try {
          const tabs = await chrome.tabs.query({ url });
          for (const tab of tabs) {
            if (typeof tab.id !== 'number') continue;
            chrome.tabs
              .sendMessage(tab.id, { type: 'sidetrack.annotation.refresh' })
              .catch(() => undefined);
          }
        } catch {
          // chrome.tabs.query rejects on invalid URL patterns; ignore.
        }
        void broadcastWorkboardChanged('annotation');
      })().catch(() => undefined);
    },
  });

  // F14 — queue state SSE subscription. Per-id projection writes
  // `_BAC/queue/<id>.json`. mirrorRemoteQueueItem updates
  // `sidetrack.queueItems`; broadcastWorkboardChanged forces the
  // side panel to re-read.
  const fetchQueueProjection = async (
    cfg: { url: string; bridgeKey: string },
    bacId: string,
  ): Promise<import('../src/background/state').RemoteQueueItemProjection | null> => {
    try {
      const r = await fetch(
        `${cfg.url.replace(/\/$/, '')}/v1/queue/${encodeURIComponent(bacId)}/projection`,
        { headers: { 'x-bac-bridge-key': cfg.bridgeKey } },
      );
      if (!r.ok) return null;
      const body = (await r.json()) as { data?: unknown };
      if (typeof body.data !== 'object' || body.data === null) return null;
      return body.data as import('../src/background/state').RemoteQueueItemProjection;
    } catch {
      return null;
    }
  };
  reviewDraftsSse.subscribe({
    prefix: '_BAC/queue/projections/',
    onEvent: (event) => {
      const m = /^_BAC\/queue\/projections\/(?<id>[^/]+?)\.json$/.exec(event.relPath);
      const bacId = m?.groups?.id;
      if (bacId === undefined) return;
      void (async () => {
        const cached = await refreshCompanionCache();
        if (cached === null) return;
        const cfg = { url: cached.companionUrl, bridgeKey: cached.bridgeKey };
        const projection = await fetchQueueProjection(cfg, bacId);
        if (projection === null) return;
        const { mirrorRemoteQueueItem } = await import('../src/background/state');
        await mirrorRemoteQueueItem(projection);
        void broadcastWorkboardChanged('queue');
      })().catch(() => undefined);
    },
  });

  // F15 — dispatch state SSE subscription. Per-id projection writes
  // `_BAC/dispatches/<id>.json`. mirrorRemoteDispatch updates the
  // `sidetrack.recentDispatches` cache + dispatch link map.
  const fetchDispatchProjection = async (
    cfg: { url: string; bridgeKey: string },
    bacId: string,
  ): Promise<import('../src/background/state').RemoteDispatchProjection | null> => {
    try {
      const r = await fetch(
        `${cfg.url.replace(/\/$/, '')}/v1/dispatches/${encodeURIComponent(bacId)}/projection`,
        { headers: { 'x-bac-bridge-key': cfg.bridgeKey } },
      );
      if (!r.ok) return null;
      const body = (await r.json()) as { data?: unknown };
      if (typeof body.data !== 'object' || body.data === null) return null;
      const d = body.data as { entry?: unknown; link?: unknown };
      return {
        bac_id: bacId,
        ...(d.entry === undefined
          ? {}
          : {
              entry: d.entry as import('../src/background/state').RemoteDispatchProjection['entry'],
            }),
        ...(d.link === undefined
          ? {}
          : { link: d.link as import('../src/background/state').RemoteDispatchProjection['link'] }),
      };
    } catch {
      return null;
    }
  };
  reviewDraftsSse.subscribe({
    prefix: '_BAC/dispatches/projections/',
    onEvent: (event) => {
      const m = /^_BAC\/dispatches\/projections\/(?<id>[^/]+?)\.json$/.exec(event.relPath);
      const bacId = m?.groups?.id;
      if (bacId === undefined) return;
      void (async () => {
        const cached = await refreshCompanionCache();
        if (cached === null) return;
        const cfg = { url: cached.companionUrl, bridgeKey: cached.bridgeKey };
        const projection = await fetchDispatchProjection(cfg, bacId);
        if (projection === null) return;
        const { mirrorRemoteDispatch } = await import('../src/background/state');
        await mirrorRemoteDispatch(projection);
        void broadcastWorkboardChanged('dispatch');
      })().catch(() => undefined);
    },
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
