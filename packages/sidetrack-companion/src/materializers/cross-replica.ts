import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../navigation/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { edgeIdFor, nodeIdFor, type ConnectionEdge } from '../connections/types.js';

const REPLICA_NODE_PREFIX = 'replica:';

export type CrossReplicaEdge = ConnectionEdge & {
  readonly kind: 'visit_observed_on_replica';
  readonly producedBy: { readonly source: 'cross-replica' };
  readonly confidence: 'observed';
};

export interface CrossReplicaReplicaSummary {
  readonly replicaId: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface CrossReplicaMaterialization {
  readonly edges: readonly CrossReplicaEdge[];
  readonly replicas: readonly CrossReplicaReplicaSummary[];
}

export type BuildCrossReplicaEdges = (
  merged: readonly AcceptedEvent[],
) => readonly CrossReplicaEdge[];

interface NavigationObservation {
  readonly canonicalUrl: string;
  readonly replicaId: string;
  readonly observedAt: string;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const timelineVisitKeyFor = (canonicalUrl: string): string =>
  canonicalUrl.trim().replace(/#.*$/u, '').replace(/\/+$/u, '');

const isoFromTimestamp = (timestampMs: number): string | null => {
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
};

const collectNavigationObservations = (
  merged: readonly AcceptedEvent[],
): readonly NavigationObservation[] => {
  const observations: NavigationObservation[] = [];
  for (const event of merged) {
    if (event.type !== NAVIGATION_COMMITTED) continue;
    if (!isNavigationCommittedPayload(event.payload)) continue;
    if (event.dot.replicaId.length === 0) continue;

    const canonicalUrl = timelineVisitKeyFor(event.payload.canonicalUrl);
    if (canonicalUrl.length === 0) continue;

    const observedAt = isoFromTimestamp(event.payload.commitTimestamp);
    if (observedAt === null) continue;

    observations.push({
      canonicalUrl,
      replicaId: event.dot.replicaId,
      observedAt,
    });
  }
  return observations;
};

const buildEdgesFromObservations = (
  observations: readonly NavigationObservation[],
): readonly CrossReplicaEdge[] => {
  const firstObservedByUrlReplica = new Map<string, Map<string, string>>();

  for (const observation of observations) {
    let byReplica = firstObservedByUrlReplica.get(observation.canonicalUrl);
    if (byReplica === undefined) {
      byReplica = new Map<string, string>();
      firstObservedByUrlReplica.set(observation.canonicalUrl, byReplica);
    }

    const previous = byReplica.get(observation.replicaId);
    if (previous === undefined || observation.observedAt < previous) {
      byReplica.set(observation.replicaId, observation.observedAt);
    }
  }

  const edges: CrossReplicaEdge[] = [];
  for (const [canonicalUrl, byReplica] of firstObservedByUrlReplica) {
    if (byReplica.size < 2) continue;

    const fromNodeId = nodeIdFor('timeline-visit', canonicalUrl);
    for (const [replicaId, observedAt] of byReplica) {
      const toNodeId = nodeIdFor('replica', replicaId);
      edges.push({
        id: edgeIdFor('visit_observed_on_replica', fromNodeId, toNodeId),
        kind: 'visit_observed_on_replica',
        fromNodeId,
        toNodeId,
        observedAt,
        producedBy: { source: 'cross-replica' },
        confidence: 'observed',
      });
    }
  }

  return edges.sort(
    (left, right) =>
      compareText(left.fromNodeId, right.fromNodeId) || compareText(left.toNodeId, right.toNodeId),
  );
};

const summarizeReplicas = (
  observations: readonly NavigationObservation[],
  includedReplicaIds?: ReadonlySet<string>,
): readonly CrossReplicaReplicaSummary[] => {
  const byReplica = new Map<string, { firstSeenAt: string; lastSeenAt: string }>();

  for (const observation of observations) {
    if (includedReplicaIds !== undefined && !includedReplicaIds.has(observation.replicaId)) {
      continue;
    }
    const existing = byReplica.get(observation.replicaId);
    if (existing === undefined) {
      byReplica.set(observation.replicaId, {
        firstSeenAt: observation.observedAt,
        lastSeenAt: observation.observedAt,
      });
      continue;
    }
    if (observation.observedAt < existing.firstSeenAt) {
      existing.firstSeenAt = observation.observedAt;
    }
    if (observation.observedAt > existing.lastSeenAt) {
      existing.lastSeenAt = observation.observedAt;
    }
  }

  return [...byReplica.entries()]
    .map(([replicaId, summary]) => ({
      replicaId,
      firstSeenAt: summary.firstSeenAt,
      lastSeenAt: summary.lastSeenAt,
    }))
    .sort((left, right) => compareText(left.replicaId, right.replicaId));
};

export const replicaIdFromNodeId = (nodeId: string): string | null => {
  if (!nodeId.startsWith(REPLICA_NODE_PREFIX)) return null;
  const replicaId = nodeId.slice(REPLICA_NODE_PREFIX.length);
  return replicaId.length > 0 ? replicaId : null;
};

export const buildCrossReplicaEdges: BuildCrossReplicaEdges = (
  merged: readonly AcceptedEvent[],
): readonly CrossReplicaEdge[] => buildEdgesFromObservations(collectNavigationObservations(merged));

export const buildCrossReplicaMaterialization = (
  merged: readonly AcceptedEvent[],
): CrossReplicaMaterialization => {
  const observations = collectNavigationObservations(merged);
  const edges = buildEdgesFromObservations(observations);
  const edgeReplicaIds = new Set<string>();
  for (const edge of edges) {
    const replicaId = replicaIdFromNodeId(edge.toNodeId);
    if (replicaId !== null) edgeReplicaIds.add(replicaId);
  }

  return {
    edges,
    replicas: summarizeReplicas(observations, edgeReplicaIds),
  };
};
