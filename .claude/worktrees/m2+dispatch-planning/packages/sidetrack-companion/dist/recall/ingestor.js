import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chunkTurn } from './chunker.js';
import { embed } from './embedder.js';
import { INDEX_CHUNK_SCHEMA_VERSION, INDEX_VERSION, tombstoneByThread, upsertEntries, } from './indexFile.js';
import { CAPTURE_RECORDED, isCaptureRecordedPayload, isRecallTombstonePayload, RECALL_TOMBSTONE_TARGET, } from './events.js';
import { RECALL_MODEL, RECALL_MODEL_ID } from './modelManifest.js';
const recallDir = (vaultRoot) => join(vaultRoot, '_BAC', 'recall');
const manifestPath = (vaultRoot) => join(recallDir(vaultRoot), 'manifest.json');
const ingestStatePath = (vaultRoot) => join(recallDir(vaultRoot), 'ingest-state.json');
const indexPath = (vaultRoot) => join(recallDir(vaultRoot), 'index.bin');
const writeAtomic = async (path, body) => {
    await mkdir(join(path, '..'), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
};
const readJsonOrDefault = async (path, fallback) => {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return fallback;
    }
};
export const readIngestState = (vaultRoot) => readJsonOrDefault(ingestStatePath(vaultRoot), { processedEvents: {} });
export const readRecallManifest = (vaultRoot) => readJsonOrDefault(manifestPath(vaultRoot), null);
export const writeRecallManifest = async (vaultRoot) => {
    const manifest = {
        indexVersion: INDEX_VERSION,
        chunkSchemaVersion: INDEX_CHUNK_SCHEMA_VERSION,
        modelId: RECALL_MODEL.modelId,
        modelRevision: RECALL_MODEL.revision,
        embeddingDim: RECALL_MODEL.embeddingDim,
        builtAt: new Date().toISOString(),
    };
    await writeAtomic(manifestPath(vaultRoot), `${JSON.stringify(manifest, null, 2)}\n`);
};
const writeIngestState = (vaultRoot, state) => writeAtomic(ingestStatePath(vaultRoot), `${JSON.stringify(state, null, 2)}\n`);
const metadataFromChunk = (chunk) => ({
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
});
// Cap how many texts the embedder sees per call. Same value as
// rebuild.ts so the memory footprint matches.
const EMBED_BATCH = 16;
const EMBED_TEXT_CHARS = 4000;
export const ingestIncremental = async (vaultRoot, eventLog) => {
    const state = await readIngestState(vaultRoot);
    const merged = await eventLog.readMerged();
    // Filter to events past the previous frontier per replica so a
    // long history doesn't get re-projected on every tick.
    const fresh = merged.filter((event) => {
        const lastSeq = state.processedEvents[event.dot.replicaId] ?? 0;
        return event.dot.seq > lastSeq;
    });
    // Tombstones are MONOTONIC over the merged log. A tombstone
    // emitted in a prior incremental pass (already past the
    // frontier) must still tombstone any capture that arrives later
    // for the same thread — otherwise a delayed peer capture
    // arriving after the thread was already deleted would land as
    // a LIVE chunk in this pass while a full rebuild would
    // tombstone it. To stay rebuild-equivalent, the per-chunk
    // tombstone check below uses EVERY tombstone in the merged log,
    // not just `fresh`. (Reviewer-flagged divergence bug.)
    //
    // We keep TWO sets:
    //   - `tombstonedThreads` (full merged-log scan): the per-chunk
    //     tombstone flag at insert time uses this. Captures for a
    //     previously-tombstoned thread land tombstoned no matter
    //     when they arrive.
    //   - `freshTombstones`: only the tombstones that JUST landed in
    //     this pass. We run tombstoneByThread for these to flip
    //     existing index entries; older tombstones already applied
    //     their sweep in prior passes, so re-running them would
    //     just be wasted I/O (no correctness impact, but pointless).
    const tombstonedThreads = new Set();
    for (const event of merged) {
        if (event.type !== RECALL_TOMBSTONE_TARGET)
            continue;
        if (!isRecallTombstonePayload(event.payload))
            continue;
        tombstonedThreads.add(event.payload.threadId);
    }
    const freshTombstones = new Set();
    for (const event of fresh) {
        if (event.type !== RECALL_TOMBSTONE_TARGET)
            continue;
        if (!isRecallTombstonePayload(event.payload))
            continue;
        freshTombstones.add(event.payload.threadId);
    }
    // Chunk every fresh capture.recorded event.
    const chunks = [];
    for (const event of fresh) {
        if (event.type !== CAPTURE_RECORDED)
            continue;
        if (!isCaptureRecordedPayload(event.payload))
            continue;
        const payload = event.payload;
        const threadId = payload.threadId ?? payload.bac_id;
        let fallbackOrdinal = 0;
        for (const turn of payload.turns) {
            if (typeof turn.text !== 'string' || turn.text.trim().length === 0) {
                fallbackOrdinal += 1;
                continue;
            }
            const ordinal = typeof turn.ordinal === 'number' ? turn.ordinal : fallbackOrdinal;
            fallbackOrdinal = Math.max(fallbackOrdinal + 1, ordinal + 1);
            const produced = chunkTurn({
                sourceBacId: payload.bac_id,
                threadId,
                turnOrdinal: ordinal,
                capturedAt: turn.capturedAt ?? payload.capturedAt,
                text: turn.text,
                ...(turn.markdown === undefined ? {} : { markdown: turn.markdown }),
                ...(turn.formattedText === undefined ? {} : { formattedText: turn.formattedText }),
                ...(turn.role === undefined ? {} : { role: turn.role }),
                ...(turn.modelName === undefined ? {} : { modelName: turn.modelName }),
                ...(payload.provider === undefined ? {} : { provider: payload.provider }),
                ...(payload.threadUrl === undefined ? {} : { threadUrl: payload.threadUrl }),
                ...(payload.title === undefined ? {} : { title: payload.title }),
            });
            for (const chunk of produced)
                chunks.push({ chunk, event });
        }
    }
    // Embed in batches, then upsert. Once the upsert succeeds the
    // ingest state moves forward; a kill-9 between batches loses at
    // most one batch of progress but the chunks are deterministic so
    // a re-run produces the same entries.
    let indexedCount = 0;
    for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
        const batch = chunks.slice(offset, offset + EMBED_BATCH);
        const vectors = await embed(batch.map(({ chunk }) => chunk.embedText.slice(0, EMBED_TEXT_CHARS)));
        const entries = [];
        for (let i = 0; i < batch.length; i += 1) {
            const item = batch[i];
            const embedding = vectors[i];
            if (item === undefined || embedding === undefined)
                continue;
            const { chunk, event } = item;
            entries.push({
                id: chunk.chunkId,
                threadId: chunk.threadId,
                capturedAt: chunk.capturedAt,
                embedding,
                replicaId: event.dot.replicaId,
                lamport: event.dot.seq,
                tombstoned: tombstonedThreads.has(chunk.threadId),
                metadata: metadataFromChunk(chunk),
            });
        }
        await upsertEntries(indexPath(vaultRoot), entries, RECALL_MODEL_ID, {
            modelRevision: RECALL_MODEL.revision,
        });
        indexedCount += entries.length;
    }
    // Apply fresh tombstones to EXISTING index entries — not just
    // the chunks we just produced. A tombstone that arrives after the
    // capture it targets must still flip the older entries on disk
    // before the ingest frontier advances; without this, peer-driven
    // tombstones get silently consumed.
    //
    // We only sweep `freshTombstones` here (not the full
    // tombstonedThreads set). Older tombstones already swept in
    // prior passes; re-sweeping is harmless but wasteful.
    let tombstonedEntries = 0;
    for (const threadId of freshTombstones) {
        const result = await tombstoneByThread(indexPath(vaultRoot), threadId);
        tombstonedEntries += result.tombstoned;
    }
    // Compute the new high-water marks per replica from the merged
    // log (NOT just `fresh`) so we capture every event we observed,
    // not just the ones we emitted entries for.
    const nextProcessed = { ...state.processedEvents };
    for (const event of merged) {
        const prev = nextProcessed[event.dot.replicaId] ?? 0;
        if (event.dot.seq > prev)
            nextProcessed[event.dot.replicaId] = event.dot.seq;
    }
    await writeIngestState(vaultRoot, {
        processedEvents: nextProcessed,
        lastIncrementalIngestAt: new Date().toISOString(),
        ...(state.lastFullRebuildAt === undefined
            ? {}
            : { lastFullRebuildAt: state.lastFullRebuildAt }),
    });
    await writeRecallManifest(vaultRoot);
    return {
        indexedChunks: indexedCount,
        tombstonedChunks: freshTombstones.size,
        tombstonedEntries,
        processedEvents: nextProcessed,
    };
};
export const recallStateExists = async (vaultRoot) => {
    try {
        await stat(ingestStatePath(vaultRoot));
        return true;
    }
    catch {
        return false;
    }
};
//# sourceMappingURL=ingestor.js.map