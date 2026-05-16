import type { TopicRevision, TopicRevisionTopic } from '../producers/topic-revision.js';

const COLLAPSE_TOPIC_MIN_MEMBERS = 50;
const COLLAPSE_SHARE_MIN_MEMBERS = 20;
const COLLAPSE_MAX_TOPIC_SHARE = 0.5;
const COLLAPSE_PREVIOUS_TOPIC_COUNT = 5;

export interface TopicShadowObservationDiagnostics {
  readonly shadowRevisionId: string;
  readonly previousShadowRevisionId?: string;
  readonly adjacentOverlapVisitCount: number;
  readonly adjacentChangedVisitCount: number;
  readonly adjacentPerVisitChurn?: number;
  readonly adjacentRawTopicIdChurn?: number;
  readonly previousShadowTopicCount?: number;
  readonly previousShadowMaxTopicSize?: number;
  readonly previousShadowAssignedVisitCount?: number;
  readonly topicCountDeltaFromPrevious?: number;
  readonly maxTopicSizeDeltaFromPrevious?: number;
  readonly assignedVisitCountDeltaFromPrevious?: number;
  readonly shadowNoiseShare?: number;
  readonly previousShadowNoiseShare?: number;
  readonly noiseShareDeltaFromPrevious?: number;
  readonly baselineCollapsed: boolean;
  readonly previousBaselineCollapsed?: boolean;
  readonly activeCollapseBoundaryChanged?: boolean;
  readonly shadowCollapsed: boolean;
  readonly previousShadowCollapsed?: boolean;
  readonly shadowCollapseBoundaryChanged?: boolean;
}

export interface BuildTopicShadowObservationInput {
  readonly baselineRevision: TopicRevision;
  readonly previousBaselineRevision: TopicRevision | null;
  readonly shadowRevision: TopicRevision;
  readonly previousShadowRevision: TopicRevision | null;
}

const roundMetric = (value: number): number => Number(value.toFixed(6));

const topicMemberCount = (topic: TopicRevisionTopic): number => topic.memberCanonicalUrls.length;

const revisionAssignedVisitCount = (revision: TopicRevision): number =>
  revision.topics.reduce((sum, topic) => sum + topicMemberCount(topic), 0);

const revisionMaxTopicSize = (revision: TopicRevision): number =>
  revision.topics.reduce((max, topic) => Math.max(max, topicMemberCount(topic)), 0);

const isCollapsedRevision = (
  revision: TopicRevision,
  previousTopicCount: number | undefined,
): boolean => {
  const maxTopicSize = revisionMaxTopicSize(revision);
  const assignedVisitCount = revisionAssignedVisitCount(revision);
  if (assignedVisitCount === 0 || maxTopicSize === 0) return false;
  const maxShare = maxTopicSize / assignedVisitCount;
  return (
    (revision.topics.length <= 1 && maxTopicSize >= COLLAPSE_TOPIC_MIN_MEMBERS) ||
    (assignedVisitCount >= COLLAPSE_SHARE_MIN_MEMBERS && maxShare >= COLLAPSE_MAX_TOPIC_SHARE) ||
    (revision.topics.length <= 2 &&
      previousTopicCount !== undefined &&
      previousTopicCount >= COLLAPSE_PREVIOUS_TOPIC_COUNT)
  );
};

const noiseShareFor = (
  baselineRevision: TopicRevision,
  shadowRevision: TopicRevision,
): number | undefined => {
  const baselineAssignedVisitCount = revisionAssignedVisitCount(baselineRevision);
  if (baselineAssignedVisitCount === 0) return undefined;
  const shadowAssignedVisitCount = revisionAssignedVisitCount(shadowRevision);
  return roundMetric(
    (baselineAssignedVisitCount - shadowAssignedVisitCount) / baselineAssignedVisitCount,
  );
};

const visitToTopicMap = (revision: TopicRevision): Map<string, string> => {
  const out = new Map<string, string>();
  for (const topic of revision.topics) {
    for (const member of topic.memberCanonicalUrls) {
      out.set(member, topic.topicId);
    }
  }
  return out;
};

const memberSetByTopic = (revision: TopicRevision): Map<string, ReadonlySet<string>> => {
  const out = new Map<string, ReadonlySet<string>>();
  for (const topic of revision.topics) {
    out.set(topic.topicId, new Set(topic.memberCanonicalUrls));
  }
  return out;
};

const bestPreviousTopicByCurrentTopic = (
  previous: TopicRevision,
  current: TopicRevision,
): Map<string, string> => {
  const previousMembers = memberSetByTopic(previous);
  const out = new Map<string, string>();
  for (const currentTopic of current.topics) {
    let bestTopicId: string | undefined;
    let bestOverlap = 0;
    for (const [previousTopicId, previousTopicMembers] of previousMembers) {
      let overlap = 0;
      for (const member of currentTopic.memberCanonicalUrls) {
        if (previousTopicMembers.has(member)) overlap += 1;
      }
      if (
        overlap > bestOverlap ||
        (overlap === bestOverlap && bestTopicId !== undefined && previousTopicId < bestTopicId)
      ) {
        bestTopicId = previousTopicId;
        bestOverlap = overlap;
      }
    }
    if (bestTopicId !== undefined && bestOverlap > 0) {
      out.set(currentTopic.topicId, bestTopicId);
    }
  }
  return out;
};

const adjacentChurn = (
  previous: TopicRevision,
  current: TopicRevision,
): {
  readonly overlapVisitCount: number;
  readonly changedVisitCount: number;
  readonly mappedChurn: number;
  readonly rawTopicIdChurn: number;
} => {
  const previousTopicByVisit = visitToTopicMap(previous);
  const currentTopicByVisit = visitToTopicMap(current);
  const bestPreviousByCurrent = bestPreviousTopicByCurrentTopic(previous, current);
  let overlapVisitCount = 0;
  let changedVisitCount = 0;
  let rawChangedVisitCount = 0;
  for (const [visitKey, currentTopicId] of currentTopicByVisit) {
    const previousTopicId = previousTopicByVisit.get(visitKey);
    if (previousTopicId === undefined) continue;
    overlapVisitCount += 1;
    if (previousTopicId !== currentTopicId) rawChangedVisitCount += 1;
    const mappedPreviousTopicId = bestPreviousByCurrent.get(currentTopicId);
    if (mappedPreviousTopicId !== previousTopicId) changedVisitCount += 1;
  }
  return {
    overlapVisitCount,
    changedVisitCount,
    mappedChurn: overlapVisitCount === 0 ? 0 : roundMetric(changedVisitCount / overlapVisitCount),
    rawTopicIdChurn:
      overlapVisitCount === 0 ? 0 : roundMetric(rawChangedVisitCount / overlapVisitCount),
  };
};

export const buildTopicShadowObservationDiagnostics = ({
  baselineRevision,
  previousBaselineRevision,
  shadowRevision,
  previousShadowRevision,
}: BuildTopicShadowObservationInput): TopicShadowObservationDiagnostics => {
  const baselineCollapsed = isCollapsedRevision(
    baselineRevision,
    previousBaselineRevision?.topics.length,
  );
  const previousBaselineCollapsed =
    previousBaselineRevision === null
      ? undefined
      : isCollapsedRevision(previousBaselineRevision, undefined);
  const shadowCollapsed = isCollapsedRevision(
    shadowRevision,
    previousShadowRevision?.topics.length,
  );
  const previousShadowCollapsed =
    previousShadowRevision === null
      ? undefined
      : isCollapsedRevision(previousShadowRevision, undefined);
  const currentShadowTopicCount = shadowRevision.topics.length;
  const currentShadowMaxTopicSize = revisionMaxTopicSize(shadowRevision);
  const currentShadowAssignedVisitCount = revisionAssignedVisitCount(shadowRevision);
  const previousShadowTopicCount =
    previousShadowRevision === null ? undefined : previousShadowRevision.topics.length;
  const previousShadowMaxTopicSize =
    previousShadowRevision === null ? undefined : revisionMaxTopicSize(previousShadowRevision);
  const previousShadowAssignedVisitCount =
    previousShadowRevision === null
      ? undefined
      : revisionAssignedVisitCount(previousShadowRevision);
  const churn =
    previousShadowRevision === null
      ? undefined
      : adjacentChurn(previousShadowRevision, shadowRevision);
  const shadowNoiseShare = noiseShareFor(baselineRevision, shadowRevision);
  const previousShadowNoiseShare =
    previousBaselineRevision === null || previousShadowRevision === null
      ? undefined
      : noiseShareFor(previousBaselineRevision, previousShadowRevision);

  return {
    shadowRevisionId: shadowRevision.revisionId,
    ...(previousShadowRevision === null
      ? {}
      : { previousShadowRevisionId: previousShadowRevision.revisionId }),
    adjacentOverlapVisitCount: churn?.overlapVisitCount ?? 0,
    adjacentChangedVisitCount: churn?.changedVisitCount ?? 0,
    ...(churn === undefined
      ? {}
      : {
          adjacentPerVisitChurn: churn.mappedChurn,
          adjacentRawTopicIdChurn: churn.rawTopicIdChurn,
        }),
    ...(previousShadowTopicCount === undefined ? {} : { previousShadowTopicCount }),
    ...(previousShadowMaxTopicSize === undefined ? {} : { previousShadowMaxTopicSize }),
    ...(previousShadowAssignedVisitCount === undefined ? {} : { previousShadowAssignedVisitCount }),
    ...(previousShadowTopicCount === undefined
      ? {}
      : { topicCountDeltaFromPrevious: currentShadowTopicCount - previousShadowTopicCount }),
    ...(previousShadowMaxTopicSize === undefined
      ? {}
      : { maxTopicSizeDeltaFromPrevious: currentShadowMaxTopicSize - previousShadowMaxTopicSize }),
    ...(previousShadowAssignedVisitCount === undefined
      ? {}
      : {
          assignedVisitCountDeltaFromPrevious:
            currentShadowAssignedVisitCount - previousShadowAssignedVisitCount,
        }),
    ...(shadowNoiseShare === undefined ? {} : { shadowNoiseShare }),
    ...(previousShadowNoiseShare === undefined ? {} : { previousShadowNoiseShare }),
    ...(shadowNoiseShare === undefined || previousShadowNoiseShare === undefined
      ? {}
      : { noiseShareDeltaFromPrevious: roundMetric(shadowNoiseShare - previousShadowNoiseShare) }),
    baselineCollapsed,
    ...(previousBaselineCollapsed === undefined ? {} : { previousBaselineCollapsed }),
    ...(previousBaselineCollapsed === undefined
      ? {}
      : { activeCollapseBoundaryChanged: previousBaselineCollapsed !== baselineCollapsed }),
    shadowCollapsed,
    ...(previousShadowCollapsed === undefined ? {} : { previousShadowCollapsed }),
    ...(previousShadowCollapsed === undefined
      ? {}
      : { shadowCollapseBoundaryChanged: previousShadowCollapsed !== shadowCollapsed }),
  };
};
