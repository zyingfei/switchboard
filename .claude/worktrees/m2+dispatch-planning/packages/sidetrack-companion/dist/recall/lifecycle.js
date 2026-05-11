import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { embed, getResolvedEmbedderAccelerator, getResolvedEmbedderDevice, MODEL_ID, } from './embedder.js';
import { RECALL_TOMBSTONE_TARGET } from './events.js';
import { appendEntry as appendEntryRaw, gcEntries as gcEntriesRaw, readIndex, tombstoneByThread as tombstoneByThreadRaw, } from './indexFile.js';
import { rebuildFromEventLog } from './rebuild.js';
const indexPathFor = (vaultRoot) => join(vaultRoot, '_BAC', 'recall', 'index.bin');
const eventLogPathFor = (vaultRoot) => join(vaultRoot, '_BAC', 'events');
const countTurnsInEventLog = async (vaultRoot, eventLog) => {
    // Sources, in priority order:
    //   1. The per-replica log under `_BAC/log/<replicaId>/*.jsonl`.
    //      This is where every post-PR-#93 capture lives — including
    //      events synced from peers via the relay. We MUST count this
    //      or drift detection is blind to cross-replica captures and
    //      auto-rebuilds never fire after a sync.
    //   2. The legacy `_BAC/events/*.jsonl` file. Pre-PR-#93 vaults
    //      have only this; post-#93 vaults still write a back-compat
    //      copy of the local replica's captures here. We dedupe by
    //      bac_id so we don't double-count a local capture that was
    //      written through both paths.
    let total = 0;
    const seenBacIds = new Set();
    if (eventLog !== undefined) {
        const accepted = await eventLog.readMerged();
        for (const event of accepted) {
            if (event.type !== 'capture.recorded')
                continue;
            const payload = event.payload;
            if (typeof payload.bac_id === 'string') {
                seenBacIds.add(payload.bac_id);
            }
            if (!Array.isArray(payload.turns))
                continue;
            for (const rawTurn of payload.turns) {
                if (typeof rawTurn !== 'object' || rawTurn === null)
                    continue;
                const text = rawTurn.text;
                if (typeof text === 'string' && text.trim().length > 0) {
                    total += 1;
                }
            }
        }
    }
    const eventDir = eventLogPathFor(vaultRoot);
    const files = await readdir(eventDir).catch(() => []);
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
                const bacId = parsed.bac_id;
                if (typeof bacId === 'string' && seenBacIds.has(bacId)) {
                    // Already accounted for via the per-replica log walk
                    // above; skip so we don't double-count.
                    continue;
                }
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
    const embedFn = opts.embedder ?? embed;
    const driftTolerance = opts.driftTolerance ?? 0.05;
    const log = opts.log ??
        ((message) => {
            // eslint-disable-next-line no-console
            console.info(message);
        });
    const warn = opts.warn ??
        ((message) => {
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
    // Single-writer mutex serialising every path that mutates the
    // index file. Rebuild, appendEntry, gcEntries, tombstoneByThread,
    // and the auto-index batch all queue here so two concurrent
    // callers cannot read-then-write the same file.
    let writeChain = Promise.resolve();
    const enqueueWrite = (task) => {
        const next = writeChain.then(task, task);
        writeChain = next.then(() => undefined, () => undefined);
        return next;
    };
    const report = async () => {
        const [index, eventTurnCount] = await Promise.all([
            readIndex(indexPathFor(opts.vaultRoot)),
            countTurnsInEventLog(opts.vaultRoot, opts.eventLog),
        ]);
        // Tombstoned rows are still on disk (OR-Set semantics) but the
        // user's mental model is "deleted." Drift compares the live
        // entry count against the event log so a tombstoned row doesn't
        // mask missing index coverage.
        const liveEntryCount = (index?.items ?? []).filter((item) => item.tombstoned !== true).length;
        const entryCount = index?.items.length ?? 0;
        const modelId = index?.modelId ?? null;
        const driftPct = eventTurnCount > 0 && liveEntryCount < eventTurnCount
            ? Math.max(0, 1 - liveEntryCount / eventTurnCount)
            : 0;
        const driftBeyondTolerance = driftPct > driftTolerance;
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
        else if (driftBeyondTolerance) {
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
            drift: {
                eventTurnCount,
                entryCount,
                pct: driftPct,
                tolerance: driftTolerance,
            },
        };
    };
    const scheduleRebuild = (reason) => {
        if (rebuildPromise !== null)
            return;
        opts.activity?.recordRebuildStarted(reason);
        log(`[recall] starting background rebuild (${reason})`);
        lastError = null;
        rebuildEmbedded = 0;
        rebuildTotal = 0;
        rebuildPromise = enqueueWrite(async () => {
            try {
                const result = await rebuilder(opts.vaultRoot, eventLogPathFor(opts.vaultRoot), {
                    onProgress: (embedded, total) => {
                        rebuildEmbedded = embedded;
                        rebuildTotal = total;
                    },
                    ...(opts.eventLog === undefined ? {} : { eventLog: opts.eventLog }),
                });
                opts.activity?.recordRebuildFinished(result.indexed);
                lastRebuildAt = new Date().toISOString();
                lastRebuildIndexed = result.indexed;
                log(`[recall] background rebuild finished: indexed ${String(result.indexed)} entries`);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : 'Recall rebuild failed.';
                lastError = message;
                opts.activity?.recordRebuildFailed(message);
                warn(`[recall] background rebuild failed: ${message}`);
            }
            finally {
                rebuildPromise = null;
                rebuildEmbedded = 0;
                rebuildTotal = 0;
            }
        });
    };
    const ensureFresh = async () => {
        const current = await report();
        if (current.status === 'missing' || current.status === 'stale') {
            scheduleRebuild(current.status === 'missing' ? 'startup' : 'drift');
        }
        return current;
    };
    const waitForRebuild = async () => {
        if (rebuildPromise !== null) {
            await rebuildPromise;
        }
    };
    const isRebuilding = () => rebuildPromise !== null;
    const indexPath = () => indexPathFor(opts.vaultRoot);
    // Cap matches rebuildFromEventLog so memory pressure stays bounded
    // during catch-up after a long offline window. 16 turns × ~1500
    // chars × 384-dim ≈ ~75KB of activations per batch on this model.
    const AUTO_INDEX_BATCH_SIZE = 16;
    const appendEntry = (entry) => enqueueWrite(async () => {
        await appendEntryRaw(indexPath(), entry, currentModelId);
    });
    const gcEntries = (validIds) => enqueueWrite(async () => await gcEntriesRaw(indexPath(), validIds));
    const ingestIncremental = (eventLog) => enqueueWrite(async () => {
        // Lazy import keeps the lifecycle module's dependency graph
        // narrow — the ingestor pulls in the chunker + manifest paths
        // which are heavy.
        const { ingestIncremental: ingest } = await import('./ingestor.js');
        return await ingest(opts.vaultRoot, eventLog);
    });
    const tombstoneByThread = (threadId) => enqueueWrite(async () => {
        // Emit a log event so peers learn about the tombstone via
        // sync. clientEventId is deterministic per (threadId,
        // replicaId) so a duplicate archive call collapses on the
        // eventLog's idempotency check rather than appending another
        // event. Best-effort; if the eventLog isn't wired (legacy
        // tests), we still mutate the index locally.
        if (opts.eventLog !== undefined && opts.replica !== undefined) {
            // Invariant C: do not pass an explicit baseVector. The
            // eventLog auto-resolves deps from this aggregate's prior
            // events, so concurrent tombstones from two replicas still
            // dominate any pre-tombstone projection.
            await opts.eventLog
                .appendServerObserved({
                clientEventId: `recall-tombstone:${opts.replica.replicaId}:${threadId}`,
                aggregateId: threadId,
                type: RECALL_TOMBSTONE_TARGET,
                payload: { threadId },
            })
                .catch(() => undefined);
        }
        return await tombstoneByThreadRaw(indexPath(), threadId);
    });
    return {
        report,
        ensureFresh,
        scheduleRebuild,
        waitForRebuild,
        isRebuilding,
        appendEntry,
        gcEntries,
        tombstoneByThread,
        ingestIncremental,
    };
};
//# sourceMappingURL=lifecycle.js.map