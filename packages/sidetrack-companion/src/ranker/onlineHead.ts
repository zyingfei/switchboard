// P4 of the make-the-ranker-dynamic plan — wire the dormant online
// head into the per-drain materializer.
//
// Steps 5-6 (`onlineLabelLedger.ts`, `onlinePairwiseUpdate.ts`) landed
// the substrate: a causal label ledger + a pure pairwise RankNet
// weight update. They were SHADOW-ONLY — nothing read the tail, nothing
// blended the deltas into serving. This module finishes the wiring:
//
//   1. `applyOnlineHeadDrainStep` — read ONLY the drain tail
//      (`pendingEventsForDrain`, never `readMerged`), advance the
//      ledger frontier, and for each newly-observed visit↔visit label
//      apply one clamped pairwise nudge against the active batch model.
//      Persists the tiny `online-ranker-state.json`. O(new-actions);
//      a drain with no feedback events does no feature work.
//
//   2. `onlineDelta` — the clamped additive serving blend, shared by
//      the closest-visit augmentation (and, later, the /v2 stage).
//
// Guardrails baked in:
//   - Flag-gated: `onlineRankerEnabled()` (default OFF). When off the
//     materializer never reads/writes the state file — zero new I/O.
//   - baseRevisionId-gated: deltas apply only while the state was based
//     on the model that is actually serving. A batch retrain swaps the
//     active revision underneath us → `rebaseToModel` zeroes the weights
//     (the fresh model already folded in that feedback) but KEEPS the
//     ledger so applied labels are never re-applied.
//   - Tail-read only + bounded per-drain feature work, so the I/O floor
//     this plan is guarding never moves.
//
// Negative sampling: for a positive label the labeled pair should rank
// above an unrelated competitor for the same `from`; for a negative
// label the unrelated competitor should rank above the rejected pair.
// The competitor is the alphabetically-first non-positive candidate the
// serving generator produces for `from` — fully deterministic so the
// online weights are replay-stable.

import type { ConnectionsSnapshot } from '../connections/snapshot.js';
import { visitKeyFromNodeOrRaw } from '../connections/snapshot.js';
import type { ConnectionEdge } from '../connections/types.js';
import type { PageEvidenceRecord } from '../page-evidence/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { generateCandidates } from './candidates.js';
import { type CandidatePairFeatures } from './feature-schema.js';
import { extractFeatures } from './features.js';
import {
  advanceFrontier,
  EMPTY_ONLINE_RANKER_STATE,
  type OnlineRankerState,
  readOnlineRankerState,
  writeOnlineRankerState,
} from './onlineLabelLedger.js';
import { applyPairwiseUpdateFromFeatures, ONLINE_RANKER_WEIGHTS_LENGTH } from './onlinePairwiseUpdate.js';
import { logisticFeatureVector, RANKER_FEATURE_KEYS } from './train.js';
import type { Candidate } from './types.js';

const FEATURE_COUNT = RANKER_FEATURE_KEYS.length;
const DEFAULT_DELTA_CLAMP = 0.15;

export const onlineRankerEnabled = (): boolean => process.env['SIDETRACK_ONLINE_RANKER'] === '1';

// Resolve the serve-blend clamp once per drain (env-overridable). The
// serving wrapper captures this so it isn't re-read on every predict.
export const onlineDeltaClamp = (): number => {
  const raw = Number(process.env['SIDETRACK_ONLINE_RANKER_DELTA_CLAMP']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DELTA_CLAMP;
};

// Clamped additive online score delta over the normalized feature
// vector, excluding the bias slot (`weights[0]`). Pure; the serve
// surfaces add this to the batch model's score. Returns 0 on any
// dimension mismatch so a schema drift can never scribble a score.
export const onlineDelta = (
  features: CandidatePairFeatures,
  weights: readonly number[],
  clamp: number = onlineDeltaClamp(),
): number => {
  if (weights.length !== ONLINE_RANKER_WEIGHTS_LENGTH) return 0;
  const vec = logisticFeatureVector(features);
  let delta = 0;
  for (let index = 0; index < vec.length; index += 1) {
    delta += (weights[index + 1] ?? 0) * (vec[index] ?? 0);
  }
  if (!Number.isFinite(delta)) return 0;
  if (delta > clamp) return clamp;
  if (delta < -clamp) return -clamp;
  return delta;
};

// Re-base the online state onto a new serving model: zero the weights
// but KEEP the ledger (appliedLabelKeys/digest/frontier). The fresh
// batch model already incorporated every label in the ledger, so the
// online deltas restart from zero and only post-swap feedback nudges
// it. Keeping the ledger means those already-folded labels are never
// re-applied as online nudges.
const rebaseToModel = (state: OnlineRankerState, modelRevisionId: string): OnlineRankerState => ({
  ...state,
  baseRevisionId: modelRevisionId,
  weights: new Array(ONLINE_RANKER_WEIGHTS_LENGTH).fill(0) as number[],
});

export interface OnlineHeadDrainInput {
  readonly vaultRoot: string;
  // The drain tail — `pendingEventsForDrain`. NEVER the full merged log.
  readonly events: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
  // Candidate/feature context events (`input.events` === the drain's
  // `merged`), matching what the serving augmentation feeds the model.
  readonly merged: readonly AcceptedEvent[];
  // The revision id of the batch model that will serve this drain.
  readonly modelRevisionId: string;
  readonly nowMs: number;
  readonly pageEvidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>;
  readonly evidenceVectorsByVectorId?: ReadonlyMap<string, Float32Array>;
}

export interface OnlineHeadDrainResult {
  readonly state: OnlineRankerState;
  // Number of pairwise updates actually applied this drain (visit↔visit
  // labels with a usable competitor). <= newLabels.length.
  readonly appliedUpdates: number;
}

// Apply the online head for one drain. Returns the (possibly updated)
// state, or `null` if the head is disabled. Persists the state file
// only when something actually changed.
export const applyOnlineHeadDrainStep = async (
  input: OnlineHeadDrainInput,
): Promise<OnlineHeadDrainResult | null> => {
  if (!onlineRankerEnabled()) return null;

  const loaded = await readOnlineRankerState(input.vaultRoot);
  let state = loaded ?? EMPTY_ONLINE_RANKER_STATE(FEATURE_COUNT);
  // Re-base when the serving model differs from the state's base. This
  // single check covers the batch-retrain case (the active revision
  // swapped during this same drain) and any manual model swap.
  const rebased = state.baseRevisionId !== input.modelRevisionId;
  if (rebased) state = rebaseToModel(state, input.modelRevisionId);

  const { state: advanced, newLabels } = advanceFrontier(state, input.events, input.nowMs);
  state = advanced;

  if (newLabels.length === 0) {
    // No new labels, but a rebase or frontier advance may still need
    // persisting. Skip the write when nothing changed.
    const changed = rebased || loaded === null || state !== loaded;
    if (changed) await writeOnlineRankerState(input.vaultRoot, state);
    return { state, appliedUpdates: 0 };
  }

  // Visit-key membership set (mirrors closestVisitRankerEdgesForSnapshot).
  const visitKeys = new Set(
    input.snapshot.nodes
      .filter((node) => node.kind === 'timeline-visit')
      .map((node) => visitKeyFromNodeOrRaw(node.id))
      .filter((visitKey) => visitKey.length > 0),
  );
  // Sorted view for the deterministic random-unrelated negative fallback
  // (mirrors the batch trainer's `randomUnrelated` from `visitKeys`).
  const sortedVisitKeys = [...visitKeys].sort();

  const candidateContext: {
    merged: AcceptedEvent[];
    existingEdges: ConnectionEdge[];
    pageEvidenceByCanonicalUrl?: ReadonlyMap<string, PageEvidenceRecord>;
    evidenceVectorsByVectorId?: ReadonlyMap<string, Float32Array>;
  } = {
    merged: [...input.merged],
    existingEdges: [...input.snapshot.edges],
    ...(input.pageEvidenceByCanonicalUrl === undefined
      ? {}
      : { pageEvidenceByCanonicalUrl: input.pageEvidenceByCanonicalUrl }),
    ...(input.evidenceVectorsByVectorId === undefined
      ? {}
      : { evidenceVectorsByVectorId: input.evidenceVectorsByVectorId }),
  };
  const featureContext = {
    merged: [...input.merged],
    snapshot: input.snapshot,
    retrievalContext: { missingRetrievalContext: true } as const,
  };

  // Positive `to` keys per `from` so a sampled competitor never
  // collides with a pair the user actually asserted this drain.
  const positiveToByFrom = new Map<string, Set<string>>();
  for (const label of newLabels) {
    if (label.polarity !== 'positive') continue;
    const fromKey = visitKeyFromNodeOrRaw(label.fromVisitId);
    const toKey = visitKeyFromNodeOrRaw(label.toVisitId);
    const set = positiveToByFrom.get(fromKey) ?? new Set<string>();
    set.add(toKey);
    positiveToByFrom.set(fromKey, set);
  }

  let weights = state.weights;
  let appliedUpdates = 0;
  for (const label of newLabels) {
    const fromKey = visitKeyFromNodeOrRaw(label.fromVisitId);
    const toKey = visitKeyFromNodeOrRaw(label.toVisitId);
    // Visit↔visit labels only. Container/document targets (organize
    // moves, some snippet promotes) aren't closest-visit pairs — the
    // batch impression path owns those.
    if (fromKey === toKey) continue;
    if (!visitKeys.has(fromKey) || !visitKeys.has(toKey)) continue;

    const blockedTo = positiveToByFrom.get(fromKey) ?? new Set<string>();
    // Prefer a HARD negative from the serving generator (same-domain /
    // nav-chain competitor). On a feedback-only drain the generator's
    // pool is empty (its merged window holds only the feedback event),
    // so fall back to a deterministic random-unrelated visit from the
    // snapshot — always available, replay-stable, and the same negative
    // distribution the batch trainer's `randomUnrelated` uses. Without
    // this fallback the online head silently no-ops on the very feedback
    // drains it exists to learn from.
    const competitor =
      sampleCompetitor(fromKey, toKey, blockedTo, visitKeys, candidateContext) ??
      unrelatedVisitCandidate(fromKey, toKey, blockedTo, sortedVisitKeys);
    if (competitor === null) continue;

    const labeledCandidate: Candidate = {
      fromVisitId: fromKey,
      toVisitId: toKey,
      sources: ['user_confirmed'],
      generatedAt: 0,
    };
    const labeledFeatures = extractFeatures(labeledCandidate, featureContext);
    const competitorFeatures = extractFeatures(competitor, featureContext);

    const [positive, negative] =
      label.polarity === 'positive'
        ? [labeledFeatures, competitorFeatures]
        : [competitorFeatures, labeledFeatures];
    weights = applyPairwiseUpdateFromFeatures(weights, positive, negative);
    appliedUpdates += 1;
  }

  state = {
    ...state,
    weights,
    updatedAtMs: input.nowMs,
    // Stamp the nudge time only when a pairwise update actually applied —
    // `updatedAtMs` alone refreshes on every frontier write and cannot
    // answer "when did feedback last move the weights".
    ...(appliedUpdates > 0 ? { lastNudgeAtMs: input.nowMs } : {}),
  };
  await writeOnlineRankerState(input.vaultRoot, state);
  return { state, appliedUpdates };
};

// Deterministic competitor pick: the alphabetically-first candidate the
// serving generator produces for `from` whose target is a distinct,
// non-positive timeline visit. Replay-stable (no RNG, sorted key).
const sampleCompetitor = (
  fromKey: string,
  labeledToKey: string,
  blockedTo: ReadonlySet<string>,
  visitKeys: ReadonlySet<string>,
  context: Parameters<typeof generateCandidates>[1],
): Candidate | null => {
  let best: { candidate: Candidate; toKey: string } | null = null;
  for (const candidate of generateCandidates(fromKey, context)) {
    const candToKey = visitKeyFromNodeOrRaw(candidate.toVisitId);
    if (candToKey.length === 0) continue;
    if (candToKey === fromKey || candToKey === labeledToKey) continue;
    if (blockedTo.has(candToKey)) continue;
    if (!visitKeys.has(candToKey)) continue;
    if (best === null || candToKey < best.toKey) {
      best = { candidate, toKey: candToKey };
    }
  }
  return best?.candidate ?? null;
};

// Deterministic string hash (djb2) — pure, replay-stable, no crypto cost
// per call. Used only to spread the random-unrelated negative across the
// visit-key list so it isn't always the alphabetically-first visit.
const hashString = (value: string): number => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return hash >>> 0;
};

// Deterministic random-unrelated negative: a visit key from the snapshot
// that is distinct from `from`, the labeled `to`, and any positive `to`
// for this `from`. Seeded by (from, to) so it is replay-stable. Returns
// null only when the snapshot has no other visit to contrast against.
const unrelatedVisitCandidate = (
  fromKey: string,
  labeledToKey: string,
  blockedTo: ReadonlySet<string>,
  sortedVisitKeys: readonly string[],
): Candidate | null => {
  const total = sortedVisitKeys.length;
  if (total === 0) return null;
  const start = hashString(`${fromKey} ${labeledToKey}`) % total;
  for (let step = 0; step < total; step += 1) {
    const candToKey = sortedVisitKeys[(start + step) % total];
    if (candToKey === undefined || candToKey.length === 0) continue;
    if (candToKey === fromKey || candToKey === labeledToKey) continue;
    if (blockedTo.has(candToKey)) continue;
    return {
      fromVisitId: fromKey,
      toVisitId: candToKey,
      sources: ['random_unrelated'],
      generatedAt: 0,
    };
  }
  return null;
};
