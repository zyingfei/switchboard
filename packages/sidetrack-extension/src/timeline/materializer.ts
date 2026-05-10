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
  type TimelineProvider,
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

const ACTIVE_BUDGET = DEFAULT_PLUGIN_BUDGETS.activeSetCount[SURFACE] ?? 200;

// State tracked in module memory for health reporting. The spool +
// chrome.storage are the durable truth; counters are derived.
let lastReconcileAt: string | null = null;
let lastError: string | null = null;
let companionReachable = false;
let lastObservedAt: string | null = null;
let admitAttempts = 0;
let admittedCount = 0;
let rejectedCount = 0;
type TimelineAdmitRejectReason =
  | 'spool-full-explicit'
  | 'spool-full-passive-policy-drop'
  | 'export-required';
interface TimelineAdmitDiagnostic {
  readonly at: string;
  readonly ok: boolean;
  readonly intent: AdmitIntent;
  readonly tier?: 'active' | 'spool';
  readonly reason?: TimelineAdmitRejectReason;
  readonly activeCount: number;
  readonly spoolCount: number;
  readonly clientEventId: string;
}

interface TimelineDrainDiagnostic {
  readonly at: string;
  readonly drainableCount: number;
  readonly drainHookPresent: boolean;
  readonly uploaded: number;
  readonly remaining: number;
  readonly error?: string;
}
let lastAdmit: TimelineAdmitDiagnostic | null = null;
let lastDrain: TimelineDrainDiagnostic | null = null;

export interface TimelineMaterializerDiagnostics {
  readonly admitAttempts: number;
  readonly admittedCount: number;
  readonly rejectedCount: number;
  readonly lastAdmit: TimelineAdmitDiagnostic | null;
  readonly lastDrain: TimelineDrainDiagnostic | null;
  readonly companionReachable: boolean;
  readonly lastObservedAt: string | null;
  readonly lastError: string | null;
  readonly spool: {
    readonly total: number;
    readonly active: number;
    readonly spooled: number;
    readonly pendingSend: number;
  };
}

export const getTimelineMaterializerDiagnostics =
  async (): Promise<TimelineMaterializerDiagnostics> => {
    const metrics = await spoolMetrics(SURFACE);
    return {
      admitAttempts,
      admittedCount,
      rejectedCount,
      lastAdmit,
      lastDrain,
      companionReachable,
      lastObservedAt,
      lastError,
      spool: {
        total: metrics.total,
        active: metrics.byState.active,
        spooled: metrics.byState.spooled,
        pendingSend: metrics.byState['pending-send'],
      },
    };
  };

export const setCompanionReachableForTimeline = (reachable: boolean): void => {
  companionReachable = reachable;
};

const guard = new PluginBudgetGuard(DEFAULT_PLUGIN_BUDGETS);

interface DrainCompanionDeps {
  readonly companionUrl: string;
  readonly bridgeKey: string;
}

// Hook for the companion-extended fetch path. Production wiring sets
// it via setTimelineFetchHook; tests inject a synthetic. Returns the
// raw companion response body shape so the materializer can map its
// TimelineEntry rows into the plugin's ActiveTimelineObservation
// view (lossy — visitCount + firstSeenAt are dropped because the
// PluginMaterializer<T> generic constrains both admit and fetch to
// the same TItem; revisiting the generic would touch every existing
// materializer, so we live with the synthesis for now).
interface CompanionTimelineEntry {
  readonly id: string;
  readonly date: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly provider?: TimelineProvider;
  readonly tabSessionId?: string;
  readonly openerTabSessionId?: string;
  readonly visitCount: number;
}

let fetchHook:
  | ((query: ExtendedQuery) => Promise<{
      readonly scope: 'companion-extended';
      readonly items: readonly CompanionTimelineEntry[];
    }>)
  | null = null;

export const setTimelineFetchHook = (
  hook:
    | ((query: ExtendedQuery) => Promise<{
        readonly scope: 'companion-extended';
        readonly items: readonly CompanionTimelineEntry[];
      }>)
    | null,
): void => {
  fetchHook = hook;
};

export const createDefaultTimelineFetchHook = (
  deps: DrainCompanionDeps,
): ((query: ExtendedQuery) => Promise<{
  readonly scope: 'companion-extended';
  readonly items: readonly CompanionTimelineEntry[];
}>) => {
  return async (query) => {
    const params = new URLSearchParams();
    if (query.q !== undefined && query.q.length > 0) params.set('q', query.q);
    if (query.limit !== undefined && query.limit > 0) {
      params.set('limit', String(query.limit));
    }
    const search = params.toString();
    const url = `${deps.companionUrl.replace(/\/$/u, '')}/v1/timeline${search.length > 0 ? `?${search}` : ''}`;
    const res = await fetch(url, {
      headers: { 'x-bac-bridge-key': deps.bridgeKey },
    });
    if (!res.ok) throw new Error(`timeline fetch HTTP ${String(res.status)}`);
    const json = (await res.json()) as {
      data?: { scope?: string; items?: readonly CompanionTimelineEntry[] };
    };
    const items = json.data?.items ?? [];
    return { scope: 'companion-extended', items };
  };
};

// Hook for tests + production wiring. The default is a fetch wrapper
// against the companion's /v1/timeline/events endpoint.
let drainHook:
  | ((entries: readonly SpoolEntry<BrowserTimelineObservedPayload>[]) => Promise<{
      uploaded: readonly SpoolEntry['edgeDot'][];
    }>)
  | null = null;

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
    // Reviewer-flagged: a re-drain after a lost POST response (or
    // a re-import via archive) makes the companion return
    // skipped[reason='already-imported']. Those edge dots ARE
    // present on the companion — the spool entry is safe to
    // remove. Treating them as acked is what makes the drain
    // contract honestly idempotent. Anything else in `skipped`
    // (invalid-event-type / invalid-payload / arbitrary error) is
    // NOT safe to remove — the entry stays spooled for either
    // operator inspection or a future schema migration.
    const json = (await res.json()) as {
      data?: {
        imported?: { replicaId: string; seq: number }[];
        skipped?: { replicaId: string; seq: number; reason: string }[];
      };
      // Tolerate the older non-envelope shape some test fixtures use.
      imported?: { replicaId: string; seq: number }[];
      skipped?: { replicaId: string; seq: number; reason: string }[];
    };
    const imported = json.data?.imported ?? json.imported ?? [];
    const skipped = json.data?.skipped ?? json.skipped ?? [];
    const alreadyImported = skipped
      .filter((s) => s.reason === 'already-imported')
      .map((s) => ({ replicaId: s.replicaId, seq: s.seq }));
    return { uploaded: [...imported, ...alreadyImported] };
  };
};

// admitLocal: passive intent. Returns within ms.
const admitLocal = async (
  observation: ActiveTimelineObservation,
  intent: AdmitIntent = 'passive',
): Promise<AdmitResult> => {
  const metrics = await spoolMetrics(SURFACE);
  const activeCount = metrics.byState.active + metrics.byState.spooled;
  const spoolCount = metrics.byState.spooled + metrics.byState['pending-send'];
  admitAttempts += 1;
  const decision = guard.decideAdmit({
    intent,
    activeSetCount: activeCount,
    spoolCount,
    activeSetBudget: ACTIVE_BUDGET,
  });
  if (!decision.ok) {
    // Health-visible. Counters live on the budget guard; reflected in
    // health() below.
    rejectedCount += 1;
    lastAdmit = {
      at: new Date().toISOString(),
      ok: false,
      intent,
      reason: decision.reason,
      activeCount,
      spoolCount,
      clientEventId: observation.payload.eventId,
    };
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
  await spoolAppend(SURFACE, entry);
  lastObservedAt = observation.payload.observedAt;
  admittedCount += 1;
  lastAdmit = {
    at: new Date().toISOString(),
    ok: true,
    intent,
    tier: decision.tier,
    activeCount,
    spoolCount,
    clientEventId: observation.payload.eventId,
  };
  return decision;
};

// mirrorFromCompanion: timeline is NOT SSE-mirrored in this PR.
//
// Reviewer-flagged: the previous implementation pretended to "mirror
// from companion" but actually stored the plugin's own observation
// shape in chrome.storage — false-pretense behavior on the SSE path.
// Honest stance: timeline doesn't have an SSE delivery channel yet.
// Side-panel reads of older history go through fetchExtended →
// GET /v1/timeline (the companion projection is the source of truth).
//
// We satisfy the PluginMaterializer interface with an explicit no-op
// + a single `void item` so future plumbing (a real SSE-driven
// mirror, or a side-panel render layer) has an obvious slot to wire
// into. Calling this method does NOT corrupt any local state — that
// was the bug.
const mirrorFromCompanion = async (item: ActiveTimelineObservation): Promise<void> => {
  void item;
};

// Reviewer-flagged: fetchExtended actually queries the companion's
// GET /v1/timeline endpoint when reachable. The companion returns
// reduced TimelineEntry rows; we synthesize lossy
// ActiveTimelineObservation views (visitCount + firstSeenAt are
// dropped) so the PluginMaterializer<ActiveTimelineObservation>
// generic stays consistent. Side-panel renderers that need
// visitCount can fetch the raw companion JSON via a future
// fetchExtendedRaw or by changing the generic.
const fetchExtended = async (
  query: ExtendedQuery,
): Promise<ExtendedResult<ActiveTimelineObservation>> => {
  if (!companionReachable || fetchHook === null) {
    return buildScopedResult<ActiveTimelineObservation>(
      'plugin-active-only-companion-unreachable',
      [],
    );
  }
  try {
    const result = await fetchHook(query);
    const items: ActiveTimelineObservation[] = result.items.map((entry) => ({
      payload: {
        eventId: entry.id,
        observedAt: entry.lastSeenAt,
        url: entry.url,
        transition: 'updated' as const,
        ...(entry.canonicalUrl === undefined ? {} : { canonicalUrl: entry.canonicalUrl }),
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        ...(entry.tabSessionId === undefined ? {} : { tabSessionId: entry.tabSessionId }),
        ...(entry.openerTabSessionId === undefined
          ? {}
          : { openerTabSessionId: entry.openerTabSessionId }),
      },
    }));
    return buildScopedResult<ActiveTimelineObservation>(result.scope, items);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return buildScopedResult<ActiveTimelineObservation>(
      'plugin-active-only-companion-unreachable',
      [],
    );
  }
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
    lastDrain = {
      at: new Date().toISOString(),
      drainableCount: 0,
      drainHookPresent: drainHook !== null,
      uploaded: 0,
      remaining: remainingSpool,
    };
    return { uploaded: 0, remaining: remainingSpool };
  }
  if (drainHook === null) {
    lastDrain = {
      at: new Date().toISOString(),
      drainableCount: drainable.length,
      drainHookPresent: false,
      uploaded: 0,
      remaining: drainable.length,
    };
    return { uploaded: 0, remaining: drainable.length };
  }
  // Mark each entry as pending-send while we ship it; if drain
  // fails the entries stay pending-send and a retry transitions
  // them again (idempotent on edgeDot at the companion).
  for (const entry of drainable) {
    await spoolTransition(SURFACE, entry.edgeDot, 'pending-send');
  }
  let uploaded = 0;
  // Track which dots came back as acked so the rollback step
  // doesn't re-spool them. Self-review caught: a SUCCESSFUL drain
  // with partial uploads (e.g., companion accepted N of M) was
  // leaving the un-acked entries stuck in 'pending-send' forever
  // because the rollback only ran in the catch path. The
  // success-with-leftovers case is now handled too.
  const ackedKey = (dot: SpoolEntry['edgeDot']): string => `${dot.replicaId}|${String(dot.seq)}`;
  const ackedSet = new Set<string>();
  let drainError: string | undefined;
  try {
    const result = await drainHook(drainable);
    for (const dot of result.uploaded) {
      await spoolTransition(SURFACE, dot, 'evicted-after-ack');
      // For passive surfaces we drop the entry from the spool once
      // the companion has acked it — it lives in the companion event
      // log + projection now.
      await spoolRemove(SURFACE, dot);
      ackedSet.add(ackedKey(dot));
      uploaded += 1;
    }
    lastReconcileAt = new Date().toISOString();
    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    drainError = lastError;
  }
  // Rollback path runs in BOTH success and failure cases — every
  // entry we transitioned to 'pending-send' that did NOT get acked
  // must return to 'spooled' so a later drain retries it.
  for (const entry of drainable) {
    if (ackedSet.has(ackedKey(entry.edgeDot))) continue;
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
  const remaining = (await readSpool(SURFACE)).filter(
    (e) => e.state === 'spooled' || e.state === 'pending-send',
  ).length;
  lastDrain = {
    at: new Date().toISOString(),
    drainableCount: drainable.length,
    drainHookPresent: true,
    uploaded,
    remaining,
    ...(drainError === undefined ? {} : { error: drainError }),
  };
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
    lastObservedAt,
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
    activeSetSize: metrics.byState.active + metrics.byState.spooled,
    spoolSize: metrics.byState.spooled + metrics.byState['pending-send'],
  };
};

// Test seam: clear in-memory state between tests. Production code
// never calls this.
export const resetTimelineMaterializerStateForTests = (): void => {
  lastReconcileAt = null;
  lastError = null;
  companionReachable = false;
  lastObservedAt = null;
  admitAttempts = 0;
  admittedCount = 0;
  rejectedCount = 0;
  lastAdmit = null;
  lastDrain = null;
  // Counters on the guard are intentionally reset by re-instantiating;
  // tests that care should clear chrome.storage spool entries
  // directly.
};

// Convenience used by the observer wiring: convert a payload into
// the shape expected by admitLocal.
export const observationFromPayload = (
  payload: BrowserTimelineObservedPayload,
): ActiveTimelineObservation => ({ payload });
