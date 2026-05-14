import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import {
  companionStatusLabel,
  compareQueueItems,
  createEmptyWorkboardState,
  type AllThreadsBucket,
  type CodingSession,
  type DispatchDiagnostic,
  type TrackedThread,
  type WorkboardState,
  type WorkstreamNode,
} from '../../src/workboard';
import {
  isCaptureFeedbackMessage,
  isRuntimeResponse,
  isFocusThreadInSidePanelMessage,
  isWorkboardChangedMessage,
  messageTypes,
  type AnnotateTurnResponse,
  type PublishAnnotationToChatResponse,
  type RecallQueryResponse,
  type RuntimeResponse,
  type WorkboardRequest,
} from '../../src/messages';
import { canonicalThreadUrl, detectProviderFromUrl } from '../../src/capture/providerDetection';
import { sanitizeTimelineUrl } from '../../src/timeline/sanitize';
import {
  CodingAttach,
  AutoSendQueueRow,
  type ComposedPacket,
  DispatchConfirm,
  type DispatchEvent as RecentDispatchEvent,
  type DispatchStatus as RecentDispatchStatus,
  MoveToPicker,
  PacketComposer,
  RecentDispatches,
  ReviewComposer,
  ReviewDraftFooter,
  SendToDropdown,
  type SendToTarget,
  SettingsPanel,
  type SettingsValue,
  SystemBannersStack,
  UpdateBanner,
  CodingOfferBanner,
  HealthPanel,
  Icons,
  DesignPreview,
  WorkstreamDetailPanel,
  TurnText,
  NeedsOrganizeSuggestion,
  type LinkedNote,
  type TrustEntry,
  type TrustTool,
  type ThemeMode,
  type DensityMode,
  TabRecovery,
  Wizard,
  type RestoreStrategy,
  type ReviewVerdict,
  type ScopeSuggestion,
  type WorkstreamOption,
} from './components';
import { createDispatchClient } from '../../src/dispatch/client';
import {
  bridgeKeyValidationCopy,
  validateBridgeKeyCandidate,
} from '../../src/companion/bridgeKeyValidation';
import {
  type DispatchMode,
  dispatchKindToUiPacketKind,
  mapUiPacketKind,
  mapUiTarget,
  providerIdToDispatchProvider,
} from '../../src/dispatch/types';
import { createReviewClient } from '../../src/review/client';
import type { ReviewOutcome, ReviewVerdict as ReviewVerdictType } from '../../src/review/types';
import { createSettingsClient } from '../../src/settings/client';
import { isProviderWithOptIn, type SettingsDocument } from '../../src/settings/types';
import { createTurnsClient, type CapturedTurnRecord } from '../../src/turns/client';
import { deriveLifecycle } from '../../src/sidepanel/lifecycle';
import { formatRelative } from '../../src/util/time';
import { createSuggestionsClient } from '../../src/companion/suggestionsClient';
import { listPendingOffers, markStatus, type OfferRecord } from '../../src/codingAttach/state';
import { ConnectionsView } from '../../src/sidepanel/connections/ConnectionsView';
import { hostOf, type EntityDisplayCtx } from '../../src/sidepanel/entityDisplay/format';
import { useReplicaAliasMap } from '../../src/sidepanel/entityDisplay/replicaAliases';
import { useSnippetPreviewMap } from '../../src/sidepanel/entityDisplay/snippetPreview';
import { AttributionBadge } from '../../src/sidepanel/tabsession/AttributionBadge';
import { SuggestionStats } from '../../src/sidepanel/tabsession/SuggestionStats';
import { tabSessionDisplayTitle } from '../../src/sidepanel/tabsession/displayTitle';
import { InboxCard } from '../../src/sidepanel/tabsession/InboxCard';
import { InboxView } from '../../src/sidepanel/tabsession/InboxView';
import { SuggestionBanner } from '../../src/sidepanel/tabsession/SuggestionBanner';
import { loadOrCreateEdgeReplica } from '../../src/sync/edgeReplicaId';
import {
  TAB_SESSION_DRAG_MIME,
  type TabSessionInboxData,
  type TabSessionProjection,
  type TabSessionRecord,
  type TabSessionResolutionResult,
  type TabSessionWorkstreamOption,
  type UrlInboxData,
  type UrlProjection,
  type UrlResolutionResult,
  type UrlVisitRecord,
} from '../../src/sidepanel/tabsession/types';
import {
  USER_ORGANIZED_ITEM,
  feedbackClientEventId,
  type FeedbackEventEnvelope,
  type UserOrganizedItemPayload,
} from '../../src/sidepanel/connections/client';
import './style.css';

const TARGET_PROVIDER_LABEL: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  other: 'Other',
};

const EMPTY_TAB_SESSION_INBOX: TabSessionInboxData = {
  items: [],
  total: 0,
  limit: 51,
  offset: 0,
};

const EMPTY_URL_INBOX: UrlInboxData = {
  items: [],
  total: 0,
  limit: 51,
  offset: 0,
};

// Adapt a UrlVisitRecord to the TabSessionRecord shape the existing
// InboxCard / current-tab card components expect. The synthesized id
// is the canonical URL — actions interpret it as the URL-attribution
// target (handleUrlAttribute), not a tab-session id.
const tabSessionRecordFromUrl = (url: UrlVisitRecord): TabSessionRecord => ({
  tabSessionId: url.canonicalUrl,
  openedAt: url.firstSeenAt,
  lastActivityAt: url.lastSeenAt,
  ...(url.latestUrl === undefined ? {} : { latestUrl: url.latestUrl }),
  ...(url.latestTitle === undefined ? {} : { latestTitle: url.latestTitle }),
  ...(url.provider === undefined ? {} : { provider: url.provider }),
  ...(url.currentAttribution === undefined
    ? {}
    : { currentAttribution: url.currentAttribution }),
  ...(url.currentIgnored === undefined
    ? {}
    : {
        currentIgnored: {
          reason: url.currentIgnored.reason,
          observedAt: url.currentIgnored.observedAt,
          clientEventId: url.currentIgnored.clientEventId,
        },
      }),
  attributionHistory: url.attributionHistory,
});

// The URL resolver returns a UrlResolutionResult ({ canonicalUrl, … });
// the existing InboxCard / SuggestionBanner / AttributionBadge expect
// a TabSessionResolutionResult ({ tabSessionId, … }). Same wire shape
// apart from the key — surface-rename to keep the UI components
// unaware of the underlying attribution unit.
const tabSessionResolutionFromUrl = (
  result: UrlResolutionResult,
): TabSessionResolutionResult => ({
  tabSessionId: result.canonicalUrl,
  dryRun: true,
  decision: result.decision,
  fusedCandidates: result.fusedCandidates,
});

const tabSessionIdFromDragEvent = (event: DragEvent<HTMLElement>): string | null => {
  if (typeof event.dataTransfer.getData !== 'function') return null;
  const explicit = event.dataTransfer.getData(TAB_SESSION_DRAG_MIME);
  if (explicit.length > 0) return explicit;
  const plain = event.dataTransfer.getData('text/plain');
  return plain.startsWith('tses_') ? plain : null;
};

// Module-level semaphore to cap concurrent fetches to the companion.
// Without this, dozens of NeedsOrganizeSuggestionRow components mount
// at once and each fires its own /v1/suggestions/thread/{id} fetch in
// useEffect, blowing past Chrome's per-origin socket cap (~6 for
// HTTP/1.1) and triggering ERR_INSUFFICIENT_RESOURCES failures + a
// transient "companion disconnected" banner. Holding to 4 in-flight
// keeps the companion's single-threaded HTTP loop responsive AND
// keeps the periodic /v1/system/health probe from being starved.
//
// Implementation: when a release happens and the queue is non-empty,
// the slot is TRANSFERRED to the waiter (active stays the same). Only
// when the queue is empty does release decrement active. This avoids
// the over-allocate drift that the simpler decrement-then-resolve
// version exhibited under heavy load (the resolve→continuation gap
// let another acquire slip in and over-allocate).
const COMPANION_FETCH_MAX_CONCURRENCY = 4;
const companionFetchState = { active: 0, queue: [] as Array<() => void> };
const acquireCompanionFetchSlot = async (): Promise<() => void> => {
  if (companionFetchState.active < COMPANION_FETCH_MAX_CONCURRENCY) {
    companionFetchState.active += 1;
  } else {
    await new Promise<void>((resolve) => {
      companionFetchState.queue.push(resolve);
    });
    // Slot was transferred to us by the previous releaser — active
    // was NOT decremented in that path. Don't re-increment here.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = companionFetchState.queue.shift();
    if (next !== undefined) {
      next(); // Transfer slot; active stays at MAX.
    } else {
      companionFetchState.active -= 1;
    }
  };
};

// The URL projection's byCanonicalUrl is keyed by what the observer
// produced — `sanitizeTimelineUrl(canonicalThreadUrl(rawUrl))`. The live
// `chrome.tabs` URL the side panel reads has NOT been through that
// pipeline, so it can carry a fragment (Google appends `#scso=...`
// post-load), marketing params, or sensitive params that the stored
// canonical dropped. Apply the same pipeline here so lookup keys agree.
const comparableTabUrl = (input: string | undefined): string | null => {
  if (input === undefined || input.length === 0) return null;
  const canonical = sanitizeTimelineUrl(canonicalThreadUrl(input));
  return canonical.length > 1 && canonical.endsWith('/') ? canonical.slice(0, -1) : canonical;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTabSessionProjection = (value: unknown): value is TabSessionProjection =>
  isPlainRecord(value) &&
  value['schemaVersion'] === 1 &&
  isPlainRecord(value['bySessionId']) &&
  isPlainRecord(value['openSessionsByTabId']);

const isTabSessionInboxData = (value: unknown): value is TabSessionInboxData =>
  isPlainRecord(value) &&
  Array.isArray(value['items']) &&
  typeof value['total'] === 'number' &&
  typeof value['limit'] === 'number' &&
  typeof value['offset'] === 'number';

const isResolverAction = (value: unknown): value is 'auto-apply' | 'suggest' | 'inbox' =>
  value === 'auto-apply' || value === 'suggest' || value === 'inbox';

const isTabSessionResolutionResult = (value: unknown): value is TabSessionResolutionResult =>
  isPlainRecord(value) &&
  typeof value['tabSessionId'] === 'string' &&
  value['dryRun'] === true &&
  isPlainRecord(value['decision']) &&
  isResolverAction(value['decision']['action']) &&
  (value['decision']['workstreamId'] === undefined ||
    typeof value['decision']['workstreamId'] === 'string') &&
  typeof value['decision']['margin'] === 'number' &&
  Array.isArray(value['fusedCandidates']);

const isUrlProjection = (value: unknown): value is UrlProjection =>
  isPlainRecord(value) &&
  value['schemaVersion'] === 1 &&
  isPlainRecord(value['byCanonicalUrl']);

const isUrlInboxData = (value: unknown): value is UrlInboxData =>
  isPlainRecord(value) &&
  Array.isArray(value['items']) &&
  typeof value['total'] === 'number' &&
  typeof value['limit'] === 'number' &&
  typeof value['offset'] === 'number';

const isUrlResolutionResult = (value: unknown): value is UrlResolutionResult =>
  isPlainRecord(value) &&
  typeof value['canonicalUrl'] === 'string' &&
  value['dryRun'] === true &&
  isPlainRecord(value['decision']) &&
  isResolverAction(value['decision']['action']) &&
  (value['decision']['workstreamId'] === undefined ||
    typeof value['decision']['workstreamId'] === 'string') &&
  typeof value['decision']['margin'] === 'number' &&
  Array.isArray(value['fusedCandidates']);

const sendRequestRaw = async (
  request: WorkboardRequest,
): Promise<Extract<RuntimeResponse, { ok: true }>> => {
  const response = (await chrome.runtime.sendMessage(request)) as unknown;
  if (!isRuntimeResponse(response)) {
    throw new Error('Sidetrack background returned an invalid response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response;
};

const sendRequest = async (request: WorkboardRequest): Promise<WorkboardState> =>
  (await sendRequestRaw(request)).state;

const providerLabel = (provider: TrackedThread['provider']): string => {
  if (provider === 'chatgpt') {
    return 'ChatGPT';
  }
  if (provider === 'claude') {
    return 'Claude';
  }
  if (provider === 'gemini') {
    return 'Gemini';
  }
  return 'Generic';
};

interface ThreadSearchResult {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly score: number;
  readonly title?: string;
  readonly snippet?: string;
  readonly threadUrl?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isThreadSearchResult = (value: unknown): value is ThreadSearchResult =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.threadId === 'string' &&
  typeof value.capturedAt === 'string' &&
  typeof value.score === 'number' &&
  (value.title === undefined || typeof value.title === 'string') &&
  (value.snippet === undefined || typeof value.snippet === 'string') &&
  (value.threadUrl === undefined || typeof value.threadUrl === 'string');

const isRecallQueryResponse = (value: unknown): value is RecallQueryResponse =>
  isRecord(value) && typeof value.ok === 'boolean' && Array.isArray(value.items);

export const formatBuildTimestamp = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}Z`;
};

const SETUP_COMPLETED_KEY = 'sidetrack:setupCompleted';

const DEFAULT_VAULT_PATH = '~/Documents/Sidetrack-vault';

const readSetupCompleted = async (): Promise<boolean> => {
  const result = await chrome.storage.local.get({ [SETUP_COMPLETED_KEY]: false });
  return result[SETUP_COMPLETED_KEY] === true;
};

const writeSetupCompleted = async (): Promise<void> => {
  await chrome.storage.local.set({ [SETUP_COMPLETED_KEY]: true });
};

const workstreamPath = (
  workstreamId: string | undefined,
  workstreams: readonly WorkstreamNode[],
): string => {
  if (workstreamId === undefined) {
    return 'Needs organize';
  }

  const byId = new Map(workstreams.map((workstream) => [workstream.bac_id, workstream]));
  const visited = new Set<string>();
  const titles: string[] = [];
  let cursor = byId.get(workstreamId);

  while (cursor !== undefined && !visited.has(cursor.bac_id)) {
    visited.add(cursor.bac_id);
    titles.unshift(cursor.title);
    cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
  }

  return titles.length > 0 ? titles.join(' / ') : 'Needs organize';
};

const buildWorkstreamOptions = (
  workstreams: readonly WorkstreamNode[],
): readonly WorkstreamOption[] =>
  workstreams.map((workstream) => ({
    bac_id: workstream.bac_id,
    path: workstreamPath(workstream.bac_id, workstreams),
  }));

const isThreadPrivate = (
  thread: TrackedThread,
  workstreams: readonly WorkstreamNode[],
  screenShareMode: boolean,
): boolean =>
  workstreams.some(
    (workstream) =>
      workstream.bac_id === thread.primaryWorkstreamId &&
      (workstream.privacy === 'private' ||
        (screenShareMode && workstream.screenShareSensitive === true)),
  );

const visibleThreads = (threads: readonly TrackedThread[]): readonly TrackedThread[] =>
  threads.filter(
    (thread) =>
      thread.status !== 'removed' &&
      thread.status !== 'archived' &&
      thread.trackingMode !== 'removed' &&
      thread.trackingMode !== 'archived',
  );

// Lifecycle derivation lives in src/sidepanel/lifecycle.ts so it can
// be unit-tested without rendering the full App tree.

const restoreStrategyForThread = (thread: TrackedThread): RestoreStrategy =>
  thread.tabSnapshot?.tabId === undefined ? 'reopen_url' : 'focus_open';

// Lifecycle bucket — used by the All Threads view to render explicit
// subgroup headers. Order matches the user's priority list:
// Unread → Ungrouped → Waiting on AI → Stale or closed → Normal.
// A thread goes into the FIRST matching bucket.
const ALL_THREAD_BUCKET_ORDER: readonly AllThreadsBucket[] = [
  'unread',
  'ungrouped',
  'waiting',
  'stale',
  'normal',
];

const ALL_THREAD_BUCKET_LABEL: Record<AllThreadsBucket, string> = {
  unread: 'Unread reply',
  ungrouped: 'Ungrouped',
  waiting: 'Waiting on AI',
  stale: 'Stale or closed',
  normal: 'Normal',
};

const isStaleOrClosed = (thread: TrackedThread): boolean =>
  thread.status === 'closed' ||
  thread.status === 'restorable' ||
  thread.status === 'archived' ||
  thread.status === 'removed' ||
  thread.trackingMode === 'stopped';

const classifyAllThread = (
  thread: TrackedThread,
  reminders: readonly { readonly threadId: string; readonly status: string }[],
): AllThreadsBucket => {
  const hasUnread = reminders.some((r) => r.threadId === thread.bac_id && r.status !== 'dismissed');
  if (hasUnread) return 'unread';
  if (thread.primaryWorkstreamId === undefined) return 'ungrouped';
  if (thread.lastTurnRole === 'user') return 'waiting';
  if (isStaleOrClosed(thread)) return 'stale';
  return 'normal';
};

// Spec rank order: signal (unread) → amber (waiting on AI / needs
// organize) → green (you replied last / fresh) → gray (stale /
// closed). One flat list, signal-first. Tiebreak by lastSeenAt desc.
const lifecycleRank = (
  thread: TrackedThread,
  reminders: readonly { readonly threadId: string; readonly status: string }[],
): number => {
  const lc = deriveLifecycle(thread, reminders);
  if (lc.dotClass === 'signal') return 0;
  if (lc.dotClass === 'amber') return 1;
  if (lc.dotClass === 'green') return 2;
  return 3;
};

const sortThreadsByLifecycle = (
  list: readonly TrackedThread[],
  reminders: readonly { readonly threadId: string; readonly status: string }[],
): readonly TrackedThread[] =>
  list.slice().sort((a, b) => {
    const rankDelta = lifecycleRank(a, reminders) - lifecycleRank(b, reminders);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });

// Map a composed-packet target to the URL we open in a new tab on
// Dispatch. The user's "where did this go?" confusion is solved by
// actually opening the chat + putting the packet on their clipboard
// to paste in. Export targets (notebook/markdown) skip this and get
// a file download via downloadAsFile below.
const TARGET_CHAT_URL: Partial<Record<ComposedPacket['target'], string>> = {
  gpt_pro: 'https://chatgpt.com/',
  deep_research: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/app',
  codex: 'https://chatgpt.com/codex',
};

const downloadAsFile = (filename: string, body: string, mime = 'text/markdown'): void => {
  const blob = new Blob([body], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
};

// Adapt the companion's DispatchEventRecord shape to the visual
// component's expected shape. Companion gives us kind+target+raw
// timestamp; component wants a label-friendly summary.
const DISPATCH_KIND_TO_DISPLAY: Record<string, RecentDispatchEvent['dispatchKind']> = {
  research: 'research_packet',
  review: 'submit_back',
  coding: 'coding_agent_packet',
  note: 'clone_to_chat',
  other: 'dispatch_out',
};

const DISPATCH_PROVIDER_LABEL: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  other: 'External',
};

const DISPATCH_STATUS_TO_DISPLAY = (status: string): RecentDispatchStatus => {
  if (status === 'replied' || status === 'noted' || status === 'pending' || status === 'archived') {
    return status;
  }
  // 'sent', 'queued', 'failed' all map to 'sent' visually — failed is
  // an internal companion state, not user-facing yet.
  return 'sent';
};

const dispatchDiagnosticReasonText = (
  reason: NonNullable<DispatchDiagnostic['reason']>,
): string => {
  switch (reason) {
    case 'window-expired':
      return 'The capture landed outside the 30-minute dispatch matching window.';
    case 'provider-mismatch':
      return 'The captured provider did not match this dispatch target.';
    case 'tiny-prefix':
      return 'The dispatch prefix was too short to link safely.';
    case 'already-linked':
      return 'The best candidate was already linked to another thread.';
    case 'no-prefix-match':
      return 'No captured user turn contained the dispatch prefix.';
  }
};

// Persist + hydrate the last-known companion status across panel
// re-mounts. Without this hook the panel starts in 'unknown' on every
// open and paints "vault: connecting…" for ~1 s while the first
// /status poll round-trips. When the companion was reachable on close
// (the common case) we can repaint "vault: synced" instantly and let
// the live poll auto-correct if the world changed since.
//
// localStorage is the right tool here: it's synchronous (so we can
// read it inside the useState factory) and side-panel pages have
// their own per-origin store. The cache is tiny (one string) and
// auto-recovers — a stale entry only ever lives until the next
// refresh() lands, ~1 s after mount.
const COMPANION_STATUS_CACHE_KEY = 'sidetrack.lastCompanionStatus';
const COMPANION_STATUS_VALUES: ReadonlySet<string> = new Set([
  'connected',
  'disconnected',
  'vault-error',
  'local-only',
  'unknown',
]);
const readCachedCompanionStatus = (): WorkboardState['companionStatus'] | undefined => {
  try {
    const raw = window.localStorage.getItem(COMPANION_STATUS_CACHE_KEY);
    if (raw !== null && COMPANION_STATUS_VALUES.has(raw)) {
      return raw as WorkboardState['companionStatus'];
    }
  } catch {
    // localStorage may be unavailable (test env, private mode). Fall
    // through to the default 'unknown' state.
  }
  return undefined;
};
const writeCachedCompanionStatus = (status: WorkboardState['companionStatus']): void => {
  try {
    window.localStorage.setItem(COMPANION_STATUS_CACHE_KEY, status);
  } catch {
    // Best-effort; cache miss on next mount is acceptable.
  }
};

const App = () => {
  const [state, setState] = useState<WorkboardState>(() => {
    const cached = readCachedCompanionStatus();
    return cached === undefined
      ? createEmptyWorkboardState()
      : createEmptyWorkboardState({ companionStatus: cached });
  });
  const [bridgeKey, setBridgeKey] = useState('');
  const [port, setPort] = useState('17373');
  const [selectedWorkstream, setSelectedWorkstream] = useState('');
  const [moveThreadId, setMoveThreadId] = useState<string | null>(null);
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null);
  const [draggingTabSessionId, setDraggingTabSessionId] = useState<string | null>(null);
  const [dropWorkstreamId, setDropWorkstreamId] = useState<string | null>(null);
  const [recoveryThreadId, setRecoveryThreadId] = useState<string | null>(null);
  // Bac_id of a dispatch the user clicked to inspect — used by the
  // External viewer modal (and as a fallback "show me the body" for
  // any dispatch the user wants to see again). Null = closed.
  const [viewingDispatchId, setViewingDispatchId] = useState<string | null>(null);
  const [expandedWorkstreamId, setExpandedWorkstreamId] = useState<string | null>(null);
  const [wsPickerOpen, setWsPickerOpen] = useState(false);
  const [wsPickerCreateMode, setWsPickerCreateMode] = useState(false);
  // Tab-session re-attribution picker — when set, the WorkstreamPicker
  // modal applies its selection to this tab-session id (not the global
  // "active workstream pill" intent). Keeps tab attribution and intent
  // independent so changing one doesn't accidentally change the other.
  const [tabSessionMoveId, setTabSessionMoveId] = useState<string | null>(null);
  // Stage 5 polish — debug panel-state dump. Tracks the latest dump
  // result so the icon button can flash a success/error chip with the
  // file path the user can hand to an assistant.
  const [dumpStatus, setDumpStatus] = useState<
    | { readonly kind: 'idle' }
    | { readonly kind: 'dumping' }
    | { readonly kind: 'dumped'; readonly path: string }
    | { readonly kind: 'error'; readonly message: string }
  >({ kind: 'idle' });
  const [viewMode, setViewMode] = useState<'workstream' | 'all' | 'inbox' | 'connections'>(
    'workstream',
  );
  // Stage 5 polish — cross-surface jumps between Inbox and Connections.
  // `connectionsAnchorRequest` is a string that ConnectionsView watches
  // via its requestAnchor prop; when set non-empty, the view auto-anchors
  // there. `inboxSearchRequest` is similar for InboxView's initialQuery.
  const [connectionsAnchorRequest, setConnectionsAnchorRequest] = useState<string>('');
  const [inboxSearchRequest, setInboxSearchRequest] = useState<string>('');
  const requestSwitchToConnections = (canonicalUrl: string): void => {
    // The timeline-visit node id IS the canonical URL — the snapshot
    // builds them that way. So anchoring on `timeline-visit:<URL>`
    // lands on the most useful neighborhood for an unattributed URL.
    setConnectionsAnchorRequest(`timeline-visit:${canonicalUrl}`);
    setViewMode('connections');
  };
  const requestSwitchToInbox = (canonicalUrl: string): void => {
    setInboxSearchRequest(canonicalUrl);
    setViewMode('inbox');
  };
  const [queueDraft, setQueueDraft] = useState('');
  const [queueExpandFor, setQueueExpandFor] = useState<string | null>(null);
  // Set briefly after the user opens compose-at-end via the row's
  // "Queue follow-up" menu so the input grabs focus on the next render.
  const [queueComposeAutoFocus, setQueueComposeAutoFocus] = useState<string | null>(null);
  const [draggedQueueItemId, setDraggedQueueItemId] = useState<string | null>(null);
  const [dragOverQueueItemId, setDragOverQueueItemId] = useState<string | null>(null);
  const [queueCopiedId, setQueueCopiedId] = useState<string | null>(null);
  // Per-thread inline-review draft expansion. Mirrors queueExpandFor:
  // null = chip collapsed, threadId = footer expanded for that thread.
  const [reviewDraftExpandFor, setReviewDraftExpandFor] = useState<string | null>(null);
  // Recent Dispatches "show archived" toggle. Local-only — archived
  // is a UI filter, not a persisted preference.
  const [showArchivedDispatches, setShowArchivedDispatches] = useState(false);
  const [noteComposeOpen, setNoteComposeOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteEditId, setNoteEditId] = useState<string | null>(null);
  // Per-thread inline note compose. Holds the thread bac_id whose
  // history strip is currently in compose mode; null = none open.
  // Separate from noteComposeOpen so the workstream-level rail and
  // the per-thread strip don't fight each other for state.
  const [threadNoteFor, setThreadNoteFor] = useState<string | null>(null);
  const [threadNoteDraft, setThreadNoteDraft] = useState('');
  const [threadHistoryOpen, setThreadHistoryOpen] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [composeThreadId, setComposeThreadId] = useState<string | null>(null);
  const [composeWorkstreamOverrideId, setComposeWorkstreamOverrideId] = useState<string | null>(
    null,
  );
  const [composeScopeSuggestionsByThread, setComposeScopeSuggestionsByThread] = useState<
    ReadonlyMap<string, readonly ScopeSuggestion[]>
  >(() => new Map<string, readonly ScopeSuggestion[]>());
  // Which thread row currently has its Send-to dropdown open (null
  // = none). Only one open at a time.
  const [sendToOpenFor, setSendToOpenFor] = useState<string | null>(null);
  const [pendingDispatch, setPendingDispatch] = useState<ComposedPacket | null>(null);
  const [dispatchInFlight, setDispatchInFlight] = useState(false);
  const [reviewThreadId, setReviewThreadId] = useState<string | null>(null);
  const [reviewInFlight, setReviewInFlight] = useState(false);
  const [reviewTurnsByUrl, setReviewTurnsByUrl] = useState<
    ReadonlyMap<string, readonly CapturedTurnRecord[]>
  >(() => new Map<string, readonly CapturedTurnRecord[]>());
  const [settings, setSettings] = useState<SettingsDocument | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [healthPanelOpen, setHealthPanelOpen] = useState(false);
  // Deeper-page-access banner: engagement + future content-extraction
  // subsystems need `https://*/*` host permission. Default `true` so the
  // first paint is clean; useEffect below corrects it after the
  // chrome.permissions.contains probe resolves. When the user dismisses
  // the banner manually we hide it for the session (re-shown on a fresh
  // panel open if still missing).
  const [hasDeeperPagePermission, setHasDeeperPagePermission] = useState<boolean>(true);
  const [deeperAccessBannerDismissed, setDeeperAccessBannerDismissed] = useState<boolean>(false);
  const [deeperAccessBannerBusy, setDeeperAccessBannerBusy] = useState<boolean>(false);
  // Direct chrome.tabs read for the active tab URL. `state.activeTabUrl`
  // only updates on the 15 s state poll, so the Current-tab card lagged
  // visibly after every navigation. Subscribing to chrome.tabs events
  // here pulls activeTabUrl into the side panel immediately, without
  // waiting for the SW round-trip.
  const [liveActiveTabUrl, setLiveActiveTabUrl] = useState<string | undefined>(undefined);
  // Keep a ref so loadTabSessions (called from background polls) can
  // read the current focused-tab URL without rebuilding the callback
  // on every focus change.
  const liveActiveTabUrlRef = useRef(liveActiveTabUrl);
  liveActiveTabUrlRef.current = liveActiveTabUrl;
  const [liveActiveTabTitle, setLiveActiveTabTitle] = useState<string | undefined>(undefined);
  const [threadSearchOpen, setThreadSearchOpen] = useState(false);
  const [threadSearchQuery, setThreadSearchQuery] = useState('');
  const [threadSearchResults, setThreadSearchResults] = useState<readonly ThreadSearchResult[]>([]);
  const [threadSearchState, setThreadSearchState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [threadSearchError, setThreadSearchError] = useState<string | null>(null);
  const [designPreviewOpen, setDesignPreviewOpen] = useState(false);
  const [workstreamDetailOpen, setWorkstreamDetailOpen] = useState(false);
  const [workstreamDetailLinkedNotes, setWorkstreamDetailLinkedNotes] = useState<
    readonly LinkedNote[]
  >([]);
  // Mount-time defaults — match the companion's allow-by-default
  // trust semantic so the UI doesn't lie about state before the
  // panel-open hydration fires GET /v1/workstreams/{id}/trust.
  const [workstreamDetailTrust, setWorkstreamDetailTrust] = useState<readonly TrustEntry[]>([
    {
      tool: 'sidetrack.queue.create',
      humanLabel: 'queue_item',
      description: 'queue an outbound follow-up to a provider',
      allowed: true,
    },
    {
      tool: 'sidetrack.threads.move',
      humanLabel: 'move_item',
      description: 'move a tracked thread to this workstream',
      allowed: true,
    },
    {
      tool: 'sidetrack.workstreams.bump',
      humanLabel: 'bump_workstream',
      description: 'raise priority on a queued ask',
      allowed: true,
    },
    {
      tool: 'sidetrack.threads.archive',
      humanLabel: 'archive_thread',
      description: 'archive a tracked thread',
      allowed: true,
    },
    {
      tool: 'sidetrack.threads.unarchive',
      humanLabel: 'unarchive_thread',
      description: 'restore an archived thread',
      allowed: true,
    },
  ]);
  const [tabSessionInbox, setTabSessionInbox] =
    useState<TabSessionInboxData>(EMPTY_TAB_SESSION_INBOX);
  const [tabSessionProjection, setTabSessionProjection] = useState<TabSessionProjection | null>(
    null,
  );
  const [tabSessionSuggestions, setTabSessionSuggestions] = useState<
    Record<string, TabSessionResolutionResult>
  >({});
  const [tabSessionLoading, setTabSessionLoading] = useState(false);
  const [tabSessionError, setTabSessionError] = useState<string | null>(null);
  // Per-canonical-URL state (Phase B). URL is the attribution unit;
  // tab-session state above is preserved for back-compat with sync
  // peers that haven't been updated yet.
  const [urlInbox, setUrlInbox] = useState<UrlInboxData>(EMPTY_URL_INBOX);
  const [urlProjection, setUrlProjection] = useState<UrlProjection | null>(null);
  const [urlSuggestions, setUrlSuggestions] = useState<Record<string, UrlResolutionResult>>({});
  // Stage 5 follow-up — refs let loadTabSessions read the latest
  // suggestion cache without listing it as a dep (which would
  // re-create the callback + tear down the 4s interval on every
  // suggestion update).
  const tabSessionSuggestionsRef = useRef(tabSessionSuggestions);
  tabSessionSuggestionsRef.current = tabSessionSuggestions;
  const urlSuggestionsRef = useRef(urlSuggestions);
  urlSuggestionsRef.current = urlSuggestions;
  const tabSessionSuggestionLoadInFlightRef = useRef(false);
  const urlSuggestionLoadInFlightRef = useRef(false);
  // 2026-05 cleanup: with the 4 s background poll gone, the user can
  // refresh a single suggestion via the per-card ↻ button. This set
  // tracks which urls are currently re-fetching so the button can
  // disable + show a spinner without a separate Map per card.
  const [refreshingUrlSuggestionIds, setRefreshingUrlSuggestionIds] =
    useState<ReadonlySet<string>>(() => new Set<string>());
  // URL auto-apply is reversible (your manual move beats the inferred
  // one on precedence tie-break) but we still don't want to retry the
  // same URL on every poll cycle. Track in-flight + completed attempts
  // per canonical URL so each URL is auto-applied at most once per
  // session per server response.
  const urlAutoApplyInFlightRef = useRef<Set<string>>(new Set<string>());
  const [pendingCodingOffers, setPendingCodingOffers] = useState<readonly OfferRecord[]>([]);
  // Per-row dismissals for the Needs-Organize inline suggestion. Local
  // (per-session) — survives panel close but not extension reload.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Which thread row's action overflow menu (⋯) is open. One at a
  // time across the workboard.
  const [actionMenuOpenFor, setActionMenuOpenFor] = useState<string | null>(null);

  // Persist companionStatus on every change so the next panel mount
  // can hydrate from cache instead of starting in 'unknown'. Pair to
  // readCachedCompanionStatus above; keeps the next reopen flash-free
  // when the world hasn't changed.
  useEffect(() => {
    writeCachedCompanionStatus(state.companionStatus);
  }, [state.companionStatus]);

  // Click-outside dismissal for the overflow menu. The menu's own
  // contents stop propagation, so any click that reaches document
  // came from outside.
  useEffect(() => {
    if (actionMenuOpenFor === null) return undefined;
    const onDoc = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.thread-overflow-anchor') !== null) {
        return;
      }
      setActionMenuOpenFor(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
    };
  }, [actionMenuOpenFor]);
  // Probe + watch the host permission state. `chrome.permissions.contains`
  // is the source of truth; `onAdded`/`onRemoved` fire when the user
  // grants or revokes (including from Chrome's chrome://extensions UI).
  // Each chrome.* read is guarded because the test harness mounts the
  // side panel against a partially-stubbed chrome.
  useEffect(() => {
    if (typeof chrome === 'undefined' || chrome.permissions === undefined) return undefined;
    const origins = ['https://*/*', 'http://*/*'];
    let cancelled = false;
    const probe = (): void => {
      try {
        chrome.permissions.contains({ origins }, (granted) => {
          if (!cancelled) setHasDeeperPagePermission(Boolean(granted));
        });
      } catch {
        // Test harness without chrome.permissions — leave optimistic default.
      }
    };
    probe();
    const onChange = (): void => probe();
    type ListenerEvent = {
      readonly addListener?: (cb: (...args: unknown[]) => void) => void;
      readonly removeListener?: (cb: (...args: unknown[]) => void) => void;
    };
    const onAdded = chrome.permissions.onAdded as unknown as ListenerEvent | undefined;
    const onRemoved = chrome.permissions.onRemoved as unknown as ListenerEvent | undefined;
    const onChangeAny = onChange as unknown as (...args: unknown[]) => void;
    onAdded?.addListener?.(onChangeAny);
    onRemoved?.addListener?.(onChangeAny);
    return () => {
      cancelled = true;
      onAdded?.removeListener?.(onChangeAny);
      onRemoved?.removeListener?.(onChangeAny);
    };
  }, []);
  // Keep liveActiveTabUrl in sync with the focused tab using chrome.tabs
  // directly. Listening to onActivated + onUpdated gives sub-second
  // latency for the Current-tab card, instead of waiting on the SW's
  // periodic state poll. Each chrome.* read is guarded because the test
  // harness mounts the side panel against a partially-stubbed chrome.
  useEffect(() => {
    if (typeof chrome === 'undefined' || chrome.tabs === undefined) return undefined;
    let cancelled = false;
    // Only http(s) URLs can be tracked. The side panel page itself
    // (chrome-extension://…) often comes back as "active" when its
    // window is focused, especially in stealth Chromium contexts where
    // the side panel surface is opened as a regular tab. Without this
    // filter, the Current-tab card rendered "Sidetrack (capturing…)"
    // for the side panel's own URL. chrome:// / file:// / about: tabs
    // are never observed by the timeline wiring, so leaving the live
    // state at undefined is the honest answer.
    const isTrackableScheme = (url: string): boolean =>
      url.startsWith('https://') || url.startsWith('http://');
    const applyActiveTab = (tabs: readonly chrome.tabs.Tab[]): void => {
      if (cancelled) return;
      const tab = tabs.find(
        (candidate) =>
          candidate.active === true &&
          typeof candidate.url === 'string' &&
          candidate.url.length > 0 &&
          isTrackableScheme(candidate.url),
      );
      const url = tab?.url;
      const title = tab?.title;
      setLiveActiveTabUrl(url);
      setLiveActiveTabTitle(
        url !== undefined && title !== undefined && title.length > 0 ? title : undefined,
      );
    };
    const refresh = (): void => {
      try {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
          if (cancelled) return;
          if (
            tabs.some(
              (tab) =>
                tab.active === true &&
                typeof tab.url === 'string' &&
                tab.url.length > 0 &&
                isTrackableScheme(tab.url),
            )
          ) {
            applyActiveTab(tabs);
            return;
          }
          // In the headed recorder, the "side panel" can be a regular
          // chrome-extension:// tab. That tab may be the last-focused
          // window even though the user is actively browsing in another
          // window. Fall back to all active tabs and pick an http(s) tab
          // so Current-tab renders from live tab state instead of waiting
          // for the slower projection poll.
          chrome.tabs.query({ active: true }, (allActiveTabs) => {
            applyActiveTab(allActiveTabs);
          });
        });
      } catch {
        // Test harness — leave state untouched.
      }
    };
    refresh();
    const onActivated = (): void => refresh();
    const onUpdated = (
      _tabId: number,
      changeInfo: { url?: string; title?: string },
      tab: { active?: boolean },
    ): void => {
      if (tab.active !== true) return;
      if (changeInfo.url !== undefined || changeInfo.title !== undefined) refresh();
    };
    const onFocusChanged = (): void => refresh();
    type ListenerEvent = {
      readonly addListener?: (cb: (...args: unknown[]) => void) => void;
      readonly removeListener?: (cb: (...args: unknown[]) => void) => void;
    };
    const activatedApi = chrome.tabs.onActivated as unknown as ListenerEvent | undefined;
    const updatedApi = chrome.tabs.onUpdated as unknown as ListenerEvent | undefined;
    const focusApi = chrome.windows?.onFocusChanged as unknown as ListenerEvent | undefined;
    const onActivatedAny = onActivated as unknown as (...args: unknown[]) => void;
    const onUpdatedAny = onUpdated as unknown as (...args: unknown[]) => void;
    const onFocusChangedAny = onFocusChanged as unknown as (...args: unknown[]) => void;
    activatedApi?.addListener?.(onActivatedAny);
    updatedApi?.addListener?.(onUpdatedAny);
    focusApi?.addListener?.(onFocusChangedAny);
    return () => {
      cancelled = true;
      activatedApi?.removeListener?.(onActivatedAny);
      updatedApi?.removeListener?.(onUpdatedAny);
      focusApi?.removeListener?.(onFocusChangedAny);
    };
  }, []);
  const handleGrantDeeperPageAccess = useCallback(async (): Promise<void> => {
    setDeeperAccessBannerBusy(true);
    try {
      const granted = await new Promise<boolean>((resolve) => {
        chrome.permissions.request({ origins: ['https://*/*', 'http://*/*'] }, (g) => {
          resolve(Boolean(g));
        });
      });
      setHasDeeperPagePermission(granted);
      if (granted) {
        await chrome.runtime
          .sendMessage({ type: 'sidetrack.timeline.permission.granted' })
          .catch(() => undefined);
      }
    } finally {
      setDeeperAccessBannerBusy(false);
    }
  }, []);
  // Cache of suggested workstream per thread, keyed by thread bac_id.
  // Populated from companion's GET /v1/suggestions/thread/{id} (PR #76
  // Track F) when the row is rendered. Empty fallback shows nothing.
  // Stale-while-revalidate semantics: each row renders the cached
  // value immediately AND always kicks a background fetch on mount
  // / on workstream-state change / on explicit refresh. Cache is
  // dropped wholesale when the workstream fingerprint shifts so a
  // workstream rename, member move, or new workstream invalidates
  // every cached suggestion at once.
  const [suggestionCache, setSuggestionCache] = useState<
    ReadonlyMap<
      string,
      { readonly workstreamId: string; readonly label: string; readonly confidence: number }
    >
  >(() => new Map());
  const lastFingerprintRef = useRef<string | null>(null);

  // Refresh pending coding-session offers from chrome.storage. Driven
  // by storage events (set by the background detection handler) plus
  // a one-shot read on mount so we pick up any offers staged before
  // the panel opened. PR #78 ships the detection writes; offers stay
  // empty in environments without the background script.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const offers = await listPendingOffers();
        if (!cancelled) setPendingCodingOffers(offers);
      } catch {
        // chrome.storage missing (e.g., test env) — no banner
      }
    };
    void refresh();
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('sidetrack.codingAttach.offers' in changes) {
        void refresh();
      }
    };
    // chrome.storage is undefined in jsdom (unit tests), so guard. The
    // typedef has it as always-defined globally; the check is real.
    interface StorageOnChanged {
      readonly addListener: (
        cb: (changes: Record<string, chrome.storage.StorageChange>) => void,
      ) => void;
      readonly removeListener: (
        cb: (changes: Record<string, chrome.storage.StorageChange>) => void,
      ) => void;
    }
    const onChanged: StorageOnChanged | null =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      typeof chrome.storage?.onChanged?.addListener === 'function'
        ? chrome.storage.onChanged
        : null;
    onChanged?.addListener(onStorageChanged);
    return () => {
      cancelled = true;
      onChanged?.removeListener(onStorageChanged);
    };
  }, []);
  // Default to light explicitly — 'auto' was tracking system theme,
  // surprising users who keep their OS in dark mode but expect the
  // side panel to stay light. User can flip in Settings.
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [density, setDensity] = useState<DensityMode>('cozy');

  // Apply theme + density to the root <html> element so all sidepanel
  // styles inherit. 'auto' resolves via prefers-color-scheme; guarded
  // for environments without matchMedia (e.g. jsdom in unit tests).
  useEffect(() => {
    const root = document.documentElement;
    const matchMedia: ((query: string) => MediaQueryList) | undefined =
      typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined;
    const prefersDark = matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    const resolved: 'light' | 'ink' = theme === 'auto' ? (prefersDark ? 'ink' : 'light') : theme;
    if (resolved === 'ink') {
      root.setAttribute('data-theme', 'ink');
    } else {
      root.removeAttribute('data-theme');
    }
    if (density === 'compact') {
      root.setAttribute('data-density', 'compact');
    } else {
      root.removeAttribute('data-density');
    }
  }, [theme, density]);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [codingAttachOpen, setCodingAttachOpen] = useState(false);
  const [setupCompleted, setSetupCompleted] = useState<boolean | null>(null);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [vaultPath, setVaultPath] = useState(DEFAULT_VAULT_PATH);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [captureToastHost, setCaptureToastHost] = useState<string | null>(null);
  const [findPulseDismissedUrl, setFindPulseDismissedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wizardConnectionError, setWizardConnectionError] = useState<string | null>(null);
  // Recall index lifecycle state — polled from /v1/system/health when
  // the companion is reachable. The header pill flips to "indexing"
  // amber while the companion's background rebuild is in flight, so
  // the user understands why Déjà-vu queries return nothing yet.
  const [recallStatus, setRecallStatus] = useState<
    'missing' | 'stale' | 'empty' | 'rebuilding' | 'ready' | null
  >(null);

  // MCP Streamable HTTP info exposed by the companion's /v1/status
  // when the companion is also managing the sidetrack-mcp child.
  // Side-panel attach prompts use this to embed the *real* auth key
  // the MCP server is accepting, instead of the user's bridge key
  // (which is a different secret and only worked previously by
  // accident when the user manually started MCP with
  // --mcp-auth-key=<bridge>).
  const [mcpInfo, setMcpInfo] = useState<{
    readonly url: string;
    readonly port: number;
    readonly authKey: string;
    readonly health?: {
      readonly reachable: boolean;
      readonly authAccepted: boolean;
      readonly status: 'ok' | 'auth_failed' | 'unreachable';
      readonly checkedAt: string;
    };
  } | null>(null);
  const [vaultRoot, setVaultRoot] = useState<string | null>(null);

  const threads = useMemo(() => visibleThreads(state.threads), [state.threads]);
  // Stable string that mutates whenever the workstream graph or any
  // thread's primary-workstream assignment changes. Drives both the
  // wholesale cache flush below and the per-row useEffect dep so the
  // companion's suggestion gets re-fetched whenever the inputs that
  // shaped it changed.
  const workstreamFingerprint = useMemo(() => {
    const wsParts = state.workstreams
      .map((ws) => `${ws.bac_id}:${ws.revision}`)
      .sort()
      .join('|');
    const memberParts = state.threads
      .map((t) => `${t.bac_id}->${t.primaryWorkstreamId ?? ''}`)
      .sort()
      .join('|');
    return `${wsParts}#${memberParts}`;
  }, [state.workstreams, state.threads]);
  // Stable callback so the row effect's `resolveLabel` dep doesn't
  // thrash on every render. workstreamPath is pure over the
  // workstreams array, so we re-create only when the array changes.
  const resolveWorkstreamLabel = useCallback(
    (workstreamId: string) => workstreamPath(workstreamId, state.workstreams),
    [state.workstreams],
  );
  // Unified display context for the entityDisplay helpers — feeds
  // ConnectionsView and the Inbox provenance row. `resolveWorkstreamPath`
  // returns null when the workstream isn't in the local list so the
  // helper can fall back to "Unknown workstream" instead of leaking a
  // raw bac_id. Replica aliases are persisted by useReplicaAliasMap so
  // numbering stays stable across panel reloads.
  const [localReplicaId, setLocalReplicaId] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadOrCreateEdgeReplica().then((replica) => {
      if (!cancelled) setLocalReplicaId(replica.edgeReplicaId);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const replicaAlias = useReplicaAliasMap({
    ...(localReplicaId === undefined ? {} : { localReplicaId }),
    observedReplicaIds: [],
  });
  const snippetPreviews = useSnippetPreviewMap();
  const displayCtx = useMemo<EntityDisplayCtx>(
    () => ({
      resolveWorkstreamPath: (bacId) => {
        const found = state.workstreams.find((w) => w.bac_id === bacId);
        return found === undefined ? null : workstreamPath(bacId, state.workstreams);
      },
      replicaAlias,
      snippetPreview: snippetPreviews.lookup,
    }),
    [state.workstreams, replicaAlias, snippetPreviews],
  );
  // Invalidate every cached suggestion when the workstream
  // fingerprint shifts (rename, member move, new/deleted workstream).
  // The per-row effect will re-fetch on its next render.
  useEffect(() => {
    // Skip the initial render so we don't drop a freshly-populated
    // cache that hasn't observed any mutation yet.
    if (lastFingerprintRef.current === null) {
      lastFingerprintRef.current = workstreamFingerprint;
      return;
    }
    if (lastFingerprintRef.current !== workstreamFingerprint) {
      lastFingerprintRef.current = workstreamFingerprint;
      setSuggestionCache(new Map());
    }
  }, [workstreamFingerprint]);
  const moveThread = useMemo(
    () => threads.find((thread) => thread.bac_id === moveThreadId),
    [moveThreadId, threads],
  );
  const recoveryThread = useMemo(
    () => threads.find((thread) => thread.bac_id === recoveryThreadId),
    [recoveryThreadId, threads],
  );
  const composeThread = useMemo(
    () => threads.find((thread) => thread.bac_id === composeThreadId),
    [composeThreadId, threads],
  );
  const reviewThread = useMemo(
    () => threads.find((thread) => thread.bac_id === reviewThreadId),
    [reviewThreadId, threads],
  );
  const composeWorkstream = useMemo(() => {
    if (composeThread === undefined) {
      return undefined;
    }
    const targetWorkstreamId = composeWorkstreamOverrideId ?? composeThread.primaryWorkstreamId;
    return state.workstreams.find((workstream) => workstream.bac_id === targetWorkstreamId);
  }, [composeThread, composeWorkstreamOverrideId, state.workstreams]);

  const refresh = async () => {
    // Use sendRequestRaw so we can consume state from `ok:false`
    // responses too. getWorkboardState returns ok:false +
    // state.companionStatus='disconnected' when the companion is
    // unreachable; throwing there means the side panel discards
    // the disconnected state and the user keeps seeing a stale
    // "connected" UI. Refresh is a poll, not an action — it
    // should reflect whatever state the background has.
    const response = (await chrome.runtime.sendMessage({
      type: messageTypes.getWorkboardState,
    })) as unknown;
    if (!isRuntimeResponse(response)) {
      throw new Error('Sidetrack background returned an invalid response.');
    }
    if (!response.ok && response.state === undefined) {
      // No state to consume — surface the error and bail.
      throw new Error(response.error);
    }
    const next = response.ok ? response.state : response.state!;
    setState(next);
    setBridgeKey(next.settings.companion.bridgeKey);
    setPort(String(next.settings.companion.port));
    setError(next.lastError ?? (response.ok ? null : (response.error ?? null)));
    if (next.vaultPath !== undefined) {
      setVaultPath(next.vaultPath);
    }
    // Default to "not set" (Inbox) on first load — user picks via the ws-bar.
  };

  const fetchCompanionJson = useCallback(
    async <T,>(path: string): Promise<T> => {
      if (port.length === 0 || bridgeKey.length === 0) {
        throw new Error('Companion is not configured.');
      }
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { 'x-bac-bridge-key': bridgeKey },
      });
      if (!response.ok) {
        throw new Error(`Companion ${path} failed (${String(response.status)}).`);
      }
      const body = (await response.json()) as { readonly data?: T };
      if (body.data === undefined) {
        throw new Error(`Companion ${path} returned no data.`);
      }
      return body.data;
    },
    [bridgeKey, port],
  );

  // Cap the resolver fan-out so the side panel doesn't fire 50+
  // concurrent /resolve calls at once. The companion's HTTP loop is
  // single-threaded — saturating it caused the periodic
  // /v1/system/health probe to time out, briefly flashing the
  // "companion disconnected" banner, and stalled Inbox updates by 10+
  // seconds per refresh cycle. Bound to 4 in-flight requests.
  const mapWithConcurrency = useCallback(
    async <T, R>(
      items: readonly T[],
      limit: number,
      worker: (item: T) => Promise<R>,
    ): Promise<R[]> => {
      const out: R[] = new Array(items.length) as R[];
      let next = 0;
      const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (true) {
          const i = next;
          next += 1;
          if (i >= items.length) return;
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          out[i] = await worker(items[i]!);
        }
      });
      await Promise.all(runners);
      return out;
    },
    [],
  );

  // Stage 5 follow-up — `/resolve?dryRun=true` runs the full
  // resolver pipeline (PPR + cluster + similarity + ranker fusion) on
  // the companion. Firing it for every unattributed item on every 4 s
  // poll dominated the panel's HTTP budget AND the companion's CPU as
  // the graph grew. Cache results per id; only fetch resolves for ids
  // we haven't seen yet, or for ids the caller marks dirty via
  // `forceRefetch`.
  //
  // The cache is invalidated entirely on user mutation (attribution,
  // dismiss) because those change the resolver inputs.
  const loadTabSessionSuggestions = useCallback(
    async (
      projection: TabSessionProjection,
      inbox: TabSessionInboxData,
      previous: Readonly<Record<string, TabSessionResolutionResult>>,
      forceRefetch = false,
    ): Promise<Record<string, TabSessionResolutionResult>> => {
      const recordsById = new Map<string, TabSessionRecord>();
      for (const record of Object.values(projection.bySessionId)) {
        if (record.closedAt === undefined && record.currentAttribution === undefined) {
          recordsById.set(record.tabSessionId, record);
        }
      }
      for (const record of inbox.items) {
        if (record.currentAttribution === undefined) {
          recordsById.set(record.tabSessionId, record);
        }
      }
      // Drop cached entries for ids no longer in the inbox.
      const next: Record<string, TabSessionResolutionResult> = {};
      for (const id of recordsById.keys()) {
        if (!forceRefetch && previous[id] !== undefined) next[id] = previous[id];
      }
      const idsToFetch = [...recordsById.keys()].filter((id) =>
        forceRefetch ? true : next[id] === undefined,
      );
      const fetched = await mapWithConcurrency(idsToFetch, 4, async (tabSessionId) => {
        try {
          const result = await fetchCompanionJson<unknown>(
            `/v1/tabsessions/${encodeURIComponent(tabSessionId)}/resolve?dryRun=true`,
          );
          return isTabSessionResolutionResult(result) ? ([tabSessionId, result] as const) : null;
        } catch {
          return null;
        }
      });
      for (const entry of fetched) {
        if (entry === null) continue;
        const [id, result] = entry;
        // Skip caching empty results. An empty resolution most often
        // means the materializer hasn't folded the new visit into the
        // snapshot yet (materializer drains run async in a child
        // process). If we cached an empty result we'd stick on
        // "No signal yet" forever — the snapshot.revision watcher
        // will force a refetch when the drain lands, and any unrelated
        // refresh trigger in the meantime gets a fresh attempt too.
        if (result.fusedCandidates.length === 0) continue;
        next[id] = result;
      }
      return next;
    },
    [fetchCompanionJson, mapWithConcurrency],
  );

  // Resolve every unattributed URL in the Inbox so the cards can show
  // "Best guess: …" inline. Cached across polls; refetched on user
  // mutation.
  const loadUrlSuggestions = useCallback(
    async (
      inbox: UrlInboxData,
      previous: Readonly<Record<string, UrlResolutionResult>>,
      forceRefetch = false,
      extraCanonicalUrls: readonly string[] = [],
    ): Promise<Record<string, UrlResolutionResult>> => {
      const inboxCanonicalUrls = inbox.items
        .filter((item) => item.currentAttribution === undefined)
        .map((item) => item.canonicalUrl);
      // Merge inbox URLs with caller-supplied extras (e.g., the focused
      // tab's URL when it's not in the inbox top page). Dedupe by Set.
      const canonicalUrls = [...new Set<string>([...inboxCanonicalUrls, ...extraCanonicalUrls])];
      const next: Record<string, UrlResolutionResult> = {};
      for (const url of canonicalUrls) {
        if (!forceRefetch && previous[url] !== undefined) next[url] = previous[url];
      }
      const toFetch = canonicalUrls.filter((url) =>
        forceRefetch ? true : next[url] === undefined,
      );
      const fetched = await mapWithConcurrency(toFetch, 4, async (canonicalUrl) => {
        try {
          const result = await fetchCompanionJson<unknown>(
            `/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
          );
          return isUrlResolutionResult(result) ? ([canonicalUrl, result] as const) : null;
        } catch {
          return null;
        }
      });
      for (const entry of fetched) {
        if (entry === null) continue;
        const [url, result] = entry;
        // Same self-heal as the tab-session cache: empty results
        // usually mean the materializer hasn't drained the new visit
        // yet. Don't cache them; let snapshot.revision changes (or
        // any other refresh trigger) force a refetch.
        if (result.fusedCandidates.length === 0) continue;
        next[url] = result;
      }
      return next;
    },
    [fetchCompanionJson, mapWithConcurrency],
  );

  // Per-row refresh: re-resolves a single URL's suggestion without
  // touching the rest of the inbox. With the 4 s background poll
  // gone (2026-05), this is how the user manually picks up a fresher
  // suggestion for ONE card — one /v1/visits/.../resolve call,
  // instead of refetching the whole list.
  const refreshUrlSuggestion = useCallback(
    async (canonicalUrl: string): Promise<void> => {
      setRefreshingUrlSuggestionIds((current) => {
        if (current.has(canonicalUrl)) return current;
        const next = new Set(current);
        next.add(canonicalUrl);
        return next;
      });
      try {
        const result = await fetchCompanionJson<unknown>(
          `/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`,
        );
        if (isUrlResolutionResult(result)) {
          setUrlSuggestions((current) => ({ ...current, [canonicalUrl]: result }));
        }
      } catch {
        // Per-card refresh failures stay silent — the user can retry.
      } finally {
        setRefreshingUrlSuggestionIds((current) => {
          if (!current.has(canonicalUrl)) return current;
          const next = new Set(current);
          next.delete(canonicalUrl);
          return next;
        });
      }
    },
    [fetchCompanionJson],
  );

  // Stage 5 follow-up — background polls should NOT flip the
  // `tabSessionLoading` flag (it toggles the "Loading tab sessions…"
  // line, which reflows the Inbox layout every 4 s = visible flicker).
  // Only the initial load + the explicit refresh button surface
  // loading state; the poll silently swaps in fresh data.
  //
  // Similarly: the error banner is only cleared on SUCCESS, not on
  // every fetch start. A flaky companion (one failed poll out of
  // ten) used to flash the red banner on/off; now it persists until
  // the next successful refresh, which is the actual signal the user
  // wants.
  const loadTabSessions = useCallback(
    async (
      options: { readonly background?: boolean; readonly forceRefetchSuggestions?: boolean } = {},
    ): Promise<void> => {
      const background = options.background === true;
      const forceRefetch = options.forceRefetchSuggestions === true;
      if (port.length === 0 || bridgeKey.length === 0) {
        setTabSessionProjection(null);
        setTabSessionInbox(EMPTY_TAB_SESSION_INBOX);
        setTabSessionSuggestions({});
        setUrlProjection(null);
        setUrlInbox(EMPTY_URL_INBOX);
        setUrlSuggestions({});
        return;
      }
      if (!background) {
        setTabSessionLoading(true);
        setTabSessionError(null);
      }
      const loadUrlState = async (): Promise<void> => {
        try {
          const [urlProj, urlInboxResp] = await Promise.all([
            fetchCompanionJson<unknown>('/v1/visits/projection'),
            fetchCompanionJson<unknown>('/v1/visits/inbox?limit=51&offset=0'),
          ]);
          if (isUrlProjection(urlProj) && isUrlInboxData(urlInboxResp)) {
            setUrlProjection(urlProj);
            setUrlInbox(urlInboxResp);
            if (!urlSuggestionLoadInFlightRef.current) {
              urlSuggestionLoadInFlightRef.current = true;
              // Include the currently-focused tab's URL in the suggestion
              // fetch even when it's not in the inbox top page — otherwise
              // the Current Tab card renders without a suggestion for
              // late-page or attributed URLs the resolver could still
              // give us advice on. Read from the latest active-tab state.
              const focusedCanonical =
                liveActiveTabUrlRef.current ??
                state.activeTabUrl ??
                state.currentTab?.tabSnapshot?.url ??
                state.currentTab?.threadUrl;
              const focusedExtras =
                typeof focusedCanonical === 'string' && focusedCanonical.length > 0
                  ? [focusedCanonical]
                  : [];
              void loadUrlSuggestions(
                urlInboxResp,
                urlSuggestionsRef.current,
                forceRefetch,
                focusedExtras,
              )
                .then(setUrlSuggestions)
                .catch(() => undefined)
                .finally(() => {
                  urlSuggestionLoadInFlightRef.current = false;
                });
            }
          } else {
            // eslint-disable-next-line no-console
            console.warn('[sidetrack:panel] loadTabSessions — invalid /v1/visits payload');
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[sidetrack:panel] loadTabSessions — /v1/visits fetch failed', err);
        }
      };
      void loadUrlState();
      try {
        const [tabProjection, tabInbox] = await Promise.all([
          fetchCompanionJson<unknown>('/v1/tabsessions/projection'),
          fetchCompanionJson<unknown>('/v1/tabsessions/inbox?limit=51&offset=0'),
        ]);
        if (!isTabSessionProjection(tabProjection) || !isTabSessionInboxData(tabInbox)) {
          throw new Error('Companion returned an invalid tab-session projection.');
        }
        setTabSessionProjection(tabProjection);
        setTabSessionInbox(tabInbox);
        if (!tabSessionSuggestionLoadInFlightRef.current) {
          tabSessionSuggestionLoadInFlightRef.current = true;
          void loadTabSessionSuggestions(
            tabProjection,
            tabInbox,
            tabSessionSuggestionsRef.current,
            forceRefetch,
          )
            .then(setTabSessionSuggestions)
            .catch(() => {
              if (!background) setTabSessionSuggestions({});
            })
            .finally(() => {
              tabSessionSuggestionLoadInFlightRef.current = false;
            });
        }
        // Successful fetch — clear any error banner left over from a
        // prior poll. Doing it here (vs at start) keeps the banner
        // sticky until the situation actually recovers.
        setTabSessionError(null);
      } catch (loadError) {
        // Only surface tab-session errors in the foreground. A
        // single failed background poll doesn't deserve a red
        // banner; if the failure persists, the next foreground
        // action (refresh button, view-mode change, initial mount)
        // will surface it.
        if (!background) {
          setTabSessionError(
            loadError instanceof Error ? loadError.message : 'Could not load tab sessions.',
          );
          setTabSessionSuggestions({});
        }
      } finally {
        if (!background) setTabSessionLoading(false);
      }
    },
    [bridgeKey, fetchCompanionJson, loadTabSessionSuggestions, loadUrlSuggestions, port],
  );

  // Stage 5 follow-up — `state.updatedAt` and `viewMode` are reactive
  // (workboard state bumps, panel-tab switches), not user-initiated
  // loads. Firing the foreground loader here flipped
  // `tabSessionLoading` every time an attribution landed, which made
  // the "Loading tab sessions…" line appear above the existing cards
  // and shift them down. Use background mode; the InboxView still
  // shows a loading skeleton when there's no projection yet.
  useEffect(() => {
    if (state.companionStatus !== 'connected') return;
    void loadTabSessions({ background: true });
  }, [loadTabSessions, state.companionStatus, state.updatedAt, viewMode]);

  // Watch the companion's snapshot revision. When the materializer
  // produces a new snapshot (typically 1-5s after a freshly visited
  // URL is captured), force a re-fetch of resolver suggestions so
  // the Current Tab card stops showing "No signal yet" for URLs the
  // graph now knows about. The cache-fill side of this also skips
  // caching empty results — together they self-heal the stale state.
  const lastSnapshotRevisionRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.companionStatus !== 'connected') return;
    const rev = state.snapshotRevision;
    if (rev === undefined) return;
    if (lastSnapshotRevisionRef.current === rev) return;
    // First observation: prime without refetching.
    const previous = lastSnapshotRevisionRef.current;
    lastSnapshotRevisionRef.current = rev;
    if (previous === null) return;
    void loadTabSessions({ background: true, forceRefetchSuggestions: true });
  }, [loadTabSessions, state.companionStatus, state.snapshotRevision]);

  // 2026-05 cleanup: dropped the 4 s background poll. It was firing
  // /v1/tabsessions/*/resolve four times per minute per visible card,
  // for every warm-restart of the side panel, even when nothing had
  // changed. The user explicitly asked for cache-first behavior:
  // suggestions stick until the user hits Refresh (list-level), the
  // per-card refresh button, or visibly navigates a tab (handled by
  // the push-driven refresh below). The companion already publishes
  // freshness through tab-navigation events, so this poll was pure
  // overhead.
  //
  // If we ever need a heartbeat to detect companion-status changes,
  // it should be a small "ping" call (no suggestions in the response)
  // rather than re-fetching every suggestion in the visible list.

  // Push-driven refresh: the moment the user navigates a tab, force the
  // SW to drain its spool and reload the projection. Without this the
  // Inbox card / Current-tab card lag until the next 4 s poll + 60 s
  // SW drain alarm. Listens to chrome.tabs.onUpdated (URL or title
  // change) and debounces so the chatty status/title burst per
  // navigation coalesces into one refresh.
  useEffect(() => {
    const chromeApi = (
      globalThis as unknown as { chrome?: { tabs?: typeof chrome.tabs; runtime?: typeof chrome.runtime } }
    ).chrome;
    const tabsApi = chromeApi?.tabs;
    if (tabsApi === undefined || typeof tabsApi.onUpdated?.addListener !== 'function') return;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let refreshInFlight: Promise<void> | null = null;
    let refreshAgain = false;
    const delay = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    const forceDrainTimeline = (): Promise<void> =>
      new Promise((resolve) => {
        if (chromeApi?.runtime?.sendMessage === undefined) {
          resolve();
          return;
        }
        try {
          chromeApi.runtime.sendMessage({ type: 'sidetrack.timeline.force-drain' }, () => {
            // Reading lastError prevents Chrome from surfacing an
            // unchecked runtime error if the SW restarted mid-drain.
            const lastError = chromeApi?.runtime?.lastError;
            void lastError;
            resolve();
          });
        } catch {
          resolve();
        }
      });
    const runRefresh = (): void => {
      if (refreshInFlight !== null) {
        refreshAgain = true;
        return;
      }
      refreshInFlight = (async () => {
        do {
          refreshAgain = false;
          if (state.companionStatus !== 'connected') return;
          await forceDrainTimeline();
          await delay(150);
          await loadTabSessions({ background: true });
        } while (refreshAgain);
      })().finally(() => {
        refreshInFlight = null;
      });
    };
    const trigger = (): void => {
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        runRefresh();
      }, 250);
    };
    const onUpdated = (
      _tabId: number,
      changeInfo: { url?: string; status?: string; title?: string },
    ): void => {
      // Only refresh on URL change. Title / status updates flow through
      // the SW's drain + the panel's 4 s poll; firing here for every
      // title or status change made the Inbox look like it was
      // "constantly refreshing" — items moved around as the projection
      // bumped lastSeenAt.
      if (changeInfo.url !== undefined) {
        trigger();
      }
    };
    const onActivated = (): void => {
      trigger();
    };
    tabsApi.onUpdated.addListener(onUpdated);
    tabsApi.onActivated.addListener(onActivated);
    return () => {
      tabsApi.onUpdated.removeListener(onUpdated);
      tabsApi.onActivated.removeListener(onActivated);
      if (pending !== null) clearTimeout(pending);
    };
  }, [loadTabSessions, state.companionStatus]);

  useEffect(() => {
    void refresh()
      .catch((loadError: unknown) => {
        setError(
          loadError instanceof Error ? loadError.message : 'Could not load Sidetrack state.',
        );
      })
      .finally(() => {
        setStateLoaded(true);
      });
    void readSetupCompleted()
      .then(setSetupCompleted)
      .catch(() => {
        setSetupCompleted(false);
      });
    // Periodic state refresh — keeps the header status pills (vault +
    // companion) in sync with reality. Without this, companion going
    // down between user actions wasn't detected and the pill stayed
    // green until the next user action.
    const id = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 15_000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  // Recall lifecycle poll — only runs when companion is reachable
  // and we have a bridge key. Surfaces 'rebuilding' as an amber
  // pill in the header so the user knows why Déjà-vu is silent
  // immediately after companion startup or a model upgrade.
  useEffect(() => {
    if (state.companionStatus !== 'connected' || bridgeKey.trim().length === 0) {
      setRecallStatus(null);
      return undefined;
    }
    const portValue = state.settings.companion.port;
    let cancelled = false;
    const fetchRecall = async (): Promise<void> => {
      try {
        const response = await fetch(`http://127.0.0.1:${String(portValue)}/v1/system/health`, {
          headers: { 'x-bac-bridge-key': bridgeKey },
        });
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as {
          readonly data?: { readonly recall?: { readonly status?: unknown } };
        };
        const status = body.data?.recall?.status;
        if (
          status === 'missing' ||
          status === 'stale' ||
          status === 'empty' ||
          status === 'rebuilding' ||
          status === 'ready'
        ) {
          setRecallStatus(status);
        } else {
          setRecallStatus(null);
        }
      } catch {
        // Ignore — pill just stays at last known value until next tick.
      }
    };
    void fetchRecall();
    // Poll faster while rebuilding so the pill clears promptly.
    const intervalMs = recallStatus === 'rebuilding' ? 5_000 : 30_000;
    const handle = window.setInterval(() => {
      void fetchRecall();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [state.companionStatus, bridgeKey, state.settings.companion.port, recallStatus]);

  // Fetch /v1/status to discover the companion-managed Streamable
  // HTTP MCP server (port + auth key). Only present when the user
  // starts the companion with --mcp-port. Refreshed when companion
  // reconnects; a stale-but-non-zero value still works because the
  // auth key is persisted on disk and stable across companion
  // restarts.
  useEffect(() => {
    if (state.companionStatus !== 'connected' || bridgeKey.trim().length === 0) {
      setMcpInfo(null);
      setVaultRoot(null);
      return undefined;
    }
    const portValue = state.settings.companion.port;
    let cancelled = false;
    const fetchMcp = async (): Promise<void> => {
      try {
        const response = await fetch(`http://127.0.0.1:${String(portValue)}/v1/status`, {
          headers: { 'x-bac-bridge-key': bridgeKey },
        });
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as {
          readonly data?: {
            readonly vaultRoot?: unknown;
            readonly mcp?: {
              readonly url?: unknown;
              readonly port?: unknown;
              readonly authKey?: unknown;
              readonly health?: {
                readonly reachable?: unknown;
                readonly authAccepted?: unknown;
                readonly status?: unknown;
                readonly checkedAt?: unknown;
              };
            };
          };
        };
        const data = body.data;
        if (typeof data?.vaultRoot === 'string' && data.vaultRoot.length > 0) {
          setVaultRoot(data.vaultRoot);
        } else {
          setVaultRoot(null);
        }
        const mcp = data?.mcp;
        if (
          mcp !== undefined &&
          typeof mcp.url === 'string' &&
          typeof mcp.port === 'number' &&
          typeof mcp.authKey === 'string'
        ) {
          const healthRaw = mcp.health;
          let health:
            | {
                readonly reachable: boolean;
                readonly authAccepted: boolean;
                readonly status: 'ok' | 'auth_failed' | 'unreachable';
                readonly checkedAt: string;
              }
            | undefined;
          if (
            healthRaw !== undefined &&
            typeof healthRaw.reachable === 'boolean' &&
            typeof healthRaw.authAccepted === 'boolean' &&
            (healthRaw.status === 'ok' ||
              healthRaw.status === 'auth_failed' ||
              healthRaw.status === 'unreachable') &&
            typeof healthRaw.checkedAt === 'string'
          ) {
            health = {
              reachable: healthRaw.reachable,
              authAccepted: healthRaw.authAccepted,
              status: healthRaw.status,
              checkedAt: healthRaw.checkedAt,
            };
          }
          setMcpInfo({
            url: mcp.url,
            port: mcp.port,
            authKey: mcp.authKey,
            ...(health === undefined ? {} : { health }),
          });
        } else {
          setMcpInfo(null);
        }
      } catch {
        // Companion unreachable mid-poll — keep last known value;
        // CodingAttach gracefully falls back to the bridge-key URL.
      }
    };
    void fetchMcp();
    return () => {
      cancelled = true;
    };
  }, [state.companionStatus, bridgeKey, state.settings.companion.port]);

  useEffect(() => {
    const runtimeMessages = chrome.runtime.onMessage;
    let pendingRefresh: number | undefined;
    const listener = (message: unknown) => {
      if (isCaptureFeedbackMessage(message)) {
        setCaptureToastHost(message.host);
        return;
      }
      if (isWorkboardChangedMessage(message)) {
        // Debounce bursts of mutations into one refresh.
        if (pendingRefresh !== undefined) {
          window.clearTimeout(pendingRefresh);
        }
        pendingRefresh = window.setTimeout(() => {
          pendingRefresh = undefined;
          void refresh().catch(() => {
            // Silent: SystemBanners covers the broader companion/vault state.
          });
        }, 150);
      }
      if (isFocusThreadInSidePanelMessage(message)) {
        // Chat-side floating button OR Déjà-vu Jump → find the
        // matching thread by canonical URL, switch to whichever view
        // contains it (the workstream filter or All Threads), expand
        // the bucket if collapsed, then scroll the row into view and
        // flash the .focusing class.
        //
        // Reads from stateRef (synced via the effect below) instead
        // of using setState as a state-reader — React 18 will silently
        // skip the inner setFocusingThreadId update inside an updater
        // function that returns the same reference.
        //
        // The view-switch + bucket-expand are critical: ~10% of
        // threads in a typical vault sit outside the currently-
        // visible workstream filter, and without this branch the
        // setFocusingThreadId fires correctly but no DOM row exists
        // for the .focusing class to attach to → Jump silently looks
        // like a no-op.
        const targetCanonical = canonicalThreadUrl(message.threadUrl);
        void (async () => {
          let match = stateRef.current.threads.find(
            (thread) =>
              thread.threadUrl === message.threadUrl ||
              canonicalThreadUrl(thread.threadUrl) === targetCanonical,
          );
          // No local card for this thread (typical for recall hits
          // sourced from the companion vault that the local cache
          // never captured). Synthesize one inline from the message
          // payload so the user can still focus + click into it.
          if (match === undefined && message.bacId !== undefined) {
            const synthesized: TrackedThread = {
              bac_id: message.bacId,
              provider: detectProviderFromUrl(message.threadUrl),
              threadUrl: message.threadUrl,
              title: message.title ?? message.threadUrl,
              lastSeenAt: message.lastSeenAt ?? new Date().toISOString(),
              status: 'active',
              trackingMode: 'manual',
              tags: [],
            };
            setState((current) => ({
              ...current,
              threads: [synthesized, ...current.threads],
            }));
            // Also push into stateRef so the focus logic below sees it.
            stateRef.current = {
              ...stateRef.current,
              threads: [synthesized, ...stateRef.current.threads],
            };
            match = synthesized;
          }
          if (match === undefined) return;
          // If the matched thread isn't in the active workstream
          // view, fall back to "All threads" so the row renders.
          if (
            viewModeRef.current === 'workstream' &&
            match.primaryWorkstreamId !== currentWsIdRef.current
          ) {
            setViewMode('all');
          }
          await expandBucketForThreadRef.current?.(match);
          // Yield two animation frames so React commits the view +
          // bucket changes and the row's ref callback fires.
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          });
          const node = threadRowRefs.current.get(match.bac_id);
          node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setFocusingThreadId(match.bac_id);
          window.setTimeout(() => {
            setFocusingThreadId((prev) => (prev === match.bac_id ? null : prev));
          }, 1500);
        })();
      }
    };
    runtimeMessages.addListener(listener);
    return () => {
      runtimeMessages.removeListener(listener);
      if (pendingRefresh !== undefined) {
        window.clearTimeout(pendingRefresh);
      }
    };
  }, []);

  useEffect(() => {
    if (captureToastHost === null) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setCaptureToastHost(null);
    }, 3_000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [captureToastHost]);

  // Spec: if the current tab is tracked and lives in a workstream, focus
  // that workstream. If the current tab isn't tracked, leave the picker on
  // whatever the user last had selected — the panel doesn't follow random
  // tab switches into "not set".
  useEffect(() => {
    const currentWsForTab = state.currentTab?.primaryWorkstreamId;
    if (currentWsForTab === undefined) {
      return;
    }
    if (selectedWorkstream === currentWsForTab) {
      return;
    }
    setSelectedWorkstream(currentWsForTab);
    setExpandedWorkstreamId(null);
  }, [state.currentTab?.bac_id, state.currentTab?.primaryWorkstreamId, selectedWorkstream]);

  useEffect(() => {
    // Defensive auto-save: if the user typed a plausible bridge key + port in
    // the inline settings form but didn't click Connect, persist after a
    // short debounce so closing the panel doesn't lose the value. Skips when
    // the form is empty (initial state) or matches what's already persisted.
    if (!stateLoaded) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0 || bridgeKey.trim().length === 0) {
      return undefined;
    }
    if (
      bridgeKey === state.settings.companion.bridgeKey &&
      portNumber === state.settings.companion.port
    ) {
      return undefined;
    }
    const handle = window.setTimeout(() => {
      void runAction(() =>
        sendRequest({
          type: messageTypes.saveCompanionSettings,
          settings: { bridgeKey, port: portNumber },
        }),
      );
    }, 700);
    return () => {
      window.clearTimeout(handle);
    };
  }, [
    bridgeKey,
    port,
    stateLoaded,
    state.settings.companion.bridgeKey,
    state.settings.companion.port,
  ]);

  useEffect(() => {
    if (
      reviewThread === undefined ||
      bridgeKey.length === 0 ||
      reviewTurnsByUrl.has(reviewThread.threadUrl)
    ) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createTurnsClient({ port: portNumber, bridgeKey });
    const targetUrl = reviewThread.threadUrl;
    void client
      .recentForThread(targetUrl, { limit: 5, role: 'assistant' })
      .then((list) => {
        if (!cancelled) {
          setReviewTurnsByUrl((prev) => new Map(prev).set(targetUrl, list));
        }
      })
      .catch(() => {
        // Companion older than turns endpoint, or vault unreachable. Fall back
        // to thread-title synthetic span.
        if (!cancelled) {
          setReviewTurnsByUrl((prev) => new Map(prev).set(targetUrl, []));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reviewThread, bridgeKey, port, reviewTurnsByUrl]);

  // Mirror of the review-turns fetch for the packet composer. Loads the
  // most-recent N turns (both roles) so the composer can offer a
  // "Include last N turns" picker with live token preview.
  const [composeTurnsByUrl, setComposeTurnsByUrl] = useState<
    ReadonlyMap<string, readonly CapturedTurnRecord[]>
  >(() => new Map<string, readonly CapturedTurnRecord[]>());
  // Inline captured-turn history under a thread row. Title click
  // toggles which thread is expanded; the fetch pattern mirrors
  // composeTurnsByUrl above. We cache by threadUrl so collapsing
  // and re-expanding doesn't re-fetch.
  const [titleExpandedFor, setTitleExpandedFor] = useState<string | null>(null);
  const [inlineTurnsByUrl, setInlineTurnsByUrl] = useState<
    ReadonlyMap<string, readonly CapturedTurnRecord[]>
  >(() => new Map<string, readonly CapturedTurnRecord[]>());
  // Inline per-turn annotation composer state. Only one turn is open
  // for annotation at a time across the side panel — saving or
  // cancelling clears it. We key by `${threadUrl}::${ordinal}` so
  // re-collapsing and re-expanding the same thread doesn't drop a
  // half-typed note.
  const [annotateTurnKey, setAnnotateTurnKey] = useState<string | null>(null);
  const [annotateTurnDraft, setAnnotateTurnDraft] = useState('');
  const [annotateTurnAnchorText, setAnnotateTurnAnchorText] = useState('');
  const [annotateTurnStatus, setAnnotateTurnStatus] = useState<{
    readonly key: string;
    readonly tone: 'saving' | 'ok' | 'error';
    readonly text: string;
  } | null>(null);
  // Refs to thread row DOM elements, keyed by bac_id, so the
  // chat-side focus button can scrollIntoView + flash the matching
  // row. Map mutated via the ref callback below.
  const threadRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [focusingThreadId, setFocusingThreadId] = useState<string | null>(null);
  // Mirror of `state` for the message listener registered with empty
  // deps. Without this, the listener can only see state via a
  // setState((current) => ...) callback — and React 18 will skip
  // re-renders if the callback returns the same reference, suppressing
  // any nested state setters fired inside.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // Same trick for the bits the focus-thread handler needs to read
  // from outside the empty-deps useEffect closure: which view we're
  // on, which workstream is selected, and the helper that expands
  // the All-Threads bucket containing a given thread. Each is mirrored
  // through a ref so the listener always reads the latest values
  // even though the registration runs only once.
  const viewModeRef = useRef<'workstream' | 'all' | 'inbox' | 'connections'>('workstream');
  const currentWsIdRef = useRef<string | null>(null);
  const expandBucketForThreadRef = useRef<((thread: TrackedThread) => Promise<void>) | null>(null);
  const activeTabTrackedThread = useMemo(
    () =>
      state.activeTabUrl === undefined
        ? undefined
        : threads.find((thread) => thread.threadUrl === state.activeTabUrl),
    [state.activeTabUrl, threads],
  );
  const findIconPulsing =
    activeTabTrackedThread !== undefined &&
    focusingThreadId !== activeTabTrackedThread.bac_id &&
    state.activeTabUrl !== findPulseDismissedUrl;
  useEffect(() => {
    if (
      composeThread === undefined ||
      bridgeKey.length === 0 ||
      composeTurnsByUrl.has(composeThread.threadUrl)
    ) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createTurnsClient({ port: portNumber, bridgeKey });
    const targetUrl = composeThread.threadUrl;
    void client
      .recentForThread(targetUrl, { limit: 12 })
      .then((list) => {
        if (!cancelled) {
          setComposeTurnsByUrl((prev) => new Map(prev).set(targetUrl, list));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setComposeTurnsByUrl((prev) => new Map(prev).set(targetUrl, []));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [composeThread, bridgeKey, port, composeTurnsByUrl]);

  useEffect(() => {
    setComposeWorkstreamOverrideId(null);
  }, [composeThreadId]);

  useEffect(() => {
    if (
      composeThread === undefined ||
      bridgeKey.length === 0 ||
      composeScopeSuggestionsByThread.has(composeThread.bac_id)
    ) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createSuggestionsClient({ port: portNumber, bridgeKey });
    const targetThreadId = composeThread.bac_id;
    void client
      .forThread(targetThreadId, { limit: 3 })
      .then((list) => {
        if (cancelled) return;
        const suggestions = list.map((item): ScopeSuggestion => {
          const breakdown =
            item.breakdown === undefined
              ? []
              : Object.entries(item.breakdown)
                  .filter(([, value]) => Number.isFinite(value))
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([key, value]) => `${key} ${value.toFixed(2)}`);
          return {
            id: item.workstreamId,
            label: workstreamPath(item.workstreamId, state.workstreams),
            confidence: item.score,
            reason: breakdown.length > 0 ? breakdown.join(' · ') : 'suggested by companion',
          };
        });
        setComposeScopeSuggestionsByThread((prev) =>
          new Map(prev).set(targetThreadId, suggestions),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setComposeScopeSuggestionsByThread((prev) => new Map(prev).set(targetThreadId, []));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [composeThread, bridgeKey, port, composeScopeSuggestionsByThread, state.workstreams]);

  // Pre-fetch turns when the Send-to dropdown opens, so the smart-
  // default packet builder has full chat context cached when the
  // user picks a target. Reuses composeTurnsByUrl as the shared
  // cache. No-op when the user closes the dropdown without picking.
  useEffect(() => {
    if (sendToOpenFor === null || bridgeKey.length === 0) {
      return undefined;
    }
    const targetThread = state.threads.find((t) => t.bac_id === sendToOpenFor);
    if (targetThread === undefined) {
      return undefined;
    }
    const targetUrl = targetThread.threadUrl;
    if (composeTurnsByUrl.has(targetUrl)) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createTurnsClient({ port: portNumber, bridgeKey });
    // Ask for the server-side max (Math.min(limit ?? 5, 50) in
    // schemas.ts) so the smart-default packet ships the full thread
    // tail. The DispatchConfirm token-budget guard catches outliers.
    void client
      .recentForThread(targetUrl, { limit: 50 })
      .then((list) => {
        if (!cancelled) {
          setComposeTurnsByUrl((prev) => new Map(prev).set(targetUrl, list));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setComposeTurnsByUrl((prev) => new Map(prev).set(targetUrl, []));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sendToOpenFor, state.threads, bridgeKey, port, composeTurnsByUrl]);

  // Lazy-fetch the most recent turns for the inline-expanded thread.
  // Triggered when the user clicks the title; cached by threadUrl
  // so a second expansion of the same row is instant.
  useEffect(() => {
    if (titleExpandedFor === null || bridgeKey.length === 0) {
      return undefined;
    }
    const expandedThread = state.threads.find((t) => t.bac_id === titleExpandedFor);
    if (expandedThread === undefined) {
      return undefined;
    }
    const targetUrl = expandedThread.threadUrl;
    if (inlineTurnsByUrl.has(targetUrl)) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createTurnsClient({ port: portNumber, bridgeKey });
    void client
      .recentForThread(targetUrl, { limit: 5 })
      .then((list) => {
        if (!cancelled) {
          setInlineTurnsByUrl((prev) => new Map(prev).set(targetUrl, list));
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Cache an empty result so we don't keep retrying on a
          // companion that's down. The user can collapse + re-
          // expand to retry.
          setInlineTurnsByUrl((prev) => new Map(prev).set(targetUrl, []));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [titleExpandedFor, state.threads, bridgeKey, port, inlineTurnsByUrl]);

  useEffect(() => {
    if (state.companionStatus !== 'connected' || bridgeKey.length === 0) {
      return undefined;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      return undefined;
    }
    let cancelled = false;
    const client = createSettingsClient({ port: portNumber, bridgeKey });
    client
      .read()
      .then((document) => {
        if (!cancelled) {
          setSettings(document);
        }
      })
      .catch(() => {
        // Companion may not yet have the settings endpoint; SystemBanners
        // already covers companion/vault state.
      });
    return () => {
      cancelled = true;
    };
  }, [state.companionStatus, bridgeKey, port]);

  const runAction = async (action: () => Promise<WorkboardState>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      setError(next.lastError ?? null);
      setBridgeKey(next.settings.companion.bridgeKey);
      setPort(String(next.settings.companion.port));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Sidetrack action failed.');
    } finally {
      setBusy(false);
    }
  };

  const completeSetup = async (saveCompanionFirst: boolean): Promise<void> => {
    if (saveCompanionFirst) {
      const portNumber = Number(port);
      if (!Number.isFinite(portNumber) || portNumber <= 0) {
        const message = 'Invalid companion port.';
        setWizardConnectionError(message);
        throw new Error(message);
      }
      const bridgeKeyFailure = validateBridgeKeyCandidate(bridgeKey);
      if (bridgeKeyFailure !== null) {
        const message = bridgeKeyValidationCopy[bridgeKeyFailure];
        setWizardConnectionError(message);
        throw new Error(message);
      }
      setWizardConnectionError(null);
      setBusy(true);
      setError(null);
      try {
        const next = await sendRequest({
          type: messageTypes.saveCompanionSettings,
          settings: { bridgeKey: bridgeKey.trim(), port: portNumber },
        });
        setState(next);
        setError(next.lastError ?? null);
        setBridgeKey(next.settings.companion.bridgeKey);
        setPort(String(next.settings.companion.port));
      } catch (setupError) {
        const message =
          setupError instanceof Error ? setupError.message : 'Could not connect companion.';
        setWizardConnectionError(message);
        setError(message);
        throw setupError;
      } finally {
        setBusy(false);
      }
    }
    await writeSetupCompleted();
    setSetupCompleted(true);
    setWizardOpen(false);
  };

  const recordOrganizedItemFeedback = async (
    payload: Omit<UserOrganizedItemPayload, 'payloadVersion'>,
  ): Promise<void> => {
    const event: FeedbackEventEnvelope = {
      type: USER_ORGANIZED_ITEM,
      payload: { payloadVersion: 1, ...payload },
    };
    try {
      const response = (await chrome.runtime.sendMessage({
        type: messageTypes.postConnectionsFeedbackEvent,
        event,
        clientEventId: feedbackClientEventId(event),
      })) as unknown;
      if (isRecord(response) && response.ok === false) {
        console.warn(
          '[feedback] user.organized.item failed:',
          typeof response.error === 'string' ? response.error : 'unknown error',
        );
      }
    } catch (error) {
      console.warn('[feedback] user.organized.item failed:', error);
    }
  };

  const moveThreadToWorkstream = async (
    threadId: string,
    workstreamId: string,
  ): Promise<WorkboardState> => {
    const thread = state.threads.find((candidate) => candidate.bac_id === threadId);
    const next = await sendRequest({
      type: messageTypes.moveThread,
      threadId,
      workstreamId,
    });
    await recordOrganizedItemFeedback({
      itemKind: 'thread',
      itemId: threadId,
      action: 'move',
      ...(thread?.primaryWorkstreamId === undefined
        ? {}
        : { fromContainer: thread.primaryWorkstreamId }),
      toContainer: workstreamId,
    });
    return next;
  };

  const attributeTabSessionToWorkstream = async (
    tabSessionId: string,
    workstreamId: string | null,
  ): Promise<WorkboardState> => {
    if (port.length === 0 || bridgeKey.length === 0) {
      throw new Error('Companion is not configured.');
    }
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/tabsessions/${encodeURIComponent(tabSessionId)}/attribute`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `tabsession-${tabSessionId}-${workstreamId ?? 'inbox'}-${String(
            Date.now(),
          )}`,
          'x-bac-bridge-key': bridgeKey,
        },
        body: JSON.stringify({ workstreamId }),
      },
    );
    if (!response.ok) {
      throw new Error(`Tab-session attribution failed (${String(response.status)}).`);
    }
    // User mutation — refetch resolver suggestions (cache is stale).
    await loadTabSessions({ forceRefetchSuggestions: true });
    return await sendRequest({ type: messageTypes.getWorkboardState });
  };

  // Per-canonical-URL attribution (Phase B). The Inbox + Current-tab
  // card now route through here — they attribute the PAGE, not the tab.
  const attributeUrlToWorkstream = async (
    canonicalUrl: string,
    workstreamId: string | null,
  ): Promise<WorkboardState> => {
    if (port.length === 0 || bridgeKey.length === 0) {
      throw new Error('Companion is not configured.');
    }
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/visits/${encodeURIComponent(canonicalUrl)}/attribute`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `url-${canonicalUrl}-${workstreamId ?? 'inbox'}-${String(Date.now())}`,
          'x-bac-bridge-key': bridgeKey,
        },
        body: JSON.stringify({ workstreamId }),
      },
    );
    if (!response.ok) {
      throw new Error(`URL attribution failed (${String(response.status)}).`);
    }
    // User mutation — refetch resolver suggestions (cache is stale).
    await loadTabSessions({ forceRefetchSuggestions: true });
    return await sendRequest({ type: messageTypes.getWorkboardState });
  };

  const handleTabSessionAttribute = (tabSessionId: string, workstreamId: string | null) => {
    void runAction(() => attributeTabSessionToWorkstream(tabSessionId, workstreamId));
  };

  // High-confidence URL resolver auto-apply. Companion gate is
  // `SIDETRACK_URL_RESOLVER_AUTO_APPLY=1`; when it's off the POST
  // returns `skipped-disabled` and the projection is unchanged. We
  // still attempt the call so that flipping the env on takes effect
  // without an extension reload. Bounded by:
  //   1. Only URLs with `decision.action === 'auto-apply'`.
  //   2. Only URLs with no existing user-asserted attribution
  //      (the companion enforces this too as a safety check).
  //   3. Track in-flight per-URL to avoid spamming the same URL.
  const triggerUrlAutoApply = useCallback(
    async (canonicalUrl: string): Promise<void> => {
      if (port.length === 0 || bridgeKey.length === 0) return;
      if (urlAutoApplyInFlightRef.current.has(canonicalUrl)) return;
      urlAutoApplyInFlightRef.current.add(canonicalUrl);
      try {
        await fetch(
          `http://127.0.0.1:${port}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `url-auto-apply-${canonicalUrl}-${String(Date.now())}`,
              'x-bac-bridge-key': bridgeKey,
            },
            body: JSON.stringify({ dryRun: false, policyMode: 'balanced' }),
          },
        );
        // Success or skipped-disabled — re-fetch suggestions so the
        // panel reflects the applied attribution (or stays as-is when
        // disabled).
        await loadTabSessions({ background: true, forceRefetchSuggestions: true });
      } catch {
        // Silent — auto-apply is best-effort.
      } finally {
        urlAutoApplyInFlightRef.current.delete(canonicalUrl);
      }
    },
    [bridgeKey, port, loadTabSessions],
  );

  // Trigger auto-apply when fresh suggestions arrive. Effect debounces
  // implicitly by depending on `urlSuggestions` — runs once per fetch.
  useEffect(() => {
    if (urlProjection === null) return;
    for (const [canonicalUrl, result] of Object.entries(urlSuggestions)) {
      if (result.decision.action !== 'auto-apply') continue;
      const existing = urlProjection.byCanonicalUrl[canonicalUrl]?.currentAttribution;
      if (existing !== undefined && existing.source !== 'inferred') continue;
      void triggerUrlAutoApply(canonicalUrl);
    }
  }, [urlSuggestions, urlProjection, triggerUrlAutoApply]);

  // Wrapper used by the Inbox + Current-tab card after the Phase B
  // switchover. The card's record is a synthesized TabSessionRecord
  // whose `tabSessionId` field carries the canonical URL — see
  // `tabSessionRecordFromUrl` in this file. This dispatches to the
  // per-URL attribution endpoint.
  const handleUrlAttribute = (canonicalUrl: string, workstreamId: string | null) => {
    void runAction(() => attributeUrlToWorkstream(canonicalUrl, workstreamId));
  };

  // Stage 5 polish — explicit "ignore this URL" action. Distinct from
  // workstreamId:null (which is "meaningful one-off"). Writes a
  // urls.ignored event so the URL is hidden from Inbox + skipped by
  // auto-apply. Reversible: re-organizing into a workstream clears
  // the ignore in the projection mutator.
  const ignoreUrl = async (
    canonicalUrl: string,
    reason: 'noise' | 'duplicate' | 'private' = 'noise',
  ): Promise<WorkboardState> => {
    if (port.length === 0 || bridgeKey.length === 0) {
      throw new Error('Companion is not configured.');
    }
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/visits/${encodeURIComponent(canonicalUrl)}/ignore`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `url-ignore-${canonicalUrl}-${reason}-${String(Date.now())}`,
          'x-bac-bridge-key': bridgeKey,
        },
        body: JSON.stringify({ reason }),
      },
    );
    if (!response.ok) {
      throw new Error(`URL ignore failed (${String(response.status)}).`);
    }
    await loadTabSessions({ forceRefetchSuggestions: true });
    return await sendRequest({ type: messageTypes.getWorkboardState });
  };

  const handleUrlIgnore = (
    canonicalUrl: string,
    reason: 'noise' | 'duplicate' | 'private' = 'noise',
  ) => {
    void runAction(() => ignoreUrl(canonicalUrl, reason));
  };

  // Stage 5 polish — "Dump panel state" button handler. Collects the
  // panel's visible-to-debugging fields (focused tab, urlInbox slice,
  // suggestions, view mode, companion status) and POSTs to the
  // companion's /v1/debug/dump endpoint, which writes
  // `${vaultRoot}/_BAC/debug-dumps/latest.json` (plus a timestamped
  // copy). Falls back to clipboard if the companion is unreachable so
  // the user always gets a usable artifact.
  const handleDumpPanelState = () => {
    setDumpStatus({ kind: 'dumping' });
    const payload = {
      viewMode,
      companionStatus: state.companionStatus,
      focused: {
        canonicalUrl: focusedUrlRecord?.canonicalUrl,
        record: focusedUrlRecord,
        suggestion: focusedTabSuggestion,
      },
      urlInbox: {
        total: urlInbox.total,
        items: urlInbox.items.slice(0, 20),
      },
      urlSuggestions: Object.fromEntries(
        Object.entries(urlSuggestions).slice(0, 50),
      ),
      workstreams: state.workstreams.map((w) => ({
        bac_id: w.bac_id,
        title: w.title,
        parentId: w.parentId ?? null,
        privacy: w.privacy,
      })),
      threadsLight: state.threads.map((t) => ({
        bac_id: t.bac_id,
        title: t.title,
        provider: t.provider,
        primaryWorkstreamId: t.primaryWorkstreamId ?? null,
        status: t.status,
        lastSeenAt: t.lastSeenAt,
      })),
      tabSessionMoveId,
      activeTabUrl: state.activeTabUrl ?? null,
      activeTabSessionId: state.activeTabSessionId ?? null,
      capturedAt: new Date().toISOString(),
    };
    void (async () => {
      try {
        if (port.length === 0 || bridgeKey.length === 0) {
          throw new Error('Companion not configured');
        }
        const response = await fetch(`http://127.0.0.1:${port}/v1/debug/dump`, {
          method: 'POST',
          headers: {
            'x-bac-bridge-key': bridgeKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        const body = (await response.json()) as { readonly data?: { readonly path?: string } };
        const path = body.data?.path;
        if (typeof path !== 'string' || path.length === 0) {
          throw new Error('No path returned');
        }
        setDumpStatus({ kind: 'dumped', path });
      } catch (error) {
        // Clipboard fallback so the user always walks away with the dump.
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          setDumpStatus({
            kind: 'error',
            message: `Companion unreachable — copied to clipboard instead (${
              error instanceof Error ? error.message : String(error)
            })`,
          });
        } catch (clipError) {
          setDumpStatus({
            kind: 'error',
            message: `Dump failed: ${error instanceof Error ? error.message : String(error)} / clipboard: ${
              clipError instanceof Error ? clipError.message : String(clipError)
            }`,
          });
        }
      }
    })();
  };

  const handleMoveTarget = (target: WorkstreamOption | { readonly create: string }) => {
    const threadId = moveThreadId;
    if (threadId === null) {
      return;
    }

    void runAction(async () => {
      if ('create' in target) {
        const afterCreate = await sendRequest({
          type: messageTypes.createWorkstream,
          workstream: { title: target.create, privacy: 'shared' },
        });
        const created = afterCreate.workstreams.find(
          (workstream) => workstream.title === target.create && workstream.parentId === undefined,
        );
        if (created === undefined) {
          setMoveThreadId(null);
          return afterCreate;
        }
        const afterMove = await moveThreadToWorkstream(threadId, created.bac_id);
        setMoveThreadId(null);
        return afterMove;
      }

      const next = await moveThreadToWorkstream(threadId, target.bac_id);
      setMoveThreadId(null);
      return next;
    });
  };

  const handleThreadDrop = (workstreamId: string) => {
    const threadId = draggingThreadId;
    setDropWorkstreamId(null);
    setDraggingThreadId(null);
    if (threadId === null) {
      return;
    }
    const thread = state.threads.find((candidate) => candidate.bac_id === threadId);
    if (thread?.primaryWorkstreamId === workstreamId) {
      return;
    }
    void runAction(() => moveThreadToWorkstream(threadId, workstreamId));
  };

  const handleWorkstreamDrop = (event: DragEvent<HTMLElement>, workstreamId: string) => {
    if (draggingThreadId !== null) {
      handleThreadDrop(workstreamId);
      return;
    }
    const tabSessionId = draggingTabSessionId ?? tabSessionIdFromDragEvent(event);
    setDropWorkstreamId(null);
    setDraggingTabSessionId(null);
    if (tabSessionId === null) {
      return;
    }
    void runAction(() => attributeTabSessionToWorkstream(tabSessionId, workstreamId));
  };

  const allowThreadDrop = (event: DragEvent<HTMLElement>, workstreamId: string) => {
    const types = Array.from(event.dataTransfer.types ?? []);
    if (
      draggingThreadId === null &&
      draggingTabSessionId === null &&
      !types.includes(TAB_SESSION_DRAG_MIME) &&
      !types.includes('text/plain')
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropWorkstreamId(workstreamId);
  };

  const restoreThread = (threadId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.restoreThreadTab,
        threadId,
      }),
    );
  };

  // Focus (or open) the live browser tab for a tab-session card. The
  // session record carries the latest canonical URL we observed for it;
  // we mirror openTabForThread's policy of "find existing tab → focus,
  // else open new".
  const openTabForSession = useCallback((record: TabSessionRecord): void => {
    const url = record.latestUrl;
    if (typeof url !== 'string' || url.length === 0) return;
    void (async () => {
      try {
        const tabs = await chrome.tabs.query({ url });
        const live = tabs.find((t) => typeof t.id === 'number');
        if (live !== undefined && typeof live.id === 'number') {
          await chrome.tabs.update(live.id, { active: true });
          if (live.windowId !== undefined) {
            await chrome.windows.update(live.windowId, { focused: true });
          }
          return;
        }
      } catch {
        // host_permission may be missing for arbitrary hosts; fall through.
      }
      await chrome.tabs.create({ url });
    })();
  }, []);

  // Switch to the thread's existing tab if still alive, otherwise open a new
  // one at the same URL.
  // (1) Try chrome.tabs.update(tabId) using the captured tabId.
  // (2) If that fails (tab was closed and re-opened, so tabId is stale),
  //     query all tabs matching threadUrl and focus the first one.
  // (3) Otherwise create a new tab at threadUrl.
  const openTabForThread = (thread: TrackedThread) => {
    const tabId = thread.tabSnapshot?.tabId;
    const focusByQuery = async () => {
      try {
        const tabs = await chrome.tabs.query({ url: thread.threadUrl });
        const live = tabs.find((t) => typeof t.id === 'number');
        if (live !== undefined && typeof live.id === 'number') {
          await chrome.tabs.update(live.id, { active: true });
          await chrome.windows.update(live.windowId, { focused: true });
          return true;
        }
      } catch {
        // chrome.tabs.query may fail without host_permissions on the URL —
        // fall through to create.
      }
      return false;
    };
    void (async () => {
      if (typeof tabId === 'number') {
        try {
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (tab?.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          return;
        } catch {
          // tabId is stale — fall through.
        }
      }
      const focused = await focusByQuery();
      if (focused) {
        return;
      }
      await chrome.tabs.create({ url: thread.threadUrl });
    })();
  };

  // "Find" icon in the side-panel header. Reads the active tab in
  // the focused window, finds a tracked thread whose threadUrl
  // matches, scrolls + flashes the row using the same
  // threadRowRefs / focusingThreadId machinery we ship for the
  // background-broadcast focus path. If the active tab isn't a
  // tracked thread, surface a banner.
  const scrollAndFlashThread = (threadId: string, delayMs = 0): void => {
    window.setTimeout(() => {
      const node = threadRowRefs.current.get(threadId);
      node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFocusingThreadId(threadId);
      window.setTimeout(() => {
        setFocusingThreadId((prev) => (prev === threadId ? null : prev));
      }, 1500);
    }, delayMs);
  };

  const expandBucketForThread = async (thread: TrackedThread): Promise<void> => {
    const bucket = classifyAllThread(thread, state.reminders);
    if (!state.collapsedBuckets.includes(bucket)) {
      return;
    }
    const collapsedBuckets = ALL_THREAD_BUCKET_ORDER.filter(
      (candidate) => candidate !== bucket && state.collapsedBuckets.includes(candidate),
    );
    const next = await sendRequest({
      type: messageTypes.setCollapsedBuckets,
      collapsedBuckets,
    });
    setState(next);
  };
  // Mirror the helper into a ref so the focus-thread handler can
  // call it without re-binding when state changes (the handler's
  // useEffect has empty deps).
  useEffect(() => {
    expandBucketForThreadRef.current = expandBucketForThread;
  });

  const focusThreadInWorkstream = (thread: TrackedThread): void => {
    setViewMode('workstream');
    setCurrentWs(thread.primaryWorkstreamId ?? null);
    scrollAndFlashThread(thread.bac_id, 120);
  };

  const findActiveTabThread = (): void => {
    void (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const url = tabs[0]?.url;
        if (url === undefined) {
          setError('Could not read the active tab. Try focusing a chat tab first.');
          return;
        }
        const match = state.threads.find((t) => t.threadUrl === url);
        if (match === undefined) {
          setError(
            'The active tab is not a tracked thread. Open one of your tracked chats and try again.',
          );
          return;
        }
        setFindPulseDismissedUrl(url);
        if (viewMode === 'workstream' && match.primaryWorkstreamId !== currentWsId) {
          setViewMode('all');
        }
        await expandBucketForThread(match);
        scrollAndFlashThread(match.bac_id, 140);
      } catch (lookupError) {
        setError(
          lookupError instanceof Error
            ? lookupError.message
            : 'Could not find a matching thread row.',
        );
      }
    })();
  };

  const runThreadSearch = (): void => {
    const q = threadSearchQuery.trim();
    if (q.length === 0) {
      setThreadSearchResults([]);
      setThreadSearchState('idle');
      setThreadSearchError(null);
      return;
    }
    setThreadSearchState('loading');
    setThreadSearchError(null);
    void (async () => {
      try {
        const response = (await chrome.runtime.sendMessage({
          type: messageTypes.recallQuery,
          q,
          limit: 10,
        })) as unknown;
        if (!isRecallQueryResponse(response)) {
          throw new Error('Search returned an invalid response.');
        }
        if (!response.ok) {
          throw new Error(response.error ?? 'Thread search failed.');
        }
        setThreadSearchResults(response.items.filter(isThreadSearchResult));
        setThreadSearchState('idle');
      } catch (searchError) {
        setThreadSearchResults([]);
        setThreadSearchState('error');
        setThreadSearchError(
          searchError instanceof Error ? searchError.message : 'Thread search failed.',
        );
      }
    })();
  };

  const findThreadForSearchResult = (result: ThreadSearchResult): TrackedThread | undefined => {
    const byId = state.threads.find((thread) => thread.bac_id === result.threadId);
    if (byId !== undefined) return byId;
    if (result.threadUrl === undefined || result.threadUrl.length === 0) return undefined;
    const canonical = canonicalThreadUrl(result.threadUrl);
    return state.threads.find((thread) => canonicalThreadUrl(thread.threadUrl) === canonical);
  };

  const focusThreadSearchResult = (result: ThreadSearchResult): void => {
    void (async () => {
      const match = findThreadForSearchResult(result);
      if (match === undefined) {
        if (result.threadUrl !== undefined && result.threadUrl.length > 0) {
          await chrome.tabs.create({ url: result.threadUrl });
          return;
        }
        setError('Search result is not in the current thread list.');
        return;
      }
      setThreadSearchOpen(false);
      if (viewMode === 'workstream' && match.primaryWorkstreamId !== currentWsId) {
        setViewMode('all');
      }
      await expandBucketForThread(match);
      scrollAndFlashThread(match.bac_id, 140);
    })();
  };

  const openThreadSearchResult = (result: ThreadSearchResult): void => {
    const match = findThreadForSearchResult(result);
    if (match !== undefined) {
      openTabForThread(match);
      return;
    }
    if (result.threadUrl !== undefined && result.threadUrl.length > 0) {
      void chrome.tabs.create({ url: result.threadUrl });
    }
  };

  // ─── Send-to dropdown smart-default packet builder ─────────────
  // Bypass the composer for the 70% case: pick a target → build a
  // packet with smart defaults and route to DispatchConfirm. Map
  // each SendToTarget to (kind, ComposedPacket.target). The body
  // is rendered from the existing PacketComposer template helpers
  // (research / coding / notebook) so output matches what the
  // composer would produce.
  const SEND_TO_INTENT: Record<
    SendToTarget,
    {
      readonly kind: ComposedPacket['kind'];
      readonly target: ComposedPacket['target'];
    }
  > = {
    claude: { kind: 'research_packet', target: 'claude' },
    gpt_pro: { kind: 'research_packet', target: 'gpt_pro' },
    gemini: { kind: 'research_packet', target: 'gemini' },
    claude_code: { kind: 'coding_agent_packet', target: 'claude_code' },
    codex: { kind: 'coding_agent_packet', target: 'codex' },
    cursor: { kind: 'coding_agent_packet', target: 'cursor' },
    markdown: { kind: 'notebook_export', target: 'markdown' },
    notebook: { kind: 'notebook_export', target: 'notebook' },
  };

  const buildSmartDefaultPacket = (thread: TrackedThread, target: SendToTarget): ComposedPacket => {
    const intent = SEND_TO_INTENT[target];
    const turns = composeTurnsByUrl.get(thread.threadUrl) ?? [];
    const turnsMd =
      turns.length === 0
        ? '_No turns captured yet._'
        : turns
            .map((t) => {
              const role = t.role === 'assistant' ? '### Assistant' : '### User';
              // Ship the full turn body. The DispatchConfirm modal's
              // token-budget chip warns the user when the packet
              // exceeds the target model's context window; it is the
              // user's call to edit or proceed. Per-turn truncation
              // here used to silently drop long replies before that
              // guard existed.
              return `${role}\n${t.text}`;
            })
            .join('\n\n');
    const provider = providerLabel(thread.provider);
    const head = `## Source\n${provider} · ${thread.threadUrl}`;
    let body: string;
    if (intent.kind === 'research_packet') {
      // Default = raw forward. The user asked for a "just here's the
      // context from another conversation" packet by default; the
      // structured Critique/Compare/Drill-deeper templates are
      // available in the Customize composer if they want them. Brief
      // title + source + the captured turns.
      body = `# Context from another conversation: ${thread.title}\n\n${head}\n\n${turnsMd}`;
    } else if (intent.kind === 'coding_agent_packet') {
      // MCP-aware handoff. The agent connects to the local MCP
      // endpoint and pulls thread/dispatch/recall context over the
      // tool channel — nothing else is in the prompt. Bridge key
      // is interpolated inline because clipboard is local-only and
      // the companion only listens on 127.0.0.1.
      const keyStr = bridgeKey.length > 0 ? bridgeKey : '<run the companion to generate>';
      // Compact handoff (~225 chars): title + endpoint + thread_id
      // + a one-line breadcrumb pointing at the discovery path. The
      // verbose explanatory paragraph from the prior packet was
      // front-loading a contract that capable agents auto-discover
      // via tools/list. Side-by-side review:
      // packages/sidetrack-mcp/src/e2e/handoff-prompt-trim-review.md.
      body = `# Coding handoff: ${thread.title}\nsidetrack_mcp: http://127.0.0.1:8721/mcp\nsidetrack_mcp_auth: Bearer ${keyStr}\nsidetrack_thread_id: ${thread.bac_id}\n(connect → readResource sidetrack://thread/<id>/markdown)\n\n## User's ask\n…`;
    } else {
      const today = new Date().toISOString().slice(0, 10);
      body = `---\ntitle: ${thread.title}\ncreated: ${today}\nsource: ${thread.threadUrl}\nprovider: ${provider}\n---\n\n# ${thread.title}\n\n${turnsMd}`;
    }
    return {
      kind: intent.kind,
      template: intent.kind === 'research_packet' ? 'critique' : null,
      target: intent.target,
      title: thread.title,
      body,
      scopeLabel: thread.title,
      sourceThreadId: thread.bac_id,
      tokenEstimate: Math.ceil(body.length / 4),
      redactedItems: [],
      ...(thread.primaryWorkstreamId === undefined
        ? {}
        : { workstreamId: thread.primaryWorkstreamId }),
    };
  };

  const handleSendToPick = (thread: TrackedThread, target: SendToTarget): void => {
    setSendToOpenFor(null);
    const packet = buildSmartDefaultPacket(thread, target);
    // Cache the user's last target so the dropdown's "Recent" row
    // pre-selects it next time.
    void sendRequest({
      type: messageTypes.cacheLastDispatchTarget,
      threadId: thread.bac_id,
      target,
    }).catch(() => undefined);
    if (target === 'markdown' || target === 'notebook') {
      // Export targets bypass DispatchConfirm — write the file
      // immediately and record the dispatch event so it shows up in
      // Recent Dispatches.
      const safeTitle = thread.title.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 80);
      downloadAsFile(`${safeTitle || 'sidetrack-packet'}.md`, packet.body);
      setError(`Downloaded ${safeTitle || 'sidetrack-packet'}.md.`);
      setPendingDispatch(packet);
      return;
    }
    // AI providers + coding agents → confirm modal, then dispatch.
    setPendingDispatch(packet);
  };

  const submitQueueFollowUp = (threadId: string) => {
    const text = queueDraft.trim();
    if (text.length === 0) {
      return;
    }
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.queueFollowUp,
        item: { text, scope: 'thread', targetId: threadId },
      });
      // Keep the queue expanded and the compose input focused so the
      // user can stack the next follow-up without re-clicking. Only
      // the draft text is cleared.
      setQueueDraft('');
      setQueueExpandFor(threadId);
      setQueueComposeAutoFocus(threadId);
      return next;
    });
  };

  const dismissQueueItem = (queueItemId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateQueueItem,
        queueItemId,
        update: { status: 'dismissed' },
      }),
    );
  };

  const reorderQueueItem = (
    pendingItems: readonly { readonly bac_id: string }[],
    sourceId: string,
    targetId: string | null,
  ) => {
    // targetId === null => drop at the tail. Otherwise insert the
    // dragged item before targetId. Active items (mid-send) keep
    // their existing position; the drain ships them next regardless
    // of where reorder happened.
    const ids = pendingItems.map((i) => i.bac_id).filter((id) => id !== sourceId);
    let nextOrder: string[];
    if (targetId === null) {
      nextOrder = [...ids, sourceId];
    } else {
      const targetIndex = ids.indexOf(targetId);
      if (targetIndex < 0) {
        nextOrder = [...ids, sourceId];
      } else {
        nextOrder = [...ids.slice(0, targetIndex), sourceId, ...ids.slice(targetIndex)];
      }
    }
    if (nextOrder.length === 0) {
      return;
    }
    void runAction(() =>
      sendRequest({
        type: messageTypes.reorderQueueItems,
        queueItemIds: nextOrder,
      }),
    );
  };

  const submitNote = () => {
    const text = noteDraft.trim();
    if (text.length === 0) {
      return;
    }
    if (noteEditId !== null) {
      const editId = noteEditId;
      void runAction(async () => {
        const next = await sendRequest({
          type: messageTypes.updateCaptureNote,
          noteId: editId,
          update: { text },
        });
        setNoteDraft('');
        setNoteEditId(null);
        setNoteComposeOpen(false);
        return next;
      });
      return;
    }
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.createCaptureNote,
        note: {
          text,
          kind: 'manual',
          ...(currentWsId === null ? {} : { workstreamId: currentWsId }),
        },
      });
      setNoteDraft('');
      setNoteComposeOpen(false);
      return next;
    });
  };

  const deleteNote = (noteId: string) => {
    void runAction(() => sendRequest({ type: messageTypes.deleteCaptureNote, noteId }));
  };

  const beginEditNote = (noteId: string, text: string) => {
    setNoteComposeOpen(true);
    setNoteEditId(noteId);
    setNoteDraft(text);
  };

  const submitThreadNote = (threadId: string) => {
    const text = threadNoteDraft.trim();
    if (text.length === 0) {
      return;
    }
    const targetThread = state.threads.find((t) => t.bac_id === threadId);
    void runAction(async () => {
      const next = await sendRequest({
        type: messageTypes.createCaptureNote,
        note: {
          text,
          kind: 'manual',
          threadId,
          ...(targetThread?.primaryWorkstreamId === undefined
            ? {}
            : { workstreamId: targetThread.primaryWorkstreamId }),
        },
      });
      setThreadNoteDraft('');
      setThreadNoteFor(null);
      // Make sure the strip stays expanded after add so the user sees
      // the new entry land.
      setThreadHistoryOpen((prev) => {
        if (prev.has(threadId)) {
          return prev;
        }
        const nextSet = new Set(prev);
        nextSet.add(threadId);
        return nextSet;
      });
      return next;
    });
  };

  const submitTurnAnnotation = (
    threadUrl: string,
    turn: CapturedTurnRecord,
    key: string,
    publishToChat = false,
  ): void => {
    const note = annotateTurnDraft.trim();
    const anchorText = annotateTurnAnchorText.trim();
    if (note.length === 0) {
      return;
    }
    setAnnotateTurnStatus({
      key,
      tone: 'saving',
      text: publishToChat
        ? 'placing marker and publishing to chat…'
        : 'placing marker on the live page…',
    });
    void (async () => {
      try {
        const capturedAt = new Date().toISOString();
        const response: AnnotateTurnResponse = await chrome.runtime.sendMessage({
          type: messageTypes.annotateTurn,
          threadUrl,
          turnText: turn.text,
          ...(turn.sourceSelector === undefined ? {} : { sourceSelector: turn.sourceSelector }),
          ...(anchorText.length === 0 ? {} : { anchorText }),
          note,
          capturedAt,
        });
        if (!response.ok) {
          setAnnotateTurnStatus({
            key,
            tone: 'error',
            text: response.error ?? 'Could not place the marker.',
          });
          return;
        }
        if (publishToChat) {
          const publishResponse: PublishAnnotationToChatResponse = await chrome.runtime.sendMessage(
            {
              type: messageTypes.publishAnnotationToChat,
              threadUrl,
              turnText: turn.text,
              turnRole: turn.role,
              ...(anchorText.length === 0 ? {} : { anchorText }),
              note,
              capturedAt,
            },
          );
          if (!publishResponse.ok) {
            setAnnotateTurnStatus({
              key,
              tone: 'error',
              text: `marker placed; publish failed: ${
                publishResponse.error ?? 'Could not publish annotation to chat.'
              }`,
            });
            return;
          }
        }
        setAnnotateTurnDraft('');
        setAnnotateTurnAnchorText('');
        setAnnotateTurnKey(null);
        // Surface a soft success line so the user can confirm the
        // marker landed even though the side panel doesn't show the
        // live page. The fallback message ("kept in this session
        // only") flows through here when companion persistence fails
        // but the in-page marker still mounted.
        setAnnotateTurnStatus({
          key,
          tone: response.error === undefined || publishToChat ? 'ok' : 'error',
          text:
            response.error === undefined
              ? publishToChat
                ? 'marker placed and published to chat'
                : 'marker placed on live page'
              : publishToChat
                ? `marker placed and published to chat; ${response.error}`
                : response.error,
        });
        if (!publishToChat) {
          window.setTimeout(() => {
            setAnnotateTurnStatus((current) =>
              current !== null && current.key === key ? null : current,
            );
          }, 4_000);
        }
      } catch (error) {
        setAnnotateTurnStatus({
          key,
          tone: 'error',
          text: error instanceof Error ? error.message : 'annotateTurn failed.',
        });
      }
    })();
  };

  const toggleThreadHistory = (threadId: string) => {
    setThreadHistoryOpen((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(threadId)) {
        nextSet.delete(threadId);
      } else {
        nextSet.add(threadId);
      }
      return nextSet;
    });
  };

  const copyQueueItemText = (queueItemId: string, text: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        setQueueCopiedId(queueItemId);
        setTimeout(() => {
          setQueueCopiedId((current) => (current === queueItemId ? null : current));
        }, 1200);
      } catch {
        // Clipboard API can be unavailable in some contexts; fail quietly.
      }
    })();
  };

  const updateTracking = (threadId: string, trackingMode: TrackedThread['trackingMode']) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.updateThreadTracking,
        threadId,
        trackingMode,
      }),
    );
  };

  const handlePacketDispatch = (packet: ComposedPacket) => {
    // Export targets bypass DispatchConfirm — they're a file write,
    // not a chat round-trip. Render a download immediately and
    // record a 'noted' DispatchEvent so it shows up in Recent
    // Dispatches.
    if (packet.target === 'notebook' || packet.target === 'markdown') {
      const safeTitle = packet.title.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 80);
      const filename = `${safeTitle || 'sidetrack-packet'}.md`;
      downloadAsFile(filename, packet.body);
      setError(`Downloaded ${filename}.`);
      // Still record the dispatch so Recent Dispatches has the row.
      setPendingDispatch(packet);
      setComposeThreadId(null);
      return;
    }
    setPendingDispatch(packet);
    setComposeThreadId(null);
  };

  const handlePacketSave = (packet: ComposedPacket) => {
    // Save-to-vault: copy body to clipboard for the user's
    // convenience, record the dispatch event with status:'noted'.
    void navigator.clipboard.writeText(packet.body).catch(() => undefined);
    setPendingDispatch({ ...packet });
    setComposeThreadId(null);
    setError('Packet saved to vault and copied to clipboard.');
  };

  const handlePacketCopy = (packet: ComposedPacket) => {
    void navigator.clipboard
      .writeText(packet.body)
      .then(() => {
        setError(`Packet copied to clipboard (${packet.tokenEstimate.toLocaleString()} tokens).`);
      })
      .catch(() => {
        setError('Could not copy to clipboard — paste from the body field above.');
      });
    setComposeThreadId(null);
  };

  const submitPendingDispatch = async () => {
    if (pendingDispatch === null || bridgeKey.length === 0) {
      return;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      setError('Invalid companion port.');
      return;
    }
    setDispatchInFlight(true);
    setError(null);
    try {
      const client = createDispatchClient({ port: portNumber, bridgeKey });
      const idempotencyKey = `disp_ui_${String(Date.now())}_${Math.random().toString(36).slice(2, 10)}`;
      const provider = mapUiTarget(pendingDispatch.target);
      const mode: DispatchMode =
        settings !== null && isProviderWithOptIn(provider) && settings.autoSendOptIn[provider]
          ? 'auto-send'
          : 'paste';
      const submitResult = await client.submit(
        {
          kind: mapUiPacketKind(pendingDispatch.kind),
          target: { provider, mode },
          title: pendingDispatch.title,
          body: pendingDispatch.body,
          ...(pendingDispatch.sourceThreadId !== undefined
            ? { sourceThreadId: pendingDispatch.sourceThreadId }
            : {}),
          ...(pendingDispatch.workstreamId !== undefined
            ? { workstreamId: pendingDispatch.workstreamId }
            : {}),
        },
        idempotencyKey,
      );
      // Cache the unredacted body locally — the companion stored a
      // redacted form, but the user pastes the original into the
      // chat, and the auto-link matcher needs to compare against
      // what the user actually pasted. Fire-and-forget; failures
      // shouldn't block the dispatch flow.
      void sendRequest({
        type: messageTypes.cacheDispatchOriginal,
        dispatchId: submitResult.bac_id,
        body: pendingDispatch.body,
      }).catch(() => undefined);
      // Update the per-thread "last target" so the SendToDropdown
      // can pre-select it next time. Same for composer-driven
      // dispatches as for one-tap Send-to picks.
      if (pendingDispatch.sourceThreadId !== undefined) {
        void sendRequest({
          type: messageTypes.cacheLastDispatchTarget,
          threadId: pendingDispatch.sourceThreadId,
          target: pendingDispatch.target,
        }).catch(() => undefined);
      }
      // Side-effect: copy the body + open the target provider in a
      // new tab so the user can paste right into a fresh chat. Skip
      // for export targets — those got their download in the
      // composer handler. Skip for noted-only sinks (other) — no
      // chat to open.
      const targetUrl = TARGET_CHAT_URL[pendingDispatch.target];
      if (targetUrl !== undefined) {
        await navigator.clipboard.writeText(pendingDispatch.body).catch(() => undefined);
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
        setError(
          `Opened ${TARGET_PROVIDER_LABEL[provider] ?? provider} in a new tab. Packet copied to your clipboard — paste to send.`,
        );
      }
      setPendingDispatch(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Dispatch failed.');
    } finally {
      setDispatchInFlight(false);
    }
  };

  const handleSettingsSave = (next: {
    readonly autoSendOptIn: SettingsValue['autoSendOptIn'];
    readonly defaultPacketKind: SettingsValue['defaultPacketKind'];
    readonly defaultDispatchTarget: SettingsValue['defaultDispatchTarget'];
    readonly screenShareSafeMode: boolean;
  }) => {
    if (settings === null || bridgeKey.length === 0) {
      setSettingsError('Connect the companion first to save settings.');
      return;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      setSettingsError('Invalid companion port.');
      return;
    }
    setSettingsBusy(true);
    setSettingsError(null);
    const client = createSettingsClient({ port: portNumber, bridgeKey });
    void client
      .patch({
        revision: settings.revision,
        autoSendOptIn: next.autoSendOptIn,
        defaultPacketKind: next.defaultPacketKind,
        defaultDispatchTarget: next.defaultDispatchTarget,
        screenShareSafeMode: next.screenShareSafeMode,
      })
      .then((updated) => {
        setSettings(updated);
        setSettingsOpen(false);
      })
      .catch((settingsErr: unknown) => {
        setSettingsError(
          settingsErr instanceof Error ? settingsErr.message : 'Could not save settings.',
        );
      })
      .finally(() => {
        setSettingsBusy(false);
      });
  };

  const submitReview = async (
    thread: TrackedThread,
    payload: {
      readonly verdict: ReviewVerdict | null;
      readonly reviewerNote: string;
      readonly perSpan: Record<string, string>;
      readonly spanText?: Record<string, string>;
    },
    outcome: ReviewOutcome,
    spanContext: ReadonlyMap<
      string,
      { readonly text: string; readonly ordinal: number; readonly capturedAt?: string }
    >,
  ): Promise<boolean> => {
    if (bridgeKey.length === 0) {
      setError('Connect the companion to record reviews.');
      return false;
    }
    const portNumber = Number(port);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      setError('Invalid companion port.');
      return false;
    }
    const trimmedNote = payload.reviewerNote.trim();
    const hasPerSpanComment = Object.values(payload.perSpan).some((c) => c.trim().length > 0);
    if (trimmedNote.length === 0 && !hasPerSpanComment) {
      setError('Add a comment (overall or per-span) before saving the review.');
      return false;
    }
    setReviewInFlight(true);
    setError(null);
    try {
      const client = createReviewClient({ port: portNumber, bridgeKey });
      const idempotencyKey = `rev_ui_${String(Date.now())}_${Math.random().toString(36).slice(2, 10)}`;
      const spans = Object.entries(payload.perSpan)
        .filter(([, comment]) => comment.trim().length > 0)
        .map(([id, comment]) => {
          const context = spanContext.get(id);
          // Prefer the user-edited text; fall back to the captured text.
          const editedText = payload.spanText?.[id];
          return {
            id,
            text: editedText ?? context?.text ?? thread.title,
            comment: comment.trim(),
            ...(context?.capturedAt !== undefined ? { capturedAt: context.capturedAt } : {}),
          };
        });
      const firstWithComment = Object.entries(payload.perSpan).find(
        ([, comment]) => comment.trim().length > 0,
      );
      const sourceTurnOrdinal =
        firstWithComment !== undefined ? (spanContext.get(firstWithComment[0])?.ordinal ?? 0) : 0;
      await client.submit(
        {
          sourceThreadId: thread.bac_id,
          sourceTurnOrdinal,
          provider: thread.provider,
          // Verdict is optional in the new UX — fall back to 'open' on
          // the wire so we don't change the schema until we're sure
          // the new comment-driven model sticks.
          verdict: payload.verdict ?? 'open',
          reviewerNote: trimmedNote.length > 0 ? trimmedNote : '(per-span comments only)',
          spans,
          outcome,
        },
        idempotencyKey,
      );
      return true;
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Review failed.');
      return false;
    } finally {
      setReviewInFlight(false);
    }
  };

  // Inline-review draft handlers — wire the per-thread chip + footer
  // into the new draft message types. The send-as-follow-up path
  // delegates entirely to the background handler (which bundles the
  // draft, queues a follow-up, and turns auto-send on for the
  // thread). Save-to-vault uses the same review HTTP client as the
  // modal flow but reads the staged draft from chrome.storage.
  const dropReviewDraftSpan = (threadId: string, spanId: string) => {
    void runAction(() => sendRequest({ type: messageTypes.dropReviewDraftSpan, threadId, spanId }));
  };

  const updateInlineReviewDraft = (
    threadId: string,
    patch: { overall?: string; verdict?: ReviewVerdictType },
  ) => {
    void runAction(() => sendRequest({ type: messageTypes.updateReviewDraft, threadId, ...patch }));
  };

  const setReviewDraftSpanComment = (threadId: string, spanId: string, comment: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.setReviewDraftSpanComment,
        threadId,
        spanId,
        comment,
      }),
    );
  };

  // Two ways to ship the staged draft. Both bundle into the queue
  // template + clear the draft. Difference is whether the per-thread
  // auto-send chip flips on. Footer expansion state stays put — the
  // chip + footer naturally vanish once the draft clears, and reappear
  // pre-expanded when the user adds another comment from the chat
  // page. The user keeps working without losing their place.
  const addInlineReviewToQueue = (threadId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.sendReviewDraftAsFollowUp,
        threadId,
        autoSend: false,
      }),
    );
  };

  const sendInlineReviewNow = (threadId: string) => {
    void runAction(() =>
      sendRequest({
        type: messageTypes.sendReviewDraftAsFollowUp,
        threadId,
        autoSend: true,
      }),
    );
  };

  const discardInlineReviewDraft = (threadId: string) => {
    setReviewDraftExpandFor(null);
    void runAction(() => sendRequest({ type: messageTypes.discardReviewDraft, threadId }));
  };

  // Auto-pop the wizard ONLY for true first-launch users (no setupCompleted
  // flag AND no bridge key in storage on first mount). Existing-user
  // migration: a non-empty bridge key from a prior install means they
  // already configured it; don't re-pop. After "Done" or "Skip",
  // setupCompleted=true → never re-pops.
  //
  // We anchor firstLaunch on the initial mount via a sticky flag —
  // otherwise typing into the bridge-key field inside the wizard would
  // flip firstLaunch to false and yank the wizard out from under the
  // user mid-interaction.
  const firstLaunchPending =
    stateLoaded && setupCompleted === false && bridgeKey.trim().length === 0;
  const [firstLaunchAnchored, setFirstLaunchAnchored] = useState(false);
  useEffect(() => {
    if (firstLaunchPending && !firstLaunchAnchored) {
      setFirstLaunchAnchored(true);
    }
  }, [firstLaunchPending, firstLaunchAnchored]);
  const inFirstLaunchMode = firstLaunchAnchored && setupCompleted === false;
  const showWizard = inFirstLaunchMode || wizardOpen;
  const localOnlyMode = state.companionStatus === 'local-only';
  // When local-only is the chosen mode, the companion isn't expected;
  // "disconnected" only applies when a bridge key was set but the
  // companion is unreachable. The 'unknown' state means we haven't
  // completed the first /status poll yet — don't surface the red
  // banner during that gap; the panel just opened and is still
  // dialing the companion. The status pill softens to "connecting…"
  // for those few ticks.
  const companionDisconnected =
    !localOnlyMode &&
    state.companionStatus !== 'unknown' &&
    (bridgeKey.trim().length === 0 || state.companionStatus === 'disconnected');
  // Relay banner is gated on the companion being reachable —
  // if companion is down we already show that, no point also
  // claiming peer-sync is paused (it definitionally is). Only
  // surface relay-down when we have a live status block AND
  // it reports !connected.
  const relayConfigured = state.relayHealth !== undefined;
  const relayDown =
    relayConfigured && !companionDisconnected && state.relayHealth?.connected === false;
  const relayStatusForBanner: 'up' | 'down' | 'unconfigured' = !relayConfigured
    ? 'unconfigured'
    : relayDown
      ? 'down'
      : 'up';
  const vaultUnreachable = state.companionStatus === 'vault-error';
  const providerHealth = state.selectorHealth.find((entry) => entry.latestStatus !== 'ok');
  const workstreamOptions = useMemo(
    () => buildWorkstreamOptions(state.workstreams),
    [state.workstreams],
  );
  const hasSystemBanners =
    companionDisconnected ||
    relayDown ||
    vaultUnreachable ||
    providerHealth !== undefined ||
    state.queuedCaptureCount > 0 ||
    (state.failedCaptureCount ?? 0) > 0 ||
    captureToastHost !== null;

  // Current workstream id; null = "not set / Inbox" (special).
  const currentWsId =
    expandedWorkstreamId === null && selectedWorkstream === ''
      ? null
      : (expandedWorkstreamId ?? (selectedWorkstream || null));
  // Sync refs the focus-thread handler reads from outside its
  // empty-deps closure — see stateRef declaration above for context.
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);
  useEffect(() => {
    currentWsIdRef.current = currentWsId;
  }, [currentWsId]);
  // Phase 4: persist the user's currently-focused workstream id so
  // the timeline observer (running in the background SW) can stamp
  // it onto every browser.timeline.observed event for active-
  // workstream attribution. Stored under
  // sidetrack.activeWorkstreamId; the observer caches the value off
  // chrome.storage.onChanged.
  useEffect(() => {
    void (async () => {
      try {
        if (currentWsId === null) {
          await chrome.storage.local.remove('sidetrack.activeWorkstreamId');
        } else {
          await chrome.storage.local.set({
            'sidetrack.activeWorkstreamId': currentWsId,
          });
        }
      } catch {
        // chrome.storage may be unavailable in some test harnesses
        // — ignore; the observer just doesn't tag visits in that
        // case.
      }
    })();
  }, [currentWsId]);
  const currentWs =
    currentWsId === null ? null : (state.workstreams.find((w) => w.bac_id === currentWsId) ?? null);
  const currentWsLabel =
    currentWs === null ? 'not set' : workstreamPath(currentWs.bac_id, state.workstreams);
  const tabSessionWorkstreams = useMemo<readonly TabSessionWorkstreamOption[]>(
    () => workstreamOptions.map((workstream) => ({ ...workstream })),
    [workstreamOptions],
  );
  const tabSessionRecords = useMemo<readonly TabSessionRecord[]>(
    () =>
      tabSessionProjection === null
        ? []
        : Object.values(tabSessionProjection.bySessionId).sort((left, right) =>
            left.lastActivityAt < right.lastActivityAt ? 1 : -1,
          ),
    [tabSessionProjection],
  );
  const focusedTabUrl = comparableTabUrl(
    liveActiveTabUrl ??
      state.activeTabUrl ??
      state.currentTab?.tabSnapshot?.url ??
      state.currentTab?.threadUrl,
  );
  // Per-URL state: every visible attribution surface (Current tab,
  // Inbox, Pages-in-this-workstream) reads from `urlProjection` instead
  // of the tab-session projection. The synthesized TabSessionRecord
  // shape lets InboxCard / suggestion banner stay unchanged; the
  // record's `tabSessionId` field carries the canonical URL.
  const urlRecords = useMemo<readonly UrlVisitRecord[]>(
    () =>
      urlProjection === null
        ? []
        : Object.values(urlProjection.byCanonicalUrl).sort((left, right) =>
            left.lastSeenAt < right.lastSeenAt ? 1 : -1,
          ),
    [urlProjection],
  );
  const focusedUrlRecord = useMemo(() => {
    if (focusedTabUrl === null) return undefined;
    // `byCanonicalUrl` is keyed by exact canonical URL; the comparable
    // form may differ (canonicalThreadUrl strips fragments). Try both.
    const direct = urlProjection?.byCanonicalUrl[focusedTabUrl];
    if (direct !== undefined) return direct;
    // urlRecords is sorted by lastSeenAt desc.
    return urlRecords.find((record) => comparableTabUrl(record.canonicalUrl) === focusedTabUrl);
  }, [focusedTabUrl, urlProjection, urlRecords]);
  const focusedTabSession = useMemo(
    () => (focusedUrlRecord === undefined ? undefined : tabSessionRecordFromUrl(focusedUrlRecord)),
    [focusedUrlRecord],
  );
  const focusedTabSuggestion =
    focusedUrlRecord === undefined ? undefined : urlSuggestions[focusedUrlRecord.canonicalUrl];
  const focusedSuggestionIsActionable =
    focusedUrlRecord !== undefined &&
    focusedUrlRecord.currentAttribution === undefined &&
    focusedTabSuggestion?.decision.action === 'suggest' &&
    focusedTabSuggestion.decision.workstreamId !== undefined;
  const fallbackSuggestedUrl = useMemo(
    () =>
      urlRecords.find((record) => {
        const suggestion = urlSuggestions[record.canonicalUrl];
        return (
          record.currentAttribution === undefined &&
          suggestion?.decision.action === 'suggest' &&
          suggestion.decision.workstreamId !== undefined
        );
      }),
    [urlRecords, urlSuggestions],
  );
  const suggestedOpenUrl = focusedSuggestionIsActionable ? focusedUrlRecord : fallbackSuggestedUrl;
  const suggestedOpenTabSession = useMemo(
    () => (suggestedOpenUrl === undefined ? undefined : tabSessionRecordFromUrl(suggestedOpenUrl)),
    [suggestedOpenUrl],
  );
  const suggestedOpenTabSessionResolution =
    suggestedOpenUrl === undefined ? undefined : urlSuggestions[suggestedOpenUrl.canonicalUrl];
  const currentWorkstreamTabSessions = useMemo(
    () =>
      currentWsId === null
        ? []
        : urlRecords
            .filter((record) => record.currentAttribution?.workstreamId === currentWsId)
            .slice(0, 50)
            .map(tabSessionRecordFromUrl),
    [currentWsId, urlRecords],
  );
  const currentWsThreads = sortThreadsByLifecycle(
    currentWsId === null
      ? threads.filter((t) => t.primaryWorkstreamId === undefined)
      : threads.filter((t) => t.primaryWorkstreamId === currentWsId),
    state.reminders,
  );
  const activeCount = currentWsThreads.filter(
    (t) => t.status !== 'closed' && t.status !== 'archived' && t.status !== 'removed',
  ).length;
  const staleCount = currentWsThreads.filter(
    (t) => t.status === 'closed' || t.status === 'restorable' || t.status === 'needs_organize',
  ).length;
  const setCurrentWs = (id: string | null) => {
    setExpandedWorkstreamId(id);
    setSelectedWorkstream(id ?? '');
  };

  // All Threads view bucketing: classify EVERY thread (open + closed)
  // into the first matching lifecycle bucket per user priority order.
  // Within each bucket: lastSeenAt desc.
  const allThreadsByBucket = (() => {
    const buckets = new Map<AllThreadsBucket, TrackedThread[]>(
      ALL_THREAD_BUCKET_ORDER.map((b) => [b, []] as const),
    );
    for (const t of threads) {
      const bucket = classifyAllThread(t, state.reminders);
      buckets.get(bucket)?.push(t);
    }
    for (const [, list] of buckets) {
      list.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    }
    return buckets;
  })();

  const currentWsThreadsByBucket = (() => {
    const buckets = new Map<AllThreadsBucket, TrackedThread[]>(
      ALL_THREAD_BUCKET_ORDER.map((b) => [b, []] as const),
    );
    for (const t of currentWsThreads) {
      const bucket = classifyAllThread(t, state.reminders);
      buckets.get(bucket)?.push(t);
    }
    return buckets;
  })();

  const toggleThreadBucket = (bucket: AllThreadsBucket) => {
    const current = new Set(state.collapsedBuckets);
    if (current.has(bucket)) {
      current.delete(bucket);
    } else {
      current.add(bucket);
    }
    const collapsedBuckets = ALL_THREAD_BUCKET_ORDER.filter((candidate) => current.has(candidate));
    void runAction(() =>
      sendRequest({
        type: messageTypes.setCollapsedBuckets,
        collapsedBuckets,
      }),
    );
  };

  // Captures: manual notes filtered by the current workstream (or Inbox)
  // plus inbound reminders whose linked thread sits in scope. Notes that
  // are anchored to a specific thread render under that thread's history
  // strip instead — exclude them here so they don't double-render.
  const scopedNotes = (
    viewMode === 'all'
      ? state.captureNotes
      : state.captureNotes.filter((note) =>
          currentWsId === null
            ? note.workstreamId === undefined
            : note.workstreamId === currentWsId,
        )
  ).filter((note) => note.threadId === undefined);
  // Coding sessions (registered via the agent's MCP register tool) render
  // alongside chat threads in the same workstream group.
  const attachedSessions = state.codingSessions.filter((s) => s.status === 'attached');
  const currentWsCodingSessions =
    currentWsId === null
      ? attachedSessions.filter((s) => s.workstreamId === undefined)
      : attachedSessions.filter((s) => s.workstreamId === currentWsId);
  // Inline thread-row renderer reused across views.
  const renderThreadRow = (thread: TrackedThread) => {
    const isPrivate = isThreadPrivate(thread, state.workstreams, state.screenShareMode);
    const lifecycle = deriveLifecycle(thread, state.reminders);
    const { dotClass, stampLabel, lifecyclePill } = lifecycle;
    // Two timestamps when we have captured turns:
    //   - synced (lastSeenAt) = when the side panel last fetched
    //   - updated (max turn capturedAt) = when the chat last changed
    // Fall back to a single line when no turns are fetched yet so we
    // don't display a redundant "synced 2m · updated 2m" pair.
    const cachedTurnsForRow = inlineTurnsByUrl.get(thread.threadUrl);
    const lastTurnAt =
      cachedTurnsForRow !== undefined && cachedTurnsForRow.length > 0
        ? cachedTurnsForRow.reduce<string>(
            (latest, t) => (t.capturedAt > latest ? t.capturedAt : latest),
            '',
          )
        : null;
    const stamp =
      thread.status === 'restorable'
        ? `Tab closed · ${formatRelative(thread.lastSeenAt)}`
        : thread.trackingMode === 'stopped'
          ? `Tracking stopped · ${formatRelative(thread.lastSeenAt)}`
          : lastTurnAt !== null && lastTurnAt !== thread.lastSeenAt
            ? `synced ${formatRelative(thread.lastSeenAt)} · updated ${formatRelative(lastTurnAt)}`
            : `${stampLabel} · ${formatRelative(thread.lastSeenAt)}`;
    const titleDisplay = isPrivate ? '[private]' : thread.title;
    const pendingQueueItems = state.queueItems
      .filter((q) => q.targetId === thread.bac_id && q.status === 'pending')
      .slice()
      .sort(compareQueueItems);
    const queuedCount = pendingQueueItems.length;
    // Expansion holds the compose-at-end row even when the queue is
    // empty, so the user can keep stacking follow-ups without the
    // list collapsing under them.
    const queueExpanded = queueExpandFor === thread.bac_id;
    const childForks = state.threads.filter((t) => t.parentThreadId === thread.bac_id);
    // Outgoing dispatches sourced from this thread — the user wants
    // each source-thread card to surface "this is where I shipped X to
    // Gemini / Claude / Codex." Cap at the most recent 5 to avoid
    // crowding the card; the full list still lives in Recent
    // Dispatches at the section level.
    //
    // bac_id-equality is the strict path. When local thread bac_ids
    // get re-issued (companion regenerates, storage drift), the
    // dispatch's sourceThreadId points at a dead bac_id. In that
    // orphan case, fall back to matching the dispatch.title against
    // the thread.title — dispatch.title IS the source thread title
    // captured at submit time, so an exact-string match is
    // surprisingly robust. The proper fix is adding sourceThreadUrl
    // to the dispatch schema so we can match by URL; tracked as a
    // follow-up.
    const liveThreadIdSet = new Set(state.threads.map((t) => t.bac_id));
    const outgoingDispatches = state.recentDispatches
      .filter((d) => {
        if (d.status === 'archived') return false;
        if (d.sourceThreadId === thread.bac_id) return true;
        if (d.sourceThreadId === undefined) return false;
        // Stale sourceThreadId only matters when the bac_id is dead
        // — a live but different thread should not steal dispatches.
        const sourceLive = liveThreadIdSet.has(d.sourceThreadId);
        if (sourceLive) return false;
        return d.title === thread.title;
      })
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5);
    const parent =
      thread.parentThreadId === undefined
        ? undefined
        : state.threads.find((t) => t.bac_id === thread.parentThreadId);
    // Thread-anchored notes form the inline history under the row,
    // sorted newest-first to match the workstream rail.
    const threadNotes = state.captureNotes
      .filter((note) => note.threadId === thread.bac_id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // Auto-expand the inline history strip when the thread has any
    // notes — captures should be visible without a click. Empty
    // strips collapse to the "+ note" affordance. The user can still
    // toggle explicitly via the strip header, which overrides the
    // auto-expand.
    const historyExplicitlyToggled = threadHistoryOpen.has(thread.bac_id);
    const historyOpen = historyExplicitlyToggled || threadNotes.length > 0;
    const historyComposeOpen = threadNoteFor === thread.bac_id;
    const titleExpanded = titleExpandedFor === thread.bac_id;
    const inlineTurns = inlineTurnsByUrl.get(thread.threadUrl);
    const isFocusing = focusingThreadId === thread.bac_id;
    // Inline-review draft staged from on-page selection. Surfaced as
    // a "Review draft (N) ⌄" chip in row1 next to the queued chip.
    const reviewDraft = state.reviewDrafts[thread.bac_id];
    // Only "expanded" if the row is the chosen target AND a draft
    // exists. Splitting the boolean keeps the JSX narrowing clean.
    const expandedDraft =
      reviewDraftExpandFor === thread.bac_id && reviewDraft !== undefined ? reviewDraft : null;
    const reviewDraftExpanded = expandedDraft !== null;
    return (
      <div
        key={thread.bac_id}
        className={
          'thread' +
          (isFocusing ? ' focusing' : '') +
          (draggingThreadId === thread.bac_id ? ' dragging' : '')
        }
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', thread.bac_id);
          setDraggingThreadId(thread.bac_id);
        }}
        onDragEnd={() => {
          setDraggingThreadId(null);
          setDropWorkstreamId(null);
        }}
        ref={(node) => {
          if (node === null) {
            threadRowRefs.current.delete(thread.bac_id);
          } else {
            threadRowRefs.current.set(thread.bac_id, node);
          }
        }}
      >
        <div className="row1">
          <span className={'provider ' + thread.provider}>{providerLabel(thread.provider)}</span>
          <button
            type="button"
            className={'thread-name-btn' + (titleExpanded ? ' expanded' : '')}
            title="Click to view captured turns from this thread"
            aria-expanded={titleExpanded}
            onClick={(e) => {
              e.stopPropagation();
              setTitleExpandedFor(titleExpanded ? null : thread.bac_id);
            }}
          >
            <span className="name">{titleDisplay}</span>
          </button>
          {queuedCount > 0 ? (
            <button
              type="button"
              className={'thread-queued mono' + (queueExpanded ? ' on' : '')}
              title={`Show ${String(queuedCount)} queued follow-up${queuedCount === 1 ? '' : 's'} — copy or dismiss before replying`}
              aria-expanded={queueExpanded}
              onClick={(e) => {
                e.stopPropagation();
                setQueueExpandFor(queueExpanded ? null : thread.bac_id);
              }}
            >
              {String(queuedCount)} queued
            </button>
          ) : null}
          {reviewDraft !== undefined ? (
            <button
              type="button"
              className={'thread-review-draft-chip' + (reviewDraftExpanded ? ' on' : '')}
              title={`Review draft staged with ${String(reviewDraft.spans.length)} comment${reviewDraft.spans.length === 1 ? '' : 's'} — expand to send as follow-up`}
              aria-expanded={reviewDraftExpanded}
              onClick={(e) => {
                e.stopPropagation();
                setReviewDraftExpandFor(reviewDraftExpanded ? null : thread.bac_id);
              }}
            >
              Review draft ({String(reviewDraft.spans.length)}) {reviewDraftExpanded ? '▴' : '▾'}
            </button>
          ) : null}
        </div>
        <div className="row2 row2-lifecycle">
          <span
            className={'dot ' + dotClass}
            data-testid={`thread-row-dot-${dotClass}`}
            data-dot-class={dotClass}
          />
          <span className="stamp">{stamp}</span>
          {/* Per spec: dot + stamp already convey lifecycle. The
              lifecycle pill is redundant for unread / waiting /
              you-replied / stale / tab-closed / tracking-stopped
              (the dot color + stamp text agree). Keep it only for
              "Needs organize" — no dot-color story for that. */}
          {lifecyclePill?.label === 'Needs organize' ? (
            <span className={'lifecycle-pill mono ' + lifecyclePill.tone}>
              {lifecyclePill.label}
            </span>
          ) : null}
          {viewMode === 'all' ? (
            <button
              type="button"
              className="thread-ws-path mono"
              title={
                thread.primaryWorkstreamId === undefined
                  ? 'Switch to Ungrouped workstream view'
                  : 'Switch to this workstream'
              }
              onClick={(e) => {
                e.stopPropagation();
                focusThreadInWorkstream(thread);
              }}
            >
              {thread.primaryWorkstreamId === undefined
                ? 'Ungrouped'
                : workstreamPath(thread.primaryWorkstreamId, state.workstreams)}
            </button>
          ) : null}
          {/* Model badge — populated by the per-turn enricher
              (turnEnricher.ts) when the provider's model picker is
              scrapeable. Surface as an inline pill so users can see
              "this thread was talking to GPT-5.1 Pro" without opening
              the dispatch confirm. Click is a no-op pure label. */}
          {thread.selectedModel !== undefined && thread.selectedModel.length > 0 ? (
            <span
              className="thread-model-pill mono"
              title={`Model captured at last turn: ${thread.selectedModel}`}
            >
              {thread.selectedModel}
            </span>
          ) : null}
          {/* Auto-send state pill — moved out of .thread-actions
              (the absolute-positioned action strip at top-right)
              into the lifecycle row so it stops crowding the icons.
              Renders inline with stamp + workstream path. */}
          {queuedCount > 0 ? (
            <button
              type="button"
              className={'thread-autosend' + (thread.autoSendEnabled ? ' on' : '')}
              aria-pressed={thread.autoSendEnabled === true}
              title={
                thread.autoSendEnabled
                  ? 'Auto-send on — queued items ship into this chat one at a time, waiting for each reply.'
                  : 'Auto-send off — turn on to drain queued follow-ups into this chat (per-provider opt-in lives in Settings).'
              }
              onClick={(e) => {
                e.stopPropagation();
                void runAction(() =>
                  sendRequest({
                    type: messageTypes.setThreadAutoSend,
                    threadId: thread.bac_id,
                    enabled: !thread.autoSendEnabled,
                  }),
                );
              }}
            >
              <span className="thread-autosend-dot" aria-hidden />
              <span className="thread-autosend-label">auto-send</span>
              <span className="thread-autosend-state">{thread.autoSendEnabled ? 'on' : 'off'}</span>
            </button>
          ) : null}
        </div>
        {lifecyclePill?.label === 'Needs organize' && !dismissedSuggestions.has(thread.bac_id) ? (
          <NeedsOrganizeSuggestionRow
            threadId={thread.bac_id}
            companionPort={port.length > 0 ? Number(port) : null}
            bridgeKey={bridgeKey.length > 0 ? bridgeKey : null}
            cached={suggestionCache.get(thread.bac_id)}
            workstreamFingerprint={workstreamFingerprint}
            indexRebuilding={recallStatus === 'rebuilding' || recallStatus === 'stale'}
            resolveLabel={resolveWorkstreamLabel}
            onCache={(payload) => {
              setSuggestionCache((prev) => {
                const next = new Map(prev);
                next.set(thread.bac_id, payload);
                return next;
              });
            }}
            onClearCache={() => {
              setSuggestionCache((prev) => {
                if (!prev.has(thread.bac_id)) return prev;
                const next = new Map(prev);
                next.delete(thread.bac_id);
                return next;
              });
            }}
            onAccept={(workstreamId) => {
              void moveThreadToWorkstream(thread.bac_id, workstreamId);
            }}
            onPickManual={() => {
              setMoveThreadId(thread.bac_id);
            }}
            onDismiss={() => {
              setDismissedSuggestions((prev) => {
                const next = new Set(prev);
                next.add(thread.bac_id);
                return next;
              });
            }}
          />
        ) : null}
        {parent !== undefined || thread.parentTitle !== undefined ? (
          <div className="row2 thread-lineage" title="Branched from a tracked thread">
            <span className="lineage-arrow">↰</span>
            <span className="lineage-from mono">from</span>
            {parent === undefined ? (
              <span className="lineage-name">{thread.parentTitle ?? 'untracked thread'}</span>
            ) : (
              <button
                type="button"
                className="btn-link lineage-name"
                title={`Switch to parent thread: ${parent.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openTabForThread(parent);
                }}
              >
                {parent.title}
              </button>
            )}
          </div>
        ) : null}
        {childForks.length > 0 ? (
          <div
            className="row2 thread-lineage"
            title={`This thread has ${String(childForks.length)} fork${
              childForks.length === 1 ? '' : 's'
            }`}
          >
            <span className="lineage-arrow">↳</span>
            <span className="lineage-from mono">
              {String(childForks.length)} fork{childForks.length === 1 ? '' : 's'}
            </span>
          </div>
        ) : null}
        {outgoingDispatches.length > 0 ? (
          <ul className="thread-dispatched-list" aria-label="Outgoing dispatches">
            {outgoingDispatches.map((d) => {
              const linkedThreadId = state.dispatchLinks[d.bac_id];
              const linkedThread =
                linkedThreadId === undefined
                  ? undefined
                  : state.threads.find((t) => t.bac_id === linkedThreadId);
              const targetLabel = TARGET_PROVIDER_LABEL[d.target.provider] ?? d.target.provider;
              const destTitle =
                linkedThread?.title ??
                (d.target.mode === 'auto-send' ? 'pending — new chat' : 'pending — paste it');
              return (
                <li key={d.bac_id} className="thread-dispatched-row">
                  <span className="lineage-arrow">↗</span>
                  <span className="thread-dispatched-target chip mono">{targetLabel}</span>
                  {linkedThread !== undefined ? (
                    <button
                      type="button"
                      className="btn-link thread-dispatched-name"
                      title={`Open destination chat: ${linkedThread.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openTabForThread(linkedThread);
                      }}
                    >
                      {destTitle}
                    </button>
                  ) : (
                    <span className="thread-dispatched-name muted">{destTitle}</span>
                  )}
                  <span className="thread-dispatched-when mono">{formatRelative(d.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="thread-actions row2">
          <button
            type="button"
            className="btn-link thread-action-icon"
            title="Open the thread's tab (or reopen if closed)"
            aria-label="Open thread tab"
            onClick={(e) => {
              e.stopPropagation();
              openTabForThread(thread);
            }}
          >
            <span className="icon-12" aria-hidden>
              {Icons.arrowR}
            </span>
          </button>
          {thread.trackingMode === 'manual' ? (
            <button
              type="button"
              className="btn-link thread-action-icon"
              title="Capture this thread now (manual mode — no auto-refresh)"
              aria-label="Capture this thread now"
              onClick={(e) => {
                e.stopPropagation();
                void (async () => {
                  await openTabForThread(thread);
                  await runAction(() => sendRequest({ type: messageTypes.captureCurrentTab }));
                })();
              }}
            >
              <span className="icon-12" aria-hidden>
                {Icons.manualTap}
              </span>
            </button>
          ) : null}
          {(() => {
            const requiresCompanion =
              state.companionStatus !== 'connected' || bridgeKey.length === 0;
            // Don't use the `disabled` attribute when companion is missing —
            // a click should explain how to enable, not be silently swallowed.
            const explainNeedsCompanion = (action: 'Send' | 'Review') => {
              setError(
                `${action} needs a connected companion to read this thread's turns from the vault. Open Settings (cog, top right) → enter the bridge port and key → Save, then try again.`,
              );
            };
            const sendDropdownOpen = sendToOpenFor === thread.bac_id;
            const menuOpen = actionMenuOpenFor === thread.bac_id;
            return (
              <>
                <button
                  type="button"
                  className={
                    'btn-link thread-action-icon' + (requiresCompanion ? ' disabled-look' : '')
                  }
                  title={
                    requiresCompanion
                      ? 'Send is unavailable in local-only mode — click for setup steps'
                      : 'Send this thread to another AI / coding agent / file'
                  }
                  aria-haspopup="menu"
                  aria-expanded={sendDropdownOpen}
                  aria-label="Send to another AI or coding agent"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (requiresCompanion) {
                      explainNeedsCompanion('Send');
                      return;
                    }
                    setSendToOpenFor(sendDropdownOpen ? null : thread.bac_id);
                  }}
                >
                  <span className="icon-12" aria-hidden>
                    {Icons.send}
                  </span>
                  <span className="thread-action-caret" aria-hidden>
                    ▾
                  </span>
                </button>
                <span className="thread-overflow-anchor">
                  <button
                    type="button"
                    className="btn-link thread-overflow-trigger"
                    title="More actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label="More actions"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActionMenuOpenFor(menuOpen ? null : thread.bac_id);
                    }}
                  >
                    ⋯
                  </button>
                  {menuOpen ? (
                    <div
                      className="thread-overflow-menu"
                      role="menu"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setActionMenuOpenFor(null);
                          // Toggle so the menu item is the collapse
                          // affordance when the queue pill is gone
                          // (e.g. count just drained to 0).
                          if (queueExpandFor === thread.bac_id) {
                            setQueueExpandFor(null);
                            setQueueDraft('');
                          } else {
                            setQueueExpandFor(thread.bac_id);
                            setQueueDraft('');
                            setQueueComposeAutoFocus(thread.bac_id);
                          }
                        }}
                      >
                        {queueExpandFor === thread.bac_id ? 'Hide queue' : 'Queue follow-up'}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={requiresCompanion ? 'disabled-look' : ''}
                        onClick={() => {
                          setActionMenuOpenFor(null);
                          if (requiresCompanion) {
                            explainNeedsCompanion('Review');
                            return;
                          }
                          setReviewThreadId(thread.bac_id);
                        }}
                      >
                        Review captured turns
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setActionMenuOpenFor(null);
                          setMoveThreadId(thread.bac_id);
                        }}
                      >
                        Move to workstream…
                      </button>
                      {thread.trackingMode === 'stopped' ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setActionMenuOpenFor(null);
                            updateTracking(
                              thread.bac_id,
                              thread.provider === 'unknown' ? 'manual' : 'auto',
                            );
                          }}
                        >
                          Resume tracking
                        </button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          className="warn"
                          onClick={() => {
                            setActionMenuOpenFor(null);
                            updateTracking(thread.bac_id, 'stopped');
                          }}
                        >
                          Stop tracking
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        className="archive"
                        onClick={() => {
                          setActionMenuOpenFor(null);
                          updateTracking(thread.bac_id, 'archived');
                        }}
                      >
                        Archive
                      </button>
                    </div>
                  ) : null}
                </span>
              </>
            );
          })()}
        </div>
        {sendToOpenFor === thread.bac_id ? (
          <div className="thread-send-to-inline">
            <SendToDropdown
              recentTarget={
                state.lastDispatchTargetByThread[thread.bac_id] as SendToTarget | undefined
              }
              onPick={(target) => {
                handleSendToPick(thread, target);
              }}
              onCustomize={() => {
                setSendToOpenFor(null);
                setComposeThreadId(thread.bac_id);
              }}
              onClose={() => {
                setSendToOpenFor(null);
              }}
            />
          </div>
        ) : null}
        {expandedDraft !== null ? (
          <div className="thread-review-draft">
            <div className="thread-review-draft-head mono">
              <span>review draft</span>
              <span className="count">
                · {String(expandedDraft.spans.length)} comment
                {expandedDraft.spans.length === 1 ? '' : 's'}
              </span>
            </div>
            <ReviewDraftFooter
              draft={expandedDraft}
              onDropSpan={(spanId) => {
                dropReviewDraftSpan(thread.bac_id, spanId);
              }}
              onUpdate={(patch) => {
                updateInlineReviewDraft(thread.bac_id, patch);
              }}
              onSetSpanComment={(spanId, comment) => {
                setReviewDraftSpanComment(thread.bac_id, spanId, comment);
              }}
              onAddToQueue={() => {
                addInlineReviewToQueue(thread.bac_id);
              }}
              onSendNow={() => {
                sendInlineReviewNow(thread.bac_id);
              }}
              onDiscard={() => {
                discardInlineReviewDraft(thread.bac_id);
              }}
            />
          </div>
        ) : null}
        {queueExpanded ? (
          <ul className="thread-queue-list" aria-label="Queued follow-ups">
            {pendingQueueItems.length === 0 ? (
              <li className="queue-empty-hint mono">
                no queued follow-ups · type below to stack one for after the next reply
              </li>
            ) : null}
            {pendingQueueItems.some((item) => item.lastError !== undefined) ? (
              <li className="queue-retry-all-row">
                <button
                  type="button"
                  className="btn-link thread-queue-retry"
                  onClick={(e) => {
                    e.stopPropagation();
                    pendingQueueItems
                      .filter((item) => item.lastError !== undefined)
                      .forEach((item) => {
                        void runAction(() =>
                          sendRequest({
                            type: messageTypes.retryAutoSend,
                            queueItemId: item.bac_id,
                          }),
                        );
                      });
                  }}
                >
                  Retry all failed
                </button>
              </li>
            ) : null}
            {pendingQueueItems.map((item, index) => {
              const itemDraggable = item.progress === undefined;
              return (
                <AutoSendQueueRow
                  key={item.bac_id}
                  item={item}
                  index={index}
                  total={pendingQueueItems.length}
                  providerLabel={providerLabel(thread.provider)}
                  copied={queueCopiedId === item.bac_id}
                  onCopy={() => {
                    copyQueueItemText(item.bac_id, item.text);
                  }}
                  onRetry={() => {
                    void runAction(() =>
                      sendRequest({
                        type: messageTypes.retryAutoSend,
                        queueItemId: item.bac_id,
                      }),
                    );
                  }}
                  onDismiss={() => {
                    dismissQueueItem(item.bac_id);
                  }}
                  dnd={
                    pendingQueueItems.length > 1
                      ? {
                          draggable: itemDraggable,
                          dragOverActive:
                            dragOverQueueItemId === item.bac_id &&
                            draggedQueueItemId !== null &&
                            draggedQueueItemId !== item.bac_id,
                          onDragStart: (event) => {
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', item.bac_id);
                            setDraggedQueueItemId(item.bac_id);
                          },
                          onDragEnd: () => {
                            setDraggedQueueItemId(null);
                            setDragOverQueueItemId(null);
                          },
                          onDragOver: (event) => {
                            if (draggedQueueItemId === null) {
                              return;
                            }
                            event.preventDefault();
                            event.dataTransfer.dropEffect = 'move';
                            if (dragOverQueueItemId !== item.bac_id) {
                              setDragOverQueueItemId(item.bac_id);
                            }
                          },
                          onDragLeave: () => {
                            if (dragOverQueueItemId === item.bac_id) {
                              setDragOverQueueItemId(null);
                            }
                          },
                          onDrop: (event) => {
                            event.preventDefault();
                            const fromTransfer = event.dataTransfer.getData('text/plain');
                            const sourceId =
                              fromTransfer.length > 0 ? fromTransfer : (draggedQueueItemId ?? '');
                            setDraggedQueueItemId(null);
                            setDragOverQueueItemId(null);
                            if (sourceId.length === 0 || sourceId === item.bac_id) {
                              return;
                            }
                            reorderQueueItem(pendingQueueItems, sourceId, item.bac_id);
                          },
                        }
                      : undefined
                  }
                />
              );
            })}
            <li
              className={`queue-compose-row${
                draggedQueueItemId !== null && dragOverQueueItemId === '__tail__'
                  ? ' drag-over-tail'
                  : ''
              }`}
              onDragOver={(event) => {
                if (draggedQueueItemId === null) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (dragOverQueueItemId !== '__tail__') {
                  setDragOverQueueItemId('__tail__');
                }
              }}
              onDragLeave={() => {
                if (dragOverQueueItemId === '__tail__') {
                  setDragOverQueueItemId(null);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const fromTransfer = event.dataTransfer.getData('text/plain');
                const sourceId =
                  fromTransfer.length > 0 ? fromTransfer : (draggedQueueItemId ?? '');
                setDraggedQueueItemId(null);
                setDragOverQueueItemId(null);
                if (sourceId.length === 0) {
                  return;
                }
                reorderQueueItem(pendingQueueItems, sourceId, null);
              }}
            >
              <form
                className="thread-queue-compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitQueueFollowUp(thread.bac_id);
                }}
              >
                <input
                  type="text"
                  className="mono"
                  placeholder="Ask next… (fires after this thread replies)"
                  value={queueDraft}
                  ref={(node) => {
                    if (
                      node !== null &&
                      queueComposeAutoFocus === thread.bac_id &&
                      document.activeElement !== node
                    ) {
                      node.focus();
                      setQueueComposeAutoFocus(null);
                    }
                  }}
                  onChange={(e) => {
                    setQueueDraft(e.target.value);
                  }}
                />
                <button
                  type="submit"
                  className="btn-link"
                  disabled={busy || queueDraft.trim().length === 0}
                >
                  Add
                </button>
              </form>
            </li>
          </ul>
        ) : null}
        {titleExpanded ? (
          <div className="thread-turn-history">
            <div className="thread-turn-history-head mono">
              captured turns
              {inlineTurns !== undefined ? (
                <span className="thread-turn-history-count">
                  · {String(inlineTurns.length)} {inlineTurns.length === 1 ? 'turn' : 'turns'}
                </span>
              ) : null}
            </div>
            {inlineTurns === undefined ? (
              <div className="thread-turn-history-empty mono">loading…</div>
            ) : inlineTurns.length === 0 ? (
              <div className="thread-turn-history-empty mono">
                no captured turns for this thread (companion may be unreachable)
              </div>
            ) : (
              inlineTurns.map((turn) => {
                const turnKey = `${thread.threadUrl}::${String(turn.ordinal)}::${turn.role}`;
                const annotateOpen = annotateTurnKey === turnKey;
                const status =
                  annotateTurnStatus !== null && annotateTurnStatus.key === turnKey
                    ? annotateTurnStatus
                    : null;
                return (
                  <div
                    key={`${turn.role}-${String(turn.ordinal)}-${turn.capturedAt}`}
                    className={'thread-turn-card thread-turn-' + turn.role}
                  >
                    <span className="thread-turn-role mono">{turn.role}</span>
                    <span className="thread-turn-text">
                      <TurnText text={turn.text} maxChars={200} />
                    </span>
                    <button
                      type="button"
                      className="thread-turn-annotate-btn mono"
                      title="Drop a margin annotation on this turn — appears on the live page without reload"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (annotateOpen) {
                          setAnnotateTurnKey(null);
                          setAnnotateTurnDraft('');
                          setAnnotateTurnAnchorText('');
                          return;
                        }
                        setAnnotateTurnKey(turnKey);
                        setAnnotateTurnDraft('');
                        setAnnotateTurnAnchorText('');
                        setAnnotateTurnStatus(null);
                      }}
                    >
                      {annotateOpen ? '× cancel' : '✎ annotate'}
                    </button>
                    {annotateOpen ? (
                      <form
                        className="thread-turn-annotate-form"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                        onSubmit={(e) => {
                          e.preventDefault();
                          submitTurnAnnotation(thread.threadUrl, turn, turnKey);
                        }}
                      >
                        <input
                          className="thread-turn-annotate-input"
                          aria-label="Keyword or quote to highlight"
                          placeholder="Keyword / quote to highlight (optional)"
                          value={annotateTurnAnchorText}
                          onChange={(e) => {
                            setAnnotateTurnAnchorText(e.target.value);
                          }}
                        />
                        <textarea
                          className="thread-turn-annotate-input"
                          rows={2}
                          autoFocus
                          placeholder="What's worth flagging on this turn? (saves a margin marker on the live page)"
                          value={annotateTurnDraft}
                          onChange={(e) => {
                            setAnnotateTurnDraft(e.target.value);
                          }}
                        />
                        <div className="thread-turn-annotate-row">
                          <span
                            className={
                              'thread-turn-annotate-status mono' +
                              (status === null ? '' : ' tone-' + status.tone)
                            }
                          >
                            {status?.text ?? ''}
                          </span>
                          <button
                            type="submit"
                            className="btn-link mono"
                            disabled={
                              annotateTurnDraft.trim().length === 0 ||
                              (status?.tone ?? '') === 'saving'
                            }
                          >
                            {(status?.tone ?? '') === 'saving' ? 'placing…' : 'place marker'}
                          </button>
                          <button
                            type="button"
                            className="btn-link mono"
                            title="Place the marker, then send the annotation into the live chat"
                            disabled={
                              annotateTurnDraft.trim().length === 0 ||
                              (status?.tone ?? '') === 'saving'
                            }
                            onClick={(e) => {
                              e.preventDefault();
                              submitTurnAnnotation(thread.threadUrl, turn, turnKey, true);
                            }}
                          >
                            publish to chat
                          </button>
                        </div>
                      </form>
                    ) : null}
                    {!annotateOpen && status !== null ? (
                      <div className={'thread-turn-annotate-result mono' + ' tone-' + status.tone}>
                        {status.text}
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        ) : null}
        <div className="thread-history">
          {historyOpen ? (
            <>
              {threadNotes.length === 0
                ? null
                : threadNotes.map((note) => (
                    <div key={note.bac_id} className="thread-history-item">
                      <span className="glyph" aria-hidden>
                        ▍
                      </span>
                      <div className="body">{note.text}</div>
                      <span className="meta">{formatRelative(note.createdAt)}</span>
                      <div className="actions">
                        <button
                          type="button"
                          className="btn-link"
                          title="Edit this note"
                          onClick={(e) => {
                            e.stopPropagation();
                            beginEditNote(note.bac_id, note.text);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-link"
                          title="Delete this note"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteNote(note.bac_id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
              {historyComposeOpen ? (
                <form
                  className="thread-history-compose"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitThreadNote(thread.bac_id);
                  }}
                >
                  <textarea
                    autoFocus
                    rows={2}
                    placeholder="Note for this thread…"
                    value={threadNoteDraft}
                    onChange={(e) => {
                      setThreadNoteDraft(e.target.value);
                    }}
                  />
                  <div className="thread-history-compose-actions">
                    <button
                      type="submit"
                      className="btn-link"
                      disabled={busy || threadNoteDraft.trim().length === 0}
                    >
                      Save note
                    </button>
                    <button
                      type="button"
                      className="btn-link"
                      onClick={(e) => {
                        e.stopPropagation();
                        setThreadNoteFor(null);
                        setThreadNoteDraft('');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="thread-history-add"
                  title="Attach a note to this thread"
                  onClick={(e) => {
                    e.stopPropagation();
                    setThreadNoteFor(thread.bac_id);
                    setThreadNoteDraft('');
                  }}
                >
                  + note
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="thread-history-add"
              title={
                threadNotes.length > 0
                  ? `Show ${String(threadNotes.length)} thread note${threadNotes.length === 1 ? '' : 's'}`
                  : 'Attach a note to this thread'
              }
              onClick={(e) => {
                e.stopPropagation();
                toggleThreadHistory(thread.bac_id);
                if (threadNotes.length === 0) {
                  setThreadNoteFor(thread.bac_id);
                  setThreadNoteDraft('');
                }
              }}
            >
              {threadNotes.length > 0
                ? `▾ history · ${String(threadNotes.length)} note${threadNotes.length === 1 ? '' : 's'}`
                : '+ note'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const detachCodingSession = (codingSessionId: string) => {
    void runAction(() => sendRequest({ type: messageTypes.detachCodingSession, codingSessionId }));
  };

  // Inline coding-session row, rendered next to chat threads inside the
  // same workstream group.
  const renderCodingSessionRow = (session: CodingSession) => (
    <div key={session.bac_id} className="thread coding-session-row">
      <div className="row1">
        <span className="provider coding" aria-hidden>
          {'>_'}
        </span>
        <span className="name">{session.name}</span>
      </div>
      <div className="row2">
        <span className="dot green" />
        <span className="stamp mono">
          {session.tool} · {session.branch} · last seen {formatRelative(session.lastSeenAt)}
        </span>
      </div>
      <div className="thread-actions row2">
        {session.resumeCommand === undefined ? null : (
          <button
            type="button"
            className="btn-link"
            title="Copy resume command to clipboard"
            onClick={(e) => {
              e.stopPropagation();
              const cmd = session.resumeCommand ?? '';
              void navigator.clipboard.writeText(cmd).catch(() => {
                // Clipboard refused — best-effort.
              });
            }}
          >
            Copy resume
          </button>
        )}
        <button
          type="button"
          className="btn-link archive"
          title="Detach this coding session"
          onClick={(e) => {
            e.stopPropagation();
            detachCodingSession(session.bac_id);
          }}
        >
          Detach
        </button>
      </div>
    </div>
  );

  return (
    <main className="bac-app" aria-label="Sidetrack workboard">
      <div className="app-head">
        <div className="app-mark">
          <span className="glyph" aria-hidden />
          Sidetrack
          {__DEV__ ? (
            <span
              className="app-mark-dev mono"
              title="Development build — production omits this badge and the design-preview icon"
            >
              DEV
            </span>
          ) : null}
        </div>
        <div className="view-tabs sp-tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'workstream'}
            aria-label="Workstream"
            className={'view-tab' + (viewMode === 'workstream' ? ' on' : '')}
            onClick={() => {
              setViewMode('workstream');
            }}
          >
            Workstream
            <span className="ct mono" aria-hidden>
              {state.workstreams.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'all'}
            aria-label="All threads"
            className={'view-tab' + (viewMode === 'all' ? ' on' : '')}
            onClick={() => {
              setViewMode('all');
            }}
          >
            All threads
            <span className="ct mono" aria-hidden>
              {state.threads.length}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'inbox'}
            aria-label="Inbox"
            className={'view-tab' + (viewMode === 'inbox' ? ' on' : '')}
            onClick={() => {
              setViewMode('inbox');
            }}
          >
            Inbox
            <span className="ct mono" aria-hidden>
              {urlInbox.total}
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'connections'}
            aria-label="Connections"
            className={'view-tab' + (viewMode === 'connections' ? ' on' : '')}
            onClick={() => {
              setViewMode('connections');
            }}
          >
            Connections
          </button>
        </div>
        <div className="app-actions">
          <button
            className={'icon-btn' + (state.screenShareMode ? ' on' : '')}
            title="Screenshare mode — mask sensitive workstreams"
            onClick={() => {
              void runAction(() =>
                sendRequest({
                  type: messageTypes.setScreenShareMode,
                  enabled: !state.screenShareMode,
                }),
              );
            }}
            type="button"
            aria-label="Toggle screenshare mode"
            aria-pressed={state.screenShareMode}
          >
            <svg viewBox="0 0 24 24">
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button
            className={'icon-btn' + (findIconPulsing ? ' pulsing' : '')}
            title="Find this tab in the side panel — scrolls + flashes the matching thread row"
            onClick={findActiveTabThread}
            type="button"
            aria-label="Find active tab in side panel"
          >
            {/* Crosshair / locator. Visually distinct from the
                magnifier in "Search indexed threads" — this one
                tells you where the active tab IS, not searches
                for something to find. */}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
              <line x1="12" y1="2" x2="12" y2="5.5" />
              <line x1="12" y1="18.5" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5.5" y2="12" />
              <line x1="18.5" y1="12" x2="22" y2="12" />
            </svg>
          </button>
          <button
            className={'icon-btn' + (threadSearchOpen ? ' on' : '')}
            title="Search indexed threads"
            onClick={() => {
              setThreadSearchOpen((open) => !open);
            }}
            type="button"
            aria-label="Search indexed threads"
            aria-pressed={threadSearchOpen}
          >
            <span style={{ display: 'inline-flex', width: 14, height: 14 }}>{Icons.search}</span>
          </button>
          {/* Capture-current-tab (+) is only useful when capture mode
              is Manual. When mode is Auto, Sidetrack refreshes
              detected threads automatically and the user has nothing
              to do here, so we hide the button to declutter the
              toolbar. */}
          {state.settings.autoTrack ? null : (
            <button
              className="icon-btn"
              title="Capture / track the current tab — adds it to your side panel as a tracked thread"
              onClick={() => {
                void runAction(() => sendRequest({ type: messageTypes.captureCurrentTab }));
              }}
              type="button"
              aria-label="Capture current tab"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          )}
          {/* Capture-mode toggle (global). The icon glyph + a small
              uppercase mono label show the current mode at a glance:
              ↻ AUTO  — Sidetrack refreshes detected threads on every
                        new turn
              ✋ MANUAL — refreshes only when the user clicks a row's
                          Capture button
              Click cycles. Tooltip says what the click will do. */}
          <button
            className={'icon-btn icon-btn-labeled' + (state.settings.autoTrack ? ' on' : '')}
            title={
              state.settings.autoTrack
                ? 'Capture mode: Auto — refreshes every new turn. Click to switch to Manual.'
                : 'Capture mode: Manual — capture-on-demand per row. Click to switch to Auto.'
            }
            onClick={() => {
              void runAction(() =>
                sendRequest({
                  type: messageTypes.saveLocalPreferences,
                  preferences: { autoTrack: !state.settings.autoTrack },
                }),
              );
            }}
            type="button"
            aria-label={
              state.settings.autoTrack
                ? 'Capture mode is Auto — switch to Manual'
                : 'Capture mode is Manual — switch to Auto'
            }
            aria-pressed={state.settings.autoTrack}
          >
            <span style={{ display: 'inline-flex', width: 14, height: 14 }}>
              {state.settings.autoTrack ? Icons.autoCycle : Icons.manualTap}
            </span>
            <span className="icon-btn-label mono">
              {state.settings.autoTrack ? 'auto' : 'manual'}
            </span>
          </button>
          <button
            className="icon-btn"
            title={
              state.companionStatus === 'connected'
                ? 'Attach coding session'
                : 'Coding-session attach needs a companion — click to configure'
            }
            onClick={() => {
              // Don't gate the icon dead — when companion is missing,
              // route the user to the wizard so they can fix it.
              if (state.companionStatus !== 'connected') {
                setWizardOpen(true);
                return;
              }
              setCodingAttachOpen(true);
            }}
            type="button"
            aria-label="Attach coding session"
          >
            <svg viewBox="0 0 24 24">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <polyline points="6 10 9 13 6 16" />
              <line x1="13" y1="16" x2="18" y2="16" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Capture health diagnostics"
            onClick={() => {
              setHealthPanelOpen(true);
            }}
            type="button"
            aria-label="Open capture health diagnostics"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </button>
          {/* Stage 5 polish — "Dump panel state" button. POSTs every
              user-facing piece of panel state to the companion, which
              writes `${vault}/_BAC/debug-dumps/latest.json`. The user
              hands me the path and I read it instead of asking for
              another screenshot. */}
          <button
            className={
              'icon-btn' +
              (dumpStatus.kind === 'dumping' ? ' pulsing' : '') +
              (dumpStatus.kind === 'dumped' ? ' on' : '') +
              (dumpStatus.kind === 'error' ? ' warn' : '')
            }
            title={
              dumpStatus.kind === 'dumped'
                ? `Dumped: ${dumpStatus.path} — click again to refresh`
                : dumpStatus.kind === 'error'
                  ? dumpStatus.message
                  : 'Dump panel state to a JSON file for review'
            }
            onClick={handleDumpPanelState}
            type="button"
            aria-label="Dump panel state"
            data-testid="dump-panel-state"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          {/* Design preview — always-on for now (was gated by __DEV__).
              Re-gate once the surfaces it shows are wired into
              production rendering. */}
          <button
            className="icon-btn"
            title="Design preview — v2 surfaces"
            onClick={() => {
              setDesignPreviewOpen(true);
            }}
            type="button"
            aria-label="Open design preview"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="13" cy="6" r="2" />
              <circle cx="6" cy="13" r="2" />
              <circle cx="13" cy="20" r="2" />
              <circle cx="20" cy="13" r="2" />
              <line x1="11.6" y1="7.4" x2="7.4" y2="11.6" />
              <line x1="14.4" y1="7.4" x2="18.6" y2="11.6" />
              <line x1="11.6" y1="18.6" x2="7.4" y2="14.4" />
              <line x1="14.4" y1="18.6" x2="18.6" y2="14.4" />
            </svg>
          </button>
          <button
            className="icon-btn"
            title="Settings"
            onClick={() => {
              setSettingsOpen(true);
            }}
            type="button"
            aria-label="Settings"
          >
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Vault + companion status pills (v2 .sp-status). Glance-able
          health at the top so the user doesn't have to dive into
          Settings to see whether the companion is reachable. */}
      <div className="sp-status">
        <span
          className={
            'sp-status-pill mono ' + (state.companionStatus === 'vault-error' ? 'err' : 'ok')
          }
          title={
            state.companionStatus === 'vault-error'
              ? "Vault: companion can't reach the configured folder"
              : 'Vault: synced via companion'
          }
        >
          <span
            className={
              'sp-status-dot ' + (state.companionStatus === 'vault-error' ? 'red' : 'green')
            }
            aria-hidden
          />
          vault {state.companionStatus === 'vault-error' ? 'error' : 'connected'}
        </span>
        <span
          className={
            'sp-status-pill mono ' +
            (state.companionStatus === 'connected'
              ? 'ok'
              : state.companionStatus === 'local-only'
                ? 'warn'
                : 'err')
          }
          title={`Companion: ${companionStatusLabel(state.companionStatus)}`}
        >
          <span
            className={
              'sp-status-dot ' +
              (state.companionStatus === 'connected'
                ? 'green'
                : state.companionStatus === 'local-only'
                  ? 'amber'
                  : 'red')
            }
            aria-hidden
          />
          companion{' '}
          {state.companionStatus === 'connected'
            ? 'running'
            : state.companionStatus === 'local-only'
              ? 'local-only'
              : 'down'}
        </span>
        {/* Recall pill — only shown when status is non-ready, so the
            steady state stays clean. Lets the user see "indexing…"
            after companion startup or a model change without having
            to dig into the diagnostics panel. */}
        {recallStatus !== null && recallStatus !== 'ready' ? (
          <span
            className={
              'sp-status-pill mono ' +
              (recallStatus === 'rebuilding' || recallStatus === 'empty' ? 'warn' : 'err')
            }
            title={
              recallStatus === 'rebuilding'
                ? 'Recall: indexing in background. Déjà-vu lookups will return matches once the rebuild completes.'
                : recallStatus === 'empty'
                  ? 'Recall: index has no entries yet. Capture some threads to populate it.'
                  : recallStatus === 'missing'
                    ? 'Recall: no index file. The companion will rebuild it on the next startup.'
                    : 'Recall: index is stale (model or schema mismatch). Open Capture health and click Re-index.'
            }
          >
            <span
              className={
                'sp-status-dot ' +
                (recallStatus === 'rebuilding' || recallStatus === 'empty' ? 'amber' : 'red')
              }
              aria-hidden
            />
            recall {recallStatus === 'rebuilding' ? 'indexing' : recallStatus}
          </span>
        ) : null}
        {/* Dump-state result chip. Click "copy" to put the absolute
            path on the clipboard, "open" to ask the OS to reveal the
            file. Errors stay in the same chip so the user doesn't have
            to hunt for them. */}
        {dumpStatus.kind === 'dumped' ? (
          <span
            className="sp-status-pill mono ok"
            title={`Dump written to ${dumpStatus.path} — click "copy" for the path`}
            data-testid="dump-result"
          >
            <span className="sp-status-dot green" aria-hidden />
            dumped
            <button
              type="button"
              className="btn-link sp-status-pill-btn"
              onClick={() => {
                void navigator.clipboard.writeText(dumpStatus.path);
              }}
              title="Copy path to clipboard"
            >
              copy
            </button>
            <button
              type="button"
              className="btn-link sp-status-pill-btn"
              onClick={() => {
                setDumpStatus({ kind: 'idle' });
              }}
              title="Dismiss"
              aria-label="Dismiss dump notice"
            >
              ✕
            </button>
          </span>
        ) : dumpStatus.kind === 'error' ? (
          <span
            className="sp-status-pill mono warn"
            title={dumpStatus.message}
            data-testid="dump-result"
          >
            <span className="sp-status-dot amber" aria-hidden />
            dump → clipboard fallback
            <button
              type="button"
              className="btn-link sp-status-pill-btn"
              onClick={() => {
                setDumpStatus({ kind: 'idle' });
              }}
              title="Dismiss"
              aria-label="Dismiss dump notice"
            >
              ✕
            </button>
          </span>
        ) : null}
      </div>

      {!hasDeeperPagePermission && !deeperAccessBannerDismissed ? (
        <div
          className="banner warning deeper-access-banner"
          role="status"
          aria-live="polite"
          data-testid="deeper-access-banner"
        >
          <div className="deeper-access-banner-body">
            <strong>Deeper page access not granted.</strong>{' '}
            Engagement tracking (focus, scroll, copy) and future in-page features
            need it. URL + title observation already works without it.
          </div>
          <div className="deeper-access-banner-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={deeperAccessBannerBusy}
              onClick={() => {
                void handleGrantDeeperPageAccess();
              }}
            >
              {deeperAccessBannerBusy ? 'Requesting…' : 'Grant access'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDeeperAccessBannerDismissed(true);
              }}
              aria-label="Dismiss banner"
            >
              Not now
            </button>
          </div>
        </div>
      ) : null}

      {viewMode === 'workstream' ? (
        <WorkstreamBar
          currentWsLabel={currentWsLabel}
          statusLabel={companionStatusLabel(state.companionStatus)}
          onOpenPicker={() => {
            setWsPickerOpen(true);
          }}
          onAddSubWorkstream={() => {
            setWsPickerOpen(true);
            setWsPickerCreateMode(true);
          }}
          onOpenDetail={
            currentWsId === null
              ? undefined
              : () => {
                  setWorkstreamDetailOpen(true);
                  // Hydrate trust state from the companion. Without
                  // this the panel showed its hard-coded useState
                  // defaults (mostly deny), which after the
                  // allow-by-default companion change painted the
                  // wrong story. Best-effort: on companion absence
                  // or fetch failure we fall back to the in-memory
                  // state, which we now seed all-allowed at mount.
                  if (port.length > 0 && bridgeKey.length > 0) {
                    void (async () => {
                      try {
                        const url = `http://127.0.0.1:${port}/v1/workstreams/${currentWsId}/trust`;
                        const response = await fetch(url, {
                          headers: { 'x-bac-bridge-key': bridgeKey },
                        });
                        if (!response.ok) return;
                        const body = (await response.json()) as {
                          readonly data?: { readonly allowedTools?: readonly string[] };
                        };
                        const allowed = new Set(body.data?.allowedTools ?? []);
                        setWorkstreamDetailTrust((prev) =>
                          prev.map((entry) => ({ ...entry, allowed: allowed.has(entry.tool) })),
                        );
                      } catch {
                        // Leave state as-is; the in-memory defaults
                        // already match the companion's allow-by-
                        // default semantic for unseen workstreams.
                      }
                    })();
                  }
                  // Fire-and-forget linked-notes fetch when companion is
                  // configured. Empty list is a fine fallback.
                  if (port.length > 0 && bridgeKey.length > 0) {
                    void (async () => {
                      try {
                        const url = `http://127.0.0.1:${port}/v1/workstreams/${currentWsId}/linked-notes`;
                        const response = await fetch(url, {
                          headers: { 'x-bac-bridge-key': bridgeKey },
                        });
                        if (!response.ok) return;
                        const body = (await response.json()) as {
                          readonly data?: { readonly items?: readonly unknown[] };
                        };
                        const items = body.data?.items;
                        if (!Array.isArray(items)) return;
                        setWorkstreamDetailLinkedNotes(
                          items
                            .filter(
                              (
                                item,
                              ): item is {
                                readonly notePath: string;
                                readonly title: string;
                                readonly updatedAt: string;
                              } =>
                                typeof item === 'object' &&
                                item !== null &&
                                typeof (item as { readonly notePath?: unknown }).notePath ===
                                  'string',
                            )
                            .map((item, idx) => ({
                              id: `${item.notePath}-${String(idx)}`,
                              title: item.title,
                              relativePath: item.notePath,
                              editedAt: item.updatedAt,
                            })),
                        );
                      } catch {
                        // Empty list — UI shows the empty state.
                      }
                    })();
                  }
                }
          }
        />
      ) : (
        <div className="ws-bar all-bar">
          <span className="lbl">
            {viewMode === 'inbox'
              ? 'Inbox'
              : viewMode === 'connections'
                ? 'Connections'
                : 'All threads'}
          </span>
          <span className="ws-status mono">{companionStatusLabel(state.companionStatus)}</span>
        </div>
      )}

      <section
        className={
          'tab-attribution-card' +
          (focusedTabSession !== undefined
            ? ' is-active'
            : liveActiveTabUrl !== undefined
              ? ' is-loading'
              : ' is-empty')
        }
        data-testid="focused-tab-attribution"
        aria-label="Current tab attribution"
      >
        <div className="tab-attribution-card-head">
          <span className="tab-attribution-card-eyebrow mono">Current tab</span>
          {focusedTabSession !== undefined ? (
            <span
              className="tab-attribution-card-title"
              title={focusedTabSession.latestUrl ?? tabSessionDisplayTitle(focusedTabSession)}
            >
              {tabSessionDisplayTitle(focusedTabSession)}
            </span>
          ) : liveActiveTabUrl !== undefined ? (
            // Optimistic render before urlProjection has the entry.
            // The companion takes a few seconds to materialize the visit
            // (observe → drain → projection → 4 s side-panel poll).
            // Showing the live tab title + host instead of "No tracked
            // tab in focus" gives instant feedback that the side panel
            // sees the navigation.
            <span
              className="tab-attribution-card-title subtle"
              title={liveActiveTabUrl}
            >
              {liveActiveTabTitle ?? (() => {
                try { return new URL(liveActiveTabUrl).hostname; } catch { return liveActiveTabUrl; }
              })()}
              <span className="tab-attribution-card-pending mono"> (capturing…)</span>
            </span>
          ) : (
            <span className="tab-attribution-card-title subtle">No tracked tab in focus</span>
          )}
          {focusedTabSession !== undefined && focusedTabSession.latestUrl !== undefined ? (
            <button
              type="button"
              className="tab-session-go-to"
              onClick={() => {
                openTabForSession(focusedTabSession);
              }}
              title="Switch to this tab or reopen it"
              aria-label="Go to tab"
              data-testid="focused-tab-go-to"
            >
              <span className="icon-12" aria-hidden>
                {Icons.arrowR}
              </span>
              <span>Go to</span>
            </button>
          ) : null}
        </div>
        <div className="tab-attribution-card-body">
          <span className="tab-attribution-card-prefix mono">In workstream:</span>
          <AttributionBadge
            record={focusedTabSession}
            suggestion={
              focusedTabSuggestion === undefined
                ? undefined
                : tabSessionResolutionFromUrl(focusedTabSuggestion)
            }
            workstreams={tabSessionWorkstreams}
          />
          {/* Suggestion stats: bucket label + ⓘ tooltip + alternatives.
              Renders for any unattributed/un-ignored focused URL — when
              the resolver has no candidates we still draw the empty
              placeholder so the user sees why the badge is "?". */}
          {focusedUrlRecord !== undefined &&
          focusedUrlRecord.currentAttribution === undefined &&
          focusedUrlRecord.currentIgnored === undefined ? (
            <SuggestionStats
              suggestion={
                focusedTabSuggestion === undefined
                  ? undefined
                  : tabSessionResolutionFromUrl(focusedTabSuggestion)
              }
              workstreams={tabSessionWorkstreams}
              showAlternatives
              showEmptyPlaceholder
            />
          ) : null}
          {/* Stage 5 polish — the legacy "Change…" button used to live
              here. Removed because the flat 4-action bar below already
              has "Pick another…" with the same behavior (opens the
              WorkstreamPicker); rendering both was a duplicate
              affordance the user flagged. */}
        </div>
        {/* Action bar: shows up when there's a focused URL. All four
            choices flat — no overflow menu — so every state from the
            5-state attribution model has a directly-clickable
            affordance. "Yes, that's right" only renders when a
            high-enough suggestion exists; the other three always
            render so the user can take the corresponding action even
            when no suggestion is present. */}
        {focusedUrlRecord !== undefined ? (
          <div className="tab-attribution-card-actions">
            {focusedTabSuggestion !== undefined &&
            focusedTabSuggestion.decision.workstreamId !== undefined &&
            focusedUrlRecord.currentAttribution === undefined &&
            focusedUrlRecord.currentIgnored === undefined ? (
              <button
                type="button"
                className="tab-attribution-card-action primary"
                onClick={() => {
                  if (focusedTabSuggestion.decision.workstreamId !== undefined) {
                    handleUrlAttribute(
                      focusedUrlRecord.canonicalUrl,
                      focusedTabSuggestion.decision.workstreamId,
                    );
                  }
                }}
                title="Confirm the suggested workstream"
              >
                Yes, that's right
              </button>
            ) : null}
            <button
              type="button"
              className="tab-attribution-card-action"
              onClick={() => {
                setTabSessionMoveId(focusedUrlRecord.canonicalUrl);
              }}
              title="Pick a different workstream"
            >
              Pick another…
            </button>
            <button
              type="button"
              className="tab-attribution-card-action"
              onClick={() => {
                handleUrlAttribute(focusedUrlRecord.canonicalUrl, null);
              }}
              title="This page is meaningful but doesn't belong to any workstream"
            >
              Not in any stream
            </button>
            <button
              type="button"
              className="tab-attribution-card-action"
              onClick={() => {
                handleUrlIgnore(focusedUrlRecord.canonicalUrl, 'noise');
              }}
              title="Mute this URL — don't bother me about it again"
            >
              Ignore (admin / noise)
            </button>
            {/* Cross-surface jump to Connections, mirroring the
                InboxCard "⇄ Graph" affordance. Anchors on the
                timeline-visit for this URL so the user can see the
                neighborhood that does (or doesn't) exist yet — useful
                when SuggestionStats says "No signal yet" and the user
                wants to know what evidence the resolver had. */}
            <button
              type="button"
              className="tab-attribution-card-action"
              onClick={() => {
                requestSwitchToConnections(focusedUrlRecord.canonicalUrl);
              }}
              title="Open this URL's neighborhood in the Connections graph"
              data-testid="focused-tab-open-in-connections"
            >
              ⇄ Graph
            </button>
          </div>
        ) : null}
      </section>

      {suggestedOpenTabSession !== undefined && suggestedOpenTabSessionResolution !== undefined ? (
        <SuggestionBanner
          record={suggestedOpenTabSession}
          suggestion={tabSessionResolutionFromUrl(suggestedOpenTabSessionResolution)}
          workstreams={tabSessionWorkstreams}
          onAttribute={handleUrlAttribute}
          onPickAnother={(canonicalUrl) => {
            setTabSessionMoveId(canonicalUrl);
          }}
          onIgnore={handleUrlIgnore}
        />
      ) : null}

      {threadSearchOpen ? (
        <form
          className="thread-search-panel"
          role="search"
          aria-label="Search indexed threads"
          onSubmit={(event) => {
            event.preventDefault();
            runThreadSearch();
          }}
        >
          <div className="thread-search-row">
            <span className="thread-search-icon" aria-hidden>
              {Icons.search}
            </span>
            <input
              type="search"
              className="thread-search-input mono"
              placeholder="Search indexed threads"
              value={threadSearchQuery}
              onChange={(event) => {
                setThreadSearchQuery(event.target.value);
                if (event.target.value.trim().length === 0) {
                  setThreadSearchResults([]);
                  setThreadSearchState('idle');
                  setThreadSearchError(null);
                }
              }}
              autoFocus
            />
            <button
              type="submit"
              className="thread-search-submit"
              disabled={threadSearchState === 'loading' || threadSearchQuery.trim().length === 0}
            >
              {threadSearchState === 'loading' ? 'Searching' : 'Search'}
            </button>
          </div>
          {threadSearchError !== null ? (
            <div className="thread-search-note err">{threadSearchError}</div>
          ) : null}
          {threadSearchState !== 'loading' &&
          threadSearchQuery.trim().length > 0 &&
          threadSearchResults.length === 0 &&
          threadSearchError === null ? (
            <div className="thread-search-note">No indexed thread matches yet.</div>
          ) : null}
          {threadSearchResults.length > 0 ? (
            <div className="thread-search-results">
              {threadSearchResults.map((result) => {
                const local = findThreadForSearchResult(result);
                return (
                  <div className="thread-search-result" key={`${result.id}-${result.threadId}`}>
                    <button
                      type="button"
                      className="thread-search-result-main"
                      onClick={() => {
                        focusThreadSearchResult(result);
                      }}
                    >
                      <span className="thread-search-title">
                        {result.title ?? local?.title ?? result.threadId}
                      </span>
                      <span className="thread-search-meta mono">
                        score {result.score.toFixed(2)} · {formatRelative(result.capturedAt)}
                      </span>
                      {result.snippet !== undefined && result.snippet.length > 0 ? (
                        <span className="thread-search-snippet">{result.snippet}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="thread-search-open mono"
                      onClick={() => {
                        openThreadSearchResult(result);
                      }}
                    >
                      open
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </form>
      ) : null}

      {/* Workstream chip selector. Hidden on Inbox + Connections
          views: in those views the user is triaging unattributed
          pages or exploring the graph, not picking a workstream to
          focus. "Workstream:" label here renames PR-141-era
          "focused workstream" wording — the browser tab is the
          only "focus" in the panel. */}
      {viewMode === 'workstream' || viewMode === 'all' ? (
      <div className="ws-drop-strip" aria-label="Pick a workstream">
        {state.workstreams.map((workstream) => (
          <button
            type="button"
            key={workstream.bac_id}
            className={
              'ws-picker-pill' +
              (workstream.bac_id === currentWsId ? ' current' : '') +
              (dropWorkstreamId === workstream.bac_id ? ' drop-target' : '')
            }
            onClick={() => {
              setCurrentWs(workstream.bac_id);
            }}
            onDragOver={(event) => {
              allowThreadDrop(event, workstream.bac_id);
            }}
            onDragLeave={() => {
              setDropWorkstreamId((current) => (current === workstream.bac_id ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              handleWorkstreamDrop(event, workstream.bac_id);
            }}
          >
            {workstream.title}
          </button>
        ))}
      </div>
      ) : null}

      {wsPickerOpen ? (
        <WorkstreamPicker
          workstreams={state.workstreams}
          threads={threads}
          currentWsId={currentWsId}
          createMode={wsPickerCreateMode}
          onClose={() => {
            setWsPickerOpen(false);
            setWsPickerCreateMode(false);
          }}
          onSelect={(id) => {
            setCurrentWs(id);
            setWsPickerOpen(false);
            setWsPickerCreateMode(false);
          }}
          onCreate={(title, parentId, description) => {
            void runAction(async () => {
              return await sendRequest({
                type: messageTypes.createWorkstream,
                workstream: {
                  title,
                  ...(parentId === null ? {} : { parentId }),
                  privacy: 'shared',
                  ...(description !== undefined && description.length > 0 ? { description } : {}),
                },
              });
            }).then(() => {
              setWsPickerCreateMode(false);
            });
          }}
          /* When opening from "+", default new workstream parent = current */
          parentForNew={currentWsId}
        />
      ) : null}

      {tabSessionMoveId !== null ? (
        <WorkstreamPicker
          workstreams={state.workstreams}
          threads={threads}
          /* tabSessionMoveId is the canonical URL post-Phase B. */
          currentWsId={
            urlProjection?.byCanonicalUrl[tabSessionMoveId]?.currentAttribution?.workstreamId ??
            null
          }
          createMode={false}
          onClose={() => {
            setTabSessionMoveId(null);
          }}
          onSelect={(id) => {
            handleUrlAttribute(tabSessionMoveId, id);
            setTabSessionMoveId(null);
          }}
          onCreate={(title, parentId, description) => {
            void runAction(async () => {
              return await sendRequest({
                type: messageTypes.createWorkstream,
                workstream: {
                  title,
                  ...(parentId === null ? {} : { parentId }),
                  privacy: 'shared',
                  ...(description !== undefined && description.length > 0 ? { description } : {}),
                },
              });
            });
          }}
          parentForNew={null}
        />
      ) : null}

      {pendingCodingOffers.length > 0
        ? (() => {
            const offer = pendingCodingOffers[0];
            const surfaceLabel =
              offer.surface.id === 'codex'
                ? 'Codex'
                : offer.surface.id === 'claude_code'
                  ? 'Claude Code'
                  : 'Cursor';
            return (
              <CodingOfferBanner
                key={offer.tabId}
                offer={{
                  tabId: offer.tabId,
                  surfaceLabel,
                  suggestedWorkstreamLabel: currentWsLabel,
                }}
                onAccept={() => {
                  void markStatus(offer.tabId, 'accepted').then(() => {
                    setPendingCodingOffers((prev) => prev.filter((o) => o.tabId !== offer.tabId));
                    setCodingAttachOpen(true);
                  });
                }}
                onDismiss={() => {
                  void markStatus(offer.tabId, 'declined').then(() => {
                    setPendingCodingOffers((prev) => prev.filter((o) => o.tabId !== offer.tabId));
                  });
                }}
              />
            );
          })()
        : null}

      <UpdateBanner
        companionPort={port.length > 0 ? Number(port) : null}
        bridgeKey={bridgeKey.length > 0 ? bridgeKey : null}
        onUpdate={() => {
          setSettingsOpen(true);
        }}
      />

      {hasSystemBanners ? (
        <div className="banner-stack">
          <SystemBannersStack
            captureSuccessHost={captureToastHost ?? undefined}
            companionActionLabel="Open setup"
            companionStatus={companionDisconnected ? 'down' : 'running'}
            relayStatus={relayStatusForBanner}
            vaultStatus={vaultUnreachable ? 'unreachable' : 'connected'}
            providerHealth={providerHealth ? 'degraded' : 'ok'}
            providerHealthDetail={providerHealth?.warning}
            queuedCount={state.queuedCaptureCount}
            failedCount={state.failedCaptureCount ?? 0}
            {...(state.lastQueueRejectionAt === undefined
              ? {}
              : { lastRejectionAt: state.lastQueueRejectionAt })}
            onQueueDiagnostic={() => {
              void refresh();
            }}
            onRePickVault={() => {
              setWizardOpen(true);
            }}
            onRetryCompanion={() => {
              setWizardOpen(true);
            }}
            onRetryFailedCaptures={() => {
              void runAction(async () => sendRequest({ type: messageTypes.retryFailedCaptures }));
            }}
          />
        </div>
      ) : null}

      {error ? <div className="banner danger">{error}</div> : null}

      {viewMode === 'connections' ? (
        <ConnectionsView
          {...(currentWsId === null ? {} : { initialAnchor: `workstream:${currentWsId}` })}
          displayCtx={displayCtx}
          requestAnchor={connectionsAnchorRequest}
          onRequestConsumed={() => {
            setConnectionsAnchorRequest('');
          }}
          onOpenInInbox={requestSwitchToInbox}
          workstreamAnchors={state.workstreams.map((w) => ({
            id: `workstream:${w.bac_id}`,
            label: workstreamPath(w.bac_id, state.workstreams),
          }))}
          recentAnchors={[
            ...[...state.threads]
              .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
              .slice(0, 6)
              .map((t) => {
                // Never fall back to the raw threadUrl as a visible label —
                // it's how the URL leak showed up in the recent-anchors strip.
                // Title first, then host of the thread URL, then a kind label.
                const label =
                  t.title.trim().length > 0
                    ? t.title
                    : (hostOf(t.threadUrl) ?? '(untitled thread)');
                return {
                  id: `thread:${t.bac_id}`,
                  kind: 'thread' as const,
                  label,
                };
              }),
            ...[...state.workstreams].slice(0, 3).map((w) => ({
              id: `workstream:${w.bac_id}`,
              kind: 'workstream' as const,
              // Always render the path (parent walk) — never the bac_id.
              label: workstreamPath(w.bac_id, state.workstreams),
            })),
          ]}
          onOpenUrl={(url) => {
            void (async () => {
              try {
                const tabs = await chrome.tabs.query({ url });
                const live = tabs.find((t) => typeof t.id === 'number');
                if (live !== undefined && typeof live.id === 'number') {
                  await chrome.tabs.update(live.id, { active: true });
                  if (live.windowId !== undefined) {
                    await chrome.windows.update(live.windowId, { focused: true });
                  }
                  return;
                }
              } catch {
                // host_permission may be missing for arbitrary URLs.
              }
              await chrome.tabs.create({ url });
            })();
          }}
        />
      ) : viewMode === 'workstream' ? (
        <>
          <div className="sec-head">
            <span>Open threads</span>
            <span className="count mono">
              {String(activeCount)} active
              {staleCount > 0 ? ' · ' + String(staleCount) + ' stale' : ''}
            </span>
          </div>
          <div className="thread-list">
            {currentWsThreads.length === 0 && currentWsCodingSessions.length === 0 ? (
              <div className="thread-empty subtle">
                <p>No threads here yet.</p>
                <button
                  type="button"
                  className="btn-link"
                  disabled={busy}
                  onClick={() => {
                    void runAction(() => sendRequest({ type: messageTypes.captureCurrentTab }));
                  }}
                >
                  Track current tab →
                </button>
              </div>
            ) : null}
            {currentWsCodingSessions.map(renderCodingSessionRow)}
            {ALL_THREAD_BUCKET_ORDER.map((bucket) => {
              const list = currentWsThreadsByBucket.get(bucket) ?? [];
              if (list.length === 0) {
                return null;
              }
              const collapsed = state.collapsedBuckets.includes(bucket);
              return (
                <div
                  className={
                    'thread-bucket thread-bucket-' + bucket + (collapsed ? ' collapsed' : '')
                  }
                  key={bucket}
                >
                  <button
                    type="button"
                    className="thread-bucket-head"
                    aria-expanded={!collapsed}
                    onClick={() => {
                      toggleThreadBucket(bucket);
                    }}
                  >
                    <span className="thread-bucket-label">
                      <span className="thread-bucket-chevron" aria-hidden>
                        {collapsed ? '▸' : '▾'}
                      </span>
                      {ALL_THREAD_BUCKET_LABEL[bucket]}
                    </span>
                    <span className="thread-bucket-count mono">{String(list.length)}</span>
                  </button>
                  {collapsed ? null : (
                    <div className="thread-list">{list.map(renderThreadRow)}</div>
                  )}
                </div>
              );
            })}
          </div>
          {currentWsId !== null ? (
            <>
              <div className="sec-head">
                <span>Pages in this workstream</span>
                <span className="count mono">{String(currentWorkstreamTabSessions.length)}</span>
              </div>
              {currentWorkstreamTabSessions.length === 0 ? (
                <div className="thread-empty subtle">No pages attributed here yet.</div>
              ) : (
                <div className="tab-session-list">
                  {currentWorkstreamTabSessions.map((record) => {
                    // `record.tabSessionId` is the canonical URL (see
                    // tabSessionRecordFromUrl). Suggestions are keyed
                    // the same way, so this lookup just works.
                    const urlSuggestion = urlSuggestions[record.tabSessionId];
                    return (
                      <InboxCard
                        key={record.tabSessionId}
                        record={record}
                        {...(urlSuggestion === undefined
                          ? {}
                          : { suggestion: tabSessionResolutionFromUrl(urlSuggestion) })}
                        workstreams={tabSessionWorkstreams}
                        onAttribute={handleUrlAttribute}
                        onOpenTab={openTabForSession}
                        onPickAnother={(canonicalUrl) => {
                          setTabSessionMoveId(canonicalUrl);
                        }}
                        onIgnore={handleUrlIgnore}
                        displayCtx={displayCtx}
                        onOpenInConnections={requestSwitchToConnections}
                      />
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </>
      ) : viewMode === 'inbox' ? (
        <InboxView
          // Per-URL Inbox (Phase B). Records are synthesized from
          // urlInbox; each record's `tabSessionId` field carries the
          // canonical URL, and onAttribute dispatches to the URL
          // attribution endpoint.
          //
          // Dedupe against the focused tab: the Current Tab card at
          // the top of the panel is its own surface for the URL in
          // focus, so showing the same canonical URL twice (once at
          // the top, once in the Inbox list) is the "dup items"
          // confusion. Filter it out here.
          inbox={{
            items: urlInbox.items
              .map(tabSessionRecordFromUrl)
              .filter(
                (item) =>
                  focusedUrlRecord === undefined ||
                  item.tabSessionId !== focusedUrlRecord.canonicalUrl,
              ),
            total: urlInbox.total,
            limit: urlInbox.limit,
            offset: urlInbox.offset,
          }}
          // Stage 5 follow-up — only surface the loading line on the
          // actual first load (no projection yet). Subsequent fetches
          // swap data silently so existing cards don't shift down.
          loading={tabSessionLoading && tabSessionProjection === null && urlProjection === null}
          error={tabSessionError}
          workstreams={tabSessionWorkstreams}
          suggestions={Object.fromEntries(
            Object.entries(urlSuggestions).map(([canonicalUrl, result]) => [
              canonicalUrl,
              tabSessionResolutionFromUrl(result),
            ]),
          )}
          onRefresh={() => {
            void loadTabSessions();
          }}
          onAttribute={handleUrlAttribute}
          onOpenTab={openTabForSession}
          onPickAnother={(canonicalUrl) => {
            setTabSessionMoveId(canonicalUrl);
          }}
          onIgnore={handleUrlIgnore}
          displayCtx={displayCtx}
          onOpenInConnections={requestSwitchToConnections}
          onRefreshSuggestion={(canonicalUrl) => {
            void refreshUrlSuggestion(canonicalUrl);
          }}
          refreshingSuggestionIds={refreshingUrlSuggestionIds}
          initialQuery={inboxSearchRequest}
          onQueryConsumed={() => {
            setInboxSearchRequest('');
          }}
        />
      ) : (
        <>
          <div className="sec-head">
            <span>All threads</span>
            <span className="count mono">
              {String(threads.length)} total · grouped by lifecycle
            </span>
          </div>
          {ALL_THREAD_BUCKET_ORDER.map((bucket) => {
            const list = allThreadsByBucket.get(bucket) ?? [];
            if (list.length === 0) {
              return null;
            }
            const collapsed = state.collapsedBuckets.includes(bucket);
            return (
              <div
                className={
                  'thread-bucket thread-bucket-' + bucket + (collapsed ? ' collapsed' : '')
                }
                key={bucket}
              >
                <button
                  type="button"
                  className="thread-bucket-head"
                  aria-expanded={!collapsed}
                  onClick={() => {
                    toggleThreadBucket(bucket);
                  }}
                >
                  <span className="thread-bucket-label">
                    <span className="thread-bucket-chevron" aria-hidden>
                      {collapsed ? '▸' : '▾'}
                    </span>
                    {ALL_THREAD_BUCKET_LABEL[bucket]}
                  </span>
                  <span className="thread-bucket-count mono">{String(list.length)}</span>
                </button>
                {collapsed ? null : <div className="thread-list">{list.map(renderThreadRow)}</div>}
              </div>
            );
          })}
        </>
      )}

      {(() => {
        // Recent Dispatches: chronological log of packets sent out of
        // Sidetrack (review submit-backs, dispatch-out packets, coding
        // agent packets). Only render when there's at least one.
        const dispatches = state.recentDispatches.slice(0, 12);
        if (dispatches.length === 0) {
          return null;
        }
        const linksMap = state.dispatchLinks;
        const dispatchEvents: RecentDispatchEvent[] = dispatches.map((d) => {
          const sourceTitle =
            state.threads.find((t) => t.bac_id === d.sourceThreadId)?.title ?? d.title;
          // Auto-link: if the matcher paired this dispatch to a
          // captured destination thread, surface its title so the
          // row reads "→ Gemini · my new chat" instead of "pending
          // chat". The action button also flips to "↗ open".
          const linkedThreadId = linksMap[d.bac_id];
          const linkedThread =
            linkedThreadId === undefined
              ? undefined
              : state.threads.find((t) => t.bac_id === linkedThreadId);
          return {
            bac_id: d.bac_id,
            sourceTitle,
            targetProviderLabel: DISPATCH_PROVIDER_LABEL[d.target.provider] ?? d.target.provider,
            ...(linkedThread === undefined ? {} : { targetThreadTitle: linkedThread.title }),
            mode: d.target.mode,
            dispatchKind: DISPATCH_KIND_TO_DISPLAY[d.kind] ?? 'dispatch_out',
            dispatchedAt: formatRelative(d.createdAt),
            status: DISPATCH_STATUS_TO_DISPLAY(d.status),
          };
        });
        // Helper: map companion target.provider → ComposedPacket
        // target shape used by TARGET_CHAT_URL.
        const lookupChatUrl = (provider: string): string | undefined => {
          const targetKey = (
            provider === 'chatgpt'
              ? 'gpt_pro'
              : provider === 'claude_code'
                ? 'claude_code'
                : provider
          ) as keyof typeof TARGET_CHAT_URL;
          return TARGET_CHAT_URL[targetKey];
        };
        return (
          <>
            <div className="sec-head">
              <span>Recent dispatches</span>
              <span className="sec-head-actions">
                <span className="count mono">{String(dispatchEvents.length)}</span>
              </span>
            </div>
            <RecentDispatches
              dispatches={dispatchEvents}
              onFocusSource={(id) => {
                const dispatch = state.recentDispatches.find((d) => d.bac_id === id);
                if (dispatch === undefined) {
                  return;
                }
                const thread = state.threads.find((t) => t.bac_id === dispatch.sourceThreadId);
                if (thread !== undefined) {
                  openTabForThread(thread);
                  return;
                }
                setError(
                  'Source thread is no longer tracked (archived or removed). Use the target side of the row to reopen the destination chat.',
                );
              }}
              onOpenTarget={(id) => {
                // For LINKED rows: jump to the destination thread (if
                // we still track it). For UNLINKED rows: open the
                // customize composer pre-populated from the source
                // thread (auto-send on by default for AI providers
                // per the per-provider opt-in). The new Dispatch
                // button (always-visible) handles the no-customize
                // fast path; the view button still exists if the
                // user just wants to inspect the body.
                const dispatch = state.recentDispatches.find((d) => d.bac_id === id);
                if (dispatch === undefined) {
                  return;
                }
                const linkedThreadId = linksMap[id];
                if (linkedThreadId !== undefined) {
                  const linkedThread = state.threads.find((t) => t.bac_id === linkedThreadId);
                  if (linkedThread !== undefined) {
                    openTabForThread(linkedThread);
                    return;
                  }
                }
                if (dispatch.sourceThreadId !== undefined) {
                  setComposeThreadId(dispatch.sourceThreadId);
                  return;
                }
                // Source thread untracked / vanished — fall back to
                // the read-only viewer.
                setViewingDispatchId(id);
              }}
              onView={(id) => {
                setViewingDispatchId(id);
              }}
              onCopy={(id) => {
                // Paste-mode action: re-copy + open new chat. Use the
                // unredacted body (cached locally on submit) so the
                // user pastes the same text the matcher will compare
                // against — see dispatchLinking.ts and the viewer
                // modal below.
                const dispatch = state.recentDispatches.find((d) => d.bac_id === id);
                if (dispatch === undefined) {
                  return;
                }
                const bodyToShip = state.dispatchOriginals[id] ?? dispatch.body;
                const url = lookupChatUrl(dispatch.target.provider);
                if (url === undefined) {
                  // Export / external target → open viewer instead.
                  setViewingDispatchId(id);
                  return;
                }
                void navigator.clipboard
                  .writeText(bodyToShip)
                  .then(() => {
                    setError(
                      `Re-copied packet to clipboard. Opening ${TARGET_PROVIDER_LABEL[dispatch.target.provider] ?? dispatch.target.provider} — paste to send.`,
                    );
                  })
                  .catch(() => {
                    setError(
                      `Could not re-copy to clipboard. Click "view" to open the body and copy manually.`,
                    );
                  });
                window.open(url, '_blank', 'noopener,noreferrer');
              }}
              onDispatch={(id) => {
                // Auto-send mode action: open the target tab AND
                // auto-send via the orchestrator. Background owns the
                // "wait for tab to load → inject content script →
                // autoSendItem" flow.
                const dispatch = state.recentDispatches.find((d) => d.bac_id === id);
                if (dispatch === undefined) {
                  return;
                }
                const bodyToShip = state.dispatchOriginals[id] ?? dispatch.body;
                const url = lookupChatUrl(dispatch.target.provider);
                if (url === undefined) {
                  setViewingDispatchId(id);
                  return;
                }
                void runAction(async () => {
                  await sendRequest({
                    type: messageTypes.dispatchAutoSendInNewTab,
                    dispatchId: id,
                    url,
                    body: bodyToShip,
                  });
                  setError(
                    `Opening ${TARGET_PROVIDER_LABEL[dispatch.target.provider] ?? dispatch.target.provider} and auto-sending the packet…`,
                  );
                  return await sendRequest({ type: messageTypes.getWorkboardState });
                });
              }}
              showArchived={showArchivedDispatches}
              onToggleShowArchived={() => {
                setShowArchivedDispatches((prev) => !prev);
              }}
              onArchive={(id) => {
                void runAction(() =>
                  sendRequest({ type: messageTypes.archiveDispatch, dispatchId: id }),
                );
              }}
              onUnarchive={(id) => {
                void runAction(() =>
                  sendRequest({ type: messageTypes.unarchiveDispatch, dispatchId: id }),
                );
              }}
            />
          </>
        );
      })()}

      <div className="sec-head">
        <span>Captures</span>
        <span className="sec-head-actions">
          <span className="count mono">{String(scopedNotes.length)}</span>
          <button
            type="button"
            className="btn-link sec-head-btn"
            title={
              currentWsId === null ? 'Add a note in the Inbox' : `Add a note in ${currentWsLabel}`
            }
            onClick={() => {
              setNoteEditId(null);
              setNoteDraft('');
              setNoteComposeOpen(true);
            }}
          >
            + note
          </button>
        </span>
      </div>
      {noteComposeOpen ? (
        <form
          className="note-compose"
          onSubmit={(e) => {
            e.preventDefault();
            submitNote();
          }}
        >
          <textarea
            autoFocus
            rows={3}
            placeholder={
              currentWsId === null ? 'Note (lands in the Inbox)…' : `Note for ${currentWsLabel}…`
            }
            value={noteDraft}
            onChange={(e) => {
              setNoteDraft(e.target.value);
            }}
          />
          <div className="note-compose-actions">
            <button
              type="submit"
              className="btn-link"
              disabled={busy || noteDraft.trim().length === 0}
            >
              {noteEditId === null ? 'Save note' : 'Update note'}
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setNoteComposeOpen(false);
                setNoteDraft('');
                setNoteEditId(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="capture-list">
        {scopedNotes.length === 0 ? (
          <div className="capture-empty subtle">
            <p>
              Notes you save here are scoped to the current workstream. Inbound replies surface as
              the <strong>Unread reply</strong> badge on the thread row above. Obsidian / external
              imports come later.
            </p>
          </div>
        ) : null}
        {scopedNotes.slice(0, 12).map((note) => (
          <div className="capture capture-note" key={note.bac_id}>
            <svg viewBox="0 0 24 24" aria-hidden>
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
            <div className="capture-body">
              <div className="text">{note.text}</div>
              <div className="meta mono">
                note · {formatRelative(note.createdAt)}
                {note.kind !== 'manual' ? ` · ${note.kind}` : ''}
              </div>
              <div className="capture-actions">
                <button
                  type="button"
                  className="btn-link"
                  title="Edit this note"
                  onClick={() => {
                    beginEditNote(note.bac_id, note.text);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-link archive"
                  title="Delete this note"
                  onClick={() => {
                    deleteNote(note.bac_id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Build identity — small mono line at the very bottom of the
          side panel. Lets the user confirm the loaded extension
          matches their git state at a glance ("did the new build
          actually load?"). Sourced from the vite-define inject in
          wxt.config.ts. */}
      <div className="build-version mono" title="Sidetrack build identity">
        v{__BUILD_INFO__.version} · {__BUILD_INFO__.sha} · built{' '}
        {formatBuildTimestamp(__BUILD_INFO__.builtAt)}
      </div>

      {moveThread ? (
        <MoveToPicker
          currentPath={workstreamPath(moveThread.primaryWorkstreamId, state.workstreams)}
          itemTitle={moveThread.title}
          onClose={() => {
            setMoveThreadId(null);
          }}
          onMove={handleMoveTarget}
          workstreams={workstreamOptions}
        />
      ) : null}

      {composeThread ? (
        <PacketComposer
          defaultTitle={composeThread.title}
          {...(settings !== null
            ? { defaultKind: dispatchKindToUiPacketKind(settings.defaultPacketKind) }
            : {})}
          scope={{
            label: workstreamPath(composeWorkstream?.bac_id, state.workstreams),
            meta: `${composeThread.title} · ${providerLabel(composeThread.provider)} · ${formatRelative(composeThread.lastSeenAt)}`,
            sourceThreadId: composeThread.bac_id,
            threadUrl: composeThread.threadUrl,
            providerLabel: providerLabel(composeThread.provider),
            availableTurns: (composeTurnsByUrl.get(composeThread.threadUrl) ?? []).map((t) => ({
              role: t.role,
              text: t.text,
              capturedAt: t.capturedAt,
            })),
            ...(composeWorkstream !== undefined ? { workstreamId: composeWorkstream.bac_id } : {}),
            // Surface any staged inline-review draft so the composer
            // can offer an "Include N comments" toggle in the scope
            // options. The toggle defaults to ON when there's at least
            // one span; user can untoggle to dispatch without the
            // commentary.
            ...(state.reviewDrafts[composeThread.bac_id] !== undefined
              ? { reviewDraft: state.reviewDrafts[composeThread.bac_id] }
              : {}),
          }}
          scopeSuggestions={composeScopeSuggestionsByThread.get(composeThread.bac_id) ?? []}
          onScopeChange={(workstreamId) => {
            setComposeWorkstreamOverrideId(workstreamId);
          }}
          onCancel={() => {
            setComposeThreadId(null);
          }}
          onCopy={handlePacketCopy}
          onSave={handlePacketSave}
          onDispatch={handlePacketDispatch}
        />
      ) : null}

      {pendingDispatch ? (
        <DispatchConfirm
          target={
            TARGET_PROVIDER_LABEL[mapUiTarget(pendingDispatch.target)] ??
            mapUiTarget(pendingDispatch.target)
          }
          sourceLabel={(() => {
            // Surface the source thread's provider + model in the
            // confirm modal subtitle so the user sees which chat the
            // context came from. Display-only.
            if (pendingDispatch.sourceThreadId === undefined) return undefined;
            const sourceThread = state.threads.find(
              (t) => t.bac_id === pendingDispatch.sourceThreadId,
            );
            if (sourceThread === undefined) return undefined;
            const provLabel =
              TARGET_PROVIDER_LABEL[providerIdToDispatchProvider(sourceThread.provider)] ??
              sourceThread.provider;
            const model = sourceThread.selectedModel;
            return model === undefined || model.length === 0
              ? provLabel
              : `${provLabel} · ${model}`;
          })()}
          body={pendingDispatch.body}
          autoSendOptedIn={(() => {
            const t = pendingDispatch.target;
            if (t === 'markdown' || t === 'notebook') return false;
            if (t === 'codex' || t === 'claude_code' || t === 'cursor') return false;
            const provider = mapUiTarget(t);
            return (
              settings !== null && isProviderWithOptIn(provider) && settings.autoSendOptIn[provider]
            );
          })()}
          dispatchKind={(() => {
            // Map the packet target → side-effect lane the modal
            // uses for its "Will ..." header.
            const t = pendingDispatch.target;
            if (t === 'markdown' || t === 'notebook') return 'export' as const;
            if (t === 'codex' || t === 'claude_code' || t === 'cursor') return 'coding' as const;
            // AI providers: paste vs auto-send depends on the user's
            // settings + the thread's autoSendEnabled toggle.
            const provider = mapUiTarget(t);
            const autoOn =
              settings !== null &&
              isProviderWithOptIn(provider) &&
              settings.autoSendOptIn[provider];
            return autoOn ? ('chat-auto' as const) : ('chat-paste' as const);
          })()}
          tokenEstimate={pendingDispatch.tokenEstimate}
          redactedCount={pendingDispatch.redactedItems.reduce((sum, r) => sum + r.count, 0)}
          {...(pendingDispatch.redactedItems.length > 0
            ? {
                redactedKinds: pendingDispatch.redactedItems.map(
                  (r) => `${String(r.count)} ${r.kind}`,
                ),
              }
            : {})}
          onCancel={() => {
            setPendingDispatch(null);
          }}
          onEdit={() => {
            setComposeThreadId(pendingDispatch.sourceThreadId ?? composeThreadId);
            setPendingDispatch(null);
          }}
          onConfirm={() => {
            if (!dispatchInFlight) {
              void submitPendingDispatch();
            }
          }}
        />
      ) : null}

      {reviewThread
        ? (() => {
            const fetchedTurns = reviewTurnsByUrl.get(reviewThread.threadUrl);
            const realSpans =
              fetchedTurns !== undefined && fetchedTurns.length > 0
                ? fetchedTurns.map((turn) => ({
                    id: `turn_${String(turn.ordinal)}`,
                    text: turn.text.length > 600 ? `${turn.text.slice(0, 600)}…` : turn.text,
                    capturedAt: turn.capturedAt,
                  }))
                : [
                    {
                      id: `${reviewThread.bac_id}_overall`,
                      text: reviewThread.title,
                      capturedAt: reviewThread.lastSeenAt,
                    },
                  ];
            const spanContext = new Map(
              fetchedTurns !== undefined && fetchedTurns.length > 0
                ? fetchedTurns.map(
                    (turn) =>
                      [
                        `turn_${String(turn.ordinal)}`,
                        { text: turn.text, ordinal: turn.ordinal, capturedAt: turn.capturedAt },
                      ] as const,
                  )
                : [
                    [
                      `${reviewThread.bac_id}_overall`,
                      { text: reviewThread.title, ordinal: 0, capturedAt: reviewThread.lastSeenAt },
                    ] as const,
                  ],
            );
            return (
              <div
                className="modal-backdrop"
                onClick={() => {
                  setReviewThreadId(null);
                }}
              >
                <div
                  className="review-modal-shell"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <ReviewComposer
                    provider={providerLabel(reviewThread.provider)}
                    capturedAt={formatRelative(reviewThread.lastSeenAt)}
                    spans={realSpans}
                    onClose={() => {
                      setReviewThreadId(null);
                    }}
                    onSave={(payload) => {
                      if (reviewInFlight) {
                        return;
                      }
                      void submitReview(reviewThread, payload, 'save', spanContext).then((ok) => {
                        if (ok) {
                          setReviewThreadId(null);
                        }
                      });
                    }}
                    onSendBack={(payload) => {
                      if (reviewInFlight) {
                        return;
                      }
                      // 1) Record the review to the vault.
                      // 2) Queue the rendered comment as a follow-up
                      //    against the same thread.
                      // 3) Toggle auto-send on if it isn't already —
                      //    the orchestrator wired in feat/auto-send-drain
                      //    will paste-and-send into the live chat.
                      const perSpanLines = Object.entries(payload.perSpan)
                        .filter(([, comment]) => comment.trim().length > 0)
                        .map(([, comment], i) => `${String(i + 1)}. ${comment.trim()}`)
                        .join('\n');
                      const followUpBody = [
                        payload.reviewerNote.trim(),
                        perSpanLines.length > 0 ? `\n\nPer-span feedback:\n${perSpanLines}` : '',
                      ]
                        .join('')
                        .trim();
                      void submitReview(reviewThread, payload, 'submit_back', spanContext).then(
                        (reviewOk) => {
                          if (!reviewOk) {
                            return;
                          }
                          // Skip the queue+drain step if there's nothing
                          // to send (review-only save). Should not happen
                          // because the button is gated, but defend.
                          if (followUpBody.length === 0) {
                            setReviewThreadId(null);
                            return;
                          }
                          void runAction(async () => {
                            // Park the comment as a queue item against the
                            // source thread.
                            await sendRequest({
                              type: messageTypes.queueFollowUp,
                              item: {
                                text: followUpBody,
                                scope: 'thread',
                                targetId: reviewThread.bac_id,
                              },
                            });
                            // Make sure auto-send is on so the orchestrator
                            // ships the queued comment into the chat.
                            if (reviewThread.autoSendEnabled !== true) {
                              await sendRequest({
                                type: messageTypes.setThreadAutoSend,
                                threadId: reviewThread.bac_id,
                                enabled: true,
                              });
                            }
                            return await sendRequest({ type: messageTypes.getWorkboardState });
                          });
                          setReviewThreadId(null);
                        },
                      );
                    }}
                    onDispatchOut={(payload) => {
                      // Build the dispatch body from the user's review
                      // payload — verdict (optional now), note, and per-
                      // span comments paired with the (possibly edited)
                      // span text.
                      const perSpanBlocks = Object.entries(payload.perSpan)
                        .filter(([, comment]) => comment.trim().length > 0)
                        .map(([id, comment]) => {
                          const spanBody = payload.spanText[id] ?? '';
                          return [`> ${spanBody.replace(/\n/g, '\n> ')}`, '', comment.trim()].join(
                            '\n',
                          );
                        })
                        .join('\n\n---\n\n');
                      const body = [
                        `# Review notes`,
                        '',
                        `## Source thread`,
                        `${providerLabel(reviewThread.provider)} · ${reviewThread.threadUrl}`,
                        ...(payload.verdict !== null ? ['', `## Verdict`, payload.verdict] : []),
                        ...(payload.reviewerNote.trim().length > 0
                          ? ['', `## Reviewer note`, payload.reviewerNote]
                          : []),
                        ...(perSpanBlocks.length > 0
                          ? ['', `## Per-span feedback`, perSpanBlocks]
                          : []),
                      ].join('\n');
                      const dispatchPacket: ComposedPacket = {
                        kind: 'context_pack',
                        template: null,
                        target: 'claude',
                        title: `Review: ${reviewThread.title}`,
                        body,
                        scopeLabel: reviewThread.title,
                        sourceThreadId: reviewThread.bac_id,
                        ...(reviewThread.primaryWorkstreamId !== undefined
                          ? { workstreamId: reviewThread.primaryWorkstreamId }
                          : {}),
                        tokenEstimate: 0,
                        redactedItems: [],
                      };
                      setReviewThreadId(null);
                      setPendingDispatch(dispatchPacket);
                    }}
                  />
                </div>
              </div>
            );
          })()
        : null}

      {recoveryThread ? (
        <TabRecovery
          onClose={() => {
            setRecoveryThreadId(null);
          }}
          onFocusOpen={() => {
            restoreThread(recoveryThread.bac_id);
            setRecoveryThreadId(null);
          }}
          onReopenUrl={() => {
            restoreThread(recoveryThread.bac_id);
            setRecoveryThreadId(null);
          }}
          snapshot={{
            title: recoveryThread.title,
            url: recoveryThread.threadUrl,
            provider: providerLabel(recoveryThread.provider),
            favIconUrl: recoveryThread.tabSnapshot?.favIconUrl,
            capturedAt: recoveryThread.tabSnapshot?.capturedAt ?? recoveryThread.lastSeenAt,
            lastActiveAt: formatRelative(recoveryThread.lastSeenAt),
            restoreStrategy: restoreStrategyForThread(recoveryThread),
          }}
        />
      ) : null}

      {viewingDispatchId !== null
        ? (() => {
            const dispatch = state.recentDispatches.find((d) => d.bac_id === viewingDispatchId);
            if (dispatch === undefined) {
              return null;
            }
            // The companion stores a redacted body (PII / API keys
            // → [category] tokens). The matcher in dispatchLinking.ts
            // matches against the *unredacted* body cached locally on
            // submit — so the viewer must show + copy the unredacted
            // form too. Otherwise the user pastes the redacted text,
            // the matcher's needle (unredacted) never substring-hits
            // the captured turn, and the dispatch never links.
            const displayBody = state.dispatchOriginals[dispatch.bac_id] ?? dispatch.body;
            const targetLabel =
              TARGET_PROVIDER_LABEL[dispatch.target.provider] ?? dispatch.target.provider;
            const linkedThreadId = state.dispatchLinks[dispatch.bac_id];
            const oneHourAgo = Date.now() - 60 * 60 * 1000;
            const diagnostic =
              linkedThreadId !== undefined
                ? undefined
                : state.dispatchDiagnostics.find(
                    (entry) =>
                      entry.provider === dispatch.target.provider &&
                      Date.parse(entry.capturedAt) >= oneHourAgo,
                  );
            const close = () => {
              setViewingDispatchId(null);
            };
            return (
              <div className="modal-backdrop" onClick={close}>
                <div
                  className="dispatch-viewer"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  <div className="dispatch-viewer-head">
                    <div>
                      <h3 className="dispatch-viewer-title">{dispatch.title}</h3>
                      <div className="dispatch-viewer-meta mono">
                        {dispatch.kind} · {targetLabel} · {formatRelative(dispatch.createdAt)} ·{' '}
                        {dispatch.tokenEstimate.toLocaleString()} tokens
                      </div>
                    </div>
                    <button
                      type="button"
                      className="modal-close"
                      onClick={close}
                      aria-label="Close"
                    >
                      ✕
                    </button>
                  </div>
                  <textarea className="dispatch-viewer-body mono" value={displayBody} readOnly />
                  {diagnostic === undefined ? null : (
                    <details className="dispatch-diagnostic">
                      <summary>Why didn't this link?</summary>
                      <p>{dispatchDiagnosticReasonText(diagnostic.reason ?? 'no-prefix-match')}</p>
                      <dl className="dispatch-diagnostic-grid mono">
                        <div>
                          <dt>candidates</dt>
                          <dd>{String(diagnostic.candidatesConsidered)}</dd>
                        </div>
                        <div>
                          <dt>best prefix</dt>
                          <dd>{String(diagnostic.bestPrefixMatchLen)}</dd>
                        </div>
                      </dl>
                    </details>
                  )}
                  <div className="dispatch-viewer-foot">
                    <button type="button" className="btn btn-ghost" onClick={close}>
                      Close
                    </button>
                    <div className="spacer" />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        const safeTitle = dispatch.title
                          .replace(/[^a-z0-9-_]+/gi, '-')
                          .slice(0, 80);
                        downloadAsFile(`${safeTitle || 'sidetrack-dispatch'}.md`, displayBody);
                        setError(`Re-downloaded ${safeTitle || 'sidetrack-dispatch'}.md.`);
                      }}
                    >
                      ⤓ Download .md
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(displayBody)
                          .then(() => {
                            setError('Copied dispatch body to clipboard.');
                          })
                          .catch(() => {
                            setError('Could not copy — select the text above and copy manually.');
                          });
                      }}
                    >
                      Copy to clipboard
                    </button>
                  </div>
                </div>
              </div>
            );
          })()
        : null}

      {showWizard ? (
        <Wizard
          bridgeKey={bridgeKey}
          companionReachable={state.companionStatus === 'connected'}
          connectionError={wizardConnectionError}
          onClose={() => {
            // Lock the wizard open during first-launch (no Skip / Done
            // pressed yet) so users can't accidentally ESC out of setup.
            if (!inFirstLaunchMode) {
              setWizardOpen(false);
            }
          }}
          onFinish={() => {
            void completeSetup(true).catch((setupError: unknown) => {
              setError(
                setupError instanceof Error ? setupError.message : 'Could not finish setup.',
              );
            });
          }}
          onBridgeKeyChange={(value) => {
            setWizardConnectionError(null);
            setBridgeKey(value);
          }}
          onPortChange={(value) => {
            setWizardConnectionError(null);
            setPort(String(value));
          }}
          onSkip={() => {
            setWizardConnectionError(null);
            void completeSetup(false).catch((setupError: unknown) => {
              setError(
                setupError instanceof Error ? setupError.message : 'Could not finish setup.',
              );
            });
          }}
          onVaultPathChange={setVaultPath}
          port={Number.isFinite(Number(port)) && Number(port) > 0 ? Number(port) : 17_373}
          vaultPath={vaultPath}
        />
      ) : null}

      {codingAttachOpen ? (
        <CodingAttach
          {...(selectedWorkstream !== '' ? { defaultWorkstreamId: selectedWorkstream } : {})}
          workstreams={workstreamOptions}
          companionAvailable={state.companionStatus === 'connected'}
          mcpEndpoint={(() => {
            // Prefer the companion-managed MCP info from /v1/status —
            // its authKey is what the running MCP server actually
            // accepts. Fall back to the loopback default when the
            // companion isn't managing MCP (older setup where the
            // user starts sidetrack-mcp by hand).
            if (mcpInfo !== null) {
              return mcpInfo.url;
            }
            return 'http://127.0.0.1:8721/mcp';
          })()}
          mcpAuthBearer={mcpInfo?.authKey ?? (bridgeKey.length === 0 ? undefined : bridgeKey)}
          {...(mcpInfo?.health === undefined ? {} : { mcpHealth: mcpInfo.health })}
          {...(vaultRoot === null ? {} : { vaultRoot })}
          {...(bridgeKey.length === 0 ? {} : { bridgeKey })}
          companionPort={state.settings.companion.port}
          onCancel={() => {
            setCodingAttachOpen(false);
          }}
          onCreateToken={async (request) => {
            const response = await sendRequestRaw({
              type: messageTypes.createCodingAttachToken,
              request,
            });
            if (response.attachToken === undefined) {
              throw new Error('Companion did not return an attach token.');
            }
            setState(response.state);
            return response.attachToken;
          }}
          onPoll={async () => {
            // The background pulls fresh sessions from the companion in
            // every getWorkboardState response, so polling that is enough.
            // The token itself isn't needed here; tokens are single-use, so
            // any new attached session is the one we just asked for.
            const next = await sendRequest({ type: messageTypes.getWorkboardState });
            setState(next);
            return next.codingSessions.filter((session) => session.status === 'attached');
          }}
          onAttached={() => {
            setCodingAttachOpen(false);
          }}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          settings={
            settings === null
              ? null
              : {
                  autoSendOptIn: settings.autoSendOptIn,
                  defaultPacketKind: settings.defaultPacketKind,
                  defaultDispatchTarget: settings.defaultDispatchTarget,
                  screenShareSafeMode: settings.screenShareSafeMode,
                  revision: settings.revision,
                }
          }
          busy={settingsBusy}
          error={settingsError}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsError(null);
          }}
          onSave={handleSettingsSave}
          localPreferences={{
            autoTrack: state.settings.autoTrack,
            vaultPath: state.vaultPath ?? '',
            notifyOnQueueComplete: state.settings.notifyOnQueueComplete,
          }}
          companionConfigured={bridgeKey.length > 0}
          workstreams={state.workstreams}
          screenShareMode={state.screenShareMode}
          onSaveLocalPreferences={(next) => {
            void runAction(() =>
              sendRequest({ type: messageTypes.saveLocalPreferences, preferences: next }),
            );
          }}
          archivedThreads={state.threads
            .filter((t) => t.trackingMode === 'archived' && t.status !== 'removed')
            .slice()
            .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
            .map((t) => ({
              bac_id: t.bac_id,
              title: t.title,
              workstreamPath: workstreamPath(t.primaryWorkstreamId, state.workstreams),
              archivedAt: formatRelative(t.lastSeenAt),
              providerLabel: providerLabel(t.provider),
            }))}
          onRestoreThread={(threadId) => {
            const target = state.threads.find((t) => t.bac_id === threadId);
            const knownProvider = target !== undefined && target.provider !== 'unknown';
            const restoredMode: TrackedThread['trackingMode'] =
              state.settings.autoTrack && knownProvider ? 'auto' : 'manual';
            updateTracking(threadId, restoredMode);
          }}
          onDeleteThread={(threadId) => {
            updateTracking(threadId, 'removed');
          }}
          onBulkUpdateWorkstreamPrivacy={() => {
            void runAction(() =>
              sendRequest({
                type: messageTypes.bulkUpdateWorkstreamPrivacy,
                from: 'private',
                to: 'shared',
              }),
            );
          }}
          onToggleWorkstreamSensitive={(workstream, sensitive) => {
            void runAction(() =>
              sendRequest({
                type: messageTypes.updateWorkstream,
                workstreamId: workstream.bac_id,
                update: {
                  revision: workstream.revision,
                  screenShareSensitive: sensitive,
                },
              }),
            );
          }}
          onSetScreenShareMode={(enabled) => {
            void runAction(() =>
              sendRequest({
                type: messageTypes.setScreenShareMode,
                enabled,
              }),
            );
          }}
          onConnectCompanion={() => {
            // Switch from local-only → companion-backed by re-opening
            // the wizard. Closing Settings first so the wizard isn't
            // stacked behind it.
            setSettingsOpen(false);
            setWizardOpen(true);
          }}
          theme={theme}
          density={density}
          onThemeChange={setTheme}
          onDensityChange={setDensity}
          companionPort={port.length > 0 ? Number(port) : null}
          bridgeKey={bridgeKey.length > 0 ? bridgeKey : null}
          onSaveCompanionConnection={(next) => {
            // Pushing into the local port + bridgeKey state triggers
            // the existing debounced auto-save effect (App.tsx around
            // line ~1020) which writes to chrome.storage via the
            // saveCompanionSettings message. No new wiring needed.
            setPort(String(next.port));
            setBridgeKey(next.bridgeKey);
          }}
        />
      ) : null}

      {healthPanelOpen ? (
        <HealthPanel
          onClose={() => {
            setHealthPanelOpen(false);
          }}
          companionPort={port.length > 0 ? Number(port) : null}
          bridgeKey={bridgeKey.length > 0 ? bridgeKey : null}
          queuedCaptureCount={state.queuedCaptureCount}
          droppedCaptureCount={state.droppedCaptureCount}
        />
      ) : null}

      {designPreviewOpen ? (
        <DesignPreview
          onClose={() => {
            setDesignPreviewOpen(false);
          }}
        />
      ) : null}

      {workstreamDetailOpen ? (
        <WorkstreamDetailPanel
          workstreamLabel={currentWs?.title ?? currentWsLabel}
          {...(currentWs === null
            ? {}
            : {
                workstream: {
                  bac_id: currentWs.bac_id,
                  title: currentWs.title,
                  ...(currentWs.parentId === undefined ? {} : { parentId: currentWs.parentId }),
                },
                workstreams: state.workstreams.map((w) => ({
                  bac_id: w.bac_id,
                  title: w.title,
                  ...(w.parentId === undefined ? {} : { parentId: w.parentId }),
                })),
                onRename: (nextTitle: string) => {
                  void runAction(async () => {
                    const next = await sendRequest({
                      type: messageTypes.updateWorkstream,
                      workstreamId: currentWs.bac_id,
                      update: { revision: currentWs.revision, title: nextTitle },
                    });
                    await recordOrganizedItemFeedback({
                      itemKind: 'workstream',
                      itemId: currentWs.bac_id,
                      action: 'rename',
                      details: { rename: nextTitle },
                    });
                    return next;
                  });
                },
                onMove: (parentId: string | null) => {
                  void runAction(async () => {
                    const next = await sendRequest({
                      type: messageTypes.updateWorkstream,
                      workstreamId: currentWs.bac_id,
                      update: {
                        revision: currentWs.revision,
                        // null sentinel = detach to top-level. The
                        // companion writer treats null as "remove
                        // parentId from the record + drop self from
                        // the previous parent's children". When
                        // parentId is a string, normal re-parent.
                        parentId: parentId ?? null,
                      },
                    });
                    await recordOrganizedItemFeedback({
                      itemKind: 'workstream',
                      itemId: currentWs.bac_id,
                      action: 'move',
                      ...(currentWs.parentId === undefined
                        ? {}
                        : { fromContainer: currentWs.parentId }),
                      ...(parentId === null ? {} : { toContainer: parentId }),
                    });
                    return next;
                  });
                },
                onDelete: async () => {
                  // Delete refuses on companion side when there are
                  // child workstreams. Bubble the failure back to
                  // the panel so the confirm modal can show the
                  // error pill instead of silently closing.
                  await sendRequest({
                    type: messageTypes.deleteWorkstream,
                    workstreamId: currentWs.bac_id,
                  });
                  setCurrentWs(null);
                },
                threadCount: threads.filter((t) => t.primaryWorkstreamId === currentWs.bac_id)
                  .length,
              })}
          linkedNotes={workstreamDetailLinkedNotes}
          trustEntries={workstreamDetailTrust}
          onClose={() => {
            setWorkstreamDetailOpen(false);
          }}
          onTrustChange={(tool: TrustTool, next: boolean) => {
            // Optimistic — update local state immediately. PUT to the
            // companion is best-effort; revert on failure would need a
            // request-id pattern not yet in place for this endpoint.
            setWorkstreamDetailTrust((prev) =>
              prev.map((entry) => (entry.tool === tool ? { ...entry, allowed: next } : entry)),
            );
            if (port.length > 0 && bridgeKey.length > 0 && currentWsId !== null) {
              const allowedTools = workstreamDetailTrust
                .map((e) => (e.tool === tool ? { ...e, allowed: next } : e))
                .filter((e) => e.allowed)
                .map((e) => e.tool);
              void fetch(`http://127.0.0.1:${port}/v1/workstreams/${currentWsId}/trust`, {
                method: 'PUT',
                headers: {
                  'x-bac-bridge-key': bridgeKey,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({ allowedTools }),
              }).catch(() => {
                // Best-effort — companion may not be running.
              });
            }
          }}
        />
      ) : null}
    </main>
  );
};

export default App;

// =====================================================
// Spec-aligned UI subcomponents (PR 2 / design rewrite)
// =====================================================

// Per-row workstream-suggestion fetcher. Calls
// GET /v1/suggestions/thread/{id} (PR #76 Track F) when companion is
// configured. Caches the top suggestion via the parent's onCache so
// repeated row renders don't re-fetch.

interface NeedsOrganizeSuggestionRowProps {
  readonly threadId: string;
  readonly companionPort: number | null;
  readonly bridgeKey: string | null;
  readonly cached?: {
    readonly workstreamId: string;
    readonly label: string;
    readonly confidence: number;
  };
  // Stable string that changes whenever the workstream graph
  // changes (counts, revisions, members). The fetch effect depends
  // on it, so any workstream mutation invalidates the cached
  // suggestion automatically.
  readonly workstreamFingerprint: string;
  // True while the recall index is being rebuilt (model swap,
  // schema change, or empty index). Clicking ↻ during this window
  // returns scores against a partially-rebuilt index — the row
  // would flip every few seconds as new entries land. We pause the
  // fetch and surface a clear "indexing" hint instead, so the user
  // doesn't read the noise as instability. The effect re-runs once
  // this flips false (rebuild settled).
  readonly indexRebuilding: boolean;
  // Resolves a workstreamId to its display label (`workstreamPath`
  // semantics). Threaded in so the row shows real names instead of
  // a bac_id slice.
  readonly resolveLabel: (workstreamId: string) => string;
  readonly onCache: (payload: {
    readonly workstreamId: string;
    readonly label: string;
    readonly confidence: number;
  }) => void;
  readonly onClearCache: () => void;
  readonly onAccept: (workstreamId: string) => void;
  readonly onPickManual: () => void;
  readonly onDismiss: () => void;
}

function NeedsOrganizeSuggestionRow({
  threadId,
  companionPort,
  bridgeKey,
  cached,
  workstreamFingerprint,
  indexRebuilding,
  resolveLabel,
  onCache,
  onClearCache,
  onAccept,
  onPickManual,
  onDismiss,
}: NeedsOrganizeSuggestionRowProps) {
  // Render the cached value immediately; the fetch effect below
  // always runs (stale-while-revalidate) so a subsequent mutation
  // on the companion side propagates without forcing a side-panel
  // reload. If the user explicitly hits the refresh icon we clear
  // both the local state AND the parent cache and re-fetch.
  const [suggestion, setSuggestion] = useState<{
    readonly workstreamId: string;
    readonly label: string;
    readonly confidence: number;
  } | null>(cached ?? null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (companionPort === null || bridgeKey === null) return undefined;
    // Suppress fetches while the recall index is rebuilding —
    // partially-rebuilt index gives oscillating scores and the user
    // reads the flicker as instability. The deps below include
    // `indexRebuilding`, so the fetch fires automatically the
    // moment the rebuild settles to 'ready'.
    if (indexRebuilding) {
      setPending(true);
      return undefined;
    }
    let cancelled = false;
    setPending(true);
    void (async () => {
      // Throttle: acquire a global slot before issuing the fetch so
      // the simultaneous mount of N suggestion rows can't exhaust
      // Chrome's per-origin socket pool. Slot releases on finally.
      const release = await acquireCompanionFetchSlot();
      if (cancelled) {
        release();
        return;
      }
      try {
        const url = `http://127.0.0.1:${String(companionPort)}/v1/suggestions/thread/${threadId}?limit=1`;
        const response = await fetch(url, { headers: { 'x-bac-bridge-key': bridgeKey } });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled mutated by cleanup
        if (cancelled || !response.ok) return;
        // Server shape: { data: Suggestion[] } — `data` is the
        // ranked array DIRECTLY, not `{ items: Suggestion[] }`.
        // The previous parser unwrapped `body.data?.items?.[0]`,
        // which silently returned undefined and cleared the
        // suggestion even when the companion replied with a real
        // top match. Confirmed via scripts/raw-suggest.mjs against
        // a live companion (score 0.50, lex 0.67, vec 0.60).
        const body = (await response.json()) as {
          readonly data?: readonly {
            readonly workstreamId: string;
            readonly score: number;
          }[];
        };
        const top = body.data?.[0];
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled mutated by cleanup
        if (cancelled) return;
        if (top === undefined) {
          // No suggestion above threshold any more — clear so the
          // row falls back to the manual-pick affordance.
          setSuggestion(null);
          return;
        }
        const label = resolveLabel(top.workstreamId);
        const next = { workstreamId: top.workstreamId, label, confidence: top.score };
        setSuggestion(next);
        onCache(next);
      } catch {
        // Silent — empty render
      } finally {
        release();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled mutated by cleanup
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    companionPort,
    bridgeKey,
    threadId,
    onCache,
    resolveLabel,
    workstreamFingerprint,
    indexRebuilding,
    refreshTick,
  ]);

  // Always render the row even when the companion has no automatic
  // suggestion above threshold — surface the manual picker so the
  // user has a path to file the thread without hunting for the
  // workstream chip elsewhere.
  const hasAuto = suggestion !== null;
  // While the index is rebuilding, scores oscillate as new turns
  // land. Show a clear "indexing…" hint instead of the score so
  // the user understands the suggestion will be accurate again
  // shortly. The fetch effect re-fires automatically when
  // indexRebuilding flips false.
  const suggestedLabel = indexRebuilding
    ? 'Indexing — suggestions paused'
    : hasAuto
      ? suggestion.label
      : 'Pick a workstream…';
  return (
    <NeedsOrganizeSuggestion
      suggestedLabel={suggestedLabel}
      confidence={hasAuto && !indexRebuilding ? suggestion.confidence : 0}
      pending={pending || indexRebuilding}
      onAccept={() => {
        if (hasAuto && suggestion.workstreamId.length > 0) {
          onAccept(suggestion.workstreamId);
        } else {
          onPickManual();
        }
      }}
      onPickManual={onPickManual}
      onRefresh={() => {
        // Clearing the parent cache then bumping refreshTick forces
        // the effect to re-run with no cached fallback to render.
        onClearCache();
        setSuggestion(null);
        setRefreshTick((tick) => tick + 1);
      }}
      onDismiss={onDismiss}
    />
  );
}

interface WorkstreamBarProps {
  readonly currentWsLabel: string;
  readonly statusLabel: string;
  readonly onOpenPicker: () => void;
  readonly onAddSubWorkstream: () => void;
  readonly onOpenDetail?: () => void;
}

function WorkstreamBar({
  currentWsLabel,
  statusLabel,
  onOpenPicker,
  onAddSubWorkstream,
  onOpenDetail,
}: WorkstreamBarProps) {
  return (
    <div className="ws-bar">
      <span className="lbl">Workstream</span>
      <button type="button" className="ws-name" onClick={onOpenPicker} aria-haspopup="menu">
        {currentWsLabel}
      </button>
      <button
        type="button"
        className="icon-btn ws-add"
        title="Add sub-workstream"
        aria-label="Add sub-workstream"
        onClick={onAddSubWorkstream}
      >
        <svg viewBox="0 0 24 24">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {onOpenDetail !== undefined ? (
        <button
          type="button"
          className="icon-btn"
          title="Workstream detail — linked notes + MCP write trust"
          aria-label="Open workstream detail"
          onClick={onOpenDetail}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </button>
      ) : null}
      <span className="ws-status mono">{statusLabel}</span>
      <span className="swap-arrow" aria-hidden>
        ↓
      </span>
    </div>
  );
}

interface WorkstreamPickerProps {
  readonly workstreams: readonly WorkstreamNode[];
  readonly threads: readonly TrackedThread[];
  readonly currentWsId: string | null;
  readonly createMode: boolean;
  readonly parentForNew: string | null;
  readonly onClose: () => void;
  readonly onSelect: (id: string | null) => void;
  readonly onCreate: (title: string, parentId: string | null, description?: string) => void;
}

function WorkstreamPicker({
  workstreams,
  threads,
  currentWsId,
  createMode,
  parentForNew,
  onClose,
  onSelect,
  onCreate,
}: WorkstreamPickerProps) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(createMode);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDescription, setDraftDescription] = useState('');

  // Hierarchy-aware rendering: group workstreams as roots + per-root
  // children. When a search query is active we flatten matches (search
  // wins over hierarchy clarity); otherwise we render each root
  // followed by its indented children.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return workstreams;
    return workstreams.filter((w) => w.title.toLowerCase().includes(q));
  }, [query, workstreams]);

  const isSearching = query.trim().length > 0;
  const hierarchical = useMemo(() => {
    if (isSearching) return matches.map((w) => ({ ws: w, depth: 0 }));
    // Build children index. Each entry's children get appended after it.
    const byParent = new Map<string | null, WorkstreamNode[]>();
    for (const w of workstreams) {
      const key = w.parentId ?? null;
      const list = byParent.get(key) ?? [];
      list.push(w);
      byParent.set(key, list);
    }
    const out: { ws: WorkstreamNode; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number): void => {
      const children = byParent.get(parentId) ?? [];
      for (const w of children) {
        out.push({ ws: w, depth });
        walk(w.bac_id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [isSearching, matches, workstreams]);

  const threadCountFor = (wsId: string): number =>
    threads.filter((t) => t.primaryWorkstreamId === wsId).length;
  const inboxCount = threads.filter((t) => t.primaryWorkstreamId === undefined).length;
  // Track which parent the user is creating a sub-workstream under.
  // null = top-level. Defaults to parentForNew (prop) but the user can
  // toggle between "top-level" and "under current" via the trigger row.
  const [createParent, setCreateParent] = useState<string | null>(parentForNew);
  const parentTitle =
    parentForNew === null
      ? null
      : workstreams.find((w) => w.bac_id === parentForNew)?.title ?? 'current';

  return (
    <div className="ws-picker-backdrop" onClick={onClose} role="presentation">
      <div
        className="ws-picker"
        onClick={(e) => {
          e.stopPropagation();
        }}
        role="menu"
      >
        <input
          type="search"
          className="ws-picker-search mono"
          placeholder="Search workstreams…"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
        <div className="ws-picker-list">
          {/* Column header explains what the right-hand count means. */}
          <div className="ws-picker-header mono subtle">
            <span>Workstream</span>
            <span title="Threads currently attributed to this workstream">threads</span>
          </div>
          <button
            type="button"
            className={'ws-picker-row' + (currentWsId === null ? ' on' : '')}
            onClick={() => {
              onSelect(null);
            }}
            title="Inbox — threads waiting for you to assign a workstream"
          >
            <span className="ws-picker-name">
              <strong>Not assigned</strong>{' '}
              <em className="subtle">— threads waiting for triage</em>
            </span>
            <span className="mono subtle" title={`${String(inboxCount)} unassigned threads`}>
              {inboxCount}
            </span>
          </button>
          {hierarchical.map(({ ws: w, depth }) => {
            const count = threadCountFor(w.bac_id);
            return (
              <button
                type="button"
                key={w.bac_id}
                className={
                  'ws-picker-row' +
                  (currentWsId === w.bac_id ? ' on' : '') +
                  (depth > 0 ? ' is-child' : '')
                }
                onClick={() => {
                  onSelect(w.bac_id);
                }}
                title={
                  depth > 0
                    ? `Sub-workstream (nested ${String(depth)} deep)`
                    : 'Top-level workstream'
                }
                style={depth > 0 ? { paddingLeft: `${String(12 + depth * 14)}px` } : undefined}
              >
                <span className="ws-picker-name">
                  {depth > 0 ? <span className="ws-picker-indent">└ </span> : null}
                  {w.title}
                </span>
                <span className="mono subtle" title={`${String(count)} threads in ${w.title}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        {creating ? (
          <form
            className="ws-picker-create"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = draftTitle.trim();
              if (trimmed.length === 0) {
                return;
              }
              onCreate(trimmed, createParent, draftDescription.trim());
              setDraftTitle('');
              setDraftDescription('');
              setCreating(false);
            }}
          >
            <input
              type="text"
              className="ws-picker-create-input"
              // Unified placeholder — the user already knows whether
              // they're creating a top-level workstream or a sub-
              // workstream from the button they just clicked (the
              // workstream-detail panel button labels are explicit).
              // The placeholder doesn't need to repeat that context;
              // a uniform "New workstream name…" reads cleaner and
              // matches the e2e suite's expectations.
              placeholder="New workstream name…"
              value={draftTitle}
              autoFocus
              onChange={(e) => {
                setDraftTitle(e.target.value);
              }}
              aria-label={
                createParent === null
                  ? 'New top-level workstream name'
                  : `New sub-workstream under ${parentTitle ?? 'current'}`
              }
            />
            {/* Optional description — flows into the suggester's
                lexical match + cold-start centroid, so multi-language
                or topic-keyword hints land here. Keep it short:
                "travel hotel hiking 旅游 酒店 徒步" is enough to
                attract foreign-language threads. */}
            <textarea
              className="ws-picker-create-input"
              placeholder="Description / keywords (optional, helps auto-match — multi-language ok)"
              value={draftDescription}
              rows={2}
              onChange={(e) => {
                setDraftDescription(e.target.value);
              }}
            />
            <button type="submit" className="btn btn-primary">
              Create
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setCreating(false);
                setDraftTitle('');
                setDraftDescription('');
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="ws-picker-create-triggers">
            {parentForNew !== null ? (
              <button
                type="button"
                className="ws-picker-create-trigger"
                onClick={() => {
                  setCreateParent(parentForNew);
                  setCreating(true);
                }}
                title={`Create a sub-workstream nested under ${parentTitle ?? 'current'}`}
              >
                + New under {parentTitle ?? 'current'}
              </button>
            ) : null}
            <button
              type="button"
              className="ws-picker-create-trigger"
              onClick={() => {
                setCreateParent(null);
                setCreating(true);
              }}
              title="Create a new top-level workstream (not nested under any other)"
            >
              + New top-level workstream
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
