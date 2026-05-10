import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getResolvedEmbedderAccelerator, getResolvedEmbedderDevice, MODEL_ID, } from './embedder.js';
import { readIndex } from './indexFile.js';
import { rebuildFromEventLog } from './rebuild.js';
const indexPathFor = (vaultRoot) => join(vaultRoot, '_BAC', 'recall', 'index.bin');
const eventLogPathFor = (vaultRoot) => join(vaultRoot, '_BAC', 'events');
const countTurnsInEventLog = async (vaultRoot) => {
    const eventDir = eventLogPathFor(vaultRoot);
    const files = await readdir(eventDir).catch(() => []);
    let total = 0;
    for (const file of files) {
        if (!file.endsWith('.jsonl'))
            continue;
        const raw = await readFile(join(eventDir, file), 'utf8').catch(() => '');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0)
                continue;
            try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed !== 'object' || parsed === null)
                    continue;
                const turns = parsed.turns;
                if (!Array.isArray(turns))
                    continue;
                for (const rawTurn of turns) {
                    if (typeof rawTurn !== 'object' || rawTurn === null)
                        continue;
                    const text = rawTurn.text;
                    if (typeof text === 'string' && text.trim().length > 0) {
                        total += 1;
                    }
                }
            }
            catch {
                // Ignore malformed lines — the event log is append-only.
            }
        }
    }
    return total;
};
export const createRecallLifecycle = (opts) => {
    const currentModelId = opts.currentModelId ?? MODEL_ID;
    const rebuilder = opts.rebuilder ?? rebuildFromEventLog;
    const log = opts.log ?? ((message) => {
        // eslint-disable-next-line no-console
        console.info(message);
    });
    const warn = opts.warn ?? ((message) => {
        console.warn(message);
    });
    let rebuildPromise = null;
    let lastError = null;
    let lastRebuildAt = null;
    let lastRebuildIndexed = null;
    // Live progress fields — only meaningful while rebuildPromise is
    // active; reset to 0 between runs so the UI doesn't latch onto
    // a stale fraction.
    let rebuildEmbedded = 0;
    let rebuildTotal = 0;
    const report = async () => {
        const [index, eventTurnCount] = await Promise.all([
            readIndex(indexPathFor(opts.vaultRoot)),
            countTurnsInEventLog(opts.vaultRoot),
        ]);
        const entryCount = index?.items.length ?? 0;
        const modelId = index?.modelId ?? null;
        let status;
        if (rebuildPromise !== null) {
            status = 'rebuilding';
        }
        else if (index === null) {
            status = 'missing';
        }
        else if (modelId !== currentModelId) {
            status = 'stale';
        }
        else if (entryCount === 0 && eventTurnCount > 0) {
            // Header is current but nothing got indexed (likely an
            // upgrade from before incremental indexing was wired). Treat
            // as stale so reconnect-time auto-rebuild can heal it.
            status = 'stale';
        }
        else if (entryCount === 0) {
            status = 'empty';
        }
        else {
            status = 'ready';
        }
        return {
            status,
            entryCount,
            eventTurnCount,
            modelId,
            currentModelId,
            companionVersion: opts.companionVersion,
            lastRebuildAt,
            lastRebuildIndexed,
            lastError,
            rebuildEmbedded,
            rebuildTotal,
            embedderDevice: getResolvedEmbedderDevice(),
            embedderAccelerator: getResolvedEmbedderAccelerator(),
        };
    };
    const scheduleRebuild = (reason) => {
        if (rebuildPromise !== null)
            return;
        log(`[recall] starting background rebuild (${reason})`);
        lastError = null;
        rebuildEmbedded = 0;
        rebuildTotal = 0;
        rebuildPromise = (async () => {
            try {
                const result = await rebuilder(opts.vaultRoot, eventLogPathFor(opts.vaultRoot), {
                    onProgress: (embedded, total) => {
                        rebuildEmbedded = embedded;
                        rebuildTotal = total;
                    },
                });
                lastRebuildAt = new Date().toISOString();
                lastRebuildIndexed = result.indexed;
                log(`[recall] background rebuild finished: indexed ${String(result.indexed)} entries`);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : 'Recall rebuild failed.';
                lastError = message;
                warn(`[recall] background rebuild failed: ${message}`);
            }
            finally {
                rebuildPromise = null;
                rebuildEmbedded = 0;
                rebuildTotal = 0;
            }
        })();
    };
    const ensureFresh = async () => {
        const current = await report();
        if (current.status === 'missing' || current.status === 'stale') {
            scheduleRebuild('startup');
        }
        return current;
    };
    const waitForRebuild = async () => {
        if (rebuildPromise !== null) {
            await rebuildPromise;
        }
    };
    const isRebuilding = () => rebuildPromise !== null;
    return { report, ensureFresh, scheduleRebuild, waitForRebuild, isRebuilding };
};
//# sourceMappingURL=lifecycle.js.map