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
}

export interface DispatchLinkedPayload {
  readonly dispatchId: string;
  readonly threadId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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
    typeof target['provider'] === 'string'
  );
};

export const isDispatchLinkedPayload = (
  value: unknown,
): value is DispatchLinkedPayload =>
  isRecord(value) &&
  typeof value['dispatchId'] === 'string' &&
  typeof value['threadId'] === 'string';
