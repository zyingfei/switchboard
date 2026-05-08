import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../navigation/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  edgeIdFor,
  nodeIdFor,
  type ConnectionEdge,
  type ConnectionsSnapshot,
} from '../connections/types.js';
import { extractFeatures } from '../ranker/features.js';
import type { CandidatePairFeatures } from '../ranker/feature-schema.js';
import type { Candidate } from '../ranker/types.js';

export const CONTINUATION_CLASSIFIER_REVISION_ID = 'continuation-classifier:v1:deterministic';
export const CONTINUATION_SCORE_THRESHOLD = 0.7;

export interface ContinuationSpecificFeatures {
  readonly time_since_prior_visit_minutes: number;
  readonly time_proximity_score: number;
  readonly copy_paste_lineage_continuity: 0 | 1;
}

export type ContinuationFeatures = CandidatePairFeatures & ContinuationSpecificFeatures;

export interface ContinuationPrediction {
  readonly fromVisitId: string;
  readonly toVisitId: string;
  readonly canonicalUrl: string;
  readonly fromUrl: string;
  readonly toUrl: string;
  readonly fromReplicaId: string;
  readonly toReplicaId: string;
  readonly fromObservedAt: string;
  readonly toObservedAt: string;
  readonly score: number;
  readonly features: ContinuationFeatures;
}

export type ContinuationConnectionEdge = ConnectionEdge & {
  readonly kind: 'visit_continues_visit';
  readonly producedBy: {
    readonly source: 'continuation-classifier';
    readonly revisionId: string;
  };
  readonly confidence: 'inferred';
  readonly family: 'flow';
};

export interface ClassifyContinuationsInput {
  readonly merged: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
  readonly revisionId?: string;
  readonly threshold?: number;
}

interface NavigationObservation {
  readonly visitId: string;
  readonly canonicalUrl: string;
  readonly url: string;
  readonly replicaId: string;
  readonly observedAtMs: number;
  readonly observedAt: string;
}

const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const REPLICA_PREFIX = 'replica:';
const MINUTE_MS = 60 * 1000;
const PROXIMITY_HALF_LIFE_MINUTES = 180;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const visitKeyForUrl = (url: string): string =>
  url.trim().replace(/#.*$/u, '').replace(/\/+$/u, '');

const parsePrefixedId = (value: string, prefix: string): string | null => {
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return id.length > 0 ? id : null;
};

const isoFromTimestamp = (timestampMs: number): string | null => {
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
};

const roundMetric = (value: number): number => Number(value.toFixed(6));

const clampedUnit = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const compareObservation = (left: NavigationObservation, right: NavigationObservation): number =>
  left.observedAtMs - right.observedAtMs ||
  compareText(left.replicaId, right.replicaId) ||
  compareText(left.visitId, right.visitId) ||
  compareText(left.canonicalUrl, right.canonicalUrl);

const collectNavigationObservations = (
  merged: readonly AcceptedEvent[],
): readonly NavigationObservation[] => {
  const observations: NavigationObservation[] = [];
  for (const event of merged) {
    if (event.type !== NAVIGATION_COMMITTED || !isNavigationCommittedPayload(event.payload)) {
      continue;
    }
    const canonicalUrl = visitKeyForUrl(event.payload.canonicalUrl);
    const observedAt = isoFromTimestamp(event.payload.commitTimestamp);
    if (
      canonicalUrl.length === 0 ||
      observedAt === null ||
      event.payload.visitId.length === 0 ||
      event.dot.replicaId.length === 0
    ) {
      continue;
    }
    observations.push({
      visitId: event.payload.visitId,
      canonicalUrl,
      url: event.payload.url,
      replicaId: event.dot.replicaId,
      observedAtMs: event.payload.commitTimestamp,
      observedAt,
    });
  }
  return observations.sort(compareObservation);
};

const crossReplicaReplicasByCanonicalUrl = (
  snapshot: ConnectionsSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const byCanonical = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'visit_observed_on_replica') continue;
    const canonicalUrl = parsePrefixedId(edge.fromNodeId, TIMELINE_VISIT_PREFIX);
    const replicaId = parsePrefixedId(edge.toNodeId, REPLICA_PREFIX);
    if (canonicalUrl === null || replicaId === null) continue;
    let replicas = byCanonical.get(canonicalUrl);
    if (replicas === undefined) {
      replicas = new Set<string>();
      byCanonical.set(canonicalUrl, replicas);
    }
    replicas.add(replicaId);
  }
  return byCanonical;
};

const candidateForPair = (from: NavigationObservation, to: NavigationObservation): Candidate => ({
  fromVisitId: from.visitId,
  toVisitId: to.visitId,
  sources: ['cross_replica_continuation'],
  generatedAt: to.observedAtMs,
});

const timeProximityScore = (minutes: number): number =>
  Math.exp(-Math.max(0, minutes) / PROXIMITY_HALF_LIFE_MINUTES);

export const scoreContinuationFeatures = (features: ContinuationFeatures): number =>
  clampedUnit(
    features.same_canonical_url * 0.2 +
      features.same_workstream * 0.25 +
      features.engagement_class_match * 0.15 +
      features.time_proximity_score * 0.2 +
      features.copy_paste_lineage_continuity * 0.15 +
      clampedUnit(features.cosine_similarity) * 0.05,
  );

export const scoreCrossReplicaContinuationCandidates = (
  input: ClassifyContinuationsInput,
): readonly ContinuationPrediction[] => {
  const eligibleReplicasByCanonical = crossReplicaReplicasByCanonicalUrl(input.snapshot);
  if (eligibleReplicasByCanonical.size === 0) return [];

  const observationsByCanonical = new Map<string, NavigationObservation[]>();
  for (const observation of collectNavigationObservations(input.merged)) {
    const eligibleReplicas = eligibleReplicasByCanonical.get(observation.canonicalUrl);
    if (eligibleReplicas === undefined || !eligibleReplicas.has(observation.replicaId)) {
      continue;
    }
    const existing = observationsByCanonical.get(observation.canonicalUrl) ?? [];
    existing.push(observation);
    observationsByCanonical.set(observation.canonicalUrl, existing);
  }

  const predictions: ContinuationPrediction[] = [];
  const seenPairs = new Set<string>();
  for (const [canonicalUrl, observations] of observationsByCanonical) {
    const sorted = [...observations].sort(compareObservation);
    for (let i = 0; i < sorted.length; i += 1) {
      const from = sorted[i];
      if (from === undefined) continue;
      for (let j = i + 1; j < sorted.length; j += 1) {
        const to = sorted[j];
        if (to === undefined) continue;
        if (from.replicaId === to.replicaId || from.visitId === to.visitId) continue;
        const pairKey = `${from.visitId}\u0000${to.visitId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const s18Features = extractFeatures(candidateForPair(from, to), {
          merged: [...input.merged],
          snapshot: input.snapshot,
        });
        const minutes = Math.max(0, (to.observedAtMs - from.observedAtMs) / MINUTE_MS);
        const features: ContinuationFeatures = {
          ...s18Features,
          time_since_prior_visit_minutes: roundMetric(minutes),
          time_proximity_score: roundMetric(timeProximityScore(minutes)),
          copy_paste_lineage_continuity: s18Features.same_copied_snippet_count > 0 ? 1 : 0,
        };
        predictions.push({
          fromVisitId: from.visitId,
          toVisitId: to.visitId,
          canonicalUrl,
          fromUrl: from.url,
          toUrl: to.url,
          fromReplicaId: from.replicaId,
          toReplicaId: to.replicaId,
          fromObservedAt: from.observedAt,
          toObservedAt: to.observedAt,
          score: roundMetric(scoreContinuationFeatures(features)),
          features,
        });
      }
    }
  }

  return predictions.sort(comparePrediction);
};

const comparePrediction = (left: ContinuationPrediction, right: ContinuationPrediction): number =>
  compareText(left.canonicalUrl, right.canonicalUrl) ||
  compareText(left.fromVisitId, right.fromVisitId) ||
  compareText(left.toVisitId, right.toVisitId) ||
  compareText(left.fromReplicaId, right.fromReplicaId) ||
  compareText(left.toReplicaId, right.toReplicaId);

export const continuationEdgeForPrediction = (
  prediction: ContinuationPrediction,
  revisionId = CONTINUATION_CLASSIFIER_REVISION_ID,
): ContinuationConnectionEdge => {
  const fromNodeId = nodeIdFor('timeline-visit', prediction.fromVisitId);
  const toNodeId = nodeIdFor('timeline-visit', prediction.toVisitId);
  return {
    id: edgeIdFor('visit_continues_visit', fromNodeId, toNodeId),
    kind: 'visit_continues_visit',
    fromNodeId,
    toNodeId,
    observedAt: prediction.toObservedAt,
    producedBy: {
      source: 'continuation-classifier',
      revisionId,
    },
    confidence: 'inferred',
    family: 'flow',
    metadata: {
      score: prediction.score,
      canonicalUrl: prediction.canonicalUrl,
      fromReplicaId: prediction.fromReplicaId,
      toReplicaId: prediction.toReplicaId,
      featureSchemaVersion: prediction.features.schemaVersion,
      sameWorkstream: prediction.features.same_workstream,
      engagementClassMatch: prediction.features.engagement_class_match,
      timeSincePriorVisitMinutes: prediction.features.time_since_prior_visit_minutes,
      timeProximityScore: prediction.features.time_proximity_score,
      copyPasteLineageContinuity: prediction.features.copy_paste_lineage_continuity,
    },
  };
};

export const classifyCrossReplicaContinuations = (
  input: ClassifyContinuationsInput,
): readonly ContinuationPrediction[] => {
  const threshold = input.threshold ?? CONTINUATION_SCORE_THRESHOLD;
  return scoreCrossReplicaContinuationCandidates(input).filter(
    (prediction) => prediction.score >= threshold,
  );
};

export const buildContinuationEdges = (
  input: ClassifyContinuationsInput,
): readonly ContinuationConnectionEdge[] => {
  const revisionId = input.revisionId ?? CONTINUATION_CLASSIFIER_REVISION_ID;
  return classifyCrossReplicaContinuations(input)
    .map((prediction) => continuationEdgeForPrediction(prediction, revisionId))
    .sort((left, right) => compareText(left.id, right.id));
};
