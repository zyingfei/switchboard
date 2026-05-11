// Per-operation timeout. The 250ms cap that lived here originally
// was tight enough to silently force `captureSummary` and
// `recallSummary` into their empty fallbacks on any vault with
// multi-MB event logs — the UX was "Capture health is empty even
// though I just captured ten things." /v1/system/health is polled
// every ~30s, not on the request hot path, so a multi-second
// budget is the right tradeoff.
const FAST_OP_BUDGET_MS = 1_000;
const HEAVY_OP_BUDGET_MS = 5_000;
const withBudget = async (operation, fallback, budgetMs = FAST_OP_BUDGET_MS) => await Promise.race([
    operation(),
    new Promise((resolve) => {
        setTimeout(() => {
            resolve(fallback);
        }, budgetMs);
    }),
]);
export const collectHealth = async (deps) => {
    const now = deps.now?.() ?? new Date();
    const [writable, sizeBytes, capture, recall, service] = await Promise.all([
        withBudget(deps.vaultWritable, false),
        withBudget(deps.vaultSizeBytes, null, HEAVY_OP_BUDGET_MS),
        withBudget(deps.captureSummary, { lastByProvider: {}, queueDepthHint: null, droppedHint: null }, HEAVY_OP_BUDGET_MS),
        withBudget(deps.recallSummary, { indexExists: false, entryCount: null, modelId: null, sizeBytes: null }, HEAVY_OP_BUDGET_MS),
        withBudget(deps.serviceStatus, { installed: false, running: false }),
    ]);
    const sync = deps.syncSummary?.();
    return {
        uptimeSec: Math.max(0, Math.floor((now.getTime() - deps.startedAt.getTime()) / 1000)),
        vault: { root: deps.vaultRoot, writable, sizeBytes },
        capture,
        recall,
        service,
        ...(sync === undefined ? {} : { sync }),
    };
};
//# sourceMappingURL=health.js.map