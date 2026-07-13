import {
  emptyEngagementTotals,
  mergeEngagementTotals,
  type EngagementTotals,
} from '../../content/engagement/aggregator';

// Durable engagement-session store.
//
// The engagement `session.aggregated` event is the ONLY event the
// companion classifier folds into a visit node's `focusedWindowMs`
// (companion engagement-class-revision.ts) — and that number drives the
// >=5000ms visit-similarity engagement gate, which is the sole feeder of
// `visit_resembles_visit` edges. If aggregates stop, similarity-based
// attribution goes dark vault-wide.
//
// Historically the in-memory engagement cache (`engagementCache.ts`) held
// unfinalized sessions in a plain `Map` and emitted `session.aggregated`
// only when a best-effort teardown beacon (`pagehide`/`beforeunload`/
// `visibilitychange`) reached a LIVE service worker, or when
// `chrome.tabs.onRemoved` fired while the SW happened to be awake. Under
// MV3 service-worker idle-eviction both are unreliable: an evicted SW
// loses every unfinalized session, so aggregates can silently stop for
// weeks while periodic (non-final) intervals keep flowing (they only need
// the SW alive at SOME 30s tick). This store makes unfinalized sessions
// SURVIVE eviction by persisting them to `chrome.storage.local`, so a
// periodic idle-sweep and an SW-wake seal can always finalize orphans.

export const ENGAGEMENT_SESSIONS_KEY = 'sidetrack.engagement.sessionsByTab';

export interface StoredEngagementSession {
  readonly visitId: string;
  readonly sessionId: string;
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly updatedAt: number;
  readonly totals: EngagementTotals;
}

export type EngagementSessionsByTab = Record<string, StoredEngagementSession>;

interface ChromeStorageLocal {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

export interface EngagementSessionStore {
  readonly readAll: () => Promise<EngagementSessionsByTab>;
  readonly get: (tabId: number) => Promise<StoredEngagementSession | undefined>;
  readonly set: (tabId: number, record: StoredEngagementSession) => Promise<void>;
  readonly remove: (tabId: number) => Promise<StoredEngagementSession | undefined>;
  readonly mutate: (
    apply: (records: EngagementSessionsByTab) => EngagementSessionsByTab,
  ) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseTotals = (value: unknown): EngagementTotals => {
  const base = emptyEngagementTotals();
  if (!isRecord(value)) return base;
  const out: Record<string, number> = { ...base };
  for (const key of Object.keys(base) as (keyof EngagementTotals)[]) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out as unknown as EngagementTotals;
};

const parseSession = (value: unknown): StoredEngagementSession | undefined => {
  if (!isRecord(value)) return undefined;
  const visitId = value['visitId'];
  const sessionId = value['sessionId'];
  const intervalStart = value['intervalStart'];
  const intervalEnd = value['intervalEnd'];
  const updatedAt = value['updatedAt'];
  if (typeof visitId !== 'string' || visitId.length === 0) return undefined;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  if (typeof intervalStart !== 'number' || !Number.isFinite(intervalStart)) return undefined;
  if (typeof intervalEnd !== 'number' || !Number.isFinite(intervalEnd)) return undefined;
  return {
    visitId,
    sessionId,
    intervalStart,
    intervalEnd,
    updatedAt:
      typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : intervalEnd,
    totals: parseTotals(value['totals']),
  };
};

const parseSessionsByTab = (value: unknown): EngagementSessionsByTab => {
  if (!isRecord(value)) return {};
  const out: EngagementSessionsByTab = {};
  for (const [tabKey, raw] of Object.entries(value)) {
    const parsed = parseSession(raw);
    if (parsed !== undefined) out[tabKey] = parsed;
  }
  return out;
};

const chromeStorageLocal = (): ChromeStorageLocal => {
  const c = (globalThis as unknown as { chrome?: { storage?: { local?: ChromeStorageLocal } } })
    .chrome;
  const local = c?.storage?.local;
  if (local === undefined) throw new Error('chrome.storage.local is unavailable');
  return local;
};

export const createChromeEngagementSessionStore = (
  storage: ChromeStorageLocal = chromeStorageLocal(),
): EngagementSessionStore => {
  // Serialize mutations so concurrent interval/finalize/sweep writers
  // read-modify-write against the same base snapshot without clobbering.
  let mutationQueue: Promise<void> = Promise.resolve();
  const readAll = async (): Promise<EngagementSessionsByTab> => {
    const got = await storage.get(ENGAGEMENT_SESSIONS_KEY);
    return parseSessionsByTab(got[ENGAGEMENT_SESSIONS_KEY]);
  };
  const mutate = async (
    apply: (records: EngagementSessionsByTab) => EngagementSessionsByTab,
  ): Promise<void> => {
    const run = mutationQueue.then(async () => {
      const records = await readAll();
      await storage.set({ [ENGAGEMENT_SESSIONS_KEY]: apply(records) });
    });
    mutationQueue = run.catch(() => {});
    await run;
  };
  return {
    readAll,
    mutate,
    get: async (tabId) => (await readAll())[String(tabId)],
    set: async (tabId, record) =>
      mutate((records) => ({ ...records, [String(tabId)]: record })),
    remove: async (tabId) => {
      let removed: StoredEngagementSession | undefined;
      await mutate((records) => {
        removed = records[String(tabId)];
        if (removed === undefined) return records;
        const next = { ...records };
        delete next[String(tabId)];
        return next;
      });
      return removed;
    },
  };
};

// Fold a new interval's totals into the stored session for a tab,
// returning the updated record. `sessionId`/`intervalStart` are pinned to
// the first interval seen for the tab (matching the in-memory cache), so
// the derived aggregate is stable across the session's lifetime.
export const foldIntervalIntoSession = (input: {
  readonly existing: StoredEngagementSession | undefined;
  readonly baseSessionId: string;
  readonly tabId: number;
  readonly visitId: string;
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly totals: EngagementTotals;
  readonly now: number;
}): StoredEngagementSession => {
  const { existing } = input;
  const mergedTotals =
    existing === undefined
      ? mergeEngagementTotals(emptyEngagementTotals(), input.totals)
      : mergeEngagementTotals(existing.totals, input.totals);
  return {
    visitId: input.visitId,
    sessionId:
      existing?.sessionId ??
      `${input.baseSessionId}:tab:${String(input.tabId)}:start:${String(input.intervalStart)}`,
    intervalStart: Math.min(existing?.intervalStart ?? input.intervalStart, input.intervalStart),
    intervalEnd: Math.max(existing?.intervalEnd ?? input.intervalEnd, input.intervalEnd),
    updatedAt: input.now,
    totals: mergedTotals,
  };
};
