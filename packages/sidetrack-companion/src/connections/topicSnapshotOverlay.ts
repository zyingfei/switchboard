import { createHash } from 'node:crypto';

import {
  DEFAULT_TOPIC_WORKSTREAM_SHARE_THRESHOLD,
  type TopicRevision,
} from '../producers/topic-revision.js';
import {
  edgeIdFor,
  nodeIdFor,
  type ConnectionEdge,
  type ConnectionNode,
  type ConnectionsSnapshot,
} from './types.js';

const TOPIC_EDGE_KINDS = new Set<string>([
  'visit_in_topic',
  'topic_in_workstream',
  'topic.lineage',
]);

const isTopicNodeId = (nodeId: string): boolean => nodeId.startsWith('topic:');

const sortById = <T extends { readonly id: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const maxIso = (left: string, right: string): string => (right > left ? right : left);

const shadowSnapshotRevision = (
  baseSnapshot: ConnectionsSnapshot,
  topicRevision: TopicRevision,
  nodeCount: number,
  edgeCount: number,
): string => {
  const hasher = createHash('sha256');
  hasher.update(baseSnapshot.snapshotRevision ?? baseSnapshot.updatedAt);
  hasher.update('|shadow-topic|');
  hasher.update(topicRevision.revisionId);
  hasher.update('|');
  hasher.update(String(nodeCount));
  hasher.update('|');
  hasher.update(String(edgeCount));
  return hasher.digest('hex').slice(0, 16);
};

export const overlayTopicRevisionOnSnapshot = (
  baseSnapshot: ConnectionsSnapshot,
  topicRevision: TopicRevision,
): ConnectionsSnapshot => {
  const nodesById = new Map<string, ConnectionNode>();
  for (const node of baseSnapshot.nodes) {
    if (node.kind !== 'topic') nodesById.set(node.id, node);
  }

  const edgesById = new Map<string, ConnectionEdge>();
  for (const edge of baseSnapshot.edges) {
    if (TOPIC_EDGE_KINDS.has(edge.kind)) continue;
    if (isTopicNodeId(edge.fromNodeId) || isTopicNodeId(edge.toNodeId)) continue;
    edgesById.set(edge.id, edge);
  }

  let updatedAt = baseSnapshot.updatedAt;
  const topicProducedBy = {
    source: 'topic-clusterer',
    revisionId: topicRevision.revisionId,
  } as const;

  const visitWorkstreamIdFor = (canonicalUrl: string): string | undefined => {
    const value = nodesById.get(nodeIdFor('timeline-visit', canonicalUrl))?.metadata[
      'workstreamId'
    ];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  for (const topic of [...topicRevision.topics].sort((a, b) =>
    a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0,
  )) {
    const topicNodeId = nodeIdFor('topic', topic.topicId);
    updatedAt = maxIso(updatedAt, topic.metadata.lastObservedAt);
    nodesById.set(topicNodeId, {
      id: topicNodeId,
      kind: 'topic',
      label: topic.metadata.representativeTitles[0] ?? topic.topicId,
      firstSeenAt: topic.metadata.firstObservedAt,
      lastSeenAt: topic.metadata.lastObservedAt,
      originReplicaIds: [],
      metadata: { ...topic.metadata },
    });

    for (const memberCanonicalUrl of topic.memberCanonicalUrls) {
      const visitNodeId = nodeIdFor('timeline-visit', memberCanonicalUrl);
      if (!nodesById.has(visitNodeId)) {
        nodesById.set(visitNodeId, {
          id: visitNodeId,
          kind: 'timeline-visit',
          label: memberCanonicalUrl,
          firstSeenAt: topic.metadata.firstObservedAt,
          lastSeenAt: topic.metadata.lastObservedAt,
          originReplicaIds: [],
          metadata: { canonicalUrl: memberCanonicalUrl },
        });
      }
      edgesById.set(edgeIdFor('visit_in_topic', visitNodeId, topicNodeId), {
        id: edgeIdFor('visit_in_topic', visitNodeId, topicNodeId),
        kind: 'visit_in_topic',
        fromNodeId: visitNodeId,
        toNodeId: topicNodeId,
        observedAt: topic.metadata.lastObservedAt,
        producedBy: topicProducedBy,
        confidence: 'inferred',
      });
    }

    const dominantWorkstreamId = topic.metadata.dominantWorkstreamId;
    if (dominantWorkstreamId !== undefined) {
      let dominantCount = 0;
      for (const memberCanonicalUrl of topic.memberCanonicalUrls) {
        if (visitWorkstreamIdFor(memberCanonicalUrl) === dominantWorkstreamId) dominantCount += 1;
      }
      const dominantShare =
        topic.memberCanonicalUrls.length === 0
          ? 0
          : dominantCount / topic.memberCanonicalUrls.length;
      if (dominantShare >= DEFAULT_TOPIC_WORKSTREAM_SHARE_THRESHOLD) {
        const workstreamNodeId = nodeIdFor('workstream', dominantWorkstreamId);
        if (!nodesById.has(workstreamNodeId)) {
          nodesById.set(workstreamNodeId, {
            id: workstreamNodeId,
            kind: 'workstream',
            label: dominantWorkstreamId,
            originReplicaIds: [],
            metadata: {},
          });
        }
        edgesById.set(edgeIdFor('topic_in_workstream', topicNodeId, workstreamNodeId), {
          id: edgeIdFor('topic_in_workstream', topicNodeId, workstreamNodeId),
          kind: 'topic_in_workstream',
          fromNodeId: topicNodeId,
          toNodeId: workstreamNodeId,
          observedAt: topic.metadata.lastObservedAt,
          producedBy: topicProducedBy,
          confidence: 'inferred',
        });
      }
    }
  }

  for (const lineage of topicRevision.lineage) {
    updatedAt = maxIso(updatedAt, lineage.observedAt);
    const fromNodeId = nodeIdFor('topic', lineage.fromTopicId);
    const toNodeId = nodeIdFor('topic', lineage.toTopicId);
    edgesById.set(edgeIdFor('topic.lineage', fromNodeId, toNodeId), {
      id: edgeIdFor('topic.lineage', fromNodeId, toNodeId),
      kind: 'topic.lineage',
      fromNodeId,
      toNodeId,
      observedAt: lineage.observedAt,
      producedBy: topicProducedBy,
      confidence: 'observed',
      metadata: { lineageKind: lineage.kind },
    });
  }

  const nodes = sortById([...nodesById.values()]);
  const edges = sortById([...edgesById.values()]);
  return {
    ...baseSnapshot,
    scope: { ...baseSnapshot.scope, topicVariant: 'shadow' },
    nodes,
    edges,
    updatedAt,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    snapshotRevision: shadowSnapshotRevision(
      baseSnapshot,
      topicRevision,
      nodes.length,
      edges.length,
    ),
  };
};
