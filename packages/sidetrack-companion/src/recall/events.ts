// Recall log-event types. The recall index is now a projection of
// these events from the per-replica log:
//
//   capture.recorded         — one per accepted /v1/events POST
//   recall.tombstone.target  — one per archive (or future hard-delete)
//   recall.served            — one per /v2/recall response (impression)
//   recall.action            — one per user action on a served candidate
//
// All four events carry an aggregateId so projection readers can
// filter by aggregate. capture.recorded / recall.tombstone use
// threadId; recall.served / recall.action use servedContextId (the
// impression identity) so the group-level ranker trainer can join
// served × action by impression. All round-trip through the causal
// foundation (dot, deps, idempotent on clientEventId).

export const CAPTURE_RECORDED = 'capture.recorded' as const;
export const RECALL_TOMBSTONE_TARGET = 'recall.tombstone.target' as const;
export const RECALL_SERVED = 'recall.served' as const;
export const RECALL_ACTION = 'recall.action' as const;

export type RecallEventType =
  | typeof CAPTURE_RECORDED
  | typeof RECALL_TOMBSTONE_TARGET
  | typeof RECALL_SERVED
  | typeof RECALL_ACTION;

export interface CaptureTurnInputShape {
  readonly ordinal?: number;
  readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
  readonly text: string;
  readonly capturedAt?: string;
  // Recall V3: optional richer rendering fields. The chunker prefers
  // markdown → formattedText → text; these flow through unchanged
  // when the capture event carried them.
  readonly markdown?: string;
  readonly formattedText?: string;
  readonly modelName?: string;
}

export interface CaptureRecordedPayload {
  readonly bac_id: string;
  readonly threadId?: string;
  readonly threadUrl?: string;
  readonly provider?: string;
  readonly title?: string;
  readonly capturedAt: string;
  readonly turns: readonly CaptureTurnInputShape[];
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

export interface RecallTombstonePayload {
  readonly threadId: string;
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasValidPayloadExtensionFields = (value: Record<string, unknown>): boolean =>
  (value['payloadVersion'] === undefined ||
    (typeof value['payloadVersion'] === 'number' && value['payloadVersion'] >= 1)) &&
  (value['dimensions'] === undefined || isRecord(value['dimensions']));

export const isCaptureRecordedPayload = (value: unknown): value is CaptureRecordedPayload => {
  if (!isRecord(value)) return false;
  const v = value;
  if (typeof v['bac_id'] !== 'string') return false;
  if (typeof v['capturedAt'] !== 'string') return false;
  if (!Array.isArray(v['turns'])) return false;
  return hasValidPayloadExtensionFields(v);
};

export const isRecallTombstonePayload = (value: unknown): value is RecallTombstonePayload => {
  if (!isRecord(value)) return false;
  return typeof value['threadId'] === 'string' && hasValidPayloadExtensionFields(value);
};

// Recall v2 — impression logging (Phase 0 of the hard-replacement plan).
//
// The group-level ranker trainer (Phase 3) reads recall.served events
// to reconstruct what was shown to the user, and recall.action events
// to learn which candidates the user actually engaged with. The pair
// is joined by servedContextId.
//
// recall.served is server-observed (the companion writes it when it
// responds to /v2/recall). recall.action is client-observed (the
// extension POSTs to /v1/recall/action when the user clicks /
// open-new-tab / acts on a served candidate; the companion appends
// it through appendClientObserved). The companion's existing
// feedback events (user.organized.item / user.flow.confirmed / etc.)
// stay independent — recall.action is a parallel record that ties
// those actions to a specific impression.

/** One row of a served impression's results, as recorded for training. */
export interface RecallServedCandidateSnapshot {
  /** Stable dedupe key — usually canonical-URL hash or thread id. */
  readonly entityId: string;
  /** Primary source kind from the /v2 candidate generators. */
  readonly sourceKind: string;
  /** Per-source ranks (1-based) per RecallSourceKind that contributed. */
  readonly perLaneRanks?: Readonly<Record<string, number>>;
  /** Per-source raw scores per RecallSourceKind that contributed. */
  readonly perLaneScores?: Readonly<Record<string, number>>;
  /** Final fused RRF (or weighted) score. */
  readonly fusedScore: number;
  /** Cross-encoder rerank score when rerank ran on this candidate. */
  readonly rerankScore?: number;
  /** Rank within the final response (0-based). */
  readonly servedPosition: number;
  readonly canonicalUrl?: string;
}

export interface RecallServedPayload {
  readonly payloadVersion: 1;
  /** Stable impression identity — joins served × action records. */
  readonly servedContextId: string;
  /** The query text as submitted. */
  readonly query: string;
  /** Recall intent (dejavu / search / focus). */
  readonly intent: string;
  /** Session context the request carried — currentUrl, activeChatBacIds, etc. */
  readonly sessionContext?: Readonly<Record<string, unknown>>;
  /** POST-suppression results, in the order shown to the user. */
  readonly results: readonly RecallServedCandidateSnapshot[];
  /** Per-source candidate counts as fused (for candidateSourceDistribution). */
  readonly perSourceCounts?: Readonly<Record<string, number>>;
  /** Cross-encoder fired on this response? */
  readonly rerankApplied: boolean;
  /** When rerank fired, the topK that was rescored. */
  readonly rerankTopK?: number;
  /** Entity ids dropped during suppression (with reasons for audit). */
  readonly suppressedEntityIds?: readonly string[];
  /** Per-replica monotonic sequence for ordering against recall.action. */
  readonly sequenceNumber: number;
  /** ISO timestamp the response was emitted. */
  readonly servedAt: string;
}

/** Explicit action kinds — per design doc (no implicit signals). */
export const RECALL_ACTION_KINDS = [
  'click',
  'open_new_tab',
  'snippet_promote',
  'flow_confirm',
  'flow_reject',
  'move',
  'promote',
  'ignore',
  'reject',
] as const;

export type RecallActionKind = (typeof RECALL_ACTION_KINDS)[number];

export interface RecallActionPayload {
  readonly payloadVersion: 1;
  /** The impression this action targets. */
  readonly servedContextId: string;
  /** Which served candidate the user acted on. */
  readonly entityId: string;
  /** Explicit action kind. */
  readonly actionKind: RecallActionKind;
  /** ISO timestamp the action fired. */
  readonly actionAt: string;
  /** Optional reference to a parent feedback event (e.g. the
   *  user.flow.confirmed event id). Used by the trainer to dedupe
   *  when the action also lives in the feedback event log. */
  readonly referencesEventId?: string;
}

const ACTION_KIND_SET: ReadonlySet<string> = new Set<string>(RECALL_ACTION_KINDS);

export const isRecallServedCandidateSnapshot = (
  value: unknown,
): value is RecallServedCandidateSnapshot => {
  if (!isRecord(value)) return false;
  if (typeof value['entityId'] !== 'string' || value['entityId'].length === 0) return false;
  if (typeof value['sourceKind'] !== 'string' || value['sourceKind'].length === 0) return false;
  if (typeof value['fusedScore'] !== 'number') return false;
  if (typeof value['servedPosition'] !== 'number') return false;
  return true;
};

export const isRecallServedPayload = (value: unknown): value is RecallServedPayload => {
  if (!isRecord(value)) return false;
  if (value['payloadVersion'] !== 1) return false;
  if (typeof value['servedContextId'] !== 'string' || value['servedContextId'].length === 0) {
    return false;
  }
  if (typeof value['query'] !== 'string') return false;
  if (typeof value['intent'] !== 'string') return false;
  if (!Array.isArray(value['results'])) return false;
  if (!value['results'].every(isRecallServedCandidateSnapshot)) return false;
  if (typeof value['rerankApplied'] !== 'boolean') return false;
  if (typeof value['sequenceNumber'] !== 'number') return false;
  if (typeof value['servedAt'] !== 'string') return false;
  return true;
};

export const isRecallActionPayload = (value: unknown): value is RecallActionPayload => {
  if (!isRecord(value)) return false;
  if (value['payloadVersion'] !== 1) return false;
  if (typeof value['servedContextId'] !== 'string' || value['servedContextId'].length === 0) {
    return false;
  }
  if (typeof value['entityId'] !== 'string' || value['entityId'].length === 0) return false;
  if (typeof value['actionKind'] !== 'string' || !ACTION_KIND_SET.has(value['actionKind'])) {
    return false;
  }
  if (typeof value['actionAt'] !== 'string') return false;
  if (
    value['referencesEventId'] !== undefined &&
    typeof value['referencesEventId'] !== 'string'
  ) {
    return false;
  }
  return true;
};
