import type { ConnectionsSnapshot } from '../connections/types.js';

export interface ClusterEvidence {
  readonly workstreamId: string;
  readonly support: number;
  readonly posterior: number;
}

const WORKSTREAM_PREFIX = 'workstream:';
const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const VISIT_INSTANCE_PREFIX = 'visit-instance:';

export const buildClusterEvidence = (
  snapshot: ConnectionsSnapshot,
  targetVisitNodeIds: ReadonlySet<string> = new Set<string>(),
  minSupport = 3,
  alpha = 1,
): readonly ClusterEvidence[] => {
  if (targetVisitNodeIds.size === 0) return [];
  const targetVisits = new Set(targetVisitNodeIds);
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'visit_instance_same_url_as_timeline_visit') continue;
    if (targetVisitNodeIds.has(edge.fromNodeId) && edge.toNodeId.startsWith(TIMELINE_VISIT_PREFIX)) {
      targetVisits.add(edge.toNodeId);
    }
    if (targetVisitNodeIds.has(edge.toNodeId) && edge.fromNodeId.startsWith(VISIT_INSTANCE_PREFIX)) {
      targetVisits.add(edge.fromNodeId);
    }
  }
  const targetTopics = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'visit_in_topic') continue;
    if (targetVisits.has(edge.fromNodeId)) targetTopics.add(edge.toNodeId);
    if (targetVisits.has(edge.toNodeId)) targetTopics.add(edge.fromNodeId);
  }
  if (targetTopics.size === 0) return [];
  const counts = new Map<string, number>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'topic_in_workstream' || !edge.toNodeId.startsWith(WORKSTREAM_PREFIX)) {
      continue;
    }
    if (!targetTopics.has(edge.fromNodeId)) continue;
    const workstreamId = edge.toNodeId.slice(WORKSTREAM_PREFIX.length);
    counts.set(workstreamId, (counts.get(workstreamId) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total < minSupport) return [];
  const buckets = Math.max(1, counts.size);
  return [...counts.entries()]
    .filter(([, support]) => support >= minSupport)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([workstreamId, support]) => ({
      workstreamId,
      support,
      posterior: (support + alpha) / (total + alpha * buckets),
    }));
};
