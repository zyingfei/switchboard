import {
  emptyEngagementTotals,
  mergeEngagementTotals,
  type EngagementIntervalMessage,
  type EngagementTotals,
} from '../../content/engagement/aggregator';

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
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly totals: EngagementTotals;
}

export interface EngagementCache {
  readonly mergeInterval: (
    tabId: number,
    message: EngagementIntervalMessage,
  ) => {
    readonly interval: EngagementIntervalObservedPayload;
    readonly aggregate: EngagementSessionAggregatedPayload;
  };
  readonly finalizeTab: (
    tabId: number,
    endedAt: number,
  ) =>
    | {
        readonly interval: EngagementIntervalObservedPayload;
        readonly aggregate: EngagementSessionAggregatedPayload;
      }
    | null;
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
  sessionId: string,
  cached: CachedEngagementSession,
): EngagementSessionAggregatedPayload => ({
  payloadVersion: 1,
  visitId: cached.visitId,
  sessionId,
  dimensions: {
    engagement: cached.totals,
  },
});

export const createEngagementCache = (input: {
  readonly sessionId: string;
}): EngagementCache => {
  const byTab = new Map<number, CachedEngagementSession>();

  return {
    mergeInterval(tabId, message) {
      const existing = byTab.get(tabId);
      const totals =
        existing === undefined
          ? mergeEngagementTotals(emptyEngagementTotals(), message.dimensions.engagement)
          : mergeEngagementTotals(existing.totals, message.dimensions.engagement);
      const cached: CachedEngagementSession = {
        visitId: message.visitId,
        intervalStart: Math.min(existing?.intervalStart ?? message.intervalStart, message.intervalStart),
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
        aggregate: toAggregatePayload(input.sessionId, cached),
      };
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
        aggregate: toAggregatePayload(input.sessionId, {
          ...existing,
          intervalEnd: endedAt,
        }),
      };
    },
  };
};

export const isEngagementIntervalMessage = (
  value: unknown,
): value is EngagementIntervalMessage => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record['type'] !== 'sidetrack.engagement.interval' || record['version'] !== 1) {
    return false;
  }
  if (typeof record['visitId'] !== 'string' || record['visitId'].length === 0) return false;
  if (typeof record['intervalStart'] !== 'number' || typeof record['intervalEnd'] !== 'number') {
    return false;
  }
  if (typeof record['final'] !== 'boolean') return false;
  const dimensions = record['dimensions'];
  if (typeof dimensions !== 'object' || dimensions === null || Array.isArray(dimensions)) {
    return false;
  }
  const engagement = (dimensions as Record<string, unknown>)['engagement'];
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
