import type { ExtractionStore } from '../../recall/extraction/store.js';
import type {
  ExtractionRevision,
  ExtractionSourceState,
} from '../../recall/extraction/types.js';
import type { AcceptedEvent } from '../causal.js';
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
}

export const createExtractionMaterializer = (
  deps: CreateExtractionMaterializerDeps,
): Materializer => {
  const handles = eventTypesForMaterializer('extraction');
  let pending = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;

  const ingestRevision = async (revision: ExtractionRevision): Promise<void> => {
    await deps.store.putRevision(revision);
    const existing = await deps.store.readSourceState(revision.sourceUnitId);
    const history = existing?.history ?? [];
    const historyEntry = {
      extractionRevisionId: revision.extractionRevisionId,
      extractorId: revision.extractorId,
      extractorVersion: revision.extractorVersion,
      createdAt: revision.createdAt,
    };
    const dedupedHistory = history.some(
      (h) => h.extractionRevisionId === revision.extractionRevisionId,
    )
      ? history
      : [...history, historyEntry].slice(-20); // bound history to 20 entries
    // Build candidate list: every revision in history. Each carries
    // extractor + version + schema. The active-revision policy
    // picks one.
    const candidates = dedupedHistory.map((h) => ({
      extractionRevisionId: h.extractionRevisionId,
      extractorId: h.extractorId,
      extractorVersion: h.extractorVersion,
      // History rows lack schema version + producer dot; we look
      // them up on the revision file when needed. For the policy
      // pass, schema version defaults to 1 (legacy floor); a future
      // enhancement could enrich history with these fields.
      extractionSchemaVersion: 1,
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

  const handleEvent = async (event: AcceptedEvent): Promise<void> => {
    pending = true;
    try {
      if (event.type === CAPTURE_RECORDED) {
        const revisions = wrapCaptureAsLegacyRevisions(event);
        for (const revision of revisions) {
          await ingestRevision(revision);
        }
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
        await ingestRevision(revision);
      }
      lastSuccessAt = new Date().toISOString();
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      pending = false;
    }
  };

  const onAccepted: Materializer['onAccepted'] = (event) => {
    void handleEvent(event);
  };

  const catchUp: Materializer['catchUp'] = async (eventLog) => {
    pending = true;
    try {
      const merged = await eventLog.readMerged();
      for (const event of merged) {
        if (handles.has(event.type)) {
          await handleEvent(event);
        }
      }
      lastSuccessAt = new Date().toISOString();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      pending = false;
    }
  };

  const awaitIdle: Materializer['awaitIdle'] = async () => {
    while (pending) {
      await new Promise((r) => setTimeout(r, 5));
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
