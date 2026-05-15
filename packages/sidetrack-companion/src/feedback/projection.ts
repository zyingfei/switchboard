import type { AcceptedEvent } from '../sync/causal.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
  isUserEngagementRelabeledPayload,
  isUserFlowConfirmedPayload,
  isUserFlowRejectedPayload,
  isUserOrganizedItemPayload,
  isUserSnippetPromotedPayload,
  isUserTopicRenamedPayload,
  type FeedbackEventType,
  type FeedbackPayload,
  type UserOrganizedItemAction,
  type UserOrganizedItemKind,
  type UserOrganizedItemPayload,
} from './events.js';

export const FEEDBACK_PROJECTION_SCHEMA_VERSION = 1;

export interface UserAction {
  readonly eventType: FeedbackEventType;
  readonly itemId: string;
  readonly action: string;
  readonly acceptedAtMs: number;
  readonly replicaId: string;
  readonly seq: number;
  readonly payload: FeedbackPayload;
}

export interface FeedbackTrainingLabel {
  readonly fromId: string;
  readonly toId: string;
  readonly weight: number;
}

type FeedbackMembershipAction = Extract<UserOrganizedItemAction, 'move' | 'merge' | 'promote'>;

export interface FeedbackOrganizedMembership {
  readonly itemId: string;
  readonly containerId: string;
  readonly sourceItemId: string;
  readonly sourceItemKind: UserOrganizedItemKind;
  readonly action: FeedbackMembershipAction;
  readonly acceptedAtMs: number;
  readonly replicaId: string;
  readonly seq: number;
}

export interface FeedbackProjection {
  readonly schemaVersion: typeof FEEDBACK_PROJECTION_SCHEMA_VERSION;
  readonly perItem: Record<string, readonly UserAction[]>;
  readonly containerByItem: Record<string, FeedbackOrganizedMembership>;
  readonly organizedItemsByContainer: Record<string, readonly FeedbackOrganizedMembership[]>;
  readonly positiveLabels: readonly FeedbackTrainingLabel[];
  readonly negativeLabels: readonly FeedbackTrainingLabel[];
}

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareEventOrder = (left: AcceptedEvent, right: AcceptedEvent): number => {
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  const replica = compareString(left.dot.replicaId, right.dot.replicaId);
  if (replica !== 0) return replica;
  if (left.dot.seq !== right.dot.seq) return left.dot.seq - right.dot.seq;
  return compareString(left.type, right.type);
};

const compareAction = (left: UserAction, right: UserAction): number => {
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  const replica = compareString(left.replicaId, right.replicaId);
  if (replica !== 0) return replica;
  if (left.seq !== right.seq) return left.seq - right.seq;
  return compareString(left.eventType, right.eventType);
};

const compareLabel = (left: FeedbackTrainingLabel, right: FeedbackTrainingLabel): number => {
  const from = compareString(left.fromId, right.fromId);
  if (from !== 0) return from;
  const to = compareString(left.toId, right.toId);
  if (to !== 0) return to;
  return left.weight - right.weight;
};

const compareMembership = (
  left: FeedbackOrganizedMembership,
  right: FeedbackOrganizedMembership,
): number => {
  const item = compareString(left.itemId, right.itemId);
  if (item !== 0) return item;
  const container = compareString(left.containerId, right.containerId);
  if (container !== 0) return container;
  const source = compareString(left.sourceItemId, right.sourceItemId);
  if (source !== 0) return source;
  const kind = compareString(left.sourceItemKind, right.sourceItemKind);
  if (kind !== 0) return kind;
  const action = compareString(left.action, right.action);
  if (action !== 0) return action;
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  const replica = compareString(left.replicaId, right.replicaId);
  if (replica !== 0) return replica;
  return left.seq - right.seq;
};

const pushAction = (perItem: Map<string, UserAction[]>, action: UserAction): void => {
  const list = perItem.get(action.itemId);
  if (list === undefined) {
    perItem.set(action.itemId, [action]);
  } else {
    list.push(action);
  }
};

const label = (fromId: string | undefined, toId: string | undefined): FeedbackTrainingLabel[] => {
  if (fromId === undefined || toId === undefined || fromId.length === 0 || toId.length === 0) {
    return [];
  }
  return [{ fromId, toId, weight: 1 }];
};

const nonNullContainer = (value: string | null | undefined): string | undefined =>
  value === null ? undefined : value;

const sortedUniqueStrings = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort(compareString);

const membershipItemIdsFor = (payload: UserOrganizedItemPayload): readonly string[] => {
  const explicitMemberIds = payload.details?.memberIds;
  if (explicitMemberIds !== undefined && explicitMemberIds.length > 0) {
    return sortedUniqueStrings(explicitMemberIds);
  }
  if (payload.action === 'merge') {
    return sortedUniqueStrings([payload.itemId, ...(payload.details?.mergeMembers ?? [])]);
  }
  return [payload.itemId];
};

const applyOrganizedMembership = (
  containerByItem: Map<string, FeedbackOrganizedMembership>,
  payload: UserOrganizedItemPayload,
  event: AcceptedEvent,
): void => {
  if (payload.action === 'split' || payload.action === 'ignore') {
    containerByItem.delete(payload.itemId);
    for (const memberId of payload.details?.memberIds ?? []) containerByItem.delete(memberId);
    return;
  }
  if (payload.action !== 'move' && payload.action !== 'merge' && payload.action !== 'promote') {
    return;
  }

  const containerId = nonNullContainer(payload.toContainer);
  const memberIds = membershipItemIdsFor(payload);
  if (containerId === undefined) {
    for (const memberId of memberIds) containerByItem.delete(memberId);
    return;
  }

  for (const memberId of memberIds) {
    containerByItem.set(memberId, {
      itemId: memberId,
      containerId,
      sourceItemId: payload.itemId,
      sourceItemKind: payload.itemKind,
      action: payload.action,
      acceptedAtMs: event.acceptedAtMs,
      replicaId: event.dot.replicaId,
      seq: event.dot.seq,
    });
  }
};

const labelsForOrganizedItem = (
  payload: Extract<FeedbackPayload, { readonly itemId: string }>,
): {
  readonly positive: readonly FeedbackTrainingLabel[];
  readonly negative: readonly FeedbackTrainingLabel[];
} => {
  if (!isUserOrganizedItemPayload(payload)) return { positive: [], negative: [] };
  if (payload.action === 'move' || payload.action === 'merge' || payload.action === 'promote') {
    return { positive: label(payload.itemId, nonNullContainer(payload.toContainer)), negative: [] };
  }
  if (payload.action === 'split') {
    return {
      positive: [],
      negative: (payload.details?.splitInto ?? []).flatMap((targetId) =>
        label(payload.itemId, targetId),
      ),
    };
  }
  if (payload.action === 'ignore') {
    return {
      positive: [],
      negative: [
        ...label(payload.itemId, payload.fromContainer ?? payload.itemId),
        ...(payload.details?.splitInto ?? []).flatMap((targetId) => label(payload.itemId, targetId)),
      ],
    };
  }
  return { positive: [], negative: [] };
};

const stablePerItem = (
  perItem: ReadonlyMap<string, readonly UserAction[]>,
): Record<string, readonly UserAction[]> => {
  const out: Record<string, readonly UserAction[]> = {};
  for (const key of [...perItem.keys()].sort(compareString)) {
    out[key] = [...(perItem.get(key) ?? [])].sort(compareAction);
  }
  return out;
};

const stableContainerByItem = (
  containerByItem: ReadonlyMap<string, FeedbackOrganizedMembership>,
): Record<string, FeedbackOrganizedMembership> => {
  const out: Record<string, FeedbackOrganizedMembership> = {};
  for (const key of [...containerByItem.keys()].sort(compareString)) {
    const membership = containerByItem.get(key);
    if (membership !== undefined) out[key] = membership;
  }
  return out;
};

const stableItemsByContainer = (
  containerByItem: ReadonlyMap<string, FeedbackOrganizedMembership>,
): Record<string, readonly FeedbackOrganizedMembership[]> => {
  const byContainer = new Map<string, FeedbackOrganizedMembership[]>();
  for (const membership of containerByItem.values()) {
    const list = byContainer.get(membership.containerId) ?? [];
    list.push(membership);
    byContainer.set(membership.containerId, list);
  }

  const out: Record<string, readonly FeedbackOrganizedMembership[]> = {};
  for (const containerId of [...byContainer.keys()].sort(compareString)) {
    out[containerId] = [...(byContainer.get(containerId) ?? [])].sort(compareMembership);
  }
  return out;
};

export const projectFeedback = (events: readonly AcceptedEvent[]): FeedbackProjection => {
  const perItem = new Map<string, UserAction[]>();
  const containerByItem = new Map<string, FeedbackOrganizedMembership>();
  const positiveLabels: FeedbackTrainingLabel[] = [];
  const negativeLabels: FeedbackTrainingLabel[] = [];

  for (const event of [...events].sort(compareEventOrder)) {
    if (event.type === USER_ORGANIZED_ITEM && isUserOrganizedItemPayload(event.payload)) {
      pushAction(perItem, {
        eventType: USER_ORGANIZED_ITEM,
        itemId: event.payload.itemId,
        action: event.payload.action,
        acceptedAtMs: event.acceptedAtMs,
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
        payload: event.payload,
      });
      applyOrganizedMembership(containerByItem, event.payload, event);
      const labels = labelsForOrganizedItem(event.payload);
      positiveLabels.push(...labels.positive);
      negativeLabels.push(...labels.negative);
      continue;
    }

    if (
      event.type === USER_ENGAGEMENT_RELABELED &&
      isUserEngagementRelabeledPayload(event.payload)
    ) {
      pushAction(perItem, {
        eventType: USER_ENGAGEMENT_RELABELED,
        itemId: event.payload.visitId,
        action: 'relabeled',
        acceptedAtMs: event.acceptedAtMs,
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
        payload: event.payload,
      });
      continue;
    }

    if (event.type === USER_FLOW_CONFIRMED && isUserFlowConfirmedPayload(event.payload)) {
      pushAction(perItem, {
        eventType: USER_FLOW_CONFIRMED,
        itemId: `${event.payload.fromId}\u0000${event.payload.toId}`,
        action: 'confirmed',
        acceptedAtMs: event.acceptedAtMs,
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
        payload: event.payload,
      });
      positiveLabels.push(...label(event.payload.fromId, event.payload.toId));
      continue;
    }

    if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      pushAction(perItem, {
        eventType: USER_FLOW_REJECTED,
        itemId: `${event.payload.fromId}\u0000${event.payload.toId}`,
        action: 'rejected',
        acceptedAtMs: event.acceptedAtMs,
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
        payload: event.payload,
      });
      negativeLabels.push(...label(event.payload.fromId, event.payload.toId));
      continue;
    }

    if (event.type === USER_TOPIC_RENAMED && isUserTopicRenamedPayload(event.payload)) {
      pushAction(perItem, {
        eventType: USER_TOPIC_RENAMED,
        itemId: event.payload.topicId,
        action: 'renamed',
        acceptedAtMs: event.acceptedAtMs,
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
        payload: event.payload,
      });
      continue;
    }

    if (event.type === USER_SNIPPET_PROMOTED && isUserSnippetPromotedPayload(event.payload)) {
      pushAction(perItem, {
        eventType: USER_SNIPPET_PROMOTED,
        itemId: event.payload.snippetId,
        action: 'promoted',
        acceptedAtMs: event.acceptedAtMs,
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
        payload: event.payload,
      });
      positiveLabels.push(
        ...label(event.payload.sourceVisitId ?? event.payload.snippetId, event.payload.targetId),
      );
    }
  }

  return {
    schemaVersion: FEEDBACK_PROJECTION_SCHEMA_VERSION,
    perItem: stablePerItem(perItem),
    containerByItem: stableContainerByItem(containerByItem),
    organizedItemsByContainer: stableItemsByContainer(containerByItem),
    positiveLabels: positiveLabels.sort(compareLabel),
    negativeLabels: negativeLabels.sort(compareLabel),
  };
};
