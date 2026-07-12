import type { ExtractionStore } from '../../recall/extraction/store.js';
import type { ExtractionRevision, ExtractionSourceState } from '../../recall/extraction/types.js';
import type { AcceptedEvent } from '../causal.js';
import { getCaughtUpSharedEventStore } from '../eventStore.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import { eventTypesForMaterializer } from './registry.js';
import {
  CAPTURE_EXTRACTION_PRODUCED,
  isCaptureExtractionProducedPayload,
} from '../../recall/extraction/events.js';
import { selectActiveRevision } from '../../recall/extraction/manifest.js';
import { wrapCaptureAsLegacyRevisions } from '../../recall/extraction/legacyExtractor.js';
import { CAPTURE_RECORDED } from '../../recall/events.js';

// Sync Contract v1 / Class E materializer.
//
// Owns extraction semantics. Two event types feed it:
//
//   capture.recorded            — wraps as a legacy extraction revision.
//   capture.extraction.produced — peer announced a fresher revision.
//
// For each event:
//   1. Build/extract the ExtractionRevision.
//   2. putRevision(...) — durable write of the revision content.
//   3. Read the source state, append the revision to history,
//      compute the active revision via the manifest policy, update
//      pointers + status.
//
// Recall is a CONSUMER of the source state via its catchUp; the
// extraction materializer does not call recall directly. That's
// the callback-independent correctness rule (gate L2-G10): a crash
// after putSourceState but before recall sees the change is
// recovered by recall's catchUp scanning extraction state on
// startup.

export interface CreateExtractionMaterializerDeps {
  readonly store: ExtractionStore;
  readonly eventLog: EventLog;
  readonly vaultRoot?: string;
}

export const createExtractionMaterializer = (
  deps: CreateExtractionMaterializerDeps,
): Materializer => {
  const handles = eventTypesForMaterializer('extraction');
  let pending = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  // Per-source serialization: read-modify-write on
  // ExtractionSourceState is racy if two events for the same
  // sourceUnitId run concurrently (one would overwrite the
  // other's history append). We chain promises per sourceUnitId
  // so updates serialize within a source while different
  // sources still run in parallel. Reviewer-flagged.
  const perSourceQueue = new Map<string, Promise<void>>();
  let inFlight = 0;
  const incInFlight = (): void => {
    inFlight += 1;
    pending = true;
  };
  const decInFlight = (): void => {
    inFlight -= 1;
    if (inFlight <= 0) pending = false;
  };
  const serializeBySource = async (
    sourceUnitId: string,
    work: () => Promise<void>,
  ): Promise<void> => {
    const prior = perSourceQueue.get(sourceUnitId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    perSourceQueue.set(sourceUnitId, next);
    try {
      await next;
    } finally {
      // Drop the queue head when this is the most recent task.
      // A later enqueue may have already replaced it; in that
      // case we leave the chain alone.
      if (perSourceQueue.get(sourceUnitId) === next) {
        perSourceQueue.delete(sourceUnitId);
      }
    }
  };

  const ingestRevision = async (revision: ExtractionRevision): Promise<void> => {
    await deps.store.putRevision(revision);
    const existing = await deps.store.readSourceState(revision.sourceUnitId);
    const history = existing?.history ?? [];
    // History entry carries the full set of fields
    // selectActiveRevision needs (schema version + producer dot).
    // Older state files may have entries without these — the
    // policy treats missing schema version as 0 (lowest
    // precedence) and missing producer dot as "tie undefined."
    const historyEntry = {
      extractionRevisionId: revision.extractionRevisionId,
      extractorId: revision.extractorId,
      extractorVersion: revision.extractorVersion,
      createdAt: revision.createdAt,
      extractionSchemaVersion: revision.extractionSchemaVersion,
      producerDot: revision.producerDot,
    };
    const dedupedHistory = history.some(
      (h) => h.extractionRevisionId === revision.extractionRevisionId,
    )
      ? history
      : [...history, historyEntry].slice(-20); // bound history to 20 entries
    // Build candidate list: every revision in history with full
    // policy inputs (schema version + producer dot). Reviewer-
    // flagged: previously this defaulted schema to 1 and dropped
    // producer dot, which made the policy's tie-break path
    // unreachable for revisions other than the one being ingested.
    const candidates = dedupedHistory.map((h) => ({
      extractionRevisionId: h.extractionRevisionId,
      extractorId: h.extractorId,
      extractorVersion: h.extractorVersion,
      extractionSchemaVersion: h.extractionSchemaVersion ?? 0,
      ...(h.producerDot === undefined ? {} : { producerDot: h.producerDot }),
    }));
    // The latest revision is the most recent in history; the policy
    // may pick an older one if it's superseded by a later
    // higher-schema entry.
    const winner = selectActiveRevision(candidates) ?? {
      extractionRevisionId: revision.extractionRevisionId,
      extractorId: revision.extractorId,
      extractorVersion: revision.extractorVersion,
      extractionSchemaVersion: revision.extractionSchemaVersion,
    };
    const indexed = existing?.indexedExtractionRevision;
    const status: 'current' | 'stale' =
      indexed === winner.extractionRevisionId ? 'current' : 'stale';
    const next: ExtractionSourceState = {
      sourceUnitId: revision.sourceUnitId,
      sourceBacId: revision.sourceBacId,
      latestExtractionRevision: winner.extractionRevisionId,
      ...(indexed === undefined ? {} : { indexedExtractionRevision: indexed }),
      status,
      history: dedupedHistory,
    };
    await deps.store.putSourceState(next);
  };

  // Process one revision under the per-source serialization
  // queue. Each ingest is read-modify-write on the source state
  // file; without serialization, two concurrent events for the
  // same sourceUnitId would race and lose history entries.
  const handleRevision = async (revision: ExtractionRevision): Promise<void> => {
    incInFlight();
    try {
      await serializeBySource(revision.sourceUnitId, async () => {
        try {
          await ingestRevision(revision);
          lastSuccessAt = new Date().toISOString();
          lastError = null;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      });
    } finally {
      decInFlight();
    }
  };

  const handleEvent = async (event: AcceptedEvent): Promise<void> => {
    if (event.type === CAPTURE_RECORDED) {
      const revisions = wrapCaptureAsLegacyRevisions(event);
      // Each turn is its own sourceUnitId so different turns of
      // the same capture serialize independently.
      await Promise.all(revisions.map((rev) => handleRevision(rev)));
    } else if (
      event.type === CAPTURE_EXTRACTION_PRODUCED &&
      isCaptureExtractionProducedPayload(event.payload)
    ) {
      const payload = event.payload;
      const revision: ExtractionRevision = {
        extractionRevisionId: payload.extractionRevisionId,
        sourceUnitId: payload.sourceUnitId,
        sourceBacId: payload.sourceBacId,
        extractorId: payload.extractorId,
        extractorVersion: payload.extractorVersion,
        extractionSchemaVersion: payload.extractionSchemaVersion,
        inputHash: payload.inputHash,
        outputHash: payload.outputHash,
        chunkerVersion: payload.chunkerVersion,
        createdAt: payload.content.capturedAt,
        producerReplicaId: event.dot.replicaId,
        producerDot: { replicaId: event.dot.replicaId, seq: event.dot.seq },
        content: payload.content,
      };
      await handleRevision(revision);
    }
  };

  const onAccepted: Materializer['onAccepted'] = (event) => {
    // Fire-and-forget at the runner level; the per-source queue
    // serializes within. inFlight tracks the outstanding work so
    // awaitIdle can wait for the queue to drain.
    void handleEvent(event);
  };

  const catchUp: Materializer['catchUp'] = async (eventLog) => {
    incInFlight();
    try {
      // Schedule every event through handleEvent → per-source
      // serialization. AWAIT all of them so catchUp resolves only
      // after the queue is drained — same AWAIT-drain rule as the
      // runner's catchUpAll. Different sourceUnitIds run in
      // parallel; same-source events serialize via the queue.
      const store =
        deps.vaultRoot === undefined ? null : await getCaughtUpSharedEventStore(deps.vaultRoot);
      if (store === null) {
        // Stream only the handled extraction types instead of
        // materialising the full ~700MB merged log at boot.
        const handled = await eventLog.streamFiltered((e) => handles.has(e.type), handles);
        await Promise.all(handled.map((e) => handleEvent(e)));
      } else {
        await store.forEachChunk(async (chunk) => {
          await Promise.all(chunk.filter((e) => handles.has(e.type)).map((e) => handleEvent(e)));
        }, 2000);
      }
      lastSuccessAt = new Date().toISOString();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      decInFlight();
    }
  };

  const awaitIdle: Materializer['awaitIdle'] = async () => {
    // Wait for in-flight work AND every per-source queue to drain.
    while (pending || perSourceQueue.size > 0) {
      // Snapshot the queues, await them all, then re-check —
      // drains scheduled while we awaited may still be pending.
      const snapshot = [...perSourceQueue.values()];
      if (snapshot.length > 0) {
        await Promise.all(snapshot.map((p) => p.catch(() => undefined)));
      } else {
        await new Promise((r) => setTimeout(r, 5));
      }
    }
  };

  const health: Materializer['health'] = (): MaterializerHealth => ({
    status: lastError !== null ? 'failed' : 'healthy',
    lastSuccessAt,
    lastError,
    pending,
  });

  return {
    name: 'extraction',
    handles,
    onAccepted,
    catchUp,
    awaitIdle,
    health,
  };
};
