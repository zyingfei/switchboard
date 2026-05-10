import { canonicalThreadUrl, detectProviderFromUrl } from '../capture/providerDetection';
import { loadOrCreateEdgeReplica, type EdgeReplica } from '../sync/edgeReplicaId';
import {
  createDefaultTimelineDrainHook,
  createDefaultTimelineFetchHook,
  observationFromPayload,
  setCompanionReachableForTimeline,
  setTimelineDrainHook,
  setTimelineFetchHook,
  timelinePluginMaterializer,
  getTimelineMaterializerDiagnostics,
} from './materializer';
import {
  createTimelineObserver,
  getTimelineObserverDiagnostics,
  type TimelineObserver,
} from './observer';
import type { BrowserTimelineObservedPayload } from './events';

// Sync Contract v1 / Class F — bind chrome.tabs APIs to the timeline
// observer + materializer. Production wiring referenced in
// `docs/timeline.md`.
//
// Responsibilities:
//   - Check the timeline-enabled gate (default OFF; reviewer-flagged
//     privacy posture). When the gate is off, NO listeners are
//     registered, NO alarm is scheduled, NO observations land in the
//     spool.
//   - Allocate the edge replica id once on init (idempotent).
//   - Build a TimelineObserver with synchronous hashes + the
//     existing canonicalThreadUrl + detectProviderFromUrl.
//   - Bridge chrome.tabs.onActivated / onUpdated / onRemoved into
//     observer.observe / .close.
//   - Schedule a periodic drain via chrome.alarms.
//   - Update setCompanionReachableForTimeline based on drain results.
//
// The init function is idempotent on the gate value: calling it
// twice while disabled is a no-op; calling it twice while enabled
// is a no-op because chrome.alarms.create with the same name
// replaces the previous one and the listener registry uses a guard.

const DRAIN_ALARM = 'sidetrack.timeline.drain';
const DRAIN_PERIOD_MIN = 1; // every minute when companion reachable

// Legacy settings key for the timeline enable gate. Stage 1 migrates
// this into the Class A privacy event stream, but the key stays for
// bootstrapping existing installs and tests that simulate the legacy
// flag.
export const TIMELINE_ENABLED_KEY = 'sidetrack.timeline.enabled';
export const TIMELINE_PRIVACY_GATE = 'timeline';
export const TIMELINE_REPLAY_DEBUG_KEY = 'sidetrack.timeline.replayDebug';

// Settings key for the user's currently-focused workstream. When
// set, the timeline observer stamps it onto every browser.timeline.
// observed event so the connections graph can attribute ambient
// browsing to the right flow without requiring a paste / annotation.
// Phase 4 — Active-workstream attribution.
export const ACTIVE_WORKSTREAM_KEY = 'sidetrack.activeWorkstreamId';

interface TimelineEnabledStorage {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

const getStorage = (): TimelineEnabledStorage => {
  const c = (globalThis as unknown as { chrome?: { storage?: { local?: TimelineEnabledStorage } } })
    .chrome;
  const local = c?.storage?.local;
  if (local === undefined) throw new Error('chrome.storage.local is unavailable');
  return local;
};

// Read the gate. Defaults to false on missing / non-boolean values.
export const isTimelineEnabled = async (): Promise<boolean> => {
  try {
    const got = await getStorage().get(TIMELINE_ENABLED_KEY);
    return got[TIMELINE_ENABLED_KEY] === true;
  } catch {
    return false;
  }
};

// Set the gate. Returns the new value. Used by the side panel /
// future settings UI to toggle the feature on or off. When toggled
// off after a session has been running, the in-memory observer is
// not torn down — but chrome.alarms.clear cancels the scheduled
// drain and no new observations are observed because the listener
// closure consults the gate before each emit. Callers should
// reload the SW to fully reset state.
export const setTimelineEnabled = async (enabled: boolean): Promise<boolean> => {
  await getStorage().set({ [TIMELINE_ENABLED_KEY]: enabled });
  return enabled;
};

let initialized = false;
let initializeCalls = 0;
let successfulInitializeCalls = 0;
let activeWorkstreamCacheRefreshes = 0;
let storageChangeListenerAttached = false;
let onActivatedListenerCount = 0;
let onUpdatedListenerCount = 0;
let onRemovedListenerCount = 0;
let alarmListenerCount = 0;
let onActivatedCalls = 0;
let onUpdatedCalls = 0;
let onRemovedCalls = 0;
let onUpdatedSequence = 0;
let observerObserveCalls = 0;
let observerCloseCalls = 0;
let triggerDrainCalls = 0;
type TimelineGateBoundary = 'init' | 'onActivated' | 'onUpdated' | 'onRemoved';
interface TimelineGateReadDiagnostic {
  readonly at: string;
  readonly boundary: TimelineGateBoundary;
  readonly open: boolean;
}

interface TimelineOnUpdatedDiagnostic {
  readonly sequence: number;
  readonly at: string;
  readonly tabId: number;
  readonly status?: string;
  readonly hasChangeUrl: boolean;
  readonly tabUrl?: string;
  readonly urlUsed?: string;
  readonly gateOpen?: boolean;
  readonly skippedReason?: string;
}

interface TimelineObserveRequestDiagnostic {
  readonly at: string;
  readonly source: 'onActivated' | 'onUpdated' | 'onRemoved';
  readonly transition?: BrowserTimelineObservedPayload['transition'];
  readonly url?: string;
  readonly activeWorkstreamId?: string;
}

interface TimelineDrainTriggerDiagnostic {
  readonly at: string;
  readonly capturedInitDepsPresent: boolean;
  readonly uploaded: number;
  readonly remaining: number;
}
let lastGateRead: TimelineGateReadDiagnostic | null = null;
let lastOnUpdated: TimelineOnUpdatedDiagnostic | null = null;
let lastObserveRequest: TimelineObserveRequestDiagnostic | null = null;
let lastDrainTrigger: TimelineDrainTriggerDiagnostic | null = null;

export interface TimelineWiringDiagnostics {
  readonly initialized: boolean;
  readonly capturedInitDepsPresent: boolean;
  readonly initializeCalls: number;
  readonly successfulInitializeCalls: number;
  readonly listeners: {
    readonly storageChangeAttached: boolean;
    readonly onActivated: number;
    readonly onUpdated: number;
    readonly onRemoved: number;
    readonly alarm: number;
  };
  readonly listenerCalls: {
    readonly onActivated: number;
    readonly onUpdated: number;
    readonly onRemoved: number;
  };
  readonly observerBridgeCalls: {
    readonly observe: number;
    readonly close: number;
  };
  readonly activeWorkstreamCache: {
    readonly refreshes: number;
    readonly value: string | null;
  };
  readonly triggerDrainCalls: number;
  readonly lastGateRead: TimelineGateReadDiagnostic | null;
  readonly lastOnUpdated: TimelineOnUpdatedDiagnostic | null;
  readonly lastObserveRequest: TimelineObserveRequestDiagnostic | null;
  readonly lastDrainTrigger: TimelineDrainTriggerDiagnostic | null;
}

export interface TimelineReplayDiagnostics {
  readonly wiring: TimelineWiringDiagnostics;
  readonly observer: ReturnType<typeof getTimelineObserverDiagnostics>;
  readonly materializer: Awaited<ReturnType<typeof getTimelineMaterializerDiagnostics>>;
}

const recordGateRead = (boundary: TimelineGateBoundary, open: boolean): void => {
  lastGateRead = { at: new Date().toISOString(), boundary, open };
};

const updateLastOnUpdated = (
  sequence: number,
  patch: Partial<Omit<TimelineOnUpdatedDiagnostic, 'sequence'>>,
): void => {
  if (lastOnUpdated === null || lastOnUpdated.sequence !== sequence) return;
  lastOnUpdated = { ...lastOnUpdated, ...patch };
};

// Deterministic synchronous hash (FNV-1a 64-bit) used to scope
// (tabId, windowId) into a stable opaque identity. Salted with the
// edgeReplicaId so the companion can't reverse to the raw chrome
// tab id without knowing the edge identity. Not a cryptographic
// hash — pseudonymity, not secrecy.
const fnv1a64 = (input: string): string => {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
};

// Cached active workstream id read from chrome.storage. The
// observer's emit hot path needs a synchronous resolver; we read
// once at boot, then refresh on chrome.storage.onChanged. Set to
// undefined when no workstream is focused.
let cachedActiveWorkstreamId: string | undefined;

const refreshActiveWorkstreamCache = async (): Promise<void> => {
  activeWorkstreamCacheRefreshes += 1;
  try {
    const got = await getStorage().get(ACTIVE_WORKSTREAM_KEY);
    const v = got[ACTIVE_WORKSTREAM_KEY];
    cachedActiveWorkstreamId = typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    cachedActiveWorkstreamId = undefined;
  }
};

// Exposed so the replay-from-pack driver (and any other test that
// programmatically writes ACTIVE_WORKSTREAM_KEY in rapid succession)
// can force a cache refresh synchronously rather than waiting for
// the chrome.storage.onChanged listener — which fires async after
// `set()` resolves and may lose to the next page.goto if the replay
// loop drives navigations on the heels of a workstreamSwitch event.
// Returns a string when a workstream is focused, undefined otherwise.
export const refreshActiveWorkstreamFromStorage = async (): Promise<string | undefined> => {
  await refreshActiveWorkstreamCache();
  return cachedActiveWorkstreamId;
};

const startActiveWorkstreamCache = async (): Promise<void> => {
  await refreshActiveWorkstreamCache();
  const c = (
    globalThis as unknown as {
      chrome?: {
        storage?: {
          onChanged?: {
            addListener: (
              listener: (changes: Record<string, { newValue?: unknown }>) => void,
            ) => void;
          };
        };
      };
    }
  ).chrome;
  c?.storage?.onChanged?.addListener((changes) => {
    if (Object.prototype.hasOwnProperty.call(changes, ACTIVE_WORKSTREAM_KEY)) {
      const v = changes[ACTIVE_WORKSTREAM_KEY]?.newValue;
      cachedActiveWorkstreamId = typeof v === 'string' && v.length > 0 ? v : undefined;
    }
  });
  storageChangeListenerAttached = true;
};

const buildObserver = (replica: EdgeReplica): TimelineObserver => {
  const salt = replica.edgeReplicaId;
  return createTimelineObserver({
    clock: () => new Date(),
    emit: (payload) => {
      // Fire-and-forget admit. PluginBudgetGuard is the gate; we
      // drop on failure (passive intent, health-visible counter).
      void timelinePluginMaterializer
        .admitLocal(observationFromPayload(payload), 'passive')
        .catch(() => undefined);
    },
    getActiveWorkstreamId: () => cachedActiveWorkstreamId,
    hashTabId: (tabId, windowId) =>
      fnv1a64(`${salt}|tab|${String(tabId)}|${String(windowId)}`).slice(0, 16),
    hashWindowId: (windowId) => fnv1a64(`${salt}|win|${String(windowId)}`).slice(0, 16),
    canonicalize: (url) => {
      try {
        return canonicalThreadUrl(url);
      } catch {
        return undefined;
      }
    },
    providerOf: (url) => {
      const provider = detectProviderFromUrl(url);
      // Map detector's ProviderId → timeline's narrower union.
      if (provider === 'chatgpt' || provider === 'claude' || provider === 'gemini') {
        return provider;
      }
      // 'codex' and 'unknown' fall through to 'generic' (or undefined
      // for non-providers); we elide non-provider URLs to keep the
      // projection focused.
      if (provider === 'codex' || provider === 'unknown') {
        return undefined;
      }
      return undefined;
    },
    coalesceWindowMs: 30_000,
  });
};

interface InitDeps {
  // Lookup the current companion config for the drainer. Returning
  // null disables drain (and flags companion unreachable).
  readonly readCompanion: () => Promise<{ url: string; bridgeKey: string } | null>;
  // Production reads the Class A privacy projection. Tests may omit it
  // and fall back to the legacy storage gate helper above.
  readonly readTimelineGateState?: () => Promise<boolean>;
}

// Captured at init() so external triggerTimelineDrain() can run the
// same drain path (used by tests + a side-panel "drain now" path).
let capturedInitDeps: InitDeps | null = null;

const tryDrain = async (deps: InitDeps): Promise<{ uploaded: number; remaining: number }> => {
  const companion = await deps.readCompanion();
  if (companion === null || companion.url.trim().length === 0) {
    setCompanionReachableForTimeline(false);
    setTimelineDrainHook(null);
    setTimelineFetchHook(null);
    return { uploaded: 0, remaining: 0 };
  }
  // Wire BOTH hooks once we have companion config — drain (POST)
  // and fetch (GET). The drainer uses POST /v1/timeline/events;
  // the fetcher uses GET /v1/timeline. Both honor the bridge key.
  setTimelineDrainHook(
    createDefaultTimelineDrainHook({
      companionUrl: companion.url,
      bridgeKey: companion.bridgeKey,
    }),
  );
  setTimelineFetchHook(
    createDefaultTimelineFetchHook({
      companionUrl: companion.url,
      bridgeKey: companion.bridgeKey,
    }),
  );
  try {
    const result = await timelinePluginMaterializer.drainSpoolToCompanion();
    setCompanionReachableForTimeline(true);
    return result;
  } catch {
    setCompanionReachableForTimeline(false);
    return { uploaded: 0, remaining: 0 };
  }
};

// External trigger — runs the same try-drain path that the periodic
// alarm runs. Returns { uploaded, remaining } when wiring has been
// initialized; resolves to a zero-effect result otherwise (init
// hasn't run because the timeline gate is off, or the SW just
// booted and hasn't initialized yet).
export const triggerTimelineDrain = async (): Promise<{
  uploaded: number;
  remaining: number;
}> => {
  triggerDrainCalls += 1;
  if (capturedInitDeps === null) {
    lastDrainTrigger = {
      at: new Date().toISOString(),
      capturedInitDepsPresent: false,
      uploaded: 0,
      remaining: 0,
    };
    return { uploaded: 0, remaining: 0 };
  }
  const result = await tryDrain(capturedInitDeps);
  lastDrainTrigger = {
    at: new Date().toISOString(),
    capturedInitDepsPresent: true,
    uploaded: result.uploaded,
    remaining: result.remaining,
  };
  return result;
};

export const initializeTimelineWiring = async (deps: InitDeps): Promise<void> => {
  initializeCalls += 1;
  if (initialized) return;
  const readTimelineGateState = deps.readTimelineGateState ?? isTimelineEnabled;
  // Gate first — if the user hasn't opted in via the privacy
  // projection, register nothing.
  const initGateOpen = await readTimelineGateState();
  recordGateRead('init', initGateOpen);
  if (!initGateOpen) return;
  initialized = true;
  successfulInitializeCalls += 1;
  capturedInitDeps = deps;

  // Phase 4: keep the active-workstream-id cache hot before the
  // observer starts emitting. Reads chrome.storage once, then
  // listens for chrome.storage.onChanged so subsequent panel
  // updates take effect on the next emit.
  await startActiveWorkstreamCache();

  const replica = await loadOrCreateEdgeReplica();
  const observer = buildObserver(replica);

  // chrome.tabs.onActivated → observer.observe with the active tab's
  // current URL. We have to re-fetch the tab because onActivated
  // doesn't carry a URL.
  chrome.tabs.onActivated.addListener((info) => {
    onActivatedCalls += 1;
    void (async () => {
      try {
        const gateOpen = await readTimelineGateState();
        recordGateRead('onActivated', gateOpen);
        if (!gateOpen) return;
        const tab = await chrome.tabs.get(info.tabId);
        if (typeof tab.url !== 'string' || tab.url.length === 0) return;
        observerObserveCalls += 1;
        lastObserveRequest = {
          at: new Date().toISOString(),
          source: 'onActivated',
          transition: 'activated',
          url: tab.url,
          ...(cachedActiveWorkstreamId === undefined
            ? {}
            : { activeWorkstreamId: cachedActiveWorkstreamId }),
        };
        observer.observe({
          tabId: info.tabId,
          windowId: info.windowId,
          url: tab.url,
          ...(typeof tab.title === 'string' ? { title: tab.title } : {}),
          transition: 'activated',
        });
      } catch {
        // Tab might be gone by the time we look up — silent.
      }
    })();
  });
  onActivatedListenerCount += 1;

  // chrome.tabs.onUpdated fires on URL change, status complete, and
  // title changes. We only emit on URL changes (the observer's
  // coalesce drops repeated identical-canonical observations).
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    onUpdatedCalls += 1;
    const sequence = (onUpdatedSequence += 1);
    lastOnUpdated = {
      sequence,
      at: new Date().toISOString(),
      tabId,
      ...(typeof changeInfo.status === 'string' ? { status: changeInfo.status } : {}),
      hasChangeUrl: changeInfo.url !== undefined,
      ...(typeof tab.url === 'string' ? { tabUrl: tab.url } : {}),
    };
    void (async () => {
      const gateOpen = await readTimelineGateState();
      recordGateRead('onUpdated', gateOpen);
      updateLastOnUpdated(sequence, { gateOpen });
      if (!gateOpen) {
        updateLastOnUpdated(sequence, { skippedReason: 'gate-closed' });
        return;
      }
      if (changeInfo.url === undefined && changeInfo.status !== 'complete') {
        updateLastOnUpdated(sequence, { skippedReason: 'no-url-and-not-complete' });
        return;
      }
      const url = tab.url ?? changeInfo.url;
      if (typeof url !== 'string' || url.length === 0) {
        updateLastOnUpdated(sequence, { skippedReason: 'missing-url' });
        return;
      }
      updateLastOnUpdated(sequence, { urlUsed: url });
      if (typeof tab.windowId !== 'number') {
        updateLastOnUpdated(sequence, { skippedReason: 'missing-window-id' });
        return;
      }
      observerObserveCalls += 1;
      lastObserveRequest = {
        at: new Date().toISOString(),
        source: 'onUpdated',
        transition: changeInfo.status === 'complete' ? 'completed' : 'updated',
        url,
        ...(cachedActiveWorkstreamId === undefined
          ? {}
          : { activeWorkstreamId: cachedActiveWorkstreamId }),
      };
      observer.observe({
        tabId,
        windowId: tab.windowId,
        url,
        ...(typeof tab.title === 'string' ? { title: tab.title } : {}),
        transition: changeInfo.status === 'complete' ? 'completed' : 'updated',
      });
    })();
  });
  onUpdatedListenerCount += 1;

  // chrome.tabs.onRemoved: emit a closed transition so timeline
  // sessions have a clean tail.
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    onRemovedCalls += 1;
    void (async () => {
      const gateOpen = await readTimelineGateState();
      recordGateRead('onRemoved', gateOpen);
      if (!gateOpen) return;
      observerCloseCalls += 1;
      lastObserveRequest = {
        at: new Date().toISOString(),
        source: 'onRemoved',
        ...(cachedActiveWorkstreamId === undefined
          ? {}
          : { activeWorkstreamId: cachedActiveWorkstreamId }),
      };
      observer.close({ tabId, windowId: removeInfo.windowId });
    })();
  });
  onRemovedListenerCount += 1;

  // Periodic drain via chrome.alarms (1-minute cadence; same minimum
  // MV3 floor as the dispatch poll alarm).
  try {
    await chrome.alarms.create(DRAIN_ALARM, { periodInMinutes: DRAIN_PERIOD_MIN });
  } catch {
    // Alarm registration is best-effort; on failure we still drain
    // opportunistically when the side panel triggers an explicit
    // drain via message handlers.
  }
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== DRAIN_ALARM) return;
    void tryDrain(deps).catch(() => undefined);
  });
  alarmListenerCount += 1;

  // Eager first drain on init — picks up anything spooled across a
  // service-worker restart.
  void tryDrain(deps).catch(() => undefined);
};

export const readTimelineReplayDiagnostics = async (): Promise<TimelineReplayDiagnostics> => ({
  wiring: {
    initialized,
    capturedInitDepsPresent: capturedInitDeps !== null,
    initializeCalls,
    successfulInitializeCalls,
    listeners: {
      storageChangeAttached: storageChangeListenerAttached,
      onActivated: onActivatedListenerCount,
      onUpdated: onUpdatedListenerCount,
      onRemoved: onRemovedListenerCount,
      alarm: alarmListenerCount,
    },
    listenerCalls: {
      onActivated: onActivatedCalls,
      onUpdated: onUpdatedCalls,
      onRemoved: onRemovedCalls,
    },
    observerBridgeCalls: {
      observe: observerObserveCalls,
      close: observerCloseCalls,
    },
    activeWorkstreamCache: {
      refreshes: activeWorkstreamCacheRefreshes,
      value: cachedActiveWorkstreamId ?? null,
    },
    triggerDrainCalls,
    lastGateRead,
    lastOnUpdated,
    lastObserveRequest,
    lastDrainTrigger,
  },
  observer: getTimelineObserverDiagnostics(),
  materializer: await getTimelineMaterializerDiagnostics(),
});

// Test-only seam to reset the init guard between tests.
export const resetTimelineWiringForTests = (): void => {
  initialized = false;
};
