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
import { extractFeatures } from './features.js';
import type { CandidateRetrievalFeatureContext, RetrievalContext } from './feature-schema.js';
import {
  trainRankerRevisionFromGroups,
  type RankerRevision,
  type RankerTrainingGroup,
  type RankerTrainingLabelingSummary,
  type RankerTrainingRow,
  type TrainRankerOptions,
} from './train.js';
import type { Candidate, CandidateSource } from './types.js';

const POSITIVE_ACTIONS: ReadonlySet<RecallActionKind> = new Set([
  'click',
  'open_new_tab',
  'snippet_promote',
  'flow_confirm',
  'move',
  'promote',
]);

const NEGATIVE_ACTIONS: ReadonlySet<RecallActionKind> = new Set([
  'flow_reject',
  'ignore',
  'reject',
]);

export const MIN_RECALL_IMPRESSION_POSITIVE_GROUPS = 50;

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

export const relevanceGradeForAction = (kind: RecallActionKind): 3 | 0 => {
  if (POSITIVE_ACTIONS.has(kind)) return 3;
  if (NEGATIVE_ACTIONS.has(kind)) return 0;
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

const candidateSourceFor = (sourceKind: string): CandidateSource => {
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

const retrievalContextForCandidates = (
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
}

export interface RecallImpressionTrainingBuildResult {
  readonly groups: readonly RankerTrainingGroup[];
  readonly rawPositiveCount: number;
  readonly rawNegativeCount: number;
  readonly totalCandidateCount: number;
  readonly unjudgedCandidateCount: number;
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
) => Promise<RecallResponse | null>;

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

const servedCandidateFromRecallCandidate = (
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
}: RecallImpressionTrainingBuildInput): Promise<RecallImpressionTrainingBuildResult> => {
  const servedEvents = merged
    .filter((event) => event.type === RECALL_SERVED && isRecallServedPayload(event.payload))
    .sort(
      (left, right) =>
        left.acceptedAtMs - right.acceptedAtMs ||
        compareText(left.clientEventId, right.clientEventId),
    );
  const groups: RankerTrainingGroup[] = [];
  let rawPositiveCount = 0;
  let rawNegativeCount = 0;
  let totalCandidateCount = 0;
  let unjudgedCandidateCount = 0;
  const candidateSourceDistribution: Record<string, number> = {};

  for (const servedEvent of servedEvents) {
    if (!isRecallServedPayload(servedEvent.payload)) continue;
    const served = servedEvent.payload;
    const anchorId = anchorIdForServed(served);
    const actionsByEntity = latestActionByEntity(served.servedContextId, merged);
    const retrievalContext = retrievalContextForServed(anchorId, served);
    const rows: RankerTrainingRow[] = [];
    for (const servedCandidate of served.results) {
      totalCandidateCount += 1;
      candidateSourceDistribution[servedCandidate.sourceKind] =
        (candidateSourceDistribution[servedCandidate.sourceKind] ?? 0) + 1;
      const action = actionsByEntity.get(servedCandidate.entityId);
      if (action === undefined) {
        unjudgedCandidateCount += 1;
        continue;
      }
      const label = relevanceGradeForAction(action.actionKind);
      if (label > 0) rawPositiveCount += 1;
      else rawNegativeCount += 1;
      const toVisitId = servedCandidate.canonicalUrl ?? servedCandidate.entityId;
      const candidate: Candidate = {
        fromVisitId: anchorId,
        toVisitId,
        sources: [candidateSourceFor(servedCandidate.sourceKind)],
        generatedAt: parseTime(served.servedAt) || servedEvent.acceptedAtMs,
      };
      rows.push({
        candidate,
        features: extractFeatures(candidate, {
          merged: [...merged],
          snapshot,
          retrievalContext,
        }),
        label,
      });
    }
    if (rows.length > 0) {
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
      if (response === null) continue;
      const servedCandidates = response.results.map(servedCandidateFromRecallCandidate);
      const retrievalContext = retrievalContextForCandidates(
        spec.anchorId,
        servedCandidates,
        rankDeltaByEntity(response),
      );
      const rows: RankerTrainingRow[] = [];
      for (let index = 0; index < response.results.length; index += 1) {
        const candidateResult = response.results[index];
        const servedCandidate = servedCandidates[index];
        if (candidateResult === undefined || servedCandidate === undefined) continue;
        totalCandidateCount += 1;
        candidateSourceDistribution[candidateResult.sourceKind] =
          (candidateSourceDistribution[candidateResult.sourceKind] ?? 0) + 1;
        if (!candidateMatchesTarget(candidateResult, spec.targetEntityId)) {
          unjudgedCandidateCount += 1;
          continue;
        }
        const label = relevanceGradeForAction(spec.actionKind);
        if (label > 0) rawPositiveCount += 1;
        else rawNegativeCount += 1;
        const toVisitId = servedCandidate.canonicalUrl ?? servedCandidate.entityId;
        const candidate: Candidate = {
          fromVisitId: spec.anchorId,
          toVisitId,
          sources: [candidateSourceFor(servedCandidate.sourceKind)],
          generatedAt: event.acceptedAtMs,
        };
        rows.push({
          candidate,
          features: extractFeatures(candidate, {
            merged: [...merged],
            snapshot,
            retrievalContext,
          }),
          label,
        });
      }
      if (rows.length > 0) {
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
    rawPositiveCount,
    rawNegativeCount,
    totalCandidateCount,
    unjudgedCandidateCount,
    candidateSourceDistribution,
  };
};

export interface RecallImpressionTrainingStats {
  readonly rawPositiveCount: number;
  readonly rawNegativeCount: number;
  readonly groupCount: number;
  readonly positiveGroupCount: number;
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
    const actionEntityIds = new Set(contextActions.map((action) => action.entityId));
    if (actionEntityIds.size > 0) groupCount += 1;
    if (contextActions.some((action) => relevanceGradeForAction(action.actionKind) > 0)) {
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
    if (relevanceGradeForAction(action.payload.actionKind) > 0) rawPositiveCount += 1;
    else rawNegativeCount += 1;
  }
  return {
    rawPositiveCount,
    rawNegativeCount,
    groupCount,
    positiveGroupCount,
    avgCandidatesPerGroup: groupCount === 0 ? 0 : totalCandidateCount / groupCount,
    positivesPerGroup: groupCount === 0 ? 0 : rawPositiveCount / groupCount,
    explicitRejectsPerGroup: groupCount === 0 ? 0 : rawNegativeCount / groupCount,
    unjudgedCandidatesPerGroup: groupCount === 0 ? 0 : unjudgedCandidateCount / groupCount,
    candidateSourceDistribution,
  };
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
    };

export const maybeRetrainRecallImpressionRanker = async (input: {
  readonly merged: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
  readonly reconstructFeedback?: RecallHistoricalFeedbackReconstructor | undefined;
  readonly trainOptions?: TrainRankerOptions;
}): Promise<RecallImpressionRetrainResult> => {
  const build = await buildRecallImpressionTrainingGroups(input);
  const stats = summarizeRecallImpressionTraining(build);
  const positiveGroupCount = build.groups.filter((group) =>
    group.rows.some((row) => row.label > 0),
  ).length;
  if (positiveGroupCount < MIN_RECALL_IMPRESSION_POSITIVE_GROUPS) {
    return { status: 'skipped', reason: 'insufficient_groups', stats };
  }
  const labelingSummary: RankerTrainingLabelingSummary = {
    totalCandidates: build.totalCandidateCount,
    labeledRows: build.groups.reduce((sum, group) => sum + group.rows.length, 0),
    positiveRows: build.rawPositiveCount,
    negativeRows: build.rawNegativeCount,
    implicitNegativeRows: 0,
    unlabeledCandidateCount: build.unjudgedCandidateCount,
  };
  const revision = await trainRankerRevisionFromGroups(
    build.groups,
    input.trainOptions ?? {},
    labelingSummary,
  );
  return { status: 'trained', revision, stats };
};
