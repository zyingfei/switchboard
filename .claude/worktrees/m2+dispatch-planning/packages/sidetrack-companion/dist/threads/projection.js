import { eventDominates, mergeRegister, vectorFromEvents, } from '../sync/causal.js';
import { isThreadStatusPayload, isThreadUpsertedPayload, THREAD_ARCHIVED, THREAD_DELETED, THREAD_UNARCHIVED, THREAD_UPSERTED, } from './events.js';
const isRelevant = (event, bacId) => {
    if (event.type === THREAD_UPSERTED) {
        return isThreadUpsertedPayload(event.payload) && event.payload.bac_id === bacId;
    }
    if (event.type === THREAD_ARCHIVED ||
        event.type === THREAD_UNARCHIVED ||
        event.type === THREAD_DELETED) {
        return isThreadStatusPayload(event.payload) && event.payload.bac_id === bacId;
    }
    return false;
};
const recordFromUpsert = (payload) => ({
    bac_id: payload.bac_id,
    provider: payload.provider,
    threadUrl: payload.threadUrl,
    title: payload.title,
    lastSeenAt: payload.lastSeenAt,
    tags: payload.tags ?? [],
    ...(payload.primaryWorkstreamId === undefined
        ? {}
        : { primaryWorkstreamId: payload.primaryWorkstreamId }),
    ...(payload.trackingMode === undefined ? {} : { trackingMode: payload.trackingMode }),
});
export const projectThread = (bacId, events) => {
    const relevant = events.filter((event) => isRelevant(event, bacId));
    const upsertCandidates = [];
    const statusCandidates = [];
    const deletes = [];
    for (const event of relevant) {
        if (event.type === THREAD_UPSERTED && isThreadUpsertedPayload(event.payload)) {
            upsertCandidates.push({ value: recordFromUpsert(event.payload), event });
            // Each upsert can also carry an explicit status. Surface that
            // as a status-register candidate so a peer's later archive
            // doesn't lose to an upsert that arrived without observing it.
            if (event.payload.status !== undefined) {
                statusCandidates.push({ value: event.payload.status, event });
            }
            continue;
        }
        if (event.type === THREAD_ARCHIVED) {
            statusCandidates.push({ value: 'archived', event });
            continue;
        }
        if (event.type === THREAD_UNARCHIVED) {
            statusCandidates.push({ value: 'tracked', event });
            continue;
        }
        if (event.type === THREAD_DELETED) {
            deletes.push(event);
            continue;
        }
    }
    // A delete wins only over events it causally observed. Concurrent
    // later upserts revive the thread.
    const isErased = (event) => deletes.some((tombstone) => eventDominates(tombstone, event));
    const liveUpserts = upsertCandidates.filter((candidate) => !isErased(candidate.event));
    const liveStatus = statusCandidates.filter((candidate) => !isErased(candidate.event));
    const record = mergeRegister(liveUpserts);
    const status = mergeRegister(liveStatus);
    const deleted = deletes.length > 0 &&
        record.status === 'resolved' &&
        record.value === undefined &&
        status.status === 'resolved' &&
        status.value === undefined;
    const lastEventMs = relevant.reduce((latest, event) => Math.max(latest, event.acceptedAtMs), 0);
    return {
        bac_id: bacId,
        record,
        status,
        deleted,
        vector: vectorFromEvents(relevant),
        updatedAtMs: lastEventMs,
    };
};
//# sourceMappingURL=projection.js.map