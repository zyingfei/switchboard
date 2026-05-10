import { eventDominates, mergeRegister, vectorFromEvents, } from '../sync/causal.js';
export const REVIEW_DRAFT_EVENT_TYPES = [
    'review-draft.span.added',
    'review-draft.span.removed',
    'review-draft.comment.set',
    'review-draft.overall.set',
    'review-draft.verdict.set',
    'review-draft.discarded',
];
export const isReviewDraftEvent = (event) => REVIEW_DRAFT_EVENT_TYPES.includes(event.type);
const isAnchor = (value) => {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    const tq = v['textQuote'];
    const tp = v['textPosition'];
    if (typeof tq !== 'object' || tq === null)
        return false;
    if (typeof tp !== 'object' || tp === null)
        return false;
    const tqv = tq;
    const tpv = tp;
    return (typeof tqv['exact'] === 'string' &&
        typeof tqv['prefix'] === 'string' &&
        typeof tqv['suffix'] === 'string' &&
        typeof tpv['start'] === 'number' &&
        typeof tpv['end'] === 'number' &&
        typeof v['cssSelector'] === 'string');
};
const isVerdict = (value) => value === 'agree' ||
    value === 'disagree' ||
    value === 'partial' ||
    value === 'needs_source' ||
    value === 'open';
export const projectReviewDraft = (threadId, threadUrl, events) => {
    const overallCandidates = [];
    const verdictCandidates = [];
    const discardEvents = [];
    const spans = new Map();
    const ensureSpan = (spanId) => {
        let info = spans.get(spanId);
        if (info === undefined) {
            info = { spanId, adds: [], removes: [], comments: [] };
            spans.set(spanId, info);
        }
        return info;
    };
    for (const event of events) {
        if (event.type === 'review-draft.discarded') {
            discardEvents.push(event);
            continue;
        }
        if (event.type === 'review-draft.overall.set') {
            const text = event.payload['text'];
            if (typeof text === 'string') {
                overallCandidates.push({ value: text, event });
            }
            continue;
        }
        if (event.type === 'review-draft.verdict.set') {
            const payload = event.payload;
            const value = isVerdict(payload['value']) ? payload['value'] : payload['verdict'];
            if (isVerdict(value)) {
                verdictCandidates.push({ value, event });
            }
            continue;
        }
        if (event.type === 'review-draft.span.added') {
            const payload = event.payload;
            const spanId = typeof payload['spanId'] === 'string' ? payload['spanId'] : null;
            if (spanId === null)
                continue;
            const info = ensureSpan(spanId);
            info.adds.push(event);
            // An add can carry an initial comment; record as the first
            // register candidate so a later comment.set without prior
            // edits still resolves cleanly.
            const initial = typeof payload['comment'] === 'string'
                ? payload['comment']
                : typeof payload['initialComment'] === 'string'
                    ? payload['initialComment']
                    : null;
            if (initial !== null && initial.length > 0) {
                info.comments.push({ value: initial, event });
            }
            continue;
        }
        if (event.type === 'review-draft.span.removed') {
            const payload = event.payload;
            const spanId = typeof payload['spanId'] === 'string' ? payload['spanId'] : null;
            if (spanId === null)
                continue;
            ensureSpan(spanId).removes.push(event);
            continue;
        }
        if (event.type === 'review-draft.comment.set') {
            const payload = event.payload;
            const spanId = typeof payload['spanId'] === 'string' ? payload['spanId'] : null;
            const text = typeof payload['text'] === 'string' ? payload['text'] : null;
            if (spanId === null || text === null)
                continue;
            ensureSpan(spanId).comments.push({ value: text, event });
            continue;
        }
    }
    // Discard wins only over events it causally observed. Concurrent
    // edits stay alive — they reconstitute a fresh draft.
    const isDiscarded = (event) => discardEvents.some((discard) => eventDominates(discard, event));
    // For each span, surviving adds are those not dominated by any
    // remove for the same span. Spans with no surviving adds are
    // tombstoned.
    const liveSpans = [];
    const tombstones = [];
    for (const info of spans.values()) {
        const survivingAdds = info.adds.filter((add) => !info.removes.some((remove) => eventDominates(remove, add)) && !isDiscarded(add));
        if (survivingAdds.length === 0) {
            tombstones.push(info.spanId);
            continue;
        }
        // Pick the most recent surviving add for the static fields
        // (anchor, quote, capturedAt). Concurrent adds with different
        // anchors stay diagnostically visible via `addDots`.
        const winnerAdd = survivingAdds.reduce((winner, candidate) => candidate.acceptedAtMs > winner.acceptedAtMs ? candidate : winner);
        const winnerPayload = winnerAdd.payload;
        const anchor = winnerPayload['anchor'];
        if (!isAnchor(anchor))
            continue;
        const quote = typeof winnerPayload['quote'] === 'string' ? winnerPayload['quote'] : '';
        const capturedAt = typeof winnerPayload['capturedAt'] === 'string'
            ? winnerPayload['capturedAt']
            : new Date(winnerAdd.acceptedAtMs).toISOString();
        const liveCommentCandidates = info.comments.filter((value) => !isDiscarded(value.event));
        const comment = mergeRegister(liveCommentCandidates);
        liveSpans.push({
            spanId: info.spanId,
            quote,
            anchor,
            comment,
            capturedAt,
            addDots: survivingAdds.map((add) => add.dot),
            removeDots: info.removes.map((remove) => remove.dot),
        });
    }
    // Sort spans by spanId so projection output is deterministic.
    liveSpans.sort((a, b) => (a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0));
    tombstones.sort();
    const overall = mergeRegister(overallCandidates.filter((c) => !isDiscarded(c.event)));
    const verdict = mergeRegister(verdictCandidates.filter((c) => !isDiscarded(c.event)));
    // The draft is "discarded" iff every aggregate-level candidate
    // is dominated by some discard event AND no later add survives.
    const discardedByLatest = discardEvents.length > 0 &&
        liveSpans.length === 0 &&
        overall.status === 'resolved' &&
        overall.value === undefined &&
        verdict.status === 'resolved' &&
        verdict.value === undefined;
    const lastEventMs = events.length === 0
        ? 0
        : events.reduce((latest, event) => Math.max(latest, event.acceptedAtMs), 0);
    return {
        threadId,
        threadUrl,
        vector: vectorFromEvents(events),
        spans: liveSpans,
        overall,
        verdict,
        tombstones: { spanIds: tombstones },
        discarded: discardedByLatest,
        updatedAtMs: lastEventMs,
    };
};
//# sourceMappingURL=projection.js.map