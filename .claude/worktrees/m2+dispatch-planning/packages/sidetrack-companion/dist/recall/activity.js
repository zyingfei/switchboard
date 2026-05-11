const MAX_RECENT_EVENTS = 20;
const MAX_THREAD_IDS = 5;
const uniqueLimited = (values) => {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        if (seen.has(value))
            continue;
        seen.add(value);
        out.push(value);
        if (out.length >= MAX_THREAD_IDS)
            break;
    }
    return out;
};
export const createRecallActivityTracker = (now = () => new Date()) => {
    let lastIndexedAt = null;
    let lastIndexedCount = null;
    let lastIndexedThreadIds = [];
    let lastRecallQueryAt = null;
    let lastRecallQueryResultCount = null;
    let lastSuggestionAt = null;
    let lastSuggestionThreadId = null;
    let recent = [];
    const push = (event) => {
        const withTime = { ...event, at: now().toISOString() };
        recent = [withTime, ...recent].slice(0, MAX_RECENT_EVENTS);
    };
    return {
        recordIncrementalIndex(input) {
            lastIndexedAt = now().toISOString();
            lastIndexedCount = input.count;
            lastIndexedThreadIds = uniqueLimited(input.threadIds);
            const event = {
                kind: 'incremental-index',
                at: lastIndexedAt,
                count: input.count,
                threadIds: lastIndexedThreadIds,
            };
            recent = [event, ...recent].slice(0, MAX_RECENT_EVENTS);
        },
        recordRebuildStarted(reason) {
            push({ kind: 'rebuild-started', reason });
        },
        recordRebuildFinished(count) {
            lastIndexedAt = now().toISOString();
            lastIndexedCount = count;
            lastIndexedThreadIds = [];
            const event = { kind: 'rebuild-finished', at: lastIndexedAt, count };
            recent = [event, ...recent].slice(0, MAX_RECENT_EVENTS);
        },
        recordRebuildFailed(error) {
            push({ kind: 'rebuild-failed', error });
        },
        recordIngestFailed(error) {
            // Capture-time projection failed (most often the offline +
            // empty-cache path triggering RecallModelMissingError). The
            // event is durably appended either way; the operator just
            // needs visibility that the cache is stale and a manual
            // `recall reingest` will be needed once the model is
            // available. Pushed onto `recent` rather than promoted to a
            // dedicated lastIngestError field — health consumers should
            // already be inspecting `recent` for diagnostic context.
            push({ kind: 'ingest-failed', error });
        },
        recordQuery(input) {
            lastRecallQueryAt = now().toISOString();
            lastRecallQueryResultCount = input.resultCount;
            const event = {
                kind: 'query',
                at: lastRecallQueryAt,
                queryLength: input.queryLength,
                resultCount: input.resultCount,
            };
            recent = [event, ...recent].slice(0, MAX_RECENT_EVENTS);
        },
        recordSuggestion(input) {
            lastSuggestionAt = now().toISOString();
            lastSuggestionThreadId = input.threadId;
            const event = {
                kind: 'suggestion',
                at: lastSuggestionAt,
                threadId: input.threadId,
                resultCount: input.resultCount,
            };
            recent = [event, ...recent].slice(0, MAX_RECENT_EVENTS);
        },
        report() {
            return {
                lastIndexedAt,
                lastIndexedCount,
                lastIndexedThreadIds,
                lastRecallQueryAt,
                lastRecallQueryResultCount,
                lastSuggestionAt,
                lastSuggestionThreadId,
                recent,
            };
        },
    };
};
//# sourceMappingURL=activity.js.map