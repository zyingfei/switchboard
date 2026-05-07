import type { AcceptedEvent } from '../sync/causal.js';

import {
  CAPTURE_RECORDED,
  isCaptureRecordedPayload,
  isRecallTombstonePayload,
  RECALL_TOMBSTONE_TARGET,
} from './events.js';

// Pre-embedding inputs for the recall index, derived from the
// per-replica log. The rebuild path passes these through the
// embedder to produce IndexEntry rows; multi-replica sync stamps
// `(replicaId, lamport)` from the dot so peers' captures coexist as
// distinct entries.
//
// Recall V3 enriches each input with the source-thread + per-turn
// metadata the chunker needs to produce headingPath-aware chunks.
// All new fields are optional so legacy callers keep compiling.
export interface RecallProjectionInput {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly text: string;
  readonly replicaId: string;
  readonly lamport: number;
  readonly tombstoned: boolean;
  // The bac_id of the source capture event. Used to dedupe against
  // legacy `_BAC/events/` entries during the migration window.
  readonly sourceBacId: string;
  readonly turnOrdinal: number;
  readonly markdown?: string;
  readonly formattedText?: string;
  readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
  readonly modelName?: string;
  readonly provider?: string;
  readonly threadUrl?: string;
  readonly title?: string;
}

// Walk the merged log and emit one input per surviving turn.
//
//   - `capture.recorded` events become per-turn inputs, stamped with
//     the event's dot for replicaId/lamport.
//   - `recall.tombstone.target` events flag every input whose
//     threadId matches as tombstoned. Tombstones are monotonic —
//     once flagged, never resurrected.
//
// The output order mirrors the input order (already deterministic
// thanks to `sortAcceptedEvents` in the eventLog reader).
export const projectRecallFromLog = (
  events: readonly AcceptedEvent[],
): readonly RecallProjectionInput[] => {
  const tombstonedThreads = new Set<string>();
  for (const event of events) {
    if (event.type !== RECALL_TOMBSTONE_TARGET) continue;
    if (!isRecallTombstonePayload(event.payload)) continue;
    tombstonedThreads.add(event.payload.threadId);
  }

  const items: RecallProjectionInput[] = [];
  for (const event of events) {
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
      const capturedAt = turn.capturedAt ?? payload.capturedAt;
      items.push({
        id: `${threadId}:${String(ordinal)}`,
        threadId,
        capturedAt,
        text: turn.text,
        replicaId: event.dot.replicaId,
        lamport: event.dot.seq,
        tombstoned: tombstonedThreads.has(threadId),
        sourceBacId: payload.bac_id,
        turnOrdinal: ordinal,
        ...(turn.markdown === undefined ? {} : { markdown: turn.markdown }),
        ...(turn.formattedText === undefined ? {} : { formattedText: turn.formattedText }),
        ...(turn.role === undefined ? {} : { role: turn.role }),
        ...(turn.modelName === undefined ? {} : { modelName: turn.modelName }),
        ...(payload.provider === undefined ? {} : { provider: payload.provider }),
        ...(payload.threadUrl === undefined ? {} : { threadUrl: payload.threadUrl }),
        ...(payload.title === undefined ? {} : { title: payload.title }),
      });
    }
  }
  return items;
};

// Map of bac_id → set of (id, replicaId) tuples already produced by
// the log projection. The rebuild path consults this when scanning
// the legacy `_BAC/events/` log so a capture that's been migrated
// (or written through the new dual-write path) is not double-indexed.
export const collectLogBacIds = (events: readonly AcceptedEvent[]): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const event of events) {
    if (event.type !== CAPTURE_RECORDED) continue;
    if (!isCaptureRecordedPayload(event.payload)) continue;
    out.add(event.payload.bac_id);
  }
  return out;
};
