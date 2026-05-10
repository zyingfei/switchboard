import type { ConnectionsSnapshot } from '../connections/types.js';

export interface ClusterEvidence {
  readonly workstreamId: string;
  readonly support: number;
  readonly posterior: number;
}

const WORKSTREAM_PREFIX = 'workstream:';

export const buildClusterEvidence = (
  snapshot: ConnectionsSnapshot,
  minSupport = 3,
  alpha = 1,
): readonly ClusterEvidence[] => {
  const counts = new Map<string, number>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'topic_in_workstream' || !edge.toNodeId.startsWith(WORKSTREAM_PREFIX)) {
      continue;
    }
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
