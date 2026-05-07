import type { RecallActivityTracker } from '../../recall/activity.js';
import { chunkTurn } from '../../recall/chunker.js';
import { embed } from '../../recall/embedder.js';
import type { EmbeddingCache } from '../../recall/embeddingCache.js';
import { replaceEntriesForSourceUnit } from '../../recall/indexFile.js';
import type { RecallLifecycle } from '../../recall/lifecycle.js';
import type { ExtractionStore } from '../../recall/extraction/store.js';
import { MODEL_ID } from '../../recall/embedder.js';
import { RECALL_MODEL } from '../../recall/modelManifest.js';
import type { IndexEntry } from '../../recall/ranker.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import { eventTypesForMaterializer } from './registry.js';

// Class B materializer for the recall index.
//
// Uses the dirty-bit pattern: every onAccepted call sets `dirty`. If
// no worker is in-flight, start one. The worker drains while dirty
// is true, then exits. A burst of N events scheduled while a worker
// is already running coalesces into at most one extra drain pass.
// This is the "no deadlock + bounded scheduling under burst" answer
// (gate L1-G6) — even a 100-event reconnect backlog produces exactly
// one in-flight ingest worker.
//
// Lane 2 will reshape the trigger: instead of running
// ingestIncremental over the merged log directly, the materializer
// will react to extraction-store changes via the
// `latestExtractionRevision != indexedExtractionRevision` divergence
// and call replaceEntriesForSourceUnit. For Lane 1, we keep the
// existing ingestIncremental path so the contract closes the recall
// freshness bug without waiting for Lane 2.
//
// Replay-recoverability: catchUp does the same thing as a burst of
// onAccepted events — it asks the lifecycle's ingestIncremental to
// catch up the index frontier. After a crash, the next startup's
// catchUp brings the index back in line with the event log.

export interface CreateRecallMaterializerDeps {
  readonly recallLifecycle: RecallLifecycle;
  readonly recallActivity: RecallActivityTracker;
  readonly eventLog: EventLog;
  // Lane 2: optional extraction store. When provided, the
  // materializer's catchUp scans for sources where
  // latestExtractionRevision != indexedExtractionRevision and runs
  // source-scoped replace via replaceEntriesForSourceUnit. When
  // absent, the materializer behaves as Lane 1 (replays via
  // ingestIncremental over the merged event log).
  readonly extractionStore?: ExtractionStore;
  // Index file path. Required when extractionStore is set so the
  // materializer can call replaceEntriesForSourceUnit. Defaults
  // to <vaultRoot>/_BAC/recall/index.bin in production wiring.
  readonly indexPath?: string;
  // Lane 2 / L2-G2: optional embedding cache. When provided, the
  // reconcile path checks the cache first by `embedTextHash`. If
  // the chunk text is unchanged (metadata-only extractor upgrade),
  // the cache returns the prior vector and the embedder is NOT
  // called for that chunk. When absent, behavior is unchanged.
  readonly embeddingCache?: EmbeddingCache;
}

export const createRecallMaterializer = (
  deps: CreateRecallMaterializerDeps,
): Materializer => {
  const handles = eventTypesForMaterializer('recall');

  let dirty = false;
  let running = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;

  const drain = async (): Promise<void> => {
    while (dirty) {
      dirty = false;
      try {
        await deps.recallLifecycle.ingestIncremental(deps.eventLog);
        lastSuccessAt = new Date().toISOString();
        lastError = null;
      } catch (err) {
        const code =
          err !== null && typeof err === 'object' && 'code' in err
            ? String((err as { code: unknown }).code)
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

  const requestIngest = (): void => {
    dirty = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        await drain();
      } finally {
        running = false;
      }
    })();
  };

  const onAccepted: Materializer['onAccepted'] = (event) => {
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
  const reconcileExtractionStaleSources = async (): Promise<void> => {
    const store = deps.extractionStore;
    const indexPath = deps.indexPath;
    if (store === undefined || indexPath === undefined) return;
    const stale = await store.listStaleSources();
    for (const sourceState of stale) {
      const revision = await store.readRevision(sourceState.latestExtractionRevision);
      if (revision === null) continue;
      const entries: IndexEntry[] = [];
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
        if (chunks.length === 0) continue;
        // L2-G2: cache check by embedTextHash. Chunks whose text
        // (and therefore textHash) are unchanged across a metadata-
        // only extractor upgrade hit the cache and skip the
        // embedder. Per-chunk granularity so a partial overlap
        // (e.g., one paragraph changed in a 5-paragraph turn) only
        // re-embeds the changed paragraph.
        const cacheHits: (Float32Array | null)[] = [];
        const toEmbed: { index: number; text: string; hash: string }[] = [];
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i]!;
          const cached =
            deps.embeddingCache === undefined
              ? null
              : await deps.embeddingCache.get({
                  modelId: MODEL_ID,
                  modelRevision: RECALL_MODEL.revision,
                  embedTextHash: chunk.textHash,
                });
          cacheHits.push(cached);
          if (cached === null) {
            toEmbed.push({ index: i, text: chunk.text, hash: chunk.textHash });
          }
        }
        const freshVectors =
          toEmbed.length === 0 ? [] : await embed(toEmbed.map((t) => t.text));
        const vectors: Float32Array[] = [];
        let fresh = 0;
        for (let i = 0; i < chunks.length; i += 1) {
          const cached = cacheHits[i];
          if (cached !== null && cached !== undefined) {
            vectors.push(cached);
          } else {
            const vec = freshVectors[fresh] ?? new Float32Array(384);
            vectors.push(vec);
            // Store in the cache for future reuse.
            if (deps.embeddingCache !== undefined) {
              const entry = toEmbed[fresh];
              if (entry !== undefined) {
                await deps.embeddingCache.put(
                  {
                    modelId: MODEL_ID,
                    modelRevision: RECALL_MODEL.revision,
                    embedTextHash: entry.hash,
                  },
                  vec,
                );
              }
            }
            fresh += 1;
          }
        }
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i]!;
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
      await replaceEntriesForSourceUnit(
        indexPath,
        {
          sourceUnitId: revision.sourceUnitId,
          extractionRevisionId: revision.extractionRevisionId,
          entries,
        },
        MODEL_ID,
      );
      await store.markIndexed(revision.sourceUnitId, revision.extractionRevisionId);
    }
  };

  const catchUp: Materializer['catchUp'] = async (_eventLog) => {
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
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  };

  const awaitIdle: Materializer['awaitIdle'] = async () => {
    while (running || dirty) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const health: Materializer['health'] = (): MaterializerHealth => ({
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
