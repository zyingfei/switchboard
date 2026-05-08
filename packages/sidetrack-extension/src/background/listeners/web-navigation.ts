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

export interface WebNavigationApi {
  readonly onCommitted: {
    addListener(listener: (details: WebNavigationCommittedDetails) => void): void;
  };
}

export interface TabsLookupApi {
  get(tabId: number): Promise<{ readonly id?: number; readonly windowId?: number }>;
}

export interface NavigationListenerDeps {
  readonly webNavigation: WebNavigationApi;
  readonly tabs: TabsLookupApi;
  readonly tabOpenerStore: TabOpenerStore;
  readonly eventBuffer: EventBuffer;
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

const sessionHash = (
  edgeReplicaId: string,
  kind: 'tab' | 'window',
  id: number,
  browserSessionStartMs: number,
): string =>
  saltedFnv1a32Hex(
    edgeReplicaId,
    `${kind}|${String(id)}|${String(browserSessionStartMs)}`,
  );

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

export const createWebNavigationListener = (deps: NavigationListenerDeps): {
  readonly handleCommitted: (details: WebNavigationCommittedDetails) => Promise<void>;
  readonly hydrate: () => Promise<void>;
} => {
  const stateByTabSessionHash = new Map<string, TabNavigationState>();
  let hydrated = false;
  let hydratePromise: Promise<void> | null = null;

  const hydrate = async (): Promise<void> => {
    if (hydrated) return;
    if (hydratePromise !== null) return hydratePromise;
    hydratePromise = (async () => {
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
    const previousVisitId = previous?.lastVisitId ?? null;
    const navigationSequence = (previous?.navigationSequence ?? 0) + 1;
    const visitId = buildVisitId(deps.edgeReplicaId, canonicalUrl, commitTimestamp);
    const openerVisitId = await resolveOpenerVisitId(
      deps.tabOpenerStore.openerFor(details.tabId),
    );

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
      transitionType: isTransitionType(details.transitionType)
        ? details.transitionType
        : 'link',
      transitionQualifiers: (details.transitionQualifiers ?? []).filter(isTransitionQualifier),
      commitTimestamp,
      dimensions: {
        provenance: {
          source: 'chrome.webNavigation.onCommitted',
          rawUrlHash: fnv1a32Hex(details.url),
        },
      },
    };

    const allocated = await deps.allocateSeq(1);
    const bufferedEvent: BufferedEvent = {
      streamName: NAVIGATION_COMMITTED,
      lamport: allocated.fromSeq,
      replicaId: allocated.edgeReplicaId,
      payload,
      observedAt: deps.now().toISOString(),
    };
    await deps.eventBuffer.appendMany([bufferedEvent]);
    stateByTabSessionHash.set(tabSessionIdHash, { lastVisitId: visitId, navigationSequence });
  };

  return { handleCommitted, hydrate };
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
): void => {
  const webNavigation = chrome.webNavigation as WebNavigationApi;
  let listenerPromise:
    | Promise<ReturnType<typeof createWebNavigationListener>>
    | null = null;
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
        browserSessionStartMs,
        edgeReplicaId: replica.edgeReplicaId,
        allocateSeq: allocateNextSeq,
        now: () => new Date(),
      });
    })();
    return listenerPromise;
  };

  webNavigation.onCommitted.addListener((details) => {
    void listener().then((resolved) => resolved.handleCommitted(details)).catch(() => undefined);
  });
};
