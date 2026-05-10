export const TAB_SESSION_BY_TAB_HASH_KEY = 'sidetrack.tabsession.byTabIdHash';

export interface StoredTabSession {
  readonly tabSessionId: string;
  readonly openedAt: string;
  readonly lastActivityAt: string;
  readonly idleSince?: string;
  readonly openerTabSessionId?: string;
  readonly windowIdHash?: string;
  readonly providerThreadKey?: string;
}

export type TabSessionByTabIdHash = Record<string, StoredTabSession>;

interface ChromeStorageLocal {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

export interface TabSessionStorage {
  readonly readAll: () => Promise<TabSessionByTabIdHash>;
  readonly writeAll: (records: TabSessionByTabIdHash) => Promise<void>;
  readonly get: (tabIdHash: string) => Promise<StoredTabSession | undefined>;
  readonly set: (tabIdHash: string, record: StoredTabSession) => Promise<void>;
  readonly remove: (tabIdHash: string) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseStoredTabSession = (value: unknown): StoredTabSession | undefined => {
  if (!isRecord(value)) return undefined;
  const tabSessionId = value['tabSessionId'];
  const openedAt = value['openedAt'];
  const lastActivityAt = value['lastActivityAt'];
  if (typeof tabSessionId !== 'string' || tabSessionId.length === 0) return undefined;
  if (typeof openedAt !== 'string' || openedAt.length === 0) return undefined;
  if (typeof lastActivityAt !== 'string' || lastActivityAt.length === 0) return undefined;
  const idleSince = value['idleSince'];
  const openerTabSessionId = value['openerTabSessionId'];
  const windowIdHash = value['windowIdHash'];
  const providerThreadKey = value['providerThreadKey'];
  return {
    tabSessionId,
    openedAt,
    lastActivityAt,
    ...(typeof idleSince === 'string' && idleSince.length > 0 ? { idleSince } : {}),
    ...(typeof openerTabSessionId === 'string' && openerTabSessionId.length > 0
      ? { openerTabSessionId }
      : {}),
    ...(typeof windowIdHash === 'string' && windowIdHash.length > 0 ? { windowIdHash } : {}),
    ...(typeof providerThreadKey === 'string' && providerThreadKey.length > 0
      ? { providerThreadKey }
      : {}),
  };
};

const parseByTabIdHash = (value: unknown): TabSessionByTabIdHash => {
  if (!isRecord(value)) return {};
  const out: TabSessionByTabIdHash = {};
  for (const [tabIdHash, raw] of Object.entries(value)) {
    const parsed = parseStoredTabSession(raw);
    if (parsed !== undefined) out[tabIdHash] = parsed;
  }
  return out;
};

const chromeStorageLocal = (): ChromeStorageLocal => {
  const c = (
    globalThis as unknown as { chrome?: { storage?: { local?: ChromeStorageLocal } } }
  ).chrome;
  const local = c?.storage?.local;
  if (local === undefined) throw new Error('chrome.storage.local is unavailable');
  return local;
};

export const createChromeTabSessionStorage = (
  storage: ChromeStorageLocal = chromeStorageLocal(),
): TabSessionStorage => {
  const readAll = async (): Promise<TabSessionByTabIdHash> => {
    const got = await storage.get(TAB_SESSION_BY_TAB_HASH_KEY);
    return parseByTabIdHash(got[TAB_SESSION_BY_TAB_HASH_KEY]);
  };
  const writeAll = async (records: TabSessionByTabIdHash): Promise<void> => {
    await storage.set({ [TAB_SESSION_BY_TAB_HASH_KEY]: records });
  };
  return {
    readAll,
    writeAll,
    get: async (tabIdHash) => (await readAll())[tabIdHash],
    set: async (tabIdHash, record) => {
      const records = await readAll();
      await writeAll({ ...records, [tabIdHash]: record });
    },
    remove: async (tabIdHash) => {
      const records = await readAll();
      const next = { ...records };
      delete next[tabIdHash];
      await writeAll(next);
    },
  };
};
