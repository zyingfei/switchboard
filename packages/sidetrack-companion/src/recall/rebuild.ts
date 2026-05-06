import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EventLog } from '../sync/eventLog.js';
import { chunkTurn, type RecallChunk } from './chunker.js';
import { embed, MODEL_ID } from './embedder.js';
import { upsertEntries } from './indexFile.js';
import { collectLogBacIds, projectRecallFromLog } from './projection.js';
import type { ChunkMetadata, IndexEntry } from './ranker.js';

const isCaptureEventRecord = (
  value: unknown,
): value is {
  readonly bac_id?: string;
  readonly threadId?: string;
  readonly threadUrl?: string;
  readonly capturedAt?: string;
  readonly turns: readonly {
    readonly ordinal?: number;
    readonly text?: string;
    readonly capturedAt?: string;
  }[];
} =>
  typeof value === 'object' &&
  value !== null &&
  'turns' in value &&
  Array.isArray((value as { readonly turns?: unknown }).turns);

const eventFiles = async (eventLogPath: string): Promise<readonly string[]> => {
  if (eventLogPath.endsWith('.jsonl')) {
    return [eventLogPath];
  }
  const names = await readdir(eventLogPath).catch(() => []);
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(eventLogPath, name));
};

// Cap the number of texts per embedder call. The embedder allocates
// a tensor of shape [batchSize, dim, …] plus per-token activations,
// so a single 500-item batch peaks well past 1GB on a base-MiniLM
// pipeline and macOS will SIGKILL the process. 16 keeps peak under
// ~250MB on this model and still amortizes the per-call overhead.
const EMBED_BATCH_SIZE = 16;

// Tighter cap when called with explicit `EMBED_TEXT_CHARS` to keep
// individual turns from blowing up the per-batch tensor (a single
// 50KB turn becomes ~12K tokens). The model's max sequence length
// is 256, so anything past ~1500 chars gets truncated anyway —
// trimming up front saves the tokenizer + tensor cost.
const EMBED_TEXT_CHARS = 4000;

export interface RebuildOptions {
  // Optional progress callback so callers (e.g. RecallLifecycle)
  // can surface "embedded N of M" while a rebuild is in flight.
  // Fired after each batch completes, before the inter-batch yield.
  readonly onProgress?: (embedded: number, total: number) => void;
  // Optional event log. When provided, the rebuild reads
  // `capture.recorded` and `recall.tombstone.target` events from
  // the per-replica log and merges them with the legacy `_BAC/events/`
  // capture data. Captures are deduped by `bac_id`: when both sources
  // hold the same capture, the log version (which carries
  // `replicaId`/`lamport`) wins.
  readonly eventLog?: EventLog;
}

interface RawCaptureItem {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly text: string;
  readonly replicaId?: string;
  readonly lamport?: number;
  readonly tombstoned?: boolean;
  readonly sourceBacId?: string;
  readonly turnOrdinal?: number;
  readonly markdown?: string;
  readonly formattedText?: string;
  readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
  readonly modelName?: string;
  readonly provider?: string;
  readonly threadUrl?: string;
  readonly title?: string;
}

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

export const rebuildFromEventLog = async (
  vaultRoot: string,
  eventLogPath: string,
  options: RebuildOptions = {},
): Promise<{ readonly indexed: number }> => {
  // 1. Read the per-replica log first so we can dedupe legacy
  //    captures whose bac_id already appears as a `capture.recorded`
  //    event.
  const logEvents = options.eventLog === undefined ? [] : await options.eventLog.readMerged();
  const fromLog = projectRecallFromLog(logEvents);
  const logBacIds = collectLogBacIds(logEvents);

  const rawItems: RawCaptureItem[] = fromLog.map((item) => ({
    id: item.id,
    threadId: item.threadId,
    capturedAt: item.capturedAt,
    text: item.text,
    replicaId: item.replicaId,
    lamport: item.lamport,
    tombstoned: item.tombstoned,
    sourceBacId: item.sourceBacId,
    turnOrdinal: item.turnOrdinal,
    ...(item.markdown === undefined ? {} : { markdown: item.markdown }),
    ...(item.formattedText === undefined ? {} : { formattedText: item.formattedText }),
    ...(item.role === undefined ? {} : { role: item.role }),
    ...(item.modelName === undefined ? {} : { modelName: item.modelName }),
    ...(item.provider === undefined ? {} : { provider: item.provider }),
    ...(item.threadUrl === undefined ? {} : { threadUrl: item.threadUrl }),
    ...(item.title === undefined ? {} : { title: item.title }),
  }));

  // 2. Walk the legacy `_BAC/events/` log. Skip captures whose
  //    bac_id already appears in the per-replica log.
  for (const file of await eventFiles(eventLogPath)) {
    const raw = await readFile(file, 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isCaptureEventRecord(parsed)) continue;
        const threadId = parsed.bac_id ?? parsed.threadId ?? parsed.threadUrl;
        if (threadId === undefined || parsed.capturedAt === undefined) continue;
        if (parsed.bac_id !== undefined && logBacIds.has(parsed.bac_id)) continue;
        for (const turn of parsed.turns) {
          if (typeof turn.text !== 'string' || turn.text.trim().length === 0) continue;
          const turnRecord = turn as RawCaptureItem & {
            readonly text: string;
            readonly markdown?: string;
            readonly formattedText?: string;
          };
          const ordinal = turn.ordinal ?? rawItems.length;
          rawItems.push({
            id: `${threadId}:${String(ordinal)}`,
            threadId,
            capturedAt: turn.capturedAt ?? parsed.capturedAt,
            text: turn.text,
            ...(parsed.bac_id === undefined ? {} : { sourceBacId: parsed.bac_id }),
            turnOrdinal: ordinal,
            ...(turnRecord.markdown === undefined ? {} : { markdown: turnRecord.markdown }),
            ...(turnRecord.formattedText === undefined
              ? {}
              : { formattedText: turnRecord.formattedText }),
            ...(turnRecord.role === undefined ? {} : { role: turnRecord.role }),
            ...(turnRecord.modelName === undefined ? {} : { modelName: turnRecord.modelName }),
            ...(parsed.threadUrl === undefined ? {} : { threadUrl: parsed.threadUrl }),
          });
        }
      } catch {
        // Ignore malformed event-log lines; the source of truth remains append-only.
      }
    }
  }

  // Chunk every captured turn before embedding. The chunker preserves
  // heading + code-fence structure and produces deterministic
  // chunkIds, so a rebuild from the same merged log emits byte-equal
  // index files (PR #93's deterministic-build invariant).
  const chunks: { readonly chunk: RecallChunk; readonly raw: RawCaptureItem }[] = [];
  for (const raw of rawItems) {
    const sourceBacId = raw.sourceBacId ?? raw.threadId;
    const produced = chunkTurn({
      sourceBacId,
      threadId: raw.threadId,
      turnOrdinal: raw.turnOrdinal ?? 0,
      capturedAt: raw.capturedAt,
      text: raw.text,
      ...(raw.markdown === undefined ? {} : { markdown: raw.markdown }),
      ...(raw.formattedText === undefined ? {} : { formattedText: raw.formattedText }),
      ...(raw.role === undefined ? {} : { role: raw.role }),
      ...(raw.modelName === undefined ? {} : { modelName: raw.modelName }),
      ...(raw.provider === undefined ? {} : { provider: raw.provider }),
      ...(raw.threadUrl === undefined ? {} : { threadUrl: raw.threadUrl }),
      ...(raw.title === undefined ? {} : { title: raw.title }),
    });
    for (const chunk of produced) {
      chunks.push({ chunk, raw });
    }
  }

  const total = chunks.length;
  const entries: IndexEntry[] = [];
  for (let offset = 0; offset < total; offset += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
    const vectors = await embed(batch.map(({ chunk }) => chunk.embedText.slice(0, EMBED_TEXT_CHARS)));
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const embedding = vectors[index];
      if (item === undefined || embedding === undefined) continue;
      const { chunk, raw } = item;
      entries.push({
        id: chunk.chunkId,
        threadId: chunk.threadId,
        capturedAt: chunk.capturedAt,
        embedding,
        ...(raw.replicaId === undefined ? {} : { replicaId: raw.replicaId }),
        ...(raw.lamport === undefined ? {} : { lamport: raw.lamport }),
        ...(raw.tombstoned === undefined ? {} : { tombstoned: raw.tombstoned }),
        metadata: metadataFromChunk(chunk),
      });
    }
    options.onProgress?.(entries.length, total);
    // Yield to the event loop so the HTTP server can respond to
    // /v1/system/health (and any other request) between batches.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  await upsertEntries(join(vaultRoot, '_BAC', 'recall', 'index.bin'), entries, MODEL_ID);
  return { indexed: entries.length };
};
