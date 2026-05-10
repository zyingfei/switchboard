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

export interface FeedbackProjection {
  readonly schemaVersion: typeof FEEDBACK_PROJECTION_SCHEMA_VERSION;
  readonly perItem: Record<string, readonly UserAction[]>;
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
      negative: label(payload.itemId, payload.fromContainer ?? payload.itemId),
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

export const projectFeedback = (events: readonly AcceptedEvent[]): FeedbackProjection => {
  const perItem = new Map<string, UserAction[]>();
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
    positiveLabels: positiveLabels.sort(compareLabel),
    negativeLabels: negativeLabels.sort(compareLabel),
  };
};
