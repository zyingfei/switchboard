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
  // Wall-clock (injected now()) of the last mergeInterval for this tab.
  // Drives in-memory sweep aging: once zero-delta suppression stops a
  // background tab's periodic beacons, this stops advancing and the
  // session ages out of the live cache into a single aggregate.
  readonly lastMergedAtMs: number;
  // Cumulative totals ALREADY emitted for this (tabId, visitId) by a prior
  // sweep-aging finalize. Undefined until the session is first sealed.
  //
  // Why this exists: the content aggregator is CUMULATIVE-since-page-load —
  // every snapshot carries the full running totals, never a reset. Sweep
  // aging (below) emits one aggregate for a stale-but-still-live tab. If the
  // user later returns to that tab, its next beacon re-enters mergeInterval
  // and, without this baseline, we would emit a SECOND aggregate carrying
  // the full cumulative totals again. The companion sums aggregates per
  // visitId across distinct (sessionId, replicaId, seq) keys with no
  // sessionId dedup, so that double-counts a visit's engagement — inflating
  // focusedWindowMs and manufacturing spurious 5s visit-similarity edges.
  //
  // With a sealed baseline the resumed session emits only the INCREMENT
  // since the seal (current cumulative minus this baseline), so
  // sealed + increment == current cumulative: one visit, one total.
  readonly sealedEmittedTotals?: EngagementTotals;
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
   * cached — or if the session was already sealed by a sweep and has no new
   * engagement since (its aggregate already shipped). The emitted totals are
   * the increment over any sealed baseline, so a swept-then-resumed session
   * is never double-counted. The caller clears the durable mirror.
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
   * Sweep sessions idle since before `olderThanMs`, emitting one aggregate
   * for each stale session's outstanding engagement. Covers two families:
   *  - durable orphans: sessions whose SW was evicted before a final beacon
   *    landed (mirror survives in chrome.storage.local) — emitted and the
   *    mirror removed; and
   *  - stale in-memory sessions: live-cache tabs whose `lastMergedAtMs` is
   *    older than the threshold — an abandoned background tab whose periodic
   *    beacons were suppressed (zero-delta). Each is emitted then SEALED in
   *    place (kept in the cache under the same sessionId with a baseline of
   *    the totals just reported) rather than deleted, so if the user returns
   *    the resumed session emits only the increment since the seal — never a
   *    second full aggregate that the companion would sum into a double
   *    count. Its durable mirror is cleared so the durable pass can't re-emit
   *    it. An already-sealed idle session with no new engagement is skipped.
   * A still-fresh in-memory tab is left untouched.
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

// Totals to REPORT for a session, given any already-sealed baseline.
//
// Summable dimensions report only the delta since the seal so the
// companion's per-visit SUM lands on the true cumulative (sealed + delta).
// `maxScrollRatio` is a MAX on the companion side (not a sum), so it is
// passed through unchanged — reporting the running max never double-counts.
// Clamped at 0 so a (theoretically impossible) baseline larger than the
// current cumulative never emits a negative delta.
const totalsToReport = (cached: CachedEngagementSession): EngagementTotals => {
  const baseline = cached.sealedEmittedTotals;
  if (baseline === undefined) return cached.totals;
  const t = cached.totals;
  const sub = (current: number, sealed: number): number => Math.max(0, current - sealed);
  return {
    activeMs: sub(t.activeMs, baseline.activeMs),
    visibleMs: sub(t.visibleMs, baseline.visibleMs),
    focusedWindowMs: sub(t.focusedWindowMs, baseline.focusedWindowMs),
    idleMs: sub(t.idleMs, baseline.idleMs),
    foregroundBursts: sub(t.foregroundBursts, baseline.foregroundBursts),
    returnCount: sub(t.returnCount, baseline.returnCount),
    scrollEvents: sub(t.scrollEvents, baseline.scrollEvents),
    maxScrollRatio: t.maxScrollRatio,
    copyCount: sub(t.copyCount, baseline.copyCount),
    pasteCount: sub(t.pasteCount, baseline.pasteCount),
  };
};

// Whether the session has accrued any REPORTABLE engagement not yet
// emitted — true for a never-sealed session, or a sealed one that has
// grown in any summable dimension since its seal. Used to gate sweep
// re-emission so an already-sealed idle session (no growth) is not
// finalized again on every subsequent sweep. `maxScrollRatio` is excluded:
// it is a max, not fresh reportable time, and would not by itself justify a
// second aggregate.
const hasReportableEngagement = (cached: CachedEngagementSession): boolean => {
  const r = totalsToReport(cached);
  if (cached.sealedEmittedTotals === undefined) return true;
  return (
    r.activeMs > 0 ||
    r.visibleMs > 0 ||
    r.focusedWindowMs > 0 ||
    r.idleMs > 0 ||
    r.foregroundBursts > 0 ||
    r.returnCount > 0 ||
    r.scrollEvents > 0 ||
    r.copyCount > 0 ||
    r.pasteCount > 0
  );
};

const toAggregatePayload = (
  cached: CachedEngagementSession,
): EngagementSessionAggregatedPayload => ({
  payloadVersion: 1,
  visitId: cached.visitId,
  sessionId: cached.sessionId,
  dimensions: {
    engagement: totalsToReport(cached),
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
      // A prior sweep may have SEALED this tab's session (emitted an
      // aggregate for a stale-but-still-live tab) without deleting it. If
      // the same visit resumes, carry the sealed baseline forward so the
      // aggregate we emit next reports only the increment since the seal —
      // never re-counting the already-emitted engagement. A DIFFERENT visit
      // (same tab, new URL) starts a fresh session with no baseline: the seal
      // belonged to the prior visit and must not suppress the new one.
      const carriedSeal =
        existing?.sealedEmittedTotals !== undefined && existing.visitId === message.visitId
          ? existing.sealedEmittedTotals
          : undefined;
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
        lastMergedAtMs: now(),
        ...(carriedSeal !== undefined ? { sealedEmittedTotals: carriedSeal } : {}),
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
      // A session already sealed by a sweep with no new engagement since has
      // nothing left to report — its aggregate already shipped. Return null
      // so we don't emit an empty (all-zero) aggregate on tab close.
      if (!hasReportableEngagement(existing)) return null;
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
      const finalized: FinalizedEngagement[] = [];
      // Tabs whose in-memory session we sealed this sweep. A durable mirror
      // also exists for each (persist() runs after every merge), so we clear
      // those mirrors and never let the durable pass emit the same tab — the
      // "one aggregate per unit of engagement" invariant.
      const inMemorySealed = new Set<number>();
      // Age out live in-memory sessions whose last merge is older than the
      // threshold. Once zero-delta suppression halts a background tab's
      // periodic beacons, mergeInterval stops firing, `lastMergedAtMs`
      // freezes, and the abandoned session finalizes here (the pre-fix
      // behavior skipped live tabs unconditionally: `if (byTab.has(tabId))
      // continue`).
      //
      // We SEAL rather than delete: the session stays in byTab, marked with
      // the cumulative totals just emitted (`sealedEmittedTotals`). The
      // content aggregator is cumulative-since-page-load, so if the user
      // returns to this tab its next beacon reaches mergeInterval, carries
      // the seal forward, and the NEXT aggregate reports only the increment
      // since the seal. Deleting instead (the reviewed defect) let a resumed
      // tab rebuild from zero against a cumulative aggregator and re-emit the
      // full totals under a new sessionId — which the companion SUMS per
      // visit, roughly doubling focusedWindowMs and manufacturing spurious
      // >=5s visit-similarity edges. An already-sealed idle session with no
      // new engagement is skipped (`hasReportableEngagement` is false) so it
      // is not finalized again on every subsequent sweep.
      for (const [tabId, cached] of [...byTab.entries()]) {
        if (sweepNow - cached.lastMergedAtMs < olderThanMs) continue;
        if (!hasReportableEngagement(cached)) continue;
        finalized.push({
          interval: {
            payloadVersion: 1,
            visitId: cached.visitId,
            intervalStart: cached.intervalStart,
            intervalEnd: cached.intervalEnd,
            dimensions: { engagement: cached.totals },
          },
          aggregate: toAggregatePayload(cached),
        });
        // Seal in place: keep the session (same sessionId) so a resume emits
        // deltas, and record the baseline just reported.
        //
        // Crash window (narrow, bounded, documented): the seal lives only in
        // this in-memory Map, and the durable mirror is cleared below (per the
        // one-aggregate-per-session design). If the SW is evicted while a
        // session is sealed-and-idle AND the user then resumes that exact tab
        // on a fresh SW, mergeInterval sees no seal and re-emits the full
        // cumulative on finalize — a single-visit double. This is strictly
        // narrower than the warm-SW double this fix closes (it also needs an
        // eviction between seal and resume), and no worse in magnitude than
        // the MV3-eviction caveats the durable store already accepts. Making
        // it crash-safe would require seeding the seal from the durable mirror
        // on a fresh SW (a store-schema change), deferred as out of scope.
        byTab.set(tabId, { ...cached, sealedEmittedTotals: cached.totals });
        inMemorySealed.add(tabId);
      }

      const store = durable();
      if (store === null) {
        // No durable mirror to reconcile — the in-memory aging above is the
        // whole result.
        return finalized;
      }
      const all = await store.readAll().catch(() => ({}));
      const toRemove: number[] = [...inMemorySealed];
      for (const [tabKey, stored] of Object.entries(all)) {
        const tabId = Number(tabKey);
        // Already sealed from the in-memory cache this sweep — clear the
        // stale mirror below but do NOT emit a second aggregate.
        if (inMemorySealed.has(tabId)) continue;
        // Leave still-live sessions alone — the in-memory cache owns them
        // and either emits on its own final/close path or ages out here on
        // a later sweep once its `lastMergedAtMs` passes the threshold.
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
