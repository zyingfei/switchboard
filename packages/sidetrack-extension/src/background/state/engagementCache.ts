import {
  emptyEngagementTotals,
  mergeEngagementTotals,
  type EngagementIntervalMessage,
  type EngagementTotals,
} from '../../content/engagement/aggregator';
import {
  createChromeEngagementSessionStore,
  foldIntervalIntoSession,
  type EngagementSessionStore,
  type StoredEngagementSession,
} from './engagementSessionStore';

export interface EngagementIntervalObservedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly dimensions: {
    readonly engagement: EngagementTotals;
  };
}

export interface EngagementSessionAggregatedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly sessionId: string;
  readonly dimensions: {
    readonly engagement: EngagementTotals;
  };
}

interface CachedEngagementSession {
  readonly visitId: string;
  readonly sessionId: string;
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly totals: EngagementTotals;
}

export interface FinalizedEngagement {
  readonly interval: EngagementIntervalObservedPayload;
  readonly aggregate: EngagementSessionAggregatedPayload;
}

export interface EngagementCache {
  /**
   * Fold an interval into the per-tab session. Always returns the
   * interval payload and the (running) aggregate; the caller emits the
   * aggregate only when `message.final`. Synchronous so the hot path
   * stays cheap; the durable mirror is written best-effort in the
   * background via `persist`.
   */
  readonly mergeInterval: (
    tabId: number,
    message: EngagementIntervalMessage,
  ) => FinalizedEngagement;
  /**
   * Finalize the in-memory session for a tab (tab close / nav-away),
   * returning the interval + aggregate to emit, or null if nothing was
   * cached. Also clears the durable mirror for that tab.
   */
  readonly finalizeTab: (tabId: number, endedAt: number) => FinalizedEngagement | null;
  /**
   * The visitId of the in-memory session currently cached for a tab, or
   * undefined if none. Used by the SW nav-away hook to detect a same-tab
   * URL change (new visit) and finalize the prior session before its
   * intervals bleed into the next one.
   */
  readonly currentVisitId: (tabId: number) => string | undefined;
  /**
   * Mirror the current in-memory sessions to durable storage so an
   * evicted service worker can still finalize them. Best-effort; safe to
   * call fire-and-forget after `mergeInterval`.
   */
  readonly persist: (tabId: number) => Promise<void>;
  /**
   * Clear the durable mirror for a tab (after its aggregate has been
   * emitted). Best-effort.
   */
  readonly clearDurable: (tabId: number) => Promise<void>;
  /**
   * Sweep durable sessions idle since before `olderThanMs`, emitting an
   * aggregate for each and removing it. Used by the periodic idle-sweep
   * alarm and the SW-wake seal so orphaned sessions (lost when the SW was
   * evicted before a final beacon landed) are never silently dropped.
   * Skips (leaves in place) any tab still live in the in-memory cache so
   * an active session is not double-emitted.
   */
  readonly sweepDurable: (olderThanMs: number, now: number) => Promise<readonly FinalizedEngagement[]>;
}

const toIntervalPayload = (
  message: EngagementIntervalMessage,
): EngagementIntervalObservedPayload => ({
  payloadVersion: 1,
  visitId: message.visitId,
  intervalStart: message.intervalStart,
  intervalEnd: message.intervalEnd,
  dimensions: message.dimensions,
});

const toAggregatePayload = (
  cached: CachedEngagementSession,
): EngagementSessionAggregatedPayload => ({
  payloadVersion: 1,
  visitId: cached.visitId,
  sessionId: cached.sessionId,
  dimensions: {
    engagement: cached.totals,
  },
});

const storedToAggregate = (
  stored: StoredEngagementSession,
): EngagementSessionAggregatedPayload => ({
  payloadVersion: 1,
  visitId: stored.visitId,
  sessionId: stored.sessionId,
  dimensions: { engagement: stored.totals },
});

const storedToInterval = (
  stored: StoredEngagementSession,
  endedAt: number,
): EngagementIntervalObservedPayload => ({
  payloadVersion: 1,
  visitId: stored.visitId,
  intervalStart: stored.intervalStart,
  intervalEnd: endedAt,
  dimensions: { engagement: stored.totals },
});

export const createEngagementCache = (input: {
  readonly sessionId: string;
  readonly now?: () => number;
  readonly store?: EngagementSessionStore;
}): EngagementCache => {
  const byTab = new Map<number, CachedEngagementSession>();
  const now = input.now ?? (() => Date.now());
  // Lazily resolve the durable store so unit tests that only exercise the
  // in-memory contract don't require a chrome.storage stub. When absent,
  // the durable mirror/sweep degrade to no-ops (the in-memory path and
  // best-effort teardown beacons still work exactly as before).
  let storeResolved: EngagementSessionStore | undefined | null =
    input.store !== undefined ? input.store : undefined;
  const durable = (): EngagementSessionStore | null => {
    if (storeResolved === null) return null;
    if (storeResolved !== undefined) return storeResolved;
    try {
      storeResolved = createChromeEngagementSessionStore();
    } catch {
      storeResolved = null;
    }
    return storeResolved;
  };

  return {
    mergeInterval(tabId, message) {
      const existing = byTab.get(tabId);
      const totals =
        existing === undefined
          ? mergeEngagementTotals(emptyEngagementTotals(), message.dimensions.engagement)
          : mergeEngagementTotals(existing.totals, message.dimensions.engagement);
      const cached: CachedEngagementSession = {
        visitId: message.visitId,
        sessionId:
          existing?.sessionId ??
          `${input.sessionId}:tab:${String(tabId)}:start:${String(message.intervalStart)}`,
        intervalStart: Math.min(
          existing?.intervalStart ?? message.intervalStart,
          message.intervalStart,
        ),
        intervalEnd: Math.max(existing?.intervalEnd ?? message.intervalEnd, message.intervalEnd),
        totals,
      };
      if (message.final) {
        byTab.delete(tabId);
      } else {
        byTab.set(tabId, cached);
      }
      return {
        interval: toIntervalPayload(message),
        aggregate: toAggregatePayload(cached),
      };
    },
    currentVisitId(tabId) {
      return byTab.get(tabId)?.visitId;
    },
    finalizeTab(tabId, endedAt) {
      const existing = byTab.get(tabId);
      if (existing === undefined) return null;
      byTab.delete(tabId);
      const interval: EngagementIntervalObservedPayload = {
        payloadVersion: 1,
        visitId: existing.visitId,
        intervalStart: existing.intervalStart,
        intervalEnd: endedAt,
        dimensions: { engagement: existing.totals },
      };
      return {
        interval,
        aggregate: toAggregatePayload({
          ...existing,
          intervalEnd: endedAt,
        }),
      };
    },
    async persist(tabId) {
      const store = durable();
      if (store === null) return;
      const cached = byTab.get(tabId);
      if (cached === undefined) {
        // Tab was finalized (final interval) — clear any durable mirror.
        await store.remove(tabId).catch(() => undefined);
        return;
      }
      const record = foldIntervalIntoSession({
        existing: undefined,
        baseSessionId: input.sessionId,
        tabId,
        visitId: cached.visitId,
        intervalStart: cached.intervalStart,
        intervalEnd: cached.intervalEnd,
        totals: cached.totals,
        now: now(),
      });
      // Pin the sessionId to the one the in-memory cache already minted so
      // durable and live aggregates agree.
      await store
        .set(tabId, { ...record, sessionId: cached.sessionId })
        .catch(() => undefined);
    },
    async clearDurable(tabId) {
      const store = durable();
      if (store === null) return;
      await store.remove(tabId).catch(() => undefined);
    },
    async sweepDurable(olderThanMs, sweepNow) {
      const store = durable();
      if (store === null) return [];
      const all = await store.readAll().catch(() => ({}));
      const finalized: FinalizedEngagement[] = [];
      const toRemove: number[] = [];
      for (const [tabKey, stored] of Object.entries(all)) {
        const tabId = Number(tabKey);
        // Leave live sessions alone — the in-memory cache still owns them
        // and will emit on its own final/close path.
        if (byTab.has(tabId)) continue;
        if (sweepNow - stored.updatedAt < olderThanMs) continue;
        finalized.push({
          interval: storedToInterval(stored, stored.intervalEnd),
          aggregate: storedToAggregate(stored),
        });
        toRemove.push(tabId);
      }
      if (toRemove.length > 0) {
        await store
          .mutate((records) => {
            const next = { ...records };
            for (const tabId of toRemove) delete next[String(tabId)];
            return next;
          })
          .catch(() => undefined);
      }
      return finalized;
    },
  };
};

export const isEngagementIntervalMessage = (value: unknown): value is EngagementIntervalMessage => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'sidetrack.engagement.interval' || record.version !== 1) {
    return false;
  }
  if (typeof record.visitId !== 'string' || record.visitId.length === 0) return false;
  if (typeof record.intervalStart !== 'number' || typeof record.intervalEnd !== 'number') {
    return false;
  }
  if (typeof record.final !== 'boolean') return false;
  const dimensions = record.dimensions;
  if (typeof dimensions !== 'object' || dimensions === null || Array.isArray(dimensions)) {
    return false;
  }
  const engagement = (dimensions as Record<string, unknown>).engagement;
  if (typeof engagement !== 'object' || engagement === null || Array.isArray(engagement)) {
    return false;
  }
  return [
    'activeMs',
    'visibleMs',
    'focusedWindowMs',
    'idleMs',
    'foregroundBursts',
    'returnCount',
    'scrollEvents',
    'maxScrollRatio',
    'copyCount',
    'pasteCount',
  ].every((key) => typeof (engagement as Record<string, unknown>)[key] === 'number');
};
