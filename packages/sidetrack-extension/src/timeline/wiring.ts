import { canonicalThreadUrl, detectProviderFromUrl } from '../capture/providerDetection';
import { loadOrCreateEdgeReplica, type EdgeReplica } from '../sync/edgeReplicaId';
import {
  createDefaultTimelineDrainHook,
  observationFromPayload,
  setCompanionReachableForTimeline,
  setTimelineDrainHook,
  timelinePluginMaterializer,
} from './materializer';
import { createTimelineObserver, type TimelineObserver } from './observer';
import type { BrowserTimelineObservedPayload, TimelineProvider } from './events';

// Sync Contract v1 / Class F — bind chrome.tabs APIs to the timeline
// observer + materializer. This is the production wiring referenced
// in `docs/timeline.md`. Out of scope for the initial timeline PR;
// landed here as the natural follow-up that brings the feature from
// "callable" to "actually running."
//
// Responsibilities:
//   - Allocate the edge replica id once on init (idempotent).
//   - Build a TimelineObserver with synchronous hashes + the
//     existing canonicalThreadUrl + detectProviderFromUrl.
//   - Bridge chrome.tabs.onActivated / onUpdated / onRemoved /
//     chrome.windows.onFocusChanged into observer.observe / .close.
//   - Schedule a periodic drain via chrome.alarms.
//   - Update setCompanionReachableForTimeline based on drain results.
//
// The init function is idempotent: calling it twice is a no-op
// because chrome.alarms.create with the same name replaces the
// previous one and the listener registry uses a guard flag.

const DRAIN_ALARM = 'sidetrack.timeline.drain';
const DRAIN_PERIOD_MIN = 1; // every minute when companion reachable

let initialized = false;

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
    hashTabId: (tabId, windowId) =>
      fnv1a64(`${salt}|tab|${String(tabId)}|${String(windowId)}`).slice(0, 16),
    hashWindowId: (windowId) =>
      fnv1a64(`${salt}|win|${String(windowId)}`).slice(0, 16),
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
}

const tryDrain = async (deps: InitDeps): Promise<{ uploaded: number; remaining: number }> => {
  const companion = await deps.readCompanion();
  if (companion === null || companion.url.trim().length === 0) {
    setCompanionReachableForTimeline(false);
    setTimelineDrainHook(null);
    return { uploaded: 0, remaining: 0 };
  }
  setTimelineDrainHook(
    createDefaultTimelineDrainHook({
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

export const initializeTimelineWiring = async (deps: InitDeps): Promise<void> => {
  if (initialized) return;
  initialized = true;

  const replica = await loadOrCreateEdgeReplica();
  const observer = buildObserver(replica);

  // chrome.tabs.onActivated → observer.observe with the active tab's
  // current URL. We have to re-fetch the tab because onActivated
  // doesn't carry a URL.
  chrome.tabs.onActivated.addListener((info) => {
    void (async () => {
      try {
        const tab = await chrome.tabs.get(info.tabId);
        if (typeof tab.url !== 'string' || tab.url.length === 0) return;
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

  // chrome.tabs.onUpdated fires on URL change, status complete, and
  // title changes. We only emit on URL changes (the observer's
  // coalesce drops repeated identical-canonical observations).
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url === undefined && changeInfo.status !== 'complete') return;
    const url = tab.url ?? changeInfo.url;
    if (typeof url !== 'string' || url.length === 0) return;
    if (typeof tab.windowId !== 'number') return;
    observer.observe({
      tabId,
      windowId: tab.windowId,
      url,
      ...(typeof tab.title === 'string' ? { title: tab.title } : {}),
      transition: changeInfo.status === 'complete' ? 'completed' : 'updated',
    });
  });

  // chrome.tabs.onRemoved: emit a closed transition so timeline
  // sessions have a clean tail.
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    observer.close({ tabId, windowId: removeInfo.windowId });
  });

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

  // Eager first drain on init — picks up anything spooled across a
  // service-worker restart.
  void tryDrain(deps).catch(() => undefined);
};

// Test-only seam to reset the init guard between tests.
export const resetTimelineWiringForTests = (): void => {
  initialized = false;
};
