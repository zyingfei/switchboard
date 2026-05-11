export const createSyncContractRunner = () => {
    const materializers = new Map();
    const register = (m) => {
        if (materializers.has(m.name)) {
            throw new Error(`SyncContractRunner: materializer '${m.name}' already registered`);
        }
        materializers.set(m.name, m);
    };
    const onAcceptedEvent = (event, ctx) => {
        for (const m of materializers.values()) {
            // Materializers MUST coalesce internally. We swallow throws so
            // one bad materializer doesn't stall the others — its health
            // updates and the runner continues. catchUp will recover on
            // next startup if the in-memory dispatch was lost.
            try {
                if (m.handles.has(event.type)) {
                    m.onAccepted(event, ctx);
                }
            }
            catch {
                // The materializer's own try/catch should have updated
                // health. If it didn't, the failure is silent — but the
                // event is still durable in the log; catchUp recovers.
            }
        }
    };
    // Run catchUp on every materializer. AWAITS each one. If a
    // materializer throws, log + continue with others; aggregated
    // health surfaces the failure.
    const catchUpAll = async (eventLog) => {
        for (const m of materializers.values()) {
            try {
                await m.catchUp(eventLog);
            }
            catch {
                // Materializer's own catch should have updated health. If
                // not, future events + next startup will retry.
            }
        }
    };
    // Same shape as catchUpAll. Callers signal post-reconnect drain;
    // every materializer scans durable state and replays missed work.
    const onRelayReconnected = (eventLog) => catchUpAll(eventLog);
    const awaitIdle = async () => {
        // Resolve when every materializer reports pending=false. Used by
        // tests; production code should not rely on this for correctness.
        for (const m of materializers.values()) {
            try {
                await m.awaitIdle();
            }
            catch {
                // Same swallow rationale as above.
            }
        }
    };
    const health = () => {
        const out = {};
        for (const [name, m] of materializers) {
            try {
                out[name] = m.health();
            }
            catch (err) {
                out[name] = {
                    status: 'failed',
                    lastSuccessAt: null,
                    lastError: err instanceof Error ? err.message : `health() threw: ${String(err)}`,
                    pending: false,
                };
            }
        }
        return out;
    };
    return {
        register,
        onAcceptedEvent,
        catchUpAll,
        onRelayReconnected,
        awaitIdle,
        health,
    };
};
//# sourceMappingURL=runner.js.map