import { runImportProjectors } from './projectors.js';
const latestPerAggregate = (events) => {
    const byId = new Map();
    for (const event of events) {
        const prior = byId.get(event.aggregateId);
        if (prior === undefined || event.acceptedAtMs >= prior.acceptedAtMs) {
            byId.set(event.aggregateId, event);
        }
    }
    return [...byId.values()];
};
export const startAntiEntropyTask = (deps) => {
    const intervalMs = deps.intervalMs ?? 30 * 60 * 1000;
    let stopped = false;
    const scanOnce = async () => {
        if (stopped)
            return 0;
        try {
            const merged = await deps.eventLog.readMerged();
            const latest = latestPerAggregate(merged);
            for (const event of latest) {
                if (stopped)
                    break;
                await runImportProjectors({
                    vaultRoot: deps.vaultRoot,
                    eventLog: deps.eventLog,
                    ...(deps.projectionChanges === undefined
                        ? {}
                        : { projectionChanges: deps.projectionChanges }),
                }, event).catch(() => undefined);
            }
            deps.onScanComplete?.(latest.length);
            return latest.length;
        }
        catch {
            return 0;
        }
    };
    const timer = setInterval(() => {
        void scanOnce();
    }, intervalMs);
    // setInterval keeps the event loop alive on Node; release it so a
    // companion process can shut down cleanly when the loop is otherwise
    // idle. The HTTP server keeps the loop alive while it's listening.
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    if (deps.fireImmediately === true) {
        void scanOnce();
    }
    return {
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
        scanNow: scanOnce,
    };
};
//# sourceMappingURL=antiEntropy.js.map