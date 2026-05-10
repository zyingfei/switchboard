// Queue-item log-event types.
//
//   queue.created — full record at creation time.
//   queue.statusSet — status sub-register update (pending → done →
//                     dismissed).
//
// Per-item is a register over (text, scope, targetId) at creation
// plus a status sub-register. Concurrent status updates surface as
// conflicts; concurrent creates of the same id are unusual (the
// HTTP route mints the bac_id) so we don't model them.
export const QUEUE_CREATED = 'queue.created';
export const QUEUE_STATUS_SET = 'queue.statusSet';
const isRecord = (value) => typeof value === 'object' && value !== null;
export const isQueueCreatedPayload = (value) => isRecord(value) &&
    typeof value['bac_id'] === 'string' &&
    typeof value['text'] === 'string' &&
    typeof value['scope'] === 'string';
export const isQueueStatusSetPayload = (value) => isRecord(value) &&
    typeof value['bac_id'] === 'string' &&
    (value['status'] === 'pending' || value['status'] === 'done' || value['status'] === 'dismissed');
//# sourceMappingURL=events.js.map