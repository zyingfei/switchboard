// Dispatch log-event types.
//
// Dispatches are append-only facts (each represents a moment when
// the user shipped text to an external agent), so their projection
// is straightforward: keep every event, sort by (acceptedAtMs, dot).
// Dispatch links are LWW per (dispatchId, threadId) pair — the most
// recent link wins per dispatch.
export const DISPATCH_RECORDED = 'dispatch.recorded';
export const DISPATCH_LINKED = 'dispatch.linked';
const isRecord = (value) => typeof value === 'object' && value !== null;
export const isDispatchRecordedPayload = (value) => {
    if (!isRecord(value))
        return false;
    const target = value['target'];
    return (typeof value['bac_id'] === 'string' &&
        typeof value['createdAt'] === 'string' &&
        typeof value['body'] === 'string' &&
        isRecord(target) &&
        typeof target['provider'] === 'string');
};
export const isDispatchLinkedPayload = (value) => isRecord(value) &&
    typeof value['dispatchId'] === 'string' &&
    typeof value['threadId'] === 'string';
//# sourceMappingURL=events.js.map