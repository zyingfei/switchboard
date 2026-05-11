import { eventTypesForMaterializer } from './registry.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload, } from '../../timeline/events.js';
import { buildDayProjection, collectTimelinePayloads, dayBucketFor, groupByDay, } from '../../timeline/projection.js';
// Reviewer-flagged: persistent rebuildDay failures (e.g. disk full)
// would tight-loop because every onAccepted re-triggers drain. We
// add a small backoff window after a failure: if the last drain
// attempt failed within FAILURE_COOLDOWN_MS, requestDrain is a
// no-op (the day is already in dirtyDays from the failure path; a
// later catchUp / alarm / event after the cooldown will retry).
const FAILURE_COOLDOWN_MS = 5_000;
export const createTimelineMaterializer = (deps) => {
    const handles = eventTypesForMaterializer('timeline');
    let pending = false;
    let running = false;
    let lastSuccessAt = null;
    let lastError = null;
    // Wall-clock ms of the most recent drain failure; used by
    // requestDrain to skip retries within FAILURE_COOLDOWN_MS so a
    // persistent failure doesn't tight-loop with the event stream.
    let lastFailureAtMs = 0;
    // Days touched since the last drain. Set semantics — rebuild
    // each one once. catchUp clears this and rebuilds everything
    // observed in the merged log.
    let dirtyDays = new Set();
    const rebuildDay = async (date) => {
        const merged = await deps.eventLog.readMerged();
        const payloads = collectTimelinePayloads(merged.filter((e) => e.type === BROWSER_TIMELINE_OBSERVED &&
            isBrowserTimelineObservedPayload(e.payload) &&
            dayBucketFor(e.payload.observedAt) === date));
        const projection = buildDayProjection(date, payloads);
        await deps.store.putDay(projection);
    };
    const drain = async () => {
        while (dirtyDays.size > 0) {
            // Snapshot + clear so events arriving during the drain
            // re-mark their day. The next loop iteration picks them up.
            const snapshot = [...dirtyDays];
            dirtyDays = new Set();
            try {
                await Promise.all(snapshot.map((day) => rebuildDay(day)));
                lastSuccessAt = new Date().toISOString();
                lastError = null;
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                lastFailureAtMs = Date.now();
                // Re-add failed days for next-trigger retry; exit drain
                // loop to avoid tight-retry. Combined with the
                // FAILURE_COOLDOWN_MS gate in requestDrain, persistent
                // failures don't burn CPU on every incoming event.
                for (const day of snapshot)
                    dirtyDays.add(day);
                return;
            }
        }
    };
    const requestDrain = (date) => {
        dirtyDays.add(date);
        pending = true;
        if (running)
            return;
        // Reviewer-flagged backoff: skip starting a new drain if a
        // recent failure is still within the cooldown window. The day
        // stays in dirtyDays; an event/catchUp/alarm after the
        // cooldown picks it up. catchUp explicitly bypasses this gate
        // (its caller is willing to drive the retry).
        const sinceFailureMs = Date.now() - lastFailureAtMs;
        if (lastError !== null && sinceFailureMs < FAILURE_COOLDOWN_MS)
            return;
        running = true;
        void (async () => {
            try {
                await drain();
            }
            finally {
                running = false;
                pending = dirtyDays.size > 0;
            }
        })();
    };
    const onAccepted = (event, _ctx) => {
        if (event.type !== BROWSER_TIMELINE_OBSERVED)
            return;
        if (!isBrowserTimelineObservedPayload(event.payload))
            return;
        const day = dayBucketFor(event.payload.observedAt);
        requestDrain(day);
    };
    const catchUp = async (eventLog) => {
        pending = true;
        try {
            const merged = await eventLog.readMerged();
            const payloads = collectTimelinePayloads(merged);
            const grouped = groupByDay(payloads);
            // Rebuild every day that has at least one event in the merged
            // log. Idempotent; no notification dependence (gate L2-G10
            // analogue for timeline). Days that no longer have events
            // (e.g. all events tombstoned in a future iteration) keep
            // their projection file; if that ever needs cleanup, add a
            // sweep here.
            for (const [date, dayPayloads] of grouped) {
                const projection = buildDayProjection(date, dayPayloads);
                await deps.store.putDay(projection);
            }
            lastSuccessAt = new Date().toISOString();
            lastError = null;
            dirtyDays = new Set();
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
        finally {
            pending = dirtyDays.size > 0 || running;
        }
    };
    const awaitIdle = async () => {
        while (running || dirtyDays.size > 0) {
            await new Promise((r) => setTimeout(r, 5));
        }
    };
    const health = () => ({
        status: lastError !== null ? 'failed' : pending ? 'degraded' : 'healthy',
        lastSuccessAt,
        lastError,
        pending,
    });
    return {
        name: 'timeline',
        handles,
        onAccepted,
        catchUp,
        awaitIdle,
        health,
    };
};
//# sourceMappingURL=timelineMaterializer.js.map