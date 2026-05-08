// Dispatch log-event types.
//
// Dispatches are append-only facts (each represents a moment when
// the user shipped text to an external agent), so their projection
// is straightforward: keep every event, sort by (acceptedAtMs, dot).
// Dispatch links are LWW per (dispatchId, threadId) pair — the most
// recent link wins per dispatch.

export const DISPATCH_RECORDED = 'dispatch.recorded' as const;
export const DISPATCH_LINKED = 'dispatch.linked' as const;

export type DispatchEventType = typeof DISPATCH_RECORDED | typeof DISPATCH_LINKED;

export interface DispatchRecordedPayload {
  readonly bac_id: string;
  readonly target: { readonly provider: string };
  readonly workstreamId?: string;
  readonly createdAt: string;
  // We mirror the redacted body here, never the unredacted clipboard
  // contents — the redaction step happens before this event lands.
  readonly body: string;
  // Phase 4 cross-replica fix: include the structural attribution
  // (sourceThreadId, mcpRequest) so peer companions can emit
  // dispatch_from_thread / dispatch_in_workstream /
  // dispatch_requested_coding_session from the event log alone —
  // the dispatch JSONL stays per-replica and doesn't sync.
  readonly sourceThreadId?: string;
  readonly mcpRequest?: { readonly codingSessionId: string };
  // Optional title — useful as a label fallback in the connections
  // graph when peer companions don't have the local JSONL.
  readonly title?: string;
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

export interface DispatchLinkedPayload {
  readonly dispatchId: string;
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

export const isDispatchRecordedPayload = (
  value: unknown,
): value is DispatchRecordedPayload => {
  if (!isRecord(value)) return false;
  const target = value['target'];
  return (
    typeof value['bac_id'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    typeof value['body'] === 'string' &&
    isRecord(target) &&
    typeof target['provider'] === 'string' &&
    hasValidPayloadExtensionFields(value)
  );
};

export const isDispatchLinkedPayload = (
  value: unknown,
): value is DispatchLinkedPayload =>
  isRecord(value) &&
  typeof value['dispatchId'] === 'string' &&
  typeof value['threadId'] === 'string' && hasValidPayloadExtensionFields(value);
