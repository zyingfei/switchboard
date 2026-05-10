import { mintTabSessionId } from './idMint';
import type { StoredTabSession, TabSessionStorage } from './storage';

const IDLE_SOFT_CLOSE_MS = 15 * 60 * 1000;
const SOFT_CLOSE_DRIFT_THRESHOLD = 0.4;

export interface TabSessionActivityInput {
  readonly tabIdHash: string;
  readonly windowIdHash?: string;
  readonly url: string;
  readonly at?: Date;
}

export interface TabSessionCreatedInput {
  readonly tabIdHash: string;
  readonly windowIdHash?: string;
  readonly openerTabIdHash?: string;
  readonly at?: Date;
}

export interface TabSessionInfo {
  readonly tabSessionId: string;
  readonly openerTabSessionId?: string;
}

export interface TabSessionBoundary {
  readonly recordTabCreated: (input: TabSessionCreatedInput) => Promise<TabSessionInfo>;
  readonly recordActivity: (input: TabSessionActivityInput) => Promise<TabSessionInfo>;
  readonly hardStopTab: (tabIdHash: string) => Promise<void>;
  readonly hardStopWindow: (windowIdHash: string) => Promise<void>;
  readonly hardStopForExplicitMove: (tabIdHash: string) => Promise<void>;
  readonly markIdle: (at?: Date) => Promise<void>;
  readonly markActive: (at?: Date) => Promise<void>;
  readonly sweepIdle: (at?: Date) => Promise<void>;
}

export interface TabSessionBoundaryDeps {
  readonly storage: TabSessionStorage;
  readonly mintId?: (now: Date) => string;
  readonly clock?: () => Date;
  readonly softCloseOnIdleDriftEnabled?: boolean;
  readonly embeddingDriftForTab?: (
    tabIdHash: string,
    record: StoredTabSession,
  ) => number | undefined;
}

const knownProviderThreadKey = (input: string): string | undefined => {
  try {
    const url = new URL(input);
    const path = url.pathname.split('/').filter((part) => part.length > 0);
    if (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') {
      const cIndex = path.lastIndexOf('c');
      const id = cIndex >= 0 ? path[cIndex + 1] : undefined;
      return id === undefined ? undefined : `chatgpt:${id}`;
    }
    if (url.hostname === 'claude.ai') {
      const chatIndex = path.lastIndexOf('chat');
      const id = chatIndex >= 0 ? path[chatIndex + 1] : undefined;
      return id === undefined ? undefined : `claude:${id}`;
    }
    if (url.hostname === 'gemini.google.com' && path[0] === 'app' && path[1] !== undefined) {
      return `gemini:${path[1]}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const asIso = (date: Date): string => date.toISOString();

export const createTabSessionBoundary = (deps: TabSessionBoundaryDeps): TabSessionBoundary => {
  const mintId = deps.mintId ?? ((now: Date) => mintTabSessionId(now));
  const clock = deps.clock ?? (() => new Date());

  const createRecord = (input: {
    readonly now: Date;
    readonly openerTabSessionId?: string;
    readonly windowIdHash?: string;
    readonly providerThreadKey?: string;
  }): StoredTabSession => ({
    tabSessionId: mintId(input.now),
    openedAt: asIso(input.now),
    lastActivityAt: asIso(input.now),
    ...(input.openerTabSessionId === undefined
      ? {}
      : { openerTabSessionId: input.openerTabSessionId }),
    ...(input.windowIdHash === undefined ? {} : { windowIdHash: input.windowIdHash }),
    ...(input.providerThreadKey === undefined
      ? {}
      : { providerThreadKey: input.providerThreadKey }),
  });

  const recordTabCreated = async (input: TabSessionCreatedInput): Promise<TabSessionInfo> => {
    const now = input.at ?? clock();
    const opener =
      input.openerTabIdHash === undefined
        ? undefined
        : await deps.storage.get(input.openerTabIdHash);
    const record = createRecord({
      now,
      ...(opener === undefined ? {} : { openerTabSessionId: opener.tabSessionId }),
      ...(input.windowIdHash === undefined ? {} : { windowIdHash: input.windowIdHash }),
    });
    await deps.storage.set(input.tabIdHash, record);
    return {
      tabSessionId: record.tabSessionId,
      ...(record.openerTabSessionId === undefined
        ? {}
        : { openerTabSessionId: record.openerTabSessionId }),
    };
  };

  const recordActivity = async (input: TabSessionActivityInput): Promise<TabSessionInfo> => {
    const now = input.at ?? clock();
    const providerThreadKey = knownProviderThreadKey(input.url);
    const existing = await deps.storage.get(input.tabIdHash);
    const threadChanged =
      existing !== undefined &&
      providerThreadKey !== undefined &&
      existing.providerThreadKey !== undefined &&
      existing.providerThreadKey !== providerThreadKey;
    const record = (() => {
      if (existing === undefined || threadChanged) {
        return createRecord({
          now,
          ...(input.windowIdHash === undefined ? {} : { windowIdHash: input.windowIdHash }),
          ...(providerThreadKey === undefined ? {} : { providerThreadKey }),
        });
      }
      const { idleSince, ...awakeExisting } = existing;
      void idleSince;
      return {
        ...awakeExisting,
        lastActivityAt: asIso(now),
        ...(input.windowIdHash === undefined ? {} : { windowIdHash: input.windowIdHash }),
        ...(providerThreadKey === undefined ? {} : { providerThreadKey }),
      };
    })();
    await deps.storage.set(input.tabIdHash, record);
    return {
      tabSessionId: record.tabSessionId,
      ...(record.openerTabSessionId === undefined
        ? {}
        : { openerTabSessionId: record.openerTabSessionId }),
    };
  };

  const hardStopTab = async (tabIdHash: string): Promise<void> => {
    await deps.storage.remove(tabIdHash);
  };

  const hardStopWindow = async (windowIdHash: string): Promise<void> => {
    const records = await deps.storage.readAll();
    const next = { ...records };
    for (const [tabIdHash, record] of Object.entries(records)) {
      if (record.windowIdHash === windowIdHash) delete next[tabIdHash];
    }
    await deps.storage.writeAll(next);
  };

  const markIdle = async (at: Date = clock()): Promise<void> => {
    const now = asIso(at);
    const records = await deps.storage.readAll();
    const next: Record<string, StoredTabSession> = {};
    for (const [tabIdHash, record] of Object.entries(records)) {
      next[tabIdHash] = { ...record, idleSince: record.idleSince ?? now };
    }
    await deps.storage.writeAll(next);
  };

  const markActive = async (at: Date = clock()): Promise<void> => {
    const now = asIso(at);
    const records = await deps.storage.readAll();
    const next: Record<string, StoredTabSession> = {};
    for (const [tabIdHash, record] of Object.entries(records)) {
      const { idleSince, ...awakeRecord } = record;
      void idleSince;
      next[tabIdHash] = { ...awakeRecord, lastActivityAt: now };
    }
    await deps.storage.writeAll(next);
  };

  const sweepIdle = async (at: Date = clock()): Promise<void> => {
    if (deps.softCloseOnIdleDriftEnabled !== true) return;
    const records = await deps.storage.readAll();
    const next = { ...records };
    for (const [tabIdHash, record] of Object.entries(records)) {
      if (record.idleSince === undefined) continue;
      const idleMs = at.getTime() - Date.parse(record.idleSince);
      const drift = deps.embeddingDriftForTab?.(tabIdHash, record) ?? 0;
      if (idleMs >= IDLE_SOFT_CLOSE_MS && drift >= SOFT_CLOSE_DRIFT_THRESHOLD) {
        delete next[tabIdHash];
      }
    }
    await deps.storage.writeAll(next);
  };

  return {
    recordTabCreated,
    recordActivity,
    hardStopTab,
    hardStopWindow,
    hardStopForExplicitMove: hardStopTab,
    markIdle,
    markActive,
    sweepIdle,
  };
};
