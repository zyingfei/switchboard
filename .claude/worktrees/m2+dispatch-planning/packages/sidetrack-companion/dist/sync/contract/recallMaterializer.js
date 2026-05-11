import { createHash } from 'node:crypto';
import { chunkTurn } from '../../recall/chunker.js';
import { embed } from '../../recall/embedder.js';
import { replaceEntriesForSourceUnit } from '../../recall/indexFile.js';
import { MODEL_ID } from '../../recall/embedder.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import { eventTypesForMaterializer } from './registry.js';
export const createRecallMaterializer = (deps) => {
    const handles = eventTypesForMaterializer('recall');
    let dirty = false;
    let running = false;
    let lastSuccessAt = null;
    let lastError = null;
    const drain = async () => {
        while (dirty) {
            dirty = false;
            try {
                await deps.recallLifecycle.ingestIncremental(deps.eventLog);
                lastSuccessAt = new Date().toISOString();
                lastError = null;
            }
            catch (err) {
                const code = err !== null && typeof err === 'object' && 'code' in err
                    ? String(err.code)
                    : 'unknown';
                const message = err instanceof Error ? err.message : String(err);
                lastError = `${code}: ${message.slice(0, 200)}`;
                deps.recallActivity.recordIngestFailed(lastError);
                // Don't `return` — fall through to the while check. If
                // another request came in mid-flight (dirty=true), the
                // outer loop iterates and retries (rate-bounded by
                // incoming event rate; each new event triggers at most one
                // retry). If dirty=false, the loop exits naturally and we
                // wait for the next event. Without falling through, we'd
                // orphan dirty=true and awaitIdle would spin forever.
            }
        }
    };
    const requestIngest = () => {
        dirty = true;
        if (running)
            return;
        running = true;
        void (async () => {
            try {
                await drain();
            }
            finally {
                running = false;
            }
        })();
    };
    const onAccepted = (event) => {
        void event; // event type is in handles; we re-read the merged log inside drain
        requestIngest();
    };
    // Lane 2: scan extraction store for stale sources (where
    // latestExtractionRevision != indexedExtractionRevision) and
    // source-replace each. Pure function of the durable extraction
    // store state — never relies on a notification callback. This is
    // gate L2-G10's correctness invariant (callback-independent
    // recovery) AND gate L2-G1's behavior (newer extraction → recall
    // returns active only).
    const reconcileExtractionStaleSources = async () => {
        const store = deps.extractionStore;
        const indexPath = deps.indexPath;
        if (store === undefined || indexPath === undefined)
            return;
        const stale = await store.listStaleSources();
        for (const sourceState of stale) {
            const revision = await store.readRevision(sourceState.latestExtractionRevision);
            if (revision === null)
                continue;
            const entries = [];
            // Build chunks from the active extraction revision content.
            // One per turn × paragraph (chunker handles paragraph splits).
            for (const turn of revision.content.turns) {
                const chunks = chunkTurn({
                    sourceBacId: revision.sourceBacId,
                    threadId: revision.sourceBacId,
                    ...(revision.content.threadUrl === undefined
                        ? {}
                        : { threadUrl: revision.content.threadUrl }),
                    ...(revision.content.title === undefined ? {} : { title: revision.content.title }),
                    role: turn.role,
                    turnOrdinal: turn.ordinal,
                    ...(turn.modelName === undefined ? {} : { modelName: turn.modelName }),
                    capturedAt: revision.content.capturedAt,
                    text: turn.text,
                    ...(turn.markdown === undefined ? {} : { markdown: turn.markdown }),
                    ...(turn.formattedText === undefined ? {} : { formattedText: turn.formattedText }),
                });
                if (chunks.length === 0)
                    continue;
                // L2-G2: cache check by `embedTextHash`. CRITICAL: hash the
                // chunk's `embedText` (heading-breadcrumb prefixed input
                // the embedder ACTUALLY sees), NOT the raw `chunk.text` /
                // `chunk.textHash`. A heading rename or chunker breadcrumb
                // change would otherwise reuse a stale vector even though
                // the embedding input changed. (Reviewer-flagged bug.)
                const embedTextHashOf = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
                const cacheHits = [];
                const toEmbed = [];
                for (let i = 0; i < chunks.length; i += 1) {
                    const chunk = chunks[i];
                    const hash = embedTextHashOf(chunk.embedText);
                    const cached = deps.embeddingCache === undefined
                        ? null
                        : await deps.embeddingCache.get({
                            modelId: MODEL_ID,
                            modelRevision: RECALL_MODEL.revision,
                            embedTextHash: hash,
                        });
                    cacheHits.push(cached);
                    if (cached === null) {
                        toEmbed.push({ index: i, embedText: chunk.embedText, hash });
                    }
                }
                const freshVectors = toEmbed.length === 0 ? [] : await embed(toEmbed.map((t) => t.embedText));
                const vectors = [];
                let fresh = 0;
                for (let i = 0; i < chunks.length; i += 1) {
                    const cached = cacheHits[i];
                    if (cached !== null && cached !== undefined) {
                        vectors.push(cached);
                    }
                    else {
                        const vec = freshVectors[fresh] ?? new Float32Array(384);
                        vectors.push(vec);
                        // Store in the cache for future reuse.
                        if (deps.embeddingCache !== undefined) {
                            const entry = toEmbed[fresh];
                            if (entry !== undefined) {
                                await deps.embeddingCache.put({
                                    modelId: MODEL_ID,
                                    modelRevision: RECALL_MODEL.revision,
                                    embedTextHash: entry.hash,
                                }, vec);
                            }
                        }
                        fresh += 1;
                    }
                }
                for (let i = 0; i < chunks.length; i += 1) {
                    const chunk = chunks[i];
                    const vector = vectors[i] ?? new Float32Array(384);
                    entries.push({
                        id: chunk.chunkId,
                        threadId: chunk.threadId,
                        capturedAt: chunk.capturedAt,
                        embedding: vector,
                        tombstoned: false,
                        metadata: {
                            sourceBacId: chunk.sourceBacId,
                            ...(chunk.provider === undefined ? {} : { provider: chunk.provider }),
                            ...(chunk.threadUrl === undefined ? {} : { threadUrl: chunk.threadUrl }),
                            ...(chunk.title === undefined ? {} : { title: chunk.title }),
                            ...(chunk.role === undefined ? {} : { role: chunk.role }),
                            turnOrdinal: chunk.turnOrdinal,
                            ...(chunk.modelName === undefined ? {} : { modelName: chunk.modelName }),
                            headingPath: chunk.headingPath,
                            paragraphIndex: chunk.paragraphIndex,
                            charStart: chunk.charStart,
                            charEnd: chunk.charEnd,
                            textHash: chunk.textHash,
                            text: chunk.text,
                            sourceUnitId: revision.sourceUnitId,
                            extractionRevisionId: revision.extractionRevisionId,
                            extractorId: revision.extractorId,
                            extractorVersion: revision.extractorVersion,
                            extractionSchemaVersion: revision.extractionSchemaVersion,
                            inputHash: revision.inputHash,
                            outputHash: revision.outputHash,
                            chunkerVersion: revision.chunkerVersion,
                        },
                    });
                }
            }
            await replaceEntriesForSourceUnit(indexPath, {
                sourceUnitId: revision.sourceUnitId,
                extractionRevisionId: revision.extractionRevisionId,
                entries,
            }, MODEL_ID);
            await store.markIndexed(revision.sourceUnitId, revision.extractionRevisionId);
        }
    };
    const catchUp = async (_eventLog) => {
        void _eventLog; // bound at construction; runner-arg ignored
        // First: replay the merged log via ingestIncremental for any
        // legacy capture events not yet ingested.
        requestIngest();
        while (running) {
            await new Promise((r) => setTimeout(r, 5));
        }
        if (dirty) {
            requestIngest();
            while (running) {
                await new Promise((r) => setTimeout(r, 5));
            }
        }
        // Second: scan extraction store for stale sources and
        // source-replace. Idempotent — markIndexed flips status to
        // 'current' so subsequent passes are noops until a new
        // extraction revision flips it back to 'stale'.
        try {
            await reconcileExtractionStaleSources();
        }
        catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        }
    };
    const awaitIdle = async () => {
        while (running || dirty) {
            await new Promise((r) => setTimeout(r, 5));
        }
    };
    const health = () => ({
        status: lastError !== null ? 'failed' : running || dirty ? 'degraded' : 'healthy',
        lastSuccessAt,
        lastError,
        pending: running || dirty,
    });
    return {
        name: 'recall',
        handles,
        onAccepted,
        catchUp,
        awaitIdle,
        health,
    };
};
//# sourceMappingURL=recallMaterializer.js.map