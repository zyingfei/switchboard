// Thread log-event types. PR3 introduces threads as a causal
// projection of these events, alongside the legacy `_BAC/threads/
// <bac_id>.json` write path (kept for back-compat readers; the log
// is the durable cross-replica truth going forward).
//
// Event semantics:
//   thread.upserted   — full-record register write. Each upsert
//                        carries the whole thread payload; the
//                        projection collapses concurrent upserts via
//                        causal-register merge.
//   thread.archived   — status sub-register write. Causally newer
//                        archive supersedes any prior status; tied
//                        with an unarchive resolves via the LWW
//                        register tiebreak.
//   thread.unarchived — symmetric to archived.
//   thread.deleted    — hard tombstone. The projection short-circuits
//                        to a deleted state; subsequent upserts
//                        whose deps cover the delete revive the
//                        thread. Concurrent later upserts revive on
//                        their own merit (matches review-draft
//                        discard semantics).
export const THREAD_UPSERTED = 'thread.upserted';
export const THREAD_ARCHIVED = 'thread.archived';
export const THREAD_UNARCHIVED = 'thread.unarchived';
export const THREAD_DELETED = 'thread.deleted';
const isRecord = (value) => typeof value === 'object' && value !== null;
export const isThreadUpsertedPayload = (value) => {
    if (!isRecord(value))
        return false;
    return (typeof value['bac_id'] === 'string' &&
        typeof value['provider'] === 'string' &&
        typeof value['threadUrl'] === 'string' &&
        typeof value['title'] === 'string' &&
        typeof value['lastSeenAt'] === 'string');
};
export const isThreadStatusPayload = (value) => isRecord(value) && typeof value['bac_id'] === 'string';
//# sourceMappingURL=events.js.map