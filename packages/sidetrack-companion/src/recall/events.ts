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
  // Recall V3: optional richer rendering fields. The chunker prefers
  // markdown → formattedText → text; these flow through unchanged
  // when the capture event carried them.
  readonly markdown?: string;
  readonly formattedText?: string;
  readonly modelName?: string;
}

export interface CaptureRecordedPayload {
  readonly bac_id: string;
  readonly threadId?: string;
  readonly threadUrl?: string;
  readonly provider?: string;
  readonly title?: string;
  readonly capturedAt: string;
  readonly turns: readonly CaptureTurnInputShape[];
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

export interface RecallTombstonePayload {
  readonly threadId: string;
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasValidPayloadExtensionFields = (value: Record<string, unknown>): boolean =>
  (value['payloadVersion'] === undefined ||
    (typeof value['payloadVersion'] === 'number' && value['payloadVersion'] >= 1)) &&
  (value['dimensions'] === undefined || isRecord(value['dimensions']));

export const isCaptureRecordedPayload = (value: unknown): value is CaptureRecordedPayload => {
  if (!isRecord(value)) return false;
  const v = value;
  if (typeof v['bac_id'] !== 'string') return false;
  if (typeof v['capturedAt'] !== 'string') return false;
  if (!Array.isArray(v['turns'])) return false;
  return hasValidPayloadExtensionFields(v);
};

export const isRecallTombstonePayload = (value: unknown): value is RecallTombstonePayload => {
  if (!isRecord(value)) return false;
  return typeof value['threadId'] === 'string' && hasValidPayloadExtensionFields(value);
};
