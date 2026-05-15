import { createHash } from 'node:crypto';

import {
  USER_ENGAGEMENT_RELABELED,
  USER_ORGANIZED_ITEM,
  USER_TOPIC_RENAMED,
  isUserEngagementRelabeledPayload,
  isUserOrganizedItemPayload,
  isUserTopicRenamedPayload,
} from '../feedback/events.js';
import type { FeedbackProjection, UserAction } from '../feedback/projection.js';
import type { ConnectionNode, ConnectionsSnapshot } from './types.js';

const TOPIC_PREFIX = 'topic:';
const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const VISIT_INSTANCE_PREFIX = 'visit-instance:';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const compareActionOrder = (left: UserAction, right: UserAction): number => {
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  if (left.replicaId !== right.replicaId) return left.replicaId < right.replicaId ? -1 : 1;
  if (left.seq !== right.seq) return left.seq - right.seq;
  return left.eventType < right.eventType ? -1 : left.eventType > right.eventType ? 1 : 0;
};

const allActions = (projection: FeedbackProjection): readonly UserAction[] =>
  Object.values(projection.perItem).flat().sort(compareActionOrder);

const visitTopicKey = (visitId: string, topicId: string): string => `${visitId}\u0000${topicId}`;

const isTopicId = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.startsWith(TOPIC_PREFIX);

const timelineVisitNodeIdFor = (value: string): string =>
  value.startsWith(TIMELINE_VISIT_PREFIX) ? value : `${TIMELINE_VISIT_PREFIX}${value}`;

const visitIdsForNode = (node: ConnectionNode): readonly string[] => {
  const ids = new Set<string>([node.id]);
  const canonicalUrl = node.metadata['canonicalUrl'];
  if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
    ids.add(canonicalUrl);
    ids.add(timelineVisitNodeIdFor(canonicalUrl));
  }
  const url = node.metadata['url'];
  if (typeof url === 'string' && url.length > 0) {
    ids.add(url);
    ids.add(timelineVisitNodeIdFor(url));
  }
  const timelineVisitId = node.metadata['timelineVisitId'];
  if (typeof timelineVisitId === 'string' && timelineVisitId.length > 0) ids.add(timelineVisitId);
  return [...ids];
};

const withEngagementClass = (node: ConnectionNode, engagementClass: string): ConnectionNode => {
  const current = node.metadata['engagement'];
  const engagement = isRecord(current) ? current : {};
  return {
    ...node,
    metadata: {
      ...node.metadata,
      engagement: {
        ...engagement,
        class: engagementClass,
        userRelabeled: true,
      },
    },
  };
};

const feedbackRevision = (
  snapshot: ConnectionsSnapshot,
  projection: FeedbackProjection,
  nodeCount: number,
  edgeCount: number,
): string => {
  const hasher = createHash('sha256');
  hasher.update(snapshot.snapshotRevision ?? snapshot.updatedAt);
  hasher.update('|feedback|');
  hasher.update(String(nodeCount));
  hasher.update('|');
  hasher.update(String(edgeCount));
  hasher.update('|');
  hasher.update(JSON.stringify(projection.perItem));
  return hasher.digest('hex').slice(0, 16);
};

export const applyFeedbackOverlayToSnapshot = (
  snapshot: ConnectionsSnapshot,
  projection: FeedbackProjection,
): ConnectionsSnapshot => {
  const topicLabels = new Map<string, string>();
  const engagementClassByVisit = new Map<string, string>();
  const visitTopicVisibility = new Map<string, boolean>();

  for (const action of allActions(projection)) {
    if (action.eventType === USER_TOPIC_RENAMED && isUserTopicRenamedPayload(action.payload)) {
      topicLabels.set(action.payload.topicId, action.payload.newName);
      continue;
    }

    if (
      action.eventType === USER_ENGAGEMENT_RELABELED &&
      isUserEngagementRelabeledPayload(action.payload)
    ) {
      engagementClassByVisit.set(action.payload.visitId, action.payload.toClass);
      engagementClassByVisit.set(
        timelineVisitNodeIdFor(action.payload.visitId),
        action.payload.toClass,
      );
      continue;
    }

    if (action.eventType !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(action.payload)) {
      continue;
    }
    if (action.payload.itemKind !== 'visit') continue;

    if (action.payload.action === 'ignore' && isTopicId(action.payload.fromContainer)) {
      visitTopicVisibility.set(
        visitTopicKey(action.payload.itemId, action.payload.fromContainer),
        false,
      );
      continue;
    }

    if (
      (action.payload.action === 'move' ||
        action.payload.action === 'merge' ||
        action.payload.action === 'promote') &&
      isTopicId(action.payload.toContainer)
    ) {
      visitTopicVisibility.set(
        visitTopicKey(action.payload.itemId, action.payload.toContainer),
        true,
      );
    }
  }

  if (
    topicLabels.size === 0 &&
    engagementClassByVisit.size === 0 &&
    visitTopicVisibility.size === 0
  ) {
    return snapshot;
  }

  const nodes = snapshot.nodes.map((node) => {
    let next = node;
    if (node.kind === 'topic') {
      const label = topicLabels.get(node.id);
      if (label !== undefined) {
        next = {
          ...next,
          label,
          metadata: {
            ...next.metadata,
            representativeTitles: [label],
            userLabel: label,
          },
        };
      }
    }

    if (node.kind === 'timeline-visit' || node.id.startsWith(VISIT_INSTANCE_PREFIX)) {
      for (const visitId of visitIdsForNode(node)) {
        const engagementClass = engagementClassByVisit.get(visitId);
        if (engagementClass !== undefined) return withEngagementClass(next, engagementClass);
      }
    }
    return next;
  });

  const edges = snapshot.edges.filter((edge) => {
    if (edge.kind !== 'visit_in_topic') return true;
    return visitTopicVisibility.get(visitTopicKey(edge.fromNodeId, edge.toNodeId)) !== false;
  });

  return {
    ...snapshot,
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    snapshotRevision: feedbackRevision(snapshot, projection, nodes.length, edges.length),
  };
};
