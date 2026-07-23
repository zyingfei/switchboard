// Served-signal floor guard for the visit-similarity revision.
//
// Root cause this guards against (see the flapping investigation): on a
// warm delta-only drain the similarity corpus is assembled from the
// drain's event WINDOW only, so a window carrying no gate-eligible
// visits produces an EMPTY eligible corpus. That empty corpus forces a
// full HNSW rebuild whose empty-branch resets the index and returns
// `edges: []`, and that empty revision is then published — wiping all
// ~51k `visit_resembles_visit` edges from the served snapshot. The next
// drain whose window carries the eligible visits recomputes ~51k. The
// served signal flaps between full and empty on a coin flip.
//
// First-principles requirement B: a drain must not publish a similarity
// revision whose edge count collapses by more than 90% relative to the
// previously served revision UNLESS an explicit, recorded reset reason
// applies. On violation: carry the previous revision forward, mark the
// drain diagnostic with the suppressed-collapse reason, and surface a
// non-ok counter in /v1/system/health.
//
// This module is pure (no I/O, no process env, no clock): the
// materializer feeds it the just-built revision + the previously served
// edge count + which legitimate reset signals fired, and it returns the
// decision. That keeps the invariant unit-testable in isolation.

import type { VisitSimilarityEdge, VisitSimilarityRevision } from './types.js';

// Fraction of the previously served edge count below which a collapse is
// considered a floor violation. 0.10 ⇒ dropping below 10% of the prior
// served edges (a >90% collapse) trips the guard. Chosen to match
// requirement B ("collapse by more than 90%").
export const SIMILARITY_FLOOR_MIN_RETAINED_FRACTION = 0.1;

// Explicit operator override — publish a collapsed revision even with no
// natural reset signal (a deliberate full rebuild). Set to '1' to allow.
export const SIMILARITY_FLOOR_OPERATOR_REBUILD_ENV =
  'SIDETRACK_SIMILARITY_FORCE_REBUILD';

export const similarityFloorOperatorRebuildRequested = (): boolean =>
  process.env[SIMILARITY_FLOOR_OPERATOR_REBUILD_ENV] === '1';

// The allow-list of reset reasons under which a collapse (even to zero)
// is legitimate and MUST be published rather than suppressed. Each maps
// to a detectable signal the materializer already computes at the
// publish seam.
export type SimilarityFloorResetReason =
  | 'embedding-model-change' // Embedding model/revision changed → the old edges are in the wrong vector space.
  | 'materializer-version-bump' // MATERIALIZER_VERSION changed → full rebuild is intended.
  | 'store-corruption-recovery' // HNSW store recovered from corruption → rebuild is intended.
  | 'privacy-purge' // A tombstone/purge removed the visits → the empties are real.
  | 'operator-rebuild' // An explicit operator-forced rebuild.
  | 'sustained-collapse-accepted' // Bounded recovery: the low count has been rebuilt for N drains → it IS the truth.
  | 'no-previous-signal'; // No previously served edges → nothing to protect.

export interface SimilarityFloorGuardInput {
  // The revision the drain just built and is about to publish.
  readonly candidate: VisitSimilarityRevision;
  // Edge count of the revision currently served (reconstructed from the
  // previously served snapshot's `visit_resembles_visit` edges). null when
  // there is no previously served snapshot (cold boot).
  readonly previousServedEdgeCount: number | null;
  // The set of legitimate reset signals that fired this drain. When any
  // is present the collapse is allowed through.
  readonly resetReasons: readonly SimilarityFloorResetReason[];
  // Bounded-recovery escape (blocker fix): true when this same low-count
  // band has been suppressed for N consecutive drains, so a real deletion
  // (a sustained shift, not a flap) is accepted as the new truth instead
  // of being pinned to the old high revision forever. Distinct from
  // `resetReasons` because it is derived from durable cross-drain state,
  // not from a signal in this drain's window.
  readonly sustainedCollapseReached?: boolean;
}

export type SimilarityFloorGuardOutcome =
  // No collapse (or a legitimate reset) — publish the candidate as-is.
  | {
      readonly action: 'publish';
      // When a collapse WAS observed but a reset reason permitted it, the
      // reason is recorded here for the diagnostic (else null).
      readonly allowedResetReason: SimilarityFloorResetReason | null;
      readonly previousServedEdgeCount: number | null;
      readonly candidateEdgeCount: number;
    }
  // A >90% collapse with no legitimate reset — carry the previous
  // revision forward instead of publishing the collapsed candidate.
  | {
      readonly action: 'carry-forward';
      readonly previousServedEdgeCount: number;
      readonly candidateEdgeCount: number;
      // The floor the candidate had to clear to publish
      // (previousServedEdgeCount * SIMILARITY_FLOOR_MIN_RETAINED_FRACTION).
      readonly requiredEdgeFloor: number;
    };

const isCollapse = (
  candidateEdgeCount: number,
  previousServedEdgeCount: number,
): boolean =>
  previousServedEdgeCount > 0 &&
  candidateEdgeCount < previousServedEdgeCount * SIMILARITY_FLOOR_MIN_RETAINED_FRACTION;

// Pure decision. Given the just-built revision, the previously served
// edge count, and which legitimate reset signals fired, decide whether
// to publish the candidate or carry the previous revision forward.
export const decideSimilarityFloorGuard = (
  input: SimilarityFloorGuardInput,
): SimilarityFloorGuardOutcome => {
  const candidateEdgeCount = input.candidate.edges.length;
  const { previousServedEdgeCount } = input;
  // No prior served signal to protect → always publish (this also covers
  // cold boot where the whole graph is being built for the first time).
  if (previousServedEdgeCount === null || previousServedEdgeCount <= 0) {
    return {
      action: 'publish',
      allowedResetReason: null,
      previousServedEdgeCount,
      candidateEdgeCount,
    };
  }
  if (!isCollapse(candidateEdgeCount, previousServedEdgeCount)) {
    return {
      action: 'publish',
      allowedResetReason: null,
      previousServedEdgeCount,
      candidateEdgeCount,
    };
  }
  // A collapse WAS observed. Publish only if a legitimate reset reason
  // fired; otherwise carry forward. `no-previous-signal` is handled above,
  // so any of the substantive reasons permits the collapse.
  const allowedResetReason = input.resetReasons.find(
    (reason) => reason !== 'no-previous-signal',
  );
  if (allowedResetReason !== undefined) {
    return {
      action: 'publish',
      allowedResetReason,
      previousServedEdgeCount,
      candidateEdgeCount,
    };
  }
  // Bounded-recovery escape: the same low count has been rebuilt for N
  // consecutive drains. A flap alternates high/empty (the run resets on
  // each clean drain), so reaching the threshold means this is a genuine
  // SUSTAINED shift (a real deletion / legitimate corpus shrink). Accept
  // the new lower revision as the truth rather than pinning the old high
  // revision forever.
  if (input.sustainedCollapseReached === true) {
    return {
      action: 'publish',
      allowedResetReason: 'sustained-collapse-accepted',
      previousServedEdgeCount,
      candidateEdgeCount,
    };
  }
  return {
    action: 'carry-forward',
    previousServedEdgeCount,
    candidateEdgeCount,
    requiredEdgeFloor: Math.ceil(
      previousServedEdgeCount * SIMILARITY_FLOOR_MIN_RETAINED_FRACTION,
    ),
  };
};

// Per-drain diagnostic surfaced in the materializer diagnostics artifact
// (and read by /v1/system/health). Present on every drain that produced a
// similarity revision so the health surface can distinguish "clean" from
// "suppressed a collapse".
export interface SimilarityFloorDiagnostics {
  // The revision id actually published this drain (post-guard). When a
  // collapse was suppressed this is the carried-forward id, NOT the
  // degenerate empty id.
  readonly servedRevisionId: string;
  // The revision id the builder produced before the guard ran. Differs
  // from servedRevisionId iff the guard suppressed a collapse.
  readonly builtRevisionId: string;
  readonly previousServedEdgeCount: number | null;
  readonly builtEdgeCount: number;
  readonly servedEdgeCount: number;
  // True iff the guard suppressed a >90% collapse and carried forward.
  readonly suppressedCollapse: boolean;
  // When a collapse was observed but permitted, the reset reason; else
  // null. (Only meaningful when suppressedCollapse is false.)
  readonly allowedResetReason: SimilarityFloorResetReason | null;
  // Lifetime running count of suppressed collapses, read from the DURABLE
  // cross-drain floor state (survives the child-per-drain fork). This is a
  // METRIC, not a health status driver — a permanently-incrementing count
  // would pin /v1/system/health `degraded` forever (alarm fatigue).
  readonly suppressedCollapseCount: number;
  // Whether the guard is CURRENTLY flapping: a suppression happened
  // recently and the graph has not yet shown a short run of clean drains.
  // The health surface drives its status from THIS (current state) instead
  // of the lifetime count, so a fully-recovered system returns to ok.
  readonly flapping: boolean;
}

// Reconstruct a full VisitSimilarityRevision from the previously served
// snapshot's `visit_resembles_visit` edges, so a carry-forward is
// self-contained (survives a restart / a missing on-disk revision file).
// The materializer owns the snapshot→edge decode helpers, so it passes
// the already-decoded edges in; this keeps the module free of snapshot
// node-id parsing.
export const carryForwardRevision = (
  previous: {
    readonly revisionId: string;
    readonly modelId: VisitSimilarityRevision['modelId'];
    readonly modelRevision: string;
    readonly featureSchemaVersion: number;
    readonly threshold: number;
    readonly producer?: VisitSimilarityRevision['producer'];
  },
  edges: readonly VisitSimilarityEdge[],
  producedAt: number,
): VisitSimilarityRevision => ({
  revisionId: previous.revisionId,
  modelId: previous.modelId,
  modelRevision: previous.modelRevision,
  featureSchemaVersion: previous.featureSchemaVersion,
  threshold: previous.threshold,
  edges,
  producedAt,
  ...(previous.producer === undefined ? {} : { producer: previous.producer }),
});
