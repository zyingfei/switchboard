import { eventDominates, mergeRegister, vectorFromEvents, } from '../sync/causal.js';
import { isWorkstreamDeletedPayload, isWorkstreamUpsertedPayload, WORKSTREAM_DELETED, WORKSTREAM_UPSERTED, } from './events.js';
const recordFromUpsert = (payload) => ({
    bac_id: payload.bac_id,
    title: payload.title,
    ...(payload.parentId === undefined ? {} : { parentId: payload.parentId }),
    ...(payload.privacy === undefined ? {} : { privacy: payload.privacy }),
    ...(payload.screenShareSensitive === undefined
        ? {}
        : { screenShareSensitive: payload.screenShareSensitive }),
    tags: payload.tags ?? [],
    children: payload.children ?? [],
    checklist: payload.checklist ?? [],
    ...(payload.description === undefined ? {} : { description: payload.description }),
});
const isRelevant = (event, bacId) => {
    if (event.type === WORKSTREAM_UPSERTED) {
        return isWorkstreamUpsertedPayload(event.payload) && event.payload.bac_id === bacId;
    }
    if (event.type === WORKSTREAM_DELETED) {
        return isWorkstreamDeletedPayload(event.payload) && event.payload.bac_id === bacId;
    }
    return false;
};
export const projectWorkstream = (bacId, events) => {
    const relevant = events.filter((event) => isRelevant(event, bacId));
    const upsertCandidates = [];
    const deletes = [];
    for (const event of relevant) {
        if (event.type === WORKSTREAM_UPSERTED && isWorkstreamUpsertedPayload(event.payload)) {
            upsertCandidates.push({ value: recordFromUpsert(event.payload), event });
            continue;
        }
        if (event.type === WORKSTREAM_DELETED) {
            deletes.push(event);
        }
    }
    const isErased = (event) => deletes.some((tombstone) => eventDominates(tombstone, event));
    const live = upsertCandidates.filter((candidate) => !isErased(candidate.event));
    const record = mergeRegister(live);
    const deleted = deletes.length > 0 && record.status === 'resolved' && record.value === undefined;
    const lastEventMs = relevant.reduce((latest, event) => Math.max(latest, event.acceptedAtMs), 0);
    return {
        bac_id: bacId,
        record,
        deleted,
        vector: vectorFromEvents(relevant),
        updatedAtMs: lastEventMs,
    };
};
//# sourceMappingURL=projection.js.map