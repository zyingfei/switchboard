import { runImportProjectors } from '../projectors.js';
import { eventTypesForMaterializer } from './registry.js';
export const createProjectionMaterializer = (deps) => {
    const handles = eventTypesForMaterializer('projection');
    let pending = false;
    let lastSuccessAt = null;
    let lastError = null;
    const runOne = async (event, eventLog) => {
        pending = true;
        try {
            await runImportProjectors({
                vaultRoot: deps.vaultRoot,
                eventLog,
                ...(deps.projectionChanges === undefined
                    ? {}
                    : { projectionChanges: deps.projectionChanges }),
            }, event);
            lastSuccessAt = new Date().toISOString();
            lastError = null;
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            // Failure is per-event; the event is durable in the log; next
            // catchUp recovers.
        }
        finally {
            pending = false;
        }
    };
    // EventLog is bound at construction time (single log per process).
    // No "boundEventLog === null" race — onAccepted always has the
    // log available.
    const onAccepted = (event) => {
        void runOne(event, deps.eventLog);
    };
    const catchUp = async (eventLog) => {
        pending = true;
        try {
            const merged = await eventLog.readMerged();
            // Process each aggregate's latest event. Same logic as
            // antiEntropy + reproject, here unified.
            const latest = new Map();
            for (const event of merged) {
                if (!handles.has(event.type))
                    continue;
                const prior = latest.get(event.aggregateId);
                if (prior === undefined || event.acceptedAtMs >= prior.acceptedAtMs) {
                    latest.set(event.aggregateId, event);
                }
            }
            for (const event of latest.values()) {
                try {
                    await runImportProjectors({
                        vaultRoot: deps.vaultRoot,
                        eventLog,
                        ...(deps.projectionChanges === undefined
                            ? {}
                            : { projectionChanges: deps.projectionChanges }),
                    }, event);
                }
                catch (err) {
                    lastError = err instanceof Error ? err.message : String(err);
                }
            }
            lastSuccessAt = new Date().toISOString();
        }
        finally {
            pending = false;
        }
    };
    const awaitIdle = async () => {
        while (pending) {
            await new Promise((r) => setTimeout(r, 5));
        }
    };
    const health = () => ({
        status: lastError !== null ? 'failed' : 'healthy',
        lastSuccessAt,
        lastError,
        pending,
    });
    return {
        name: 'projection',
        handles,
        onAccepted,
        catchUp,
        awaitIdle,
        health,
    };
};
//# sourceMappingURL=projectionMaterializer.js.map