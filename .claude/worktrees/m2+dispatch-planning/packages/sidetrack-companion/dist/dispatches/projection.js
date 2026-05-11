import { mergeRegister, vectorFromEvents, } from '../sync/causal.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED, isDispatchLinkedPayload, isDispatchRecordedPayload, } from './events.js';
const recordedFromPayload = (event, payload) => ({
    bac_id: payload.bac_id,
    target: payload.target,
    ...(payload.workstreamId === undefined ? {} : { workstreamId: payload.workstreamId }),
    createdAt: payload.createdAt,
    body: payload.body,
    replicaId: event.dot.replicaId,
    seq: event.dot.seq,
});
export const projectDispatches = (events) => {
    const entries = [];
    const linksByDispatch = new Map();
    for (const event of events) {
        if (event.type === DISPATCH_RECORDED && isDispatchRecordedPayload(event.payload)) {
            entries.push(recordedFromPayload(event, event.payload));
            continue;
        }
        if (event.type === DISPATCH_LINKED && isDispatchLinkedPayload(event.payload)) {
            const payload = event.payload;
            let bucket = linksByDispatch.get(payload.dispatchId);
            if (bucket === undefined) {
                bucket = [];
                linksByDispatch.set(payload.dispatchId, bucket);
            }
            bucket.push({ value: payload, event });
        }
    }
    // Stable order: createdAt then dot. Same input → same output.
    entries.sort((a, b) => {
        if (a.createdAt !== b.createdAt)
            return a.createdAt < b.createdAt ? -1 : 1;
        if (a.replicaId !== b.replicaId)
            return a.replicaId < b.replicaId ? -1 : 1;
        return a.seq - b.seq;
    });
    const links = [];
    for (const [dispatchId, candidates] of linksByDispatch.entries()) {
        const merged = mergeRegister(candidates);
        if (merged.status === 'resolved') {
            links.push({
                dispatchId,
                ...(merged.value === undefined ? {} : { threadId: merged.value.threadId }),
            });
        }
        else {
            links.push({
                dispatchId,
                conflict: merged.candidates.map((candidate) => ({
                    threadId: candidate.value.threadId,
                    replicaId: candidate.replicaId,
                })),
            });
        }
    }
    links.sort((a, b) => (a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0));
    return {
        entries,
        links,
        vector: vectorFromEvents(events.filter((event) => event.type === DISPATCH_RECORDED || event.type === DISPATCH_LINKED)),
        updatedAtMs: events.reduce((max, event) => Math.max(max, event.acceptedAtMs), 0),
    };
};
//# sourceMappingURL=projection.js.map