export const ENGAGEMENT_INTERVAL_OBSERVED = 'engagement.interval.observed' as const;
export const ENGAGEMENT_SESSION_AGGREGATED = 'engagement.session.aggregated' as const;

export type EngagementEventType =
  | typeof ENGAGEMENT_INTERVAL_OBSERVED
  | typeof ENGAGEMENT_SESSION_AGGREGATED;

export interface EngagementDimensions {
  readonly activeMs: number;
  readonly visibleMs: number;
  readonly focusedWindowMs: number;
  readonly idleMs: number;
  readonly foregroundBursts: number;
  readonly returnCount: number;
  readonly scrollEvents: number;
  readonly maxScrollRatio: number;
  readonly copyCount: number;
  readonly pasteCount: number;
}

export interface EngagementIntervalObservedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly dimensions: {
    readonly engagement: EngagementDimensions;
  };
}

export interface EngagementSessionAggregatedPayload {
  readonly payloadVersion: 1;
  readonly visitId: string;
  readonly sessionId: string;
  readonly dimensions: {
    readonly engagement: EngagementDimensions;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEngagementDimensions = (value: unknown): value is EngagementDimensions => {
  if (!isRecord(value)) return false;
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
  ].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
};

const hasOnlyEngagementDimension = (value: Record<string, unknown>): boolean => {
  if (!isRecord(value['dimensions'])) return false;
  const dimensionKeys = Object.keys(value['dimensions']);
  if (dimensionKeys.length !== 1 || dimensionKeys[0] !== 'engagement') return false;
  return isEngagementDimensions(value['dimensions']['engagement']);
};

export const isEngagementIntervalObservedPayload = (
  value: unknown,
): value is EngagementIntervalObservedPayload =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  typeof value['visitId'] === 'string' &&
  value['visitId'].length > 0 &&
  typeof value['intervalStart'] === 'number' &&
  typeof value['intervalEnd'] === 'number' &&
  value['intervalEnd'] >= value['intervalStart'] &&
  hasOnlyEngagementDimension(value);

export const isEngagementSessionAggregatedPayload = (
  value: unknown,
): value is EngagementSessionAggregatedPayload =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  typeof value['visitId'] === 'string' &&
  value['visitId'].length > 0 &&
  typeof value['sessionId'] === 'string' &&
  value['sessionId'].length > 0 &&
  hasOnlyEngagementDimension(value);
