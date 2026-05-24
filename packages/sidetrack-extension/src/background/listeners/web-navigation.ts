import type { BufferedEvent, EventBuffer } from '../storage/in-memory-event-buffer';
import { IndexedDbEventBuffer } from '../storage/indexeddb-event-buffer';
import { canonicalizeUrl } from '../../graph/canonical-url';
import { fnv1a32Hex, saltedFnv1a32Hex } from '../../graph/fnv1a';
import { allocateNextSeq, loadOrCreateEdgeReplica } from '../../sync/edgeReplicaId';
import type { TabOpenerStore } from './tabs';

export const NAVIGATION_COMMITTED = 'navigation.committed' as const;

export type NavigationTransitionType =
  | 'link'
  | 'typed'
  | 'auto_bookmark'
  | 'auto_subframe'
  | 'manual_subframe'
  | 'generated'
  | 'start_page'
  | 'form_submit'
  | 'reload'
  | 'keyword'
  | 'keyword_generated';

export type NavigationTransitionQualifier =
  | 'client_redirect'
  | 'server_redirect'
  | 'forward_back'
  | 'from_address_bar';

export interface NavigationCommittedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly documentId: string;
  readonly parentDocumentId: string | null;
  readonly tabSessionIdHash: string;
  readonly windowSessionIdHash: string;
  readonly openerVisitId: string | null;
  readonly previousVisitId: string | null;
  readonly navigationSequence: number;
  readonly transitionType: NavigationTransitionType;
  readonly transitionQualifiers: readonly NavigationTransitionQualifier[];
  readonly commitTimestamp: number;
  readonly dimensions?: {
    readonly provenance?: Record<string, unknown>;
  };
}

export interface WebNavigationCommittedDetails {
  readonly tabId: number;
  readonly frameId: number;
  readonly url: string;
  readonly timeStamp: number;
  readonly transitionType?: string;
  readonly transitionQualifiers?: readonly string[];
  readonly documentId?: string;
  readonly parentDocumentId?: string;
}

export interface NavigationLinkClickDetails {
  readonly tabId: number;
  readonly sourceUrl: string;
  readonly targetUrl: string;
  readonly timeStamp: number;
}

export interface NavigationTargetCreatedDetails {
  readonly sourceTabId: number;
  readonly tabId: number;
  readonly url: string;
  readonly timeStamp: number;
}

export interface WebNavigationApi {
  readonly onCommitted: {
    addListener(listener: (details: WebNavigationCommittedDetails) => void): void;
  };
  readonly onCreatedNavigationTarget?: {
    addListener(listener: (details: NavigationTargetCreatedDetails) => void): void;
  };
}

export interface TabsLookupApi {
  get(tabId: number): Promise<{
    readonly id?: number;
    readonly windowId?: number;
    readonly url?: string;
  }>;
}

export interface NavigationListenerDeps {
  readonly webNavigation: WebNavigationApi;
  readonly tabs: TabsLookupApi;
  readonly tabOpenerStore: TabOpenerStore;
  readonly eventBuffer: EventBuffer;
  readonly navigationStateStorage?: NavigationSessionStorage;
  readonly onNavigationBuffered?: () => void;
  readonly browserSessionStartMs: number;
  readonly edgeReplicaId: string;
  readonly allocateSeq: typeof allocateNextSeq;
  readonly now: () => Date;
}

interface NavigationSessionStorage {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

interface TabNavigationState {
  readonly lastVisitId: string;
  readonly navigationSequence: number;
  readonly updatedAtMs: number;
  readonly canonicalUrl?: string;
  readonly url?: string;
}

interface PersistedTabNavigationState {
  readonly lastVisitId: string;
  readonly navigationSequence: number;
  readonly updatedAtMs: number;
  readonly canonicalUrl?: string;
  readonly url?: string;
}

interface PendingLinkClick {
  readonly sourceVisitId: string;
  readonly sourceTabSessionIdHash: string;
  readonly targetCanonicalUrl: string;
  readonly clickedAtMs: number;
}

const TRANSITION_TYPES: ReadonlySet<string> = new Set([
  'link',
  'typed',
  'auto_bookmark',
  'auto_subframe',
  'manual_subframe',
  'generated',
  'start_page',
  'form_submit',
  'reload',
  'keyword',
  'keyword_generated',
]);

const TRANSITION_QUALIFIERS: ReadonlySet<string> = new Set([
  'client_redirect',
  'server_redirect',
  'forward_back',
  'from_address_bar',
]);

const BROWSER_SESSION_START_KEY = 'sidetrack.navigation.browserSessionStartMs';
const NAVIGATION_STATE_KEY = 'sidetrack.navigation.stateByTabSessionHash.v1';
const NAVIGATION_STATE_MAX_ENTRIES = 500;
const PENDING_LINK_CLICK_TTL_MS = 45_000;
const PENDING_LINK_CLICK_MAX_ENTRIES = 200;

const isTransitionType = (value: unknown): value is NavigationTransitionType =>
  typeof value === 'string' && TRANSITION_TYPES.has(value);

const isTransitionQualifier = (value: unknown): value is NavigationTransitionQualifier =>
  typeof value === 'string' && TRANSITION_QUALIFIERS.has(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNavigationCommittedPayload = (value: unknown): value is NavigationCommittedPayload =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  typeof value['visitId'] === 'string' &&
  typeof value['tabSessionIdHash'] === 'string' &&
  typeof value['navigationSequence'] === 'number';

const isPersistedTabNavigationState = (value: unknown): value is PersistedTabNavigationState =>
  isRecord(value) &&
  typeof value['lastVisitId'] === 'string' &&
  value['lastVisitId'].length > 0 &&
  typeof value['navigationSequence'] === 'number' &&
  Number.isFinite(value['navigationSequence']) &&
  typeof value['updatedAtMs'] === 'number' &&
  Number.isFinite(value['updatedAtMs']) &&
  (value['canonicalUrl'] === undefined || typeof value['canonicalUrl'] === 'string') &&
  (value['url'] === undefined || typeof value['url'] === 'string');

const isNavigationStateKey = (key: string): boolean =>
  key.length > 0 && key.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(key);

const readPersistedNavigationState = async (
  storage: NavigationSessionStorage,
): Promise<Map<string, TabNavigationState>> => {
  const got = await storage.get(NAVIGATION_STATE_KEY);
  const raw = got[NAVIGATION_STATE_KEY];
  const out = new Map<string, TabNavigationState>();
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isNavigationStateKey(key) || !isPersistedTabNavigationState(value)) continue;
    out.set(key, {
      lastVisitId: value.lastVisitId,
      navigationSequence: value.navigationSequence,
      updatedAtMs: value.updatedAtMs,
      ...(value.canonicalUrl === undefined ? {} : { canonicalUrl: value.canonicalUrl }),
      ...(value.url === undefined ? {} : { url: value.url }),
    });
  }
  return out;
};

const writePersistedNavigationState = async (
  storage: NavigationSessionStorage,
  stateByTabSessionHash: ReadonlyMap<string, TabNavigationState>,
): Promise<void> => {
  const entries = [...stateByTabSessionHash.entries()]
    .filter(([key]) => isNavigationStateKey(key))
    .sort((left, right) => right[1].updatedAtMs - left[1].updatedAtMs)
    .slice(0, NAVIGATION_STATE_MAX_ENTRIES);
  const payload: Record<string, PersistedTabNavigationState> = {};
  for (const [key, value] of entries) {
    payload[key] = {
      lastVisitId: value.lastVisitId,
      navigationSequence: value.navigationSequence,
      updatedAtMs: value.updatedAtMs,
      ...(value.canonicalUrl === undefined ? {} : { canonicalUrl: value.canonicalUrl }),
      ...(value.url === undefined ? {} : { url: value.url }),
    };
  }
  await storage.set({ [NAVIGATION_STATE_KEY]: payload });
};

const isHttpUrl = (value: string): boolean =>
  value.startsWith('https://') || value.startsWith('http://');

const stripWww = (host: string): string => host.replace(/^www\./u, '');

const comparablePath = (path: string): string =>
  path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

const sameNavigationTarget = (left: string, right: string): boolean => {
  if (left === right) return true;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      stripWww(leftUrl.hostname) === stripWww(rightUrl.hostname) &&
      comparablePath(leftUrl.pathname) === comparablePath(rightUrl.pathname) &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return false;
  }
};

const sessionHash = (
  edgeReplicaId: string,
  kind: 'tab' | 'window',
  id: number,
  browserSessionStartMs: number,
): string =>
  saltedFnv1a32Hex(edgeReplicaId, `${kind}|${String(id)}|${String(browserSessionStartMs)}`);

export const buildVisitId = (
  edgeReplicaId: string,
  canonicalUrl: string,
  commitTimestamp: number,
): string =>
  `visit_${String(Math.trunc(commitTimestamp))}_${saltedFnv1a32Hex(
    edgeReplicaId,
    `${canonicalUrl}|${String(Math.trunc(commitTimestamp))}`,
  )}`;

const fallbackDocumentId = (
  edgeReplicaId: string,
  canonicalUrl: string,
  tabSessionIdHash: string,
  commitTimestamp: number,
): string =>
  `doc_${saltedFnv1a32Hex(
    edgeReplicaId,
    `${tabSessionIdHash}|${canonicalUrl}|${String(Math.trunc(commitTimestamp))}`,
  )}`;

export const createWebNavigationListener = (
  deps: NavigationListenerDeps,
): {
  readonly handleCommitted: (details: WebNavigationCommittedDetails) => Promise<void>;
  readonly recordLinkClick: (details: NavigationLinkClickDetails) => Promise<void>;
  readonly recordNavigationTargetCreated: (
    details: NavigationTargetCreatedDetails,
  ) => Promise<void>;
  readonly hydrate: () => Promise<void>;
} => {
  const stateByTabSessionHash = new Map<string, TabNavigationState>();
  const pendingLinkClicks: PendingLinkClick[] = [];
  let hydrated = false;
  let hydratePromise: Promise<void> | null = null;

  const hydrate = async (): Promise<void> => {
    if (hydrated) return;
    if (hydratePromise !== null) return hydratePromise;
    hydratePromise = (async () => {
      if (deps.navigationStateStorage !== undefined) {
        const persisted = await readPersistedNavigationState(deps.navigationStateStorage);
        for (const [tabSessionIdHash, state] of persisted.entries()) {
          stateByTabSessionHash.set(tabSessionIdHash, state);
        }
      }
      const buffered = await deps.eventBuffer.peek(10_000);
      const ordered = [...buffered].sort((a, b) =>
        a.lamport === b.lamport ? a.replicaId.localeCompare(b.replicaId) : a.lamport - b.lamport,
      );
      for (const event of ordered) {
        if (event.streamName !== NAVIGATION_COMMITTED) continue;
        if (!isNavigationCommittedPayload(event.payload)) continue;
        stateByTabSessionHash.set(event.payload.tabSessionIdHash, {
          lastVisitId: event.payload.visitId,
          navigationSequence: event.payload.navigationSequence,
          updatedAtMs: Date.parse(event.observedAt) || deps.now().getTime(),
          canonicalUrl: event.payload.canonicalUrl,
          url: event.payload.url,
        });
      }
      hydrated = true;
    })();
    await hydratePromise;
  };

  const resolveWindowId = async (details: WebNavigationCommittedDetails): Promise<number> => {
    const tab = await deps.tabs.get(details.tabId);
    if (typeof tab.windowId !== 'number') {
      throw new Error('navigation.committed tab has no windowId');
    }
    return tab.windowId;
  };

  const prunePendingLinkClicks = (nowMs: number): void => {
    for (let index = pendingLinkClicks.length - 1; index >= 0; index -= 1) {
      if (nowMs - pendingLinkClicks[index]!.clickedAtMs > PENDING_LINK_CLICK_TTL_MS) {
        pendingLinkClicks.splice(index, 1);
      }
    }
    if (pendingLinkClicks.length > PENDING_LINK_CLICK_MAX_ENTRIES) {
      pendingLinkClicks.splice(0, pendingLinkClicks.length - PENDING_LINK_CLICK_MAX_ENTRIES);
    }
  };

  const consumePendingLinkClick = (
    targetCanonicalUrl: string,
    commitTimestamp: number,
  ): PendingLinkClick | null => {
    prunePendingLinkClicks(commitTimestamp);
    let matched: PendingLinkClick | null = null;
    for (let index = pendingLinkClicks.length - 1; index >= 0; index -= 1) {
      const pending = pendingLinkClicks[index]!;
      if (!sameNavigationTarget(pending.targetCanonicalUrl, targetCanonicalUrl)) continue;
      pendingLinkClicks.splice(index, 1);
      if (matched === null) matched = pending;
    }
    return matched;
  };

  const appendNavigationCommitted = async (payload: NavigationCommittedPayload): Promise<void> => {
    const allocated = await deps.allocateSeq(1);
    const bufferedEvent: BufferedEvent = {
      streamName: NAVIGATION_COMMITTED,
      lamport: allocated.fromSeq,
      replicaId: allocated.edgeReplicaId,
      payload,
      observedAt: deps.now().toISOString(),
    };
    await deps.eventBuffer.appendMany([bufferedEvent]);
    deps.onNavigationBuffered?.();
  };

  const resolveOpenerVisitId = async (openerTabId: number | null): Promise<string | null> => {
    if (openerTabId === null || deps.tabOpenerStore.wasRemoved(openerTabId)) return null;
    try {
      await deps.tabs.get(openerTabId);
    } catch {
      return null;
    }
    const openerTabSessionIdHash = sessionHash(
      deps.edgeReplicaId,
      'tab',
      openerTabId,
      deps.browserSessionStartMs,
    );
    return stateByTabSessionHash.get(openerTabSessionIdHash)?.lastVisitId ?? null;
  };

  const recordLinkClick = async (details: NavigationLinkClickDetails): Promise<void> => {
    await hydrate();
    const clickedAtMs = Number.isFinite(details.timeStamp)
      ? details.timeStamp
      : deps.now().getTime();
    const sourceCanonicalUrl = canonicalizeUrl(details.sourceUrl);
    const targetCanonicalUrl = canonicalizeUrl(details.targetUrl);
    if (!isHttpUrl(sourceCanonicalUrl) || !isHttpUrl(targetCanonicalUrl)) return;
    if (sameNavigationTarget(sourceCanonicalUrl, targetCanonicalUrl)) return;

    const windowId = await resolveWindowId({
      tabId: details.tabId,
      frameId: 0,
      url: details.sourceUrl,
      timeStamp: clickedAtMs,
    });
    const tabSessionIdHash = sessionHash(
      deps.edgeReplicaId,
      'tab',
      details.tabId,
      deps.browserSessionStartMs,
    );
    const windowSessionIdHash = sessionHash(
      deps.edgeReplicaId,
      'window',
      windowId,
      deps.browserSessionStartMs,
    );
    const existing = stateByTabSessionHash.get(tabSessionIdHash);
    let sourceVisitId: string;
    if (
      existing !== undefined &&
      (existing.canonicalUrl === undefined ||
        sameNavigationTarget(existing.canonicalUrl, sourceCanonicalUrl))
    ) {
      sourceVisitId = existing.lastVisitId;
    } else {
      const navigationSequence = (existing?.navigationSequence ?? 0) + 1;
      sourceVisitId = buildVisitId(deps.edgeReplicaId, sourceCanonicalUrl, clickedAtMs);
      await appendNavigationCommitted({
        payloadVersion: 1,
        visitId: sourceVisitId,
        url: details.sourceUrl,
        canonicalUrl: sourceCanonicalUrl,
        documentId: fallbackDocumentId(
          deps.edgeReplicaId,
          sourceCanonicalUrl,
          tabSessionIdHash,
          clickedAtMs,
        ),
        parentDocumentId: null,
        tabSessionIdHash,
        windowSessionIdHash,
        openerVisitId: null,
        previousVisitId: existing?.lastVisitId ?? null,
        navigationSequence,
        transitionType: 'link',
        transitionQualifiers: [],
        commitTimestamp: clickedAtMs,
        dimensions: {
          provenance: {
            source: 'content-script.link-click.source-fallback',
            rawUrlHash: fnv1a32Hex(details.sourceUrl),
            targetUrlHash: fnv1a32Hex(details.targetUrl),
          },
        },
      });
      stateByTabSessionHash.set(tabSessionIdHash, {
        lastVisitId: sourceVisitId,
        navigationSequence,
        updatedAtMs: clickedAtMs,
        canonicalUrl: sourceCanonicalUrl,
        url: details.sourceUrl,
      });
    }

    pendingLinkClicks.push({
      sourceVisitId,
      sourceTabSessionIdHash: tabSessionIdHash,
      targetCanonicalUrl,
      clickedAtMs,
    });
    prunePendingLinkClicks(clickedAtMs);
    if (deps.navigationStateStorage !== undefined) {
      await writePersistedNavigationState(deps.navigationStateStorage, stateByTabSessionHash).catch(
        () => undefined,
      );
    }
  };

  const recordNavigationTargetCreated = async (
    details: NavigationTargetCreatedDetails,
  ): Promise<void> => {
    if (!isHttpUrl(details.url)) return;
    const sourceTab = await deps.tabs.get(details.sourceTabId);
    if (typeof sourceTab.url !== 'string' || !isHttpUrl(sourceTab.url)) return;
    deps.tabOpenerStore.rememberCreated(details.tabId, details.sourceTabId);
    await recordLinkClick({
      tabId: details.sourceTabId,
      sourceUrl: sourceTab.url,
      targetUrl: details.url,
      timeStamp: details.timeStamp,
    });
  };

  const handleCommitted = async (details: WebNavigationCommittedDetails): Promise<void> => {
    if (details.frameId !== 0) return;
    await hydrate();

    const commitTimestamp = Number.isFinite(details.timeStamp)
      ? details.timeStamp
      : deps.now().getTime();
    const canonicalUrl = canonicalizeUrl(details.url);
    const windowId = await resolveWindowId(details);
    const tabSessionIdHash = sessionHash(
      deps.edgeReplicaId,
      'tab',
      details.tabId,
      deps.browserSessionStartMs,
    );
    const windowSessionIdHash = sessionHash(
      deps.edgeReplicaId,
      'window',
      windowId,
      deps.browserSessionStartMs,
    );
    const previous = stateByTabSessionHash.get(tabSessionIdHash);
    let previousVisitId = previous?.lastVisitId ?? null;
    const navigationSequence = (previous?.navigationSequence ?? 0) + 1;
    const visitId = buildVisitId(deps.edgeReplicaId, canonicalUrl, commitTimestamp);
    let openerVisitId = await resolveOpenerVisitId(deps.tabOpenerStore.openerFor(details.tabId));
    const pendingClick = consumePendingLinkClick(canonicalUrl, commitTimestamp);
    if (pendingClick !== null) {
      if (previousVisitId === null && pendingClick.sourceTabSessionIdHash === tabSessionIdHash) {
        previousVisitId = pendingClick.sourceVisitId;
      } else if (
        openerVisitId === null &&
        pendingClick.sourceTabSessionIdHash !== tabSessionIdHash
      ) {
        openerVisitId = pendingClick.sourceVisitId;
      }
    }

    const payload: NavigationCommittedPayload = {
      payloadVersion: 1,
      visitId,
      url: details.url,
      canonicalUrl,
      documentId:
        typeof details.documentId === 'string' && details.documentId.length > 0
          ? details.documentId
          : fallbackDocumentId(deps.edgeReplicaId, canonicalUrl, tabSessionIdHash, commitTimestamp),
      parentDocumentId:
        typeof details.parentDocumentId === 'string' && details.parentDocumentId.length > 0
          ? details.parentDocumentId
          : null,
      tabSessionIdHash,
      windowSessionIdHash,
      openerVisitId,
      previousVisitId,
      navigationSequence,
      transitionType: isTransitionType(details.transitionType) ? details.transitionType : 'link',
      transitionQualifiers: (details.transitionQualifiers ?? []).filter(isTransitionQualifier),
      commitTimestamp,
      dimensions: {
        provenance: {
          source: 'chrome.webNavigation.onCommitted',
          rawUrlHash: fnv1a32Hex(details.url),
        },
      },
    };

    await appendNavigationCommitted(payload);
    stateByTabSessionHash.set(tabSessionIdHash, {
      lastVisitId: visitId,
      navigationSequence,
      updatedAtMs: commitTimestamp,
      canonicalUrl,
      url: details.url,
    });
    if (deps.navigationStateStorage !== undefined) {
      await writePersistedNavigationState(deps.navigationStateStorage, stateByTabSessionHash).catch(
        () => undefined,
      );
    }
  };

  return { handleCommitted, recordLinkClick, recordNavigationTargetCreated, hydrate };
};

export const registerWebNavigationListeners = (deps: NavigationListenerDeps): void => {
  const listener = createWebNavigationListener(deps);
  deps.webNavigation.onCommitted.addListener((details) => {
    void listener.handleCommitted(details).catch(() => undefined);
  });
};

const navigationSessionStorage = (): NavigationSessionStorage => {
  const c = chrome as typeof chrome & {
    readonly storage: typeof chrome.storage & { readonly session?: NavigationSessionStorage };
  };
  return c.storage.session ?? chrome.storage.local;
};

export const loadOrCreateBrowserSessionStartMs = async (): Promise<number> => {
  const storage = navigationSessionStorage();
  const got = await storage.get(BROWSER_SESSION_START_KEY);
  const existing = got[BROWSER_SESSION_START_KEY];
  if (typeof existing === 'number' && Number.isFinite(existing) && existing > 0) {
    return existing;
  }
  const fresh = Date.now();
  await storage.set({ [BROWSER_SESSION_START_KEY]: fresh });
  return fresh;
};

export const registerDefaultWebNavigationListeners = (
  tabOpenerStore: TabOpenerStore,
  options: { readonly onNavigationBuffered?: () => void } = {},
): {
  readonly recordLinkClick: (details: NavigationLinkClickDetails) => Promise<void>;
  readonly hydrate: () => Promise<void>;
} => {
  const webNavigation = chrome.webNavigation as WebNavigationApi;
  let listenerPromise: Promise<ReturnType<typeof createWebNavigationListener>> | null = null;
  const listener = async (): Promise<ReturnType<typeof createWebNavigationListener>> => {
    if (listenerPromise !== null) return listenerPromise;
    listenerPromise = (async () => {
      const [replica, browserSessionStartMs] = await Promise.all([
        loadOrCreateEdgeReplica(),
        loadOrCreateBrowserSessionStartMs(),
      ]);
      return createWebNavigationListener({
        webNavigation,
        tabs: chrome.tabs as TabsLookupApi,
        tabOpenerStore,
        eventBuffer: new IndexedDbEventBuffer(),
        navigationStateStorage: navigationSessionStorage(),
        onNavigationBuffered: options.onNavigationBuffered,
        browserSessionStartMs,
        edgeReplicaId: replica.edgeReplicaId,
        allocateSeq: allocateNextSeq,
        now: () => new Date(),
      });
    })();
    return listenerPromise;
  };

  webNavigation.onCommitted.addListener((details) => {
    void listener()
      .then((resolved) => resolved.handleCommitted(details))
      .catch(() => undefined);
  });
  webNavigation.onCreatedNavigationTarget?.addListener((details) => {
    void listener()
      .then((resolved) => resolved.recordNavigationTargetCreated(details))
      .catch(() => undefined);
  });
  return {
    recordLinkClick: async (details) => {
      const resolved = await listener();
      await resolved.recordLinkClick(details);
    },
    hydrate: async () => {
      const resolved = await listener();
      await resolved.hydrate();
    },
  };
};
