import type {
  CaptureEvent,
  CaptureNoteCreate,
  CaptureNoteUpdate,
  CompanionSettings,
  QueueCreate,
  QueueUpdate,
  ReminderCreate,
  ReminderUpdate,
  ThreadUpsert,
  WorkstreamCreate,
  WorkstreamUpdate,
} from '../companion/model';
import { readDroppedCount, readQueue } from '../companion/queue';
import { canonicalThreadUrl } from '../capture/providerDetection';
import type { DispatchEventRecord } from '../dispatch/types';
import type {
  ReviewDraft,
  ReviewDraftSpan,
  ReviewVerdict,
} from '../review/types';
import {
  createEmptyWorkboardState,
  defaultSettings,
  type AllThreadsBucket,
  type CaptureNote,
  type CodingSession,
  type DispatchDiagnostic,
  type InboundReminder,
  type QueueItem,
  type SelectorHealth,
  type TrackedThread,
  type UiSettings,
  type WorkboardState,
  type WorkstreamNode,
} from '../workboard';

const SETTINGS_KEY = 'sidetrack.settings';
const THREADS_KEY = 'sidetrack.threads';
const WORKSTREAMS_KEY = 'sidetrack.workstreams';
const QUEUE_ITEMS_KEY = 'sidetrack.queueItems';
const REMINDERS_KEY = 'sidetrack.reminders';
const SELECTOR_HEALTH_KEY = 'sidetrack.selectorHealth';
const COLLAPSED_SECTIONS_KEY = 'sidetrack.collapsedSections';
const COLLAPSED_BUCKETS_KEY = 'sidetrack.collapsedBuckets';
const CODING_SESSIONS_KEY = 'sidetrack.codingSessions';
const CAPTURE_NOTES_KEY = 'sidetrack.captureNotes';
const VAULT_PATH_KEY = 'sidetrack.vaultPath';
const RECENT_DISPATCHES_KEY = 'sidetrack.recentDispatches';
const DISPATCH_LINKS_KEY = 'sidetrack.dispatchLinks';
const DISPATCH_DIAGNOSTICS_KEY = 'sidetrack.dispatchDiagnostics';
// Local cache of UNREDACTED dispatch bodies, keyed by dispatchId. The
// companion stores the redacted body (PII / API keys → [category]),
// but the auto-link matcher needs the body the user actually copied
// to clipboard — which is the unredacted form. We record it on the
// extension side at submit time and use it for substring matching.
const DISPATCH_ORIGINALS_KEY = 'sidetrack.dispatchOriginals';
// Per-thread "last dispatch target" — surfaces in the SendToDropdown
// "Recent" section so the user can repeat their last dispatch with
// one click. Map: threadId → SendToTarget id (string).
const LAST_DISPATCH_TARGET_KEY = 'sidetrack.lastDispatchTargetByThread';
const SCREEN_SHARE_MODE_KEY = 'sidetrack.screenShareMode';
// Per-thread inline-review drafts (selection + comment + overall +
// verdict). Stored locally only; not part of the companion vault
// schema. The vault is written via the existing /v1/reviews endpoint
// only when the user explicitly saves or sends-as-follow-up.
const REVIEW_DRAFTS_KEY = 'sidetrack.reviewDrafts';

const storageGet = async <TValue>(key: string, fallback: TValue): Promise<TValue> => {
  const result = await chrome.storage.local.get({ [key]: fallback });
  return result[key] as TValue;
};

const storageSet = async (values: Record<string, unknown>): Promise<void> => {
  await chrome.storage.local.set(values);
};

const storageSessionGet = async <TValue>(key: string, fallback: TValue): Promise<TValue> => {
  const result = await chrome.storage.session.get({ [key]: fallback });
  return result[key] as TValue;
};

const storageSessionSet = async (values: Record<string, unknown>): Promise<void> => {
  await chrome.storage.session.set(values);
};

const createLocalBacId = (): string => `bac_${crypto.randomUUID().replaceAll('-', '_')}`;

export const readSettings = async (): Promise<UiSettings> => {
  const stored = await storageGet<UiSettings>(SETTINGS_KEY, defaultSettings);
  // Merge against defaults so installs that pre-date a new flag pick
  // it up at its default rather than `undefined` (which behaves as
  // "off" for booleans).
  return { ...defaultSettings, ...stored };
};

export const saveCompanionSettings = async (settings: CompanionSettings): Promise<UiSettings> => {
  const current = await readSettings();
  const next: UiSettings = { ...current, companion: settings };
  await storageSet({ [SETTINGS_KEY]: next });
  return next;
};

export const saveAutoTrack = async (autoTrack: boolean): Promise<UiSettings> => {
  const current = await readSettings();
  const next: UiSettings = { ...current, autoTrack };
  await storageSet({ [SETTINGS_KEY]: next });
  return next;
};

export const saveNotifyOnQueueComplete = async (
  notifyOnQueueComplete: boolean,
): Promise<UiSettings> => {
  const current = await readSettings();
  const next: UiSettings = { ...current, notifyOnQueueComplete };
  await storageSet({ [SETTINGS_KEY]: next });
  return next;
};

export const readVaultPath = async (): Promise<string | undefined> => {
  const value = await storageGet<string | undefined>(VAULT_PATH_KEY, undefined);
  return value === undefined || value.length === 0 ? undefined : value;
};

export const saveVaultPath = async (vaultPath: string): Promise<void> => {
  await storageSet({ [VAULT_PATH_KEY]: vaultPath });
};

export const readThreads = async (): Promise<readonly TrackedThread[]> =>
  await storageGet<readonly TrackedThread[]>(THREADS_KEY, []);

export const readWorkstreams = async (): Promise<readonly WorkstreamNode[]> =>
  await storageGet<readonly WorkstreamNode[]>(WORKSTREAMS_KEY, []);

export const readQueueItems = async (): Promise<readonly QueueItem[]> =>
  await storageGet<readonly QueueItem[]>(QUEUE_ITEMS_KEY, []);

export const readReminders = async (): Promise<readonly InboundReminder[]> =>
  await storageGet<readonly InboundReminder[]>(REMINDERS_KEY, []);

export const readSelectorHealth = async (): Promise<readonly SelectorHealth[]> =>
  await storageGet<readonly SelectorHealth[]>(SELECTOR_HEALTH_KEY, []);

export const readCachedCodingSessions = async (): Promise<readonly CodingSession[]> =>
  await storageGet<readonly CodingSession[]>(CODING_SESSIONS_KEY, []);

export const writeCachedCodingSessions = async (
  sessions: readonly CodingSession[],
): Promise<void> => {
  await storageSet({ [CODING_SESSIONS_KEY]: sessions });
};

// Recent-dispatches cache. Refreshed from companion's GET /v1/dispatches
// on every withCompanionStatus poll (alongside coding sessions). The
// cache lets the side panel render the section without waiting for
// the companion round-trip on each state read; a stale read just
// shows the previous batch until the next poll lands.
export const readCachedDispatches = async (): Promise<readonly DispatchEventRecord[]> =>
  await storageGet<readonly DispatchEventRecord[]>(RECENT_DISPATCHES_KEY, []);

export const writeCachedDispatches = async (
  dispatches: readonly DispatchEventRecord[],
): Promise<void> => {
  await storageSet({ [RECENT_DISPATCHES_KEY]: dispatches });
};

// Set / clear the local 'archived' status on a recorded dispatch.
// Archive is a UI-only filter — we don't write through to the
// companion vault since the underlying review/sent/replied lifecycle
// is separate. Idempotent if the row is already in the target state.
export const setDispatchArchived = async (
  dispatchId: string,
  archived: boolean,
): Promise<void> => {
  const current = await readCachedDispatches();
  const target = current.find((dispatch) => dispatch.bac_id === dispatchId);
  if (target === undefined) return;
  if (archived && target.status === 'archived') return;
  if (!archived && target.status !== 'archived') return;
  // Going-into-archive: write 'archived'. Going-out: assume the
  // rehydrated status is 'sent' — we don't store the prior status to
  // avoid bloating the local cache schema.
  const nextStatus: DispatchEventRecord['status'] = archived ? 'archived' : 'sent';
  const next = current.map((dispatch) =>
    dispatch.bac_id === dispatchId ? { ...dispatch, status: nextStatus } : dispatch,
  );
  await writeCachedDispatches(next);
};

// Dispatch → destination thread links. We can't add this to the
// companion DispatchEventRecord without bumping its schema, so we
// track it locally in chrome.storage. Map: dispatchId → threadId.
export const readDispatchLinks = async (): Promise<Readonly<Partial<Record<string, string>>>> =>
  await storageGet<Readonly<Partial<Record<string, string>>>>(DISPATCH_LINKS_KEY, {});

export const readDispatchDiagnostics = async (): Promise<readonly DispatchDiagnostic[]> =>
  await storageGet<readonly DispatchDiagnostic[]>(DISPATCH_DIAGNOSTICS_KEY, []);

export const writeDispatchDiagnostic = async (diagnostic: DispatchDiagnostic): Promise<void> => {
  const current = await readDispatchDiagnostics();
  await storageSet({
    [DISPATCH_DIAGNOSTICS_KEY]: [diagnostic, ...current]
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, 20),
  });
};

export const writeDispatchLink = async (dispatchId: string, threadId: string): Promise<void> => {
  const current = await readDispatchLinks();
  if (current[dispatchId] === threadId) {
    return;
  }
  await storageSet({
    [DISPATCH_LINKS_KEY]: { ...current, [dispatchId]: threadId },
  });
};

// Original (pre-redaction) dispatch bodies, keyed by dispatchId.
// Used by the auto-link matcher so it sees what the user actually
// copied to clipboard, not the redacted vault form. Same access
// pattern as dispatchLinks; tri-state Partial so absent lookups
// return undefined (not the empty string).
export const readDispatchOriginals = async (): Promise<Readonly<Partial<Record<string, string>>>> =>
  await storageGet<Readonly<Partial<Record<string, string>>>>(DISPATCH_ORIGINALS_KEY, {});

export const writeDispatchOriginal = async (dispatchId: string, body: string): Promise<void> => {
  const current = await readDispatchOriginals();
  if (current[dispatchId] === body) {
    return;
  }
  await storageSet({
    [DISPATCH_ORIGINALS_KEY]: { ...current, [dispatchId]: body },
  });
};

// Per-thread last dispatch target — populated each time the user
// successfully fires a Send-to dispatch. Surfaces in the dropdown's
// "Recent" section.
export const readLastDispatchTargetByThread = async (): Promise<
  Readonly<Partial<Record<string, string>>>
> => await storageGet<Readonly<Partial<Record<string, string>>>>(LAST_DISPATCH_TARGET_KEY, {});

export const writeLastDispatchTargetByThread = async (
  threadId: string,
  target: string,
): Promise<void> => {
  const current = await readLastDispatchTargetByThread();
  if (current[threadId] === target) {
    return;
  }
  await storageSet({
    [LAST_DISPATCH_TARGET_KEY]: { ...current, [threadId]: target },
  });
};

// Per-thread inline-review drafts. The content script appends spans
// as the user comments on selected text on the chat page; the side
// panel renders + lets the user edit and send. Storage is keyed by
// the tracked thread's bac_id (not threadUrl) so rename / re-resolve
// of the URL doesn't orphan the draft.
export const readReviewDrafts = async (): Promise<
  Readonly<Partial<Record<string, ReviewDraft>>>
> => await storageGet<Readonly<Partial<Record<string, ReviewDraft>>>>(REVIEW_DRAFTS_KEY, {});

const writeReviewDrafts = async (
  next: Readonly<Partial<Record<string, ReviewDraft>>>,
): Promise<void> => {
  await storageSet({ [REVIEW_DRAFTS_KEY]: next });
};

export const appendReviewDraftSpan = async (
  threadId: string,
  threadUrl: string,
  span: Omit<ReviewDraftSpan, 'bac_id'>,
): Promise<ReviewDraft> => {
  const current = await readReviewDrafts();
  const existing = current[threadId];
  const newSpan: ReviewDraftSpan = { ...span, bac_id: createLocalBacId() };
  const next: ReviewDraft = {
    threadId,
    threadUrl,
    spans: existing === undefined ? [newSpan] : [...existing.spans, newSpan],
    ...(existing?.overall === undefined ? {} : { overall: existing.overall }),
    ...(existing?.verdict === undefined ? {} : { verdict: existing.verdict }),
    updatedAt: span.capturedAt,
  };
  await writeReviewDrafts({ ...current, [threadId]: next });
  return next;
};

export const dropReviewDraftSpan = async (
  threadId: string,
  spanId: string,
): Promise<ReviewDraft | undefined> => {
  const current = await readReviewDrafts();
  const existing = current[threadId];
  if (existing === undefined) {
    return undefined;
  }
  const remaining = existing.spans.filter((span) => span.bac_id !== spanId);
  if (remaining.length === 0 && existing.overall === undefined && existing.verdict === undefined) {
    const { [threadId]: _, ...rest } = current;
    void _;
    await writeReviewDrafts(rest);
    return undefined;
  }
  const next: ReviewDraft = {
    ...existing,
    spans: remaining,
    updatedAt: new Date().toISOString(),
  };
  await writeReviewDrafts({ ...current, [threadId]: next });
  return next;
};

export const updateReviewDraft = async (
  threadId: string,
  patch: { readonly overall?: string; readonly verdict?: ReviewVerdict },
): Promise<ReviewDraft | undefined> => {
  const current = await readReviewDrafts();
  const existing = current[threadId];
  if (existing === undefined) {
    return undefined;
  }
  const nextOverall =
    patch.overall === undefined
      ? existing.overall
      : patch.overall.length === 0
        ? undefined
        : patch.overall;
  const nextVerdict = patch.verdict ?? existing.verdict;
  const next: ReviewDraft = {
    ...existing,
    ...(nextOverall === undefined ? {} : { overall: nextOverall }),
    ...(nextVerdict === undefined ? {} : { verdict: nextVerdict }),
    updatedAt: new Date().toISOString(),
  };
  // Strip undefined keys cleanly so storage doesn't carry deleted
  // overall/verdict via prior values.
  if (nextOverall === undefined && 'overall' in existing) {
    delete (next as { overall?: string }).overall;
  }
  if (nextVerdict === undefined && 'verdict' in existing) {
    delete (next as { verdict?: ReviewVerdict }).verdict;
  }
  await writeReviewDrafts({ ...current, [threadId]: next });
  return next;
};

export const discardReviewDraft = async (threadId: string): Promise<void> => {
  const current = await readReviewDrafts();
  if (current[threadId] === undefined) {
    return;
  }
  const { [threadId]: _, ...rest } = current;
  void _;
  await writeReviewDrafts(rest);
};

// Drop entries for dispatches that have aged out of recentDispatches.
// Called from the same broadcast point as pruneDispatchLinks so the
// caches stay roughly in sync.
export const pruneDispatchOriginals = async (
  knownDispatchIds: ReadonlySet<string>,
): Promise<void> => {
  const current = await readDispatchOriginals();
  const next: Record<string, string> = {};
  let changed = false;
  for (const [dispatchId, body] of Object.entries(current)) {
    if (body === undefined) {
      changed = true;
      continue;
    }
    if (knownDispatchIds.has(dispatchId)) {
      next[dispatchId] = body;
    } else {
      changed = true;
    }
  }
  if (changed) {
    await storageSet({ [DISPATCH_ORIGINALS_KEY]: next });
  }
};

// Drop links that point at threads no longer in the cache (cleanup).
export const pruneDispatchLinks = async (knownThreadIds: ReadonlySet<string>): Promise<void> => {
  const current = await readDispatchLinks();
  const next: Record<string, string> = {};
  let changed = false;
  for (const [dispatchId, threadId] of Object.entries(current)) {
    if (threadId === undefined) {
      changed = true;
      continue;
    }
    if (knownThreadIds.has(threadId)) {
      next[dispatchId] = threadId;
    } else {
      changed = true;
    }
  }
  if (changed) {
    await storageSet({ [DISPATCH_LINKS_KEY]: next });
  }
};

// Flip a dispatch's status to 'replied' once we detect a fresh
// inbound assistant turn for the dispatch's source thread. Idempotent:
// already-replied or noted dispatches are left alone. Returns the
// dispatch ids that were transitioned (caller can broadcast).
export const markDispatchesRepliedForThread = async (
  threadId: string,
): Promise<readonly string[]> => {
  const current = await readCachedDispatches();
  const flipped: string[] = [];
  const next = current.map((d) => {
    if (d.sourceThreadId !== threadId) {
      return d;
    }
    if (d.status !== 'sent' && d.status !== 'pending' && d.status !== 'queued') {
      return d;
    }
    flipped.push(d.bac_id);
    return { ...d, status: 'replied' as const };
  });
  if (flipped.length > 0) {
    await writeCachedDispatches(next);
  }
  return flipped;
};

export const readCaptureNotes = async (): Promise<readonly CaptureNote[]> =>
  await storageGet<readonly CaptureNote[]>(CAPTURE_NOTES_KEY, []);

export const createLocalCaptureNote = async (input: CaptureNoteCreate): Promise<CaptureNote> => {
  const current = await readCaptureNotes();
  const timestamp = new Date().toISOString();
  const note: CaptureNote = {
    bac_id: createLocalBacId(),
    kind: input.kind ?? 'manual',
    text: input.text,
    ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(input.source === undefined ? {} : { source: input.source }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await storageSet({ [CAPTURE_NOTES_KEY]: [note, ...current] });
  return note;
};

export const updateLocalCaptureNote = async (
  noteId: string,
  update: CaptureNoteUpdate,
): Promise<CaptureNote | undefined> => {
  const current = await readCaptureNotes();
  const timestamp = new Date().toISOString();
  let updated: CaptureNote | undefined;
  const next = current.map((note) => {
    if (note.bac_id !== noteId) {
      return note;
    }
    updated = {
      ...note,
      text: update.text ?? note.text,
      // workstreamId is intentionally allowed to be set to undefined to
      // re-park a note in the Inbox.
      workstreamId: 'workstreamId' in update ? update.workstreamId : note.workstreamId,
      updatedAt: timestamp,
    };
    return updated;
  });
  await storageSet({ [CAPTURE_NOTES_KEY]: next });
  return updated;
};

export const deleteLocalCaptureNote = async (noteId: string): Promise<void> => {
  const current = await readCaptureNotes();
  await storageSet({
    [CAPTURE_NOTES_KEY]: current.filter((note) => note.bac_id !== noteId),
  });
};

export const saveCollapsedSections = async (
  collapsedSections: WorkboardState['collapsedSections'],
): Promise<void> => {
  await storageSet({ [COLLAPSED_SECTIONS_KEY]: collapsedSections });
};

export const readCollapsedBuckets = async (): Promise<readonly AllThreadsBucket[]> =>
  await storageGet<readonly AllThreadsBucket[]>(COLLAPSED_BUCKETS_KEY, ['stale']);

export const saveCollapsedBuckets = async (
  collapsedBuckets: WorkboardState['collapsedBuckets'],
): Promise<void> => {
  await storageSet({ [COLLAPSED_BUCKETS_KEY]: collapsedBuckets });
};

export const readScreenShareMode = async (): Promise<boolean> =>
  await storageSessionGet<boolean>(SCREEN_SHARE_MODE_KEY, false);

export const saveScreenShareMode = async (enabled: boolean): Promise<void> => {
  await storageSessionSet({ [SCREEN_SHARE_MODE_KEY]: enabled });
};

export const upsertLocalThread = async (
  input: ThreadUpsert,
  result?: { readonly bac_id: string },
): Promise<TrackedThread> => {
  const current = await readThreads();
  // Canonicalize the URL so SPA URL drift (e.g. Gemini /app/<id> →
  // /app/<id>?something) doesn't fan one chat into multiple thread
  // records, which made dispatch links flicker as the matcher chased
  // whichever bac_id was created most recently.
  const canonicalUrl = canonicalThreadUrl(input.threadUrl);
  const existing = current.find(
    (thread) =>
      thread.bac_id === input.bac_id ||
      thread.threadUrl === canonicalUrl ||
      canonicalThreadUrl(thread.threadUrl) === canonicalUrl,
  );
  const bacId = result?.bac_id ?? input.bac_id ?? existing?.bac_id ?? createLocalBacId();
  const nextThread: TrackedThread = {
    bac_id: bacId,
    provider: input.provider,
    threadId: input.threadId,
    threadUrl: canonicalUrl,
    title: input.title,
    lastSeenAt: input.lastSeenAt,
    status: input.status ?? existing?.status ?? 'tracked',
    trackingMode: input.trackingMode ?? existing?.trackingMode ?? 'auto',
    primaryWorkstreamId: input.primaryWorkstreamId ?? existing?.primaryWorkstreamId,
    tags: input.tags ?? existing?.tags ?? [],
    tabSnapshot: input.tabSnapshot ?? existing?.tabSnapshot,
    parentThreadId: input.parentThreadId ?? existing?.parentThreadId,
    parentTitle: input.parentTitle ?? existing?.parentTitle,
    lastTurnRole: input.lastTurnRole ?? existing?.lastTurnRole,
    autoSendEnabled: existing?.autoSendEnabled,
    selectedModel: input.selectedModel ?? existing?.selectedModel,
  };
  await storageSet({
    [THREADS_KEY]: [
      nextThread,
      ...current.filter(
        (thread) =>
          thread.bac_id !== bacId &&
          thread.threadUrl !== canonicalUrl &&
          canonicalThreadUrl(thread.threadUrl) !== canonicalUrl,
      ),
    ],
  });
  return nextThread;
};

export const createLocalWorkstream = async (
  input: WorkstreamCreate,
  result?: { readonly bac_id: string; readonly revision: string },
): Promise<WorkstreamNode> => {
  const current = await readWorkstreams();
  const timestamp = new Date().toISOString();
  const node: WorkstreamNode = {
    bac_id: result?.bac_id ?? createLocalBacId(),
    revision: result?.revision ?? `local_${timestamp}`,
    title: input.title,
    parentId: input.parentId,
    children: [],
    tags: input.tags ?? [],
    checklist: [],
    privacy: input.privacy ?? 'shared',
    screenShareSensitive: input.screenShareSensitive ?? false,
    updatedAt: timestamp,
  };
  const withParent = current.map((candidate) =>
    candidate.bac_id === input.parentId
      ? {
          ...candidate,
          children: [...new Set([...candidate.children, node.bac_id])],
          updatedAt: timestamp,
        }
      : candidate,
  );
  await storageSet({ [WORKSTREAMS_KEY]: [node, ...withParent] });
  return node;
};

export const updateLocalWorkstream = async (
  workstreamId: string,
  update: WorkstreamUpdate,
  result?: { readonly revision: string },
): Promise<WorkstreamNode | undefined> => {
  const current = await readWorkstreams();
  const timestamp = new Date().toISOString();
  let updated: WorkstreamNode | undefined;
  const next = current.map((candidate) => {
    if (candidate.bac_id !== workstreamId) {
      return candidate;
    }
    updated = {
      ...candidate,
      ...update,
      bac_id: candidate.bac_id,
      revision: result?.revision ?? update.revision,
      children: update.children ?? candidate.children,
      checklist: update.checklist ?? candidate.checklist,
      tags: update.tags ?? candidate.tags,
      privacy: update.privacy ?? candidate.privacy,
      screenShareSensitive: update.screenShareSensitive ?? candidate.screenShareSensitive,
      updatedAt: timestamp,
    };
    return updated;
  });
  await storageSet({ [WORKSTREAMS_KEY]: next });
  return updated;
};

export const createLocalQueueItem = async (
  input: QueueCreate,
  result?: { readonly bac_id: string; readonly revision: string },
): Promise<QueueItem> => {
  const current = await readQueueItems();
  const timestamp = new Date().toISOString();
  const item: QueueItem = {
    bac_id: result?.bac_id ?? createLocalBacId(),
    text: input.text,
    scope: input.scope,
    targetId: input.targetId,
    status: input.status ?? 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await storageSet({ [QUEUE_ITEMS_KEY]: [item, ...current] });
  return item;
};

export const updateLocalQueueItem = async (
  queueItemId: string,
  update: QueueUpdate,
): Promise<QueueItem | undefined> => {
  const current = await readQueueItems();
  const timestamp = new Date().toISOString();
  let updated: QueueItem | undefined;
  const next = current.map((item) => {
    if (item.bac_id !== queueItemId) {
      return item;
    }
    // lastError tri-state: undefined = leave alone, null = clear,
    // string = overwrite. Build the next record without lastError
    // first, then add it back only when it should be set — that way
    // null actually clears the key rather than carrying it forward
    // from the old record via the spread.
    const status = update.status ?? item.status;
    const text = update.text ?? item.text;
    const next: QueueItem = {
      bac_id: item.bac_id,
      text,
      scope: item.scope,
      ...(item.targetId === undefined ? {} : { targetId: item.targetId }),
      status,
      createdAt: item.createdAt,
      updatedAt: timestamp,
    };
    let nextLastError: string | undefined = item.lastError;
    if (update.lastError === null) {
      nextLastError = undefined;
    } else if (typeof update.lastError === 'string') {
      nextLastError = update.lastError;
    }
    let nextProgress: QueueItem['progress'] | undefined = item.progress;
    if (update.progress === null || status !== 'pending') {
      nextProgress = undefined;
    } else if (update.progress === 'typing' || update.progress === 'waiting') {
      nextProgress = update.progress;
    }
    updated = {
      ...next,
      ...(nextLastError === undefined ? {} : { lastError: nextLastError }),
      ...(nextProgress === undefined ? {} : { progress: nextProgress }),
    };
    return updated;
  });
  await storageSet({ [QUEUE_ITEMS_KEY]: next });
  return updated;
};

// Stamp sortOrder on the items in the supplied id list (in order),
// preserving every other item untouched. Items not in the list keep
// whatever sortOrder they had — the caller is expected to pass the
// full ordered set of pending items it wants to re-rank (typically
// one thread's queue).
export const reorderLocalQueueItems = async (
  orderedIds: readonly string[],
): Promise<void> => {
  if (orderedIds.length === 0) {
    return;
  }
  const current = await readQueueItems();
  const rankByItemId = new Map<string, number>();
  orderedIds.forEach((id, index) => {
    rankByItemId.set(id, index);
  });
  const next = current.map((item) => {
    const rank = rankByItemId.get(item.bac_id);
    if (rank === undefined) {
      return item;
    }
    return { ...item, sortOrder: rank };
  });
  await storageSet({ [QUEUE_ITEMS_KEY]: next });
};

const normalizeForMatch = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim();

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True if `haystack` contains `needle` as whole word(s). Word-boundary
// match avoids false positives like "hi" matching "history" while still
// catching short queue items like "hi" inside a captured user turn
// "You said hi" — both \w/\W transitions hold.
const containsAsWord = (haystack: string, needle: string): boolean => {
  if (needle.length === 0) {
    return false;
  }
  // For multi-word needles ("on demand"), word-boundary on each side
  // works on the whole string since the inner space stays word-equivalent.
  const pattern = new RegExp(`\\b${escapeRegex(needle)}\\b`, 'u');
  return pattern.test(haystack);
};

// After a capture lands, scan pending queue items for the thread and flip
// any whose normalized text appears as a whole-word match in a recent
// USER turn. Returns the bac_ids that were transitioned (caller broadcasts).
//
// Word-boundary match (vs raw substring) lets short queue items like
// "hi" or "ok" auto-resolve when the user actually typed them, without
// false-positive matches against words that happen to start the same
// way ("history", "okay").
export const markQueueItemsDoneFromTurns = async (
  threadId: string,
  recentUserTexts: readonly string[],
): Promise<readonly string[]> => {
  if (recentUserTexts.length === 0) {
    return [];
  }
  const haystacks = recentUserTexts.map(normalizeForMatch).filter((value) => value.length > 0);
  if (haystacks.length === 0) {
    return [];
  }
  const current = await readQueueItems();
  const timestamp = new Date().toISOString();
  const transitioned: string[] = [];
  const next = current.map((item) => {
    if (item.targetId !== threadId || item.status !== 'pending') {
      return item;
    }
    const needle = normalizeForMatch(item.text);
    if (needle.length === 0) {
      return item;
    }
    const matched = haystacks.some((hay) => containsAsWord(hay, needle));
    if (!matched) {
      return item;
    }
    transitioned.push(item.bac_id);
    return { ...item, status: 'done' as const, updatedAt: timestamp };
  });
  if (transitioned.length === 0) {
    return [];
  }
  await storageSet({ [QUEUE_ITEMS_KEY]: next });
  return transitioned;
};

export const createLocalReminder = async (
  input: ReminderCreate,
  result?: { readonly bac_id: string; readonly revision?: string },
): Promise<InboundReminder> => {
  const current = await readReminders();
  const reminder: InboundReminder = {
    bac_id: result?.bac_id ?? createLocalBacId(),
    revision: result?.revision,
    threadId: input.threadId,
    provider: input.provider,
    detectedAt: input.detectedAt,
    status: input.status ?? 'new',
  };
  await storageSet({ [REMINDERS_KEY]: [reminder, ...current] });
  return reminder;
};

export const updateLocalReminder = async (
  reminderId: string,
  update: ReminderUpdate,
  result?: { readonly revision: string },
): Promise<InboundReminder | undefined> => {
  const current = await readReminders();
  let updated: InboundReminder | undefined;
  const next = current.map((reminder) => {
    if (reminder.bac_id !== reminderId) {
      return reminder;
    }
    updated = {
      ...reminder,
      ...update,
      revision: result?.revision ?? update.revision ?? reminder.revision,
    };
    return updated;
  });
  await storageSet({ [REMINDERS_KEY]: next });
  return updated;
};

// Per-thread auto-send opt-in. Independent of the per-provider gate
// in companionSettings.autoSendOptIn — both must be true for the
// drain to actually fire (see docs/proposals/auto-send-queue.md).
export const setThreadAutoSend = async (
  threadId: string,
  enabled: boolean,
): Promise<TrackedThread | undefined> => {
  const current = await readThreads();
  let updated: TrackedThread | undefined;
  const next = current.map((thread) => {
    if (thread.bac_id !== threadId) {
      return thread;
    }
    updated = { ...thread, autoSendEnabled: enabled };
    return updated;
  });
  if (updated === undefined) {
    return undefined;
  }
  await storageSet({ [THREADS_KEY]: next });
  return updated;
};

// Mark every non-dismissed reminder for a thread as dismissed.
// Called when the user explicitly captures the thread — they're
// actively looking at it, so the "Unread reply" pill is wrong.
export const dismissRemindersForThread = async (threadId: string): Promise<number> => {
  const current = await readReminders();
  let changed = 0;
  const next = current.map((reminder) => {
    if (reminder.threadId !== threadId || reminder.status === 'dismissed') {
      return reminder;
    }
    changed += 1;
    return { ...reminder, status: 'dismissed' as const };
  });
  if (changed > 0) {
    await storageSet({ [REMINDERS_KEY]: next });
  }
  return changed;
};

export const recordSelectorCanary = async (event: CaptureEvent): Promise<void> => {
  if (event.provider === 'unknown' || event.selectorCanary === undefined) {
    return;
  }
  const current = await readSelectorHealth();
  const warning =
    event.selectorCanary === 'ok'
      ? undefined
      : 'Provider selectors may have drifted. Clipboard fallback remains available.';
  const next: SelectorHealth = {
    provider: event.provider,
    latestStatus: event.selectorCanary,
    latestCheckedAt: event.capturedAt,
    warning,
  };
  await storageSet({
    [SELECTOR_HEALTH_KEY]: [next, ...current.filter((entry) => entry.provider !== event.provider)],
  });
};

export const buildWorkboardState = async (
  companionStatus: WorkboardState['companionStatus'],
  lastError?: string,
): Promise<WorkboardState> => {
  const vaultPath = await readVaultPath();
  return createEmptyWorkboardState({
    companionStatus,
    queuedCaptureCount: (await readQueue()).length,
    droppedCaptureCount: await readDroppedCount(),
    settings: await readSettings(),
    screenShareMode: await readScreenShareMode(),
    threads: await readThreads(),
    workstreams: await readWorkstreams(),
    queueItems: await readQueueItems(),
    reminders: await readReminders(),
    selectorHealth: await readSelectorHealth(),
    codingSessions: await readCachedCodingSessions(),
    captureNotes: await readCaptureNotes(),
    recentDispatches: await readCachedDispatches(),
    dispatchLinks: await readDispatchLinks(),
    dispatchDiagnostics: await readDispatchDiagnostics(),
    dispatchOriginals: await readDispatchOriginals(),
    lastDispatchTargetByThread: await readLastDispatchTargetByThread(),
    reviewDrafts: await readReviewDrafts(),
    collapsedSections: await storageGet<WorkboardState['collapsedSections']>(
      COLLAPSED_SECTIONS_KEY,
      [],
    ),
    collapsedBuckets: await readCollapsedBuckets(),
    ...(lastError === undefined ? {} : { lastError }),
    ...(vaultPath === undefined ? {} : { vaultPath }),
  });
};
