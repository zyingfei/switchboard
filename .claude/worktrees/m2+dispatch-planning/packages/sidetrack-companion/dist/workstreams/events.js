// Workstream log-event types.
//
//   workstream.upserted — register write of the whole record
//                          (created + updated collapse to one
//                          event type since both replace fields).
//   workstream.deleted  — tombstone. Concurrent later upserts
//                          revive (matches thread + review-draft
//                          discard semantics).
export const WORKSTREAM_UPSERTED = 'workstream.upserted';
export const WORKSTREAM_DELETED = 'workstream.deleted';
const isRecord = (value) => typeof value === 'object' && value !== null;
export const isWorkstreamUpsertedPayload = (value) => isRecord(value) && typeof value['bac_id'] === 'string' && typeof value['title'] === 'string';
export const isWorkstreamDeletedPayload = (value) => isRecord(value) && typeof value['bac_id'] === 'string';
//# sourceMappingURL=events.js.map