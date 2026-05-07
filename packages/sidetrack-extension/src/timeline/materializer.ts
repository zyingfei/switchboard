import { allocateNextSeq } from '../sync/edgeReplicaId';
import { DEFAULT_PLUGIN_BUDGETS } from '../sync/budgetConfig';
import {
  PluginBudgetGuard,
  type AdmitIntent,
  type AdmitResult,
  type ExtendedQuery,
  type ExtendedResult,
  type PluginMaterializer,
  type PluginMaterializerHealth,
} from '../sync/pluginMaterializer';
import { buildScopedResult } from '../sync/resultScope';
import {
  readSpool,
  spoolAppend,
  spoolMetrics,
  spoolRemove,
  spoolTransition,
  type SpoolEntry,
} from '../sync/spool';
import {
  BROWSER_TIMELINE_OBSERVED,
  type ActiveTimelineObservation,
  type BrowserTimelineObservedPayload,
} from './events';

// Sync Contract v1 / Class F — timeline plugin materializer.
//
// Wraps `BrowserTimelineObservedPayload` admissions in the standard
// PluginMaterializer interface:
//   - admitLocal: budget-guarded admission to active or spool.
//     Always 'passive' intent for timeline (passive overflow may
//     drop by policy; explicit overflow visibly rejects but
//     timeline never emits explicit observations).
//   - drainSpoolToCompanion: POST every non-imported spool entry
//     to /v1/timeline/events. Idempotent on edge dot.
//   - fetchExtended: HTTP fallback to /v1/timeline?... when the
//     side panel requests entries beyond the active window.
//   - mirrorFromCompanion: applies a TimelineEntry projection from
//     the companion to the plugin's local mirror. Stub for now —
//     timeline isn't SSE-mirrored in the first cut. The interface
//     slot is here so the side panel can iterate uniformly.

const SURFACE = 'timeline';

const ACTIVE_BUDGET =
  DEFAULT_PLUGIN_BUDGETS.activeSetCount[SURFACE] ?? 200;

// Storage key for the timeline projection mirror (companion-driven
// shape; minimal until the side panel renders timeline).
const MIRROR_STORAGE_KEY = 'sidetrack.timeline.projection';

interface ChromeStorageLike {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

const getChromeStorage = (): ChromeStorageLike => {
  const c = (globalThis as unknown as { chrome?: { storage?: { local?: ChromeStorageLike } } }).chrome;
  const local = c?.storage?.local;
  if (local === undefined) throw new Error('chrome.storage.local is unavailable');
  return local;
};

// State tracked in module memory for health reporting. The spool +
// chrome.storage are the durable truth; counters are derived.
let lastReconcileAt: string | null = null;
let lastError: string | null = null;
let companionReachable = false;
let lastObservedAt: string | null = null;

export const setCompanionReachableForTimeline = (reachable: boolean): void => {
  companionReachable = reachable;
};

const guard = new PluginBudgetGuard(DEFAULT_PLUGIN_BUDGETS);

interface DrainCompanionDeps {
  readonly companionUrl: string;
  readonly bridgeKey: string;
}

// Hook for tests + production wiring. The default is a fetch wrapper
// against the companion's /v1/timeline/events endpoint.
let drainHook: ((entries: readonly SpoolEntry<BrowserTimelineObservedPayload>[]) => Promise<{
  uploaded: readonly SpoolEntry['edgeDot'][];
}>) | null = null;

export const setTimelineDrainHook = (
  hook:
    | ((entries: readonly SpoolEntry<BrowserTimelineObservedPayload>[]) => Promise<{
        uploaded: readonly SpoolEntry['edgeDot'][];
      }>)
    | null,
): void => {
  drainHook = hook;
};

// Build the production drain hook against a live companion endpoint.
// Production wiring calls this once at startup and passes the
// returned function to setTimelineDrainHook. Tests typically inject
// a synthetic hook directly.
export const createDefaultTimelineDrainHook = (
  deps: DrainCompanionDeps,
): ((entries: readonly SpoolEntry<BrowserTimelineObservedPayload>[]) => Promise<{
  uploaded: readonly SpoolEntry['edgeDot'][];
}>) => {
  return async (entries) => {
    const body = JSON.stringify({
      events: entries.map((entry) => ({
        clientEventId: entry.clientEventId,
        dot: entry.edgeDot,
        deps: {},
        aggregateId: entry.payload.observedAt.slice(0, 10),
        type: BROWSER_TIMELINE_OBSERVED,
        payload: entry.payload,
        acceptedAtMs: Date.parse(entry.payload.observedAt) || Date.now(),
      })),
    });
    const res = await fetch(`${deps.companionUrl.replace(/\/$/u, '')}/v1/timeline/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': deps.bridgeKey,
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`timeline drain HTTP ${res.status}`);
    }
    const json = (await res.json()) as { imported?: { replicaId: string; seq: number }[] };
    return { uploaded: json.imported ?? [] };
  };
};

// admitLocal: passive intent. Returns within ms.
const admitLocal = async (
  observation: ActiveTimelineObservation,
  intent: AdmitIntent = 'passive',
): Promise<AdmitResult> => {
  const metrics = await spoolMetrics(SURFACE);
  const activeCount = metrics.byState['active'] + metrics.byState['spooled'];
  const decision = guard.decideAdmit({
    intent,
    activeSetCount: activeCount,
    spoolCount:
      metrics.byState['spooled'] + metrics.byState['pending-send'],
    activeSetBudget: ACTIVE_BUDGET,
  });
  if (!decision.ok) {
    // Health-visible. Counters live on the budget guard; reflected in
    // health() below.
    return decision;
  }
  // Allocate an edge dot now so even if the drainer reorders, the
  // companion's importPeerEvent dedupes by dot.
  const allocated = await allocateNextSeq(1);
  const edgeDot = { replicaId: allocated.edgeReplicaId, seq: allocated.fromSeq };
  const entry: SpoolEntry<BrowserTimelineObservedPayload> = {
    edgeDot,
    clientEventId: observation.payload.eventId,
    surface: SURFACE,
    payload: observation.payload,
    state: decision.tier === 'active' ? 'active' : 'spooled',
    createdAt: observation.payload.observedAt,
    lastTransitionAt: new Date().toISOString(),
  };
  await spoolAppend(SURFACE, entry as SpoolEntry);
  lastObservedAt = observation.payload.observedAt;
  return decision;
};

// mirrorFromCompanion: store the projection in chrome.storage so the
// side panel can render it uniformly. The wire shape mirrors
// TimelineDayProjection from the companion.
const mirrorFromCompanion = async (item: ActiveTimelineObservation): Promise<void> => {
  // For the minimal first cut, the side panel doesn't render
  // companion-projected timeline yet; we store the most recent
  // observation as a per-day cache to keep the interface alive.
  const existing = (
    await getChromeStorage().get(MIRROR_STORAGE_KEY)
  )[MIRROR_STORAGE_KEY];
  const list = Array.isArray(existing)
    ? (existing as ActiveTimelineObservation[])
    : [];
  // Dedupe by eventId and cap at active budget.
  const next = [
    item,
    ...list.filter((e) => e.payload.eventId !== item.payload.eventId),
  ].slice(0, ACTIVE_BUDGET);
  await getChromeStorage().set({ [MIRROR_STORAGE_KEY]: next });
};

const fetchExtended = async (
  _query: ExtendedQuery,
): Promise<ExtendedResult<ActiveTimelineObservation>> => {
  // Companion-extended timeline query is wired in B3 (HTTP endpoint
  // + extension HTTP client). Until then, return Mode P scope.
  if (!companionReachable) {
    return buildScopedResult<ActiveTimelineObservation>(
      'plugin-active-only-companion-unreachable',
      [],
    );
  }
  return buildScopedResult<ActiveTimelineObservation>('plugin-active', []);
};

const drainSpoolToCompanion = async (): Promise<{
  uploaded: number;
  remaining: number;
}> => {
  const entries = await readSpool(SURFACE);
  const drainable = entries.filter(
    (e) => e.state === 'active' || e.state === 'spooled',
  ) as SpoolEntry<BrowserTimelineObservedPayload>[];
  if (drainable.length === 0) {
    const remainingSpool = entries.filter((e) => e.state === 'pending-send').length;
    return { uploaded: 0, remaining: remainingSpool };
  }
  if (drainHook === null) {
    return { uploaded: 0, remaining: drainable.length };
  }
  // Mark each entry as pending-send while we ship it; if drain
  // fails the entries stay pending-send and a retry transitions
  // them again (idempotent on edgeDot at the companion).
  for (const entry of drainable) {
    await spoolTransition(SURFACE, entry.edgeDot, 'pending-send');
  }
  let uploaded = 0;
  try {
    const result = await drainHook(drainable);
    for (const dot of result.uploaded) {
      await spoolTransition(SURFACE, dot, 'evicted-after-ack');
      // For passive surfaces we drop the entry from the spool once
      // the companion has acked it — it lives in the companion event
      // log + projection now.
      await spoolRemove(SURFACE, dot);
      uploaded += 1;
    }
    lastReconcileAt = new Date().toISOString();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    // Roll the unsent entries back to 'spooled' so a later drain
    // retries them. The acked ones stay evicted-after-ack.
    for (const entry of drainable) {
      const fresh = await readSpool(SURFACE);
      const stillPending = fresh.find(
        (e) =>
          e.edgeDot.replicaId === entry.edgeDot.replicaId &&
          e.edgeDot.seq === entry.edgeDot.seq &&
          e.state === 'pending-send',
      );
      if (stillPending !== undefined) {
        await spoolTransition(SURFACE, entry.edgeDot, 'spooled');
      }
    }
  }
  const remaining = (await readSpool(SURFACE)).filter(
    (e) => e.state === 'spooled' || e.state === 'pending-send',
  ).length;
  return { uploaded, remaining };
};

const exportSpoolToArchive = async (): Promise<{
  exported: number;
  archivePath: string;
}> => {
  // chrome.downloads file-export is out of scope for this PR (per
  // docs/timeline.md). Returns a no-op shape so the interface stays
  // honest.
  return { exported: 0, archivePath: '' };
};

const health = (): PluginMaterializerHealth => {
  const metrics = guard.metrics();
  return {
    status: lastError !== null ? 'failed' : 'healthy',
    activeSetSize: 0, // refined by snapshot below
    activeSetBudget: ACTIVE_BUDGET,
    spoolSize: 0,
    spoolBudget: DEFAULT_PLUGIN_BUDGETS.spoolBytes,
    companionReachable,
    lastReconcileAt,
    lastError,
    failedExplicitCount: metrics.failedExplicit,
    droppedPassiveCount: metrics.droppedPassive,
  };
};

export const timelinePluginMaterializer: PluginMaterializer<ActiveTimelineObservation> = {
  name: SURFACE,
  admitLocal,
  mirrorFromCompanion,
  fetchExtended,
  drainSpoolToCompanion,
  exportSpoolToArchive,
  health,
};

// Async health snapshot — reads the spool storage to populate the
// active/spool sizes. The base materializer.health() returns a
// synchronous shape so it doesn't block; the snapshot is what the
// side panel + /v1/system/health surfaces use.
export const timelineHealthSnapshot = async (): Promise<PluginMaterializerHealth> => {
  const metrics = await spoolMetrics(SURFACE);
  const base = health();
  return {
    ...base,
    activeSetSize: metrics.byState['active'] + metrics.byState['spooled'],
    spoolSize:
      metrics.byState['spooled'] + metrics.byState['pending-send'],
  };
};

// Test seam: clear in-memory state between tests. Production code
// never calls this.
export const resetTimelineMaterializerStateForTests = (): void => {
  lastReconcileAt = null;
  lastError = null;
  companionReachable = false;
  lastObservedAt = null;
  // Counters on the guard are intentionally reset by re-instantiating;
  // tests that care should clear chrome.storage spool entries
  // directly.
};

// Convenience used by the observer wiring: convert a payload into
// the shape expected by admitLocal.
export const observationFromPayload = (
  payload: BrowserTimelineObservedPayload,
): ActiveTimelineObservation => ({ payload });

export const __TIMELINE_LAST_OBSERVED_AT_FOR_TESTS = (): string | null => lastObservedAt;
