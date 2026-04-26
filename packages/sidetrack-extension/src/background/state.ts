import type {
  CaptureEvent,
  CompanionSettings,
  QueueCreate,
  ReminderCreate,
  ThreadUpsert,
  WorkstreamCreate,
  WorkstreamUpdate,
} from '../companion/model';
import { readDroppedCount, readQueue } from '../companion/queue';
import {
  createEmptyWorkboardState,
  defaultSettings,
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

export const createLocalReminder = async (
  input: ReminderCreate,
  result?: { readonly bac_id: string },
): Promise<InboundReminder> => {
  const current = await readReminders();
  const reminder: InboundReminder = {
    bac_id: result?.bac_id ?? createLocalBacId(),
    threadId: input.threadId,
    provider: input.provider,
    detectedAt: input.detectedAt,
    status: input.status ?? 'new',
  };
  await storageSet({ [REMINDERS_KEY]: [reminder, ...current] });
  return reminder;
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
): Promise<WorkboardState> =>
  createEmptyWorkboardState({
    companionStatus,
    queuedCaptureCount: (await readQueue()).length,
    droppedCaptureCount: await readDroppedCount(),
    settings: await readSettings(),
    threads: await readThreads(),
    workstreams: await readWorkstreams(),
    queueItems: await readQueueItems(),
    reminders: await readReminders(),
    selectorHealth: await readSelectorHealth(),
    collapsedSections: await storageGet<WorkboardState['collapsedSections']>(
      COLLAPSED_SECTIONS_KEY,
      [],
    ),
    ...(lastError === undefined ? {} : { lastError }),
  });
