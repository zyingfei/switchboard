import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { chunkTurn, type RecallChunk } from './chunker.js';
import { embed } from './embedder.js';
import {
  INDEX_CHUNK_SCHEMA_VERSION,
  INDEX_VERSION,
  upsertEntries,
} from './indexFile.js';
import {
  CAPTURE_RECORDED,
  isCaptureRecordedPayload,
  isRecallTombstonePayload,
  RECALL_TOMBSTONE_TARGET,
} from './events.js';
import { RECALL_MODEL, RECALL_MODEL_ID } from './modelManifest.js';
import type { ChunkMetadata, IndexEntry } from './ranker.js';

// Recall ingestor — tails the per-replica event log and projects
// new `capture.recorded` events into chunked index entries while
// honoring `recall.tombstone.target` events. The state lives in
// _BAC/recall/ingest-state.json + manifest.json so a kill-9 mid-
// flight resumes cleanly.
//
// This is the "no-data-loss reindex" path: the event log is
// authoritative + immutable; the index is a rebuildable cache.
// Replaying any event range produces the same chunk entries because
// chunkIds are deterministic.

interface IngestState {
  readonly processedEvents: Record<string, number>;
  readonly lastIncrementalIngestAt?: string;
  readonly lastFullRebuildAt?: string;
  readonly lastError?: string;
}

interface RecallManifest {
  readonly indexVersion: number;
  readonly chunkSchemaVersion: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly embeddingDim: number;
  readonly builtAt: string;
}

const recallDir = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'recall');
const manifestPath = (vaultRoot: string): string => join(recallDir(vaultRoot), 'manifest.json');
const ingestStatePath = (vaultRoot: string): string =>
  join(recallDir(vaultRoot), 'ingest-state.json');
const indexPath = (vaultRoot: string): string => join(recallDir(vaultRoot), 'index.bin');

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
};

const readJsonOrDefault = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

export const readIngestState = (vaultRoot: string): Promise<IngestState> =>
  readJsonOrDefault<IngestState>(ingestStatePath(vaultRoot), { processedEvents: {} });

export const readRecallManifest = (vaultRoot: string): Promise<RecallManifest | null> =>
  readJsonOrDefault<RecallManifest | null>(manifestPath(vaultRoot), null);

export const writeRecallManifest = async (vaultRoot: string): Promise<void> => {
  const manifest: RecallManifest = {
    indexVersion: INDEX_VERSION,
    chunkSchemaVersion: INDEX_CHUNK_SCHEMA_VERSION,
    modelId: RECALL_MODEL.modelId,
    modelRevision: RECALL_MODEL.revision,
    embeddingDim: RECALL_MODEL.embeddingDim,
    builtAt: new Date().toISOString(),
  };
  await writeAtomic(manifestPath(vaultRoot), `${JSON.stringify(manifest, null, 2)}\n`);
};

const writeIngestState = (vaultRoot: string, state: IngestState): Promise<void> =>
  writeAtomic(ingestStatePath(vaultRoot), `${JSON.stringify(state, null, 2)}\n`);

const metadataFromChunk = (chunk: RecallChunk): ChunkMetadata => ({
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

interface IngestSummary {
  readonly indexedChunks: number;
  readonly tombstonedChunks: number;
  readonly processedEvents: Record<string, number>;
}

export const ingestIncremental = async (
  vaultRoot: string,
  eventLog: EventLog,
): Promise<IngestSummary> => {
  const state = await readIngestState(vaultRoot);
  const merged = await eventLog.readMerged();

  // Filter to events past the previous frontier per replica so a
  // long history doesn't get re-projected on every tick.
  const fresh = merged.filter((event) => {
    const lastSeq = state.processedEvents[event.dot.replicaId] ?? 0;
    return event.dot.seq > lastSeq;
  });

  // Tombstone targets first, since the latest threadId tombstone
  // applies to every chunk we produce in this same pass.
  const tombstonedThreads = new Set<string>();
  for (const event of fresh) {
    if (event.type !== RECALL_TOMBSTONE_TARGET) continue;
    if (!isRecallTombstonePayload(event.payload)) continue;
    tombstonedThreads.add(event.payload.threadId);
  }

  // Chunk every fresh capture.recorded event.
  const chunks: { readonly chunk: RecallChunk; readonly event: AcceptedEvent }[] = [];
  for (const event of fresh) {
    if (event.type !== CAPTURE_RECORDED) continue;
    if (!isCaptureRecordedPayload(event.payload)) continue;
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
      for (const chunk of produced) chunks.push({ chunk, event });
    }
  }

  // Embed in batches, then upsert. Once the upsert succeeds the
  // ingest state moves forward; a kill-9 between batches loses at
  // most one batch of progress but the chunks are deterministic so
  // a re-run produces the same entries.
  let indexedCount = 0;
  for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
    const batch = chunks.slice(offset, offset + EMBED_BATCH);
    const vectors = await embed(
      batch.map(({ chunk }) => chunk.embedText.slice(0, EMBED_TEXT_CHARS)),
    );
    const entries: IndexEntry[] = [];
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i];
      const embedding = vectors[i];
      if (item === undefined || embedding === undefined) continue;
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

  // Compute the new high-water marks per replica from the merged
  // log (NOT just `fresh`) so we capture every event we observed,
  // not just the ones we emitted entries for.
  const nextProcessed: Record<string, number> = { ...state.processedEvents };
  for (const event of merged) {
    const prev = nextProcessed[event.dot.replicaId] ?? 0;
    if (event.dot.seq > prev) nextProcessed[event.dot.replicaId] = event.dot.seq;
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
    tombstonedChunks: tombstonedThreads.size,
    processedEvents: nextProcessed,
  };
};

export const recallStateExists = async (vaultRoot: string): Promise<boolean> => {
  try {
    await stat(ingestStatePath(vaultRoot));
    return true;
  } catch {
    return false;
  }
};
