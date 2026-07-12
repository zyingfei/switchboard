import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConnectionsSnapshot } from '../connections/types.js';
import {
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  isUserFlowConfirmedPayload,
  isUserFlowRejectedPayload,
  isUserOrganizedItemPayload,
  isUserSnippetPromotedPayload,
} from '../feedback/events.js';
import {
  RECALL_ACTION,
  RECALL_SERVED,
  isRecallActionPayload,
  isRecallServedPayload,
  type RecallActionKind,
  type RecallActionPayload,
  type RecallServedCandidateSnapshot,
  type RecallServedPayload,
} from '../recall/events.js';
import type { RecallCandidate, RecallRequest, RecallResponse } from '../recall-v2/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { extractFeatures, extractFeaturesWithModel, type FeatureModel } from './features.js';
import {
  FEATURE_SCHEMA_VERSION,
  type CandidatePairFeatures,
  type CandidateRetrievalFeatureContext,
  type RetrievalContext,
} from './feature-schema.js';
import { decodeServedFeatureVector, encodeServedFeatureVector } from './servedFeatureVector.js';
import { loadRankerModel, predictRanker } from './predict.js';
import {
  computeImpressionMetrics,
  shipGateV2Decide,
  type ImpressionGroupForMetrics,
  type ShipGateV2Decision,
} from './shipGateV2.js';
import {
  DETERMINISTIC_BASELINE_VERSION,
  RANKER_MODEL_VERSION,
  deterministicBaselineScore,
  trainRankerRevisionFromGroups,
  type RankerArtifactQuality,
  type RankerRevision,
  type RankerTrainingGroup,
  type RankerTrainingLabelingSummary,
  type RankerTrainingRow,
  type TrainRankerOptions,
} from './train.js';
import type { Candidate, CandidateSource } from './types.js';

const EXPLICIT_POSITIVE_ACTIONS: ReadonlySet<RecallActionKind> = new Set([
  'flow_confirm',
  'move',
  'promote',
  'snippet_promote',
]);

const EXPLICIT_NEGATIVE_ACTIONS: ReadonlySet<RecallActionKind> = new Set([
  'flow_reject',
  'ignore',
  'reject',
]);

const ENGAGEMENT_ACTIONS: ReadonlySet<RecallActionKind> = new Set(['click', 'open_new_tab']);

/**
 * Move 2(a) — instance weight applied to shown-but-unjudged candidates that
 * are emitted as WEAK negatives (label 0). Kept strictly BELOW the explicit
 * reject weight so an explicit "not this one" outweighs a mere non-click.
 * These are TRAINING-DATA-only rows (label 0, LightGBM row weight): the model
 * still cannot serve until it clears the ship gate, which is why the judge
 * ruled densifying negatives freeze-safe.
 */
export const WEAK_NEGATIVE_INSTANCE_WEIGHT = 0.2;
/** Explicit rejects keep the LightGBM default weight of 1.0. */
export const EXPLICIT_REJECT_INSTANCE_WEIGHT = 1;

/**
 * Whether shown-but-unjudged candidates are emitted as weak-negative training
 * rows. Collection defaults ON (repo convention: opt-IN behaviours use =1, but
 * default-ON collection uses an explicit-DISABLE env). Set
 * SIDETRACK_RANKER_WEAK_NEGATIVES=0 (or =off/false) to restore the legacy
 * one-positive-plus-explicit-rejects grouping. Read here so the disable knob is
 * documented at its read site.
 */
export const weakNegativesEnabled = (): boolean => {
  const raw = process.env['SIDETRACK_RANKER_WEAK_NEGATIVES'];
  return raw !== '0' && raw !== 'off' && raw !== 'false';
};

export const MIN_RECALL_IMPRESSION_POSITIVE_GROUPS = 50;
/**
 * Runtime floor for how many positive groups are required before the impression
 * ranker trains. Tunable via SIDETRACK_RANKER_IMPRESSION_MIN_GROUPS so operators
 * (and the bootstrap on smaller vaults with limited reconstructable signal) can
 * lower it; defaults to MIN_RECALL_IMPRESSION_POSITIVE_GROUPS.
 */
export const minRecallImpressionPositiveGroups = (): number => {
  const raw = Number(process.env['SIDETRACK_RANKER_IMPRESSION_MIN_GROUPS']);
  return Number.isFinite(raw) && raw > 0 ? raw : MIN_RECALL_IMPRESSION_POSITIVE_GROUPS;
};
export const RECALL_IMPRESSION_SHIP_GATE_REASON_PREFIX = 'ship_gate_v2:';
export const RECALL_IMPRESSION_RETRAIN_STATE_SCHEMA_VERSION = 1;

const RECALL_IMPRESSION_RETRAIN_STATE_RELATIVE_PATH =
  '_BAC/connections/closest-visit/retrain-impressions-state.json';

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const parseTime = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const anchorIdForServed = (served: RecallServedPayload): string => {
  const currentUrl = served.sessionContext?.['currentUrl'];
  if (typeof currentUrl === 'string' && currentUrl.length > 0) return currentUrl;
  return `recall-query:${served.servedContextId}`;
};

const trainingLabelForAction = (kind: RecallActionKind): 3 | 0 | undefined => {
  if (EXPLICIT_POSITIVE_ACTIONS.has(kind)) return 3;
  if (EXPLICIT_NEGATIVE_ACTIONS.has(kind)) return 0;
  if (ENGAGEMENT_ACTIONS.has(kind)) return undefined;
  return undefined;
};

export const relevanceGradeForAction = (kind: RecallActionKind): 3 | 0 => {
  const label = trainingLabelForAction(kind);
  if (label !== undefined) return label;
  return 0;
};

const sourceFlag = (sourceKind: string): number => {
  if (sourceKind === 'page_content') return 1;
  if (sourceKind === 'timeline_visit') return 2;
  if (sourceKind === 'chat_turn') return 4;
  if (sourceKind === 'semantic_query') return 8;
  if (sourceKind === 'graph_neighbor') return 16;
  return 0;
};

// Exported for the P3 /v2 learned-rerank serve path so train and serve
// derive the candidate `sources` / retrieval features from the IDENTICAL
// builders (no parity drift).
export const candidateSourceFor = (sourceKind: string): CandidateSource => {
  if (sourceKind === 'semantic_query') return 'content_embedding_neighborhood';
  if (sourceKind === 'graph_neighbor') return 'embedding_neighborhood';
  if (sourceKind === 'timeline_visit') return 'same_title_path_tokens';
  if (sourceKind === 'chat_turn') return 'same_copied_snippet';
  return 'content_term_overlap';
};

const finiteOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const retrievalFeatureForServedCandidate = (
  candidate: RecallServedCandidateSnapshot,
  crossEncoderRankDelta?: number,
): CandidateRetrievalFeatureContext => {
  const perLaneRanks = candidate.perLaneRanks ?? {};
  const perLaneScores = candidate.perLaneScores ?? {};
  const flags = Object.keys(perLaneRanks).reduce(
    (acc, key) => acc | sourceFlag(key),
    sourceFlag(candidate.sourceKind),
  );
  const bm25Rank =
    finiteOrUndefined(perLaneRanks['page_content']) ??
    finiteOrUndefined(perLaneRanks['timeline_visit']);
  const bm25Score =
    finiteOrUndefined(perLaneScores['page_content']) ??
    finiteOrUndefined(perLaneScores['timeline_visit']);
  const denseDocScore = finiteOrUndefined(perLaneScores['semantic_query']);
  const denseDocRank = finiteOrUndefined(perLaneRanks['semantic_query']);
  const graphSimilarityRank = finiteOrUndefined(perLaneRanks['graph_neighbor']);
  return {
    ...(bm25Score === undefined ? {} : { bm25Score }),
    ...(bm25Rank === undefined ? {} : { bm25Rank }),
    ...(denseDocScore === undefined ? {} : { denseDocScore }),
    ...(denseDocRank === undefined ? {} : { denseDocRank }),
    rrfScore: candidate.fusedScore,
    rrfRank: candidate.servedPosition + 1,
    ...(graphSimilarityRank === undefined ? {} : { graphSimilarityRank }),
    candidateSourceFlags: flags,
    servedPosition: candidate.servedPosition + 1,
    ...(candidate.rerankScore === undefined ? {} : { crossEncoderScore: candidate.rerankScore }),
    ...(crossEncoderRankDelta === undefined ? {} : { crossEncoderRankDelta }),
  };
};

export const retrievalContextForCandidates = (
  anchorId: string,
  candidates: readonly RecallServedCandidateSnapshot[],
  rankDeltaByEntity: ReadonlyMap<string, number> = new Map(),
): RetrievalContext => {
  const byPairKey = new Map<string, CandidateRetrievalFeatureContext>();
  const byToVisitId = new Map<string, CandidateRetrievalFeatureContext>();
  for (const candidate of candidates) {
    const toVisitId = candidate.canonicalUrl ?? candidate.entityId;
    const features = retrievalFeatureForServedCandidate(
      candidate,
      rankDeltaByEntity.get(candidate.entityId),
    );
    byPairKey.set(`${anchorId}\u0000${toVisitId}`, features);
    byToVisitId.set(toVisitId, features);
  }
  return { byPairKey, byToVisitId };
};

const retrievalContextForServed = (
  anchorId: string,
  served: RecallServedPayload,
): RetrievalContext => retrievalContextForCandidates(anchorId, served.results);

/**
 * The anchor id the impression trainer keys features on, computed from the
 * serve-time session context (currentUrl when present, else a stable
 * per-impression `recall-query:<ctx>` id). Exported so the serve-time
 * capture path (Move 1) uses the IDENTICAL anchor the trainer will use,
 * which also resolves the query-only train/serve anchorId skew noted in the
 * data-architecture review — logged features are anchored the trainer's way,
 * not the reranker's `req.q` way.
 */
export const anchorIdForServedContext = (
  sessionContext: Readonly<Record<string, unknown>> | undefined,
  servedContextId: string,
): string => {
  const currentUrl = sessionContext?.['currentUrl'];
  if (typeof currentUrl === 'string' && currentUrl.length > 0) return currentUrl;
  return `recall-query:${servedContextId}`;
};

/**
 * Move 1 — compute the POINT-IN-TIME served feature vector for each served
 * candidate against a PRE-BUILT (warm) FeatureModel, using the SAME
 * builders the trainer uses (retrievalContextForCandidates + the trainer's
 * anchor + extractFeaturesWithModel). Returns a plain number[] per entity
 * aligned to CANDIDATE_PAIR_FEATURE_KEYS, plus the current schema version.
 *
 * Cost is O(candidates) given a warm model — the caller passes the
 * top-k served rows and MUST NOT build the model on the hot path. Returns
 * null when capture is not possible (no model) so the caller can omit the
 * fields and let the trainer fall back to reconstruction.
 */
export const computeServedFeatureVectors = (input: {
  readonly sessionContext: Readonly<Record<string, unknown>> | undefined;
  readonly servedContextId: string;
  readonly candidates: readonly RecallServedCandidateSnapshot[];
  readonly model: FeatureModel;
  readonly generatedAtMs: number;
}): {
  readonly featureSchemaVersion: number;
  readonly byEntityId: ReadonlyMap<string, number[]>;
} => {
  const anchorId = anchorIdForServedContext(input.sessionContext, input.servedContextId);
  const retrievalContext = retrievalContextForCandidates(anchorId, input.candidates);
  const byEntityId = new Map<string, number[]>();
  for (const candidate of input.candidates) {
    const toVisitId = candidate.canonicalUrl ?? candidate.entityId;
    const pair: Candidate = {
      fromVisitId: anchorId,
      toVisitId,
      sources: [candidateSourceFor(candidate.sourceKind)],
      generatedAt: input.generatedAtMs,
    };
    const features = extractFeaturesWithModel(pair, input.model, retrievalContext);
    byEntityId.set(candidate.entityId, encodeServedFeatureVector(features));
  }
  return { featureSchemaVersion: FEATURE_SCHEMA_VERSION, byEntityId };
};

/**
 * Move 1 consumption — PREFER the point-in-time feature vector logged into
 * the served candidate over re-deriving features against today's (drifted)
 * graph. The logged vector is trusted only when its `featureSchemaVersion`
 * equals the CURRENT FEATURE_SCHEMA_VERSION and it decodes to the current
 * column count; on a mismatch (schema drifted since serve) or a legacy row
 * (no logged vector) we fall back to `reconstruct()` so columns can never
 * silently misalign or mix schemas. `reconstruct` is a lazy closure so the
 * expensive reconstruction path runs ONLY when needed.
 */
const featuresForServedCandidate = (
  servedCandidate: RecallServedCandidateSnapshot,
  reconstruct: () => CandidatePairFeatures,
): CandidatePairFeatures => {
  if (
    servedCandidate.features !== undefined &&
    servedCandidate.featureSchemaVersion === FEATURE_SCHEMA_VERSION
  ) {
    const decoded = decodeServedFeatureVector(servedCandidate.features);
    if (decoded !== null) return decoded;
  }
  return reconstruct();
};

const latestActionByEntity = (
  servedContextId: string,
  actions: readonly AcceptedEvent[],
): ReadonlyMap<string, RecallActionPayload> => {
  const byEntity = new Map<string, { payload: RecallActionPayload; acceptedAtMs: number }>();
  for (const event of actions) {
    if (event.type !== RECALL_ACTION || !isRecallActionPayload(event.payload)) continue;
    if (event.payload.servedContextId !== servedContextId) continue;
    const previous = byEntity.get(event.payload.entityId);
    if (previous === undefined || event.acceptedAtMs >= previous.acceptedAtMs) {
      byEntity.set(event.payload.entityId, {
        payload: event.payload,
        acceptedAtMs: event.acceptedAtMs,
      });
    }
  }
  return new Map([...byEntity].map(([entityId, entry]) => [entityId, entry.payload]));
};

export interface RecallImpressionTrainingBuildInput {
  readonly merged: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
  readonly reconstructFeedback?: RecallHistoricalFeedbackReconstructor | undefined;
  /**
   * Injectable feature reconstructor — defaults to the real
   * `extractFeatures`. Move 1 prefers the POINT-IN-TIME feature vector
   * logged into each served candidate and only calls this to RECONSTRUCT
   * features for legacy impressions (no logged vector) or on a schema
   * mismatch. Tests inject a spy to assert reconstruction is skipped for
   * rows that carry a schema-matching logged vector (DI seam avoids the
   * process-global vi.mock leak under `bun test`).
   */
  readonly extractFeaturesFn?: typeof extractFeatures;
}

export interface RecallImpressionScoringRow {
  readonly candidate: Candidate;
  readonly features: CandidatePairFeatures;
  readonly label?: 'positive' | 'negative';
}

export interface RecallImpressionScoringGroup {
  readonly groupId: string;
  readonly rows: readonly RecallImpressionScoringRow[];
  readonly generatedAt: number;
}

export interface RecallImpressionTrainingBuildResult {
  readonly groups: readonly RankerTrainingGroup[];
  readonly scoringGroups: readonly RecallImpressionScoringGroup[];
  readonly rawPositiveCount: number;
  readonly rawNegativeCount: number;
  readonly totalCandidateCount: number;
  readonly unjudgedCandidateCount: number;
  /**
   * Move 2(a) — count of shown-but-unjudged candidates promoted to
   * weak-negative TRAINING rows (0 when SIDETRACK_RANKER_WEAK_NEGATIVES is
   * disabled). Explicit rejects are counted in rawNegativeCount, not here.
   */
  readonly weakNegativeCount: number;
  readonly candidateSourceDistribution: Readonly<Record<string, number>>;
}

export interface RecallHistoricalFeedbackReconstructionRequest {
  readonly sourceEvent: AcceptedEvent;
  readonly actionKind: RecallActionKind;
  readonly anchorId: string;
  readonly targetEntityId: string;
  readonly recallRequest: RecallRequest;
}

export type RecallHistoricalFeedbackReconstructor = (
  request: RecallHistoricalFeedbackReconstructionRequest,
) => Promise<RecallResponse | null | undefined>;

interface HistoricalFeedbackSpec {
  readonly actionKind: RecallActionKind;
  readonly anchorId: string;
  readonly targetEntityId: string;
}

const recallRequestForHistoricalFeedback = (spec: HistoricalFeedbackSpec): RecallRequest => ({
  q: spec.anchorId,
  intent: 'focus',
  limit: 20,
  session: { currentUrl: spec.anchorId },
  suppression: {
    suppressCurrentPage: 'never',
    suppressAskAiArtifacts: false,
    minHitAgeMs: 0,
  },
  strategy: { rerankTopK: 0 },
});

const historicalFeedbackSpecFor = (
  event: AcceptedEvent,
  referencedFeedbackEventIds: ReadonlySet<string>,
): HistoricalFeedbackSpec | null => {
  if (referencedFeedbackEventIds.has(event.clientEventId)) return null;
  if (event.type === USER_FLOW_CONFIRMED && isUserFlowConfirmedPayload(event.payload)) {
    return {
      actionKind: 'flow_confirm',
      anchorId: event.payload.fromId,
      targetEntityId: event.payload.toId,
    };
  }
  if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
    return {
      actionKind: 'flow_reject',
      anchorId: event.payload.fromId,
      targetEntityId: event.payload.toId,
    };
  }
  if (event.type === USER_SNIPPET_PROMOTED && isUserSnippetPromotedPayload(event.payload)) {
    return {
      actionKind: 'snippet_promote',
      anchorId: event.payload.sourceVisitId ?? event.payload.snippetId,
      targetEntityId: event.payload.targetId,
    };
  }
  if (event.type === USER_ORGANIZED_ITEM && isUserOrganizedItemPayload(event.payload)) {
    if (
      event.payload.action !== 'move' &&
      event.payload.action !== 'promote' &&
      event.payload.action !== 'ignore'
    ) {
      return null;
    }
    const anchorId =
      event.payload.fromContainer ?? event.payload.toContainer ?? event.payload.itemId;
    if (anchorId.length === 0) return null;
    return {
      actionKind: event.payload.action,
      anchorId,
      targetEntityId: event.payload.itemId,
    };
  }
  return null;
};

const betterRank = (left: number | undefined, right: number): number =>
  left === undefined || right < left ? right : left;

const betterScore = (left: number | undefined, right: number): number =>
  left === undefined || right > left ? right : left;

export const servedCandidateFromRecallCandidate = (
  candidate: RecallCandidate,
  servedPosition: number,
): RecallServedCandidateSnapshot => {
  const perLaneRanks: Record<string, number> = {};
  const perLaneScores: Record<string, number> = {};
  for (const evidence of candidate.evidence) {
    if (evidence.rank !== undefined) {
      perLaneRanks[evidence.sourceKind] = betterRank(
        perLaneRanks[evidence.sourceKind],
        evidence.rank,
      );
    }
    if (evidence.rawScore !== undefined) {
      perLaneScores[evidence.sourceKind] = betterScore(
        perLaneScores[evidence.sourceKind],
        evidence.rawScore,
      );
    }
  }
  return {
    entityId: candidate.entityId,
    sourceKind: candidate.sourceKind,
    ...(Object.keys(perLaneRanks).length === 0 ? {} : { perLaneRanks }),
    ...(Object.keys(perLaneScores).length === 0 ? {} : { perLaneScores }),
    fusedScore: candidate.fusedScore,
    ...(candidate.rerankScore === undefined ? {} : { rerankScore: candidate.rerankScore }),
    servedPosition,
    ...(candidate.canonicalUrl === undefined ? {} : { canonicalUrl: candidate.canonicalUrl }),
  };
};

const rankDeltaByEntity = (response: RecallResponse): ReadonlyMap<string, number> =>
  new Map((response.meta.rerank?.rankMovement ?? []).map((item) => [item.entityId, item.delta]));

const visitKeyFromNodeOrRaw = (value: string): string =>
  value.startsWith('timeline-visit:') ? value.slice('timeline-visit:'.length) : value;

const candidateMatchesTarget = (candidate: RecallCandidate, targetEntityId: string): boolean => {
  const target = visitKeyFromNodeOrRaw(targetEntityId);
  const aliases = [
    candidate.entityId,
    candidate.candidateId,
    candidate.canonicalUrl,
    candidate.threadId,
    candidate.contentId,
  ].flatMap((value): readonly string[] =>
    value === undefined ? [] : [value, visitKeyFromNodeOrRaw(value)],
  );
  return aliases.includes(targetEntityId) || aliases.includes(target);
};

export const buildRecallImpressionTrainingGroups = async ({
  merged,
  snapshot,
  reconstructFeedback,
  extractFeaturesFn = extractFeatures,
}: RecallImpressionTrainingBuildInput): Promise<RecallImpressionTrainingBuildResult> => {
  const servedEvents = merged
    .filter((event) => event.type === RECALL_SERVED && isRecallServedPayload(event.payload))
    .sort(
      (left, right) =>
        left.acceptedAtMs - right.acceptedAtMs ||
        compareText(left.clientEventId, right.clientEventId),
    );
  const groups: RankerTrainingGroup[] = [];
  const scoringGroups: RecallImpressionScoringGroup[] = [];
  let rawPositiveCount = 0;
  let rawNegativeCount = 0;
  let totalCandidateCount = 0;
  let unjudgedCandidateCount = 0;
  let weakNegativeCount = 0;
  // Move 2(a) — densify labels: unjudged-but-shown candidates become
  // weak-negative rows (label 0, low instance weight) instead of being
  // dropped, so a group is no longer one-positive-plus-explicit-rejects.
  // Default ON; SIDETRACK_RANKER_WEAK_NEGATIVES=0 restores the legacy path.
  const emitWeakNegatives = weakNegativesEnabled();
  const candidateSourceDistribution: Record<string, number> = {};

  for (const servedEvent of servedEvents) {
    if (!isRecallServedPayload(servedEvent.payload)) continue;
    const served = servedEvent.payload;
    const anchorId = anchorIdForServed(served);
    const actionsByEntity = latestActionByEntity(served.servedContextId, merged);
    const retrievalContext = retrievalContextForServed(anchorId, served);
    const rows: RankerTrainingRow[] = [];
    const scoringRows: RecallImpressionScoringRow[] = [];
    for (const servedCandidate of served.results) {
      totalCandidateCount += 1;
      candidateSourceDistribution[servedCandidate.sourceKind] =
        (candidateSourceDistribution[servedCandidate.sourceKind] ?? 0) + 1;
      const action = actionsByEntity.get(servedCandidate.entityId);
      const toVisitId = servedCandidate.canonicalUrl ?? servedCandidate.entityId;
      const candidate: Candidate = {
        fromVisitId: anchorId,
        toVisitId,
        sources: [candidateSourceFor(servedCandidate.sourceKind)],
        generatedAt: parseTime(served.servedAt) || servedEvent.acceptedAtMs,
      };
      // Move 1 — prefer the point-in-time logged feature vector; only
      // reconstruct against today's graph for legacy / schema-mismatched
      // rows. The reconstruction closure is lazy so it never runs when the
      // logged vector is used.
      const features = featuresForServedCandidate(servedCandidate, () =>
        extractFeaturesFn(candidate, {
          merged: [...merged],
          snapshot,
          retrievalContext,
        }),
      );
      if (action === undefined) {
        unjudgedCandidateCount += 1;
        scoringRows.push({ candidate, features });
        if (emitWeakNegatives) {
          weakNegativeCount += 1;
          rows.push({ candidate, features, label: 0, weight: WEAK_NEGATIVE_INSTANCE_WEIGHT });
        }
        continue;
      }
      const label = trainingLabelForAction(action.actionKind);
      if (label === undefined) {
        // Engagement-only action (click / open) — no explicit label, so it is
        // still an unjudged row; treat as a weak negative like a non-click.
        unjudgedCandidateCount += 1;
        scoringRows.push({ candidate, features });
        if (emitWeakNegatives) {
          weakNegativeCount += 1;
          rows.push({ candidate, features, label: 0, weight: WEAK_NEGATIVE_INSTANCE_WEIGHT });
        }
        continue;
      }
      const labelKind = label > 0 ? 'positive' : 'negative';
      if (label > 0) rawPositiveCount += 1;
      else rawNegativeCount += 1;
      scoringRows.push({ candidate, features, label: labelKind });
      rows.push({
        candidate,
        features,
        label,
        // Explicit rejects keep full weight (1.0) so they outrank weak
        // negatives; only stamped when weak negatives are active, otherwise
        // `weight` stays undefined and the unweighted path is unchanged.
        ...(emitWeakNegatives && label === 0
          ? { weight: EXPLICIT_REJECT_INSTANCE_WEIGHT }
          : {}),
      });
    }
    if (scoringRows.length > 0) {
      scoringGroups.push({
        groupId: served.servedContextId,
        rows: scoringRows,
        generatedAt: parseTime(served.servedAt) || servedEvent.acceptedAtMs,
      });
    }
    if (rows.some((row) => row.label > 0)) {
      groups.push({
        groupId: served.servedContextId,
        rows,
        generatedAt: parseTime(served.servedAt) || servedEvent.acceptedAtMs,
      });
    }
  }

  if (reconstructFeedback !== undefined) {
    const referencedFeedbackEventIds = new Set(
      merged
        .filter((event) => event.type === RECALL_ACTION && isRecallActionPayload(event.payload))
        .flatMap((event) =>
          isRecallActionPayload(event.payload) && event.payload.referencesEventId !== undefined
            ? [event.payload.referencesEventId]
            : [],
        ),
    );
    const feedbackEvents = [...merged].sort(
      (left, right) =>
        left.acceptedAtMs - right.acceptedAtMs ||
        compareText(left.clientEventId, right.clientEventId),
    );
    for (const event of feedbackEvents) {
      const spec = historicalFeedbackSpecFor(event, referencedFeedbackEventIds);
      if (spec === null) continue;
      const recallRequest = recallRequestForHistoricalFeedback(spec);
      const response = await reconstructFeedback({
        sourceEvent: event,
        actionKind: spec.actionKind,
        anchorId: spec.anchorId,
        targetEntityId: spec.targetEntityId,
        recallRequest,
      });
      if (response == null) continue;
      const servedCandidates = response.results.map(servedCandidateFromRecallCandidate);
      const retrievalContext = retrievalContextForCandidates(
        spec.anchorId,
        servedCandidates,
        rankDeltaByEntity(response),
      );
      const rows: RankerTrainingRow[] = [];
      const scoringRows: RecallImpressionScoringRow[] = [];
      for (let index = 0; index < response.results.length; index += 1) {
        const candidateResult = response.results[index];
        const servedCandidate = servedCandidates[index];
        if (candidateResult === undefined || servedCandidate === undefined) continue;
        totalCandidateCount += 1;
        candidateSourceDistribution[candidateResult.sourceKind] =
          (candidateSourceDistribution[candidateResult.sourceKind] ?? 0) + 1;
        const toVisitId = servedCandidate.canonicalUrl ?? servedCandidate.entityId;
        const candidate: Candidate = {
          fromVisitId: spec.anchorId,
          toVisitId,
          sources: [candidateSourceFor(servedCandidate.sourceKind)],
          generatedAt: event.acceptedAtMs,
        };
        // Historical-feedback path — always reconstructs (the synthesized
        // response carries no logged feature vector), so extract directly.
        const features = extractFeaturesFn(candidate, {
          merged: [...merged],
          snapshot,
          retrievalContext,
        });
        if (!candidateMatchesTarget(candidateResult, spec.targetEntityId)) {
          // Reconstructed impression: every non-target candidate is unjudged
          // (only the feedback target carries a label), so it becomes a weak
          // negative under the same gate as the served path.
          unjudgedCandidateCount += 1;
          scoringRows.push({ candidate, features });
          if (emitWeakNegatives) {
            weakNegativeCount += 1;
            rows.push({ candidate, features, label: 0, weight: WEAK_NEGATIVE_INSTANCE_WEIGHT });
          }
          continue;
        }
        const label = trainingLabelForAction(spec.actionKind);
        if (label === undefined) {
          unjudgedCandidateCount += 1;
          scoringRows.push({ candidate, features });
          if (emitWeakNegatives) {
            weakNegativeCount += 1;
            rows.push({ candidate, features, label: 0, weight: WEAK_NEGATIVE_INSTANCE_WEIGHT });
          }
          continue;
        }
        const labelKind = label > 0 ? 'positive' : 'negative';
        if (label > 0) rawPositiveCount += 1;
        else rawNegativeCount += 1;
        scoringRows.push({ candidate, features, label: labelKind });
        rows.push({
          candidate,
          features,
          label,
          ...(emitWeakNegatives && label === 0
            ? { weight: EXPLICIT_REJECT_INSTANCE_WEIGHT }
            : {}),
        });
      }
      if (scoringRows.length > 0) {
        scoringGroups.push({
          groupId: `reconstructed:${event.clientEventId}`,
          rows: scoringRows,
          generatedAt: event.acceptedAtMs,
        });
      }
      if (rows.some((row) => row.label > 0)) {
        groups.push({
          groupId: `reconstructed:${event.clientEventId}`,
          rows,
          generatedAt: event.acceptedAtMs,
        });
      }
    }
  }

  return {
    groups,
    scoringGroups,
    rawPositiveCount,
    rawNegativeCount,
    totalCandidateCount,
    unjudgedCandidateCount,
    weakNegativeCount,
    candidateSourceDistribution,
  };
};

export interface RecallImpressionTrainingStats {
  readonly rawPositiveCount: number;
  readonly rawNegativeCount: number;
  readonly groupCount: number;
  readonly positiveGroupCount: number;
  readonly groupCountWithPositives: number;
  readonly avgCandidatesPerGroup: number;
  readonly positivesPerGroup: number;
  readonly explicitRejectsPerGroup: number;
  readonly unjudgedCandidatesPerGroup: number;
  readonly candidateSourceDistribution: Readonly<Record<string, number>>;
}

export const summarizeRecallImpressionTraining = (
  build: RecallImpressionTrainingBuildResult,
): RecallImpressionTrainingStats => {
  const groupCount = build.groups.length;
  return {
    rawPositiveCount: build.rawPositiveCount,
    rawNegativeCount: build.rawNegativeCount,
    groupCount,
    positiveGroupCount: build.groups.filter((group) => group.rows.some((row) => row.label > 0))
      .length,
    groupCountWithPositives: build.groups.filter((group) => group.rows.some((row) => row.label > 0))
      .length,
    avgCandidatesPerGroup: groupCount === 0 ? 0 : build.totalCandidateCount / groupCount,
    positivesPerGroup: groupCount === 0 ? 0 : build.rawPositiveCount / groupCount,
    explicitRejectsPerGroup: groupCount === 0 ? 0 : build.rawNegativeCount / groupCount,
    unjudgedCandidatesPerGroup: groupCount === 0 ? 0 : build.unjudgedCandidateCount / groupCount,
    candidateSourceDistribution: build.candidateSourceDistribution,
  };
};

export const summarizeRecallImpressionEvents = (
  merged: readonly AcceptedEvent[],
): RecallImpressionTrainingStats => {
  const served = merged.filter(
    (event) => event.type === RECALL_SERVED && isRecallServedPayload(event.payload),
  );
  const actions = merged.filter(
    (event) => event.type === RECALL_ACTION && isRecallActionPayload(event.payload),
  );
  const actionsByContext = new Map<string, RecallActionPayload[]>();
  for (const action of actions) {
    if (!isRecallActionPayload(action.payload)) continue;
    const list = actionsByContext.get(action.payload.servedContextId) ?? [];
    list.push(action.payload);
    actionsByContext.set(action.payload.servedContextId, list);
  }
  let rawPositiveCount = 0;
  let rawNegativeCount = 0;
  let totalCandidateCount = 0;
  let unjudgedCandidateCount = 0;
  let groupCount = 0;
  let positiveGroupCount = 0;
  const candidateSourceDistribution: Record<string, number> = {};
  for (const event of served) {
    if (!isRecallServedPayload(event.payload)) continue;
    const servedPayload = event.payload;
    const contextActions = actionsByContext.get(servedPayload.servedContextId) ?? [];
    const explicitActions = contextActions.filter(
      (action) => trainingLabelForAction(action.actionKind) !== undefined,
    );
    const actionEntityIds = new Set(explicitActions.map((action) => action.entityId));
    if (actionEntityIds.size > 0) groupCount += 1;
    if (explicitActions.some((action) => trainingLabelForAction(action.actionKind) === 3)) {
      positiveGroupCount += 1;
    }
    for (const result of servedPayload.results) {
      totalCandidateCount += 1;
      candidateSourceDistribution[result.sourceKind] =
        (candidateSourceDistribution[result.sourceKind] ?? 0) + 1;
      if (!actionEntityIds.has(result.entityId)) {
        unjudgedCandidateCount += 1;
      }
    }
  }
  for (const action of actions) {
    if (!isRecallActionPayload(action.payload)) continue;
    const label = trainingLabelForAction(action.payload.actionKind);
    if (label === 3) rawPositiveCount += 1;
    else if (label === 0) rawNegativeCount += 1;
  }
  return {
    rawPositiveCount,
    rawNegativeCount,
    groupCount,
    positiveGroupCount,
    groupCountWithPositives: positiveGroupCount,
    avgCandidatesPerGroup: groupCount === 0 ? 0 : totalCandidateCount / groupCount,
    positivesPerGroup: groupCount === 0 ? 0 : rawPositiveCount / groupCount,
    explicitRejectsPerGroup: groupCount === 0 ? 0 : rawNegativeCount / groupCount,
    unjudgedCandidatesPerGroup: groupCount === 0 ? 0 : unjudgedCandidateCount / groupCount,
    candidateSourceDistribution,
  };
};

const reservedTestGroupIdsFor = (
  groups: readonly RankerTrainingGroup[],
): ReadonlySet<string> | null => {
  const sorted = groups
    .filter((group) => group.rows.length > 0)
    .sort(
      (left, right) =>
        left.generatedAt - right.generatedAt || compareText(left.groupId, right.groupId),
    );
  if (sorted.length < 4) return null;
  if (new Set(sorted.map((group) => group.generatedAt)).size < 2) return null;
  const testCount = Math.max(1, Math.floor(sorted.length * 0.2));
  const validationPool = sorted.slice(0, sorted.length - testCount);
  const testGroups = sorted.slice(sorted.length - testCount);
  const heldOutCount = Math.max(1, Math.floor(validationPool.length * 0.2));
  const trainGroups = validationPool.slice(0, validationPool.length - heldOutCount);
  const heldOutGroups = validationPool.slice(validationPool.length - heldOutCount);
  if (trainGroups.length === 0 || heldOutGroups.length === 0 || testGroups.length === 0) {
    return null;
  }
  const cutoffGeneratedAt = Math.max(...trainGroups.map((group) => group.generatedAt));
  const earliestHeldOut = Math.min(...heldOutGroups.map((group) => group.generatedAt));
  if (earliestHeldOut <= cutoffGeneratedAt) return null;
  const testCutoffGeneratedAt = Math.max(...heldOutGroups.map((group) => group.generatedAt));
  const earliestTest = Math.min(...testGroups.map((group) => group.generatedAt));
  if (earliestTest <= testCutoffGeneratedAt) return null;
  return new Set(testGroups.map((group) => group.groupId));
};

const labelMapForScoringRows = (
  rows: readonly RecallImpressionScoringRow[],
): ReadonlyMap<string, 'positive' | 'negative'> => {
  const labels = new Map<string, 'positive' | 'negative'>();
  for (const row of rows) {
    if (row.label !== undefined) labels.set(row.candidate.toVisitId, row.label);
  }
  return labels;
};

const rankedMetricGroup = (
  group: RecallImpressionScoringGroup,
  scoreFor: (row: RecallImpressionScoringRow) => number,
): ImpressionGroupForMetrics => ({
  groupId: group.groupId,
  rankedEntityIds: [...group.rows]
    .sort((left, right) => {
      const delta = scoreFor(right) - scoreFor(left);
      return delta !== 0 ? delta : compareText(left.candidate.toVisitId, right.candidate.toVisitId);
    })
    .map((row) => row.candidate.toVisitId),
  labels: labelMapForScoringRows(group.rows),
});

const baselineMetricGroupsFor = (
  groups: readonly RecallImpressionScoringGroup[],
): readonly ImpressionGroupForMetrics[] =>
  groups.map((group) =>
    rankedMetricGroup(group, (row) => deterministicBaselineScore(row.features)),
  );

const activeMetricGroupsFor = async (
  revision: RankerRevision,
  groups: readonly RecallImpressionScoringGroup[],
): Promise<readonly ImpressionGroupForMetrics[]> => {
  const model = await loadRankerModel(revision);
  try {
    return groups.map((group) =>
      rankedMetricGroup(group, (row) => predictRanker(row.features, model).score),
    );
  } finally {
    model.dispose();
  }
};

export interface RecallImpressionShipGateEvaluation {
  readonly decision: ShipGateV2Decision;
  readonly reservedTestGroupCount: number;
}

export const evaluateRecallImpressionShipGateV2 = async (
  revision: RankerRevision,
  build: RecallImpressionTrainingBuildResult,
): Promise<RecallImpressionShipGateEvaluation> => {
  const reservedIds = reservedTestGroupIdsFor(build.groups);
  const reservedScoringGroups =
    reservedIds === null
      ? []
      : build.scoringGroups.filter((group) => reservedIds.has(group.groupId));
  const [activeMetricGroups, baselineMetricGroups] = await Promise.all([
    activeMetricGroupsFor(revision, reservedScoringGroups),
    Promise.resolve(baselineMetricGroupsFor(reservedScoringGroups)),
  ]);
  const activeMetrics = computeImpressionMetrics(activeMetricGroups);
  const baselineMetrics = computeImpressionMetrics(baselineMetricGroups);
  return {
    decision: shipGateV2Decide({
      activeMetrics,
      baselineMetrics,
      expandedNegativeCount: 0,
      labelDriftWithoutFeedback: 0,
      reservedTestUsedExactlyOnce: true,
    }),
    reservedTestGroupCount: reservedScoringGroups.length,
  };
};

const v2Reason = (decision: ShipGateV2Decision): string =>
  `${RECALL_IMPRESSION_SHIP_GATE_REASON_PREFIX}${decision.reason}`;

const reservedMetric = (kind: 'active' | 'baseline', value: number) => ({
  kind: `ship-gate-v2 ${kind} reserved-test ndcg@10`,
  value,
});

const v2ArtifactQualityFor = (
  revision: RankerRevision,
  kind: 'graph_baseline' | 'lightgbm_lambdamart',
  decision: ShipGateV2Decision,
): RankerArtifactQuality => {
  const existing = revision.artifactQuality?.find((artifact) => artifact.kind === kind);
  if (kind === 'graph_baseline') {
    return {
      kind,
      candidate: existing?.candidate ?? DETERMINISTIC_BASELINE_VERSION,
      ...(existing?.validationMetric === undefined
        ? {}
        : { validationMetric: existing.validationMetric }),
      reservedTestMetric: reservedMetric('baseline', decision.baseline.nDcgAt10),
      shipGate: { status: 'pass', reason: `${RECALL_IMPRESSION_SHIP_GATE_REASON_PREFIX}baseline` },
    };
  }
  return {
    kind,
    candidate: existing?.candidate ?? RANKER_MODEL_VERSION,
    ...(existing?.validationMetric === undefined
      ? {}
      : { validationMetric: existing.validationMetric }),
    reservedTestMetric: reservedMetric('active', decision.active.nDcgAt10),
    shipGate: { status: decision.status, reason: v2Reason(decision) },
  };
};

export const applyRecallImpressionShipGateV2 = (
  revision: RankerRevision,
  decision: ShipGateV2Decision,
): RankerRevision => {
  const updated = new Map<RankerArtifactQuality['kind'], RankerArtifactQuality>();
  for (const artifact of revision.artifactQuality ?? []) updated.set(artifact.kind, artifact);
  updated.set('graph_baseline', v2ArtifactQualityFor(revision, 'graph_baseline', decision));
  updated.set(
    'lightgbm_lambdamart',
    v2ArtifactQualityFor(revision, 'lightgbm_lambdamart', decision),
  );
  const orderedKinds: readonly RankerArtifactQuality['kind'][] = [
    'graph_baseline',
    'logistic_batch',
    'lightgbm_lambdamart',
    'lightgbm_plus_online_lr',
    'logistic_online',
    'hierarchical_per_container_lr',
  ];
  return {
    ...revision,
    artifactQuality: orderedKinds.flatMap((kind) => {
      const artifact = updated.get(kind);
      return artifact === undefined ? [] : [artifact];
    }),
  };
};

export interface RecallImpressionRetrainState {
  readonly schemaVersion: typeof RECALL_IMPRESSION_RETRAIN_STATE_SCHEMA_VERSION;
  readonly status: 'promoted' | 'ship_gate_failed';
  readonly revisionId: string;
  readonly updatedAt: number;
  readonly stats: RecallImpressionTrainingStats;
  readonly shipGateDecision: ShipGateV2Decision;
}

export const recallImpressionRetrainStatePath = (vaultRoot: string): string =>
  join(vaultRoot, RECALL_IMPRESSION_RETRAIN_STATE_RELATIVE_PATH);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isShipGateV2Decision = (value: unknown): value is ShipGateV2Decision => {
  if (!isRecord(value)) return false;
  const status = value['status'];
  return (
    (status === 'pass' || status === 'fail' || status === 'unavailable') &&
    typeof value['reason'] === 'string' &&
    isRecord(value['active']) &&
    isRecord(value['baseline']) &&
    isRecord(value['deltas']) &&
    typeof value['reservedTestUsedExactlyOnce'] === 'boolean'
  );
};

const isRecallImpressionRetrainState = (value: unknown): value is RecallImpressionRetrainState => {
  if (!isRecord(value)) return false;
  return (
    value['schemaVersion'] === RECALL_IMPRESSION_RETRAIN_STATE_SCHEMA_VERSION &&
    (value['status'] === 'promoted' || value['status'] === 'ship_gate_failed') &&
    typeof value['revisionId'] === 'string' &&
    typeof value['updatedAt'] === 'number' &&
    isRecord(value['stats']) &&
    isShipGateV2Decision(value['shipGateDecision'])
  );
};

export const readRecallImpressionRetrainState = async (
  vaultRoot: string,
): Promise<RecallImpressionRetrainState | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(recallImpressionRetrainStatePath(vaultRoot), 'utf8'),
    ) as unknown;
    return isRecallImpressionRetrainState(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

export const writeRecallImpressionRetrainState = async (
  vaultRoot: string,
  state: RecallImpressionRetrainState,
): Promise<void> => {
  await writeAtomic(
    recallImpressionRetrainStatePath(vaultRoot),
    `${JSON.stringify(state, null, 2)}\n`,
  );
};

export type RecallImpressionRetrainResult =
  | {
      readonly status: 'skipped';
      readonly reason: 'insufficient_groups';
      readonly stats: RecallImpressionTrainingStats;
    }
  | {
      readonly status: 'trained';
      readonly revision: RankerRevision;
      readonly stats: RecallImpressionTrainingStats;
      readonly shipGateDecision: ShipGateV2Decision;
    };

export const maybeRetrainRecallImpressionRanker = async (input: {
  readonly merged: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
  readonly reconstructFeedback?: RecallHistoricalFeedbackReconstructor | undefined;
  readonly trainOptions?: TrainRankerOptions;
  /**
   * Off-thread trainer injection (P1b bootstrap). Defaults to the inline
   * `trainRankerRevisionFromGroups`; the bootstrap passes a worker-backed
   * trainer so the LightGBM CPU never blocks the request loop / `/v1/status`.
   */
  readonly train?: (
    groups: readonly RankerTrainingGroup[],
    options: TrainRankerOptions,
    labelingSummary: RankerTrainingLabelingSummary,
  ) => Promise<RankerRevision>;
}): Promise<RecallImpressionRetrainResult> => {
  const build = await buildRecallImpressionTrainingGroups(input);
  const stats = summarizeRecallImpressionTraining(build);
  const positiveGroupCount = build.groups.filter((group) =>
    group.rows.some((row) => row.label > 0),
  ).length;
  if (positiveGroupCount < minRecallImpressionPositiveGroups()) {
    return { status: 'skipped', reason: 'insufficient_groups', stats };
  }
  const labelingSummary: RankerTrainingLabelingSummary = {
    totalCandidates: build.totalCandidateCount,
    labeledRows: build.groups.reduce((sum, group) => sum + group.rows.length, 0),
    positiveRows: build.rawPositiveCount,
    negativeRows: build.rawNegativeCount,
    // Weak negatives (shown-but-unjudged rows) are the implicit-negative
    // population; explicit rejects are counted in negativeRows above.
    implicitNegativeRows: build.weakNegativeCount,
    unlabeledCandidateCount: build.unjudgedCandidateCount,
  };
  const baseRevision = await (input.train ?? trainRankerRevisionFromGroups)(
    build.groups,
    input.trainOptions ?? {},
    labelingSummary,
  );
  const gate = await evaluateRecallImpressionShipGateV2(baseRevision, build);
  const revision = applyRecallImpressionShipGateV2(baseRevision, gate.decision);
  return { status: 'trained', revision, stats, shipGateDecision: gate.decision };
};
