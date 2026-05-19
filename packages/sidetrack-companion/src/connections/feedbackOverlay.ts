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
  const canonicalUrl = node.metadata.canonicalUrl;
  if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
    ids.add(canonicalUrl);
    ids.add(timelineVisitNodeIdFor(canonicalUrl));
  }
  const url = node.metadata.url;
  if (typeof url === 'string' && url.length > 0) {
    ids.add(url);
    ids.add(timelineVisitNodeIdFor(url));
  }
  const timelineVisitId = node.metadata.timelineVisitId;
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
  // A topic's id is a content hash of its member set, so it changes
  // whenever membership changes (that is *why* topic.lineage exists).
  // A rename recorded against the id-at-rename-time would orphan on the
  // next re-cluster. Collect renames in acceptedAt/seq order and resolve
  // each to a CURRENT topic node below — exact id → lineage hop →
  // unique representative-title anchor — so the name follows the topic.
  const renames: {
    readonly oldTopicId: string;
    readonly previousName: string;
    readonly newName: string;
  }[] = [];

  for (const action of allActions(projection)) {
    if (action.eventType === USER_TOPIC_RENAMED && isUserTopicRenamedPayload(action.payload)) {
      renames.push({
        oldTopicId: action.payload.topicId,
        previousName: action.payload.previousName,
        newName: action.payload.newName,
      });
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
    renames.length === 0 &&
    engagementClassByVisit.size === 0 &&
    visitTopicVisibility.size === 0
  ) {
    return snapshot;
  }

  // Resolve each rename to a live topic node id. Tier 1: the recorded
  // id is still current (no re-cluster since). Tier 2: walk topic.lineage
  // forward from the recorded id to a unique current topic (one-drain
  // gap). Tier 3: the rename payload kept the algorithmic title at
  // rename time — bind to the current topic that still carries it, but
  // only if that match is unique (never mis-bind; an ambiguous or lost
  // anchor is a silent no-op, not a wrong label).
  if (renames.length > 0) {
    const currentTopicIds = new Set<string>();
    const titleToTopicIds = new Map<string, Set<string>>();
    for (const node of snapshot.nodes) {
      if (node.kind !== 'topic') continue;
      currentTopicIds.add(node.id);
      const titles = node.metadata['representativeTitles'];
      if (Array.isArray(titles)) {
        for (const title of titles) {
          if (typeof title !== 'string' || title.length === 0) continue;
          const set = titleToTopicIds.get(title) ?? new Set<string>();
          set.add(node.id);
          titleToTopicIds.set(title, set);
        }
      }
    }
    const lineageForward = new Map<string, Set<string>>();
    for (const edge of snapshot.edges) {
      if (edge.kind !== 'topic.lineage') continue;
      const set = lineageForward.get(edge.fromNodeId) ?? new Set<string>();
      set.add(edge.toNodeId);
      lineageForward.set(edge.fromNodeId, set);
    }
    const reachableCurrent = (start: string): string | undefined => {
      const seen = new Set<string>([start]);
      const queue: string[] = [start];
      const hits = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const next of lineageForward.get(current) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          if (currentTopicIds.has(next)) hits.add(next);
          queue.push(next);
        }
      }
      return hits.size === 1 ? [...hits][0] : undefined;
    };
    for (const rename of renames) {
      let target: string | undefined;
      if (currentTopicIds.has(rename.oldTopicId)) target = rename.oldTopicId;
      else target = reachableCurrent(rename.oldTopicId);
      if (target === undefined) {
        const byTitle = titleToTopicIds.get(rename.previousName);
        if (byTitle !== undefined && byTitle.size === 1) target = [...byTitle][0];
      }
      // Later renames win (renames is acceptedAt/seq-ordered).
      if (target !== undefined) topicLabels.set(target, rename.newName);
    }
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
