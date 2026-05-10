import { CAPTURE_RECORDED, isCaptureRecordedPayload, isRecallTombstonePayload, RECALL_TOMBSTONE_TARGET, } from './events.js';
// Walk the merged log and emit one input per surviving turn.
//
//   - `capture.recorded` events become per-turn inputs, stamped with
//     the event's dot for replicaId/lamport.
//   - `recall.tombstone.target` events flag every input whose
//     threadId matches as tombstoned. Tombstones are monotonic —
//     once flagged, never resurrected.
//
// The output order mirrors the input order (already deterministic
// thanks to `sortAcceptedEvents` in the eventLog reader).
export const projectRecallFromLog = (events) => {
    const tombstonedThreads = new Set();
    for (const event of events) {
        if (event.type !== RECALL_TOMBSTONE_TARGET)
            continue;
        if (!isRecallTombstonePayload(event.payload))
            continue;
        tombstonedThreads.add(event.payload.threadId);
    }
    const items = [];
    for (const event of events) {
        if (event.type !== CAPTURE_RECORDED)
            continue;
        if (!isCaptureRecordedPayload(event.payload))
            continue;
        const payload = event.payload;
        const threadId = payload.threadId ?? payload.bac_id;
        let fallbackOrdinal = 0;
        for (const turn of payload.turns) {
            if (typeof turn.text !== 'string' || turn.text.trim().length === 0) {
                fallbackOrdinal += 1;
                continue;
            }
            const ordinal = typeof turn.ordinal === 'number' ? turn.ordinal : fallbackOrdinal;
            fallbackOrdinal = Math.max(fallbackOrdinal + 1, ordinal + 1);
            const capturedAt = turn.capturedAt ?? payload.capturedAt;
            items.push({
                id: `${threadId}:${String(ordinal)}`,
                threadId,
                capturedAt,
                text: turn.text,
                replicaId: event.dot.replicaId,
                lamport: event.dot.seq,
                tombstoned: tombstonedThreads.has(threadId),
                sourceBacId: payload.bac_id,
                turnOrdinal: ordinal,
                ...(turn.markdown === undefined ? {} : { markdown: turn.markdown }),
                ...(turn.formattedText === undefined ? {} : { formattedText: turn.formattedText }),
                ...(turn.role === undefined ? {} : { role: turn.role }),
                ...(turn.modelName === undefined ? {} : { modelName: turn.modelName }),
                ...(payload.provider === undefined ? {} : { provider: payload.provider }),
                ...(payload.threadUrl === undefined ? {} : { threadUrl: payload.threadUrl }),
                ...(payload.title === undefined ? {} : { title: payload.title }),
            });
        }
    }
    return items;
};
// Map of bac_id → set of (id, replicaId) tuples already produced by
// the log projection. The rebuild path consults this when scanning
// the legacy `_BAC/events/` log so a capture that's been migrated
// (or written through the new dual-write path) is not double-indexed.
export const collectLogBacIds = (events) => {
    const out = new Set();
    for (const event of events) {
        if (event.type !== CAPTURE_RECORDED)
            continue;
        if (!isCaptureRecordedPayload(event.payload))
            continue;
        out.add(event.payload.bac_id);
    }
    return out;
};
//# sourceMappingURL=projection.js.map