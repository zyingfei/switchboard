// Recall log-event types. The recall index is now a projection of
// these events from the per-replica log:
//
//   capture.recorded         — one per accepted /v1/events POST
//   recall.tombstone.target  — one per archive (or future hard-delete)
//
// Both events carry their thread id as the aggregateId so projection
// readers can filter by aggregate, and both round-trip through the
// causal foundation (dot, deps, idempotent on clientEventId).

export const CAPTURE_RECORDED = 'capture.recorded' as const;
export const RECALL_TOMBSTONE_TARGET = 'recall.tombstone.target' as const;

export type RecallEventType = typeof CAPTURE_RECORDED | typeof RECALL_TOMBSTONE_TARGET;

export interface CaptureTurnInputShape {
  readonly ordinal?: number;
  readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
  readonly text: string;
  readonly capturedAt?: string;
}

export interface CaptureRecordedPayload {
  readonly bac_id: string;
  readonly threadId?: string;
  readonly threadUrl?: string;
  readonly provider?: string;
  readonly capturedAt: string;
  readonly turns: readonly CaptureTurnInputShape[];
}

export interface RecallTombstonePayload {
  readonly threadId: string;
}

export const isCaptureRecordedPayload = (value: unknown): value is CaptureRecordedPayload => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['bac_id'] !== 'string') return false;
  if (typeof v['capturedAt'] !== 'string') return false;
  if (!Array.isArray(v['turns'])) return false;
  return true;
};

export const isRecallTombstonePayload = (value: unknown): value is RecallTombstonePayload => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['threadId'] === 'string';
};
