// Recall log-event types. The recall index is now a projection of
// these events from the per-replica log:
//
//   capture.recorded         — one per accepted /v1/events POST
//   recall.tombstone.target  — one per archive (or future hard-delete)
//
// Both events carry their thread id as the aggregateId so projection
// readers can filter by aggregate, and both round-trip through the
// causal foundation (dot, deps, idempotent on clientEventId).
export const CAPTURE_RECORDED = 'capture.recorded';
export const RECALL_TOMBSTONE_TARGET = 'recall.tombstone.target';
export const isCaptureRecordedPayload = (value) => {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    if (typeof v['bac_id'] !== 'string')
        return false;
    if (typeof v['capturedAt'] !== 'string')
        return false;
    if (!Array.isArray(v['turns']))
        return false;
    return true;
};
export const isRecallTombstonePayload = (value) => {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    return typeof v['threadId'] === 'string';
};
//# sourceMappingURL=events.js.map