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
import {
  createEmptyWorkboardState,
  defaultSettings,
  type CaptureNote,
  type CodingSession,
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
const CODING_SESSIONS_KEY = 'sidetrack.codingSessions';
const CAPTURE_NOTES_KEY = 'sidetrack.captureNotes';
const VAULT_PATH_KEY = 'sidetrack.vaultPath';

const storageGet = async <TValue>(key: string, fallback: TValue): Promise<TValue> => {
  const result = await chrome.storage.local.get({ [key]: fallback });
  return result[key] as TValue;
};

const storageSet = async (values: Record<string, unknown>): Promise<void> => {
  await chrome.storage.local.set(values);
};

const createLocalBacId = (): string => `bac_${crypto.randomUUID().replaceAll('-', '_')}`;

export const readSettings = async (): Promise<UiSettings> =>
  await storageGet<UiSettings>(SETTINGS_KEY, defaultSettings);

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

export const upsertLocalThread = async (
  input: ThreadUpsert,
  result?: { readonly bac_id: string },
): Promise<TrackedThread> => {
  const current = await readThreads();
  const existing = current.find(
    (thread) => thread.bac_id === input.bac_id || thread.threadUrl === input.threadUrl,
  );
  const bacId = result?.bac_id ?? input.bac_id ?? existing?.bac_id ?? createLocalBacId();
  const nextThread: TrackedThread = {
    bac_id: bacId,
    provider: input.provider,
    threadId: input.threadId,
    threadUrl: input.threadUrl,
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
  };
  await storageSet({
    [THREADS_KEY]: [
      nextThread,
      ...current.filter(
        (thread) => thread.bac_id !== bacId && thread.threadUrl !== input.threadUrl,
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
    privacy: input.privacy ?? 'private',
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
    updated = nextLastError === undefined ? next : { ...next, lastError: nextLastError };
    return updated;
  });
  await storageSet({ [QUEUE_ITEMS_KEY]: next });
  return updated;
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
    threads: await readThreads(),
    workstreams: await readWorkstreams(),
    queueItems: await readQueueItems(),
    reminders: await readReminders(),
    selectorHealth: await readSelectorHealth(),
    codingSessions: await readCachedCodingSessions(),
    captureNotes: await readCaptureNotes(),
    collapsedSections: await storageGet<WorkboardState['collapsedSections']>(
      COLLAPSED_SECTIONS_KEY,
      [],
    ),
    ...(lastError === undefined ? {} : { lastError }),
    ...(vaultPath === undefined ? {} : { vaultPath }),
  });
};
