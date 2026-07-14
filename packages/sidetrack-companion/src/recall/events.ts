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
  /**
   * Point-in-time served feature vector (Move 1). A plain number array
   * aligned to the ranker's canonical feature-key order
   * (CANDIDATE_PAIR_FEATURE_KEYS in ranker/feature-schema.ts) at the
   * moment the impression was served — the AS-OF truth the trainer would
   * otherwise re-derive against a drifted graph. Encoded via
   * ranker/servedFeatureVector.ts; decode with the matching helper.
   * Absent when no warm FeatureModel was available to compute it at serve
   * time (the trainer then falls back to reconstruction).
   */
  readonly features?: readonly number[];
  /**
   * Schema version of `features` — mirrors FEATURE_SCHEMA_VERSION at
   * serve time. The trainer only trusts `features` when this equals the
   * current schema version; a mismatch (schema drifted since serve) falls
   * back to reconstruction so columns never silently misalign.
   */
  readonly featureSchemaVersion?: number;
  /**
   * Query-anchored cosine SIMILARITY (not distance) for the dense
   * (semantic_query) lane, threaded from the request-time computation
   * (1 − vectorDistance). The single most-relevant discarded signal.
   * Absent when the request had no dense lane / this candidate did not
   * surface from semantic_query.
   */
  readonly queryCosine?: number;
  /**
   * Propensity logging (north-star §5 S1, pattern P12). The probability
   * that THIS candidate landed at THIS `servedPosition` under the serving
   * policy in force at serve time.
   *
   * INVARIANT (as of payloadVersion 2): the recall serving pipeline is
   * fully DETERMINISTIC — every ordering site (RRF fusion, lexical
   * tie-break, cross-encoder rerank, learned rerank) sorts by score with a
   * stable id / position tie-break and NO randomness (no Math.random, no
   * shuffle, no ε-greedy / Thompson exploration in the /v2 path). So the
   * served ordering is a deterministic function of the logged candidates
   * and this value is stamped 1.0 for every served candidate today.
   *
   * When exploration / stochastic tie-breaking / interleaving (S2+) is
   * introduced, that code MUST set this to the actual selection
   * probability at serve time — it is UNRECOVERABLE later (P12). Off-policy
   * / prequential eval divides by this to de-bias the logged position
   * prior; a wrong or missing value silently re-learns the UI's ranking as
   * ground truth. Absent on legacy (v1) rows: readers treat absent as 1.0
   * (deterministic serving is the historical truth for those rows too).
   */
  readonly propensity?: number;
}

/**
 * Impression-level serving-config fingerprint (north-star §5 S1). The set
 * of arms / flags in force when this impression was served, so replay and
 * interleaving can attribute an outcome to the ARM that produced it rather
 * than to the current process env (which drifts). Every field is a boolean
 * or a small identifier read at serve time; all optional so a fingerprint
 * can grow new arms without a schema bump (a missing field = "not recorded
 * / arm did not exist at serve time", never "off").
 *
 * FREEZE-SAFE: this is a passive record of what was active — it does not
 * change any serving decision.
 */
export interface ServingConfigFingerprint {
  /** SIDETRACK_RECALL_CHUNK_VECTORS — chunk-vector / max-chunk pooling arm. */
  readonly chunkVectors?: boolean;
  /** SIDETRACK_RECALL_PROVENANCE_DOWNWEIGHT — title-only KNN down-weight arm. */
  readonly provenanceDownweight?: boolean;
  /** SIDETRACK_RECALL_LEARNED_RERANK — learned (closest-visit) rerank arm. */
  readonly learnedRerank?: boolean;
  /** Whether the cross-encoder rerank actually fired on this response. */
  readonly crossEncoderRerank?: boolean;
  /** Free-form arm/experiment identifier when an eval harness pins one. */
  readonly armId?: string;
}

const isBooleanOrUndefined = (value: unknown): boolean =>
  value === undefined || typeof value === 'boolean';

export const isServingConfigFingerprint = (
  value: unknown,
): value is ServingConfigFingerprint => {
  if (!isRecord(value)) return false;
  if (!isBooleanOrUndefined(value['chunkVectors'])) return false;
  if (!isBooleanOrUndefined(value['provenanceDownweight'])) return false;
  if (!isBooleanOrUndefined(value['learnedRerank'])) return false;
  if (!isBooleanOrUndefined(value['crossEncoderRerank'])) return false;
  if (value['armId'] !== undefined && typeof value['armId'] !== 'string') return false;
  return true;
};

export interface RecallServedPayload {
  /**
   * Impression schema version. v1 = the original impression (PR #242
   * feature-vector capture). v2 (north-star §5 S1) adds per-candidate
   * `propensity`, the explicit `surface` discriminator, and the
   * impression-level `servingConfig` fingerprint. All v2 additions are
   * optional so v1 rows still parse; readers treat this union, never a
   * strict equality against the latest.
   */
  readonly payloadVersion: 1 | 2;
  /** Stable impression identity — joins served × action records. */
  readonly servedContextId: string;
  /** The query text as submitted. */
  readonly query: string;
  /** Recall intent (dejavu / search / focus). */
  readonly intent: string;
  /**
   * Explicit surface discriminator (north-star §5 S1). Per-surface
   * calibration and interleaving key on this. Today it MIRRORS `intent`
   * (dejavu / search / focus are the served surfaces), but it is a
   * separate field so the surface taxonomy can diverge from intent (e.g.
   * a related-pages strip vs a search box on the same intent) without a
   * schema break. Absent on legacy (v1) rows: readers fall back to
   * `intent`.
   */
  readonly surface?: string;
  /**
   * Serving-config fingerprint (arms/flags active at serve time). Absent
   * on legacy (v1) rows and on v2 rows served before any arm was recorded.
   */
  readonly servingConfig?: ServingConfigFingerprint;
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
  // Move 1 optional fields — validated only when present so legacy rows
  // (no features/cosine) still pass. A malformed features array or a
  // non-numeric schema version invalidates the row rather than being
  // silently ignored.
  if (
    value['features'] !== undefined &&
    (!Array.isArray(value['features']) ||
      !value['features'].every((entry) => typeof entry === 'number'))
  ) {
    return false;
  }
  if (
    value['featureSchemaVersion'] !== undefined &&
    typeof value['featureSchemaVersion'] !== 'number'
  ) {
    return false;
  }
  if (value['queryCosine'] !== undefined && typeof value['queryCosine'] !== 'number') return false;
  // S1 optional field — validated only when present so v1 rows (no
  // propensity) still parse. A propensity is a probability in (0, 1]; a
  // non-numeric, non-finite, or non-positive value invalidates the row so
  // an off-policy reader can never divide by a bad denominator (weight =
  // 1 / propensity). Zero/negative would be a serving-code bug, not data.
  if (value['propensity'] !== undefined) {
    const p = value['propensity'];
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p > 1) return false;
  }
  return true;
};

export const isRecallServedPayload = (value: unknown): value is RecallServedPayload => {
  if (!isRecord(value)) return false;
  // Accept the v1 | v2 union — a v2 reader must still parse v1 rows written
  // before the S1 propensity/surface/servingConfig fields existed.
  if (value['payloadVersion'] !== 1 && value['payloadVersion'] !== 2) return false;
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
  // S1 optional fields — validated only when present (absent on v1 rows).
  // A present surface must be a NON-EMPTY string: an empty surface would
  // become a degenerate per-surface bucket key downstream (surfaceOf falls
  // back to intent only when the field is ABSENT, not when it is "").
  if (
    value['surface'] !== undefined &&
    (typeof value['surface'] !== 'string' || value['surface'].length === 0)
  ) {
    return false;
  }
  if (value['servingConfig'] !== undefined && !isServingConfigFingerprint(value['servingConfig'])) {
    return false;
  }
  return true;
};

/**
 * Effective surface for an impression: the explicit S1 `surface` field
 * when present, else the historical `intent` fallback (v1 rows and v2 rows
 * whose surface tracks intent). One place so every reader — calibration,
 * credit assignment, health — resolves surface identically.
 */
export const surfaceOf = (payload: RecallServedPayload): string =>
  payload.surface ?? payload.intent;

/**
 * Effective propensity for a served candidate: the explicit S1
 * `propensity` field when present, else 1.0 (deterministic serving is the
 * historical truth for v1 rows, and remains the invariant today). One
 * place so off-policy readers never divide by an implicit/missing value.
 */
export const propensityOf = (candidate: RecallServedCandidateSnapshot): number =>
  candidate.propensity ?? 1;

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
