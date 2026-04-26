import {
  normalizeProviderCapture,
  supportedProviderIds,
  type ProviderCapture,
  type ProviderId,
  type ProviderSelectorHealth,
  type SelectorCanary,
  type SupportedProviderId,
  type TrackedThreadStatus,
} from '../capture/model';
import { stableHash } from '../shared/ids';
import { storageKeys } from '../shared/storageKeys';

const maxRecentHealthSamples = 10;

export interface TrackedThread {
  provider: ProviderId;
  threadId: string;
  threadUrl: string;
  title: string;
  lastTurnAt: string;
  captureCount: number;
  status: TrackedThreadStatus;
}

export interface TrackedThreadFilter {
  provider?: ProviderId;
  status?: TrackedThreadStatus | TrackedThreadStatus[];
  threadId?: string;
  threadUrl?: string;
  limit?: number;
}

export interface SelectorCanaryReport {
  provider: ProviderId;
  url: string;
  title: string;
  selectorCanary: SelectorCanary;
  checkedAt: string;
  loadId: string;
}

interface SelectorHealthSample {
  loadId: string;
  threadUrl: string;
  selectorCanary: SelectorCanary;
  checkedAt: string;
}

type SelectorHealthStore = Partial<Record<SupportedProviderId, SelectorHealthSample[]>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeTrackedThreadStatus = (value: unknown): TrackedThreadStatus =>
  value === 'active' ||
  value === 'waiting_on_user' ||
  value === 'waiting_on_ai' ||
  value === 'stale' ||
  value === 'fallback'
    ? value
    : 'active';

const normalizeSelectorCanary = (value: unknown): SelectorCanary =>
  value === 'passed' || value === 'fallback' || value === 'failed' ? value : 'failed';

const normalizeThreadUrl = (inputUrl: string): string => {
  try {
    const url = new URL(inputUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return inputUrl;
  }
};

const extractThreadId = (provider: ProviderId, inputUrl: string): string => {
  try {
    const url = new URL(inputUrl);
    const pathname = url.pathname;
    const chatGptMatch = pathname.match(/\/c\/([^/?#]+)/);
    if (provider === 'chatgpt' && chatGptMatch) {
      return chatGptMatch[1];
    }

    const claudeMatch = pathname.match(/\/chat\/([^/?#]+)/);
    if (provider === 'claude' && claudeMatch) {
      return claudeMatch[1];
    }

    const geminiMatch = pathname.match(/\/app\/([^/?#]+)/);
    if (provider === 'gemini' && geminiMatch) {
      return geminiMatch[1];
    }
  } catch {
    return stableHash(inputUrl).slice(0, 12);
  }

  return stableHash(normalizeThreadUrl(inputUrl)).slice(0, 12);
};

const threadKey = (provider: ProviderId, threadUrl: string): string => `${provider}:${normalizeThreadUrl(threadUrl)}`;

const statusForSelectorCanary = (selectorCanary: SelectorCanary): TrackedThreadStatus => {
  if (selectorCanary === 'passed') {
    return 'active';
  }
  if (selectorCanary === 'fallback') {
    return 'fallback';
  }
  return 'stale';
};

const compareIsoDesc = (left: string, right: string): number => right.localeCompare(left);

const normalizeTrackedThread = (value: unknown): TrackedThread | null => {
  if (!isRecord(value)) {
    return null;
  }

  const provider = value.provider;
  if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'gemini' && provider !== 'unknown') {
    return null;
  }

  const threadUrl = typeof value.threadUrl === 'string' ? normalizeThreadUrl(value.threadUrl) : '';
  const title = typeof value.title === 'string' ? value.title : 'Untitled thread';
  const threadId =
    typeof value.threadId === 'string' && value.threadId.trim().length > 0
      ? value.threadId
      : extractThreadId(provider, threadUrl);

  return {
    provider,
    threadId,
    threadUrl,
    title,
    lastTurnAt: typeof value.lastTurnAt === 'string' ? value.lastTurnAt : new Date(0).toISOString(),
    captureCount: typeof value.captureCount === 'number' ? value.captureCount : 0,
    status: normalizeTrackedThreadStatus(value.status),
  };
};

const normalizeSelectorHealthStore = (value: unknown): SelectorHealthStore => {
  const record = isRecord(value) ? value : {};
  const normalized: SelectorHealthStore = {};

  supportedProviderIds.forEach((provider) => {
    const entries = Array.isArray(record[provider]) ? record[provider] : [];
    normalized[provider] = entries
      .map((entry) => (isRecord(entry) ? entry : null))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ({
        loadId:
          typeof entry.loadId === 'string' && entry.loadId.length > 0
            ? entry.loadId
            : stableHash(
                `${provider}:${typeof entry.threadUrl === 'string' ? entry.threadUrl : ''}:${
                  typeof entry.checkedAt === 'string' ? entry.checkedAt : ''
                }`,
              ),
        threadUrl: typeof entry.threadUrl === 'string' ? normalizeThreadUrl(entry.threadUrl) : '',
        selectorCanary: normalizeSelectorCanary(entry.selectorCanary),
        checkedAt: typeof entry.checkedAt === 'string' ? entry.checkedAt : new Date(0).toISOString(),
      }))
      .filter((entry) => entry.threadUrl.length > 0)
      .slice(-maxRecentHealthSamples);
  });

  return normalized;
};

const trackedThreadFromCapture = (capture: ProviderCapture, previous?: TrackedThread): TrackedThread => {
  const threadUrl = normalizeThreadUrl(capture.url);
  return {
    provider: capture.provider,
    threadId: extractThreadId(capture.provider, threadUrl),
    threadUrl,
    title: capture.title || previous?.title || 'Untitled thread',
    lastTurnAt: capture.capturedAt,
    captureCount: (previous?.captureCount ?? 0) + 1,
    status: statusForSelectorCanary(capture.selectorCanary),
  };
};

const trackedThreadFromCanary = (report: SelectorCanaryReport, previous?: TrackedThread): TrackedThread => {
  const threadUrl = normalizeThreadUrl(report.url);
  return {
    provider: report.provider,
    threadId: previous?.threadId ?? extractThreadId(report.provider, threadUrl),
    threadUrl,
    title: report.title || previous?.title || 'Untitled thread',
    lastTurnAt: report.checkedAt,
    captureCount: previous?.captureCount ?? 0,
    status: statusForSelectorCanary(report.selectorCanary),
  };
};

const readRawTrackedThreads = async (): Promise<unknown> => {
  const result = await chrome.storage.local.get(storageKeys.trackedThreads);
  return result[storageKeys.trackedThreads];
};

const writeTrackedThreads = async (threads: TrackedThread[]): Promise<void> => {
  await chrome.storage.local.set({ [storageKeys.trackedThreads]: threads });
};

const readCaptureBackfill = async (): Promise<TrackedThread[]> => {
  const result = await chrome.storage.local.get(storageKeys.captures);
  const rawCaptures = result[storageKeys.captures];
  const captures = Array.isArray(rawCaptures) ? rawCaptures : [];
  const byThread = new Map<string, TrackedThread>();

  captures
    .map(normalizeProviderCapture)
    .forEach((capture: ProviderCapture) => {
      const previous = byThread.get(threadKey(capture.provider, capture.url));
      byThread.set(threadKey(capture.provider, capture.url), trackedThreadFromCapture(capture, previous));
    });

  return Array.from(byThread.values()).sort((left, right) => compareIsoDesc(left.lastTurnAt, right.lastTurnAt));
};

const readTrackedThreadsStore = async (): Promise<TrackedThread[]> => {
  const raw = await readRawTrackedThreads();
  const normalized = Array.isArray(raw)
    ? raw.map(normalizeTrackedThread).filter((thread): thread is TrackedThread => Boolean(thread))
    : [];

  if (Array.isArray(raw) && JSON.stringify(raw) !== JSON.stringify(normalized)) {
    await writeTrackedThreads(normalized);
  }

  if (normalized.length > 0) {
    return normalized.sort((left, right) => compareIsoDesc(left.lastTurnAt, right.lastTurnAt));
  }

  const backfill = await readCaptureBackfill();
  if (backfill.length > 0) {
    await writeTrackedThreads(backfill);
  }
  return backfill;
};

const readSelectorHealthStore = async (): Promise<SelectorHealthStore> => {
  const result = await chrome.storage.local.get(storageKeys.selectorHealth);
  const raw = result[storageKeys.selectorHealth];
  const normalized = normalizeSelectorHealthStore(raw);

  if (JSON.stringify(raw ?? {}) !== JSON.stringify(normalized)) {
    await chrome.storage.local.set({ [storageKeys.selectorHealth]: normalized });
  }

  return normalized;
};

const writeSelectorHealthStore = async (health: SelectorHealthStore): Promise<void> => {
  await chrome.storage.local.set({ [storageKeys.selectorHealth]: health });
};

export const clearSelectorHealth = async (): Promise<void> => {
  await chrome.storage.local.remove(storageKeys.selectorHealth);
};

export const getTrackedThreads = async (filter: TrackedThreadFilter = {}): Promise<TrackedThread[]> => {
  const threads = await readTrackedThreadsStore();
  const statuses = Array.isArray(filter.status) ? filter.status : filter.status ? [filter.status] : null;
  const filtered = threads.filter((thread) => {
    if (filter.provider && thread.provider !== filter.provider) {
      return false;
    }
    if (statuses && !statuses.includes(thread.status)) {
      return false;
    }
    if (filter.threadId && thread.threadId !== filter.threadId) {
      return false;
    }
    if (filter.threadUrl && normalizeThreadUrl(thread.threadUrl) !== normalizeThreadUrl(filter.threadUrl)) {
      return false;
    }
    return true;
  });

  return typeof filter.limit === 'number' ? filtered.slice(0, filter.limit) : filtered;
};

export const upsertTrackedThreadFromCapture = async (capture: ProviderCapture): Promise<TrackedThread> => {
  const threads = await readTrackedThreadsStore();
  const key = threadKey(capture.provider, capture.url);
  const nextThread = trackedThreadFromCapture(
    capture,
    threads.find((thread) => threadKey(thread.provider, thread.threadUrl) === key),
  );
  const nextThreads = [
    nextThread,
    ...threads.filter((thread) => threadKey(thread.provider, thread.threadUrl) !== key),
  ].sort((left, right) => compareIsoDesc(left.lastTurnAt, right.lastTurnAt));

  await writeTrackedThreads(nextThreads);
  return nextThread;
};

export const recordSelectorCanaryCheck = async (report: SelectorCanaryReport): Promise<void> => {
  if (report.provider !== 'chatgpt' && report.provider !== 'claude' && report.provider !== 'gemini') {
    return;
  }

  const threads = await readTrackedThreadsStore();
  const key = threadKey(report.provider, report.url);
  const nextThread = trackedThreadFromCanary(
    report,
    threads.find((thread) => threadKey(thread.provider, thread.threadUrl) === key),
  );
  const nextThreads = [
    nextThread,
    ...threads.filter((thread) => threadKey(thread.provider, thread.threadUrl) !== key),
  ].sort((left, right) => compareIsoDesc(left.lastTurnAt, right.lastTurnAt));

  await writeTrackedThreads(nextThreads);

  const health = await readSelectorHealthStore();
  const providerHistory = health[report.provider] ?? [];
  const nextSample = {
    loadId: report.loadId,
    threadUrl: normalizeThreadUrl(report.url),
    selectorCanary: report.selectorCanary,
    checkedAt: report.checkedAt,
  };
  const existingIndex = providerHistory.findIndex((sample) => sample.loadId === report.loadId);
  const nextHistory = (
    existingIndex >= 0
      ? providerHistory.map((sample, index) => (index === existingIndex ? nextSample : sample))
      : [...providerHistory, nextSample]
  ).slice(-maxRecentHealthSamples);

  await writeSelectorHealthStore({
    ...health,
    [report.provider]: nextHistory,
  });
};

export const readSelectorHealth = async (): Promise<ProviderSelectorHealth[]> => {
  const health = await readSelectorHealthStore();
  return supportedProviderIds.map((provider) => {
    const recent = health[provider] ?? [];
    const latest = recent[recent.length - 1];
    return {
      provider,
      cleanLoads: recent.filter((entry) => entry.selectorCanary === 'passed').length,
      recentLoads: recent.length,
      fallbackLoads: recent.filter((entry) => entry.selectorCanary === 'fallback').length,
      failedLoads: recent.filter((entry) => entry.selectorCanary === 'failed').length,
      latestStatus: latest?.selectorCanary,
      latestCheckedAt: latest?.checkedAt,
    };
  });
};
