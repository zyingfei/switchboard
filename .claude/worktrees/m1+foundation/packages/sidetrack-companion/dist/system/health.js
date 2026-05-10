const withBudget = async (operation, fallback) => await Promise.race([
    operation(),
    new Promise((resolve) => {
        setTimeout(() => {
            resolve(fallback);
        }, 250);
    }),
]);
export const collectHealth = async (deps) => {
    const now = deps.now?.() ?? new Date();
    const [writable, sizeBytes, capture, recall, service] = await Promise.all([
        withBudget(deps.vaultWritable, false),
        withBudget(deps.vaultSizeBytes, null),
        withBudget(deps.captureSummary, {
            lastByProvider: {},
            queueDepthHint: null,
            droppedHint: null,
        }),
        withBudget(deps.recallSummary, {
            indexExists: false,
            entryCount: null,
            modelId: null,
            sizeBytes: null,
        }),
        withBudget(deps.serviceStatus, { installed: false, running: false }),
    ]);
    return {
        uptimeSec: Math.max(0, Math.floor((now.getTime() - deps.startedAt.getTime()) / 1000)),
        vault: { root: deps.vaultRoot, writable, sizeBytes },
        capture,
        recall,
        service,
    };
};
//# sourceMappingURL=health.js.map